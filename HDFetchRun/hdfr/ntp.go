package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"syscall"
	"time"
)

// The box boots with a 1970 clock and only syncs once the vendor app's own NTP
// runs - which never happens under HDFR, because the vendor app is not started.
// Everything downstream cares: TLS cannot validate, guide freshness cannot be
// computed, and recordings carry 1970 timestamps. So HDFR syncs the clock
// itself, before it does anything that depends on time.
const (
	ntpPacketSize = 48
	ntpEpochDelta = 2208988800 // seconds between 1900 (NTP epoch) and 1970
	ntpMinYear    = 2020
)

// querySNTP asks an SNTP server for the current time. It deliberately speaks the
// simple subset of NTP (one request, one reply) rather than pulling in a client
// library: the daemon ships as a single dependency-free binary.
func querySNTP(server string, timeout time.Duration) (time.Time, error) {
	addr := server
	if _, _, err := net.SplitHostPort(addr); err != nil {
		addr = net.JoinHostPort(server, "123")
	}
	conn, err := net.DialTimeout("udp", addr, timeout)
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	// LI=0, VN=3 (version 3), Mode=3 (client).
	req := make([]byte, ntpPacketSize)
	req[0] = 0x1b
	if _, err := conn.Write(req); err != nil {
		return time.Time{}, err
	}
	resp := make([]byte, ntpPacketSize)
	n, err := conn.Read(resp)
	if err != nil {
		return time.Time{}, err
	}
	if n < ntpPacketSize {
		return time.Time{}, fmt.Errorf("short SNTP reply (%d bytes)", n)
	}
	mode := resp[0] & 0x07
	stratum := resp[1]
	if mode != 4 && mode != 5 {
		return time.Time{}, fmt.Errorf("unexpected SNTP mode %d", mode)
	}
	if stratum == 0 || stratum > 15 {
		return time.Time{}, fmt.Errorf("SNTP server not synchronised (stratum %d)", stratum)
	}

	// Transmit timestamp: seconds since 1900 in the first 32 bits, fraction in
	// the next 32.
	secs := binary.BigEndian.Uint32(resp[40:44])
	frac := binary.BigEndian.Uint32(resp[44:48])
	if secs == 0 {
		return time.Time{}, fmt.Errorf("SNTP reply has no timestamp")
	}
	nsec := int64(frac) * 1e9 >> 32
	return time.Unix(int64(secs)-ntpEpochDelta, nsec).UTC(), nil
}

// setSystemClock steps the clock. The daemon runs as root on the box; anywhere
// else this fails harmlessly with EPERM and is reported.
func setSystemClock(t time.Time) error {
	tv := syscall.NsecToTimeval(t.UnixNano())
	return syscall.Settimeofday(&tv)
}

// syncClockLoop keeps trying until the clock is plausible: at the time the boot
// hook starts this daemon there is often no DHCP lease yet, so the first attempt
// fails on DNS and a later one succeeds. The early attempts are close together so
// the clock is set within seconds of the lease arriving - before the box's own
// browser finishes loading the page.
func syncClockLoop(server string, log *Logger) {
	for attempt := 0; attempt < 40; attempt++ {
		syncClockAtBoot(server, log)
		if time.Now().Year() >= ntpMinYear {
			return
		}
		if attempt == 0 {
			log.Printf("ntp: no network yet, retrying every 5s until the clock is set")
		}
		time.Sleep(5 * time.Second)
	}
	log.Printf("ntp: gave up after %d attempts, clock is still unset", 40)
}

// syncClockAtBoot brings the clock forward when it is clearly wrong. It never
// moves a clock that is already plausible: if the vendor app (or the box's own
// NTP) did the job, there is nothing to fix.
func syncClockAtBoot(server string, log *Logger) {
	if server == "" {
		log.Printf("ntp: disabled in config")
		return
	}
	now := time.Now()
	needs := now.Year() < ntpMinYear
	t, err := querySNTP(server, 3*time.Second)
	if err != nil {
		log.Printf("ntp: %s: %v (clock stays at %s)", server, err, now.Format(time.RFC3339))
		return
	}
	drift := t.Sub(now)
	if drift < 0 {
		drift = -drift
	}
	if !needs && drift < 2*time.Minute {
		log.Printf("ntp: clock already within %s of %s, not stepping", drift.Round(time.Second), server)
		return
	}
	if err := setSystemClock(t); err != nil {
		log.Printf("ntp: cannot set clock to %s: %v", t.Format(time.RFC3339), err)
		return
	}
	log.Printf("ntp: clock stepped %s -> %s (was %s off %s)", now.Format(time.RFC3339),
		t.Format(time.RFC3339), drift.Round(time.Second), server)
}
