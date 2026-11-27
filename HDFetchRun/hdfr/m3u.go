package main

// M3U playlist support: TVHeadend (and anything else that takes an "IPTV
// Automatic Network") cannot see HDFR as an HDHomeRun device, because that
// discovery happens over UDP broadcast and HDFR is HTTP only. A plain M3U of
// the same per-channel streams is the accepted way in.
//
// Two details make the playlist actually usable rather than merely valid:
//
//   - tvg-id must equal the XMLTV <channel id> or the guide never binds to the
//     service, so the ids are read back out of the guide cache.
//   - tvg-chno must match the lineup's GuideNumber (LCN + guide_offset), or the
//     programmes land on different numbers in the media server.

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// guideIDCache memoises the LCN -> XMLTV channel id map. Parsing the guide on
// every playlist request would mean walking a 9 MB document each time, and the
// guide only changes on refresh, so the file's size and modification time are
// enough to know when to re-read it.
type guideIDCache struct {
	mu   sync.Mutex
	path string
	size int64
	mod  time.Time
	ids  map[int]string
}

var guideIDs guideIDCache

// channelIDs returns the current guide's LCN -> channel id map, re-parsing only
// when the file has changed. A missing or half-downloaded guide is not an
// error: the playlist is still valid without tvg-id, it just loses the guide.
func (c *guideIDCache) channelIDs(path string) map[int]string {
	c.mu.Lock()
	defer c.mu.Unlock()

	info, err := os.Stat(path)
	if err != nil {
		// Missing or half-written guide: keep whatever we already know rather
		// than dropping tvg-id from the playlist.
		return c.ids
	}
	if c.ids != nil && c.path == path && c.size == info.Size() && c.mod.Equal(info.ModTime()) {
		return c.ids
	}

	ids, err := parseGuideChannelIDs(path)
	if err != nil {
		// Keep whatever we had rather than dropping the guide on a partial file.
		return c.ids
	}
	c.path, c.size, c.mod, c.ids = path, info.Size(), info.ModTime(), ids
	return ids
}

// parseGuideChannelIDs reads only the <channel> elements, which XMLTV places
// before any <programme>. Parsing stops at the first programme: the channel
// block is all we need and the rest of the document is an order of magnitude
// larger.
func parseGuideChannelIDs(path string) (map[int]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec := xml.NewDecoder(f)
	ids := make(map[int]string)
	var (
		inChannel bool
		id        string
		lcn       int
	)

	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}

		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "channel":
				inChannel, id, lcn = true, "", 0
				for _, a := range t.Attr {
					if a.Name.Local == "id" {
						id = strings.TrimSpace(a.Value)
					}
				}
			case "lcn":
				if inChannel {
					var s string
					if err := dec.DecodeElement(&s, &t); err == nil {
						lcn, _ = strconv.Atoi(strings.TrimSpace(s))
					}
				}
			case "programme":
				// Channels all precede programmes in XMLTV.
				return ids, nil
			}
		case xml.EndElement:
			if t.Name.Local == "channel" && inChannel {
				if id != "" && lcn > 0 {
					ids[lcn] = id
				}
				inChannel = false
			}
		}
	}
	return ids, nil
}

// buildM3U renders the playlist. Kept free of HTTP and config plumbing so it can
// be tested against a handful of channels and ids.
func buildM3U(channels []Channel, ids map[int]string, base string, offset int, group string) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	for _, c := range channels {
		name := m3uAttr(c.Name)
		b.WriteString("#EXTINF:-1")
		if id := ids[c.LCN]; id != "" {
			fmt.Fprintf(&b, " tvg-id=\"%s\"", m3uAttr(id))
		}
		fmt.Fprintf(&b, " tvg-chno=\"%d\" tvg-name=\"%s\" group-title=\"%s\",%s\n",
			c.LCN+offset, name, m3uAttr(group), name)
		fmt.Fprintf(&b, "%s/v%d\n", base, c.LCN) // base ends in /tunerN or /auto
	}
	return b.String()
}

// m3uAttr escapes a value for use inside an #EXTINF attribute or title. Line
// breaks would end the entry, and quotes would truncate the attribute.
func m3uAttr(s string) string {
	s = strings.NewReplacer("\"", "'", "\r", " ", "\n", " ").Replace(s)
	return strings.TrimSpace(s)
}
