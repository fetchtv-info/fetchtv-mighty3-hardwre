package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HDHomeRun-compatible surface. Jellyfin needs three things (see the contract in
// the skill reference): /discover.json, /lineup.json and a plain-HTTP MPEG-TS
// URL. Everything else is optional when the tuner is added by address.
const (
	slotHandoverWait = 8 * time.Second        // how long a replaced slot stream gets to release its tuner
	tunerCount       = 3                      // honest: 4 tuners, 1 left for live TV on the box
	streamTimeout    = 30 * time.Second       // how long to wait for the page to start a recording
	tailPollSleep    = 100 * time.Millisecond // how often to retry a read at EOF
	firstByteWait    = 8 * time.Second        // wait for the recorder to write something
	writeTimeout     = 20 * time.Second       // per-chunk write budget: a wedged client must not hold a tuner
	stallTimeout     = 25 * time.Second       // hard limit: drop the stream if even a restart did not help
	stallGrace       = 2 * time.Second        // a stalled recorder is restarted after this long

	// Media servers scan muxes/channels concurrently, so more requests than
	// tuners arrive at once and each would otherwise fail outright. Queue for a
	// slot instead: a scan that waits is a scan that succeeds, and it costs
	// nothing when the box is idle.
	tunerWait      = 25 * time.Second
	tunerPollSleep = 250 * time.Millisecond

	// Recorder starts fail transiently while the box finishes closing the
	// previous recording ("start failed h=-1", "no file appeared"), so give
	// each start a few attempts before declaring the channel unavailable.
	startAttempts   = 3
	startRetryDelay = 2 * time.Second

	// A stream whose writes stop advancing is treated as abandoned. Long enough
	// to ride out a stalled client, short enough that a phantom tuner does not
	// block the next scan for minutes.
	// Measured: a healthy start creates its file in 2-6 s. Four seconds was too
	// tight and made every start look like a failure; twelve was long enough to
	// lose the player. Six is the working compromise.
	recordingFileWait  = 6 * time.Second // how long to wait for the box to create the file
	staleStreamTimeout = 90 * time.Second
	staleStreamCheck   = 15 * time.Second

	// warmCap bounds how many tuners may sit idle-but-recording. One is enough
	// to make repeat requests instant without starving a real viewer; the rest
	// are reclaimed on demand by acquire.
	warmCap     = 1
	maxRestarts = 2
	// stopSettle is how long to wait after a recorder is released before the
	// next start is issued. The box accepts a start while it is still closing
	// the previous recorder and then produces a stream that stalls almost
	// immediately, so the gap is cheaper than the retry.
	stopSettle = 2 * time.Second
)

type Channel struct {
	LCN  int    `json:"lcn"`
	Name string `json:"name"`
	// Freq is the multiplex frequency as the vendor reports it (0 if unknown).
	// Channels with the same Freq share one recording tuner.
	Freq int `json:"freq,omitempty"`
}

type hdhr struct {
	// recGate serialises "start" against "stop".
	//
	// The page drives one recorder command at a time, and a stop issued while a
	// start is in flight disturbs the new recording: measured 2026-11-26, a
	// switch between playlist entries left the new recording stuck after 192 KB
	// ("no data for 1m0s"), while the same switch after a gap was healthy. Since
	// a player changing channel is exactly that pattern, the two are ordered.
	recGate chan struct{}
	// progs maps LCN to the program number (from the PMT) that channel records as. Learned
	// from a good stream, then used to reject a candidate file that belongs to a
	// different channel.
	progs *programMap
	// handles records which recording owns each vendor handle, so a late stop
	// can never land on a newer recording that was given the same slot.
	handles handleBook
	// stopping holds recording files whose stop is already in progress. The
	// reconcile sweep skips them: they are being dealt with, and a second stop
	// is exactly what used to kill the next channel.
	stopping map[string]bool
	// claimed holds files adopted by a start that has not registered its
	// stream yet, so a concurrent start cannot adopt the same file.
	claimed map[string]bool
	// retiring holds files whose recorder is being stopped. The file keeps
	// growing until the box acts on the stop, so to a new start it looks
	// exactly like a fresh recording; it must never be adopted (measured:
	// channel 13 adopted channel 30's file seconds after 30 was replaced).
	retiring map[string]bool
	// tunerWarn is set when the box behaves as if a recording tuner is stuck
	// (see noteNoFile); nil when the tuners look healthy.
	tunerWarn *tunerWarning
	// audio holds channels learned to be unrecordable (radio.go).
	audio   *audioOnlyStore
	cmds    *cmdQueue
	log     *Logger
	cfgPath string
	root    string
	port    int
	guide   *GuideStore

	mu       sync.Mutex
	channels []Channel
	chanAt   time.Time
	streams  map[string]*liveStream // key: LCN
	starting map[string]bool        // LCNs with a recording being started

	// startMu serialises recorder starts. The page handles one command at a
	// time, so overlapping start requests make the box fail ("no file
	// appeared", "start failed h=-1") rather than merely queue.
	startMu sync.Mutex
	active  map[string]string // recording file -> LCN, persisted in state/
	lastLCN string            // most recently opened tuner, served at "/"
	// slots[i] is the viewer on /tuner<i>. A slot is one viewer: a new request
	// on it replaces the stream it holds (see serveTuner).
	slots   [tunerCount]*slotHold
	viewing Channel // what the box itself is tuned to (reported by the page)
}

type liveStream struct {
	lcn    string
	file   string
	refs   int
	cancel context.CancelFunc // lets an operator release a stuck stream
	// lastWrite is the last time bytes actually went to a client. This box
	// cannot set write deadlines, so a handler can block in Write with no way
	// to notice a dead peer; a stream whose writes stop advancing is reclaimed
	// by the reaper instead of holding a tuner forever.
	lastWrite time.Time
	// idle marks a "warm" recording: the last viewer has gone but the recorder
	// is deliberately left running until expire, so a repeat request for the
	// channel starts instantly.
	idle   bool
	expire time.Time
	// handle is the vendor recorder handle reported at start. Stopping by
	// handle works even when the page has lost its own bookkeeping (a page
	// reload clears it), which used to leave recorders running until the box
	// ran out of slots and refused every new start with h=-1.
	handle string
	// base is the file size when this stream adopted the recording. The box
	// recycles record<N> names, so everything below base belongs to a previous
	// channel and must never be served.
	base int64
	// id is the Ag_record_create() id, which the box's PVR index uses as the
	// file id. It is what lets us delete through the vendor API instead of
	// unlinking, which would leave the index stale.
	id string
}

// lastWriteAt records write progress so the reaper can tell a live stream from
// one whose handler is blocked on a peer that has gone away.
func (ls *liveStream) lastWriteAt(h *hdhr) {
	h.mu.Lock()
	ls.lastWrite = time.Now()
	h.mu.Unlock()
}

// reapStaleStreams reclaims tuners whose handlers are stuck in Write. This box
// cannot set write deadlines, so a client that vanishes without closing cleanly
// can leave a handler blocked for minutes; nothing else would free the slot.
func (h *hdhr) reapStaleStreams() {
	t := time.NewTicker(staleStreamCheck)
	defer t.Stop()
	for range t.C {
		var stale []string
		now := time.Now()
		h.mu.Lock()
		for lcn, ls := range h.streams {
			// A warm recording whose window has passed is stopped like any
			// other; a busy one is only reclaimed if its writes stopped.
			if ls.idle {
				if now.After(ls.expire) {
					stale = append(stale, lcn)
				}
				continue
			}
			if ls.lastWrite.IsZero() {
				continue
			}
			if now.Sub(ls.lastWrite) > staleStreamTimeout {
				stale = append(stale, lcn)
			}
		}
		h.mu.Unlock()
		for _, lcn := range stale {
			h.log.Printf("stream lcn=%s: reclaiming the tuner (warm window over or writes stalled)", lcn)
			h.releaseStream(lcn)
		}
		h.reconcileRegistry()
	}
}

// reconcileRegistry stops recorders this daemon started but no longer tracks.
// Reference counting can leak when a handler disappears without running its
// deferred release, and a leaked recorder keeps writing until the box reboots -
// which then makes every new start fail. The registry is the source of truth:
// any file recorded but not attached to a live stream is stopped here.
func (h *hdhr) reconcileRegistry() {
	for file, val := range h.orphanRecordings() {
		lcn, handle, id := splitActive(val)
		h.log.Printf("pvr: %s is recording with no live stream (lcn=%s handle=%s) - stopping it", file, lcn, handle)
		h.stopRecording(lcn, file, handle, id)
	}
}

// orphanRecordings returns registry entries that no live stream holds and that
// are not already being stopped. The second condition is the fix for the
// recycled-handle bug: a recording whose stop is still verifying used to look
// orphaned, got a second stop by handle, and that stop hit the next channel.
func (h *hdhr) orphanRecordings() map[string]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	live := make(map[string]bool, len(h.streams))
	for _, ls := range h.streams {
		live[ls.file] = true
	}
	orphans := make(map[string]string, len(h.active))
	for file, val := range h.active {
		_, _, id := splitActive(val)
		if !live[file] && !h.stopping[stopKey(file, id)] {
			orphans[file] = val
		}
	}
	return orphans
}

