# 03 — On-box functions: binaries, native JS surface, and what actually works

This document lists what exists on the unit and, for each thing, whether it was
exercised and whether it behaved. Nothing here needs any vendor service: every
call below runs against the hardware, locally.

Status column:

| Status | Meaning |
|---|---|
| **works** | Exercised on hardware, behaved as described |
| **present** | Binding exists; not exercised here |
| **unreliable** | Exists, but returns values that do not reflect reality |
| **dead** | Callable, returns `-1` regardless of arguments — not wired up on this build |

## 3.1 What runs where

| Layer | Component |
|---|---|
| Boot ROM → loader | BBL / BFW / SSBL / BOLT (document 01) |
| Kernel | Linux `4.1.20-1.9`, armv7l, built for this board |
| Initramfs | `/etc/init.d/rcS` as PID 1; mounts the flash rootfs and the disk |
| Rootfs (ramfs, volatile) | `/home/<vendor>/` — helper binaries and the startup script |
| `/usr` (ext4, read-only) | the application and its libraries |
| `/root` (ext4, read-write) | persistent state files |
| Application | `nxserver` — Broadcom Nexus middleware; it launches the browser |
| UI | Chromium webview rendering a local web bundle |
| Bridge | a native object exposed to the page's JavaScript (`Ag_*` methods) |

There is no separate "product UI" on the box: the locally installed web bundle
registers exactly seven surfaces —

```
SPLASH, PRE_SPLASH, OFFLINE_LAUNCH, SETTINGS_NETWORK, MODAL, OSD, MEDIA_PLAYER
```

— with no home screen, no channel list and no guide. The full menu is fetched at
boot from the vendor's servers after a successful authentication. On an isolated 
box the welcome/retry surface is what you get *instead of* the menu, not a gate in front of it.

— Any vendor middleware is removed during the Factory Reset process. Boxes that have
**not** been factory reset are likely to retain a cache of the vendor's UI. It bears
repeating: nothing in this repo refers to any of the vendor UI code as it does not exist 
on my unit.

## 3.2 Binaries

All ELF32 ARM EABI5 hard-float, built with GCC 4.8.5 (Broadcom `stbgcc-4.8-1.5`).

| Binary | Size | What it is |
|---|---|---|
| `nxserver` | 860 619 B | Nexus media server. Heap and platform management, JSON-RPC over Unix domain sockets, video plane and HDMI/HDCP control. Effectively stripped: `file` claims DWARF, but `nm` shows only `$a` local labels and the DWARF comes from statically linked libc. Use `nm -D` and `strings`; the `NEXUS_*` API names survive in `.rodata`. |
| `nxserver_config` | 219 477 B | frontend/tuning tool — `NEXUS_Frontend_TuneOfdm`, `NEXUS_PacketSub_Open`, `libliveMedia`, `libbip_*`, `libtshdrbuilder` |
| `nxserver_heaps` | 52 404 B | heap inspector — `NEXUS_Heap_GetStatus`, `NxClient_Join` |
| `libnexus.so` | ~7 MB | the exported API used by anything that wants the hardware directly |
| `nexus.ko` | — | kernel module that owns the tuner. **There is no `/dev/dvb` and no `/sys/class/dvb`** on this box. |

`libnexus.so` exports what a standalone client would need:
`NEXUS_Tuner_Init/OpenGeneric/Open3128/Acquire/Tune/SetFrequency/Untune/GetStatus/ReadPowerLevel`,
`NEXUS_PidChannel_*` (demux) and `NEXUS_Record_*` / `NEXUS_RecordModule_*` (record).
No headers ship on the box, so prototypes have to be reconstructed from symbols;
there is also no ARM toolchain installed.

## 3.3 How the page reaches the hardware

The UI's JavaScript gets a native object with `Ag_*` methods. Two access paths
were used, both verified:

```js
var hw  = window.top.hardware;          // vendor wrapper layer
var nat = hw.hardware;                  // the native object itself
```

and, from any page in the same browser process:

```js
var nat = new window.AVPlayer();         // same native object, no wrapper needed
```

The wrapper layer (`Hybroad_Base`, `ChannelManager`, `MediaPlayer`) wraps only a
fraction of the native surface, and it is unreliable evidence in both directions
— see 3.5.

## 3.4 Native surface

### DVB / tuner

