package main

// Service identity from the stream itself.
//
// The box exposes no way to say which file a tuner is writing, so the daemon has
// to pick a candidate and hope. This file removes the hope from the common case:
// the recording carries the served service's PMT, and the program number in it
// is stable per channel.
//
// It must be the PMT, not the PAT. On a multiplex like Seven the box keeps the
// full PAT (8 programs) and records only the requested service, so "the first
// program in the PAT" is 1360 for every Seven channel and cannot tell 7 from
// 7two. The PMT that is actually present names the service (measured
// 2026-11-26: 7 = 1360, 7two = 1362, 7flix = 1366, 7mate = 1367).
//
// Learn the number once per channel, then verify every later candidate: a file
// whose PMT names a different program is, provably, not the channel asked for.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
)

// The name changed when identification moved from the PAT to the PMT: values
// learned the old way (first PAT program) are wrong for every channel sharing a
// multiplex, and reading them would reject good recordings.
const programStateName = "programs-pmt.json"

// servedProgram returns the program number of the service actually recorded in
// the file, read from its PMT, or 0 when none is found.
//
// It starts at `from` because a recycled recording may still hold the previous
// channel's PSI at the head of the file: the new data begins at the offset the
// stream adopted the file, and only that region describes our channel.
//
// The PAT is read first only to learn which PIDs carry PMTs. Matching table_id
// 0x02 on arbitrary PIDs is not safe: video PES payload can contain that byte.
func servedProgram(f *os.File, from, window int64) int {
	if window <= 0 {
		window = 1 << 20
	}
	if from < 0 {
		from = 0
	}
	buf := make([]byte, window)
	n, err := f.ReadAt(buf, from)
	if err != nil && n == 0 {
		return 0
	}
	buf = buf[:n]

	pmtPIDs := map[uint16]bool{}
	for off := 0; off+188 <= len(buf) && len(pmtPIDs) == 0; off += 188 {
		sec := psiSection(buf[off:off+188], 0x0000, 0x00)
		if sec == nil {
			continue
		}
		end := 3 + (int(sec[1]&0x0f)<<8 | int(sec[2])) - 4
		if end > len(sec) {
			end = len(sec)
		}
		for j := 8; j+4 <= end; j += 4 {
			prog := int(sec[j])<<8 | int(sec[j+1])
			pid := uint16(sec[j+2]&0x1f)<<8 | uint16(sec[j+3])
			if prog != 0 {
				pmtPIDs[pid] = true
			}
		}
	}
	if len(pmtPIDs) == 0 {
		return 0
	}
	for off := 0; off+188 <= len(buf); off += 188 {
		pkt := buf[off : off+188]
		pid := uint16(pkt[1]&0x1f)<<8 | uint16(pkt[2])
		if !pmtPIDs[pid] {
			continue
		}
		if sec := psiSection(pkt, pid, 0x02); sec != nil {
			return int(sec[3])<<8 | int(sec[4]) // program_number
		}
	}
	return 0
}

// psiSection returns the section starting in this packet if it is on `pid`,
// starts a payload unit, and carries `table`. Nil otherwise.
func psiSection(pkt []byte, pid uint16, table byte) []byte {
	if len(pkt) < 188 || pkt[0] != 0x47 || pkt[1]&0x40 == 0 {
		return nil
	}
	if uint16(pkt[1]&0x1f)<<8|uint16(pkt[2]) != pid {
		return nil
	}
	start := 4
	if pkt[3]&0x20 != 0 { // adaptation field present
		start += 1 + int(pkt[4])
	}
	if start >= 188 {
		return nil
	}
	start += 1 + int(pkt[start]) // pointer_field
	if start+12 > 188 || pkt[start] != table {
		return nil
	}
	return pkt[start:]
}

// programMap remembers which PAT program number each LCN records as.
type programMap struct {
	mu    sync.Mutex
	path  string
	byLCN map[string]int
	// droppedAtLoad lists LCNs forgotten at load for sharing a program number,
	// so the daemon can log it once it has a logger.
	droppedAtLoad []string
}

func loadProgramMap(root string) *programMap {
	pm := &programMap{path: filepath.Join(root, "state", programStateName), byLCN: map[string]int{}}
	if b, err := os.ReadFile(pm.path); err == nil {
		var raw map[string]int
		if json.Unmarshal(b, &raw) == nil && raw != nil {
			pm.byLCN = raw
		}
	}
	if len(pm.dropShared()) > 0 {
		pm.save()
	}
	return pm
}

// dropShared removes every entry whose program number another LCN also holds,
// and returns the LCNs removed. A program number names one service, so a shared
// value means at least one entry was learned from the wrong recording - and
// nothing says which, so both are forgotten and relearned. (Measured: with the
// recording tuners stuck, channel 10's start wrote Nine into a new file, and 10
// learned Nine's 1110; every real 10 HD recording was then rejected.)
func (pm *programMap) dropShared() []string {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	count := map[int]int{}
	for _, v := range pm.byLCN {
		count[v]++
	}
	var dropped []string
	for k, v := range pm.byLCN {
		if count[v] > 1 {
			delete(pm.byLCN, k)
			dropped = append(dropped, k)
		}
	}
	sort.Strings(dropped)
	pm.droppedAtLoad = dropped
	return dropped
}

func (pm *programMap) get(lcn string) int {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	return pm.byLCN[lcn]
}

// owner returns the LCN, other than `except`, that holds this program number,
// or "" if none does.
func (pm *programMap) owner(prog int, except string) string {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	for k, v := range pm.byLCN {
		if v == prog && k != except {
			return k
		}
	}
	return ""
}

// learn records the observed program number, replacing a stale value. It
// refuses a value another LCN already holds and returns that LCN, because the
// commonest way to see another channel's program is to have been handed its
// recording; the cost of refusing is only that this channel stays unverified.
func (pm *programMap) learn(lcn string, prog int) (refusedFor string) {
	if prog == 0 {
		return ""
	}
	pm.mu.Lock()
	for k, v := range pm.byLCN {
		if v == prog && k != lcn {
			pm.mu.Unlock()
			return k
		}
	}
	old, had := pm.byLCN[lcn]
	if had && old == prog {
		pm.mu.Unlock()
		return ""
	}
	pm.byLCN[lcn] = prog
	pm.mu.Unlock()
	pm.save()
	return ""
}

func (pm *programMap) save() {
	pm.mu.Lock()
	raw := make(map[string]int, len(pm.byLCN))
	for k, v := range pm.byLCN {
		raw[k] = v
	}
	pm.mu.Unlock()
	b, err := json.MarshalIndent(raw, "", " ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(pm.path), 0o755)
	tmp := pm.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		_ = os.Rename(tmp, pm.path)
	}
}

// known returns whether this LCN has been seen before.
func (pm *programMap) known(lcn string) bool {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	_, ok := pm.byLCN[lcn]
	return ok
}

// String is for logs and diagnostics.
func (pm *programMap) String(lcn string) string {
	return strconv.Itoa(pm.get(lcn))
}
