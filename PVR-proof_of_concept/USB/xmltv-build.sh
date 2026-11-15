#!/bin/sh
# Hermes XMLTV -> compact guide converter.
#
# The XML is ~9 MB and cannot be read through Ag_textFile_read at any sane speed
# (512-byte chunks), so awk reduces it to a small pipe-delimited file that the UI
# loads instead:
#
#   /root/guide.txt           lcn|start|stop|title      (UTC, YYYYMMDDHHMMSS)
#   /root/guide_channels.txt  lcn|display-name
#
# NOTE: the firmware text-file API only opens .txt/.json - a .tsv returns -1.
#
# Window: programmes that ended up to 3 h ago or start within the next 72 h.
# The view starts 30 min before the current half hour and the file is rebuilt
# only hourly, so trimming at "now" left the left edge of the grid blank.
# XMLTV here carries "+0000" offsets, so UTC comparison against `date -u` is exact.

XML=/root/xmltv/guide.xml
OUT=/root/guide.txt
CHAN=/root/guide_channels.txt
LOG=/root/xmltv/build.log

[ -f "$XML" ] || { echo "no xml" >> "$LOG"; exit 1; }

NOW=$(date -u +%Y%m%d%H%M%S)
UNTIL=$(date -u -d @$(( $(date -u +%s) + 259200 )) +%Y%m%d%H%M%S)
# Keep programmes that ended up to 3 h ago: the guide view starts 30 min before
# the current half hour, and the file is only rebuilt hourly, so trimming at
# "now" left the left edge of the grid with nothing to draw.
FROM=$(date -u -d @$(( $(date -u +%s) - 10800 )) +%Y%m%d%H%M%S)

awk -v now="$NOW" -v from="$FROM" -v until="$UNTIL" -v chanfile="$CHAN" '
  /<channel id="/ {
    cid = "";
    if (match($0, /id="[^"]+"/)) cid = substr($0, RSTART + 4, RLENGTH - 5);
    next;
  }
  /<\/channel>/ { cid = ""; next }
  /<lcn>/ {
    if (cid != "" && match($0, /<lcn>[0-9]+<\/lcn>/))
      lcn[cid] = substr($0, RSTART + 5, RLENGTH - 11);
    next;
  }
  /<display-name>/ {
    if (cid != "" && !(cid in dname) && match($0, /<display-name>[^<]*<\/display-name>/))
      dname[cid] = substr($0, RSTART + 14, RLENGTH - 29);
    next;
  }
  /<programme / {
    ps = ""; pe = ""; pc = ""; pt = ""; pd = ""; psub = ""; pep = ""; indesc = 0;
    if (match($0, /start="[0-9]+/))   ps = substr($0, RSTART + 7, RLENGTH - 7);
    if (match($0, /stop="[0-9]+/))    pe = substr($0, RSTART + 6, RLENGTH - 6);
    if (match($0, /channel="[^"]+"/)) pc = substr($0, RSTART + 9, RLENGTH - 10);
    next;
  }
  /<title/ {
    if (pc != "" && pt == "" && match($0, /<title[^>]*>[^<]+<\/title>/)) {
      s = substr($0, RSTART, RLENGTH);
      sub(/^<title[^>]*>/, "", s);
      sub(/<\/title>.*$/, "", s);
      pt = s;
    }
    next;
  }
  /<sub-title/ {
    if (pc != "" && psub == "" && match($0, /<sub-title[^>]*>[^<]+<\/sub-title>/)) {
      s2 = substr($0, RSTART, RLENGTH);
      sub(/^<sub-title[^>]*>/, "", s2);
      sub(/<\/sub-title>.*$/, "", s2);
      psub = s2;
    }
    next;
  }
  /<episode-num system="SxxExx"/ {
    if (pc != "" && pep == "") {
      epv = $0;
      sub(/^.*system="SxxExx"[^>]*>/, "", epv);
      sub(/<.*$/, "", epv);
      gsub(/^[ \t]+/, "", epv); gsub(/[ \t]+$/, "", epv);
      # only SxxEyy with 0-99 in both parts: the field is also used for strand
      # ids (S2026E1112 = year+month+day on Racing Review, S2016E304 on home
      # shopping), which must not be treated as episode numbers
      if (epv ~ /^S[0-9][0-9]?E[0-9][0-9]?$/) pep = epv;
    }
    next;
  }
  /<desc/ {
    if (pc != "") {
      pd = "";
      line = $0;
      sub(/^.*<desc[^>]*>/, "", line);
      if (line ~ /<\/desc>/) { sub(/<\/desc>.*$/, "", line); indesc = 0 } else indesc = 1;
      pd = line;
    }
    next;
  }
  indesc {
    line = $0;
    if (line ~ /<\/desc>/) { sub(/<\/desc>.*$/, "", line); indesc = 0 }
    pd = pd " " line;
    next;
  }
  /<\/programme>/ {
    if (pc != "" && (pc in lcn) && pe > from && ps < until) {
      gsub(/[|\t\r]/, " ", pt);
      gsub(/[|\t\r]/, " ", pd);
      gsub(/  +/, " ", pd);
      sub(/^ +/, "", pd);
      if (length(pd) > 220) pd = substr(pd, 1, 220) " ...";
      gsub(/[|\t\r]/, " ", psub);
      gsub(/[|\t\r]/, " ", pep);
      print lcn[pc] "|" ps "|" pe "|" pt "|" pd "|" psub "|" pep;
    }
    pc = "";
    next;
  }
  END {
    for (c in lcn) if (c in dname) print lcn[c] "|" dname[c] > chanfile;
  }
' "$XML" > "$OUT"

lines=$(wc -l < "$OUT" 2>/dev/null || echo 0)
chans=$(wc -l < "$CHAN" 2>/dev/null || echo 0)
echo "$(date) guide.tsv $lines lines, channels.tsv $chans lines (range $FROM..$UNTIL)" >> "$LOG"
