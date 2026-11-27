package main

// Audio-only services. The box will not record these: the start is accepted and
// given a handle, but no file is ever written and the stop answers -1, so every
// retry fails and each attempt costs the full file wait. They therefore must not
// be advertised as streamable.
//
// The box exposes no service type (measured 2026-11-27: no getter on the bridge,
// and recordings carry no SDT), so two mechanisms are combined:
//
//   - learned, which works anywhere: a start that is accepted but writes nothing
//     while another channel on the same multiplex is recording proves the tuner
//     and multiplex are fine, so the service itself is unrecordable. Persisted in
//     state/audio-only.json (delete the file to forget, e.g. after a rescan).
//   - a configurable name list (config radio_names), matched as whole words,
//     case-insensitively, so a channel can be filtered before it is ever tried.
//     The default is the Australian radio networks; set [] to rely on learning.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// defaultRadioNames seeds config radio_names. Whole words, so "rn" matches
// "ABC RN" but not "Hornet", and "abc kids listen" does not match "ABC KIDS".
var defaultRadioNames = []string{
	"radio",
	"newsradio",
	"triple j",
	"double j",
	"unearthed",
	"abc classic",
	"abc jazz",
	"abc country",
	"abc kids listen",
	"abc stem",
	"rn",
	"sbs chill",
	"sbs popasia",
	"sbs arabic",
	"south asian",
}

var radioWordCache sync.Map // entry -> *regexp.Regexp

// isRadioName reports whether a channel name matches one of the entries as
// whole words.
func isRadioName(name string, entries []string) bool {
	n := strings.TrimSpace(name)
	if n == "" {
		return false
	}
	for _, e := range entries {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		v, ok := radioWordCache.Load(e)
		if !ok {
			re, err := regexp.Compile(`(?i)(^|[^\p{L}\p{N}])` + regexp.QuoteMeta(e) + `($|[^\p{L}\p{N}])`)
			if err != nil {
				continue
			}
			v, _ = radioWordCache.LoadOrStore(e, re)
		}
		if v.(*regexp.Regexp).MatchString(n) {
			return true
		}
	}
	return false
}

// isRadio is the name test with the built-in defaults, for callers without a
// config to hand.
func isRadio(name string) bool { return isRadioName(name, defaultRadioNames) }

// audioOnlyStore remembers channels learned to be unrecordable.
type audioOnlyStore struct {
	mu   sync.Mutex
	path string
	lcns map[string]string // lcn -> channel name when learned
}

const audioOnlyStateName = "audio-only.json"

func loadAudioOnly(root string) *audioOnlyStore {
	s := &audioOnlyStore{path: filepath.Join(root, "state", audioOnlyStateName), lcns: map[string]string{}}
	if b, err := os.ReadFile(s.path); err == nil {
		var m map[string]string
		if json.Unmarshal(b, &m) == nil && m != nil {
			s.lcns = m
		}
	}
	return s
}

func (s *audioOnlyStore) has(lcn string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.lcns[lcn]
	return ok
}

// learn marks an LCN as audio-only; it reports whether this is new.
func (s *audioOnlyStore) learn(lcn, name string) bool {
	s.mu.Lock()
	if _, ok := s.lcns[lcn]; ok {
		s.mu.Unlock()
		return false
	}
	s.lcns[lcn] = name
	b, err := json.MarshalIndent(s.lcns, "", " ")
	s.mu.Unlock()
	if err == nil {
		_ = os.MkdirAll(filepath.Dir(s.path), 0o755)
		tmp := s.path + ".tmp"
		if os.WriteFile(tmp, b, 0o644) == nil {
			_ = os.Rename(tmp, s.path)
		}
	}
	return true
}

func (s *audioOnlyStore) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.lcns))
	for l := range s.lcns {
		out = append(out, l)
	}
	sort.Strings(out)
	return out
}

// streamableChannels is the channel list without audio-only services: what the
// lineup, the playlist and the TVH grid advertise. The config is read once.
func (h *hdhr) streamableChannels() []Channel {
	names := h.cfg().RadioNames
	all := h.channelList()
	out := make([]Channel, 0, len(all))
	for _, c := range all {
		lcn := strconv.Itoa(c.LCN)
		if (h.audio != nil && h.audio.has(lcn)) || isRadioName(c.Name, names) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// unstreamable reports whether a channel must not be offered or started:
// learned audio-only, or matching the configured radio names.
func (h *hdhr) unstreamable(lcn, name string) bool {
	if h.audio != nil && h.audio.has(lcn) {
		return true
	}
	return isRadioName(name, h.cfg().RadioNames)
}
