# HDFetchRun (HDFR)

Turns a FetchTV M616T set-top box into a tuner Jellyfin can see as an HDHomeRun, with a
minimal on-box UI driven by the retail remote. Design and phase plan: `../DESIGN.md`.
What the box actually does, as measured: `../phase0/FINDINGS.md`.

**Status: phase 6.** Tuner emulation works end to end: Jellyfin discovers the box as an
HDHomeRun, lists all channels, and plays them (verified on Android TV); VLC and other IPTV
players use `playlist.m3u`. Three streams can record at once, on three different multiplexes
(verified 2026-11-27), and a fourth waits for a free tuner or is refused. HDFR serves its own
XMLTV guide and a read-only TVHeadend-compatible API. Phases: 0-3 the tuner surface and UI,
4 the guide, 5 hardening, 6 the TVH API; stream resilience and tuner slots came after.

## HDHomeRun surface (phase 3)

| endpoint | behaviour |
|---|---|
| `/discover.json` | `ModelNumber` `HDHR-4DT` (deliberately not `hdtc`), `TunerCount` 3, `BaseURL`/`LineupURL` built from the request's `Host` |
| `/lineup.json` | the page's channel list as `{GuideNumber, GuideName, URL, HD}`; URL is `http://<host>/auto/v<lcn>` |
| `/auto/v<lcn>` | starts a recording of that LCN on any free tuner, tails the recorder's `.mpg` and writes `video/mp2t` until the client goes away, then stops the recording and removes it through the vendor PVR index |
| `/tuner<N>/v<lcn>` | the same, on slot N (0-2): one viewer per slot, and a new request replaces what the slot was showing (see *Stream resilience*) |

Measured on the unit: ~750 KB/s (~6 Mbps) per stream, valid TS (1808/1808 packets on 0x47), three
concurrent streams on three multiplexes work (separate handles and files), and the PVR directory
returns to its baseline count after every disconnect. Two clients asking for the **same** channel
share one recording and one tuner (refcounted in `hdhr.go`).

The tail loop only reads and flushes; client loss is detected by the failed write or the request
context, and either way the stop is queued to the page, which owns the recorder; the daemon then
deletes the recording by its PVR index entry (never by unlinking the file).

Two details that matter in practice:

* **Tuning is a lock, streaming is the root.** A real HDHomeRun locks a tuner at
  `/tunerN/v<ch>` and then streams from the device root, and Jellyfin does exactly that (its
  ffmpeg input is `http://<device>/`). So `/` is the transport stream of the most recently
  locked tuner and the UI lives at `/ui/`. Serving HTML at `/` made ffmpeg fail with exit 187.
  Only the exact path `/` streams; any other unknown path is a 404 (the box's browser asks for
  `/favicon.ico` on every page load, and streaming that held a tuner).
* **Streams join at a keyframe.** The recorder starts writing mid-GOP, so the file's first
  bytes are usually undecodable until the next IDR. `ts.go` scans the growing file for a packet
  with the transport-level `random_access_indicator` and starts there; without it HD channels
  took noticeably longer to show a picture.

## Guide (phase 4)

The EPG is HDFR's own: it downloads the XMLTV, stores it under `/root/HDFR/guide/`, refreshes it
on a timer and serves it to the media server. Nothing else has to be running on the box.

| endpoint | behaviour |
|---|---|
| `/guide.xml` | the cached XMLTV with `<lcn>` shifted by `guide_offset`, so guide channels line up with lineups that were renumbered, and programme `<icon>`s removed (see *Thumbnails*) |
| `/api/guide` | cache status: path, size, when it was fetched, last error, whether a refresh is running |
| `/api/guide` (POST) | start a refresh now; the on-box menu's *Refresh guide* item calls this |
| `/api/cities`, `/api/guide/city?name=…` | the built-in city table and the setter the menu's *Guide city* picker uses |

Two operational endpoints:

