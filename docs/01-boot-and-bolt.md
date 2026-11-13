# 01 — Boot chain and the BOLT bootloader

Everything here was observed on a retail **Fetch TV Mighty** (Hybroad **M616T**,
BCM7252S) over its serial debug header. Claims are labelled:

| Label | Meaning |
|---|---|
| **verified** | Reproduced on hardware, output captured |
| **reported** | Documented elsewhere or printed by the device, not independently reproduced here |
| **untested** | Present, but not exercised |

## 1.1 Serial console

The debug header is silkscreened **RS232** and is **not** RS232 — it is 3.3 V TTL
at **115200 8-N-1, no flow control**. Driving it with a real ±12 V RS232 port
will damage the SoC.

This work was performed using a BusPirate 3.2 in UART mode. Other UART-to-USB console devices exist.
I soldered pin headers for ease but this is not needed.

- Header **P11**, four unmarked pins. 
- Use a USB-to-TTL adapter. Connect **GND and the crossed data pair only** —
  leave the adapter's VCC pin unconnected.
- Adjacent header **P12** is marked **BSS** and is unidentified. Same footprint,
  possibly a second UART. (**untested**).
- Console device is **uart0** (a 16550-compatible DUART at `0xf040a900`), and the
  loader's environment carries `BOOT_CONSOLE uart0`.

![UART Image](images/Console%20Connection.png)

## 1.2 Boot chain

`BBL v2.0.0` → `BFW v4.2.5` → `SSBL` → `BOLT v1.29` (local build 2019-05-28,
`BOLT_VERSION 1.29.2685`, BSP 4.2.5, SHMOO 2.1.1.0).

Secure boot is **enabled** and the chain is verified:

```
OTP Sec Boot 0x00000001
SSBL verify key 1 OK
BFW key3 OK
MICH: disable success
SEC: jtag debug status: 000000af      <- JTAG locked
```

Practical consequences:

- The boot ROM is not modifiable, and any rootfs/kernel image that is not signed
  with the vendor key is rejected at power-on. Nothing you write to flash
  survives.
- JTAG is fused off.

Useful loader environment (from `printenv`):

```
RUNLEVEL        1
BOOT_CONSOLE    uart0
KERNEL          0
ROOTFS          0
KERNEL0VERSION  3.7.12096
KERNEL1VERSION  3.7.12051
MEMCONFIG       vmalloc=380m bmem=768m@1279m bmem=970m@2099m
DT_ADDRESS      0x7618000
```

Boot device is eMMC, 3776 MB, with `MEMORYSIZE 3072` (3 GB).

Each boot prints `RR:0000xxxx` — the reset-reason word. `RR:00000001` is a cold
boot; a value that changes on later cycles (commonly `RR:00000040`) means a
watchdog reset, i.e. userspace died after hand-off, not the loader.

## 1.3 Interrupting the autoboot

1. When powered on the box will print diagnostic information via the UART.
2. When timed correctly, spamming CTRL-C will print one line
   `********** Automatic startup canceled via Ctrl-C **********` - note the box
   is still booting, keep spamming CTRL-C until the message `Starting HYBROAD M616T`.
3. An unlock code must now be entered to drop to the BOLT console. Normal booting
   will resume if this code is not entered in about 30 seconds. Echo is disabled.

This following procedure proved reliable to obtain a BOLT console:

1. Connect to the UART with the box powered off.
2. Turn on the box.
3. Wait for the first byte of boot output.
4. From that byte, spam `Ctrl-C` (~5 per second) and **keep going** past the
   cancel banner until `Starting HYBROAD M616T` has printed.
5. Wait for ~1.5 s of line silence — the loader is still working while it prints,
   and keys sent into that output are discarded.
6. Send the unlock code `28392221221` and Enter. This build also accepted
   commands without the code — try `help` first.
7. `BOLT> ` answers. A bare `\r` also produces it, which is the cheapest way to
   find out whether the prompt is alive or the box is wedged.

`tools/bolt_console.py` implements exactly this, with the timing logic driven by
output rather than a clock:

```console
$ pip install pyserial
$ ./bolt_console.py --port /dev/ttyUSB0
```

