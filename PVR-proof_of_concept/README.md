# Example PVR, only using native calls

This is an example PVR, quite functional but incomplete and not pretty.
It is not intended as an "end state" but was used extensively while
working through the analysis.

## Design decisions, AI harness

Although I have tried to make this usable, I DO NOT ADVISE using this.
Much of the build and analysis has been automated and AI driven using the
Hermes Agent with highly permissive controls. As a consequence, many
design criteria have been based on allowing the AI to drive the test/build/deploy/test 
loop - so much so that it had control of the UART, could start a wireshark
capture, had root access to the box via a TELNET console, could
restart the box using a smart plug, and hooks into the application so specific
functions could be tested. 

Consequently there are items that you must be aware of:
- The code is 99.9% AI created. Use at your own risk.
- This PoC opens a Telnet interface with local root on port 2323, no authentication.
- Files are made on the hard drive - many JSON files which the agent uses to debug. There are
processes in place to try and clean these up but be warned
- The app also makes various files for the purpose of rendering the UI, but it tries not to delete anything without warning, and nothing important..
- There are hooks that allow the agent to test functionality in the app. You may not want these.

TL;DR: **Don't use this, it is a proof of concept only.** My hope is it will help 
to encourage one or more proper developers to develop a better long-term solution.

For all I know, it won't even work on your box.

## What this tests
- Live FTA playback including time-shifting (Pause/play/rewind TV)
- TV Guide, downloaded from https://www.xmltv.net once per 24h. Basic "Favourites", logo support, "Rec" to record
- DVB-T Channel Scan
- EIT (Broadcast Guide Info). This is used when you watch Live TV as "Now" and "Next" info. XML guide not used here.
- Recordings list, will try and enumerate old Fetch recordings if they are there. Correct nameing relies on a txt SQL dump and
I really don't know if it exists on all boxes or not. 
- Tracks/marks recordings that have been viewed past 90% (adjustable)
- Automatic deletion of old recordings based on age/view status when disk space gets below a threshold
- Timers (set only from the guide), Series link (only using series info from XML, if available)
- Just because, it'll provide a HTTP web interface on port 8081 if you give it the web server binary.
This will allow you to download the recorded programs, noting that long programs may use
multiple files and these are not concatenated here.

## What it doesn't do
- No display resolution adjustment. Have not looked into this at all. The UI probably won't scale.
- No standby/power off.
- No hardware timers - it must be powered up to support timer recordings
- Probably lots of other things you might expect a proper PVR to do. This is a PoC.

## What you need

- A retail M616T with the stock firmware intact (secure boot stays untouched — nothing
  here modifies the kernel or rootfs image, only userspace files).
- Access to the BOLT CLI.
- **One FAT32 USB stick** for the payload — call it the *stick* below. It stays plugged
  in permanently; it is not the recordings disk.
- A CA bundle - tested with https://curl.se/docs/caextract.html
- The files mentioned in the table below
- (optionally) `darkhttpd` built from https://github.com/emikulic/darkhttpd

## What goes where

On the box, exactly **one** file is installed — the wrapper. Everything else is read
from the stick at every boot, so changing the TV UI means editing the stick and
rebooting, never remounting `/usr`.

| Path | Where | Required | What it is |
|---|---|---|---|
| `/usr/local/bin/nxserver/nxserver` | box | yes | the wrapper (launcher) — the only installed file |
| `/usr/local/bin/nxserver/nxserver.real` | box | yes | the stock binary, **renamed** (it already exists on any box, as `nxserver`) |
| `<stick>/hermes_enable` | stick | yes | empty marker file; without it nothing is patched |
| `<stick>/patch-fta.sh` | stick | yes | boot patcher: clock step, SUI patches, harness injection |
| `<stick>/hermes_pvrui.js` | stick | yes | the TV harness (the file in `harness/`, same name on the stick) |
| `<stick>/ca-bundle.pem` | stick | yes | modern CA bundle; the firmware has no usable store |
| `<stick>/xmltv-refresh.sh` | stick | yes | guide fetcher, loops every 5 minutes |
| `<stick>/xmltv-build.sh` | stick | yes | XML → guide reducer, called by the fetcher |
| `<stick>/recweb.sh` | stick | no | builds the recordings page |
| `<stick>/darkhttpd` | stick | no | static ARM web server (build it yourself, see below) |

Runtime state — settings, timers, the viewed map, guide cache, logs — is created under
`/root` on first boot. Do not copy those from another box.

The stick is identified by the marker file, and must be a **real USB device**
(`/dev/sd[b-z]`). The recordings disk is `sda` and is ignored deliberately: putting
`hermes_enable` on the PVR disk does nothing.

## Step 1 — prepare the stick

