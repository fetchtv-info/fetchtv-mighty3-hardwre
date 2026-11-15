#!/bin/sh
# Re-apply the FTA/activation-bypass patches after each boot.
#
# Why: the SUI lives on the initramfs RAM rootfs (/webpage), so in-place edits
# are lost on reboot. This runs from the nxserver wrapper before the app starts.
#
# 0. CLOCK. This box has no usable RTC, so it boots with a 1970 clock and every
#    TLS connection fails until the time is corrected - the SUI's native
#    GET https://apis.fetchtv.com.au/v2/alive then times out and the box
#    concludes it is offline ("Welcome/Let's Connect" loop). The clock is set
#    over NTP (UDP/123) using the busybox ntpd applet already in the firmware,
#    so nothing here depends on another host being online.
#
# 1. classes.bundle.js - Fetch replies NOT_ACTIVATED to the SUI's auth call,
#    which makes the app set boxNotActivated / activationRequired /
#    welcomeProcess and show the "Set up Fetch" welcome flow. Forcing those
#    option flags to false stops the welcome flow being entered.
#
# 2. internet_test_redirect.html - this launcher normally authenticates against
#    the live middleware and loads the REMOTE SUI release, where patch (1) does
#    not apply. Redirecting straight to offlineFirmwareSuiUrl
#    (file:///home/fetchtv/sui/index.htm) forces the LOCAL SUI, which loads
#    __webpack/classes.bundle.js - i.e. the patched code.
#
# It lives on the USB stick with the harness, and is called by the nxserver
# wrapper - the only file installed on the box. Remove the stick (or the marker
# file hermes_enable) and reboot to boot stock.
#
# Revert: remove the call from the nxserver wrapper, or drop the marker file.

SUI=/webpage/home/fetchtv/sui
B=$SUI/__webpack/classes.bundle.js
L=$SUI/internet_test_redirect.html
LOG=/root/fta-patch.log
SELFDIR=`dirname "$0"`

# --- step 0: set the clock over NTP -----------------------------------------
# Peers by IP so DNS is never in the boot path. ntpd -q sets the time once and
# exits; each attempt is bounded because a peer that never answers would
# otherwise hold the boot (and the telnet window) open indefinitely.
if ! ifconfig eth0 2>/dev/null | grep -q 'inet addr'; then
  udhcpc -i eth0 -q -n -t 3 >/dev/null 2>&1
fi

NTP_PEERS="162.159.200.1 216.239.35.0 103.16.34.5"
clock_ok() {
  [ "$(date -u +%Y)" -ge 2020 ]
}

SYNCED=0
clock_ok && SYNCED=1
for round in 1 2; do
  [ "$SYNCED" = 1 ] && break
  for P in $NTP_PEERS; do
    [ "$SYNCED" = 1 ] && break
    busybox ntpd -q -n -p "$P" >>"$LOG" 2>&1 &
    NPID=$!
    n=0
    while [ $n -lt 8 ]; do
      kill -0 "$NPID" 2>/dev/null || break
      n=$((n+1))
      sleep 1
    done
    if kill -0 "$NPID" 2>/dev/null; then
      kill "$NPID" 2>/dev/null
    fi
    if clock_ok; then
      SYNCED=1
      echo "$(date -u) clock synced over NTP (peer $P)" >> "$LOG" 2>/dev/null
    fi
  done
done
[ "$SYNCED" = 1 ] || echo "$(date -u) WARNING: NTP sync failed" >> "$LOG" 2>/dev/null

# --- USB gate ---------------------------------------------------------------
# Risk control: the SUI/kernel-side injections only run when a marked USB stick
# is inserted. Without it the box boots stock (still with telnet), so a bad
# harness can never trap the box in a loop that we cannot get out of.
#   stick must be a real USB device (sd[b-z]), NOT sda which is the PVR HDD
#   marker file: <mount>/hermes_enable
#   optional harness copy on the stick takes priority over the one in /root
ENABLE=0
USBMNT=""
i=0
while [ $i -lt 20 ]; do
  for m in $(mount | sed -n 's|^/dev/sd[b-z][0-9]* on \(/mnt/[^ ]*\) .*|\1|p'); do
    if [ -f "$m/hermes_enable" ]; then USBMNT="$m"; ENABLE=1; break; fi
  done
  [ "$ENABLE" = "1" ] && break
  i=$((i + 1))
  sleep 1
