package main

import (
	"io"
	"os"
	"time"
)

// Starting a transport stream mid-GOP means the decoder has nothing to show
// until the next keyframe, which is why HD channels take noticeably longer to
// appear on the client. Broadcasters mark keyframe packets with the
// transport-level random_access_indicator, so the stream can start there
// instead of at whatever byte the recorder happened to begin on.
const (
	tsPacketSize    = 188
	tsScanWindow    = 1 << 20 // 1 MiB is ~1.5 s of a 5.6 Mbps mux
	tsLiveWindow    = 3 << 20 // how far back from the end a joining client may start
	tsKeyframeWait  = 4 * time.Second
	tsScanPollSleep = 150 * time.Millisecond
)

// tsAlignedOffset finds the first offset where a run of packets all start with
// the 0x47 sync byte, i.e. where the transport stream really begins. The
// recorded file can start mid-packet because the recorder joins a live mux.
func tsAlignedOffset(buf []byte) int {
	for off := 0; off < tsPacketSize && off+tsPacketSize*8 <= len(buf); off++ {
		aligned := true
		for k := 0; k < 8; k++ {
			if buf[off+k*tsPacketSize] != 0x47 {
				aligned = false
				break
			}
		}
		if aligned {
			return off
		}
	}
	return -1
}

// firstKeyframeOffset returns the absolute offset of the first packet that both
// starts a PES and is flagged as a random access point, or -1 if the window
// holds none.
func firstKeyframeOffset(buf []byte, base int64) int64 {
	start := tsAlignedOffset(buf)
	if start < 0 {
		return -1
	}
	for i := start; i+tsPacketSize <= len(buf); i += tsPacketSize {
		if buf[i] != 0x47 {
			return -1 // alignment lost; do not guess
		}
		afc := (buf[i+3] >> 4) & 0x03 // adaptation_field_control
		if afc != 2 && afc != 3 {
			continue
		}
		if buf[i+4] == 0 {
			continue // adaptation field present but empty
		}
		randomAccess := buf[i+5]&0x40 != 0 // adaptation field: RAI
		payloadStart := buf[i+1]&0x40 != 0 // PUSI
		if randomAccess && payloadStart {
			return base + int64(i)
		}
	}
	return -1
}

// keyframeStart waits for the recording to fill enough to scan, then returns the
// offset to start serving from. It looks at the *end* of the file first: a client
// joining a stream that has been running for a while must start at the live edge,
// not at the first keyframe of the file, or it races through old footage (and
// looks like a bandwidth spike). It falls back to offset 0 when nothing better
// presents itself.
func keyframeStart(f *os.File) int64 {
	deadline := time.Now().Add(tsKeyframeWait)
	for {
		if st, err := f.Stat(); err == nil && st.Size() >= int64(tsPacketSize*8) {
			size := st.Size()

			// Live edge first: the first keyframe in the last few seconds of the
			// recording.
			from := size - tsLiveWindow
			if from < 0 {
				from = 0
			}
			span := size - from
			buf := make([]byte, span)
			if _, err := f.ReadAt(buf, from); err == nil || err == io.EOF {
				if off := firstKeyframeOffset(buf, from); off >= 0 {
					return off
				}
			}

			// Nothing in the live window yet (fresh recording, or the recorder is
			// between keyframes): fall back to the start of the file.
			if from > 0 && size >= int64(tsPacketSize*8) {
				head := size
				if head > tsScanWindow {
					head = tsScanWindow
				}
				buf2 := make([]byte, head)
				if _, err := f.ReadAt(buf2, 0); err == nil || err == io.EOF {
					if off := firstKeyframeOffset(buf2, 0); off >= 0 {
						return off
					}
				}
			}
			if size >= tsLiveWindow+tsScanWindow {
				return 0 // long file, no keyframe anywhere we looked
			}
		}
		if time.Now().After(deadline) {
			return 0
		}
		time.Sleep(tsScanPollSleep)
	}
}