- `POST /api/device?lcn=N&name=…` — the page reports what the box itself is tuned to;
  `/api/state` returns it as `viewing_lcn`. Only the page can see the vendor tuner, so this is
  self-reported, and it is deliberately *not* counted as a stream.
- `POST /api/release?lcn=N` — cancels a stream handler, which releases the tuner and discards
  the recording. A media server can leave a tuner open for minutes after the viewer stops (Jellyfin's
  live-TV kill timer), which otherwise occupies one of the three slots. The stream record is removed
  directly rather than left to the handler, because this box cannot set write deadlines and a
  handler blocked in `Write` would otherwise keep the slot until its client finally dropped.

Config: `guide_city` selects one of the 51 feeds in `cities.go` (the list from
xmltv.net's Australian index) and takes precedence over `guide_url`, which is
only for a custom feed (`guide_city` empty). `guide_refresh_hours` defaults to 24
and `0` disables refreshing. A failed or truncated download never replaces a
working cache; the response is validated before it is swapped in.

Two things about this box specifically:

* **The clock reads 1970** until the vendor app syncs time. Age arithmetic and TLS validation
  are meaningless in that state, so the refresher falls back to a monotonic timer and, while the
  clock is unset, fetches without certificate verification (the guide is public data). All of it
  is logged.
* **Matching is by LCN.** Jellyfin pairs a tuner channel with a guide channel by the `<lcn>`
  element, which is why the offset has to be applied to the guide as well as the lineup. The
  Adelaide feed carries 48 channels; the box scans 59 (it lists duplicates and +2 variants), so
  a subset of channels get programme data.


## On-box UI (phase 2)

The page (`index.html` + `app.js` + `ui.css`) is the only thing that can drive the tuner: the `Ag_*`
bridge belongs to the webview. It is deliberately empty when idle, because the video plane is
composited *behind* it — anything drawn shows as an overlay on live TV.

| Key | Live TV | Menu |
|---|---|---|
| Up / CH+ | next channel + OSD | move cursor |
| Down / CH- | previous channel + OSD | move cursor |
| OK / Menu | open the menu | activate item |
| Back / Exit | hide the OSD | close the menu |

Menu rows: the Jellyfin, IPTV playlist, XMLTV guide and TVH API URLs (taken live from
`/api/state`, so they follow the DHCP lease), stored channel count, **Scan for channels** (asks
for confirmation), **Refresh guide**, **Guide city**, **Debug harness on/off**, tuned channels,
what the box itself is showing, **Recording tuners** (`ok`, or a stuck-tuner warning), boot count
and version.
Rows marked `*` are actionable; info rows are not selectable.

Behaviour worth knowing:

- **Tuning always stops first.** A second `Ag_dvb_play` without an intervening `Ag_dvb_stop` changes
  the reported channel but leaves the video plane on the old one.
- **No channels stored means a scan.** At boot, `Ag_dvb_Channel_GetCount(0) == 0` triggers the SUI's
  own scan sequence rather than showing an empty UI.
- **The scan** is the vendor's two-stage plan (`deleteChannelList`, then `startScan` over VHF
  177500 kHz×8 and UHF 522500 kHz×43 with 7 MHz steps). The SUI waits for a native
  `CHANNEL_SCAN_BLOCK_END` event that does not exist outside the SUI, so this implementation polls
  `Ag_dvb_getAutoScanProgress()` instead, with a 20 s stall timeout and a 4 min cap per stage. It is
  destructive: it clears the stored channel list and stops live TV.
- **The page reports to the daemon** via `/api/log?msg=…`, which lands in `hdfrd.log`. That is the
  debug harness: `tail` the log over telnet and you see every tune, menu action and scan step without
  a serial console.

`/api/debug?enabled=0|1` flips the harness and rewrites `config.json` atomically:

- from the box itself (loopback) it is always allowed — this is what the menu uses;
- from the LAN it is only allowed while the harness is currently **on**, so turning it off cannot be
  undone remotely;
- the boot hook reads the flag and skips `telnetd` when it is explicitly `false` (anything else,
  including an unreadable config, starts it — the shell is the recovery path).


