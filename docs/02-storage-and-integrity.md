# 02 — Storage layout, and what is (and is not) verified

## 2.1 How this map was established

Two independent sources agree on the layout:

1. **BOLT's own table** — `show devices` lists each region by name with a start
   offset and size. Partition numbering follows offset order, so the Nth entry
   is `mmcblk0pN`.
2. **The running kernel** — every partition is reachable as a block device from
   the initramfs shell, so each `/dev/mmcblk0pN` can be read directly and
   compared against the image dumped for the matching name.

Sizes alone are ambiguous (several partitions share a size), so the mapping was
confirmed by comparing content. One caveat worth stating plainly: the two 16 MB
partitions (`avail` and `securedata`) are **both entirely zero** on this unit, so
their contents cannot tell them apart. Offset order is what places `avail` at
`p6` and `securedata` at `p13`; a unit with `securedata` in use would settle it
conclusively.

## 2.2 eMMC layout

Boot device is eMMC, 3776 MB (`MEMORYSIZE 3072`).

| # | node | loader name | start offset | size | content | mounted at |
|---|---|---|---|---|---|---|
| 1 | `mmcblk0p1` | `flash0.nvram` | `0x000004400` | 4 MB | plaintext loader environment | — |
| 2 | `mmcblk0p2` | `flash0.nvram_bak` | `0x000404400` | 4 MB | byte-identical copy of p1 | — |
| 3 | `mmcblk0p3` | `flash0.config0` | `0x000804400` | 4 MB | device config, encoded | — |
| 4 | `mmcblk0p4` | `flash0.config1` | `0x000C04400` | 4 MB | byte-identical copy of p3 | — |
| 5 | `mmcblk0p5` | `flash0.devtree` | `0x001004400` | 4 MB | zero-fill (DTB is generated at runtime) | — |
| 6 | `mmcblk0p6` | `flash0.avail` | `0x001404400` | 16 MB | zero-fill | — |
| 7 | `mmcblk0p7` | `flash0.kernel0` | `0x002404400` | 64 MB | signed kernel container | booted by the loader |
| 8 | `mmcblk0p8` | `flash0.kernel1` | `0x006404400` | 64 MB | signed kernel container (A/B) | — |
| 9 | `mmcblk0p9` | `flash0.root0` | `0x00A404400` | 384 MB | ext4, the active rootfs | `/usr` (read-only) |
| 10 | `mmcblk0p10` | `flash0.root1` | `0x022404400` | 384 MB | ext4 (A/B) | — |
| 11 | `mmcblk0p11` | `flash0.roothome` | `0x03A404400` | 256 MB | ext4, persistent data | `/root` (read-write) |
| 12 | `mmcblk0p12` | `flash0.factorytest` | `0x04A404400` | 64 MB | signed container, same header format as the kernels | — |
| 13 | `mmcblk0p13` | `flash0.securedata` | `0x04E404400` | 16 MB | zero-fill on this unit | — |
| 14 | `mmcblk0p14` | `flash0.backup` | `0x04F404400` | 512 MB | zero-fill | — |
| 15 | `mmcblk0p15` | `flash0.Android` | `0x06F404400` | 1996 MB | zero-fill (no Android system present) | — |

Beyond the numbered partitions:

| region | size | content |
|---|---|---|
| `mmcblk0boot0` | 2 MB | the boot chain (BBL / BFW / SSBL) — starts with an ARM branch table (`e9 00 00 06`-style entries) |
| `mmcblk0boot1` | 2 MB | zero-fill |
| `mmcblk0rpmb` | 2 MB | RPMB area, replay-protected |

Notes on individual regions:

- **`nvram` / `nvram_bak`** hold the loader environment as plaintext `NAME=VALUE`
  strings — 19 variables in 4 MB of blank space, including `MEMCONFIG`,
  `KERNEL0VERSION`, `ROOT0FSTYPE`, `BOOTOK` and `BOLT_VERSION`. The backup is a
  **byte-identical mirror**, not a checksum partner: nothing was observed
  comparing the two at boot.
- **`config0` / `config1`** begin with the model string and a 15-digit number,
  followed by key/value data that is **not readable plaintext** (high-bit and
  punctuation bytes, consistent with an in-house substitution or XOR scheme).
  The two copies are byte-identical. The encoding was not identified, and no
  integrity field was located in the partition header.
- **`kernel0` / `kernel1`** share a container header — the first eight bytes are
  `60 5e 59 7e 75 40 58 23` — but the images differ, because the two slots carry
  different builds (`3.7.12096` vs `3.7.12051`). Payload entropy across the first
  4 MB is 8.00 bits/byte, i.e. compressed or encrypted rather than plaintext; the
  loader exposes a separate `secureload -decrypt` command, which suggests
  decryption is part of the boot path.
- **`factorytest`** carries the same container header as the kernels, so it is a
  signed image, not a filesystem.
- **`devtree`** being zero-fill is expected, not corruption: `/chosen` contains
  only `stdout-path`, the device tree is generated at runtime, and `dt add prop`
  / `dt del prop` operate on the live tree.
- About half of the eMMC is zero-fill, so a gzip of a full dump is roughly a
  fifth of its raw size.

## 2.3 Integrity and encryption, per region

Note the use of cryptographic enforcement of some regions.

