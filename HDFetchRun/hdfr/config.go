package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Config is the whole operator-visible surface of HDFR. Anything not here is a
// constant in the code, on purpose: a small config is easier to audit.
type Config struct {
	HTTPPort     int    `json:"http_port"`
	FriendlyName string `json:"friendly_name"`
	DeviceID     string `json:"device_id"`
	LogMaxBytes  int64  `json:"log_max_bytes"`
	LogKeep      int    `json:"log_keep"`
	Debug        bool   `json:"debug"`
	// GuideOffset is added to the LCN to form the GuideNumber in /lineup.json.
	// It exists because media servers key channels by number: if another tuner
	// already uses the LCNs (an IPTV lineup numbered 1-83, say), the channels
	// collide and ours are the ones that disappear. Playback URLs are unaffected
	// - the offset only changes the number clients see.
	GuideOffset int `json:"guide_offset"`
	// GuideURL is the XMLTV feed HDFR downloads for the EPG, and
	// GuideRefreshHours is how stale it may get before a refresh. An empty URL
	// disables downloading; a seeded or manually placed guide.xml is still
	// served.
	GuideURL          string `json:"guide_url"`
	GuideRefreshHours int    `json:"guide_refresh_hours"`
	// GuideCity picks a feed from the built-in Australian city table (see
	// cities.go); it takes precedence over GuideURL when the name is known, so
	// the menu only has to write a city name. Set it empty and use guide_url
	// for a custom feed.
	GuideCity string `json:"guide_city"`
	// NTPServer is queried once at start-up to bring the clock forward. The box
	// otherwise believes it is 1970, which breaks TLS, guide freshness and
	// recording timestamps. Empty disables it.
	NTPServer string `json:"ntp_server"`
}

var hex8 = regexp.MustCompile(`^[0-9A-Fa-f]{8}$`)

func defaultConfig() Config {
	return Config{
		HTTPPort:     8080,
		FriendlyName: "FetchTV M616T",
		DeviceID:     "1064B1A0",
		LogMaxBytes:  256 * 1024,
		LogKeep:      3,
		Debug:        true,
		// Adelaide by default: the feed carries every SA broadcaster and the
		// box is region-locked to its own mux anyway. The menu can change the
		// city; guide_url stays free for a custom feed.
		GuideCity:         "Adelaide",
		GuideRefreshHours: 24,
		NTPServer:         "pool.ntp.org",
	}
}

// guideFeed returns the XMLTV URL in force. A named city wins over a raw URL so
// the menu only has to store the city.
func (c Config) guideFeed() string {
	if c.GuideCity != "" {
		if c, ok := cityByName(c.GuideCity); ok {
			return c.URL
		}
	}
	return c.GuideURL
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := cfg.validate(); err != nil {
		return cfg, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

func (c Config) validate() error {
	if c.HTTPPort < 1 || c.HTTPPort > 65535 {
		return fmt.Errorf("http_port %d out of range", c.HTTPPort)
	}
	if strings.TrimSpace(c.FriendlyName) == "" {
		return errors.New("friendly_name is empty")
	}
	if !hex8.MatchString(c.DeviceID) {
		return fmt.Errorf("device_id %q must be 8 hex characters", c.DeviceID)
	}
	if c.LogMaxBytes < 64*1024 {
		return fmt.Errorf("log_max_bytes %d is below 64KB", c.LogMaxBytes)
	}
	if c.LogKeep < 1 || c.LogKeep > 20 {
		return fmt.Errorf("log_keep %d out of range 1..20", c.LogKeep)
	}
	if c.GuideOffset < 0 || c.GuideOffset > 10000 {
		return fmt.Errorf("guide_offset %d out of range 0..10000", c.GuideOffset)
	}
	if c.GuideURL != "" && !strings.HasPrefix(c.GuideURL, "http://") && !strings.HasPrefix(c.GuideURL, "https://") {
		return fmt.Errorf("guide_url %q must start with http:// or https://", c.GuideURL)
	}
	if c.GuideRefreshHours < 0 || c.GuideRefreshHours > 168 {
		return fmt.Errorf("guide_refresh_hours %d out of range 0..168", c.GuideRefreshHours)
	}
	return nil
}

// saveConfig writes the config back atomically and re-validates first: the menu
// is the only runtime writer, and it must never be able to corrupt the file.
func saveConfig(path string, cfg Config) error {
	if err := cfg.validate(); err != nil {
		return err
	}
	buf, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	buf = append(buf, '\n')
	return writeFileSync(path, buf, 0o644)
}