## Layout on the box

```
/root/HDFR/
  hdfrd          static ARM binary (Go, no runtime deps)
  config.json    the only operator-tunable file
  index.html     the page the box's browser loads
  logs/          hdfrd.log (+ .1 .. .N), daemon.out, hdfrd.pid
  backup/        nxserver.orig - the launcher as it was before HDFR
/root/hdfrd-boot.log              one line per boot, written by the hook
/root/yx_config_user.ini          vendor config; only homepage_url is touched
/root/yx_config_user.ini.hdfr-orig   byte copy of that file before our first edit
```

## How boot works

`/usr/local/bin/nxserver/nxserver` is a four-branch shell hook (see `boot/nxserver`):

1. Starts the development telnet shell on 2323.
2. If `/root/HDFR/hdfrd` is executable and `config.json` validates, it calls
   `hdfrd -configure` (which points `homepage_url` at `http://127.0.0.1:<port>/`) and starts
   `hdfrd -serve` with `setsid`.
3. Otherwise it puts `homepage_url` back to the stock offline page and boots stock.
4. It always ends with `exec .../nxserver.real`.

**The homepage URL is loopback on purpose.** The hook runs before the box's DHCP client has an
address (measured: no IPv4 at hook time, address appears ~20 s later). A URL containing the LAN
address would be empty or stale at boot. The daemon listens on all interfaces, so Jellyfin still
reaches it over the LAN.

The presence check is the executable bit on `hdfrd`. Removing or renaming that file is a complete,
reversible disable: the next boot restores the stock homepage and boots the Fetch UI.

## Install / uninstall

Files are pushed over HTTP, verified by md5, then installed by a script that remounts `/usr`
read-write only for the file swap:

```sh
# on a host serving hdfr/build artifacts at :8090/dist
wget -O /tmp/hdfr-stage/nxserver http://<host>:8090/dist/nxserver   # etc
sh /tmp/hdfr-stage/install.sh /tmp/hdfr-stage
```

`boot/uninstall.sh` restores the vendor launcher, puts `homepage_url` back and removes the tree.

## Recovery without a working daemon

telnet 2323 is started by the hook before anything that can fail, so it is always there:

```sh
mv /root/HDFR/hdfrd /root/HDFR/hdfrd.off     # disable; next boot is stock
# or, to restore the config by hand:
sed -i 's|^homepage_url=.*|homepage_url=file:///home/fetchtv/sui/internet_test_redirect.html|' \
    /root/yx_config_user.ini && sync && reboot
```

## Logs

`hdfrd.log` is size-rotated by the daemon (default 256 KB, keep 3). `hdfrd-boot.log` is bounded by
the hook (32 KB, one rotation) because when HDFR is disabled no daemon exists to rotate it.

## Security

No authentication anywhere: the HDHomeRun protocol has none, telnet is a root shell, and the HTTP
daemon answers every interface. LAN only — never port-forward this box.

## Building

```sh
./build.sh          # CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7, static, stripped
```
Also built on Windows at least once and it worked fine with latest golang. Check the build powershell script in tools.


### Source layout

Everything in `hdfr/` is one Go package (`package main`), so **every non-test `.go` file is
compiled into `hdfrd`** — Go has no source manifest and no per-file imports between files in a
package. Add a file and it joins the build; delete one and the build breaks wherever it was used.

