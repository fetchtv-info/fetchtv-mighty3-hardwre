#!/bin/sh
# Build the recordings web page served by darkhttpd on :8081.
#
# What exists comes from the PVR directory: record<N>.mpg plus optional
# record<N>.mpg_.NNN overflow parts, with the middleware's recording id as the
# first NUL-terminated string in record<N>.mda. Titles come from two places, in
# order of preference:
#
#   /root/hermes_rec_titles.txt   id -> name/channel/date/episode, from the
#                                 middleware's own SQL dump (covers old recordings)
#   /root/hermes_web_meta.txt     id -> what the TV harness currently shows
#                                 (fresher for recordings it made itself)
#
# Nothing here writes to the PVR: it only reads it and writes the page plus
# playlists beside it.
#
# Output: /mnt/usb1/index.html and /mnt/usb1/play/rec<N>.m3u
#
# Performance note: this runs on a 1.7 GHz dual-core with a FAT32 stick, so the
# whole build is ONE awk process. An earlier version forked dd/tr/stat twice per
# recording and took minutes; this takes seconds.

PVR=/mnt/usb1/PVR
OUT=/mnt/usb1/index.html
PLAYDIR=/mnt/usb1/play
META=/root/hermes_web_meta.txt
TITLES=/root/hermes_rec_titles.txt
TMP=/mnt/usb1/.index.new

mkdir -p "$PLAYDIR" || exit 1

ls -ln "$PVR" 2>/dev/null | awk -v pvr="$PVR" -v playdir="$PLAYDIR" \
    -v out="$TMP" -v titles="$TITLES" -v meta="$META" \
    -v now="`date -u '+%Y-%m-%d %H:%M UTC'`" '
function esc(s) { gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s); return s }
function human(b) {
    if (b >= 1073741824) return sprintf("%.1f GB", b / 1073741824)
    if (b >= 1048576)    return sprintf("%.0f MB", b / 1048576)
    return sprintf("%.0f KB", b / 1024)
}
# the id is the first NUL-terminated run of digits; a few files carry a short
# magic ("PLTV") first, so try the first few strings
function getid(f,   i, s) {
    for (i = 0; i < 4; i++) {
        if ((getline s < f) <= 0) break
        gsub(/[^0-9]/, "", s)
        if (s != "") { close(f); return s }
    }
    close(f)
    return ""
}
BEGIN {
    while ((getline line < titles) > 0) {          # id name channel date episode
        split(line, f, "\t")
        if (f[1] != "") { tname[f[1]] = f[2]; tch[f[1]] = f[3]; tday[f[1]] = f[4]; tep[f[1]] = f[5] }
    }
    close(titles)
    while ((getline line < meta) > 0) {            # id label channel ep day dur bytes seen
        split(line, f, "\t")
        if (f[1] == "") continue
        if (f[2] != "" && f[2] !~ /^Recording [0-9]+$/) mname[f[1]] = f[2]
        if (f[3] != "") mch[f[1]] = f[3]
        if (f[4] != "") mep[f[1]] = f[4]
        if (f[5] != "") mday[f[1]] = f[5]
    }
    close(meta)
}
{
    # ls -ln: perms links owner group SIZE mon day time/year NAME
    name = $NF
    if (name ~ /^record[0-9]+\.mpg$/) {
        n = name; sub(/^record/, "", n); sub(/\.mpg$/, "", n)
        size[n] += $5
        parts[n]++
        order[n] = order[n] "\n" name
        if (n + 0 > maxn) maxn = n + 0
    } else if (name ~ /^record[0-9]+\.mpg_/) {
        n = name; sub(/^record/, "", n); sub(/\.mpg_.*$/, "", n)
        size[n] += $5
        parts[n]++
        order[n] = order[n] "\n" name
    }
}
END {
    rows = ""
    for (n = maxn; n >= 0; n--) {
        if (!(n in size)) continue
        id = getid(pvr "/record" n ".mda")
        label = mname[id]; ch = mch[id]; day = mday[id]; ep = mep[id]
        if (label == "") label = tname[id]
        if (ch == "") ch = tch[id]
        if (day == "") day = tday[id]
        if (ep == "") ep = tep[id]
        if (label == "") label = "Recording " n

        # playlist over the parts, so a player fetches them in order
        pl = playdir "/rec" n ".m3u"
        printf "#EXTM3U\n" > pl
        k = split(order[n], plist, "\n")
        for (i = 1; i <= k; i++) if (plist[i] != "") printf "PVR/%s\n", plist[i] > pl
        close(pl)

        total += size[n]; count++
        rows = rows "<tr><td class=c>" n "</td><td class=t>" esc(label) \
            (ep != "" && ep != label ? "<span class=ep>  " esc(ep) "</span>" : "") \
            "</td><td class=c>" esc(ch) "</td><td class=c>" esc(day) \
            "</td><td class=r>" human(size[n]) \
            (parts[n] > 1 ? " <span class=ep>(" parts[n] ")</span>" : "") \
            "</td><td class=c><a href=\"/play/rec" n ".m3u\">play</a></td>" \
            "<td class=c><a href=\"/PVR/record" n ".mpg\">save</a></td></tr>\n"
    }

    head = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    head = head "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    head = head "<title>FetchTV recordings</title><style>"
    head = head "body{background:#000;color:#00ff66;font:14px/1.45 monospace;margin:0;padding:18px}"
    head = head "h1{font-size:19px;letter-spacing:2px;margin:0 0 4px}"
    head = head ".sub{color:#00a040;font-size:12px;margin-bottom:14px}"
    head = head "table{border-collapse:collapse;width:100%}"
    head = head "th{position:sticky;top:0;background:#001a0a;color:#00ff66;text-align:left;"
    head = head "font-weight:400;letter-spacing:1px;font-size:11px;padding:6px 8px;"
    head = head "border-bottom:1px solid #00a040}"
    head = head "td{padding:4px 8px;border-bottom:1px solid #0a2a12;vertical-align:top}"
    head = head "tr:hover td{background:#04140a}"
    head = head ".c{white-space:nowrap}.r{text-align:right;white-space:nowrap}"
    head = head ".t{color:#aaffcc}.ep{color:#00a040;font-size:12px}"
    head = head "a{color:#7cffb2;text-decoration:none}a:hover{text-decoration:underline;color:#fff}"
    head = head "thead th:first-child{width:46px}"
    head = head "</style></head><body><h1>RECORDINGS</h1>"
    head = head sprintf("<div class=sub>%d recordings &middot; %s &middot; page built %s</div>", count, human(total), now)
    head = head "<table><thead><tr><th>#</th><th>Title</th><th>Channel</th><th>Date</th>"
    head = head "<th>Size</th><th>Play</th><th>Save</th></tr></thead><tbody>"

    printf "%s%s</tbody></table></body></html>", head, rows > out
    close(out)
    printf "recweb: %d rows\n", count
}'
