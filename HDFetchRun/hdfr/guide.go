package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The electronic programme guide belongs to HDFR, not to anything that was
// previously run on this box: HDFR fetches the XMLTV itself, keeps it under its
// own directory, and refreshes it on a timer. Nothing outside /root/HDFR is
// required for the guide to work.
const (
	guideFileName   = "guide.xml"
	guideStatusName = "status.json"
	guideMinBytes   = 64 * 1024
	guideMaxBytes   = 64 << 20
	guideFetchWait  = 3 * time.Minute
	guideCheckEvery = 15 * time.Minute
	legacyGuidePath = "/root/xmltv/guide.xml" // only ever read once, to seed
)

// GuideStatus is what /api/guide reports and what survives a restart.
type GuideStatus struct {
	URL       string    `json:"url"`
	Size      int64     `json:"size"`
	LastOK    time.Time `json:"last_ok"`
	LastError string    `json:"last_error,omitempty"`
	Checked   time.Time `json:"checked"`
	Source    string    `json:"source,omitempty"`
}

// GuideStore owns the XMLTV cache: one file, one status record, one refresh at
// a time.
type GuideStore struct {
	dir string
	log *Logger
	cfg func() Config

	mu         sync.Mutex
	refreshing bool
	status     GuideStatus
	attempted  time.Time // monotonic: the box clock cannot be trusted for this
}

// clockIsBogus reports whether the box clock is still near 1970, which happens
// until the vendor app syncs time. Age arithmetic and TLS validation are both
// meaningless in that state, so callers take a different path.
func clockIsBogus() bool { return time.Now().Year() < 2020 }

func newGuideStore(root string, log *Logger, cfg func() Config) (*GuideStore, error) {
	dir := filepath.Join(root, "guide")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("guide dir: %w", err)
	}
	g := &GuideStore{dir: dir, log: log, cfg: cfg}
	g.loadStatus()

	// A box upgraded from the earlier PVR harness still has its cache on disk.
	// Adopt it once so the guide works before the first fetch, then never look
	// at that path again.
	if _, err := os.Stat(g.Path()); errors.Is(err, os.ErrNotExist) {
		if st, err := os.Stat(legacyGuidePath); err == nil && st.Size() >= guideMinBytes {
			if err := copyFile(legacyGuidePath, g.Path()); err == nil {
				g.mu.Lock()
				g.status.Size = st.Size()
				g.status.LastOK = st.ModTime()
				g.status.Source = "seeded from " + legacyGuidePath
				g.mu.Unlock()
				g.saveStatus()
				g.log.Printf("guide: seeded from %s (%d bytes)", legacyGuidePath, st.Size())
			}
		}
	}
	return g, nil
}

func (g *GuideStore) Path() string { return filepath.Join(g.dir, guideFileName) }

// caBundlePath is the CA store shipped with HDFR, used instead of the box's own
// (2014-era) trust store.
func (g *GuideStore) caBundlePath() string {
	return filepath.Join(filepath.Dir(g.dir), "certs", "ca-bundle.pem")
}

// loadCABundle parses a PEM bundle, or returns nil when it is missing or empty.
func loadCABundle(path string) *x509.CertPool {
	pemBytes, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil
	}
	return pool
}

func (g *GuideStore) loadStatus() {
	raw, err := os.ReadFile(filepath.Join(g.dir, guideStatusName))
	if err != nil {
		return
	}
	var st GuideStatus
	if json.Unmarshal(raw, &st) == nil {
		g.status = st
	}
}

func (g *GuideStore) saveStatus() {
	g.mu.Lock()
	st := g.status
	g.mu.Unlock()
	buf, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	if err := writeFileSync(filepath.Join(g.dir, guideStatusName), append(buf, '\n'), 0o644); err != nil {
		g.log.Printf("guide: cannot write status: %v", err)
	}
}

// Status reports the cache state, including whether a refresh is running.
func (g *GuideStore) Status() map[string]any {
	g.mu.Lock()
	st, running := g.status, g.refreshing
	g.mu.Unlock()

	size := int64(0)
	if info, err := os.Stat(g.Path()); err == nil {
		size = info.Size()
	}
	out := map[string]any{
		"url":        g.cfg().guideFeed(),
		"city":       g.cfg().GuideCity,
		"path":       g.Path(),
		"size":       size,
		"last_ok":    st.LastOK,
		"last_error": st.LastError,
		"checked":    st.Checked,
		"source":     st.Source,
		"refreshing": running,
	}
	if !st.LastOK.IsZero() {
		if clockIsBogus() {
			// Timestamps from this box are meaningless until it syncs time, so
			// report the state instead of a fabricated age.
			out["clock_unset"] = true
			if !g.attempted.IsZero() {
				out["minutes_since_check"] = int(time.Since(g.attempted).Minutes())
			}
		} else {
			out["age_hours"] = int(time.Since(st.LastOK).Hours())
		}
	}
	return out
}