| file | what it does |
|---|---|
| `main.go` | entry point; the `-serve` / `-configure` / `-restore` / `-stop` / `-version` flags |
| `hdhr.go` | HDHomeRun surface: discover, lineup, `/tunerN` slots and `/auto` pool, recorder start/stop, file identification, stream loop, registry, sweeps, release, stuck-tuner detection, served-guide cache |
| `handles.go` | vendor recorder handle ownership: one stop per recording, never a stop for a handle a newer recording holds |
| `service.go` | which service a recording carries (PMT program number) and the learned per-channel map |
| `ts.go` | transport-stream alignment, keyframe and live-edge scanning |
| `server.go` | HTTP routing, `/api/state`, `/api/health`, `/api/log`, `/api/pvr`, `/api/cmd`, request logging, guide LCN shifting and programme-icon stripping |
| `cmd.go` | command queue between daemon and page (`/api/next`, `/api/report`) |
| `m3u.go` | `playlist.m3u` for IPTV importers (VLC, TVHeadend), XMLTV id lookup |
| `tvhapi.go` | read-only TVHeadend-compatible API (phase 6) |
| `radio.go` | recognising audio-only services, which the box cannot record |
| `guide.go` | EPG: fetch, cache, status, refresh timer, CA bundle |
| `cities.go` | the 51-city XMLTV table |
| `config.go` | config struct, defaults, validation, atomic save |
| `ntp.go` | SNTP query and clock stepping |
| `inifile.go` | reading/writing `homepage_url` in the vendor INI |
| `log.go` | size-rotating logger |
| `stop.go` | `-stop`: pidfile, or `/proc` fallback |
| `net.go` | finding the box's IPv4 |

Not compiled in: everything that is not Go — `build.sh`,
`build.ps1`, `go.mod`, `assets/` (UI and default config), `boot/` (the shell hook).

Reading order for someone new to the codebase: `main.go` → `server.go` → `hdhr.go`. Those are the
spine; the rest are leaves. Only the standard library is used, deliberately: it cross-compiles to a
static ARM binary and stays auditable.

## Stream resilience

The daemon cannot ask the box which file a recorder writes, so it identifies it,
verifies it and owns its teardown:

- **Identification** — a start completes under the start lock: snapshot the PVR
  directory, start, then adopt the file that *grows*. The file is claimed until
  its stream is registered, so two starts can never adopt the same file.
- **Verification** — the recording's PMT names the service actually recorded;
  the program number is learned per channel (`state/programs-pmt.json`) and every
  later start is checked against it. A mismatch is rejected, never served. Values
  are only learned from a file this start created.
- **Handle ownership** — vendor handles are recycled immediately. Every
  successful start claims its handle for its record id; a stop for a record that
  no longer owns the handle is never sent, and each record is stopped once.
- **Stall recovery** — 2 s without new data restarts the recorder for the same
  channel; 25 s without data drops the connection.
- **Health** — `/api/health` fails if the stream lock is stuck, so a wedged daemon
  is not reported as healthy.

**Tuner slots.** `/tuner<N>/v<lcn>` (N = 0-2) is one viewer: a new request on a
slot replaces the stream that slot holds - a player changing channel says so
explicitly instead of the daemon waiting for the old connection to close. Same
channel again hands the running recording over (instant); another channel ends the
old stream first so its tuner is free. Only the client that holds a slot can
replace it; another machine on a busy slot is served from the pool. `/auto/v<lcn>`
is the pooled path (any free tuner, no replacement) and is what `lineup.json`
advertises, because a media server opens several streams at once.
`/playlist.m3u?tuner=N` puts every entry on slot N (default 0), `?tuner=auto` on
the pool - e.g. one TVHeadend IPTV network per slot, each with max streams 1.
`/api/state` lists occupied `slots`.

TL;DR:
| App | URL | Why |
|---|---|---|
| VLC | http://<ip>:8080/playlist.m3u | The playlist stream URLs will be 'locked' to a tuner. When changing streams, HDFR will recognises the current stream should stop then start the next. |
| | or http://<ip>:8080/playlist.m3u?tuner=1 (values 0-2) | This just maipulates which 'tuner' is in the playlist URLs. We can't really lock to a tuner, it's out of our hands. It's really just optimises the freeing of previously used tuners |
| Jellyfin | http://<ip>:8080 | Add it as an HDHomeRun Tuner. Jellyfin will get a 'lineup.json' file, and HDFR will try and auto-allocate tuners as best it can. |
| TVHeadEnd | TBA | This was proving problematic so it has been parked for now but work will continue. It could work, who knows. |