done
echo "$(date -u) usb gate: enable=$ENABLE mount=${USBMNT:-none}" >> "$LOG" 2>/dev/null

# --- patch 1: suppress the activation/welcome flags -------------------------
if [ "$ENABLE" = "1" ] && [ -f "$B" ] && grep -q 'boxNotActivated: true' "$B" 2>/dev/null; then
  sed -i \
    -e 's/boxNotActivated: true/boxNotActivated: false/g' \
    -e 's/activationRequired: true/activationRequired: false/g' \
    -e 's/welcomeProcess: true/welcomeProcess: false/g' \
    "$B" && echo "$(date -u) patched classes.bundle.js" >> "$LOG" 2>/dev/null
fi

# --- patch 2: force the local SUI instead of the remote release -------------
if [ "$ENABLE" = "1" ] && [ -f "$L" ] && ! grep -q 'HERMES_FORCE_LOCAL_SUI' "$L" 2>/dev/null; then
  sed -i 's|function initSuiLoadWorkflow(){|function initSuiLoadWorkflow(){ /*HERMES_FORCE_LOCAL_SUI*/ window.location = offlineFirmwareSuiUrl; return;|' "$L" \
    && echo "$(date -u) forced local SUI in internet_test_redirect.html" >> "$LOG" 2>/dev/null
fi

# --- crash-loop breaker -----------------------------------------------------
# A bad harness can crash the app and the watchdog will reboot in a loop, which
# also removes the telnet window we'd use to fix it. Count consecutive boots and
# deny injection if we look stuck; a background job clears the counter once this
# boot has survived long enough to prove itself.
BC=/root/boot_count
BOOTN=$(cat "$BC" 2>/dev/null || echo 0)
BOOTN=$((BOOTN + 1))
echo "$BOOTN" > "$BC" 2>/dev/null
SAFE=""
[ -f /root/fetch-preservation/SAFE_MODE ] && SAFE=1
# backups land here; create it because a stick-only install has no /usr copy to
# seed the directory
mkdir -p /root/fetch-preservation 2>/dev/null
[ "$BOOTN" -gt 3 ] && SAFE=1 && echo "$(date -u) SAFE MODE: $BOOTN consecutive boots - harness injection disabled" >> "$LOG" 2>/dev/null
( sleep 150; echo 0 > "$BC" ) &

# --- step 3: inject the DVB scan harness into the local SUI -----------------
HARNESS="$SELFDIR/hermes_pvrui.js"
[ -n "$USBMNT" ] && [ -f "$USBMNT/hermes_pvrui.js" ] && HARNESS="$USBMNT/hermes_pvrui.js"
if [ "$ENABLE" = "1" ] && [ -z "$SAFE" ] && [ -f "$HARNESS" ]; then
  cp -f "$HARNESS" "$SUI/hermes_pvrui.js" 2>/dev/null
  if [ -f "$SUI/index.htm" ] && ! grep -q 'hermes_pvrui.js' "$SUI/index.htm" 2>/dev/null; then
    cp -f "$SUI/index.htm" /root/index.htm.orig 2>/dev/null
    sed -i 's|</body>|<script src="./hermes_pvrui.js"></script></body>|' "$SUI/index.htm" \
      && echo "$(date -u) injected hermes_pvrui.js into index.htm" >> "$LOG" 2>/dev/null
  fi
fi

# --- patch 4: make the launcher BE the SUI ----------------------------------
# The app is started with file:///home/fetchtv/sui/internet_test_redirect.html,
# whose own flow only redirects to the local SUI if its network probe decides to
# give up. When that probe stalls (firewalled endpoints, no channels) index.htm is
# never loaded and the screen stays black. Replacing the launcher's contents with
# the SUI removes the decision; both files sit in the same directory, so relative
# resource paths still resolve.
if [ "$ENABLE" = "1" ] && [ -f "$L" ] && [ -f "$SUI/index.htm" ] && ! grep -q 'HERMES_LAUNCHER_IS_SUI' "$L" 2>/dev/null; then
  cp "$L" /root/fetch-preservation/internet_test_redirect.orig 2>/dev/null
  { echo '<!--HERMES_LAUNCHER_IS_SUI-->'; cat "$SUI/index.htm"; } > "$L.new" 2>/dev/null \
    && mv "$L.new" "$L" \
    && echo "$(date -u) launcher replaced with the local SUI" >> "$LOG" 2>/dev/null
fi

exit 0
