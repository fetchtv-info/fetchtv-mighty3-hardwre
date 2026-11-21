# HDFetchRun (HDFR)

Turns a FetchTV M616T set-top box into a tuner Jellyfin can see as an HDHomeRun, with a
minimal on-box UI driven by the retail remote (only used for setup). You will need to set
up with the STB connected to a TV so that setup and TV scanning can be performed and you can
confirm basic functionality. After that it's just a basic TV tuner (up/down for channel change).

The remaining three tuners can be accessed by Jellyfin over the network.

Jellyfin discovers the box as an HDHomeRun, lists all channels, and plays them. Three concurrent
streams are allowed and a fourth is refused. HDFR also serves its own XMLTV that Jellyfin uses
for the guide. 

## Design notes

This behaviour has been tested on Jellyfin 12.2 and may not (probably doesn't) properly emulate
an authentic HDHomeRun device. 

No transcoding is performed on the M616T, the stream is sent as-is.

The HDHR code is written in Go for relative ease of reading and auditing. 

WiFi is not supported.

## HDHomeRun surface

| endpoint | behaviour |
|---|---|
| `/discover.json` | `ModelNumber` `HDHR-4DT` (deliberately not `hdtc`), `TunerCount` 3, `BaseURL`/`LineupURL` built from the request's `Host` |
| `/lineup.json` | the page's channel list as `{GuideNumber, GuideName, URL, HD}`; URL is `http://<host>/tuner0/v<lcn>` |
| `/tuner0/v<lcn>` | starts a recording of that LCN, tails the recorder's `.mpg` and writes chunked `video/mp2t` until the client goes away, then stops the recording and deletes the file |

Measured on the unit: ~750 KB/s (~6 Mbps) per stream, valid TS (1808/1808 packets on 0x47), two
concurrent streams on different channels work (separate handles and files), and the PVR directory
returns to its baseline count after every disconnect. Two clients asking for the **same** channel
share one recording and one tuner (refcounted in `hdhr.go`).

The tail loop only reads and flushes; client loss is detected by the failed write or the request
context, and either way the stop+delete command is queued to the page, which owns the recorder.

Two details that matter in practice:

* **Tuning is a lock, streaming is the root.** A real HDHomeRun locks a tuner at
  `/tunerN/v<ch>` and then streams from the device root, and Jellyfin does exactly that (its
  ffmpeg input is `http://<device>/`). So `/` is the transport stream of the most recently
  locked tuner and the UI lives at `/ui/`. Serving HTML at `/` made ffmpeg fail with exit 187.
* **Streams join at a keyframe.** The recorder starts writing mid-GOP, so the file's first
  bytes are usually undecodable until the next IDR. `ts.go` scans the growing file for a packet
  with the transport-level `random_access_indicator` and starts there; without it HD channels
  took noticeably longer to show a picture.

## Guide

The EPG is HDFR's own: it downloads the XMLTV, stores it under `/root/HDFR/guide/`, refreshes it
on a timer and serves it to the media server. Nothing else has to be running on the box.

| endpoint | behaviour |
|---|---|
| `/guide.xml` | the cached XMLTV with `<lcn>` shifted by `guide_offset`, so guide channels line up with lineups that were renumbered |
| `/api/guide` | cache status: path, size, when it was fetched, last error, whether a refresh is running |
| `/api/guide` (POST) | start a refresh now; the on-box menu's *Refresh guide* item calls this |
| `/api/cities`, `/api/guide/city?name=…` | the built-in city table and the setter the menu's *Guide city* picker uses |

Two operational endpoints:

- `POST /api/device?lcn=N&name=…` — the page reports what the box itself is tuned to;
  `/api/state` returns it as `viewing_lcn`. Only the page can see the vendor tuner, so this is
  self-reported, and it is deliberately *not* counted as a stream.
- `POST /api/release?lcn=N` — cancels a stream handler, which releases the tuner and deletes the
  recording. A media server can leave a tuner open for minutes after the viewer stops (Jellyfin's
  live-TV kill timer), which otherwise occupies one of the three slots.

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
  element, there is an offset of 250 applied that you might not like.. but this avoids existing 
  live streams in my Jellyfin. You will likely need to manually map the channels to the guide in Jellyfin.

## On-box UI

The page (`index.html` + `app.js` + `ui.css`) is the only thing that can drive the tuner: the `Ag_*`
bridge belongs to the webview. It is deliberately empty when idle, because the video plane is
composited *behind* it — anything drawn shows as an overlay on live TV.

| Key | Live TV | Menu |
|---|---|---|
| Up / CH+ | next channel + OSD | move cursor |
| Down / CH- | previous channel + OSD | move cursor |
| OK / Menu | open the menu | activate item |
| Back / Exit | hide the OSD | close the menu |

Menu rows: the Jellyfin URL (taken live from `/api/state`, so it follows the DHCP lease), stored
channel count, **Scan for channels** (asks for confirmation), **Debug harness on/off**, version.
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

1. Starts the development telnet shell on 2323 (ONLY IF NOT DISABLED - toggle in UI)
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

## Building

Built using golang-go 1.22 but 1.21, 1.23 should be fine. No other specific known requirements.
Probably a good idea to read that build script though for path oddities.

```sh
apt install glang-go
./build.sh          # CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7, static, stripped
```
I have also built this on windows using go 1.27.4. Use build.ps1 script. (read it first).

## Install / uninstall

**This is at your own risk**

Step 1: Get a dev shell on the box.
If you know how to use a UART adaptor, you can use the bolt_console.py in the tools folder. You'll need to
open the box up.

If you prefer to not open the box or want another approach, download the fetch_inject.py and payload_persist.js into the same directory.
Power off the set top box, and plug the Ethernet cable directly into an Ethernet cable on your computer.
Configure that Ethernet port to a static IP and remember what it is. Examples use 192.168.50.1 / 255.255.255.0, no gateway or DNS settings needed here.

Test the inject script:
```sh
sudo python3 fetch_inject.py --iface 192.168.50.1 --host-ip 192.168.50.1 --dhcp-range 192.168.50.2-192.168.50.20 --log events.jsonl
```
The box will power up, "Preparing system please wait". If all is working you should see log messages on your console in JSONL format. The first few lines are 
just the config the script is running with.
```sh
{"seq":1,"t_mono_ns":38352454093620,"t_utc":"2026-11-21T08:04:52.223066+00:00","kind":"injection","dry_run":true,"payload":null,"route":null}
{"seq":2,"t_mono_ns":38352460817675,"t_utc":"2026-11-21T08:04:52.229787+00:00","kind":"mode","dhcp":true,"host_ip":"192.168.50.1","broadcast":"192.168.50.255"}
{"seq":3,"t_mono_ns":38352461333530,"t_utc":"2026-11-21T08:04:52.230302+00:00","kind":"ready","dns":"0.0.0.0:53","https":"0.0.0.0:443","dry_run":true}
```
..after some seconds you should see the DHCP and any HTTPS requests
```sh
{"seq":4,"t_mono_ns":38381409402057,"t_utc":"2026-11-21T08:05:21.178375+00:00","kind":"dhcp","client_ip":"0.0.0.0","mac":"0c:56:5c:00:00:00","msgtype":1,"vendor_class":"hybroad"}
{"seq":5,"t_mono_ns":38381409615861,"t_utc":"2026-11-21T08:05:21.178584+00:00","kind":"dhcp_reply","mac":"0c:56:5c:00:00:00","msgtype":2,"offered_ip":"192.168.50.2","dest":"192.168.50.255"}
...
{"seq":16,"t_mono_ns":38389647167443,"t_utc":"2026-11-21T08:05:29.416138+00:00","kind":"dns","client_ip":"192.168.50.2","qname":"mw.fetchtv.com.au","qtype":1,"qclass":1}
{"seq":17,"t_mono_ns":38389652204565,"t_utc":"2026-11-21T08:05:29.421176+00:00","kind":"tls_sni","sni":"mw.fetchtv.com.au"}
{"seq":19,"t_mono_ns":38389678907438,"t_utc":"2026-11-21T08:05:29.447878+00:00","kind":"https","client_ip":"192.168.50.2","sni":"mw.fetchtv.com.au","method":"GET","path":"/v2/releases/prod/203013456778/genx/sui_redirect_nocache.htm","user_agent":"Takin/3.0.0 (Linux arm ; U; en), FetchTV_STB_BCM7252S/3.7.12096 (FetchTV, M616T, Wired)"}
```

In this example I'm going to MITM the sui_redirect_nocache.htm page. 
Break out of the script with CTRL-C, power off the box again. We're going to intercept that web request that has *sui_redirect* in the URL
```sh
sudo python3 fetch_inject.py --iface 192.168.50.1 --host-ip 192.168.50.1 --dhcp-range 192.168.50.2-192.168.50.20 --payload-route '*sui_redirect*' --payload payload_persist.js --log events.jsonl
```
Power the box on again, wait a bit. The script will send the listed payload file. When that runs, that payload will send beacons back to indicate what worked and what happened in the log.
Once/if you get to "stage=done&v=triggered", that's done. You've bricked the box or made a dev telnet shell. I only have a test unit of one so it could go either way.
```sh
{"seq":49,"t_mono_ns":38959021019026,"t_utc":"2026-11-21T08:14:58.789988+00:00","kind":"beacon","client_ip":"192.168.50.2","query":"stage=done&v=triggered"}
```

CTRL-C out of the script. POWER DOWN THE BOX. For ease run the "test" script again so we issue a DHCP address to the box when it comes back up. Then power the box up. It should look
like nothing happened.
See if you can connect via telnet. Yes I know, telnet. There's no sshd that I could find so you get what you're given.
```sh
root@T410:/home/box/HDFetchRun# telnet 192.168.50.2 2323
Trying 192.168.50.2...
Connected to 192.168.50.2.
Escape character is '^]'.

sh-3.2#
```

Stage 2. Put the HDFR files on there.

Files are pushed over HTTP, verified by md5, then installed by a script that remounts `/usr`
read-write only for the file swap:

In the Telnet shell:
```sh
cd /tmp
mkdir hdfr-stage
cd hdfr-stage

# on a host serving hdfr/build artifacts at :8090/dist
wget -O hdfrd http://<host>:8090/dist/hdfrd
wget -O nxserver http://<host>:8090/dist/nxserver
wget -O config.json http://<host>:8090/dist/config.json
wget -O index.html http://<host>:8090/dist/index.html
wget -O app.js http://<host>:8090/dist/app.js
wget -O ca-bundle.pem http://<host>:8090/dist/ca-bundle.pem
wget -O ui.css http://<host>:8090/dist/ui.css
wget -O install.sh http://<host>:8090/dist/install.sh
wget -O uninstall.sh http://<host>:8090/dist/uninstall.sh
sh /tmp/hdfr-stage/install.sh /tmp/hdfr-stage
```

This should look something like:
```sh
...
sh-3.2# wget -O uninstall.sh http://192.168.50.1:8090/dist/uninstall.sh
Connecting to 192.168.50.1:8090 (192.168.50.1:8090)
uninstall.sh         100% |****************************************************************************************************************************************************|  1127   0:00:00 ETA
sh-3.2# ls -l
-rw-r--r--    1 root     root         26607 Jan  1 00:37 app.js
-rw-r--r--    1 root     root        224449 Jan  1 00:39 ca-bundle.pem
-rw-r--r--    1 root     root           278 Jan  1 00:37 config.json
-rw-r--r--    1 root     root       7536800 Jan  1 00:37 hdfrd
-rw-r--r--    1 root     root           651 Jan  1 00:37 index.html
-rw-r--r--    1 root     root          3008 Jan  1 00:43 install.sh
-rw-r--r--    1 root     root          3460 Jan  1 00:37 nxserver
-rw-r--r--    1 root     root          1537 Jan  1 00:38 ui.css
-rw-r--r--    1 root     root          1127 Jan  1 00:43 uninstall.sh
sh-3.2# sh /tmp/hdfr-stage/install.sh /tmp/hdfr-stage
install: config check
hdfrd: homepage_url http://127.0.0.1:8080/ui/ (changed)
hdfrd 0.5.0-phase5-20261121
install: writing boot hook (remount /usr rw)
-rwxr-xr-x    1 root     root          3460 Jan  1 00:43 nxserver
-rwxr-xr-x    1 root     root        860619 Jan  1 00:01 nxserver.real
install: done - power-cycle to boot HDFR
sh-3.2#
```
So now, plug it back into your normal network and power off/on.

`boot/uninstall.sh` restores the vendor launcher, puts `homepage_url` back and removes the tree.

## First start

If there are no channels scanned, it should auto-scan for them. Otherwise pressing Menu will bring up a small menu 

<img width="1721" height="986" alt="HDFetchRun1" src="https://github.com/user-attachments/assets/69c99097-1d1f-4db3-af44-6220dff82725" />

In your Jellyfin server, use the IP and Port displayed in the menu as the Tuner IP Address. Do not enable transcoding as the STB does not support it.
You should also add the STB as the TV Guide Provider - in the example above, that'd be 
```sh
http://10.1.1.126:8080/guide.xml
```

The menu also displays the Channel being viewed on Live TV, as well as what the other tuners are doing (if anything).


## Recovery without a working daemon

telnet 2323 is started by the hook before anything that can fail, so it is always there. Unless it isn't because it's been disabled in the UI.

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

### Source layout

Everything in `hdfr/` is one Go package (`package main`), so **every non-test `.go` file is
compiled into `hdfrd`** — Go has no source manifest and no per-file imports between files in a
package. Add a file and it joins the build; delete one and the build breaks wherever it was used.

| file | what it does |
|---|---|
| `main.go` | entry point; the `-serve` / `-configure` / `-restore` / `-stop` / `-version` flags |
| `hdhr.go` | HDHomeRun surface: discover, lineup, tuner lock, stream loop, registry, sweep, release |
| `server.go` | HTTP routing, `/api/state`, `/api/log`, `/api/pvr`, request logging, guide id shifting |
| `guide.go` | EPG: fetch, cache, status, refresh timer, CA bundle |
| `config.go` | config struct, defaults, validation, atomic save |
| `ntp.go` | SNTP query and clock stepping |
| `ts.go` | transport-stream alignment, keyframe and live-edge scanning |
| `inifile.go` | reading/writing `homepage_url` in the vendor INI |
| `cmd.go` | command queue between daemon and page (`/api/next`, `/api/report`) |
| `cities.go` | the 51-city XMLTV table |
| `log.go` | size-rotating logger |
| `stop.go` | `-stop`: pidfile, or `/proc` fallback |
| `net.go` | finding the box's IPv4 |

Not compiled in:  everything that is not Go — `build.sh`, `go.mod`, `assets/` (UI and default config), `boot/` (the shell hook)

Reading order for someone new to the codebase: `main.go` → `server.go` → `hdhr.go`. Those are the
spine; the rest are leaves. Only the standard library is used, deliberately: it cross-compiles to a
static ARM binary and stays auditable. Line counts are from the phase 5 build.

## Hardening

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

## Auditing this

For someone reviewing what runs on their box:

- **What starts**: `/usr/local/bin/nxserver/nxserver` (a small shell wrapper) either points
  `homepage_url` at HDFR and starts `hdfrd`, or restores the stock page and boots normally.
  `nxserver.real` is always exec'd, so the vendor stack is never bypassed.
- **What listens**: one HTTP server on `:8080` (tuner surface, UI, guide) and, unless `debug` is
  `false`, a telnet shell on `:2323` for recovery. No authentication on either — LAN only.
- **What it writes**: `$ROOT` (`/root/HDFR`: binary, UI, config, logs, guide cache, state),
  `/root/yx_config_user.ini` (one key), `/root/boot_count`, `/root/hdfrd-boot.log`, and
  recordings under `/mnt/usb1/PVR` (deleted when the stream ends).
- **What it reads**: its own config, the box's channel list via the page, and the recorder's files.
- **How to remove it**: `boot/uninstall.sh` restores the vendor launcher and deletes `$ROOT`;
  `hdfrd -restore` puts `homepage_url` back.
