#!/usr/bin/env python3
"""Interactive FetchTV BOLT launcher + console.

Prompts, waits for you to press Enter (you control the timing from your
keyboard), spams Ctrl-C across the autoboot window, sends the
unlock code, then hands you a live console.

  ~/uart-venv/bin/python bolt_console.py
  ~/uart-venv/bin/python bolt_console.py --spam-secs 20 --code 28392221221
  ~/uart-venv/bin/python bolt_console.py --no-code          # prompt may be unlocked

Quit the console with Ctrl-] (then Enter if your terminal needs it).
Everything is logged to --log (raw bytes) so it can be replayed later.
"""
import argparse
import os
import select
import sys
import time

import serial

CTRL_C = b"\x03"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--spam-secs", type=float, default=15.0)
    ap.add_argument("--spam-every", type=float, default=0.05)
    ap.add_argument("--code", default="28392221221")
    ap.add_argument("--no-code", action="store_true")
    ap.add_argument("--cmd", action="append", default=[],
                    help="command(s) to send after the unlock code, before handing over")
    ap.add_argument("--log", default=None)
    args = ap.parse_args()

    if args.log:
      log_path = args.log
      os.makedirs(os.path.dirname(log_path), exist_ok=True)
      log = open(log_path, "wb", buffering=0)
    else:
      log = open(os.devnull, "wb", buffering=0)

    ser = serial.Serial(args.port, args.baud, timeout=0.05,
                        rtscts=False, dsrdtr=False, xonxoff=False)

    print(f"port   : {args.port} @ {args.baud} 8N1")
    print(f"log    : {log_path}")
    print()
    print("1. Power off the box now and wait 3 s.")
    print("2. Press ENTER here and then power the box back on.")
    print()
    try:
        input(">>> press ENTER now to start the Ctrl-C window: ")
    except KeyboardInterrupt:
        print("\ncancelled")
        return 1

    t0 = time.monotonic()
    print(f"spamming Ctrl-C for {args.spam_secs:.0f}s ...", flush=True)
    seen = b""
    n = 0
    while time.monotonic() - t0 < args.spam_secs:
        ser.write(CTRL_C)
        ser.flush()
        n += 1
        # drain + show whatever the box is saying
        chunk = ser.read(8192)
        if chunk:
            log.write(chunk)
            seen += chunk
            sys.stdout.buffer.write(chunk)
            sys.stdout.flush()
        time.sleep(args.spam_every)
    print(f"\n[{n} Ctrl-C sent]", flush=True)

    if b"canceled via Ctrl-C" in seen:
        print("[autoboot canceled -- good]", flush=True)
    else:
        print("[WARNING: never saw the 'canceled via Ctrl-C' banner]", flush=True)

    if not args.no_code:
        time.sleep(0.4)
        print(f"sending unlock code {args.code} ...", flush=True)
        ser.write(args.code.encode() + b"\r")
        ser.flush()
        time.sleep(1.2)
        chunk = ser.read(16384)
        if chunk:
            log.write(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.flush()

    for c in args.cmd:
        time.sleep(0.5)
        print(f"sending: {c}", flush=True)
        ser.write(c.encode("latin-1") + b"\r")
        ser.flush()
        time.sleep(1.5)
        chunk = ser.read(65536)
        if chunk:
            log.write(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.flush()

    print("\n--- live console (quit with Ctrl-]) ---\n", flush=True)
    import termios
    import tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while True:
            r, _, _ = select.select([fd, ser], [], [], 0.1)
            if fd in r:
                data = os.read(fd, 1024)
                if not data:
                    break
                if b"\x1d" in data:  # Ctrl-]
                    print("\r\n[quit]", flush=True)
                    break
                ser.write(data)
                ser.flush()
            if ser in r:
                data = ser.read(8192)
                if data:
                    log.write(data)
                    os.write(sys.stdout.fileno(), data)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        log.close()
        ser.close()
    print(f"\nlog saved: {log_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