`warm_seconds` (config) keeps a recorder running after the viewer leaves. With
handle ownership fixed it is not needed for clean switching (20/20 measured with
it at 0 and at 10); it only makes switching *back* to the previous channel
instant, at the cost of a tuner. EXPERIMENTAL. Don't use it.

## TVHeadend-compatible API (phase 6)

Kind of. Unfinshed. It's parked at the moment. 
A read-only subset of TVH's HTTP API, so a TVH-native client can be pointed
straight at HDFR instead of at a TVH instance. **No authentication and no
`/comet/events`** — that is a deliberate scope decision, not an omission.

| Endpoint | Returns |
|---|---|
| `/api/serverinfo` | `api_version: 20`, name `HDFR`, `sw_version: hdfr-<build>` |
| `/api/channel/grid` | one entry per streamable channel: `uuid` (md5 of the LCN), `name`, `number` = LCN, `services`, `epggrab` |
| `/api/epg/events/grid` | XMLTV programmes as TVH events: `eventId`, `channelUuid`, `channelNumber`, `start`, `stop`, `title`, `description`, `image`, `nextEventId` |
| `/stream/channel/<uuid>` | MPEG-TS from the pool, served by the same path as `/auto/v<lcn>` |
| `/api/dvr/entry/grid` | always empty — HDFR does not record |
| `/api/status/subscriptions` | the live streams, which is what TVH's Status page shows |

Notes that matter operationally:

- **The uuid is a contract.** It is `md5("hdfr:<lcn>")`, so it is stable across
  restarts; clients cache channel and EPG state against it. Changing the scheme
  would look like every channel vanished.
- **`api_version: 20`** is what TVH 4.3 reports. Clients gate features on it and
  several refuse to connect to anything lower, so the number is part of the
  interface, not a claim about the internals.
- **The EPG is parsed from the same `guide.xml`** the playlist uses, once per
  file change (not per request): ~9 MB, ~1.5 s on the box, ~10 800 programmes.
  The parse is streaming, because the file is much larger than spare memory.
- **Audio-only services are excluded** from the grid, as they are from the
  playlist: the box cannot record them, so advertising them guarantees failures.
- **Every stream starts with PSI.** The recording is joined at a video keyframe,
  and on this box the PAT/PMT can sit ~200 KB further on (~0.4 s). Scanners cope;
  TVHeadend does not — its libav runs with `analyzeduration=0`, decides stream
  parameters from the first packets, reported the audio as `mp3, 0 channels`,
  failed to write a header and dropped the mux with *No input detected*. The
  daemon now writes the recorded PAT/PMT (three repetitions) before the keyframe
  data, so the first packets are self-describing.
- **Channel `number` is the real LCN** (1 = "10", 2 = "ABC TV", 7 = "7 Adelaide"),
  not the LCN+`guide_offset` value used in the M3U `tvg-chno`.

## Hardening (phase 5)

What protects the box from a bad day:

| risk | mitigation |
|---|---|
| A client that stops reading pins a write (and its tuner) forever | streams are written over a hijacked connection with a per-write deadline (`writeTimeout`, 20 s); a silent client is dropped and the tuner released. Measured: released after 25 s |
| The recorder stops writing | `stallTimeout` (60 s) drops the stream and frees the tuner |
| A recording is left behind by a vanished client | registry (`state/active.json`) swept at boot and hourly; files a live stream is reading are skipped |
| A bad build loops the box | boot counter (`/root/boot_count`): three consecutive short boots fall back to stock. Visible in the menu and in `/api/state` |
| HDFR misbehaves and the box is remote | `touch /root/HDFR/DISABLE` forces a stock boot without deleting anything; remove it to come back |
| The daemon cannot be stopped after a deploy | `hdfrd -stop` kills by pidfile *or* by scanning `/proc`, so a replaced binary still holding :8080 is stoppable. The pidfile is written only after the port is bound |
| Logs grow without bound | `hdfrd.log` rotates (`log_max_bytes` × `log_keep`); the hook rotates `daemon.out` at 128 KB; `/api/state` reports `log_bytes` |

