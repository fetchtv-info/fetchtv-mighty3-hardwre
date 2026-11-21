package main

import (
	"encoding/json"
	"sync"
	"time"
)

// cmdQueue is the daemon side of the control bus. The page is the only part of
// the system that can touch the tuner/recorder, so work is queued here and the
// page collects it by polling /api/next. Small and in-memory on purpose: a
// queued command nobody collects is forgotten at the next reboot.
type cmdQueue struct {
	mu      sync.Mutex
	nextID  int
	pending []Command
	last    *Report
	waiters map[int]chan Report
}

type Command struct {
	ID  int    `json:"id"`
	Cmd string `json:"cmd"`
	Arg string `json:"arg"`
}

type Report struct {
	ID     int    `json:"id"`
	Cmd    string `json:"cmd"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func newCmdQueue() *cmdQueue {
	return &cmdQueue{nextID: 1, waiters: map[int]chan Report{}}
}

func (q *cmdQueue) add(name, arg string) Command {
	q.mu.Lock()
	defer q.mu.Unlock()
	c := Command{ID: q.nextID, Cmd: name, Arg: arg}
	q.nextID++
	q.pending = append(q.pending, c)
	return c
}

func (q *cmdQueue) pop() (Command, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.pending) == 0 {
		return Command{}, false
	}
	c := q.pending[0]
	q.pending = q.pending[1:]
	return c, true
}

// wait blocks until the page reports on this command id, or the timeout expires.
func (q *cmdQueue) wait(id int, timeout time.Duration) (Report, bool) {
	ch := make(chan Report, 1)
	q.mu.Lock()
	q.waiters[id] = ch
	q.mu.Unlock()
	defer func() {
		q.mu.Lock()
		delete(q.waiters, id)
		q.mu.Unlock()
	}()
	select {
	case r := <-ch:
		return r, true
	case <-time.After(timeout):
		return Report{}, false
	}
}

func (q *cmdQueue) report(r Report) {
	q.mu.Lock()
	q.last = &r
	ch := q.waiters[r.ID]
	q.mu.Unlock()
	if ch != nil {
		select {
		case ch <- r:
		default:
		}
	}
}

func (q *cmdQueue) snapshot() (pending int, last json.RawMessage) {
	q.mu.Lock()
	defer q.mu.Unlock()
	pending = len(q.pending)
	if q.last != nil {
		b, _ := json.Marshal(q.last)
		last = b
	}
	return
}
