# Fetch TV Mighty 3 (Hybroad M616T) — hardware notes

Notes from reverse-engineering a retail **Fetch TV Mighty** set-top box, built by
**Hybroad** and labelled **M616T**. The box is a Broadcom BCM7252S (armv7l)
running Linux 4.1.20 with a Chromium-based UI on Broadcom Nexus middleware.

This work is based on firmware 3.7.12096 and BOLT bootloader 1.29.

These notes cover the hardware and firmware surface only. They do not describe
any vendor service, account system or online API — everything documented here
works with the box off the network.

## AI Use Statement
This work has been largely created using AI tooling with Human editing and oversight. Take this into consideration when using this information. 

## What is here

| Document | Contents |
|---|---|
| [docs/01-boot-and-bolt.md](docs/01-boot-and-bolt.md) | Serial console pinout, boot chain, reaching the BOLT bootloader, its command surface, unsigned payload execution, kernel command-line handling, dumping flash |
| [docs/02-storage-and-integrity.md](docs/02-storage-and-integrity.md) | eMMC partition map with offsets and mount points, boot partitions and RPMB, which regions are signature-verified and which are not, the SATA disk and its contents |
| [docs/03-on-box-functions.md](docs/03-on-box-functions.md) | Binaries, the native `Ag_*` JavaScript surface, DVB tuner and EIT, recorder, playback, file I/O, remote key codes, clock and networking quirks — each marked tested or untested |
| [tools/bolt_console.py](tools/bolt_console.py) | Commented Python example: interrupts the autoboot, unlocks the prompt, hands over a console |

## Verification labels

Claims are labelled so you can tell what was reproduced from what was merely
reported:

- **verified** / **works** — reproduced on hardware, output captured
- **reported** — documented elsewhere or printed by the device, not independently reproduced
- **untested** / **present** — the thing exists, but was not exercised
- **dead** — callable and present, but not wired up on this build

Anything not labelled is a description of what the device printed.

## Quick summary

- The debug header is **3.3 V TTL at 115200 8-N-1** despite being silkscreened
  "RS232".
- Secure boot is enabled and JTAG is fused off, but the loader (`BOLT`) executes
  unsigned code from RAM, and its interrupt window is event-driven, not timed.
- The rootfs is a plain ext4 partition with **no boot-time signature check** —
  the vendor only checksums two library directories. The kernel is a signed
  container and will not boot unsigned.
- Nothing on the eMMC or the disk is encrypted at rest. Subscription recordings
  are CA-scrambled inside an otherwise ordinary MPEG-TS; free-to-air recordings
  are clear.
- The box has a fully functional local DVB-T tuner, recorder and player reachable
  from the UI's own JavaScript with no vendor service involved.

## Cautions

- `secureload -verify` against a partition that is not a signed container
  **wedges the bootloader** — power-cycle only.
- Writing the eMMC boot partitions is the one operation that bricks the box
  permanently.
- Some payloads here take the application down and produce a watchdog reboot
  loop. Read document 03's probing advice before calling unknown natives.

## Not covered

Vendor services, account/activation state, remote UI delivery, and anything
requiring the box to be online.

## Licence

MIT — see [LICENSE](LICENSE).

No affiliation with Fetch TV, Hybroad or Broadcom. Product names are used only
to identify the hardware.