Deploying a UI or binary change no longer needs a power cycle: `hdfrd -stop`, copy, restart, then
`curl "/api/cmd?cmd=reload"` to make the page pick up new `app.js`.

## Endpoints

| path | what it is |
|---|---|
| `/discover.json` | HDHomeRun discovery document |
| `/lineup.json` | HDHomeRun channel list (URL = `/auto/v<lcn>`) |
| `/auto/v<lcn>` | any free tuner: lock that channel and stream MPEG-TS |
| `/tuner<N>/v<lcn>` | slot N (0-2): one viewer, a new request replaces the slot's stream |
| `/` | the stream itself, for clients that lock then read the device root (exact path only) |
| `/playlist.m3u` | M3U playlist of every TV channel on slot 0; `?tuner=N` for slot N, `?tuner=auto` for the pool |
| `/guide.xml` | XMLTV guide, `<lcn>` shifted by `guide_offset` |
| `/api/serverinfo`, `/api/channel/grid`, `/api/epg/events/grid` | TVH-compatible read-only API (phase 6) |
| `/ui/` | the on-box TV interface |

`/playlist.m3u` exists because TVHeadend (and similar) cannot see HDFR as an HDHomeRun
device: HDHomeRun discovery is a UDP broadcast on port 65001, while HDFR is HTTP only.
An "IPTV Automatic Network" pointed at the playlist is the supported way in. TVH cannot
fetch XMLTV from a URL itself; its XMLTV grabber runs a command, e.g. a two-line script
that does `curl -fsS http://<box>:8080/guide.xml`. Two details make it bind correctly, and both come
from data HDFR already has:

- `tvg-id` is the XMLTV `<channel id>` read back out of the guide cache, so programmes
  attach to the right service. Channels absent from the guide simply omit the attribute.
- `tvg-chno` is the lineup's `GuideNumber` (LCN + `guide_offset`), matching `/lineup.json`
  and the rewritten `<lcn>`, so channel numbers agree across both interfaces.

Tuner accounting is invisible to these clients: they do not know about the three-tuner
limit or the lock/stream contract, so a fourth simultaneous stream shows up to them as a
tune failure rather than as a clear message. The way round it is one IPTV network per slot
(`playlist.m3u?tuner=0`, `1`, `2`), each limited to one stream, which hands the accounting
to the importer.

Audio-only services are **excluded from `lineup.json`, the playlist and the TVH grid**: the box accepts a
start for them but never writes a file, so every attempt is a guaranteed failure. A direct
request for one returns `403 audio-only channel` immediately. The box exposes no service
type, so `radio.go` combines two signals:

- **Learned, works anywhere:** a start that is accepted but records nothing *while another
  channel on the same multiplex is recording* proves the tuner is fine and the service is
  not recordable. The channel is saved in `state/audio-only.json` (delete it to forget, e.g.
  after a rescan). The first such request fails once; every later one is refused at once.
- **Names, before the first try:** config `radio_names`, matched as whole words,
  case-insensitively. Absent means the built-in list (Australian radio networks: `radio`,
  `triple j`, `abc classic`, `rn`, ...); set your own words for another region, or `[]` to rely
  on learning alone.


Two behaviours make concurrent scanning work better:

- **Queue for a tuner** (`tunerWait`, 25 s) rather than refusing with 503 the moment all
  three are busy — a scanner that waits succeeds.
- **Serialise and retry starts**: the page processes one recorder command at a time, and
  the box answers `h=-1` / `no file appeared` while the previous recording is still
  closing, so starts are taken under a mutex and retried up to three times.

### Warm recordings (`warm_seconds`)

EXPERIMENTAL. Don't use it. Also, don't let me tell you what to do.
The box needs ~4–5 s to create a recording after being asked, and IPTV scanners allow a
mux only ~5 s, so a cold first request is a coin flip. After the last viewer leaves, the
recorder is therefore left running for `warm_seconds` (default 90, `0` disables; this box
runs with `0`), and a repeat request for the same channel is answered from the live edge
immediately:

```
cold v7:  5.4 s to first byte
warm v7:  0.0 s
```

One warm stream is kept at a time (`warmCap`). A new start that needs the tuner reclaims
the warm one instead of making the client wait, warm streams are hidden from the
"Tuned channels" list because nobody is watching them, and they are stopped on shutdown —
a warm recorder has no streaming handler to notice the process leaving, and an orphaned
recorder keeps writing until the box reboots.

Measured after both changes: six simultaneous probes on six channels all return
`200` with real TS, spread over 18 s, and the tuner count returns to zero afterwards.

Warm recordings were later found not to be needed for clean switching: the "slow start after
a stop" they worked around was the recycled-handle bug (see *Stream resilience*). They now only
make switching *back* to the previous channel instant, at the cost of a tuner.

## Thumbnails (parked)

Jellyfin accepts per-channel and per-programme images from XMLTV (`<icon>`, `<image type="still">`),
and channel logos already come through from the feed. The feed's we are using has prgramme icons that 
point at URLs that do not resolve for me, causing Jellyfin to wait ~100 s on each fetch and guide
refreshes would take an age. Our `/guide.xml` strips programme `<icon>`s (channel logos are kept, the cached file is
untouched) and the TVH API sends no `image`. Generating stills was investigated and parked:

- `Ag_localPlayer_generateThumbnail` exists on the bridge (arity 1) but returns `-1` for every
  argument shape tried — relative path, absolute path, offsets, even bare handles — and
  `Ag_localPlayer_getThumbnail` likewise. It appears to require media loaded through `localPlayer`,
  which this page never uses (live TV goes through `Ag_dvb`), and no caller exists anywhere under
  `/webpage` to learn the real contract from.
- RDK's `org.rdk.ScreenCapture` is referenced in the vendor bundle but unreachable: `$badger`,
  `ThunderJS` and `webapis` are all undefined in our page; only the `Ag_*` bridge is exposed.
- `ecmax_localPlayer_generateThumbnailFromVideo` (the native name behind the wrappers) is not exposed
  either: the bridge has 697 members and **none** begin with `ecmax_`, and no `*FromVideo` variant
  exists. It is also absent from `/webpage`. Reaching it would mean calling into the vendor's native
  library from outside its process — code injection rather than a feature, on a box with a watchdog.
- The remaining route is ffmpeg off-box against a tuner stream: it costs a tuner plus a helper
  process, so it stays parked until there is a reason to spend either.

Also checked: `VideoCodec: "none"` is **not** a supported lineup flag. `HdHomerunHost` copies codecs
from the lineup but hardcodes `ChannelType = ChannelType.TV`, so radio channels cannot be marked
audio-only that way (M3U tuners get `ChannelType.Radio` from `radio="true"`; HDHomeRun has no
equivalent). Radio is therefore a capture-time filter, not a lineup flag.

## Auditing this

For someone reviewing what runs on their box:

- **What starts**: `/usr/local/bin/nxserver/nxserver` (a small shell wrapper) either points
  `homepage_url` at HDFR and starts `hdfrd`, or restores the stock page and boots normally.
  `nxserver.real` is always exec'd, so the vendor stack is never bypassed.
- **What listens**: one HTTP server on `:8080` (tuner surface, UI, guide) and, unless `debug` is
  `false`, a telnet shell on `:2323` for recovery. No authentication on either — LAN only.
- **What it writes**: `$ROOT` (`/root/HDFR`: binary, UI, config, logs, guide cache, state),
  `/root/yx_config_user.ini` (one key), `/root/boot_count`, `/root/hdfrd-boot.log`, and
  recordings under `/mnt/usb1/PVR` (removed through the vendor PVR index when the stream ends).
- **What it reads**: its own config, the box's channel list via the page, and the recorder's files.
- **How to remove it**: `boot/uninstall.sh` restores the vendor launcher and deletes `$ROOT`;
  `hdfrd -restore` puts `homepage_url` back.