| Call | Status | Notes |
|---|---|---|
| `Ag_dvb_startScan(0, freq, dist, count, 7)` | **works** | DVB-T Channel Scan. One band-plan stage. Unit is kHz. The M616T band plan is `freq = [177500, 522500]`, `dist = [7000, 7000]`, `count = [8, 43]` — i.e. 177.5 MHz + 8×7 MHz, then 522.5 MHz + 43×7 MHz (AU DVB-T). |
| `Ag_dvb_getAutoScanProgress()` | **works** | Scan percentage |
| `Ag_dvb_Channel_GetCount(0)` | **works** | services found count. |
| `Ag_dvb_Channel_GetCountByTunerType` | present | not exercised |
| `Ag_dvb_GetLogicalChannelNumberByIndex(tunerId, i)` | **works** | `tunerId` = `hardwareCapabilities.tuner.currentFreqTunerId` (2 on this unit) |
| `Ag_dvb_GetNITData(tunerId, lcn)` | **works** | returns the ONID:TSID:SID triplet |
| `Ag_dvb_GetChannelNameByIndex(tunerId, lcn)` | **works** | returns a **JSON string**, not a field: `{"channelName0":"…","channelName1":"…"}` |
| `Ag_dvb_GetCurrentChannelName` | present | not exercised |
| `Ag_dvb_GetCurrentFrequency` | **unreliable** | returned `-1`, and once a garbage value, while a channel was playing |
| `Ag_dvb_GetFrequencyByLCN`, `GetIndexByLCN`, `GetLCNbyTriplet`, `Ag_dvb_getAllLCN` | present | not individually exercised |
| `Ag_dvb_play(0, lcn)` | **works** | picture and audio. This alone is enough to watch a service. |
| `Ag_dvb_stop(0)` / `Ag_dvb_stop_sync(0)` | **works** | see the retune rule below |
| `Ag_dvb_getCurrentSignalQuality()` / `…Strength()` | **unreliable** | both return a constant `100` regardless of state but I may have good signal? |
| `Ag_dvb_deleteChannelList` | present | destructive; not exercised |
| `getSmartCardNum` / `getCASysID` | present | CA side; not exercised |

Changing Live Channels
The sequence that works is `Ag_dvb_stop(0)` (fallback `Ag_dvb_stop_sync(0)`), wait ~250 ms, then `Ag_dvb_play(0, lcn)`.

### DVB EIT (programme data carried in the broadcast)

| Call | Status | Notes |
|---|---|---|
| `Ag_dvb_EITScanStart(0)` | **works** | returns `0`; starts collection on the tuned multiplex |
| `Ag_dvb_EITScanStop` | present | — |
| `Ag_dvb_getPresentEvent(0, lcn, "eng")` | **works** | JSON string |
| `Ag_dvb_getNextEvent(0, lcn, "eng")` | **works** | JSON string |
| `Ag_dvb_TDTsyncTime` | present | time from the transport stream; not exercised |
| `Ag_dvb_GetScheduleEventIdCount` / `…IdByIndex` / `…InfoByID` | **dead** | the binding exists and the store behind it does not: 1–2 arguments throw "3 arguments required"; `(0, 7, now)` crashes the application natively; every other argument shape tried returns `-1`, even after a 60 s warm-up on a multiplex where present/next answer correctly. |

EIT notes:

- **Per multiplex only.** You get services on the mux you are tuned to; every
  other multiplex returns `null`. There is no cross-mux cache and no stored
  guide. A full guide means hopping muxes, ~10–15 s each.
- **The tuner argument is not a selector.** `Ag_dvb_EITScanStart(1)` returns `0`
  and `getPresentEvent(1, …)` behaves exactly like tuner 0, while
  `Ag_dvb_play(1, 9)` retunes the live picture. Everything in this layer is
  effectively tuner 0; the recorder's own tuners are allocated natively and are
  not addressable from JS.
- **Times are UTC**, per ETSI EN 300 468, exactly like the box clock. Compare and
  sort directly; convert only for display.
- **`startTime` is not zero-padded** — `"2026-11-11 8:30:30"`, `"2026-11-11 9:2:20"`.
  Split on separators and construct the date; fixed-offset slicing yields wrong
  dates.
- **Retry the read after a retune.** The tables are not complete the instant the
  tuner locks: a single read 3 s after tuning returns `null` often enough that
  anything built on it silently never appears. Retry 2–3 times, 3 s apart, and
  accept a partial result.
- `programCrid` / `seriesCrid` come back with a binary prefix mixed into the
  string. Use them as opaque ids; never parse or display them.

### Recorder

