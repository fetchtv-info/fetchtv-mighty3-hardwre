package main

// Phase 6: a read-only subset of the TVHeadend HTTP API, so TVH-native clients
// can be pointed straight at HDFR instead of at a TVH instance.
//
// Deliberately absent, by decision:
//   - no authentication (no Digest challenge, no login)
//   - no /comet/events push channel
//
// Everything here is a projection of state HDFR already owns: the channel list,
// the XMLTV guide cache and the live stream table. Nothing in this file starts a
// recorder except /stream/channel/<uuid>, which hands off to the same code path
// as /auto/v<lcn>.

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tvhAPIVersion is what a TVH 4.3 server reports. Clients gate features on it
// and several refuse to talk to a server that reports less, so the number is
// part of the contract rather than a claim about our internals.
const tvhAPIVersion = 20

// tvhUUID derives the 32-hex identifier TVH uses for a channel. It must be
// stable across restarts and unique per LCN, because clients cache channel and
// EPG state against it.
func tvhUUID(lcn int) string {
	sum := md5.Sum([]byte(fmt.Sprintf("hdfr:%d", lcn)))
	return hex.EncodeToString(sum[:])
}

// lcnFromUUID reverses tvhUUID by lookup: the digest is not invertible, so the
// channel list is the table.
func (h *hdhr) lcnFromUUID(uuid string) (string, bool) {
	for _, c := range h.channelList() {
		if tvhUUID(c.LCN) == uuid {
			return strconv.Itoa(c.LCN), true
		}
	}
	return "", false
}

// eventID derives the integer TVH clients expect from a channel and a start
// time. Stable for the same programme across refreshes.
func eventID(channelUUID string, start int64) int64 {
	sum := md5.Sum([]byte(fmt.Sprintf("%s@%d", channelUUID, start)))
	n := int64(0)
	for i := 0; i < 8; i++ {
		n = n<<8 | int64(sum[i])
	}
	if n < 0 {
		n = -n
	}
	return n % 2147483647 // stay inside a 32-bit signed int: clients store it as one
}

func (h *hdhr) registerTVH(mux *http.ServeMux) {
	mux.HandleFunc("/api/serverinfo", h.tvhServerInfo)
	mux.HandleFunc("/api/channel/grid", h.tvhChannelGrid)
	mux.HandleFunc("/api/epg/events/grid", h.tvhEPGGrid)
	mux.HandleFunc("/api/dvr/entry/grid", h.tvhDVRGrid)
	mux.HandleFunc("/api/status/subscriptions", h.tvhSubscriptions)
	mux.HandleFunc("/stream/channel/", h.tvhStream)
}

// tvhServerInfo mirrors the fields a client reads before anything else.
func (h *hdhr) tvhServerInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"sw_version":      "hdfr-" + version,
		"api_version":     tvhAPIVersion,
		"name":            "HDFR",
		"capabilities":    []string{"tvadapters"},
		"build_timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

// tvhChannelGrid is /api/channel/grid: one entry per streamable channel.
func (h *hdhr) tvhChannelGrid(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		UUID       string   `json:"uuid"`
		Enabled    bool     `json:"enabled"`
		Autoname   bool     `json:"autoname"`
		Name       string   `json:"name"`
		Number     int      `json:"number"`
		EPGauto    bool     `json:"epgauto"`
		EPGlimit   int      `json:"epglimit"`
		EPGgrab    []string `json:"epggrab"`
		DVRPreTime int      `json:"dvr_pre_time"`
		DVRPstTime int      `json:"dvr_pst_time"`
		EPGrunning int      `json:"epg_running"`
		Services   []string `json:"services"`
		Tags       []string `json:"tags"`
		Bouquet    string   `json:"bouquet"`
	}

	channels := h.streamableChannels() // audio-only services are never advertised
	entries := make([]entry, 0, len(channels))
	for _, c := range channels {
		uuid := tvhUUID(c.LCN)
		entries = append(entries, entry{
			UUID:       uuid,
			Enabled:    true,
			Autoname:   true,
			Name:       c.Name,
			Number:     c.LCN,
			EPGauto:    true,
			EPGgrab:    []string{},
			EPGrunning: -1,
			Services:   []string{uuid}, // one service per channel, same id
			Tags:       []string{},
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Number < entries[j].Number })

	start, limit := gridWindow(r, len(entries))
	writeJSON(w, map[string]any{
		"entries": entries[start:limit],
		"total":   len(entries),
	})
}