1. Format FAT32, label it anything.
2. Copy the files from the table above to the **root** of the stick.
3. Create an empty file `hermes_enable`.
4. (AI Comment here, I can't vouch for it) If you edited any script in a Windows editor,
   convert line endings to **LF**. A CRLF shell script fails on the first line and the
   box boots stock, which looks like the install did nothing.
6. `sync`, then unplug it cleanly.

## Step 2 — put the wrapper on the box

At the BOLT prompt you need a root shell with the eMMC's `/usr` writable. Two ways in,
either is fine:

- load and run the small payload to drop into an initramfs shell, or
- boot the kernel with `rdinit=/bin/sh`. This is covered elsewhere in this repo.

Then it is a copy, a rename and a sync. Adjust the mount paths to whatever your shell
gives you; the shape is:

```sh
mkdir -p /mnt/usr
mount -o rw /dev/mmcblk0p9 /mnt/usr          # the eMMC partition that holds /usr
mount /dev/sdb1 /mnt/stick                    # the payload stick

N=/mnt/usr/local/bin/nxserver
# keep the stock binary the first time only - never overwrite an existing nxserver.real
[ -f "$N/nxserver.real" ] || cp "$N/nxserver" "$N/nxserver.real"

cp /mnt/stick/nxserver-wrapper.sh "$N/nxserver"
chmod 755 "$N/nxserver"
sync
```

`nxserver.real` is the vendor's middleware and is what actually runs the app. The
wrapper only starts telnet, applies the patch from the stick and then `exec`s it.

Nothing else is written to the box. No files are deleted from `/usr`.

## Step 3 — first boot

Power-cycle (a full power cycle, not a soft reboot). Within about 30 seconds you should
be able to:

```sh
telnet <box-ip> 2323
```

Then check that the boot did what it should:

```sh
cat /root/hermes_boot.log
```

Expect a sequence like this — telnet is started first, always, so a broken boot cannot lock you
out:

```
00:00:18 boot: telnet on 2323
00:00:21 payload stick at /mnt/usb2
00:00:21 ca bundle: /mnt/usb2/ca-bundle.pem
08:56:30 patch-fta: ran /mnt/usb2/patch-fta.sh
08:56:30 guide refresher started
08:56:30 recordings page: enabled on 8081
08:56:30 starting nxserver.real
```

and that the patches landed:

```sh
tail /root/fta-patch.log
```

```
usb gate: enable=1 mount=/mnt/usb2
patched classes.bundle.js
forced local SUI in internet_test_redirect.html
injected hermes_pvrui.js into index.htm
launcher replaced with the local SUI
```

On the TV you will get the local SUI with the harness menu. Two first-run jobs:

- **Channel scan.** Menu → Rec Settings → Rescan channels. Takes about 3 minutes and
  must be done once per box: a box with no channels shows a black screen because the
  app's own UI never finishes initialising.
- **Guide.** Guide Settings → Guide city and Time zone. The guide feed is per city; the
  time zone only affects display, never when recordings fire.

## Step 4 (optional) — the download page

Port 80 belongs to the middleware and cannot be shared, so the page runs on **8081**
from `darkhttpd`:

```sh
git clone https://github.com/emikulic/darkhttpd
cc -O2 -o darkhttpd darkhttpd.c        # cross-compile for ARMv7 if you build elsewhere
```

Put the resulting binary on the stick with `recweb.sh` and the wrapper enables the page
automatically. It serves `/mnt/usb1` read-only: `http://<box-ip>:8081/` lists every
recording with a play link (an `.m3u` over the file's parts) and a save link.

Titles come from `/root/hermes_rec_titles.txt`, which is per box — it is generated from
that box's own middleware SQL dump. Without it the page lists recordings by number
instead of name, which is harmless.

Do not add delete buttons to that page: deletion has to go through the TV UI so the
middleware's index stays in step with the files on disk.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Box boots stock, no harness | stick missing, unreadable, or no `hermes_enable` | check `hermes_boot.log`; the line reads `no payload stick found` |
| Patch log says `usb gate: enable=0` | marker file absent, or the stick is on `sda` | marker must be on the USB stick, not the PVR disk |
| Black screen after boot | channel list empty | telnet in, then Menu → Rescan channels |
| Scripts "not found" but files are there | CRLF line endings | convert to LF, `sync` |
| Harness injects but the screen stays stock | SUI patch did not match this firmware | compare `classes.bundle.js` against the strings the patcher expects |
| Four boots in a row | harness crash loop | the patcher drops the harness after 3 consecutive boots; delete or fix the stick copy |

Two safety valves are built in: telnet starts before anything else, and after three
consecutive boots the patcher stops injecting the harness (`SAFE MODE` in the patch
log), so a bad harness cannot leave a box you cannot get into.

## Reverting

- Boot stock: remove `hermes_enable` from the stick (or pull the stick).
- Remove entirely: delete `/usr/local/bin/nxserver/nxserver` and rename
  `nxserver.real` back to `nxserver`. Reboot. The box is stock again.
