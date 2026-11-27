package main

// Vendor recorder handles are small integers (seen 0..5) and the box hands a
// freed one to the very next start. A stop sent by handle is therefore only safe while the
// recording that was given that handle still owns it.
//
// Measured 2026-11-26 09:27: channel 71 was stopped (handle 2), channel 70 started
// and was given handle 2, and five seconds later the reconcile sweep - seeing 71's
// file still in the registry while it was being cleaned up - sent "stop 71|2",
// which stopped channel 70's recorder. The player saw a stream that played for a
// few seconds and froze. This book is the rule that makes that impossible.

import "sync"

type stopVerdict int

const (
	stopAllowed    stopVerdict = iota // send it
	stopDuplicate                     // this recording was already stopped
	stopReassigned                    // the handle now belongs to another recording
)

func (v stopVerdict) String() string {
	switch v {
	case stopDuplicate:
		return "duplicate"
	case stopReassigned:
		return "reassigned"
	}
	return "allowed"
}

// handleBook remembers, per handle, the record id of the most recent start that
// was given it, and which record ids have had a stop acknowledged.
type handleBook struct {
	mu      sync.Mutex
	owner   map[string]string // handle -> record id
	stopped map[string]bool   // record id -> stop acknowledged
	order   []string          // stopped ids, oldest first, to bound the map
}

// claim records that a successful start was given `handle` for record `id`.
func (b *handleBook) claim(handle, id string) {
	if handle == "" || id == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.owner == nil {
		b.owner = map[string]string{}
	}
	b.owner[handle] = id
}

// verdict decides whether a stop of (handle, id) may be sent.
//
// retry is set for a deliberate second stop of a recording that is still
// growing after the first one: that is allowed for as long as the recording
// still owns the handle, but never once the handle has moved on.
//
// Unknown handles or ids are allowed: they come from a previous daemon run
// (nothing has been started since, so nothing can have taken the handle) or from
// a start whose answer was lost, where the page resolves the recorder by LCN.
func (b *handleBook) verdict(handle, id string, retry bool) stopVerdict {
	if handle == "" || id == "" {
		return stopAllowed
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if o, ok := b.owner[handle]; ok && o != id {
		return stopReassigned
	}
	if !retry && b.stopped[id] {
		return stopDuplicate
	}
	return stopAllowed
}

// markStopped records that a stop for record `id` was acknowledged.
func (b *handleBook) markStopped(id string) {
	if id == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped == nil {
		b.stopped = map[string]bool{}
	}
	if !b.stopped[id] {
		b.stopped[id] = true
		b.order = append(b.order, id)
	}
	// Bound the memory, oldest first: only recent ids can matter, because a
	// freed handle is reassigned within seconds.
	for len(b.order) > 256 {
		delete(b.stopped, b.order[0])
		b.order = b.order[1:]
	}
}