### Enforced by the boot chain

| region | mechanism | evidence |
|---|---|---|
| ROM / OTP | secure boot enabled, JTAG fused off | `OTP Sec Boot 0x00000001`, `SEC: jtag debug status: 000000af` |
| `boot0` (BBL/BFW/SSBL) | signature chain verified before BOLT runs | `SSBL verify key 1 OK`, `BFW key3 OK` |
| `kernel0` / `kernel1` | signed container; RSA verified before execution | loader prints `RSA verify successful!` / `Verify Ok.` before handing off |
| `factorytest` | same container/signature format | identical header magic to the kernels |

Nothing here is bypassable by reflashing: an unsigned or modified image is
rejected at power-on. The only unsigned-code that worked is loader RAM execution
(`load` + `go`, see document 01).

### Not enforced

| region | mechanism | evidence |
|---|---|---|
| `root0` (`/usr`) | **no boot-time verification** | a file under `/usr/local/bin/` was replaced and the box booted normally |
| `root1` | no verification (A/B slot, not mounted in normal boot) | — |
| `roothome` (`/root`) | none; ext4 mounted read-write | mount options, and contents freely editable |
| `nvram` / `nvram_bak` | plaintext, no hash | the environment is readable as `NAME=VALUE` |
| `avail`, `backup`, `Android`, `devtree`, `boot1` | n/a — zero-fill, no structure | byte scan of each dump |
| `rpmb` | replay-protected by the eMMC, not restorable by copying bytes back | — |

The one userspace check that does exist is narrow. The vendor startup script
runs a `checksums` helper over **two library directories only**:

```
checksums /usr/hybroad/lib  <manifest>
checksums /usr/local/lib    <manifest>
```

Nothing verifies `/usr/local/bin/`, so the application launcher itself is
outside the checked set. That is the gap that makes `/usr` editable in practice
even though the partition ships read-only.

### What is encrypted, and what is not

- **eMMC contents: not encrypted at rest.** The rootfs, roothome and the
  configuration are all readable once the partition is off the device. There is
  no dm-crypt, no LUKS header, and no per-file encryption on any partition.
- **Kernel and factorytest payloads** are compressed or encrypted inside a
  signed container (entropy 8.00 bits/byte), but the signature is what the boot
  chain enforces.
- **`securedata` is unused on this unit** (100% zero across all 16 MB), so this
  dump offers no evidence about what, if anything, a provisioned box stores
  there. Do not assume it holds keys — and do not assume it does not.
- **The SATA disk is not encrypted** — see 2.4.

## 2.4 The SATA disk

The internal 1 TB SATA drive is the box's `/mnt/usb1` (the name is a vendor
choice, not a transport: real USB storage appears as `/mnt/usb2` and enumerates
as `sd[b-z]`).

| property | value |
|---|---|
| interface | `brcm-ahci`, `ata1` |
| filesystem | **XFS** |
| encrypted | no — a plain XFS filesystem, mountable on any Linux host |
| access | mounted read-write by the application |

What is on it:

- `PVR/` — recordings, three files each: `.mpg` (the transport stream), `.nav`
  (navigation index), `.mda` (metadata). Also `.MediaIndexFILE`.
- Plaintext SQL dumps of the recording index and a `data_store` key/value table.
  Likely produced as a backup by the vendor's middleware?
- `dvb.txt` — the scanned service table, JSON: `{"lcn":7,"triplet":"4115:1285:1360"}`
  (LCN plus ONID:TSID:SID), if the box has been used.
- A live Chromium profile for the streaming apps, a Bluetooth HCI snoop log, an
  offline VOD cache, and staged firmware images under `TMP_DOWNLOADS/firmware/`.
- Configuration files that hold the Wi-Fi passphrase and any PPPoE credentials
  **in plaintext**. **This is NOT deleted** when using the vendor's Factory Reset
  option from their menu system. 

So the disk is a credential-bearing disk, not just a recording archive. Treat a
pulled drives accordingly.

### Scrambling inside the recordings

Recordings are ordinary MPEG-TS: a `0x47` sync byte every 188 bytes, with the
usual PID and PES structure. Encryption, where it applies, is **per packet** in
the TS header (`transport_scrambling_control`, bits 6-7 of byte 3), so a
recording can be part clear and part scrambled.

Measured on a free-to-air capture: **12000/12000 packets with sync intact and
`scrambling_control = 0`**, with 100 video PES start codes — i.e. entirely
clear. Recordings of subscription services keep the same framing but carry
scrambled payloads, which can only be decrypted with the box's CA keys; for
those, a `0x47` at offset 0 says nothing about whether the payload is readable.

## 2.5 Re-verifying this yourself

From an initramfs shell (`rdinit=/bin/sh`, see document 01), with the partitions
not mounted:

```sh
# what the kernel thinks the partitions are
cat /proc/partitions

# confirm a name-to-node mapping by content, not by size: hash a fixed prefix
# of BOTH sides and compare — a 1 MB device read against a 256 KB host read
# mismatches on every partition and looks like corruption
dd if=/dev/mmcblk0p9 bs=1M count=1 2>/dev/null | md5sum

# filesystem identity
dumpe2fs -h /dev/mmcblk0p9 2>/dev/null | head        # ext4 UUID, features
```