| Call | Status | Notes |
|---|---|---|
| `Ag_record_init()` | **works** | no arguments; **mandatory before any other record call**, and asynchronous — poll `Ag_playBack_rangeFile(0,0)` and `Ag_record_getDiskTotalSize()` until the count is `>= 0` and the sizes are no longer `-100`. Took ~6 s here. |
| `Ag_record_create()` | **works** | returns an id |
| `Ag_record_startByLCNAndID(lcn, id)` | **works** | returns `0` |
| `Ag_record_getStatus(handle)` | **works** | `1` while recording; takes one argument |
| `Ag_record_stop(handle)` | **works** | — |
| `Ag_record_getNoOfDrives`, `checkDiskStatus`, `getDiskFreeSize`, `getDiskTotalSize`, `GetLimitedSpace`, `getInfo` | **works** | real values; sizes are in KB |
| `Ag_record_getMetaData` | present | takes 2 arguments |
| `Ag_record_addTimer`, `getNoOfTimer`, `getTimerInfoByIndex`, `deleteTimerByIndex`, `stopRecordingTimer`, `cancelReadyTimer`, `getTimerMessage`, `getTimerRecError`, `getTunerIndexByLCN` | **dead** | all return `-1` regardless of arguments; re-running `Ag_record_init()` does not revive them. The vendor scheduled recordings server-side, so the local timer engine was left unwired. |

**Never call `create`/`start` without a completed `init`.** The uninitialised
subsystem still hands back a plausible handle (e.g. `763161831`), and `start`
then kills the application — a watchdog reboot loop, with disk sizes reading
`-100`.

**Output format:** `/mnt/usb1/PVR/record<N>.mpg` plus `.nav` and `.mda`, with
`.MediaIndexFILE` updated. Recording is a **full-multiplex capture**, not a
single programme: a 45 s clip of one service contained all 16 services on that
mux, at 360–560 KB/s (~25 MB per 45 s). Playback selects the programme out of
the stream.

**The recorder allocates its own tuner.** With a live channel playing, a
recording of a *different* multiplex completed while the live picture stayed
unchanged. This box has four tuners.

### Playback

| Call | Status | Notes |
|---|---|---|
| `Ag_playBack_rangeFile(0, 0)` | **works** | doubles as the recording count |
| `Ag_playBack_getIndexByID(id)`, `getFileInfo(index)` | **works** | `getFileInfo` returns the `@`-delimited string `id@0@0@000000@YYYY:MM:DDHH:MM:SS@HH:MM:SS@sizeKB@id`; note the date runs straight into the time |
| `Ag_playBack_play(index)`, `playPos(index, seconds)` | **works** | |
| `pause`, `resume`, `seek(seconds)`, `trick`, `stop` | **works** | |
| `getCurrentTime`, `getTotalTime`, `getStatus` | **works** | timestamps advance with wall clock when playback is healthy |
| `Ag_playBack_deleteFile(index)` | **works** | immediate, no confirmation |

**Free the decoder before playing a file.** Live DVB playback holds the video
decoder, so playback started while live TV is decoding produces a black picture
and a frozen position. Tested correct order:

```
Ag_dvb_stop(0)  →  ~1 s  →  Ag_playBack_playPos(index, 0)  →  …  →
Ag_playBack_stop()  →  Ag_dvb_stop(0)  →  playDvb({lcn}) to return to live
```

### Time-shift (pause live TV)

| Call | Status |
|---|---|
| `Ag_timeShift_startRecording()` | present |
| `Ag_timeShift_setBufferSize(seconds)` | present |
| `Ag_timeShift_pause`, `resume`, `play`, `trick(speed)`, `seek(position)`, `stop(1)`, `sync()`, `saveBuffer()` | present |
| `Ag_timeShift_getPlayTime`, `getRecordTime`, `getTotalTime`, `getStatus` | present |

**This is an API inventory, not verified behaviour** — the calls exist on the
object and accept arguments, but the feature was not exercised on this unit.

### Power / standby

| Call | Status |
|---|---|
| `Ag_power_standby()` | present |
| `Ag_power_enterDeepStandby('0xa25d4664', -1)` | present — magic token plus timeout, purpose not understood |
| `Ag_power_wakeUp()`, `Ag_power_standByReinitHDMI()`, `Ag_power_reboot()` | present |

`/sys/power/state` offers `freeze standby mem`. None of these were exercised.

### Local file I/O

The only durable store available to injected JavaScript:

