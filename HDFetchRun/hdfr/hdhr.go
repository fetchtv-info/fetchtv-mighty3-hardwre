package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	tunerCount    = 3                      // honest: 4 tuners, 1 left for live TV on the box
	streamTimeout = 30 * time.Second       // how long to wait for the page to start a recording
	tailPollSleep = 100 * time.Millisecond // how often to retry a read at EOF
	firstByteWait = 8 * time.Second        // wait for the recorder to write something
	writeTimeout  = 20 * time.Second       // per-chunk write budget: a wedged client must not hold a tuner
	stallTimeout  = 60 * time.Second       // the recorder should never stop writing for this long
)

type Channel struct {
	LCN  int    `json:"lcn"`
	Name string `json:"name"`
}

type hdhr struct {
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
	active   map[string]string      // recording file -> LCN, persisted in state/
	lastLCN  string                 // most recently opened tuner, served at "/"
	viewing  Channel                // what the box itself is tuned to (reported by the page)
}

type liveStream struct {
	lcn    string
	file   string
	refs   int
	cancel context.CancelFunc // lets an operator release a stuck stream
}

func registerHdhr(mux *http.ServeMux, cmds *cmdQueue, log *Logger, cfgPath, root string, port int, guide *GuideStore) *hdhr {
	h := &hdhr{cmds: cmds, log: log, cfgPath: cfgPath, root: root, port: port, guide: guide,
		streams: map[string]*liveStream{}}
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
		list := h.channelList()
		out := make([]map[string]any, 0, len(list))
		for _, c := range list {
			out = append(out, map[string]any{
				"GuideNumber": strconv.Itoa(c.LCN + offset),
				"GuideName":   c.Name,
				"URL":         fmt.Sprintf("%s/tuner0/v%d", base, c.LCN),
				"HD":          1,
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
		body := buildM3U(
			h.channelList(),
			guideIDs.channelIDs(h.guide.Path()),
			h.baseURL(r),
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
		w.Write(shiftGuideLCNs(body, offset))
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
	out := make([]string, 0, len(h.streams))
	for lcn := range h.streams {
		out = append(out, lcn)
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
	h.stopRecording(lcn, ls.file)
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

func (h *hdhr) noteRecording(file, lcn string) {
	h.mu.Lock()
	if h.active == nil {
		h.active = map[string]string{}
	}
	h.active[file] = lcn
	h.mu.Unlock()
	h.saveRegistry()
}

func (h *hdhr) forgetRecording(file string) {
	h.mu.Lock()
	delete(h.active, file)
	h.mu.Unlock()
	h.saveRegistry()
}

// dropStreamFiles deletes one recording and its sidecars.
func dropStreamFiles(name string) {
	base := strings.TrimSuffix(name, ".mpg")
	for _, ext := range []string{".mpg", ".mda", ".nav"} {
		os.Remove(filepath.Join(pvrDir, base+ext))
	}
}

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
	for file := range recorded {
		if !validRecName.MatchString(file) || inUse[file] {
			continue
		}
		dropStreamFiles(file)
		h.forgetRecording(file)
		removed++
	}

	// 2. Legacy leftovers from before the registry existed: the clock was 1970
	// then, so those files still carry a pre-2001 mtime.
	entries, err := os.ReadDir(pvrDir)
	if err != nil {
		if removed > 0 {
			h.log.Printf("pvr: swept %d orphaned stream recording(s)", removed)
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
		dropStreamFiles(name)
		removed++
	}
	if removed > 0 {
		h.log.Printf("pvr: swept %d orphaned stream recording(s)", removed)
	}
}

// serveRoot streams whichever tuner was opened last, which is what a real
// HDHomeRun does after a lock.
func (h *hdhr) serveRoot(w http.ResponseWriter, r *http.Request) {
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

func (h *hdhr) channelList() []Channel {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Channel, len(h.channels))
	copy(out, h.channels)
	return out
}

// serveTuner handles GET /tuner<index>/v<lcn>: start a recording of that channel
// on the box, then tail the recorder's file out as chunked MPEG-TS until the
// client goes away.
func (h *hdhr) serveTuner(w http.ResponseWriter, r *http.Request) {
	lcn, ok := parseTunerPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	// A lock also makes this channel the one served at "/".
	h.mu.Lock()
	h.lastLCN = lcn
	h.mu.Unlock()
	h.serveLCN(w, r, lcn)
}

func (h *hdhr) serveLCN(w http.ResponseWriter, r *http.Request, lcn string) {
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
	h.mu.Unlock()

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
			if size > 0 || time.Now().After(deadline) {
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
	start := keyframeStart(f)
	if start > 0 {
		if _, err := f.Seek(start, io.SeekStart); err != nil {
			h.log.Printf("stream lcn=%s: seek %d failed: %v", lcn, start, err)
		} else {
			h.log.Printf("stream lcn=%s: starting at keyframe offset %d", lcn, start)
		}
	}
	h.log.Printf("stream lcn=%s: serving %s (%d bytes so far)", lcn, ls.file, size)

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

	buf := make([]byte, 64*1024)
	lastData := time.Now()
	var sent int64
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
			continue
		}
		if rerr != nil && rerr != io.EOF {
			h.log.Printf("stream lcn=%s: read error: %v", lcn, rerr)
			break
		}
		// The recorder should always be writing; if the file stops growing the
		// tuner is no use to anyone, so give it back instead of holding it.
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

// acquire returns the stream for this LCN, starting a recording the first time.
// A second client on the same channel shares it (one tuner, one file).
func (h *hdhr) acquire(lcn string) (*liveStream, error) {
	// Reserve the slot before talking to the box: the page takes seconds to
	// start a recording, and without this reservation concurrent requests all
	// pass the limit check and oversubscribe the hardware.
	for attempt := 0; ; attempt++ {
		h.mu.Lock()
		if ls, ok := h.streams[lcn]; ok {
			ls.refs++
			h.mu.Unlock()
			return ls, nil
		}
		if h.starting[lcn] {
			h.mu.Unlock()
			// Someone else is already starting this channel; wait for them
			// rather than starting a second recording of it.
			if attempt > 60 {
				return nil, fmt.Errorf("timed out waiting for lcn %s to start", lcn)
			}
			time.Sleep(200 * time.Millisecond)
			continue
		}
		if len(h.streams)+len(h.starting) >= tunerCount {
			h.mu.Unlock()
			return nil, fmt.Errorf("all %d tuners busy", tunerCount)
		}
		if h.starting == nil {
			h.starting = map[string]bool{}
		}
		h.starting[lcn] = true
		h.mu.Unlock()
		break
	}

	releaseSlot := func() {
		h.mu.Lock()
		delete(h.starting, lcn)
		h.mu.Unlock()
	}

	c := h.cmds.add("stream_start", lcn)
	rep, ok := h.cmds.wait(c.ID, streamTimeout)
	if !ok {
		releaseSlot()
		return nil, fmt.Errorf("box did not answer the start command")
	}
	if !rep.OK {
		releaseSlot()
		// The usual cause is the box's own tuner pool being full, which is a
		// separate limit from ours.
		return nil, fmt.Errorf("box could not start recording lcn %s: %s", lcn, rep.Detail)
	}
	file := detailValue(rep.Detail, "file")
	if file == "" {
		releaseSlot()
		return nil, fmt.Errorf("no file in report: %s", rep.Detail)
	}

	h.mu.Lock()
	delete(h.starting, lcn)
	ls := &liveStream{lcn: lcn, file: file, refs: 1}
	h.streams[lcn] = ls
	h.mu.Unlock()

	h.log.Printf("stream lcn=%s: recording %s started (%s)", lcn, file, rep.Detail)
	h.noteRecording(file, lcn)
	return ls, nil
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
	delete(h.streams, lcn)
	file := ls.file
	h.mu.Unlock()

	h.stopRecording(lcn, file)
}

// stopRecording asks the page to stop the recorder and then forgets the file.
// The page owns the recorder, so the daemon only asks.
func (h *hdhr) stopRecording(lcn, file string) {
	c := h.cmds.add("stream_stop", lcn)
	go func() {
		rep, ok := h.cmds.wait(c.ID, 20*time.Second)
		if !ok {
			h.log.Printf("stream lcn=%s: stop not acknowledged", lcn)
			return
		}
		h.log.Printf("stream lcn=%s: stopped (%v %s)", lcn, rep.OK, rep.Detail)
		h.forgetRecording(file)
	}()
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
