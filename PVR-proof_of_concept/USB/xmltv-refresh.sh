#!/bin/sh
# Hermes XMLTV guide fetcher.
#
# Downloads https://xmltv.net/xml_files/<City>.xml, where the city comes from
# "Guide city" in the settings page, at most once every 24 h. Honours the
# "Use XML TV Guide" setting and keeps the cache on the PVR partition so it
# survives reboots.
#
#   cache   /root/xmltv/guide.xml
#   status  /root/xmltv/status.txt     (key=value, read by the UI)
#   log     /root/xmltv/refresh.log
#   setting /root/hermes_settings.txt  (use_xmltv=1|0, guide_city=Adelaide)
#   trigger /root/xmltv/refresh_req    (written by the UI when the city changes;
#                                      forces a fetch and is then removed)
#
# The wrapper starts it at boot and it re-checks every 5 minutes. A check is a
# stat plus two greps; the 9 MB download only happens when the cache is stale,
# missing, or the selected city has changed.

CACHE_DIR=/root/xmltv
CACHE=$CACHE_DIR/guide.xml
STATUS=$CACHE_DIR/status.txt
LOG=$CACHE_DIR/refresh.log
REQ=$CACHE_DIR/refresh_req
SETTINGS=/root/hermes_settings.txt
GUIDE=/root/guide.txt
CITIES=/root/guide_cities.txt
INDEX_URL=https://www.xmltv.net/free-epg-xml-links-for-australia/
CURL=/usr/local/bin/curl/curl
# the wrapper no longer exports a CA bundle (it changed the app's boot path), so
# this script supplies its own for the HTTPS download
SSL_CERT_FILE=/root/fetch-preservation/ca-bundle.pem
export SSL_CERT_FILE
# The reducer sits beside this script (both live on the stick). The /usr path is
# only a fallback for an install that has not been migrated yet; without this,
# [ -x "$BUILD" ] failed silently and the guide never rebuilt after a download.
SELFDIR=`dirname "$0"`
BUILD="$SELFDIR/xmltv-build.sh"
[ -x "$BUILD" ] || BUILD=/usr/local/bin/nxserver/xmltv-build.sh
MAX_AGE=86400

mkdir -p "$CACHE_DIR" 2>/dev/null

enabled() {
  [ -f "$SETTINGS" ] || return 0
  grep -q '^use_xmltv=0' "$SETTINGS" 2>/dev/null && return 1
  return 0
}

# The city list is scraped from the provider's own index page rather than
# hardcoded, so a new or renamed feed shows up without touching this script.
# Falls back to whatever list is already cached if the page changes shape.
fetch_cities() {
  mt=$(file_mtime "$CITIES")
  if [ "$mt" -gt 0 ] 2>/dev/null; then
    age=$(( $(date +%s) - mt ))
    [ "$age" -lt "$MAX_AGE" ] && return 0
  fi
  tmp=$CITIES.page
  "$CURL" -s --max-time 60 -o "$tmp" "$INDEX_URL" || { rm -f "$tmp"; return 1; }
  grep -o 'href="[^"]*\.xml"' "$tmp" 2>/dev/null | sed 's/.*\///; s/"$//; s/\.xml$//' \
    | sort -u > "$CITIES.new" 2>/dev/null
  n=$(wc -l < "$CITIES.new" 2>/dev/null || echo 0)
  if [ "$n" -ge 20 ]; then
    mv "$CITIES.new" "$CITIES"
    echo "$(date) city list: $n feeds" >> "$LOG"
  else
    echo "$(date) city scrape looked wrong ($n), kept previous list" >> "$LOG"
    rm -f "$CITIES.new"
  fi
  rm -f "$tmp"
  return 0
}

setting_city() {
  c=""
  [ -f "$SETTINGS" ] && c=$(grep '^guide_city=' "$SETTINGS" 2>/dev/null | tail -1 | cut -d= -f2-)
  # accept anything shaped like a feed name; the exact list is scraped
  case "$c" in
    ""|*[!A-Za-z0-9_]*) c=Adelaide ;;
  esac
  echo "$c"
}

CITY=$(setting_city)
URL="https://xmltv.net/xml_files/$CITY.xml"
PREV_CITY=$(grep '^city=' "$STATUS" 2>/dev/null | cut -d= -f2-)

file_mtime() {
  if [ -f "$1" ]; then
    stat -c %Y "$1" 2>/dev/null && return 0
    date -r "$1" +%s 2>/dev/null && return 0
  fi
  echo 0
}

fresh() {
  [ -f "$CACHE" ] || return 1
  mt=$(file_mtime "$CACHE")
  [ "$mt" -gt 0 ] 2>/dev/null || return 1
  now=$(date +%s)
  age=$((now - mt))
  [ "$age" -lt "$MAX_AGE" ]
}

write_status() {
  size=$(wc -c < "$CACHE" 2>/dev/null || echo 0)
  mt=$(file_mtime "$CACHE")
  {
    echo "enabled=$1"
    echo "last_ok=$mt"
    echo "size=$size"
    echo "url=$URL"
    echo "city=$CITY"
    echo "checked=$(date +%s)"
    echo "note=$2"
  } > "$STATUS" 2>/dev/null
}

fetch() {
  tmp=$CACHE.tmp
  rm -f "$tmp"
  "$CURL" -s --max-time 180 -o "$tmp" "$URL" || { echo "$(date) curl failed" >> "$LOG"; rm -f "$tmp"; return 1; }
  if ! dd if="$tmp" bs=1 count=400 2>/dev/null | grep -q '<tv'; then
    echo "$(date) not xmltv, discarded" >> "$LOG"
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$CACHE" || return 1
  echo "$(date) fetched $CITY $(wc -c < "$CACHE") bytes" >> "$LOG"
  return 0
}

build_if_needed() {
  [ -f "$CACHE" ] || return 0
  [ -x "$BUILD" ] || return 0
  if [ ! -f "$GUIDE" ] || [ "$CACHE" -nt "$GUIDE" ]; then
    "$BUILD"
  fi
}

check_once() {
  fetch_cities
  CITY=$(setting_city)
  URL="https://xmltv.net/xml_files/$CITY.xml"
  PREV_CITY=$(grep '^city=' "$STATUS" 2>/dev/null | cut -d= -f2-)

  if ! enabled; then
    write_status 0 "disabled by setting"
    return 0
  fi

  forced=0
  [ -f "$REQ" ] && forced=1 && rm -f "$REQ"

  if [ "$CITY" != "$PREV_CITY" ]; then
    echo "$(date) city changed '$PREV_CITY' -> '$CITY'" >> "$LOG"
    forced=1
  fi

  if [ "$forced" = 0 ] && fresh; then
    write_status 1 "cache fresh"
  elif fetch; then
    write_status 1 "downloaded"
  else
    write_status 1 "download failed"
  fi
  build_if_needed
}

if [ "$1" = "--once" ]; then
  check_once
  exit 0
fi

while true; do
  check_once
  sleep 300
done
