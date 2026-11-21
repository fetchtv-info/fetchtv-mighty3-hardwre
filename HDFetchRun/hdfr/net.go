package main

import (
	"errors"
	"net"
	"time"
)

// waitForIPv4 exists because the boot wrapper runs early: DHCP may not have
// completed when hdfrd -configure starts. Poll briefly rather than writing a
// homepage URL with no address in it.
func waitForIPv4(timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		if ip := firstIPv4(); ip != "" {
			return ip, nil
		}
		if time.Now().After(deadline) {
			return "", errors.New("no non-loopback IPv4 address")
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func firstIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return ""
}
