package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The vendor's config is a flat key=value file, LF only. The only key we touch
// is homepage_url; everything else is preserved byte for byte, including the
// odd "escaped trailing space" the vendor writer emits on that line.
const homeKey = "homepage_url"

// readHomepage returns the current value with the vendor's trailing-escape
// treatment removed (a value may be written as "value\ " to keep a space).
func readHomepage(text string) (string, bool) {
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, homeKey+"=") {
			continue
		}
		v := strings.TrimRight(line[len(homeKey)+1:], " \t\r")
		v = strings.TrimSuffix(v, `\`)
		return strings.TrimSpace(v), true
	}
	return "", false
}

// rewriteHomepage returns the file text with homepage_url set to want. Other
// lines are left exactly as they were, in order.
func rewriteHomepage(text, want string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	replaced := false
	for _, line := range lines {
		if strings.HasPrefix(line, homeKey+"=") && !replaced {
			out = append(out, homeKey+"="+want)
			replaced = true
			continue
		}
		out = append(out, line)
	}
	if !replaced {
		// Missing key: append a proper line before the trailing newline.
		for len(out) > 0 && out[len(out)-1] == "" {
			out = out[:len(out)-1]
		}
		out = append(out, homeKey+"="+want, "")
	}
	return strings.Join(out, "\n")
}

// setHomepage rewrites the file only when the value differs. The original is
// kept once, as <path>.hdfr-orig, so a full restore is always one copy away.
func setHomepage(path, want string) (changed bool, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	text := string(raw)
	cur, ok := readHomepage(text)
	if ok && cur == want {
		return false, nil
	}
	orig := path + ".hdfr-orig"
	if _, statErr := os.Stat(orig); os.IsNotExist(statErr) {
		if werr := writeFileSync(orig, raw, 0o644); werr != nil {
			return false, fmt.Errorf("write %s: %w", orig, werr)
		}
	}
	if err := writeFileSync(path, []byte(rewriteHomepage(text, want)), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func restoreHomepage(path string) error {
	_, err := setHomepage(path, stockURL)
	return err
}

// writeFileSync writes to a temp file in the same directory, fsyncs it, then
// renames over the target and fsyncs the directory. Power is cut with a smart
// plug on this box, so a torn config write is a real failure mode.
func writeFileSync(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
