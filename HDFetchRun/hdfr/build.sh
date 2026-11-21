#!/bin/sh
# Build hdfrd for the box and stage everything for transfer.
# Artifacts land in ../phase0/dist, which the lab server already serves at
# http://<host>:8090/dist/.
set -eu

GO=${GO:-/home/hermes/toolchains/go/bin/go}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../phase0/dist

mkdir -p "$OUT"
cd "$HERE"

# Static, no cgo: the box has glibc 2014-era, do not link against it.
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 \
    "$GO" build -trimpath -ldflags "-s -w -X main.version=0.5.0-phase5-$(date -u +%Y%m%d)" \
    -o "$OUT/hdfrd" .

cp "assets/index.html" assets/app.js assets/ui.css assets/config.json assets/ca-bundle.pem boot/nxserver boot/install.sh boot/uninstall.sh "$OUT"

echo "staged in $OUT:"
ls -l "$OUT"
md5sum "$OUT"/*
