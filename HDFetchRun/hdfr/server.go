package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Files the daemon will serve. A whitelist, not a directory walk: the box is on
// a LAN with no auth, so nothing else under the HDFR root is reachable.
var assets = map[string]string{
	"/app.js":     "application/javascript; charset=utf-8",
	"/ui.css":     "text/css; charset=utf-8",
	"/index.html": "text/html; charset=utf-8",
}

// pvrDir is where the vendor recorder writes: /mnt/usb1 is the internal SATA
// disk, and <name>.mpg / .mda / .nav are one recording.
const pvrDir = "/mnt/usb1/PVR"

// validRecName guards the delete endpoint: no paths, no traversal.
var validRecName = regexp.MustCompile(`^record[0-9]+\.mpg$`)

// The XMLTV carries the broadcast LCN in <lcn>N</lcn>; that is what a media
// server matches against the lineup's GuideNumber.
var guideLCN = regexp.MustCompile(`<lcn>([0-9]+)</lcn>`)

// shiftGuideLCNs rewrites <lcn> by offset so guide channels line up with the
// lineup numbers. Channel ids and programme references are left untouched.
func shiftGuideLCNs(xml []byte, offset int) []byte {
	if offset == 0 {
		return xml
	}
	return guideLCN.ReplaceAllFunc(xml, func(match []byte) []byte {
		sub := guideLCN.FindSubmatch(match)
		n, err := strconv.Atoi(string(sub[1]))
		if err != nil {
			return match
		}
		return []byte(fmt.Sprintf("<lcn>%d</lcn>", n+offset))
	})
}

// dirBytes sums the sizes of the files directly inside dir, for /api/state. It
// lets an operator (or the acceptance script) see retention at a glance.
func dirBytes(dir string) int64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			total += info.Size()
		}
	}
	return total
}