It waits for the first byte, interrupts through the model line, unlocks on line
quiet, then hands over a raw console (quit with `Ctrl-]`). `--command printenv`
runs one command and exits; `--log boot.log` keeps the raw session. It also
reopens the port if the adapter disappears mid-boot.

Reported-but-unverified boot shortcuts (confirm against your own capture before
relying on them): `Ctrl-E` disable Ethernet, `Ctrl-I` force system init,
`Ctrl-S` disable splash, `Ctrl-U` USB manual mode.

## 1.4 The BOLT command surface

`help` on this build lists:

```
batch boards boot coap crc d dir dt e ephycfg erase example f flash gisb go
help ifconfig incenv info load loop memtest memwrap mii osd ping printenv
reboot rlogin rmem rpmb rts save secureload set setenv seteth0mac setrunlevel
sha show sleep ssdp t tcp testenv time ttcp u uncache unsetenv usb waitusb
```

Comments:

| Command | What it actually does |
|---|---|
| `printenv` / `setenv` / `unsetenv` | Loader environment. `setenv -p NAME VALUE` writes it to NVRAM (`-ro` implies `-p`); there is no `saveenv`. |
| `show devices` | Partition table and device names (`flash0.*`, `usbdisk0`, `tcpconsole*`). |
| `d` / `t` | Memory dump / memory test. |
| `crc` / `sha` | Checksum a memory region. `crc -offset=… -size=…` is plain zlib CRC32 and matches `zlib.crc32()` on a host. |
| `load` | flash or FAT → memory. `-raw -elf -zimg -tftp -fatfs`, arbitrary `-addr`. Its exit status is the **byte count loaded**. |
| `save` | memory → **TFTP** (`save host:file addr len`). There is no FAT write command, so USB is read-only ingress and TFTP is the only egress. |
| `flash` | flash → memory, or flash → flash copy. |
| `go [addr]` | Jump to code already in memory. **No signature check** (1.6). |
| `batch` | Load and run a loader script from `-fatfs` / `-tftp`. |
| `boot` | Boot an image, optionally with a kernel command line (1.7). |
| `secureload` | Verify/decrypt signed containers. Aiming it at a partition that is not a signed container **wedges the loader** — no echo, no prompt, power-cycle only. |
| `ifconfig` / `seteth0mac` / `ping` | Networking (1.5). |
| `dt` | Live device tree: `dt show <path>`, `dt add prop`, `dt del prop`. |
| `usb` / `waitusb` / `dir` | USB host. `dir` reads **FAT/FAT32 only**; the rootfs is ext4, so `dir flash0.root0` is not usable. |
| `memtest`, `ephycfg`, `mii`, `coap`, `ssdp`, `rlogin`, `rpmb` | Present; not used here. |

`info` confirms what the build was compiled with:
`USB: STACK 1; ETH 1; DISK 1; SERIAL 1; HID 1`, `FS: FAT 1; FAT32 1`,
`LDR: ELF 1; RAW 1; SREC 1; ZIMG 1`.

## 1.5 Networking from the loader

- The interface comes up with MAC `00-00-00-00-00-00` even though
  `ETH0_HWADDR` is set. Nothing will ARP until you set it:
  `seteth0mac 000000000000` wants **12 hex characters, no separators** and
  rejects colons. `ifconfig eth0 -hwaddr=aa:bb:cc:dd:ee:ff` does accept them.
- Prefer static configuration:
  `ifconfig eth0 -addr=192.0.2.10 -mask=255.255.255.0 -gw=192.0.2.1`.
  `ifconfig eth0 -auto` (DHCP) negotiated 1000/full and then **hung the
  bootloader** in my tests (YMMV).
- The link takes ~3 s to train after `ifconfig`; verify with `ping <gateway>`
  before starting a TFTP transfer.
- TFTP is UDP/69 with no port argument.

## 1.6 Unsigned code execution via `load` + `go`

`go` is documented as "start a previously loaded program" and performs **no
signature check**, despite OTP secure boot being enabled. Verified with a
164-byte hand-assembled ARM stub that writes a string to the uart0 THR:

```
BOLT> load -raw -tftp 192.0.2.2:payload.bin -addr=0x10000000
BOLT> crc -offset=0x10000000 -size=0xa4
BOLT> go 0x10000000
Closing network 'eth0'
Starting program at 0x10000000 (DTB @ 0x7618000)
32 bit direct boot...
```

Details that matter when writing such a payload:

- The loader switches to **32-bit direct boot**, announces the **DTB address**
  (`DT_ADDRESS`, `0x7618000`) and **closes eth0** first — pass `-noclose` to keep
  the network up.
- Code runs ARM32 with BOLT's MMU still enabled, in the same execution context
  its own `printf` uses, so the UART at `0xf040a900` is writable exactly as the
  loader writes it.
- Verify the transfer before jumping: `load`'s status is the byte count, and
  `crc` over the same region should match `zlib.crc32()` of the host file.
  A `load` that stops early leaves stale RAM past the partial read and still
  writes a full-length file.

The practical angle is therefore not reflashing: it is that the UART plus the
unlock code gives arbitrary code execution on every boot, in RAM, with the
loader's own view of flash.

## 1.7 Kernel command line: `boot` substitutes, it does not append

### Getting a root shell from the loader

`rdinit=/bin/sh` is **verified** on this build — it replaces PID 1 and drops to
`sh-3.2#` as `uid=0(root)`, skipping `rcS` and its mount loop entirely:

```
BOLT> boot flash0.kernel0 "console=ttyS0,115200n8 rdinit=/bin/sh vmalloc=380m bmem=768m@1279m bmem=970m@2099m"
```

Two things to know in that shell:

- `PATH` is minimal. `export PATH=/sbin:/usr/sbin:/bin:/usr/bin:<vendor>/bin`
  first, or `ifconfig` and `grep` are "command not found". Busybox `ip` works
  without the fix.
- `Ctrl-C` cannot interrupt `rcS`: PID 1 has no controlling terminal, so the
  byte goes nowhere. Change the boot parameters instead of pressing keys.
- The network is **down** in this shell (`rcS` is the only thing that brings it
  up), and there is no default route unless you add one.

## 1.8 Dumping flash

`save` reads **memory**, not flash, so each region is a three-step cycle. This
pipeline pulled the whole 3776 MB in 25 chunks with every host CRC matching the
CRC the loader computed over the same range:

```
BOLT> load -raw flash0.root0 -addr=0x10000000 -offset=0x0 -max=0x10000000
      3342336 bytes read
BOLT> crc -offset=0x10000000 -size=0x10000000
BOLT> save 192.0.2.2:root0_00.bin 0x10000000 0x10000000
```

- **`-max` is mandatory.** Without it `load` stops partway with
  "Failed … Invalid parameter" (status -8) and leaves stale RAM past the read.
- Chunk at 256 MB (`0x10000000`); there is about 2.8 GB of free RAM above the
  loader.
- `crc` is zlib CRC32 over the region you specify — compare it to
  `zlib.crc32()` of the received file. **Hash the same byte count on both
  sides**; comparing a 1 MB device read against a 256 KB host read mismatches on
  every partition and looks exactly like catastrophic corruption.
- `flash0.nvram` (4 MB) holds the environment as plaintext `NAME=VALUE`
  strings, so re-dumping it confirms any `setenv` write.

## 1.9 What persists, and what does not

- **`setenv -p NAME VALUE` works.** Verified end to end: the variable
  survives a power cycle and `unsetenv NAME` removes it.
- Anything written to flash unsigned is rejected at the next power-on. A
  custom kernel from USB is blocked by the RSA check, which prints
  `RSA verify successful!` / `Verify Ok.` before executing.

## 1.10 Cautions

- `secureload -verify` run against a partition that is not a signed container
  **wedges BOLT**. It prints the first two header words it read, then stops
  responding.
- Writing eMMC boot partitions (`mmcblk0boot0` / `boot1`) requires clearing the
  write protect first (`echo 0 > /sys/block/mmcblk0boot0/force_ro`), or the write
  silently does nothing. **be careful** because a bad write could brick the
  box permanently.
- eMMC RPMB exists and is replay-protected: dump it if you want, but never claim
  it is restorable by writing bytes back.
