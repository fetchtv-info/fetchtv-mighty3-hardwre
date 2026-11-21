#!/bin/sh
# Remove HDFR and return the box to a stock boot. Run on the box as root.
#
# Order matters: restore the config while hdfrd still exists, put the vendor
# launcher back, and only then delete the tree.

set -u
ROOT=/root/HDFR
X=/usr/local/bin/nxserver
HOOK=$X/nxserver

fail() { echo "uninstall: $*" >&2; exit 1; }

if [ -x "$ROOT/hdfrd" ]; then
    "$ROOT/hdfrd" -restore || fail "could not restore homepage_url"
    echo "uninstall: homepage_url restored"
fi

if [ ! -f "$ROOT/backup/nxserver.orig" ]; then
    fail "no launcher backup at $ROOT/backup/nxserver.orig - leaving the boot hook alone"
fi

mount -o remount,rw /usr || fail "remount /usr rw"
cp "$ROOT/backup/nxserver.orig" "$X/nxserver.new" || { mount -o remount,ro /usr; fail "stage launcher"; }
chmod 755 "$X/nxserver.new"
mv "$X/nxserver.new" "$HOOK" || { mount -o remount,ro /usr; fail "restore launcher"; }
sync
mount -o remount,ro /usr
echo "uninstall: vendor launcher restored"

if [ -f "$ROOT/logs/hdfrd.pid" ]; then
    kill "$(cat "$ROOT/logs/hdfrd.pid")" 2>/dev/null
fi
rm -rf "$ROOT"
sync
echo "uninstall: done - power-cycle for a stock boot"