// tvhDVRGrid is deliberately empty: HDFR does not record. Reporting an empty
// grid is honest and stops clients from offering a DVR that cannot work.
func (h *hdhr) tvhDVRGrid(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"entries": []any{}, "total": 0})
}

// tvhSubscriptions reports the live streams, which is what TVH's Status page
// shows and what clients use to tell whether the tuner pool is busy.
func (h *hdhr) tvhSubscriptions(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	type item struct {
		ID       int    `json:"id"`
		State    string `json:"state"`
		Service  string `json:"service"`
		Host     string `json:"host"`
		Username string `json:"username"`
		Client   string `json:"client"`
	}
	lines := make([]item, 0, len(h.streams))
	i := 1
	lcns := make([]string, 0, len(h.streams))
	for lcn := range h.streams {
		lcns = append(lcns, lcn)
	}
	sort.Strings(lcns)
	for _, lcn := range lcns {
		lines = append(lines, item{
			ID:       i,
			State:    "Running",
			Service:  lcn + " " + h.channelName(lcn),
			Host:     r.Host,
			Username: "hdfr",
			Client:   "HDFR",
		})
		i++
	}
	h.mu.Unlock()
	writeJSON(w, map[string]any{"entries": lines, "totalCount": len(lines)})
}

// tvhStream maps a channel uuid onto the existing tuner path.
func (h *hdhr) tvhStream(w http.ResponseWriter, r *http.Request) {
	uuid := strings.TrimPrefix(r.URL.Path, "/stream/channel/")
	if uuid == "" {
		http.NotFound(w, r)
		return
	}
	lcn, ok := h.lcnFromUUID(uuid)
	if !ok {
		http.NotFound(w, r)
		return
	}
	h.mu.Lock()
	h.lastLCN = lcn
	h.mu.Unlock()
	h.serveLCN(w, r, lcn)
}

// gridWindow applies the start/limit paging every TVH grid endpoint accepts.
func gridWindow(r *http.Request, total int) (int, int) {
	start := 0
	if v := r.URL.Query().Get("start"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= total {
			start = n
		}
	}
	limit := total
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			if start+n < limit {
				limit = start + n
			}
		}
	}
	return start, limit
}

/* ---------------------------------------------------------------- EPG ---- */

// tvhProgramme is one XMLTV <programme> reduced to what a TVH grid needs.
type tvhProgramme struct {
	ChannelID string
	Start     int64
	Stop      int64
	Title     string
	Desc      string
	Image     string
}

// epgCache holds the parsed guide. The XMLTV file is ~9 MB, so it is parsed
// once per change rather than per request.
type epgCache struct {
	mu    sync.Mutex
	path  string
	size  int64
	mtime time.Time
	progs []tvhProgramme
}

var guideEPG epgCache

// programmes returns the guide contents, re-parsing when the file changes.
func (h *hdhr) programmes() []tvhProgramme {
	path := h.guide.Path()
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}

	guideEPG.mu.Lock()
	defer guideEPG.mu.Unlock()
	if guideEPG.path == path && guideEPG.size == st.Size() && guideEPG.mtime.Equal(st.ModTime()) {
		return guideEPG.progs
	}

	progs, err := parseXMLTV(path)
	if err != nil {
		h.log.Printf("tvh: guide parse failed: %v", err)
		return guideEPG.progs // keep the previous copy
	}
	guideEPG.path, guideEPG.size, guideEPG.mtime = path, st.Size(), st.ModTime()
	guideEPG.progs = progs
	h.log.Printf("tvh: parsed %d programmes from the guide", len(progs))
	return progs
}

// parseXMLTV streams the guide once, collecting programmes. Streaming matters:
// the file is far larger than the box's spare memory.
func parseXMLTV(path string) ([]tvhProgramme, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec := xml.NewDecoder(f)
	dec.Strict = false

	var progs []tvhProgramme
	var (
		cur  *tvhProgramme
		inEl string
	)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return progs, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "programme":
				p := tvhProgramme{}
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "start":
						p.Start = parseXMLTVTime(a.Value)
					case "stop":
						p.Stop = parseXMLTVTime(a.Value)
					case "channel":
						p.ChannelID = a.Value
					}
				}
				cur = &p
			case "title":
				inEl = "title"
			case "desc":
				inEl = "desc"
			case "icon":
				if cur != nil && cur.Image == "" {
					for _, a := range t.Attr {
						if a.Name.Local == "src" {
							cur.Image = a.Value
						}
					}
				}
			}
		case xml.CharData:
			if cur != nil {
				switch inEl {
				case "title":
					cur.Title += string(t)
				case "desc":
					cur.Desc += string(t)
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "programme":
				if cur != nil && cur.ChannelID != "" && cur.Start > 0 {
					progs = append(progs, *cur)
				}
				cur = nil
			case "title", "desc":
				inEl = ""
			}
		}
	}
	return progs, nil
}