| Call | Status | Notes |
|---|---|---|
| `Ag_textFile_open(path, mode)`, `read(fd, nbytes)`, `write(fd, data, bits)`, `close(fd)` | **works** | |
| `Ag_textFile_remove(path)` | **works** | |

Three traps, each of which produced silent corruption:

- **Writes truncate.** A single long `write` produced a 0-byte file, and a
  41-character write landed as 7 bytes — both read back as plausible, shorter
  files. Chunk at ≤200 chars, then reopen and compare the text before trusting
  it.
- **Never put a `|` in the payload.** The native write truncates at one, so
  `id|label` lands as the bare id. Use TAB between fields and strip `|`, TAB and
  newlines from values.
- **EOF is the string `"0"`, not a short read.** The read loop is
  `while ((chunk = read(fd, 512)) !== "0")`, and the guard must be raised for
  large files — a 696 KB file is ~1360 iterations at 512 bytes.

The file API on this build also appears to be restricted by extension: `.txt`
and `.json` open, while a `.tsv` silently returns `-1`.

### System

| Call | Status |
|---|---|
| `Ag_system_getModeNo` | present — not exercised |

## 3.5 Remote key events

Keys arrive as DOM `keydown` with **no `key` and no `code`** field, only a vendor
`keyCode`.

| Button | `keyCode` |
|---|---|
| CH UP | `1073741869` (`0x4000002D`) |
| CH DOWN | `1073741867` (`0x4000002B`) |
| digits 0–9 | ASCII 48–57 |
| Up / Down / Left / Right | `38` / `40` / `37` / `39` — standard browser codes, the one noted exception to the vendor scheme |
| TV Guide | `224` (`0xE0`) |
| Play/Pause | `415` |
| Stop | `413` |
| Fast Forward | `417` |
| Rewind | `412` |
| Record | `210` |
| Menu | `1073742338` (`0x40000202`) |
| Apps | `1073741974` (`0x40000156`) |
| Back | `213` |
| Exit | `203` |
| OK | `1073741994` (`0x400000AA`) |
| VOL UP / DOWN | **never reach the page** — consumed by the box |

Two practical notes: each press can arrive 2–3 times because `window`,
`document` and `body` listeners all fire, so dedupe by code plus timestamp
rather than counting events; and a handler that throws is completely silent here
— no console, no toast, no log — so wrap dispatch and report exceptions, or a
broken handler is indistinguishable from a key that never arrived.

## 3.6 Time

- **There is no usable battery-backed RTC.** `rtc0` is `brcmstb-waketmr`, a wake
  timer, and it reads 1970 until something sets the clock. Nothing arms an
  alarm, so a scheduled wake would have to be an offset from "now" while
  powered.
- A 1970 clock breaks every TLS connection, which presents as "the box is
  offline". The clock has to be set at boot from something that works at any
  date — plain HTTP, not HTTPS — or from the broadcast, via `Ag_dvb_TDTsyncTime` (untested).
- EIT timestamps are UTC

## 3.7 Networking from userspace

- The application takes a DHCP lease, so its address is whatever the DHCP server
  gives it — not the static address you configured in the loader or the initramfs
  shell.
- **No CA trust store ships on the box.** `/etc/ssl/certs/ca-certificates.crt`
  does not exist, so native HTTPS fails with
  `curl: (60) unable to get local issuer certificate`. The browser is unaffected
  because it runs with `--ignore-certificate-errors` — which is why the web UI
  loads while every native call that uses TLS fails. Exporting
  `SSL_CERT_FILE` / `CURL_CA_BUNDLE` to a bundled CA file before the application
  starts fixes it for it and everything it spawns.
- `ntpd -q` returns success without setting the clock on a normal home network in my tests. (Not investigated further)
- The box's own `curl` is not in `PATH`; invoke it by absolute path.
- Busybox in the initramfs has **no `grep`** and no `sqlite3` — filter and query
  host-side.
- `busybox ps` lists only the current session. To see what is really running,
  read `/proc/[0-9]*/cmdline`.

## 3.8 Untested

`Ag_dvb_TDTsyncTime`, `Ag_dvb_deleteChannelList`,
`getSmartCardNum`, `getCASysID`, the whole `Ag_timeShift_*` and `Ag_power_*`
families, `Ag_system_getModeNo`, `Ag_record_getMetaData`, the
`GetFrequencyByLCN` / `GetIndexByLCN` / `GetLCNbyTriplet` / `getAllLCN` group, and
USB mass storage from the application's own view.

A wrong call to the
recorder or the tuner takes the application down, and the watchdog turns that
into a reboot.
