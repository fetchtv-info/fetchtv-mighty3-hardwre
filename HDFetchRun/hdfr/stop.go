package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// stopDaemon terminates a running hdfrd and returns how many processes it asked
// to stop.
//
// It prefers the pidfile, but also scans /proc for the binary, because the case
// that needs this most is the one where the pidfile is gone: after a deploy the
// running process's executable is the replaced file ("/root/HDFR/hdfrd
// (deleted)"), and a failed bind can remove the pidfile that named it.
func stopDaemon(root string) int {
	pids := map[int]bool{}
	if raw, err := os.ReadFile(filepath.Join(root, "logs", "hdfrd.pid")); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && n > 0 {
			pids[n] = true
		}
	}
	if matches, err := filepath.Glob("/proc/[0-9]*/exe"); err == nil {
		for _, link := range matches {
			target, err := os.Readlink(link)
			if err != nil || !strings.Contains(target, "hdfrd") {
				continue
			}
			pidStr := strings.TrimSuffix(strings.TrimPrefix(link, "/proc/"), "/exe")
			n, err := strconv.Atoi(pidStr)
			if err != nil || n == os.Getpid() {
				continue
			}
			pids[n] = true
		}
	}

	stopped := 0
	for pid := range pids {
		if err := syscall.Kill(pid, syscall.SIGTERM); err == nil {
			stopped++
		}
	}
	// Give them a moment to shut down cleanly, so a restart does not race the
	// port (which is what leaves a deleted binary holding :8080).
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		alive := false
		for pid := range pids {
			if err := syscall.Kill(pid, 0); err == nil {
				alive = true
				break
			}
		}
		if !alive {
			return stopped
		}
		time.Sleep(200 * time.Millisecond)
	}
	for pid := range pids {
		fmt.Fprintf(os.Stderr, "hdfrd: pid %d still alive after SIGTERM\n", pid)
	}
	return stopped
}