// parseXMLTVTime reads the XMLTV timestamp form "20060102150405 +1000".
func parseXMLTVTime(v string) int64 {
	v = strings.TrimSpace(v)
	// The offset is optional and may carry no space.
	fields := strings.Fields(v)
	stamp := v
	zone := ""
	if len(fields) >= 2 {
		stamp, zone = fields[0], fields[1]
	} else if len(stamp) > 14 {
		stamp, zone = stamp[:14], stamp[14:]
	}
	t, err := time.Parse("20060102150405", stamp)
	if err != nil {
		return 0
	}
	if zone != "" {
		if off, ok := parseZone(zone); ok {
			t = t.Add(-off) // store UTC
		}
	}
	return t.Unix()
}

// parseZone converts "+1030" into a duration east of UTC.
func parseZone(z string) (time.Duration, bool) {
	if len(z) < 5 {
		return 0, false
	}
	sign := 1
	switch z[0] {
	case '+':
	case '-':
		sign = -1
	default:
		return 0, false
	}
	h, err1 := strconv.Atoi(z[1:3])
	m, err2 := strconv.Atoi(z[3:5])
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return time.Duration(sign) * (time.Duration(h)*time.Hour + time.Duration(m)*time.Minute), true
}

// tvhEPGGrid is /api/epg/events/grid, optionally filtered by channel uuid and
// by a start/end epoch window.
func (h *hdhr) tvhEPGGrid(w http.ResponseWriter, r *http.Request) {
	progs := h.programmes()
	ids := guideIDs.channelIDs(h.guide.Path())

	// xmltv id -> LCN, from the cache the playlist uses.
	byID := make(map[string]int, len(ids))
	for lcn, id := range ids {
		byID[id] = lcn
	}

	// Only the channels this box can actually stream, and only with names.
	named := map[int]string{}
	for _, c := range h.streamableChannels() {
		named[c.LCN] = c.Name
	}

	// Filtering inputs.
	q := r.URL.Query()
	wantUUID := q.Get("channel")
	from, to := int64(0), int64(1<<62)
	if v := q.Get("start"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			from = n
		}
	}
	if v := q.Get("end"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			to = n
		}
	}

	type event struct {
		EventID       int64  `json:"eventId"`
		ChannelName   string `json:"channelName"`
		ChannelUUID   string `json:"channelUuid"`
		ChannelNumber string `json:"channelNumber"`
		Start         int64  `json:"start"`
		Stop          int64  `json:"stop"`
		Title         string `json:"title"`
		Description   string `json:"description,omitempty"`
		Image         string `json:"image,omitempty"`
		NextEventID   int64  `json:"nextEventId,omitempty"`
	}

	var events []event

	for _, p := range progs {
		lcn, ok := byID[p.ChannelID]
		if !ok {
			continue
		}
		name, ok := named[lcn]
		if !ok {
			continue
		}
		uuid := tvhUUID(lcn)
		if wantUUID != "" && wantUUID != uuid {
			continue
		}
		if p.Stop < from || p.Start > to {
			continue
		}
		ev := event{
			EventID:       eventID(uuid, p.Start),
			ChannelName:   name,
			ChannelUUID:   uuid,
			ChannelNumber: strconv.Itoa(lcn),
			Start:         p.Start,
			Stop:          p.Stop,
			Title:         strings.TrimSpace(p.Title),
			Description:   strings.TrimSpace(p.Desc),
			// No Image: programme artwork from the feed is unreachable (see
			// stripProgrammeIcons), and a client would stall fetching it.
		}
		events = append(events, ev)
	}

	sort.Slice(events, func(i, j int) bool {
		if events[i].Start == events[j].Start {
			return events[i].ChannelNumber < events[j].ChannelNumber
		}
		return events[i].Start < events[j].Start
	})

	// Link each programme to the next one on the same channel. One pass: events
	// are already ordered by start, so the previous event on that channel is the
	// only one that needs updating.
	lastOnChannel := make(map[string]int, len(named))
	for i := range events {
		if prev, ok := lastOnChannel[events[i].ChannelUUID]; ok {
			events[prev].NextEventID = events[i].EventID
		}
		lastOnChannel[events[i].ChannelUUID] = i
	}

	start, limit := gridWindow(r, len(events))
	writeJSON(w, map[string]any{
		"entries":    events[start:limit],
		"totalCount": len(events),
	})
}