// RefreshAsync starts a fetch in the background. It returns false when one is
// already running, so hammering the menu cannot stack up downloads.
func (g *GuideStore) RefreshAsync() bool {
	g.mu.Lock()
	if g.refreshing {
		g.mu.Unlock()
		return false
	}
	g.refreshing = true
	g.mu.Unlock()

	go func() {
		err := g.refresh()
		g.mu.Lock()
		g.refreshing = false
		g.status.Checked = time.Now()
		g.attempted = time.Now()
		if err != nil {
			g.status.LastError = err.Error()
		} else {
			g.status.LastError = ""
		}
		g.mu.Unlock()
		g.saveStatus()
		if err != nil {
			g.log.Printf("guide: refresh failed: %v", err)
			return
		}
	}()
	return true
}

func (g *GuideStore) refresh() error {
	url := g.cfg().guideFeed()
	if url == "" {
		return errors.New("no guide feed configured (guide_city or guide_url)")
	}
	body, err := g.fetch(url)
	if err != nil {
		return err
	}
	if err := validateGuide(body); err != nil {
		return err
	}
	tmp := g.Path() + ".tmp"
	if err := writeFileSync(tmp, body, 0o644); err != nil {
		return fmt.Errorf("write cache: %w", err)
	}
	if err := os.Rename(tmp, g.Path()); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("install cache: %w", err)
	}
	g.mu.Lock()
	g.status.URL = url
	g.status.Size = int64(len(body))
	g.status.LastOK = time.Now()
	g.status.Source = "downloaded"
	g.mu.Unlock()
	g.log.Printf("guide: refreshed from %s (%d bytes)", url, len(body))
	return nil
}

func (g *GuideStore) fetch(url string) ([]byte, error) {
	tr := &http.Transport{}
	tlsCfg := &tls.Config{}
	// This box's system CA store predates the roots the feed's certificates
	// chain to, so a correct clock alone is not enough: verify against the
	// bundle shipped with HDFR. Only if a bundle is unset do we fall back to
	// skipping verification on an unset clock, which is the lesser evil when the
	// alternative is no guide at all.
	if pool := loadCABundle(g.caBundlePath()); pool != nil {
		tlsCfg.RootCAs = pool
	} else if clockIsBogus() {
		tlsCfg.InsecureSkipVerify = true
		g.log.Printf("guide: no CA bundle and box clock is unset, fetching without TLS verification")
	}
	tr.TLSClientConfig = tlsCfg
	client := &http.Client{Timeout: guideFetchWait, Transport: tr}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "HDFetchRun/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, guideMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > guideMaxBytes {
		return nil, fmt.Errorf("guide larger than %d bytes", guideMaxBytes)
	}
	return body, nil
}

// validateGuide rejects error pages and truncated downloads before they can
// replace a working cache.
func validateGuide(body []byte) error {
	if len(body) < guideMinBytes {
		return fmt.Errorf("guide too small (%d bytes)", len(body))
	}
	head := strings.TrimLeft(string(body[:512]), "\ufeff \t\r\n")
	if !strings.HasPrefix(head, "<?xml") && !strings.HasPrefix(head, "<tv") {
		return errors.New("response is not XML")
	}
	if !strings.Contains(head, "<tv") && !strings.Contains(string(body[:4096]), "<tv") {
		return errors.New("response has no <tv> element")
	}
	return nil
}

// Loop refreshes when the cache is older than guide_refresh_hours. While the box
// clock is unset the age of the file cannot be computed, so the timer starts at
// daemon start instead.
func (g *GuideStore) Loop() {
	for {
		hours := g.cfg().GuideRefreshHours
		g.mu.Lock()
		last, size, attempted := g.status.LastOK, g.status.Size, g.attempted
		g.mu.Unlock()

		var due bool
		switch {
		case size == 0:
			due = true // nothing cached at all
		case hours <= 0:
			due = false // refresh disabled
		case clockIsBogus():
			due = attempted.IsZero() || time.Since(attempted) >= time.Duration(hours)*time.Hour
		default:
			due = time.Since(last) >= time.Duration(hours)*time.Hour
		}
		if due {
			g.RefreshAsync()
		}
		time.Sleep(guideCheckEvery)
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
