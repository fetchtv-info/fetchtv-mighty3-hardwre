// hdfrd - HDFetchRun daemon. Phase 1: boot hook + presence, configuration,
// rotating logs, and a status endpoint. No tuner work yet (that is phase 2).
//
// Design rules this file follows deliberately:
//   - no third-party dependencies, so the binary is auditable and static;
//   - every write is atomic and confined to /root/HDFR or /root/yx_config_user.ini;
//   - if anything is wrong with the config, -configure exits non-zero and the
//     boot wrapper falls back to the stock boot path.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	// version is a var, not a const, so -ldflags -X can stamp a build id.
	defaultRoot = "/root/HDFR"
	iniPath     = "/root/yx_config_user.ini"
	stockURL    = "file:///home/fetchtv/sui/internet_test_redirect.html"
)

var version = "0.5.0-phase5"

func main() {
	var (
		doConfigure = flag.Bool("configure", false, "validate config and point homepage_url at hdfrd, then exit")
		doServe     = flag.Bool("serve", false, "run the HTTP server in the foreground")
		doRestore   = flag.Bool("restore", false, "set homepage_url back to the stock offline page, then exit")
		doStop      = flag.Bool("stop", false, "stop a running daemon (pidfile or /proc), then exit")
		root        = flag.String("root", defaultRoot, "HDFR root directory")
		ini         = flag.String("ini", iniPath, "vendor config file to edit")
		ver         = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	switch {
	case *ver:
		fmt.Println("hdfrd " + version)
	case *doRestore:
		if err := restoreHomepage(*ini); err != nil {
			fmt.Fprintln(os.Stderr, "hdfrd: restore:", err)
			os.Exit(1)
		}
		fmt.Println("hdfrd: homepage_url restored to the stock offline page")
	case *doConfigure:
		if err := configure(*root, *ini); err != nil {
			fmt.Fprintln(os.Stderr, "hdfrd: configure:", err)
			os.Exit(1)
		}
	case *doStop:
		n := stopDaemon(*root)
		fmt.Printf("hdfrd: stopped %d process(es)\n", n)
		if n == 0 {
			os.Exit(1)
		}
	case *doServe:
		if err := serveHTTP(*root); err != nil {
			fmt.Fprintln(os.Stderr, "hdfrd: serve:", err)
			os.Exit(1)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
}

// configure makes the box point its browser at our daemon. It is the only
// place the vendor config file is written.
func configure(root, ini string) error {
	cfg, err := loadConfig(filepath.Join(root, "config.json"))
	if err != nil {
		return err
	}
	log, err := newLogger(filepath.Join(root, "logs"), cfg.LogMaxBytes, cfg.LogKeep)
	if err != nil {
		return err
	}
	defer log.Close()

	ip, err := waitForIPv4(5 * time.Second)
	if err != nil {
		// Expected at boot: the wrapper runs before the box's DHCP client has
		// an address. That is exactly why the homepage URL uses loopback - the
		// browser and the daemon are on the same device, so no address is
		// needed at configure time.
		log.Printf("no IPv4 yet at configure time (%v); using loopback", err)
	} else {
		log.Printf("LAN address at configure time: %s", ip)
	}
	want := homepageFor(cfg.HTTPPort)
	changed, err := setHomepage(ini, want)
	if err != nil {
		return err
	}
	if changed {
		log.Printf("homepage_url set to %s", want)
	} else {
		log.Printf("homepage_url already %s", want)
	}
	// Also record what happened on stdout: the wrapper's log captures it.
	fmt.Printf("hdfrd: homepage_url %s (%s)\n", want, map[bool]string{true: "changed", false: "already set"}[changed])
	return nil
}

// homepageFor returns the URL the box's own browser loads. It is loopback on
// purpose: the wrapper runs before DHCP completes, so any address-based URL
// would be empty or stale at boot. Jellyfin reaches the same daemon over the
// LAN address because it listens on all interfaces.
//
// It points at /ui/ because "/" is the transport stream (see hdhr.go).
func homepageFor(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/ui/", port)
}
