package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Logger is a size-rotating append logger: when the active file passes max it
// becomes .1, .1 becomes .2, and files beyond keep are removed. The box is
// left running for weeks, so "grows until the flash fills" is not an option.
type Logger struct {
	mu   sync.Mutex
	path string
	max  int64
	keep int
	f    *os.File
	size int64
}

func newLogger(dir string, max int64, keep int) (*Logger, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	l := &Logger{path: filepath.Join(dir, "hdfrd.log"), max: max, keep: keep}
	// A wrapper redirect may have grown daemon.out across boots; rotate it too.
	l.rotateIfBig(filepath.Join(dir, "daemon.out"))
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *Logger) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f = f
	l.size = st.Size()
	return nil
}

func (l *Logger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	line := fmt.Sprintf("%s %s\n", time.Now().UTC().Format("2006-01-02T15:04:05Z"), fmt.Sprintf(format, args...))
	// Rotate *before* the write so the active file always ends with the newest
	// line - it is what an operator tails.
	if l.size > 0 && l.size+int64(len(line)) > l.max {
		l.rotate()
	}
	n, err := l.f.WriteString(line)
	if err == nil {
		l.size += int64(n)
	}
}

func (l *Logger) rotate() {
	l.f.Close()
	for i := l.keep - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", l.path, i), fmt.Sprintf("%s.%d", l.path, i+1))
	}
	os.Rename(l.path, l.path+".1")
	os.Remove(fmt.Sprintf("%s.%d", l.path, l.keep+1))
	_ = l.open()
}

// rotateIfBig rotates a stray file that something else keeps appending to.
func (l *Logger) rotateIfBig(path string) {
	st, err := os.Stat(path)
	if err != nil || st.Size() <= l.max {
		return
	}
	os.Rename(path, path+".1")
	os.Remove(path + fmt.Sprintf(".%d", l.keep+1))
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
	}
}