func registerHdhr(mux *http.ServeMux, cmds *cmdQueue, log *Logger, cfgPath, root string, port int, guide *GuideStore) *hdhr {
	h := &hdhr{cmds: cmds, log: log, cfgPath: cfgPath, root: root, port: port, guide: guide,
		streams: map[string]*liveStream{}, recGate: make(chan struct{}, 1),
		progs: loadProgramMap(root), audio: loadAudioOnly(root)}
	if d := h.progs.droppedAtLoad; len(d) > 0 {
		h.log.Printf("programs: forgot channels %s - they shared a program number, so at least one was learned from the wrong recording", strings.Join(d, ", "))
	}
	go h.reapStaleStreams()
	h.loadChannels()

	// The page owns the channel list (only it can read the tuner), so it posts
	// it here and /lineup.json serves from this cache.
	mux.HandleFunc("/api/channels", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, map[string]any{"channels": h.channelList()})
			return
		}
		var body struct {
			Channels []Channel `json:"channels"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad channel list", http.StatusBadRequest)
			return
		}
		h.setChannels(body.Channels)
		log.Printf("channels: page reported %d", len(body.Channels))
		writeJSON(w, map[string]any{"ok": true, "count": len(body.Channels)})
	})

	mux.HandleFunc("/discover.json", func(w http.ResponseWriter, r *http.Request) {
		base := h.baseURL(r)
		writeJSON(w, map[string]any{
			"FriendlyName":    h.cfg().FriendlyName,
			"Manufacturer":    "Hybroad",
			"ModelNumber":     "HDHR-4DT", // must not contain "hdtc"
			"FirmwareName":    "hdfr",
			"FirmwareVersion": version,
			"DeviceID":        h.cfg().DeviceID,
			"DeviceAuth":      "hdfr",
			"BaseURL":         base,
			"LineupURL":       base + "/lineup.json",
			"TunerCount":      tunerCount,
		})
	})

	mux.HandleFunc("/lineup.json", func(w http.ResponseWriter, r *http.Request) {
		base := h.baseURL(r)
		offset := h.cfg().GuideOffset
		// Audio-only services are left out: the box cannot record them, and
		// Jellyfin would list them as TV channels that never play.
		list := h.streamableChannels()
		out := make([]map[string]any, 0, len(list))
		for _, c := range list {
			out = append(out, map[string]any{
				"GuideNumber": strconv.Itoa(c.LCN + offset),
				"GuideName":   c.Name,
				// /auto, not /tuner0: a media server opens several streams at once
				// (record one channel, watch another), and /tunerN is one viewer.
				"URL": fmt.Sprintf("%s/auto/v%d", base, c.LCN),
				"HD":  1,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(out)
	})

	// Plain M3U for media servers that take an "IPTV Automatic Network" rather
	// than discovering HDHomeRun devices (see m3u.go for why that matters).
	mux.HandleFunc("/playlist.m3u", func(w http.ResponseWriter, r *http.Request) {
		cfg := h.cfg()
		// Audio-only services cannot be recorded, so listing them only gives a
		// scanner something guaranteed to fail.
		tv := h.streamableChannels()
		// ?tuner=N puts every entry on slot N (one viewer: a player changing
		// channel replaces its own stream); ?tuner=auto uses the pool. The
		// default is slot 0, which is what existing playlists already point at.
		path := "/tuner0"
		switch q := r.URL.Query().Get("tuner"); {
		case q == "auto":
			path = "/auto"
		case q != "":
			n, err := strconv.Atoi(q)
			if err != nil || n < 0 || n >= tunerCount {
				http.Error(w, fmt.Sprintf("tuner must be 0-%d or auto", tunerCount-1), http.StatusBadRequest)
				return
			}
			path = fmt.Sprintf("/tuner%d", n)
		}
		body := buildM3U(
			tv,
			guideIDs.channelIDs(h.guide.Path()),
			h.baseURL(r)+path,
			cfg.GuideOffset,
			cfg.GuideCity,
		)
		w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, body)
	})

	// Go subtree patterns end at a slash, so "/tuner/" would match "/tuner/0/v7"
	// and NOT "/tuner0/v7" - register each tuner path the HDHR way instead.
	for i := 0; i < tunerCount; i++ {
		mux.HandleFunc(fmt.Sprintf("/tuner%d/", i), h.serveTuner)
	}
	// /auto/v<lcn> is the real HDHomeRun's "any free tuner" path: pooled, no
	// slot, any number of concurrent streams up to the tuner count.
	mux.HandleFunc("/auto/", h.serveAuto)

	h.registerTVH(mux)

	mux.HandleFunc("/guide.xml", func(w http.ResponseWriter, r *http.Request) {
		// HDFR owns this cache (see guide.go); the ids inside are broadcast LCNs,
		// so <lcn> is rewritten by the same offset as the lineup or the media
		// server cannot match programmes to channels.
		body, err := os.ReadFile(h.guide.Path())
		if err != nil {
			// Serve an empty but valid XMLTV rather than 404: a client that asks
			// before the first refresh finishes should retry, not drop the
			// provider.
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			fmt.Fprintf(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv generator-info-name=\"HDFetchRun\">\n<!-- guide not downloaded yet: %s -->\n</tv>\n", h.guide.Status()["last_error"])
			return
		}
		offset := h.cfg().GuideOffset
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(servedGuide.get(h.guide.Path(), body, offset))
	})

	mux.HandleFunc("/api/guide", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if !h.guide.RefreshAsync() {
				writeJSON(w, map[string]any{"ok": false, "detail": "refresh already running"})
				return
			}
			writeJSON(w, map[string]any{"ok": true, "detail": "refresh started"})
			return
		}
		writeJSON(w, h.guide.Status())
	})

	mux.HandleFunc("/api/device", func(w http.ResponseWriter, r *http.Request) {
		h.setViewing(r.URL.Query().Get("lcn"), r.URL.Query().Get("name"))
		writeJSON(w, map[string]any{"ok": true})
	})

	// Recovery hatch: a client that stops watching but keeps the connection (or a
	// media server that forgets to close its tuner) can hold a stream for minutes.
	// This cancels the handler, which releases the tuner and deletes the file.
	mux.HandleFunc("/api/release", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		lcn := r.URL.Query().Get("lcn")
		if !h.releaseStream(lcn) {
			writeJSON(w, map[string]any{"ok": false, "detail": "no such stream: " + lcn})
			return
		}
		h.log.Printf("stream lcn=%s: released on request", lcn)
		writeJSON(w, map[string]any{"ok": true, "released": lcn})
	})

	mux.HandleFunc("/api/cities", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"current": h.cfg().GuideCity, "cities": cityNames()})
	})

	mux.HandleFunc("/api/guide/city", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		name := r.URL.Query().Get("name")
		picked, ok := cityByName(name)
		if !ok {
			http.Error(w, "unknown city: "+name, http.StatusBadRequest)
			return
		}
		cfg := h.cfg()
		cfg.GuideCity = picked.Name
		cfg.GuideURL = "" // the city table is now the source of truth
		if err := saveConfig(h.cfgPath, cfg); err != nil {
			http.Error(w, "cannot save config: "+err.Error(), http.StatusInternalServerError)
			return
		}
		h.log.Printf("guide: city set to %s (%s)", picked.Name, picked.URL)
		started := h.guide.RefreshAsync()
		writeJSON(w, map[string]any{"ok": true, "city": picked.Name, "url": picked.URL, "refreshing": started})
	})

	// The HDHomeRun contract has two halves: GET /tunerN/vCH *locks* a tuner,
	// and the transport stream itself is read from the device root. Jellyfin
	// does exactly that - its ffmpeg input is "http://<device>/" - which is why
	// the UI lives at /ui/ and "/" is the stream.
	mux.HandleFunc("/", h.serveRoot)
	h.loadRegistry()
	h.sweepOrphans()
	// Sweep again periodically: a stream whose client vanished while the daemon
	// was busy can leave a file behind, and waiting for the next boot is too
	// long. Files in use by a live stream are skipped.
	go func() {
		for range time.Tick(time.Hour) {
			h.sweepOrphans()
		}
	}()
	return h
}

// activeStreams reports the tuners currently in use, for /api/state.
func (h *hdhr) activeStreams() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.streams)+len(h.starting))
	for lcn, ls := range h.streams {
		// Warm recordings are not being watched; listing them as tuned would
		// misreport what viewers are holding.
		if ls.idle {
			continue
		}
		out = append(out, lcn)
	}
	// Include channels whose recorder is still starting. The box starts one
	// recording at a time, so a second request can sit here for seconds before
	// it becomes a stream; without this the UI shows fewer channels than the
	// media server is actually waiting on, which looks like a lost request.
	for lcn := range h.starting {
		out = append(out, lcn+" (starting)")
	}
	sort.Strings(out)
	return out
}

// setViewing records what the box's own player is tuned to. It is reported by
// the page, because only the page can see the vendor tuner; it is not a stream
// and does not use one of the tuner slots hdfrd serves.
func (h *hdhr) setViewing(lcn, name string) {
	n, err := strconv.Atoi(strings.TrimSpace(lcn))
	if err != nil || n <= 0 {
		return
	}
	h.mu.Lock()
	h.viewing = Channel{LCN: n, Name: name}
	h.mu.Unlock()
}

// viewingInfo is what /api/state exposes as the box's own picture.
func (h *hdhr) viewingInfo() any {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.viewing.LCN == 0 {
		return nil
	}
	return h.viewing
}

// releaseStream frees a tuner on request. It must not wait for the streaming
// handler to notice: this box cannot set write deadlines, so a handler blocked
// in Write can sit there for minutes and the slot would stay taken. The map
// entry is removed here, and the handler's own deferred release becomes a
// no-op because the entry is already gone.
func (h *hdhr) releaseStream(lcn string) bool {
	h.mu.Lock()
	ls, ok := h.streams[lcn]
	if !ok {
		h.mu.Unlock()
		return false
	}
	delete(h.streams, lcn)
	h.mu.Unlock()

	if ls.cancel != nil {
		ls.cancel()
	}
	h.stopRecording(lcn, ls.file, ls.handle, ls.id)
	return true
}

// bootCount mirrors the wrapper's counter, which lives outside $ROOT so that it
// survives a missing installation.
func bootCount() int { return readBootCount("/root/boot_count") }

func readBootCount(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// The registry records which PVR files HDFR started. Before the clock was
// synced, "pre-2001 mtime" identified our files; once NTP sets a real clock that
// discriminator is gone, so the daemon remembers its own recordings explicitly.
func (h *hdhr) registryPath() string { return filepath.Join(h.root, "state", "active.json") }

func (h *hdhr) loadRegistry() {
	h.active = map[string]string{}
	raw, err := os.ReadFile(h.registryPath())
	if err != nil {
		return
	}
	if err := json.Unmarshal(raw, &h.active); err != nil {
		h.log.Printf("state: cannot parse %s: %v", h.registryPath(), err)
		h.active = map[string]string{}
	}
}

func (h *hdhr) saveRegistry() {
	h.mu.Lock()
	buf, err := json.MarshalIndent(h.active, "", "  ")
	h.mu.Unlock()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(h.registryPath()), 0o755); err != nil {
		return
	}
	if err := writeFileSync(h.registryPath(), append(buf, '\n'), 0o644); err != nil {
		h.log.Printf("state: cannot write registry: %v", err)
	}
}

func (h *hdhr) noteRecording(file, lcn, handle, id string) {
	h.mu.Lock()
	if h.active == nil {
		h.active = map[string]string{}
	}
	// "lcn|handle": the handle is what stops the recorder, and keeping it in the
	// registry means an orphan can be stopped even after its stream is gone.
	h.active[file] = lcn + "|" + handle + "|" + id
	h.mu.Unlock()
	h.saveRegistry()
}

// splitActive decodes a registry value back into its LCN, handle and id.
func splitActive(v string) (lcn, handle, id string) {
	parts := strings.SplitN(v, "|", 3)
	for len(parts) < 3 {
		parts = append(parts, "")
	}
	return parts[0], parts[1], parts[2]
}

func (h *hdhr) forgetRecording(file string) {
	h.mu.Lock()
	delete(h.active, file)
	h.mu.Unlock()
	h.saveRegistry()
}

// NOTE: recordings are never unlinked. Deleting through the vendor index
// (Ag_playBack_deleteFile) is the only safe removal; see discardRecording.

func (h *hdhr) sweepOrphans() {
	// 1. Anything this daemon started in an earlier run is ours by definition -
	// but never touch a file that a live stream is reading right now.
	h.mu.Lock()
	recorded := make(map[string]string, len(h.active))
	for f, lcn := range h.active {
		recorded[f] = lcn
	}
	inUse := make(map[string]bool, len(h.streams))
	for _, ls := range h.streams {
		inUse[ls.file] = true
	}
	h.mu.Unlock()

	removed := 0
	for file, val := range recorded {
		lcn, handle, id := splitActive(val)
		if !validRecName.MatchString(file) || inUse[file] {
			continue
		}
		// Stop the recorder before touching the file. A recording orphaned by
		// our own restart keeps writing until something stops it: deleting the
		// file only hides it (the box keeps spooling into the unlinked inode and
		// the tuner slot stays taken until a reboot). stopRecording asks the
		// page to stop, then forgets the file.
		h.log.Printf("pvr: stopping orphaned recording %s (lcn=%s) from a previous run", file, lcn)
		h.stopRecording(lcn, file, handle, id)
		removed++
	}

	// 2. Legacy leftovers from before the registry existed: the clock was 1970
	// then, so those files still carry a pre-2001 mtime.
	entries, err := os.ReadDir(pvrDir)
	if err != nil {
		if removed > 0 {
			h.log.Printf("pvr: recovered %d orphaned stream recording(s)", removed)
		}
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".mpg") || !validRecName.MatchString(name) {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Unix() >= 1000000000 {
			continue // 2001-09-09: a real recording, hands off
		}
		before := info.Size()
		time.Sleep(200 * time.Millisecond)
		if again, err := os.Stat(filepath.Join(pvrDir, name)); err == nil && again.Size() != before {
			continue
		}
		// Deliberately not unlinked: a leftover file is harmless next to a
		// corrupted PVR index. It is reported so it can be removed knowingly.
		h.log.Printf("pvr: leftover pre-registry recording %s (%d bytes, id unknown) - left in place", name, before)
	}
	if removed > 0 {
		h.log.Printf("pvr: swept %d orphaned stream recording(s)", removed)
	}
}

// serveRoot streams whichever tuner was opened last, which is what a real
// HDHomeRun does after a lock.
//
// Only the exact path "/": the mux sends every unmatched path here, and the
// box's own browser asks for /favicon.ico whenever the page loads. Serving that
// as a stream made the browser a hidden viewer that held a tuner (and kept a
// recording running) until the next page load - found 2026-11-27.
func (h *hdhr) serveRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	h.mu.Lock()
	lcn := h.lastLCN
	h.mu.Unlock()
	if lcn == "" {
		http.Error(w, "no tuner locked", http.StatusServiceUnavailable)
		return
	}
	h.serveLCN(w, r, lcn)
}

func (h *hdhr) cfg() Config {
	c, err := loadConfig(h.cfgPath)
	if err != nil {
		return defaultConfig()
	}
	return c
}

// baseURL follows the request: adding the tuner by address means the client's
// own Host is the only address we know is reachable.
func (h *hdhr) baseURL(r *http.Request) string {
	host := r.Host
	if host == "" || strings.HasPrefix(host, "127.0.0.1") || strings.HasPrefix(host, "localhost") {
		host = fmt.Sprintf("%s:%d", firstIPv4(), h.port)
	}
	return "http://" + host
}

func (h *hdhr) setChannels(list []Channel) {
	h.mu.Lock()
	h.channels = list
	h.chanAt = time.Now()
	h.mu.Unlock()
	// Persist: the page only posts when it reads the tuner, so a daemon restart
	// (or a reboot before the page loads) must not empty /lineup.json.
	if buf, err := json.Marshal(list); err == nil {
		if err := writeFileSync(filepath.Join(h.root, "channels.json"), buf, 0o644); err != nil {
			h.log.Printf("channels: cannot persist list: %v", err)
		}
	}
}

func (h *hdhr) loadChannels() {
	buf, err := os.ReadFile(filepath.Join(h.root, "channels.json"))
	if err != nil {
		return
	}
	var list []Channel
	if json.Unmarshal(buf, &list) != nil {
		return
	}
	h.mu.Lock()
	h.channels = list
	h.chanAt = time.Now()
	h.mu.Unlock()
	h.log.Printf("channels: restored %d from channels.json", len(list))
}

// channelName resolves an LCN to its display name, or "" if unknown. Used to
// refuse audio-only services before the recorder is asked to start.
func (h *hdhr) channelName(lcn string) string {
	for _, c := range h.channelList() {
		if strconv.Itoa(c.LCN) == lcn {
			return c.Name
		}
	}
	return ""
}

func (h *hdhr) channelList() []Channel {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Channel, len(h.channels))
	copy(out, h.channels)
	return out
}

// slotHold is one viewer on a /tuner<i> slot.
type slotHold struct {
	idx    int
	lcn    string
	client string             // remote IP; only the same client may replace it
	cancel context.CancelFunc // set once the stream is serving
	// superseded is set when a newer request has taken the slot; a stream still
	// starting checks it after acquire and gives the tuner straight back.
	superseded bool
	// prev is the hold this one replaced on the same channel. It is cancelled
	// only after this stream has acquired, so the recording is shared rather
	// than stopped and started again.
	prev *slotHold
	done chan struct{} // closed when this stream has released its tuner
}

// serveTuner handles GET /tuner<index>/v<lcn>, where each index is a slot for
// one viewer. A new request on a slot replaces what that slot was showing: a
// player changing channel says so explicitly, instead of the daemon inferring
// it from an old connection that may linger. Clients that open several streams
// at once (media servers) use /auto instead.
//
// Only the client already holding the slot can replace its stream. A request
// from another machine on a busy slot is served from the pool instead, so two
// players configured on the same slot cannot cut each other off.
func (h *hdhr) serveTuner(w http.ResponseWriter, r *http.Request) {
	idx, lcn, ok := parseTunerSlot(r.URL.Path)
	if !ok || idx >= tunerCount {
		http.NotFound(w, r)
		return
	}
	client := clientIP(r)
	h.mu.Lock()
	h.lastLCN = lcn // a lock also makes this channel the one served at "/"
	old := h.slots[idx]
	if old != nil && old.client != client {
		h.mu.Unlock()
		h.log.Printf("tuner%d: held by %s for lcn %s; serving %s's lcn %s from the pool", idx, old.client, old.lcn, client, lcn)
		h.serveStream(w, r, lcn, nil)
		return
	}
	hold := &slotHold{idx: idx, lcn: lcn, client: client, done: make(chan struct{})}
	h.slots[idx] = hold
	var cancelOld context.CancelFunc
	if old != nil {
		old.superseded = true
		if old.lcn == lcn {
			hold.prev = old // same channel: share the recording, cancel after acquire
		} else {
			cancelOld = old.cancel
		}
	}
	h.mu.Unlock()

	if old != nil && old.lcn != lcn {
		// Different channel: end the old stream first so its tuner is free for
		// this start. If it is still starting, it sees superseded and returns.
		h.log.Printf("tuner%d: lcn %s replaces lcn %s", idx, lcn, old.lcn)
		if cancelOld != nil {
			cancelOld()
		}
		select {
		case <-old.done:
		case <-time.After(slotHandoverWait):
			h.log.Printf("tuner%d: lcn %s did not release within %s; starting anyway", idx, old.lcn, slotHandoverWait)
		}
	} else if old != nil {
		h.log.Printf("tuner%d: lcn %s requested again; handing the recording over", idx, lcn)
	}
	h.serveStream(w, r, lcn, hold)
}

// serveAuto handles GET /auto/v<lcn>: any free tuner, no slot.
func (h *hdhr) serveAuto(w http.ResponseWriter, r *http.Request) {
	lcn := strings.TrimPrefix(r.URL.Path, "/auto/v")
	if lcn == "" || strings.Trim(lcn, "0123456789") != "" {
		http.NotFound(w, r)
		return
	}
	h.mu.Lock()
	h.lastLCN = lcn
	h.mu.Unlock()
	h.serveStream(w, r, lcn, nil)
}

// clientIP is the request's remote address without the port.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// slotsInfo describes the occupied slots, for /api/state.
func (h *hdhr) slotsInfo() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for i, s := range h.slots {
		if s != nil {
			out = append(out, fmt.Sprintf("tuner%d: lcn %s (%s)", i, s.lcn, s.client))
		}
	}
	return out
}

// endSlot clears the slot if this hold still owns it and signals the handover.
func (h *hdhr) endSlot(hold *slotHold) {
	if hold == nil {
		return
	}
	h.mu.Lock()
	if h.slots[hold.idx] == hold {
		h.slots[hold.idx] = nil
	}
	h.mu.Unlock()
	close(hold.done)
}

func (h *hdhr) serveLCN(w http.ResponseWriter, r *http.Request, lcn string) {
	h.serveStream(w, r, lcn, nil)
}

func (h *hdhr) serveStream(w http.ResponseWriter, r *http.Request, lcn string, slot *slotHold) {
	defer h.endSlot(slot)
	// Refuse audio-only services before touching the recorder: the box never
	// produces a file for them, so the retries would burn 45 seconds and end in
	// the same refusal.
	if name := h.channelName(lcn); h.unstreamable(lcn, name) {
		h.log.Printf("stream lcn=%s: %q is audio-only, not streamable", lcn, name)
		http.Error(w, "audio-only channel", http.StatusForbidden)
		return
	}

	ls, err := h.acquire(lcn)
	if err != nil {
		h.log.Printf("stream lcn=%s: %v", lcn, err)
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer h.release(lcn)

	// A release request cancels this context, which ends the loop and frees the
	// tuner. A handler blocked in Write is unblocked by its write deadline.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	h.mu.Lock()
	ls.cancel = cancel
	var prev *slotHold
	superseded := false
	if slot != nil {
		slot.cancel = cancel
		superseded = slot.superseded
		prev, slot.prev = slot.prev, nil
	}
	var cancelPrev context.CancelFunc
	if prev != nil {
		cancelPrev = prev.cancel
	}
	h.mu.Unlock()
	if superseded {
		// A newer request took this slot while we were starting.
		h.log.Printf("tuner%d: lcn %s was replaced while starting; releasing it", slot.idx, lcn)
		http.Error(w, "replaced by a newer request on this tuner", http.StatusConflict)
		return
	}
	if cancelPrev != nil {
		cancelPrev() // the old viewer of this channel; we now hold the recording
	}

	f, err := os.Open(filepath.Join(pvrDir, ls.file))
	if err != nil {
		h.log.Printf("stream lcn=%s: open %s: %v", lcn, ls.file, err)
		http.Error(w, "recording file unreadable", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// Wait for the recorder to actually write something before replying, so the
	// client's probe does not see an empty stream.
	deadline := time.Now().Add(firstByteWait)
	var size int64
	for {
		if st, err := f.Stat(); err == nil {
			size = st.Size()
			if size > ls.base || time.Now().After(deadline) {
				break
			}
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(tailPollSleep)
	}

	// Join at a keyframe so the client has a picture immediately instead of
	// waiting for the next IDR (most visible on HD channels).
	start := keyframeStart(f, ls.base)
	if start > 0 {
		if _, err := f.Seek(start, io.SeekStart); err != nil {
			h.log.Printf("stream lcn=%s: seek %d failed: %v", lcn, start, err)
		} else {
			h.log.Printf("stream lcn=%s: starting at keyframe offset %d", lcn, start)
		}
	}
	h.log.Printf("stream lcn=%s: serving %s (%d bytes so far, %d before this stream)", lcn, ls.file, size, ls.base)

	// Headers first, then stream through the normal ResponseWriter: this is the
	// path Jellyfin has been reading happily, and with Unwrap on our logging
	// wrapper http.ResponseController can now set write deadlines on it.
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		h.log.Printf("stream lcn=%s: cannot set write deadline: %v", lcn, err)
	}

	// PSI first. The recording is joined at a video keyframe, and on this box the
	// PAT/PMT can be hundreds of KB further on (~0.4 s). A scanner tolerates that;
	// TVHeadend does not - its libav runs with analyzeduration=0, decides stream
	// parameters from the first packets, and reports the audio as "mp3, 0
	// channels" before failing the mux with "No input detected". Sending the
	// recorded PSI up front makes the first packets self-describing.
	if psi := psiPrelude(f, ls.base, size); len(psi) > 0 {
		_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
		if _, werr := w.Write(psi); werr != nil {
			h.log.Printf("stream lcn=%s: client gone writing PSI prelude: %v", lcn, werr)
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		h.log.Printf("stream lcn=%s: sent %d bytes of PSI before the keyframe", lcn, len(psi))
	}

	buf := make([]byte, 64*1024)
	lastData := time.Now()
	var sent int64
	restarts := 0
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			lastData = time.Now()
			// A client that stops reading must not pin the tuner: give every
			// write a deadline and drop the stream when it expires.
			_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
			if _, werr := w.Write(buf[:n]); werr != nil {
				h.log.Printf("stream lcn=%s: client gone after %d bytes (sent %d): %v", lcn, n, sent, werr)
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
			sent += int64(n)
			ls.lastWriteAt(h)
			continue
		}
		if rerr != nil && rerr != io.EOF {
			h.log.Printf("stream lcn=%s: read error: %v", lcn, rerr)
			break
		}
		// The recorder should always be writing. When it stops, the client is
		// left holding a frozen picture (VLC loops on the last second forever),
		// so try to start a fresh recording for the same channel and carry on
		// from it: a short gap is recoverable, a dead connection is not.
		if time.Since(lastData) > stallGrace && restarts < maxRestarts {
			restarts++
			h.log.Printf("stream lcn=%s: no data for %s, restarting the recorder (%d/%d)",
				lcn, stallGrace, restarts, maxRestarts)
			if nf, nstart, ok := h.recoverStalled(lcn, ls); ok {
				_ = f.Close()
				if handle, err := os.Open(filepath.Join(pvrDir, nf)); err == nil {
					f = handle
					if _, err := f.Seek(nstart, io.SeekStart); err == nil {
						h.mu.Lock()
						ls.file = nf
						ls.base = nstart
						h.mu.Unlock()
						lastData = time.Now()
						h.log.Printf("stream lcn=%s: recovered on %s at offset %d", lcn, nf, nstart)
						continue
					}
					f.Close()
				}
			}
			h.log.Printf("stream lcn=%s: recovery failed", lcn)
			break
		}
		if time.Since(lastData) > stallTimeout {
			h.log.Printf("stream lcn=%s: no data for %s, dropping the stream", lcn, stallTimeout)
			break
		}
		select {
		case <-ctx.Done():
			h.log.Printf("stream lcn=%s: request cancelled after %d bytes", lcn, sent)
			return
		case <-time.After(tailPollSleep):
		}
	}
	h.log.Printf("stream lcn=%s: stream ended after %d bytes", lcn, sent)
}

// recoverStalled stops a dead recorder and starts a fresh one for the same
// channel, returning the new file and the offset to continue from.
func (h *hdhr) recoverStalled(lcn string, ls *liveStream) (string, int64, bool) {
	// Stop first, and wait for the acknowledgement: a start issued into a
	// stopping recorder produces another dead stream.
	h.lockRecorder(10 * time.Second)
	if v := h.handles.verdict(ls.handle, ls.id, false); v == stopAllowed {
		c := h.cmds.add("stream_stop", lcn+"|"+ls.handle)
		if _, ok := h.cmds.wait(c.ID, 10*time.Second); ok {
			h.handles.markStopped(ls.id)
		}
	} else {
		h.log.Printf("stream lcn=%s: not stopping handle %s for record %s (%s)", lcn, ls.handle, ls.id, v)
	}
	h.unlockRecorder()
	h.forgetRecording(ls.file)

	existing := listRecordings(pvrDir)
	since := time.Now()
	h.lockRecorder(10 * time.Second)
	c2 := h.cmds.add("stream_start", lcn)
	rep, ok := h.cmds.wait(c2.ID, streamTimeout)
	h.claimHandle(rep, ok)
	h.unlockRecorder()
	if !ok || !rep.OK {
		return "", 0, false
	}

	f, base, found := waitGrowingRecording(pvrDir, existing, since, h.inUse())
	if !found {
		h.stopRecording(lcn, "", detailValue(rep.Detail, "handle"), detailValue(rep.Detail, "id"))
		return "", 0, false
	}

	// A fresh recording gets the same checks as a first one.
	if prog := h.observeProgram(f, base, 1500*time.Millisecond); prog != 0 {
		if want := h.progs.get(lcn); want != 0 && want != prog {
			h.log.Printf("stream lcn=%s: recovered file %s is program %d, expected %d", lcn, f, prog, want)
			h.stopRecording(lcn, f, detailValue(rep.Detail, "handle"), detailValue(rep.Detail, "id"))
			return "", 0, false
		}
	}

	h.mu.Lock()
	ls.handle = detailValue(rep.Detail, "handle")
	ls.id = detailValue(rep.Detail, "id")
	h.mu.Unlock()
	h.noteRecording(f, lcn, ls.handle, ls.id)

	// Continue a little behind the new recording's start so the join is on a
	// packet boundary rather than mid-PES.
	off := base
	if fh, err := os.Open(filepath.Join(pvrDir, f)); err == nil {
		if k := keyframeStart(fh, base); k > off {
			off = k
		}
		fh.Close()
	}
	return f, off, true
}

// acquire returns the stream for this LCN, starting a recording the first time.
// A second client on the same channel shares it (one tuner, one file).
// reclaimAllWarm stops every warm stream. They hold real recorder tuners on the
// box, so when a start fails because nothing could be recorded, freeing them is
// the difference between a retry that works and one that fails the same way.
func (h *hdhr) reclaimAllWarm() int {
	h.mu.Lock()
	var warm []string
	for lcn, ls := range h.streams {
		if ls.idle {
			warm = append(warm, lcn)
		}
	}
	h.mu.Unlock()
	for _, lcn := range warm {
		h.log.Printf("stream lcn=%s: releasing warm tuner to make room", lcn)
		h.releaseStream(lcn)
	}
	return len(warm)
}

// servedGuide caches the guide as served (LCNs shifted, programme icons
// removed). Stripping takes ~0.7 s on a PC and several times that on the box,
// so it is redone only when the guide file or the offset changes.
var servedGuide guideCache

type guideCache struct {
	mu     sync.Mutex
	path   string
	size   int64
	mtime  time.Time
	offset int
	out    []byte
}

func (c *guideCache) get(path string, raw []byte, offset int) []byte {
	st, err := os.Stat(path)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil && c.out != nil && c.path == path && c.size == st.Size() &&
		c.mtime.Equal(st.ModTime()) && c.offset == offset {
		return c.out
	}
	out := stripProgrammeIcons(shiftGuideLCNs(raw, offset))
	if err == nil {
		c.path, c.size, c.mtime, c.offset, c.out = path, st.Size(), st.ModTime(), offset, out
	}
	return out
}

// lockResponsive reports whether h.mu can be taken within d. Used by the health
// check; the probe goroutine is left to finish on its own if the lock is stuck.
func (h *hdhr) lockResponsive(d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		h.mu.Lock()
		h.mu.Unlock()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// tunerWarning records evidence of a stuck recording tuner.
type tunerWarning struct {
	At     time.Time
	LCN    string
	Freq   int
	InUse  int // multiplexes being recorded when the start failed
	Events int // how many such failures since the warning was raised
}

// Recording tuners can stop accepting a new frequency (measured 2026-11-26/27:
// with two multiplexes recording, every start on a third was accepted and wrote
// nothing; after a reboot three multiplexes recorded at once). The box reports
// nothing, so infer it: a start that writes no file is only evidence when its
// multiplex is not already being recorded (then it needed a free tuner) and
// fewer multiplexes are in use than there are tuners (so one should have been
// free).

// freqOf returns the multiplex frequency of an LCN, or 0 if unknown.
func (h *hdhr) freqOf(lcn string) int {
	for _, c := range h.channelList() {
		if strconv.Itoa(c.LCN) == lcn {
			return c.Freq
		}
	}
	return 0
}

// muxesInUse returns the multiplexes our streams are recording, other than
// the given LCN's own stream. Unknown frequencies are counted as distinct.
func (h *hdhr) muxesInUse(except string) map[int]bool {
	h.mu.Lock()
	lcns := make([]string, 0, len(h.streams))
	for l := range h.streams {
		if l != except {
			lcns = append(lcns, l)
		}
	}
	h.mu.Unlock()
	m := map[int]bool{}
	for i, l := range lcns {
		f := h.freqOf(l)
		if f == 0 {
			f = -1 - i
		}
		m[f] = true
	}
	return m
}

// healthyOnMux returns a channel, other than except, that is recording on this
// multiplex and has delivered data in the last few seconds; "" if none.
func (h *hdhr) healthyOnMux(freq int, except string) string {
	h.mu.Lock()
	cands := map[string]time.Time{}
	for l, ls := range h.streams {
		if l != except && ls.file != "" {
			cands[l] = ls.lastWrite
		}
	}
	h.mu.Unlock()
	for l, at := range cands {
		if time.Since(at) < 5*time.Second && h.freqOf(l) == freq {
			return l
		}
	}
	return ""
}

// noteNoFile is called when a start was accepted but wrote nothing. It reports
// whether that is evidence of a stuck tuner, and raises the warning if so.
func (h *hdhr) noteNoFile(lcn string) bool {
	f := h.freqOf(lcn)
	if f == 0 {
		return false
	}
	if other := h.healthyOnMux(f, lcn); other != "" {
		// The multiplex is tuned and recording, so the tuner is fine: it is the
		// service that cannot be recorded (an audio-only channel).
		name := h.channelName(lcn)
		if h.audio.learn(lcn, name) {
			h.log.Printf("channels: lcn %s (%q) was accepted but recorded nothing while lcn %s records on the same multiplex - marking it audio-only (state/%s)",
				lcn, name, other, audioOnlyStateName)
		}
		return false
	}
	inUse := h.muxesInUse(lcn)
	if inUse[f] || len(inUse) >= tunerCount {
		return false
	}
	h.mu.Lock()
	if h.tunerWarn == nil {
		h.tunerWarn = &tunerWarning{At: time.Now(), LCN: lcn, Freq: f, InUse: len(inUse)}
	}
	h.tunerWarn.Events++
	n := h.tunerWarn.Events
	h.mu.Unlock()
	h.log.Printf("tuners: lcn %s (multiplex %d) was accepted but recorded nothing while only %d of %d multiplexes are recording - a recording tuner appears stuck (%d such failure(s)); a reboot clears it",
		lcn, f, len(inUse), tunerCount, n)
	return true
}

// noteStarted clears the warning when a start succeeds on a new multiplex with
// at least as many multiplexes in use as when the warning was raised: the tuner
// that was refusing would have been needed for that.
func (h *hdhr) noteStarted(lcn string) {
	h.mu.Lock()
	w := h.tunerWarn
	h.mu.Unlock()
	if w == nil {
		return
	}
	f := h.freqOf(lcn)
	inUse := h.muxesInUse(lcn)
	if f == 0 || inUse[f] || len(inUse) < w.InUse {
		return
	}
	h.mu.Lock()
	h.tunerWarn = nil
	h.mu.Unlock()
	h.log.Printf("tuners: lcn %s started on a new multiplex with %d others recording; clearing the stuck-tuner warning", lcn, len(inUse))
}

// tunerWarningText is the plain-English state for /api/state and the menu.
func (h *hdhr) tunerWarningText() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	w := h.tunerWarn
	if w == nil {
		return ""
	}
	return fmt.Sprintf("one appears stuck since %s (lcn %s, %d failure(s)) - reboot the box to clear it",
		w.At.UTC().Format("15:04Z"), w.LCN, w.Events)
}

// claimHandle records the handle a successful start was given. Called while the
// recorder gate is held, so no stop can slip in between the start and the claim.
func (h *hdhr) claimHandle(rep Report, ok bool) {
	if ok && rep.OK {
		h.handles.claim(detailValue(rep.Detail, "handle"), detailValue(rep.Detail, "id"))
	}
}

// stopKey names one recording for the stop dedupe: its record id, which is
// unique per start, or failing that its file. Files make bad keys - two streams
// can share a misattributed file, and a foreign file that never stops growing
// used to block every later stop keyed by it.
func stopKey(file, id string) string {
	if id != "" && id != "0" {
		return "id:" + id
	}
	if file != "" {
		return "file:" + file
	}
	return ""
}

// beginStopping marks a recording as being stopped. It returns false if a stop
// for it is already in progress, in which case the caller must not send another.
func (h *hdhr) beginStopping(key string) bool {
	if key == "" {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopping[key] {
		return false
	}
	if h.stopping == nil {
		h.stopping = map[string]bool{}
	}
	h.stopping[key] = true
	return true
}

func (h *hdhr) endStopping(key string) {
	h.mu.Lock()
	delete(h.stopping, key)
	h.mu.Unlock()
}

func (h *hdhr) setRetiring(file string, on bool) {
	if file == "" {
		return
	}
	h.mu.Lock()
	if on {
		if h.retiring == nil {
			h.retiring = map[string]bool{}
		}
		h.retiring[file] = true
	} else {
		delete(h.retiring, file)
	}
	h.mu.Unlock()
}

func (h *hdhr) claimFile(file string) {
	h.mu.Lock()
	if h.claimed == nil {
		h.claimed = map[string]bool{}
	}
	h.claimed[file] = true
	h.mu.Unlock()
}

func (h *hdhr) unclaimFile(file string) {
	h.mu.Lock()
	delete(h.claimed, file)
	h.mu.Unlock()
}

// lockRecorder waits until no other recorder command is in flight.
func (h *hdhr) lockRecorder(wait time.Duration) bool {
	if h.recGate == nil {
		return true
	}
	select {
	case h.recGate <- struct{}{}:
		return true
	case <-time.After(wait):
		h.log.Printf("recorder busy for %s; proceeding anyway", wait)
		return false
	}
}

func (h *hdhr) unlockRecorder() {
	if h.recGate == nil {
		return
	}
	select {
	case <-h.recGate:
	default:
	}
}

func (h *hdhr) acquire(lcn string) (*liveStream, error) {
	// Reserve the slot before talking to the box: the page takes seconds to
	// start a recording, and without this reservation concurrent requests all
	// pass the limit check and oversubscribe the hardware.
	deadline := time.Now().Add(tunerWait)
	waited := false
	for attempt := 0; ; attempt++ {
		h.mu.Lock()
		if ls, ok := h.streams[lcn]; ok {
			// A warm recording is reused as-is: the recorder is already
			// running, so the first byte is immediate.
			if ls.idle {
				ls.idle = false
				ls.expire = time.Time{}
				// Join near the live edge, not at the recording's beginning: the
				// file has been running while nobody watched, and replaying it
				// from offset 0 shows stale content (and then stalls at EOF).
				if st, err := os.Stat(filepath.Join(pvrDir, ls.file)); err == nil {
					from := st.Size() - tsLiveWindow
					if from < 0 {
						from = 0
					}
					ls.base = from
				}
				h.log.Printf("stream lcn=%s: reusing warm recording %s from %d", lcn, ls.file, ls.base)
			}
			ls.refs++
			h.mu.Unlock()
			return ls, nil
		}
		if h.starting[lcn] {
			h.mu.Unlock()
			// Someone else is already starting this channel; wait for them
			// rather than starting a second recording of it.
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("timed out waiting for lcn %s to start", lcn)
			}
			time.Sleep(tunerPollSleep)
			continue
		}
		if len(h.streams)+len(h.starting) >= tunerCount {
			// Everything is busy. If one of those is a warm recording nobody is
			// watching, give it back rather than making this client wait: that
			// is the whole point of warming.
			warm := h.oldestWarmLocked()
			h.mu.Unlock()
			if warm != "" {
				h.log.Printf("stream lcn=%s: reclaiming warm tuner %s", lcn, warm)
				h.releaseStream(warm)
				// Let the box finish closing that recorder before starting the
				// next one. A start issued into a stopping recorder produces a
				// stream that dies after a couple of seconds, which a player sees
				// as a freeze.
				time.Sleep(stopSettle)
				continue
			}
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("all %d tuners busy after waiting %s", tunerCount, tunerWait)
			}
			waited = true
			time.Sleep(tunerPollSleep)
			continue
		}
		if h.starting == nil {
			h.starting = map[string]bool{}
		}
		h.starting[lcn] = true
		h.mu.Unlock()
		break
	}
	if waited {
		h.log.Printf("stream lcn=%s: waited for a free tuner", lcn)
	}

	releaseSlot := func() {
		h.mu.Lock()
		delete(h.starting, lcn)
		h.mu.Unlock()
	}

	// One recorder operation at a time: the page polls its command queue and
	// processes commands strictly in order, so overlapping starts are what
	// produce "no file appeared" and "start failed h=-1" from the box.
	//
	// Retries matter because teardown lags: a slot can be free by our count
	// while the box is still closing the previous recorder, and the vendor call
	// then fails with h=-1. Retrying a couple of seconds later succeeds.
	var (
		rep Report
		ok  bool
	)
	h.lockRecorder(10 * time.Second)
	h.startMu.Lock()
	// Snapshot the recordings that already exist, so the file the box creates
	// for this start can be identified without the page having to list the
	// directory (that listing is what used to cost the first five seconds).
	existing := listRecordings(pvrDir)
	since := time.Now()
	for attempt := 1; attempt <= startAttempts; attempt++ {
		c := h.cmds.add("stream_start", lcn)
		rep, ok = h.cmds.wait(c.ID, streamTimeout)
		h.claimHandle(rep, ok)
		if ok && rep.OK {
			break
		}
		if attempt < startAttempts {
			h.log.Printf("stream lcn=%s: start attempt %d failed (%s), retrying", lcn, attempt, startDetail(rep, ok))
			time.Sleep(startRetryDelay)
		}
	}
	h.unlockRecorder()
	// startMu stays held until this start's file is identified and claimed.
	// Released earlier, two starts in flight both waited for "a new growing
	// file" and both took the first to appear (measured 2026-11-26 10:05:06:
	// channels 2 and 44 both served record247.mpg, and 2 learned 44's program).
	startHeld := true
	endStart := func() {
		if startHeld {
			startHeld = false
			h.startMu.Unlock()
		}
	}
	defer endStart()
	if !ok {
		releaseSlot()
		// No answer means we do not know whether a recorder exists; tell the page to
		// stop whatever it has for this LCN rather than risk an unkillable orphan.
		h.log.Printf("stream lcn=%s: no answer to start - clearing any recorder for it", lcn)
		h.stopRecording(lcn, "", "", "")
		return nil, fmt.Errorf("box did not answer the start command")
	}
	if !rep.OK {
		releaseSlot()
		// The usual cause is the box's own tuner pool being full, which is a
		// separate limit from ours.
		return nil, fmt.Errorf("box could not start recording lcn %s: %s", lcn, rep.Detail)
	}
	file := detailValue(rep.Detail, "file")
	var base int64
	if file == "" {
		// The page answers as soon as the recorder is running; the file shows up
		// a moment later, and this process can see the directory directly.
		f, newBase, found := waitGrowingRecording(pvrDir, existing, since, h.inUse())
		base = newBase
		if found {
			// Confirm the file against the vendor index before trusting it. The
			// index knows how big the recording with this id has become, so a
			// file of a different size is somebody else's.
			id := detailValue(rep.Detail, "id")
			// The vendor index creates the entry at start but leaves its size at 0
			// until the recording finishes (measured 2026-11-26), so it can only
			// identify a file after the fact. Verify only when it actually has a
			// size; otherwise stay quiet rather than log a meaningless "verified".
			if kb, ok := h.recordSizeKB(id); ok && kb > 0 {
				if st, err := os.Stat(filepath.Join(pvrDir, f)); err == nil {
					diff := st.Size() - kb*1024
					if diff < 0 {
						diff = -diff
					}
					if diff > 512*1024 {
						h.log.Printf("stream lcn=%s: %s does not match record %s (file %d bytes, index %d KB) - looking again",
							lcn, f, id, st.Size(), kb)
						skip := h.inUse()
						skip[f] = true
						if f2, b2, ok2 := waitGrowingRecording(pvrDir, listRecordings(pvrDir), time.Now(), skip); ok2 {
							f, base, found = f2, b2, true
							if kb2, ok3 := h.recordSizeKB(id); ok3 {
								if st2, err := os.Stat(filepath.Join(pvrDir, f)); err == nil {
									if d2 := absDiff(st2.Size(), kb2*1024); d2 <= 512*1024 {
										h.log.Printf("stream lcn=%s: %s verified against record %s (%d KB)", lcn, f, id, kb2)
									}
								}
							}
						}
					} else {
						h.log.Printf("stream lcn=%s: %s verified against record %s (%d KB)", lcn, f, id, kb)
					}
				}
			}
		}
		if !found {
			// A stale warm recorder can occupy the box while our own count says
			// there is room. Free them and try once more before giving up.
			if n := h.reclaimAllWarm(); n > 0 {
				h.log.Printf("stream lcn=%s: no file appeared; released %d warm tuner(s) and retrying", lcn, n)
				time.Sleep(startRetryDelay)
				h.lockRecorder(10 * time.Second)
				existing = listRecordings(pvrDir)
				since = time.Now()
				c3 := h.cmds.add("stream_start", lcn)
				rep, ok = h.cmds.wait(c3.ID, streamTimeout)
				h.claimHandle(rep, ok)
				h.unlockRecorder()
				if ok && rep.OK {
					f, base, found = waitGrowingRecording(pvrDir, existing, since, h.inUse())
				}
			}
		}
		if !found {
			releaseSlot()
			// The box answered that it was recording, so a recorder exists. Abandoning
			// it here is what used to leak a tuner: the handle was never used to stop.
			h.log.Printf("stream lcn=%s: start accepted (%s) but no file appeared - stopping it", lcn, rep.Detail)
			h.stopRecording(lcn, "", detailValue(rep.Detail, "handle"), detailValue(rep.Detail, "id"))
			if h.noteNoFile(lcn) {
				return nil, fmt.Errorf("no recording file appeared for lcn %s: a recording tuner appears stuck, a reboot of the box clears it", lcn)
			}
			return nil, fmt.Errorf("no recording file appeared for lcn %s", lcn)
		}
		file = f
		// Tell the page which file this is, so stopping can delete it.
		h.cmds.add("setfile", lcn+"|"+file)
	}
	// Claim the file before letting the next start look for one, and keep the
	// claim until the stream is registered (inUse covers it from then on).
	h.claimFile(file)
	defer h.unclaimFile(file)
	endStart()

	// Verify the candidate against what this channel is known to record as.
	// No lock is held here: the check reads the file and may wait for its PSI,
	// and holding h.mu for that would stall every other request meanwhile.
	{
		// Only wait for the PSI when there is something to compare it against:
		// on a first visit the observation only teaches us the value, and making
		// the viewer wait for that is a cost with no benefit.
		wait := 0 * time.Millisecond
		if h.progs.known(lcn) {
			wait = 1500 * time.Millisecond
		}
		if prog := h.observeProgram(file, base, wait); prog != 0 {
			want := h.progs.get(lcn)
			switch {
			case want == 0 && base > 0:
				// Only learn from a file this start created. A file that already
				// held data may be another recorder's (measured: a leaked 7two
				// recording taught channels 2 and 10 that they were 7two).
				h.log.Printf("stream lcn=%s: %s carries program %d; not learning it from a file that predates this start",
					lcn, file, prog)
			case want == 0:
				if other := h.progs.learn(lcn, prog); other != "" {
					h.log.Printf("stream lcn=%s: %s carries program %d, which is channel %s's; serving unverified, not learning it",
						lcn, file, prog, other)
				} else {
					h.log.Printf("stream lcn=%s: learned program %d for this channel", lcn, prog)
				}
			case want == prog:
				h.log.Printf("stream lcn=%s: %s carries program %d, as expected", lcn, file, prog)
			case base == 0 && h.progs.owner(prog, lcn) == "":
				// A mismatch is only proof of a wrong channel when the program
				// belongs to another known channel. A program no channel owns, in a
				// file this start created, means the map was wrong: correct it.
				h.progs.learn(lcn, prog)
				h.log.Printf("stream lcn=%s: %s carries program %d, not the %d on record, and no other channel has %d - correcting the map",
					lcn, file, prog, want, prog)
			default:
				// Provably the wrong recording: refuse it rather than serve it.
				h.log.Printf("stream lcn=%s: REJECTING %s: program %d (channel %s), channel records as %d",
					lcn, file, prog, h.progs.owner(prog, lcn), want)
				releaseSlot()
				// Stop OUR recorder, by handle only. The rejected file is somebody
				// else's: passing it here marked it "stopping" and, as it never
				// stops growing, every later stop was refused as a duplicate.
				h.stopRecording(lcn, "", detailValue(rep.Detail, "handle"), detailValue(rep.Detail, "id"))
				return nil, fmt.Errorf("recording for lcn %s belongs to another channel (program %d)", lcn, prog)
			}
		} else {
			// Not enough data yet: learn it later from the running recording, so
			// the next start of this channel can be verified.
			go func(file, lcn string) {
				if base > 0 {
					return // same rule: never learn from a file that predates this start
				}
				if p := h.observeProgram(file, base, 15*time.Second); p != 0 && !h.progs.known(lcn) {
					if other := h.progs.learn(lcn, p); other != "" {
						h.log.Printf("stream lcn=%s: %s carries channel %s's program %d; not learning it", lcn, file, other, p)
					} else {
						h.log.Printf("stream lcn=%s: learned program %d from %s", lcn, p, file)
					}
				}
			}(file, lcn)
		}
	}

	h.noteStarted(lcn)
	ls := &liveStream{lcn: lcn, file: file, refs: 1, lastWrite: time.Now(), base: base,
		handle: detailValue(rep.Detail, "handle"),
		id:     detailValue(rep.Detail, "id")}
	h.mu.Lock()
	delete(h.starting, lcn)
	h.streams[lcn] = ls
	h.mu.Unlock()

	h.log.Printf("stream lcn=%s: recording %s started (%s)", lcn, file, rep.Detail)
	h.noteRecording(file, lcn, ls.handle, ls.id)
	return ls, nil
}

// psiPrelude returns PAT and PMT packets copied from the recording, repeated a
// few times, to be written before the keyframe join.
//
// Without it the client can receive hundreds of KB of video before the first
// PAT, which is legal MPEG-TS but defeats short-probe consumers: TVHeadend's
// libav gives up on the audio and drops the mux.
func psiPrelude(f *os.File, floor, size int64) []byte {
	if floor < 0 {
		floor = 0
	}
	window := size - floor
	if window > 4<<20 {
		window = 4 << 20 // PSI repeats well inside 4 MB even on a sparse mux
	}
	if window <= 0 {
		return nil
	}
	buf := make([]byte, window)
	n, err := f.ReadAt(buf, floor)
	if err != nil && n == 0 {
		return nil
	}
	buf = buf[:n]

	// Find the PAT on PID 0 first, then use its program map to identify the PMT
	// packets. Matching on table_id alone is not safe: a video PES starts with
	// 00 00 01, which looks exactly like pointer_field 0 followed by table 0x00.
	var pat []byte
	pmtPIDs := map[uint16]bool{}
	for off := 0; off+188 <= len(buf); off += 188 {
		pkt := buf[off : off+188]
		if pkt[0] != 0x47 || pkt[1]&0x40 == 0 {
			continue
		}
		pid := uint16(pkt[1]&0x1f)<<8 | uint16(pkt[2])
		if pid != 0 {
			continue
		}
		ptr := int(pkt[4])
		if 5+ptr+8 > len(pkt) || pkt[5+ptr] != 0x00 {
			continue
		}
		sec := pkt[5+ptr:]
		seclen := int(sec[1]&0x0f)<<8 | int(sec[2])
		end := 3 + seclen - 4
		if end > len(sec) || end < 12 {
			continue
		}
		pat = append([]byte(nil), pkt...)
		for j := 8; j+4 <= end; j += 4 {
			prog := uint16(sec[j])<<8 | uint16(sec[j+1])
			pmt := uint16(sec[j+2]&0x1f)<<8 | uint16(sec[j+3])
			if prog != 0 && pmt != 0x1fff {
				pmtPIDs[pmt] = true
			}
		}
		break
	}
	if pat == nil || len(pmtPIDs) == 0 {
		return nil
	}

	seen := map[uint16]bool{}
	var pmts [][]byte
	for off := 0; off+188 <= len(buf); off += 188 {
		pkt := buf[off : off+188]
		if pkt[0] != 0x47 || pkt[1]&0x40 == 0 {
			continue
		}
		pid := uint16(pkt[1]&0x1f)<<8 | uint16(pkt[2])
		if !pmtPIDs[pid] || seen[pid] {
			continue
		}
		ptr := int(pkt[4])
		if 5+ptr >= len(pkt) || pkt[5+ptr] != 0x02 {
			continue
		}
		seen[pid] = true
		pmts = append(pmts, append([]byte(nil), pkt...))
		if len(pmts) == len(pmtPIDs) {
			break
		}
	}
	if len(pmts) == 0 {
		return nil
	}

	out := make([]byte, 0, 3*(len(pat)+188*len(pmts)))
	for i := 0; i < 3; i++ {
		out = append(out, pat...)
		for _, pmt := range pmts {
			out = append(out, pmt...)
		}
	}
	return out
}

// observeProgram looks for the served service's PMT in a recording, waiting up
// to `wait` because the PSI is not at the start of the file: the recording is
// joined at a video keyframe and the PSI can sit hundreds of KB further in.
func (h *hdhr) observeProgram(file string, base int64, wait time.Duration) int {
	deadline := time.Now().Add(wait)
	for {
		if fh, err := os.Open(filepath.Join(pvrDir, file)); err == nil {
			p := servedProgram(fh, base, 2<<20)
			fh.Close()
			if p != 0 {
				return p
			}
		}
		if time.Now().After(deadline) {
			return 0
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// absDiff is the absolute difference between two byte counts.
func absDiff(a, b int64) int64 {
	if a > b {
		return a - b
	}
	return b - a
}

// recordSizeKB asks the vendor index how big a recording id has become. That is
// the authoritative answer to "which file is this tuner writing": the index is
// keyed by the id Ag_record_create() returned, and its size tracks the file.
func (h *hdhr) recordSizeKB(id string) (int64, bool) {
	if id == "" || id == "0" {
		return 0, false
	}
	c := h.cmds.add("recbyid", id)
	rep, ok := h.cmds.wait(c.ID, 5*time.Second)
	if !ok || !rep.OK {
		return 0, false
	}
	info := strings.ReplaceAll(detailValue(rep.Detail, "info"), "_", " ")
	parts := strings.Split(info, "@")
	if len(parts) < 7 {
		return 0, false
	}
	kb, err := strconv.ParseInt(strings.TrimSpace(parts[6]), 10, 64)
	if err != nil {
		return 0, false
	}
	return kb, true
}

// listRecordings returns the record*.mpg sizes currently in the PVR directory.
// Sizes, not just names: the box recycles names, so a name alone cannot say
// whether a file is the recording we just started or the previous channel's
// leftovers.
func listRecordings(dir string) map[string]int64 {
	sizes := map[string]int64{}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return sizes
	}
	for _, e := range ents {
		n := e.Name()
		if !strings.HasSuffix(n, ".mpg") || !validRecName.MatchString(n) {
			continue
		}
		if info, err := e.Info(); err == nil {
			sizes[n] = info.Size()
		}
	}
	return sizes
}

// waitGrowingRecording returns the recording this start actually created, and
// the offset where its data begins.
//
// Names cannot identify it: the box recycles recordNNN, so a name present before
// the start may be the previous channel's file - reading it showed a few seconds
// of the channel the viewer had just left. Instead, watch which file *grows*
// after the start command:
//
//   - a name that was not there before, or that shrank, is ours from 0
//   - a name that grew by a worthwhile margin is ours from its previous size
//     (the recorder appends)
//   - a file that holds another live stream is never considered
//
// Without this the daemon can adopt a stale file and then wait forever for data
// the box is writing somewhere else, which is a stalled player.
func waitGrowingRecording(dir string, existing map[string]int64, since time.Time, inUse map[string]bool) (string, int64, bool) {
	const grown = 64 * 1024 // ~0.1 s of video: real data, not a header write
	deadline := time.Now().Add(recordingFileWait)
	for time.Now().Before(deadline) {
		ents, err := os.ReadDir(dir)
		if err == nil {
			for _, e := range ents {
				n := e.Name()
				if !strings.HasSuffix(n, ".mpg") || !validRecName.MatchString(n) || inUse[n] {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				size := info.Size()
				prev, had := existing[n]
				switch {
				case !had:
					if size > 0 { // a name that did not exist before the start
						return n, 0, true
					}
				case size+int64(tsPacketSize) < prev: // truncated: ours from 0
					return n, 0, true
				case size-prev >= grown: // appended: ours from the old end
					return n, prev, true
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = since
	return "", 0, false
}

// inUse reports which recording files belong to live streams, so a start cannot
// mistake someone else's recording for the one it just asked for.
func (h *hdhr) inUse() map[string]bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := make(map[string]bool, len(h.streams)+len(h.claimed))
	for _, ls := range h.streams {
		if ls.file != "" {
			m[ls.file] = true
		}
	}
	for f := range h.claimed {
		m[f] = true
	}
	for f := range h.retiring {
		m[f] = true
	}
	return m
}

// startDetail renders a failed start for the log: either no answer at all or
// the page's own explanation, which is what distinguishes a transient box error
// from a channel that genuinely will not record.
func startDetail(rep Report, ok bool) string {
	if !ok {
		return "no answer from the page"
	}
	if rep.Detail != "" {
		return rep.Detail
	}
	return "failed without detail"
}

func (h *hdhr) release(lcn string) {
	h.mu.Lock()
	ls, ok := h.streams[lcn]
	if !ok {
		h.mu.Unlock()
		return
	}
	ls.refs--
	if ls.refs > 0 {
		h.mu.Unlock()
		return
	}
	// Keep the recorder running for a while: a scanner that comes back, or a
	// viewer switching between two channels, then gets a first byte instantly
	// instead of waiting ~5s for the box to start a recorder again.
	warm := h.cfg().WarmSeconds
	if warm > 0 {
		ls.idle = true
		ls.expire = time.Now().Add(time.Duration(warm) * time.Second)
		extra := h.warmOverCapLocked()
		h.mu.Unlock()
		h.log.Printf("stream lcn=%s: idle, keeping the recorder warm until %s", lcn, ls.expire.Format("15:04:05"))
		// Only keep one warm stream: more than that would starve real viewers.
		for _, l := range extra {
			h.releaseStream(l)
		}
		return
	}
	delete(h.streams, lcn)
	file, handle, id := ls.file, ls.handle, ls.id
	h.mu.Unlock()

	h.stopRecording(lcn, file, handle, id)
}

// oldestWarmLocked returns the LCN of the warm stream that has been idle
// longest, or "" if none is warm. Caller holds h.mu.
func (h *hdhr) oldestWarmLocked() string {
	oldest, oldestAt := "", time.Time{}
	for lcn, ls := range h.streams {
		if !ls.idle {
			continue
		}
		if oldest == "" || ls.lastWrite.Before(oldestAt) {
			oldest, oldestAt = lcn, ls.lastWrite
		}
	}
	return oldest
}

// warmOverCapLocked returns warm streams beyond the cap, newest first, so the
// caller can release all but one. Caller holds h.mu.
func (h *hdhr) warmOverCapLocked() []string {
	var warm []string
	for lcn, ls := range h.streams {
		if ls.idle {
			warm = append(warm, lcn)
		}
	}
	if len(warm) <= warmCap {
		return nil
	}
	// Sort by expiry so the streams closest to expiring go first.
	sort.Slice(warm, func(i, j int) bool {
		return h.streams[warm[i]].expire.Before(h.streams[warm[j]].expire)
	})
	return warm[:len(warm)-warmCap]
}

// stopAll stops every recording this daemon knows about. Called at shutdown:
// a warm recording has no streaming handler to notice the process leaving, so
// without this it would be orphaned and keep writing until the box reboots.
func (h *hdhr) stopAll() {
	h.mu.Lock()
	lcns := make([]string, 0, len(h.streams))
	for lcn := range h.streams {
		lcns = append(lcns, lcn)
	}
	h.mu.Unlock()
	if len(lcns) == 0 {
		return
	}
	h.log.Printf("shutdown: stopping %d recording(s)", len(lcns))
	for _, lcn := range lcns {
		h.releaseStream(lcn)
	}
	// The page processes one command at a time; give it a moment to act before
	// the process disappears.
	time.Sleep(2 * time.Second)
}

// stopRecording asks the page to stop the recorder and then forgets the file.
// The page owns the recorder, so the daemon only asks.
func (h *hdhr) stopRecording(lcn, file, handle, id string) {
	// One stop per recording. A second one used to come from the reconcile
	// sweep while the first was still verifying, by which time the box had
	// given the handle to the next channel.
	key := stopKey(file, id)
	if !h.beginStopping(key) {
		h.log.Printf("stream lcn=%s: stop for record %s (%s) already in progress; not sending another", lcn, id, file)
		return
	}
	// Excluded from new starts only until the box has acted on the stop: after
	// that it may legitimately reuse the name for the very next recording.
	h.setRetiring(file, true)
	go func() {
		defer h.setRetiring(file, false) // early-return paths
		h.lockRecorder(10 * time.Second)
		switch v := h.handles.verdict(handle, id, false); v {
		case stopDuplicate:
			h.unlockRecorder()
			h.log.Printf("stream lcn=%s: record %s already stopped; not stopping handle %s again", lcn, id, handle)
			h.endStopping(key)
			return
		case stopReassigned:
			// The box only reassigns a slot once its recorder has gone, so this
			// recording is already stopped; stopping the handle now would stop
			// somebody else. Clean up without touching the recorder.
			h.unlockRecorder()
			h.log.Printf("stream lcn=%s: handle %s belongs to another recording now; record %s is already gone, not stopping it",
				lcn, handle, id)
			h.discardRecording(file, id)
			h.forgetRecording(file)
			h.endStopping(key)
			return
		}
		c := h.cmds.add("stream_stop", lcn+"|"+handle)
		rep, ok := h.cmds.wait(c.ID, 20*time.Second)
		if ok {
			h.handles.markStopped(id)
		}
		h.setRetiring(file, false)
		h.unlockRecorder()
		if !ok {
			// Never delete the file here: the recorder may still be writing to
			// it, and the file is the only visible evidence that it is. Let the
			// reconcile sweep try again later (still subject to the handle rule).
			h.log.Printf("stream lcn=%s: stop not acknowledged; leaving %s in place", lcn, file)
			h.endStopping(key)
			return
		}
		h.log.Printf("stream lcn=%s: stopped (%v %s)", lcn, rep.OK, rep.Detail)

		// Trust the filesystem over the report: a stop can be acknowledged while
		// the recorder keeps writing, and a leaked recorder eats a tuner slot
		// until every later start fails with h=-1.
		if file != "" && stillGrowing(file, 6*time.Second) {
			h.lockRecorder(10 * time.Second)
			if v := h.handles.verdict(handle, id, true); v != stopAllowed {
				h.unlockRecorder()
				h.log.Printf("pvr: %s kept growing but handle %s has moved on (%s); not stopping again", file, handle, v)
			} else {
				h.log.Printf("pvr: %s kept growing after stop; asking again", file)
				c2 := h.cmds.add("stream_stop", lcn+"|"+handle)
				r2, ok2 := h.cmds.wait(c2.ID, 10*time.Second)
				h.unlockRecorder()
				if ok2 {
					h.log.Printf("stream lcn=%s: stop retry (%v %s)", lcn, r2.OK, r2.Detail)
				}
			}
			if stillGrowing(file, 5*time.Second) {
				// Left marked as stopping: it has been reported loudly, and a
				// sweep re-sending stops every 15 s would only add noise.
				h.log.Printf("pvr: %s is STILL recording after two stops (handle=%s) - leaving it for inspection", file, handle)
				return
			}
		}
		h.discardRecording(file, id)
		h.forgetRecording(file)
		h.endStopping(key)
	}()
}

// discardRecording removes one of our recordings through the vendor's PVR index.
//
// It must never unlink: an unlinked file leaves a stale index entry, after which
// the box reuses the name for the next recording and truncates whatever occupies
// it. That is how an owner's recording was destroyed on 2026-11-25. When the id
// is unknown the file is left alone and logged - wasted space is recoverable,
// someone else's recording is not.
func (h *hdhr) discardRecording(file, id string) {
	if file == "" {
		return
	}
	if id == "" || id == "0" {
		h.log.Printf("pvr: no recording id for %s - leaving it in the index", file)
		return
	}
	c := h.cmds.add("pvrdeleteid", id)
	rep, ok := h.cmds.wait(c.ID, 20*time.Second)
	if !ok {
		h.log.Printf("pvr: delete of %s (id=%s) not acknowledged - file left in place", file, id)
		return
	}
	h.log.Printf("pvr: %s %v (%s)", file, rep.OK, rep.Detail)
}

// stillGrowing reports whether a recording file is still being written, by
// sampling its size. Used to verify a stop actually took effect.
func stillGrowing(name string, window time.Duration) bool {
	path := filepath.Join(pvrDir, name)
	before, err := os.Stat(path)
	if err != nil {
		return false // gone already: nothing is recording it
	}
	time.Sleep(window)
	after, err := os.Stat(path)
	if err != nil {
		return false
	}
	return after.Size() > before.Size()
}

// parseTunerSlot splits /tuner<idx>/v<lcn> into its slot index and LCN.
func parseTunerSlot(p string) (int, string, bool) {
	rest := strings.TrimPrefix(p, "/tuner")
	i := strings.Index(rest, "/v")
	if i <= 0 {
		return 0, "", false
	}
	idx, err := strconv.Atoi(rest[:i])
	if err != nil || idx < 0 {
		return 0, "", false
	}
	lcn, ok := parseTunerPath(p)
	return idx, lcn, ok
}

func parseTunerPath(p string) (string, bool) {
	// /tuner0/v7
	rest := strings.TrimPrefix(p, "/tuner")
	i := strings.Index(rest, "/v")
	if i < 0 {
		return "", false
	}
	lcn := rest[i+2:]
	if lcn == "" {
		return "", false
	}
	for _, c := range lcn {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	return lcn, true
}

// detailValue pulls "key=value" out of a report string like
// "id=1081 handle=0 lcn=7 file=record44.mpg".
func detailValue(detail, key string) string {
	for _, f := range strings.Fields(detail) {
		if strings.HasPrefix(f, key+"=") {
			return strings.TrimPrefix(f, key+"=")
		}
	}
	return ""
}
