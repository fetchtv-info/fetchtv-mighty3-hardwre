#!/bin/sh
# Install or replace the HDFR boot hook and its files. Run on the box as root.
# Reads its payload from the directory given as $1 (default /tmp/hdfr-stage).
#
# Safe to re-run: the vendor launcher is backed up once, and the file swap is
# copy-then-mv so a power cut cannot leave a half-written launcher.

set -u
STAGE=${1:-/tmp/hdfr-stage}
ROOT=/root/HDFR
X=/usr/local/bin/nxserver
HOOK=$X/nxserver

fail() { echo "install: $*" >&2; exit 1; }

[ -r "$STAGE/hdfrd" ] || fail "no hdfrd in $STAGE"
[ -r "$STAGE/config.json" ] || fail "no config.json in $STAGE"
[ -r "$STAGE/index.html" ] || fail "no index.html in $STAGE"
[ -r "$STAGE/app.js" ] || fail "no app.js in $STAGE"
[ -r "$STAGE/ui.css" ] || fail "no ui.css in $STAGE"
[ -r "$STAGE/nxserver" ] || fail "no boot hook in $STAGE"

mkdir -p "$ROOT/logs" "$ROOT/backup" "$ROOT/guide" || fail "cannot create $ROOT"
# A CA bundle travels with the daemon: this box's own trust store predates the
# roots the guide feed chains to, and a verifiable fetch beats a skipped one.
if [ -r "$STAGE/ca-bundle.pem" ]; then
    mkdir -p "$ROOT/certs" && cp "$STAGE/ca-bundle.pem" "$ROOT/certs/ca-bundle.pem" || fail "copy CA bundle"
fi
cp "$STAGE/hdfrd"     "$ROOT/hdfrd.new"     || fail "copy hdfrd"
cp "$STAGE/config.json" "$ROOT/config.json.default" || fail "copy config"
cp "$STAGE/index.html" "$ROOT/index.html.new" || fail "copy index"
cp "$STAGE/app.js"    "$ROOT/app.js.new"    || fail "copy app.js"
cp "$STAGE/ui.css"    "$ROOT/ui.css.new"    || fail "copy ui.css"
chmod 755 "$ROOT/hdfrd.new"
mv "$ROOT/hdfrd.new" "$ROOT/hdfrd"             || fail "install hdfrd"
# An upgrade must never reset the operator's settings (guide_offset, port,
# friendly name) - seed a default only when there is no config yet.
if [ ! -r "$ROOT/config.json" ]; then
    mv "$ROOT/config.json.default" "$ROOT/config.json" || fail "install config"
else
    echo "keeping existing config.json (default left as config.json.default)"
fi
mv "$ROOT/index.html.new" "$ROOT/index.html"   || fail "install index"
mv "$ROOT/app.js.new" "$ROOT/app.js"           || fail "install app.js"
mv "$ROOT/ui.css.new" "$ROOT/ui.css"           || fail "install ui.css"
sync

# Keep the original launcher exactly once, so revert never depends on a build.
if [ ! -f "$ROOT/backup/nxserver.orig" ]; then
    cp -p "$HOOK" "$ROOT/backup/nxserver.orig" || fail "backup launcher"
    sync
fi

echo "install: config check"
"$ROOT/hdfrd" -configure -root "$ROOT" || fail "config/hdfrd self-check failed"
"$ROOT/hdfrd" -version

echo "install: writing boot hook (remount /usr rw)"
mount -o remount,rw /usr || fail "remount /usr rw"
cp "$STAGE/nxserver" "$X/nxserver.new" || { mount -o remount,ro /usr; fail "stage hook"; }
chmod 755 "$X/nxserver.new" || { mount -o remount,ro /usr; fail "chmod hook"; }
mv "$X/nxserver.new" "$X/nxserver" || { mount -o remount,ro /usr; fail "replace hook"; }
sync
mount -o remount,ro /usr
ls -l "$X" | grep -E 'nxserver' 
echo "install: done - power-cycle to boot HDFR"