// serveHTTP is the daemon proper. Phase 2 serves the UI, its files, and the
// page's debug/status endpoints; the HDHomeRun endpoints arrive in phase 3.
func serveHTTP(root string) error {
	cfgPath := filepath.Join(root, "config.json")
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		return err
	}
	log, err := newLogger(filepath.Join(root, "logs"), cfg.LogMaxBytes, cfg.LogKeep)
	if err != nil {
		return err
	}
	defer log.Close()

	started := time.Now()
	pidPath := filepath.Join(root, "logs", "hdfrd.pid")
	defer os.Remove(pidPath)

	mux := http.NewServeMux()
	cmds := newCmdQueue()

	// Set the clock before anything that depends on it (TLS, guide freshness,
	// recording timestamps). This never blocks start-up: without a DHCP lease yet
	// the attempt fails and the loop retries in the background.
	if cfg.NTPServer != "" {
		go syncClockLoop(cfg.NTPServer, log)
	}
	// The closure re-reads config.json on every call: the menu can change the
	// city, the offset or the refresh interval at runtime, and a snapshot taken
	// at start-up would silently keep using the old feed.
	guideCfg := func() Config {
		c, err := loadConfig(cfgPath)
		if err != nil {
			return cfg
		}
		return c
	}
	guide, err := newGuideStore(root, log, guideCfg)
	if err != nil {
		log.Printf("warning: guide store unavailable: %v", err)
		guide = &GuideStore{dir: root, log: log, cfg: guideCfg}
	}
	go guide.Loop()

	hd := registerHdhr(mux, cmds, log, cfgPath, root, cfg.HTTPPort, guide)

	mux.HandleFunc("/ui/", func(w http.ResponseWriter, r *http.Request) {
		serveFile(root, "index.html", "text/html; charset=utf-8", w)
	})

	for path, ctype := range assets {
		p, ct := path, ctype
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			serveFile(root, strings.TrimPrefix(p, "/"), ct, w)
		})
	}

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})

	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		// Read the config per request: the menu can change "debug" at runtime,
		// and the address appears only after DHCP.
		cur, err := loadConfig(cfgPath)
		if err != nil {
			cur = cfg
		}
		ip := firstIPv4()
		if ip == "" {
			ip = "no address yet"
		}
		pending, last := cmds.snapshot()
		state := map[string]any{
			"version":       version,
			"phase":         5,
			"ip":            ip,
			"http_port":     cur.HTTPPort,
			"friendly_name": cur.FriendlyName,
			"device_id":     cur.DeviceID,
			"debug":         cur.Debug,
			"uptime_s":      int(time.Since(started).Seconds()),
			"cmds_pending":  pending,
			"last_report":   last,
			"boot_count":    bootCount(),
			"streams":       hd.activeStreams(),
			"viewing_lcn":   hd.viewingInfo(),
			"log_bytes":     dirBytes(filepath.Join(root, "logs")),
		}
		writeJSON(w, state)
	})

	// The page reports what it does here; it is what makes the box debuggable
	// without a serial console.
	mux.HandleFunc("/api/log", func(w http.ResponseWriter, r *http.Request) {
		msg := r.URL.Query().Get("msg")
		if msg == "" && r.Method == http.MethodPost {
			buf := make([]byte, 4096)
			n, _ := r.Body.Read(buf)
			msg = string(buf[:n])
		}
		if len(msg) > 2000 {
			msg = msg[:2000] + "...(truncated)"
		}
		log.Printf("page: %s", msg)
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})

	// PVR inventory. The recorder names its own files; this is how we find them
	// (the box clock is often 1970, so names and sizes are more reliable than
	// timestamps).
	mux.HandleFunc("/api/pvr", func(w http.ResponseWriter, r *http.Request) {
		entries, err := os.ReadDir(pvrDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type file struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			Mod  int64  `json:"mod"`
		}
		var files []file
		var total int64
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".mpg") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			files = append(files, file{Name: e.Name(), Size: info.Size(),
				Mod: info.ModTime().Unix()})
			total += info.Size()
		}
		writeJSON(w, map[string]any{
			"dir":   pvrDir,
			"count": len(files),
			"total": total,
			"files": files,
		})
	})

	// Control bus. The daemon cannot tune, so it queues work for the page (which
	// polls /api/next) and the page reports the result back to /api/report.
	controlGuard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			cur, err := loadConfig(cfgPath)
			if err != nil || (!isLoopback(r) && !cur.Debug) {
				http.Error(w, "control disabled", http.StatusForbidden)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/api/cmd", controlGuard(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("cmd")
		if name == "" {
			http.Error(w, "cmd= required", http.StatusBadRequest)
			return
		}
		c := cmds.add(name, r.URL.Query().Get("arg"))
		log.Printf("cmd queued: id=%d %s %s", c.ID, c.Cmd, c.Arg)
		writeJSON(w, c)
	}))
	mux.HandleFunc("/api/next", func(w http.ResponseWriter, r *http.Request) {
		c, ok := cmds.pop()
		if !ok {
			writeJSON(w, map[string]any{"id": 0})
			return
		}
		writeJSON(w, c)
	})
	mux.HandleFunc("/api/report", func(w http.ResponseWriter, r *http.Request) {
		var rep Report
		if err := json.NewDecoder(r.Body).Decode(&rep); err != nil {
			http.Error(w, "bad report", http.StatusBadRequest)
			return
		}
		cmds.report(rep)
		log.Printf("report: id=%d %s ok=%v %s", rep.ID, rep.Cmd, rep.OK, rep.Detail)
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})

	// Cleanup. The recorder names files record<N>.mpg (plus .mda/.nav metadata);
	// deleting all three is what makes streaming leaks recoverable.
	mux.HandleFunc("/api/pvr_delete", controlGuard(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if !validRecName.MatchString(name) {
			http.Error(w, "name must match record<N>.mpg", http.StatusBadRequest)
			return
		}
		base := strings.TrimSuffix(name, ".mpg")
		var removed []string
		for _, ext := range []string{".mpg", ".mda", ".nav"} {
			if err := os.Remove(filepath.Join(pvrDir, base+ext)); err == nil {
				removed = append(removed, base+ext)
			}
		}
		log.Printf("pvr delete %s -> %v", base, removed)
		writeJSON(w, map[string]any{"removed": removed})
	}))

	// Debug-harness toggle. Reachable from the box itself always (the menu uses
	// it); from the LAN only while the harness is enabled.
	mux.HandleFunc("/api/debug", func(w http.ResponseWriter, r *http.Request) {
		cur, err := loadConfig(cfgPath)
		if err != nil {
			http.Error(w, "config unreadable", http.StatusInternalServerError)
			return
		}
		if !isLoopback(r) && !cur.Debug {
			http.Error(w, "debug harness is off", http.StatusForbidden)
			return
		}
		set, err := strconv.ParseBool(r.URL.Query().Get("enabled"))
		if err != nil {
			writeJSON(w, map[string]any{"debug": cur.Debug, "error": "enabled=0|1 required"})
			return
		}
		cur.Debug = set
		if err := saveConfig(cfgPath, cur); err != nil {
			http.Error(w, "cannot save config", http.StatusInternalServerError)
			return
		}
		log.Printf("debug harness set to %v by %s", set, r.RemoteAddr)
		writeJSON(w, map[string]any{"debug": cur.Debug})
	})

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, code: 200}
		mux.ServeHTTP(sw, r)
		// The page polls /api/next twice a second; logging that would bury
		// everything else in the file.
		if r.URL.Path == "/api/next" && sw.code == 200 {
			return
		}
		log.Printf("%s %s %d %s", r.Method, r.URL.RequestURI(), sw.code, r.RemoteAddr)
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		log.Printf("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("hdfrd %s listening on :%d (debug=%v)", version, cfg.HTTPPort, cfg.Debug)
	// Bind before the pidfile is written: a failed bind (another daemon still
	// holding the port, typically an old binary after a deploy) must not delete
	// the running daemon's pidfile and leave it unmanageable.
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.HTTPPort))
	if err != nil {
		log.Printf("listen failed: %v", err)
		return err
	}
	if err := os.WriteFile(pidPath, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644); err != nil {
		log.Printf("warning: cannot write pid file: %v", err)
	}
	defer os.Remove(pidPath)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("serve failed: %v", err)
		return err
	}
	return nil
}

func serveFile(root, name, ctype string, w http.ResponseWriter) {
	body, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		http.Error(w, name+" missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(body)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(code int) {
	s.code = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController walk through this wrapper to the real
// response - without it, SetWriteDeadline reports "feature not supported".
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Hijack passes the connection through for the streaming handler, which writes
// raw TS. Embedding the interface does not promote these methods, so each has to
// be forwarded explicitly.
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("hijacking not supported by %T", s.ResponseWriter)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
