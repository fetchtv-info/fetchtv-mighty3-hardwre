/*
 * Hermes PVR UI  —  manual recording + recordings list, driven by the retail remote.
 *
 * Verified key codes (M616T):
 *   OK          1073741994   (0x400000AA)
 *   RECORD      210
 *   STOP        413
 *   PLAY/PAUSE  415
 *   FF          417
 *   REW         412
 *   MENU        1073742338
 *   APPS        1073741974
 *   BACK        213
 *   EXIT        203
 *   UP/DOWN/L/R 38 / 40 / 37 / 39
 *   TV GUIDE    224
 *   CH UP/DOWN  1073741869 / 1073741867
 *   digits      48-57
 *   VOL UP/DOWN are handled natively by the box and never reach the page.
 *
 * Controls:
 *   LIVE:      RECORD = start/stop recording current channel
 *              MENU or APPS = open recordings list
 *              CH UP/DOWN, digits, GUIDE = tune as before
 *   LIST:      UP/DOWN = move   OK = play   RECORD = delete   BACK/EXIT = close
 *   PLAYBACK:  PLAY/PAUSE = toggle   FF/REW = +-30 s   UP/DOWN = +-30 s
 *              STOP or BACK/EXIT = stop and return to live
 *
 * Playback MUST stop live first (Ag_dvb_stop) or the decoder is busy: black
 * screen and a frozen position. Live is restored on exit.
 */
(function () {
  // Reports go to /root/ui_<seq>_<tag>.json - that is the only channel. There used
  // to be a sendBeacon mirror to a fixed development host, which made the harness
  // depend on somebody's LAN address; it told us nothing the files do not, and on a
  // box that cannot be reached there is no beacon to catch anyway.

  // Proof-of-life: written before anything else, so a boot that produces no
  // reports can be told apart from a boot where the page never executed.
  (function alive() {
    try {
      var p0 = new window.AVPlayer();
      try { p0.Ag_textFile_remove("/root/ui_000_loaded.json"); } catch (e) {}
      var fd0 = p0.Ag_textFile_open("/root/ui_000_loaded.json");
      if (fd0 != -1) {
        p0.Ag_textFile_write(fd0, '{"tag":"loaded","at":' + Date.now() + ',"data":{"loc":"' +
                             String(window.location).replace(/"/g, "") + '"}}', 800);
        p0.Ag_textFile_close(fd0);
      }
    } catch (e) {}

  })();

  // Channel-list recovery. If the DVB list is empty the SUI bundle never finishes
  // initialising (black screen, no `hardware`), so nothing above this can help.
  // The natives work regardless, so drive the vendor band plan here, at page load,
  // where the scanner is known to work, then reload into a normal boot.
  (function channelRecovery() {
    function put(name, data) {
      var payload = JSON.stringify({ tag: name, at: Date.now(), data: data });
      try {
        var p = new window.AVPlayer();
        try { p.Ag_textFile_remove("/root/" + name + ".json"); } catch (e) {}
        var fd = p.Ag_textFile_open("/root/" + name + ".json");
        if (fd != -1) {
          var bits = payload.length * 8;
          p.Ag_textFile_write(fd, payload, bits);
          p.Ag_textFile_close(fd);
        }
      } catch (e) {}
    }

    setTimeout(function () {
      var count = -1;
      try { count = Number(nat_local().Ag_dvb_Channel_GetCount(0)); } catch (e) { return; }
      if (count !== 0) { put("recovery_skip", { count: count }); return; }

      var STAGES = [[177500, 7000, 8], [522500, 7000, 43]];
      var stage = 0;
      put("recovery_scan", { reason: "empty channel list" });

      function n() {
        try { return Number(nat_local().Ag_dvb_Channel_GetCount(0)) || 0; } catch (e) { return 0; }
      }

      function runStage() {
        if (stage >= STAGES.length) {
          put("recovery_done", { channels: n(), ms: Date.now() - startedAt });
          setTimeout(function () { try { window.location.reload(); } catch (e) {} }, 1500);
          return;
        }
        var st = STAGES[stage], last = -1, still = 0, startedAt = Date.now();
        var r = null;
        try { r = nat_local().Ag_dvb_startScan(0, st[0], st[1], st[2], 7); } catch (e) { r = "throw:" + e; }
        put("recovery_stage", { stage: stage, freq: st[0], result: r });
        var iv = setInterval(function () {
          var pct = 0;
          try { pct = Number(nat_local().Ag_dvb_getAutoScanProgress()) || 0; } catch (e) {}
          put("recovery_progress", { stage: stage, pct: Math.round(pct), count: n() });
          if (pct >= 99) { clearInterval(iv); stage++; runStage(); return; }
          if (pct === last) { if (++still >= 8) { clearInterval(iv); stage++; runStage(); return; } }
          else { still = 0; last = pct; }
          if (Date.now() - startedAt > 240000) { clearInterval(iv); put("recovery_timeout", { stage: stage, pct: pct }); }
        }, 1000);
      }
      runStage();
    }, 4000);

    function nat_local() { return new window.AVPlayer(); }
  })();
  var K = {
    OK: 1073741994, REC: 210, STOP: 413, PLAY: 415, FF: 417, RW: 412,
    MENU: 1073742338, APPS: 1073741974, BACK: 213, EXIT: 203,
    UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, GUIDE: 224,
    CHUP: 1073741869, CHDN: 1073741867,
    // colour buttons, captured from the remote (0x193..0x196)
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
  };

  var seq = 0, t = null, hw = null, nat = null, ready = false;
  var lcns = [], current = null, live = false;
  var digits = "", digitTimer = null;
  var state = "LIVE";                 // LIVE | MENU | LIST | SETTINGS | PLAYBACK
  var tab = 0;                        // 0 = Recordings, 1 = Settings
  var TABS = ["Recordings", "Timers", "Guide Settings", "Rec Settings"];
  var setSel = 0;
  var settings = { use_xmltv: true, pre_pad: 2, post_pad: 5, mark_viewed: true, viewed_pct: 90,
                   maint_free_gb: 40, protect_hours: 24,
                   maint_enabled: false, maint_dryrun: true,
                   ts_enabled: false, ts_buffer_min: 30, guide_city: "Adelaide",
                   timezone: "Adelaide" };

  // Fallback only: the live list is scraped from the provider's index page by
  // xmltv-refresh.sh into /root/guide_cities.txt and loaded at boot.
  var GUIDE_CITIES = ["Adelaide", "Brisbane", "Canberra", "Darwin", "Hobart", "Melbourne",
                      "Perth", "Sydney", "Ballarat", "Bendigo", "Cairns", "Geelong",
                      "Launceston", "Newcastle", "Toowoomba", "Wollongong"];
  var guideCities = GUIDE_CITIES.slice();

  function loadGuideCities() {
    var txt = readTextFile("/root/guide_cities.txt");
    if (!txt) return;
    var out = String(txt).split("\n").map(function (l) { return l.replace(/\r/g, "").trim(); })
                 .map(function (l) { return l.replace(/\.xml$/i, ""); })
                 .filter(function (l) { return /^[A-Za-z0-9_]{3,32}$/.test(l); });
    if (out.length >= 5) {
      guideCities = out;
      report("guide_cities", { count: out.length, first: out.slice(0, 6) });
    }
  }

  function cityLabel(c) { return String(c || "").replace(/_/g, " "); }
  var viewed = {};                    // recordingId -> epoch ms marked as watched
  var VIEWED_PATH = "/root/hermes_viewed.json";
  var timers = [], timSel = 0;
  var TIMERS_PATH = "/root/hermes_timers.txt";
  var TIMER_LOG = "/root/hermes_timer_log.txt";
  var xmltv = { enabled: null, last_ok: 0, size: 0, note: "", checked: 0 };
  var SETTINGS_PATH = "/root/hermes_settings.txt";
  var XMLTV_STATUS = "/root/xmltv/status.txt";

  // recording state
  var recId = null, recHandle = null, recLcn = null, recName = null, recSince = 0;
  var recEndAt = 0;      // ms; EIT programme end + post pad for a manual REC, 0 = no limit
  var recEndTimer = null;

  // playback state
  var pbIndex = null, pbTotal = 0, pbPaused = false;

  // UI
  var ui = null, uiTimer = null, msg = null, msgTimer = null, statusLine = null;
  var pbEl = null, pbHideTimer = null;
  var items = [], sel = 0, totalCount = 0;

  var names = {};                     // recordingId -> programme/channel label
  var recChannel = {};                // recordingId -> "23 ABC Entertains" (our own recordings)
  var recEp = {};                     // recordingId -> "S01E02" when the guide knew it
  var recSub = {};                    // recordingId -> episode title, fallback identity
  var recDay = {};                    // recordingId -> YYYYMMDD (Adelaide) recorded

  function writeChunked(path, text) {
    try {
      var p = new window.AVPlayer();
      try { p.Ag_textFile_remove(path); } catch (e) {}
      var fd = p.Ag_textFile_open(path);
      if (fd == -1) return false;
      var chunks = String(text).match(/[\s\S]{1,200}/g) || [];
      for (var i = 0; i < chunks.length; i++) {
        p.Ag_textFile_write(fd, chunks[i], chunks[i].length);
      }
      p.Ag_textFile_close(fd);
      return true;
    } catch (e) { return false; }
  }

  function report(tag, data) {
    seq++;
    var name = "ui_" + ("000" + seq).slice(-3) + "_" + tag + ".json";
    var payload = JSON.stringify({ tag: tag, at: Date.now(), data: data });
    // chunked: a single Ag_textFile_write fails on larger payloads
    writeChunked("/root/" + name, payload);
  }

  // A throwing key handler is invisible on this box (no console): a hoisted local
  // var shadowed step(dir) and silently disabled CH+/CH- with no visible symptom.
  // Report uncaught errors so that kind of failure can never hide again.
  var errN = 0;
  window.onerror = function (msg, src, line) {
    try {
      if (errN++ < 20) {
        report("js_error", { msg: String(msg).slice(0, 120), line: line, where: String(src || "").slice(-40) });
      }
    } catch (e) {}
    return false;
  };

  function padR(s, n) { s = String(s); while (s.length < n) s += " "; return s; }
  function padL(s, n) { s = String(s); while (s.length < n) s = " " + s; return s; }

  // ---------- name persistence ----------
  // names{} is keyed by recording id. Without this it lived only in memory, so
  // every recording reverted to "REC <id>" after a reboot.
  var NAMES_PATH = "/root/hermes_rec_names.txt";

  function readTextFile(path) {
    try {
      var p = new window.AVPlayer();
      var fd = p.Ag_textFile_open(path);
      if (fd == -1) return null;
      var out = "", chunk = "", guard = 0;
      // Ag_textFile_read(fd, 512) returns a chunk, "0" at EOF
      while (guard++ < 5000) {
        chunk = String(p.Ag_textFile_read(fd, 512));
        if (chunk == "0" || !chunk) break;
        out += chunk;
      }
      try { p.Ag_textFile_close(fd); } catch (e) {}
      return out;
    } catch (e) { return null; }
  }

  // The firmware only accepts small writes, so chunk and verify. A single long
  // Ag_textFile_write silently truncated this file to 7 bytes once.
  function writeTextFile(path, text) {
    try {
      var s = String(text);
      var p = new window.AVPlayer();
      try { p.Ag_textFile_remove(path); } catch (e) {}
      var fd = p.Ag_textFile_open(path);
      if (fd == -1) return false;
      var chunks = s.match(/[\s\S]{1,200}/g) || [];
      for (var i = 0; i < chunks.length; i++) {
        p.Ag_textFile_write(fd, chunks[i], chunks[i].length);
      }
      p.Ag_textFile_close(fd);
      var back = readTextFile(path);
      return back !== null && back.replace(/\s+$/, "") === s.replace(/\s+$/, "");
    } catch (e) { return false; }
  }

  // ---------- SQL metadata (programme names for pre-existing recordings) ------
  // /mnt/usb1/sql_backup_recordings.txt is a plaintext dump: one INSERT per
  // recording, meta_data JSON holding channelName/channelNumber/name/size.
  // The PVR index exposes only id/duration/size, so size is the join key.
  var SQL_PATH = "/mnt/usb1/sql_backup_recordings.txt";
  var sqlBySize = {};

  function sqlField(row, field) {
    var re = new RegExp('""' + field + '"":\\s*(?:""([^"]*)""|(\\d+)|(true|false))');
    var m = re.exec(row);
    if (!m) return null;
    if (m[1] !== undefined) return m[1];
    if (m[2] !== undefined) return m[2];
    return m[3];
  }

  function loadSqlNames() {
    var txt = readTextFile(SQL_PATH);
    if (!txt) { report("sql_missing", {}); return; }
    var rows = String(txt).split("INSERT INTO recordings(");
    var n = 0;
    for (var i = 1; i < rows.length; i++) {
      var sz = sqlField(rows[i], "size");
      if (!sz) continue;
      var nm = sqlField(rows[i], "name");
      if (!nm) continue;
      sqlBySize[sz] = {
        name: nm,
        channel: sqlField(rows[i], "channelName"),
        num: sqlField(rows[i], "channelNumber"),
        start: sqlField(rows[i], "startDate")
      };
      n++;
    }
    report("sql_loaded", { rows: n, bytes: String(txt).length });
  }

  // The web page is built by a shell script that walks /mnt/usb1/PVR and reads each
  // recording's id out of its .mda sidecar. Titles live here, so dump them keyed by
  // id: label | channel | ep | day | when | dur | sizeKB | viewed
  var WEB_META = "/root/hermes_web_meta.txt";

  function writeWebMeta() {
    var n = 0;
    try { n = Number(hw.getRecordingCount()) || 0; } catch (e) { return; }
    if (!n) return;
    var lines = [];
    for (var i = 0; i < n; i++) {
      var it = buildItem(i);
      if (!it || !it.id) continue;
      var label = labelFor(it).replace(/[\t\r\n]/g, " ");
      var ch = String(it.channel || "").replace(/[\t\r\n]/g, " ");
      var ep = String(it.ep || it.episode || "").replace(/[\t\r\n]/g, " ");
      var day = String(it.when || "").replace(/[\t\r\n]/g, " ");
      var seen = viewed[it.id] ? "1" : "0";
      lines.push([it.id, label, ch, ep, day, it.dur || "", Math.round((it.sizeRaw || 0)),
                  seen].join("\t"));
    }
    writeTextFile(WEB_META, lines.join("\n") + "\n");
    report("web_meta", { rows: lines.length });
  }

  function loadNames() {
    var txt = readTextFile(NAMES_PATH);
    if (!txt) return;
    var lines = String(txt).split("\n");
    var n = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/\r/g, "");
      if (!ln) continue;
      // TAB separated: id <TAB> label [<TAB> channel]
      var f = ln.split("\t");
      if (f.length < 2 || !f[0] || !f[1]) continue;
      names[f[0]] = f[1];
      if (f[2]) recChannel[f[0]] = f[2];
      if (f[3]) recEp[f[0]] = f[3];
      if (f[4]) recDay[f[0]] = f[4];
      if (f[5]) recSub[f[0]] = f[5];
      n++;
    }
    report("names_loaded", { count: n });
  }

  function saveNames() {
    var out = [];
    for (var k in names) {
      if (!names.hasOwnProperty(k)) continue;
      var clean = function (s) { return String(s == null ? "" : s).replace(/[\t|\r\n]/g, " ").trim(); };
      out.push(clean(k) + "\t" + clean(names[k]) + "\t" + clean(recChannel[k] || "") +
               "\t" + clean(recEp[k] || "") + "\t" + clean(recDay[k] || "") +
               "\t" + clean(recSub[k] || ""));
    }
    var text = out.join("\n");
    var okv = writeTextFile(NAMES_PATH, text);
    report("names_saved", { entries: out.length, len: text.length, verified: okv });
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return h > 0 ? h + ":" + p2(m) + ":" + p2(s) : p2(m) + ":" + p2(s);
  }

  function fmtSize(kb) {
    kb = Number(kb) || 0;
    if (kb > 1024 * 1024) return (kb / 1024 / 1024).toFixed(2) + " GB";
    if (kb > 1024) return (kb / 1024).toFixed(0) + " MB";
    return kb + " KB";
  }

  // ---------- UI ----------
  function ensureUI() {
    if (ui) return ui;
    ui = document.createElement("div");
    ui.dataset.hermesOurs = "1";
    ui.style.cssText =
      "position:fixed;left:50px;top:50px;right:50px;bottom:50px;display:none;z-index:2147483646;" +
      "background:rgba(0,12,4,0.92);border:2px solid #00ff66;color:#00ff66;" +
      "font:22px/1.40 monospace;padding:22px 26px;box-sizing:border-box;overflow:hidden;" +
      "white-space:pre";
    document.body.appendChild(ui);
    return ui;
  }

  function toast(text, ms) {
    if (!msg) {
      msg = document.createElement("div");
      msg.dataset.hermesOurs = "1";
      msg.style.cssText =
        "position:fixed;left:60px;bottom:60px;padding:16px 26px;background:rgba(0,12,4,0.92);" +
        "border:2px solid #00ff66;color:#00ff66;font:28px monospace;border-radius:8px;" +
        "z-index:2147483647;pointer-events:none;display:none;white-space:pre";
      document.body.appendChild(msg);
    }
    msg.textContent = text;
    msg.style.display = "block";
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { try { msg.style.display = "none"; } catch (e) {} }, ms || 2600);
  }

  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function fmtDate(ms) {
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return "";
    var y = String(d.getFullYear());
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + y.slice(2);
  }

  function fmtClock(sec) {
    var d = new Date(Number(sec) * 1000);
    if (isNaN(d.getTime())) return "-";
    return p2(d.getHours()) + ":" + p2(d.getMinutes());
  }

  // ---------- settings + guide cache status ----------
  function loadSettings() {
    settings.use_xmltv = true;               // default ON
    var txt = readTextFile(SETTINGS_PATH);
    if (txt) {
      var lines = String(txt).split("\n");
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r/g, "");
        if (ln.indexOf("use_xmltv=") === 0) {
          settings.use_xmltv = ln.slice("use_xmltv=".length).trim() !== "0";
        } else if (ln.indexOf("pre_pad=") === 0) {
          var pv = Number(ln.slice("pre_pad=".length).trim());
          if (!isNaN(pv)) settings.pre_pad = Math.max(0, Math.min(30, pv));
        } else if (ln.indexOf("post_pad=") === 0) {
          var qv = Number(ln.slice("post_pad=".length).trim());
          if (!isNaN(qv)) settings.post_pad = Math.max(0, Math.min(30, qv));
        } else if (ln.indexOf("mark_viewed=") === 0) {
          settings.mark_viewed = ln.slice("mark_viewed=".length).trim() !== "0";
        } else if (ln.indexOf("maint_free_gb=") === 0) {
          var mv = Number(ln.slice("maint_free_gb=".length).trim());
          // the UI stops at 200 GB, but allow a higher target from the file so
          // the cleanup path can be exercised without filling the disk
          if (!isNaN(mv)) settings.maint_free_gb = Math.max(0, Math.min(900, mv));
        } else if (ln.indexOf("maint_enabled=") === 0) {
          settings.maint_enabled = ln.slice("maint_enabled=".length).trim() !== "0";
        } else if (ln.indexOf("maint_dryrun=") === 0) {
          settings.maint_dryrun = ln.slice("maint_dryrun=".length).trim() !== "0";
        } else if (ln.indexOf("guide_city=") === 0) {
          var gc = ln.slice("guide_city=".length).trim();
          if (/^[A-Za-z0-9_]{3,32}$/.test(gc)) settings.guide_city = gc;
        } else if (ln.indexOf("timezone=") === 0) {
          var tz = ln.slice("timezone=".length).trim();
          if (TZ_ZONES.indexOf(tz) >= 0) settings.timezone = tz;
        } else if (ln.indexOf("ts_enabled=") === 0) {
          settings.ts_enabled = ln.slice("ts_enabled=".length).trim() !== "0";
        } else if (ln.indexOf("ts_buffer_min=") === 0) {
          var tv = Number(ln.slice("ts_buffer_min=".length).trim());
          if (!isNaN(tv)) settings.ts_buffer_min = Math.max(5, Math.min(240, tv));
        } else if (ln.indexOf("protect_hours=") === 0) {
          var hv = Number(ln.slice("protect_hours=".length).trim());
          if (!isNaN(hv)) settings.protect_hours = Math.max(0, Math.min(168, hv));
        } else if (ln.indexOf("viewed_pct=") === 0) {
          var rv = Number(ln.slice("viewed_pct=".length).trim());
          if (!isNaN(rv)) settings.viewed_pct = Math.max(50, Math.min(99, rv));
        }
      }
    }
    // first boot with a timezone setting: persist the default so the file lists it
    if (!/^timezone=/m.test(String(txt || ""))) { try { saveSettings(); } catch (e) {} }
    loadXmltvStatus();
    report("settings_loaded", {
      use_xmltv: settings.use_xmltv, pre_pad: settings.pre_pad, post_pad: settings.post_pad,
      mark_viewed: settings.mark_viewed, viewed_pct: settings.viewed_pct,
      maint_free_gb: settings.maint_free_gb, protect_hours: settings.protect_hours,
      maint_enabled: settings.maint_enabled, maint_dryrun: settings.maint_dryrun,
      ts_enabled: settings.ts_enabled, ts_buffer_min: settings.ts_buffer_min,
      guide_city: settings.guide_city, timezone: settings.timezone,
      tz_offset_min: zoneOffsetMinutes(new Date())
    });
  }

  function saveSettings() {
    var text = "use_xmltv=" + (settings.use_xmltv ? "1" : "0") + "\n" +
               "pre_pad=" + settings.pre_pad + "\n" +
               "post_pad=" + settings.post_pad + "\n" +
               "mark_viewed=" + (settings.mark_viewed ? "1" : "0") + "\n" +
               "viewed_pct=" + settings.viewed_pct + "\n" +
               "maint_free_gb=" + settings.maint_free_gb + "\n" +
               "protect_hours=" + settings.protect_hours + "\n" +
               "maint_enabled=" + (settings.maint_enabled ? "1" : "0") + "\n" +
               "maint_dryrun=" + (settings.maint_dryrun ? "1" : "0") + "\n" +
               "ts_enabled=" + (settings.ts_enabled ? "1" : "0") + "\n" +
               "ts_buffer_min=" + settings.ts_buffer_min + "\n" +
               "guide_city=" + settings.guide_city + "\n" +
               "timezone=" + settings.timezone + "\n";
    var okv = writeTextFile(SETTINGS_PATH, text);
    report("settings_saved", {
      use_xmltv: settings.use_xmltv, pre_pad: settings.pre_pad,
      post_pad: settings.post_pad, verified: okv
    });
  }

  // Changing the city has three effects: persist it, ask the fetcher to download
  // now instead of waiting out the 24 h window, and drop the in-memory guide so
  // the grid cannot keep showing the previous city's programmes.
  // Choice rows are generic now: the row's key decides what changes.
  function applyChoice(key, val) {
    if (key === "guide_city") { setGuideCity(val); return; }
    if (key === "timezone") {
      if (settings.timezone === val) return;
      settings.timezone = val;
      saveSettings();
      report("timezone_set", { tz: val, offsetMin: zoneOffsetMinutes(new Date()) });
      toast("TIME ZONE " + String(val).toUpperCase(), 2000);
      // guide data is stored in UTC, so nothing needs re-downloading - only the
      // labels change. Redraw whatever is on screen.
      try { if (state === "LIVE") { osdHide(); eitRefresh(current); } } catch (e) {}
      return;
    }
  }

  function setGuideCity(city) {
    if (guideCities.indexOf(city) < 0) return;
    if (settings.guide_city === city) return;
    settings.guide_city = city;
    saveSettings();
    guideLoaded = false;
    try { writeTextFile("/root/xmltv/refresh_req", "1"); } catch (e) {}
    toast("Guide city: " + cityLabel(city), 2600);
    report("guide_city", { city: city });
  }

  function loadXmltvStatus() {
    xmltv = { enabled: null, last_ok: 0, size: 0, note: "", checked: 0 };
    var txt = readTextFile(XMLTV_STATUS);
    if (!txt) return;
    var lines = String(txt).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/\r/g, "");
      var eq = ln.indexOf("=");
      if (eq <= 0) continue;
      var k = ln.slice(0, eq), v = ln.slice(eq + 1);
      if (k === "enabled") xmltv.enabled = (v === "1");
      else if (k === "last_ok") xmltv.last_ok = Number(v) || 0;
      else if (k === "size") xmltv.size = Number(v) || 0;
      else if (k === "note") xmltv.note = v;
      else if (k === "checked") xmltv.checked = Number(v) || 0;
    }
  }

  // Add new settings here; the pane renders whatever this returns.
  // Two panes: guide settings (feed selection + its cache status) and everything
  // that affects recordings. setPane picks which one the SETTINGS state shows.
  var setPane = 0;   // 0 = guide, 1 = recordings

  function guideSettingsRows() {
    var all = [
      { type: "choice", key: "timezone", label: "Time zone", value: settings.timezone,
        options: TZ_ZONES },
      { type: "toggle", key: "use_xmltv", label: "Use XML TV Guide", value: settings.use_xmltv },
      { type: "choice", key: "guide_city", label: "Guide city", value: settings.guide_city,
        options: guideCities, show: !!settings.use_xmltv },
      { type: "action", key: "guide_refresh", label: "Refresh guide now", value: "ENTER",
        show: !!settings.use_xmltv },
      { type: "blank" },
      { type: "info", label: "Guide cache", value: xmltv.size ? fmtSize(xmltv.size / 1024) : "none" },
      { type: "info", label: "Guide updated", value: xmltv.last_ok ? fmtDate(xmltv.last_ok * 1000) + "  " + fmtClock(xmltv.last_ok) : "-" },
      { type: "info", label: "Guide status", value: xmltv.note || "-" }
    ];
    return all.filter(function (r) { return r.show === undefined || r.show; });
  }

  function recSettingsRows() {
    return [
      { type: "number", key: "pre_pad", label: "Pre-pad (minutes)", value: settings.pre_pad, min: 0, max: 30, step: 1 },
      { type: "number", key: "post_pad", label: "Post-pad (minutes)", value: settings.post_pad, min: 0, max: 30, step: 1 },
      { type: "toggle", key: "mark_viewed", label: "Track viewed recordings", value: settings.mark_viewed },
      { type: "number", key: "viewed_pct", label: "Viewed threshold (%)", value: settings.viewed_pct, min: 50, max: 99, step: 1 },
      { type: "toggle", key: "ts_enabled", label: "Always enable live buffer", value: settings.ts_enabled },
      { type: "number", key: "ts_buffer_min", label: "Buffer length (minutes)", value: settings.ts_buffer_min, min: 5, max: 240, step: 5 },
      { type: "blank" },
      { type: "info", label: "Storage", value: storageText() },
      { type: "toggle", key: "maint_enabled", label: "Auto-delete recordings", value: settings.maint_enabled },
      { type: "number", key: "maint_free_gb", label: "Auto-delete below (GB)", value: settings.maint_free_gb, min: 0, max: 200, step: 5 },
      { type: "number", key: "protect_hours", label: "Protect newest (hours)", value: settings.protect_hours, min: 0, max: 168, step: 1 },
      { type: "toggle", key: "maint_dryrun", label: "Cleanup dry run", value: settings.maint_dryrun },
      { type: "blank" },
      { type: "action", key: "maint_run", label: "Run cleanup now", value: "ENTER" },
      { type: "action", key: "scan_channels", label: "Rescan channels", value: "ENTER" }
    ];
  }

  function settingsRows() {
    return setPane === 1 ? recSettingsRows() : guideSettingsRows();
  }

  // blank rows are separators: skip them when moving the cursor
  function nextSelectable(from, dir) {
    var rows = settingsRows();
    if (!rows.length) return 0;
    var i = from;
    for (var n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      if (rows[i].type !== "blank") return i;
    }
    return from;
  }

  function labelFor(it) {
    if (it.name) return it.name;
    var s = sqlBySize[String(it.sizeRaw)];
    if (s && s.name) return s.name;
    return "REC " + it.id;
  }

  function dateFor(it) {
    var s = sqlBySize[String(it.sizeRaw)];
    if (s && s.start) return fmtDate(s.start);
    return it.when || "";
  }

  // Series/episode tag: only XMLTV carries them (EIT has CRIDs, not numbers), so
  // recordings get one when the guide knew the programme at record time.
  function epFor(it) {
    if (it && it.id != null && recEp[it.id]) return recEp[it.id];
    return "";
  }

  function progAt(lcn, ms) {
    if (!guideLoaded) { try { if (!loadGuide()) return null; } catch (e) { return null; } }
    var arr = guideByLcn[String(lcn)] || [];
    var off = offsetFor(lcn);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].s + off <= ms && arr[i].e + off > ms) return arr[i];
    }
    return null;
  }

  function epForChannelTime(lcn, ms) {
    var p = progAt(lcn, ms);
    return p ? normEp(p.ep) : "";
  }

  function subForChannelTime(lcn, ms) {
    var p = progAt(lcn, ms);
    return p ? (p.sub || "") : "";
  }

  function channelFor(it) {
    var s = sqlBySize[String(it.sizeRaw)];
    if (s && (s.channel || s.num)) {
      return (s.num ? s.num + " " : "") + (s.channel || "");
    }
    // our own recordings carry the channel we recorded from
    return recChannel[it.id] || it.channel || "";
  }

  // tab strip + body container, rebuilt on every render (cheap, always correct)
  function tabBarEl() {
    var bar = document.createElement("div");
    bar.style.display = "flex";
    bar.style.borderBottom = "2px solid #00ff66";
    bar.style.marginBottom = "10px";
    for (var i = 0; i < TABS.length; i++) {
      var sp = document.createElement("span");
      sp.textContent = TABS[i];
      sp.style.padding = "6px 26px";
      sp.style.fontSize = "26px";
      sp.style.color = (i === tab) ? "#001b0a" : "#00ff66";
      sp.style.background = (i === tab) ? "#00ff66" : "transparent";
      bar.appendChild(sp);
    }
    return bar;
  }

  function uiRoot() {
    var root = ensureUI();
    root.style.display = "block";
    // the guide draws edge-to-edge with its own padding reset; restore the
    // normal inset for every menu-style pane
    root.style.padding = "22px 26px";
    root.textContent = "";
    root.appendChild(tabBarEl());
    var body = document.createElement("div");
    body.style.marginTop = "8px";
    root.appendChild(body);
    return body;
  }

  function render() {
    // The lower pane follows the highlighted tab. Inside TIMERS/SETTINGS the
    // state still decides, so entering a section behaves exactly as before; on
    // the menu itself LEFT/RIGHT now previews each pane instead of redrawing the
    // recordings list every time.
    if (state === "MENU") setPane = (tab === 3) ? 1 : 0;   // preview the highlighted tab's pane
    var view = (state === "MENU") ? tab
             : (state === "SETTINGS") ? (setPane === 1 ? 3 : 2)
             : (state === "TIMERS") ? 1 : 0;
    if (view === 2 || view === 3) renderSettings();
    else if (view === 1) renderTimers();
    else renderList();
  }

  function renderSettings() {
    var el = uiRoot();
    function line(t) {
      var d = document.createElement("div");
      d.textContent = t;
      return d;
    }
    function row(label, value, selected) {
      var d = document.createElement("div");
      d.style.display = "flex";
      d.style.alignItems = "baseline";
      var a = document.createElement("span");
      a.textContent = selected ? ">" : " ";
      a.style.flex = "0 0 auto"; a.style.width = "30px";
      var b = document.createElement("span");
      b.textContent = label;
      b.style.flex = "0 0 auto"; b.style.width = "520px";
      var c = document.createElement("span");
      c.textContent = value;
      c.style.flex = "1 1 auto";
      d.appendChild(a); d.appendChild(b); d.appendChild(c);
      if (selected) d.style.color = "#ffffff";
      return d;
    }
    var rows = settingsRows();
    el.appendChild(line(setPane === 1 ? "REC SETTINGS" : "GUIDE SETTINGS"));
    el.appendChild(line(""));
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.type === "blank") {
        var gap = document.createElement("div");
        gap.style.height = "14px";
        el.appendChild(gap);
        continue;
      }
      var val = (r.type === "toggle") ? (r.value ? "ON" : "OFF")
              : (r.type === "choice") ? ("< " + cityLabel(r.value) + " >")
              : (r.type === "number") ? ("< " + r.value + " >") : r.value;
      el.appendChild(row(r.label, val, state === "SETTINGS" && i === setSel));
    }
    showHelp();
  }

  function renderList() {
    var el = uiRoot();

    var windowSize = 12;
    var start = 0;
    if (items.length > windowSize) {
      start = sel - Math.floor(windowSize / 2);
      if (start < 0) start = 0;
      if (start > items.length - windowSize) start = items.length - windowSize;
    }
    var end = Math.min(items.length, start + windowSize);

    // Fixed pixel widths per column: the box's default sans is proportional, so
    // padding with spaces can never line up. Inline-block widths always do.
    var W_NAME = 620, W_DUR = 150, W_SIZE = 170;

    function line(text, color) {
      var d = document.createElement("div");
      d.textContent = text;
      if (color) d.style.color = color;
      return d;
    }

    function row(prefix, name, ch, ep, date, dur, size, selected) {
      var d = document.createElement("div");
      d.style.display = "flex";
      d.style.alignItems = "baseline";
      d.style.whiteSpace = "nowrap";

      function cell(t, w, align, flex) {
        var s = document.createElement("span");
        s.textContent = t || "";
        if (flex) {
          s.style.flex = "1 1 auto";
          s.style.overflow = "hidden";
          s.style.textOverflow = "ellipsis";
          s.style.whiteSpace = "nowrap";
        } else {
          s.style.flex = "0 0 auto";
          s.style.width = w + "px";
        }
        if (align) s.style.textAlign = align;
        return s;
      }

      d.appendChild(cell(prefix, 30, "left", false));
      var nm = cell(name, 0, "left", true);
      d.appendChild(nm);
      d.appendChild(cell(ch, 230, "left", false));
      d.appendChild(cell(ep, 80, "left", false));
      d.appendChild(cell(date, 130, "left", false));
      d.appendChild(cell(dur, 90, "right", false));
      d.appendChild(cell(size, 110, "right", false));
      // highlight the WHOLE row, not just the title
      if (selected) {
        d.style.color = "#ffffff";
        nm.style.color = "#ffffff";
      }
      return d;
    }

    function header() {
      var d = document.createElement("div");
      d.style.display = "flex";
      d.style.alignItems = "baseline";
      d.style.opacity = "0.7";
      d.style.borderBottom = "1px solid #00ff66";
      d.style.marginBottom = "6px";
      function cell(t, w, align, flex) {
        var s = document.createElement("span");
        s.textContent = t;
        if (flex) { s.style.flex = "1 1 auto"; }
        else { s.style.flex = "0 0 auto"; s.style.width = w + "px"; }
        if (align) s.style.textAlign = align;
        return s;
      }
      d.appendChild(cell("", 30, "left", false));
      d.appendChild(cell("PROGRAMME", 0, "left", true));
      d.appendChild(cell("CHANNEL", 230, "left", false));
      d.appendChild(cell("EP", 80, "left", false));
      d.appendChild(cell("DATE", 130, "left", false));
      d.appendChild(cell("LENGTH", 90, "right", false));
      d.appendChild(cell("SIZE", 110, "right", false));
      return d;
    }

    el.appendChild(line("RECORDINGS   " + items.length + " of " + totalCount + (loadCursor < totalCount ? "   (loading)" : "")));
    el.appendChild(line(""));
    el.appendChild(header());
    if (start > 0) el.appendChild(line("     ^ " + start + " more"));
    for (var i = start; i < end; i++) {
      var it = items[i];
      var selRow = (state === "LIST") && (i === sel);
      var rowEl = row(
        (selRow ? ">" : " "),
        labelFor(it),
        channelFor(it),
        epFor(it),
        dateFor(it),
        it.dur,
        it.size,
        selRow
      );
      // watched recordings sit dimmer so unwatched ones stand out
      if (!selRow && viewed[String(it.id)]) rowEl.style.color = "#0a8a3a";
      el.appendChild(rowEl);
    }
    if (end < items.length) el.appendChild(line("     v " + (items.length - end) + " more"));
    showHelp();
  }

  var helpEl = null;

  function showHelp() {
    if (!helpEl) {
      helpEl = document.createElement("div");
      helpEl.dataset.hermesOurs = "1";
      helpEl.style.cssText =
        "position:fixed;left:0;right:0;bottom:26px;text-align:center;z-index:2147483647;" +
        "pointer-events:none";
      var inner = document.createElement("span");
      inner.dataset.hermesOurs = "1";
      inner.style.cssText =
        "display:inline-block;padding:10px 26px;background:rgba(0,12,4,0.92);" +
        "border:2px solid #00ff66;border-radius:8px;color:#00ff66;font:22px monospace";
      helpEl.appendChild(inner);
      document.body.appendChild(helpEl);
    }
    helpEl.firstChild.textContent =
      state === "GUIDE" ? "UP/DOWN channel   LEFT/RIGHT time   RECORD timer   OK watch   BACK close" :
      state === "TIMERS" ? "UP/DOWN move    OK series link    RECORD delete    BACK menu" :
      state === "LIST" ? "UP/DOWN move    LEFT/RIGHT page    OK play    RECORD delete    BACK menu" :
      state === "SETTINGS" ? "UP/DOWN move    LEFT/RIGHT change    OK toggle    BACK menu" :
      "LEFT/RIGHT switch    OK enter    BACK close";
    helpEl.style.display = "block";
  }

  function hideHelp() {
    if (helpEl) helpEl.style.display = "none";
  }

  function hideList() {
    if (ui) ui.style.display = "none";
    hideHelp();
  }


  // ---------- viewed recording tracking ----------
  function loadViewed() {
    viewed = {};
    var txt = readTextFile(VIEWED_PATH);
    if (!txt) return;
    var o = null;
    try { o = JSON.parse(String(txt)); } catch (e) { o = null; }
    if (!o || typeof o !== "object") return;
    for (var k in o) if (o.hasOwnProperty(k)) viewed[k] = Number(o[k]) || 1;
  }

  function saveViewed() {
    writeTextFile(VIEWED_PATH, JSON.stringify(viewed));
  }

  // Sticky: once marked, rewinding below the threshold does not clear it.
  function markViewed(id) {
    if (id === null || id === undefined) return false;
    var k = String(id);
    if (viewed[k]) return false;
    viewed[k] = Date.now();
    saveViewed();
    report("viewed_mark", { id: k });
    return true;
  }

  function checkViewed() {
    if (!settings.mark_viewed || pbId === null || pbId === undefined) return;
    var cur = 0, tot = 0;
    try { cur = Number(nat.Ag_playBack_getCurrentTime()) || 0; } catch (e) { return; }
    try { tot = Number(nat.Ag_playBack_getTotalTime()) || 0; } catch (e) { return; }
    if (tot <= 0) return;                       // corrupt/partial file
    var pct = Number(settings.viewed_pct) || 90;
    if ((cur / tot) * 100 >= pct) markViewed(pbId);
  }

  // text form, used by reports/tests only - the OSD itself is DOM-built above
  function pbText() {
    var s = pbStats();
    var width = 44, filled = Math.round((s.pct / 100) * width), bar = "";
    for (var i = 0; i < width; i++) bar += (i < filled ? "=" : "-");
    return [
      (pbPaused ? "Paused: " : "Playing: ") + s.title,
      "[" + bar + "] " + s.pct + "%",
      fmtDur(s.cur) + " / " + fmtDur(s.tot) + "    " + s.fin
    ].join("\n");
  }

  // The progress bar is drawn as nested blocks, not characters: the SUI's font is
  // not reliably monospace, so a "===---" string changes width as the fill
  // advances and the whole box twitches once a second. Blocks cannot.
  var pbEls = null;

  // One layout builder for both OSDs (recording playback and live buffer) so the
  // two are indistinguishable: title row, trough + percentage, then two columns
  // pinned to the box edges.
  function makeOsdBox(bottomPx) {
    var el = document.createElement("div");
    el.dataset.hermesOurs = "1";
    el.style.cssText =
      "position:fixed;left:50%;bottom:" + bottomPx + "px;transform:translateX(-50%);" +
      "width:720px;display:none;z-index:2147483646;background:rgba(0,12,4,0.92);" +
      "border:2px solid #00ff66;color:#00ff66;font:24px/1.45 monospace;" +
      "padding:14px 20px;box-sizing:border-box;border-radius:8px";

    var title = document.createElement("div");
    title.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#00ff66";

    var row2 = document.createElement("div");
    row2.style.cssText = "display:flex;align-items:center;gap:14px;margin:9px 0";
    var trough = document.createElement("div");
    trough.style.cssText = "flex:1 1 auto;height:20px;border:2px solid #00ff66;" +
      "box-sizing:border-box;overflow:hidden";
    var fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:0%;background:#00ff66";
    trough.appendChild(fill);
    var pct = document.createElement("div");
    pct.style.cssText = "flex:0 0 84px;text-align:right;color:#00ff66";
    row2.appendChild(trough);
    row2.appendChild(pct);

    var row3 = document.createElement("div");
    row3.style.cssText = "display:flex;justify-content:space-between;gap:24px;color:#00ff66";
    var time = document.createElement("div");
    var extra = document.createElement("div");
    row3.appendChild(time);
    row3.appendChild(extra);

    el.appendChild(title);
    el.appendChild(row2);
    el.appendChild(row3);
    document.body.appendChild(el);
    return { el: el, title: title, fill: fill, pct: pct, time: time, fin: extra };
  }

  function ensurePb() {
    if (pbEl) return pbEl;
    var box = makeOsdBox(70);
    pbEl = box.el;
    pbEls = box;
    return pbEl;
  }

  // one source of truth for the numbers, shared by the OSD and the test reports
  function pbStats() {
    var cur = 0, tot = pbTotal;
    try { cur = nat.Ag_playBack_getCurrentTime(); } catch (e) {}
    try { tot = nat.Ag_playBack_getTotalTime(); } catch (e) {}
    // while a seek is queued the decoder still reports the old position, so show
    // where the user has actually asked to go
    if (seekPending) cur = seekTarget;
    tot = Number(tot) || 0;
    cur = Number(cur) || 0;
    var pct = tot > 0 ? Math.min(100, Math.floor((cur / tot) * 100)) : 0;
    return {
      cur: cur, tot: tot, pct: pct,
      title: (names[pbId] || (pbItem ? labelFor(pbItem) : "") || ("REC " + pbNum)),
      fin: tot > 0 ? "Finishes at " + fmtEitClock(Date.now() + Math.max(0, tot - cur) * 1000) : ""
    };
  }

  // Panel appears for 3 s then hides; re-shown on pause/seek so the user can see
  // where they are without it sitting on the picture permanently.
  function showPbOsd() {
    var el = ensurePb();
    el.style.display = "block";
    if (pbHideTimer) clearTimeout(pbHideTimer);
    pbHideTimer = setTimeout(function () {
      try { el.style.display = "none"; } catch (e) {}
    }, 3000);
  }

  function renderPlayback(show) {
    ensurePb();
    var s = pbStats();
    pbEls.title.textContent = (pbPaused ? "Paused: " : "Playing: ") + s.title;
    pbEls.fill.style.width = s.pct + "%";
    pbEls.pct.textContent = s.pct + "%";
    pbEls.time.textContent = fmtDur(s.cur) + " / " + fmtDur(s.tot);
    pbEls.fin.textContent = s.fin;
    if (show !== false) showPbOsd();
  }

  function hidePb() {
    if (pbHideTimer) { clearTimeout(pbHideTimer); pbHideTimer = null; }
    if (pbEl) pbEl.style.display = "none";
  }

  function hideSUI() {
    try {
      if (t && t.surfaceManager) {
        ["OFFLINE_LAUNCH", "SPLASH", "PRE_SPLASH", "SETTINGS_NETWORK", "MODAL"].forEach(function (s) {
          try { t.surfaceManager.hideSurface(s); } catch (e) {}
        });
      }
      var kids = document.body.children;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].dataset && kids[i].dataset.hermesOurs) continue;
        kids[i].setAttribute("data-hermes-hide", "1");
        kids[i].style.display = "none";
      }
      var c = document.querySelectorAll("canvas");
      for (var j = 0; j < c.length; j++) c[j].style.display = "none";
    } catch (e) {}
  }

  // ---------- live TV ----------
  function tune(lcn, silent) {
    if (!lcn && lcns.length) lcn = lcns[0];
    if (!lcn) { report("tune_no_channel", {}); return; }   // never throw on an empty list
    if (tsActive) { tsStop("retune"); tsMode = "off"; tsHide(); }
    try { nat.Ag_dvb_stop(0); } catch (e) { try { nat.Ag_dvb_stop_sync(0); } catch (e2) {} }
    setTimeout(function () {
      try {
        hw.playDvb({ lcn: lcn, scope: hw, callback: function () { live = true; } });
      } catch (e) { report("tune_error", String(e).slice(0, 80)); }
      // EIT lives in the mux and takes a moment after a retune, so retry a
      // couple of times rather than giving up if the tables aren't there yet.
      setTimeout(function () {
        function attempt(n) {
          var nowEv = eitRefresh(lcn);
          var nextEv = eitNextRefresh(lcn);
          if (state === "LIVE" && (nowEv || nextEv)) {
            // The multiplex's present event is decoded a cycle or two after a
            // retune (worst at boot), so "now" can be missing while "next" is
            // already there. Show what we have, then patch "now" in when it lands.
            channelOsdShow(lcn, nowEv, nextEv, nowEv ? 6000 : 9000);
            if (!nowEv) pollPresent(lcn, 8);
            return;
          }
          if (n > 0) setTimeout(function () { attempt(n - 1); }, 3000);
        }
        attempt(2);
      }, 3000);
    }, 300);
    if (!silent) toast("CH " + lcn);
    if (settings.ts_enabled) {
      setTimeout(function () { if (state === "LIVE") tsEnsureBuffer(); }, 3500);
    }
  }

  function step(dir) {
    if (!lcns.length) return;
    var idx = lcns.indexOf(Number(current));
    if (idx < 0) idx = 0;
    current = lcns[(idx + dir + lcns.length) % lcns.length];
    tune(current, true);
    toast("CH " + current);
  }

  function commitDigits() {
    if (!digits) return;
    var n = Number(digits); digits = "";
    if (digitTimer) { clearTimeout(digitTimer); digitTimer = null; }
    if (lcns.indexOf(n) >= 0) { current = n; tune(n, true); toast("CH " + n); }
    else toast("NO CH " + n);
  }

  var chNameCache = {};   // lcn -> short service name (native call, so cache it)
  function channelName(lcn) {
    var ck = String(lcn);
    if (chNameCache.hasOwnProperty(ck)) return chNameCache[ck];
    try {
      var s = nat.Ag_dvb_GetChannelNameByIndex(0, lcn);
      if (!s) return null;                       // not cached: the tuner may not be ready yet
      var o = JSON.parse(s);
      var n = o.channelName0 || o.channelName1 || null;
      if (n) chNameCache[ck] = n;
      return n;
    } catch (e) { return null; }
  }

  // ---------- EIT: programme titles straight off the multiplex ----------
  // Ag_dvb_getPresentEvent(0, lcn, "eng") returns JSON:
  //   startTime "2026-11-11 8:30:30"  (NOT zero-padded), duration (s),
  //   eventName, shortDec, programCrid, seriesCrid
  // EIT travels inside the mux, so it only describes services on the tuned
  // multiplex - refresh after every channel change and every ~30 s.
  var eitCache = {};

  function parseEit(raw) {
    if (!raw) return null;
    var s = String(raw);
    if (s === "0" || s === "undefined" || s === "null") return null;
    var o = null;
    try { o = JSON.parse(s); } catch (e) { return null; }
    if (!o || !o.eventName) return null;
    var start = null;
    try {
      var parts = String(o.startTime).split(" ");
      var dmy = parts[0].split("-"), hms = parts[1].split(":");
      // Date.UTC keeps this independent of the box timezone: EIT carries
      // broadcast wall-clock, and every reader treats the result as UTC.
      start = Date.UTC(
        Number(dmy[0]), Number(dmy[1]) - 1, Number(dmy[2]),
        Number(hms[0]), Number(hms[1]), Number(hms[2] || 0)
      );
    } catch (e) {}
    return {
      name: o.eventName,
      start: start,
      duration: Number(o.duration) || 0,
      desc: o.shortDec || null
    };
  }

  function eitRefresh(lcn) {
    if (!nat || typeof nat.Ag_dvb_getPresentEvent !== "function") return null;
    var now = null;
    try { now = parseEit(nat.Ag_dvb_getPresentEvent(0, lcn, "eng")); } catch (e) { return null; }
    if (now) eitCache[lcn] = now;
    return now;
  }

  function eitNow(lcn) {
    return eitCache[lcn] || eitRefresh(lcn);
  }

  function eitStart() {
    if (!nat || typeof nat.Ag_dvb_EITScanStart !== "function") return;
    try { nat.Ag_dvb_EITScanStart(0); } catch (e) { report("eit_scan_error", String(e).slice(0, 80)); }
    eitRefresh(current);
    setInterval(function () {
      if (state === "LIVE") eitRefresh(current);
    }, 30000);
  }

  // Local wall-clock time for the OSD. The box clock is UTC, EIT start times are
  // broadcast local time, so convert for display (Adelaide: +9:30 ACST, +10:30 ACDT).
  function p2(n) { return (n < 10 ? "0" : "") + n; }

  // Display time zone. The box clock is UTC and always will be; this only decides
  // how UTC instants are shown (OSD clock, guide labels, timer list, Finishes at).
  // std/dst are minutes east of UTC. Zones where the two are equal have no DST.
  var TZ_ZONES = ["Adelaide", "Brisbane", "Canberra", "Darwin", "Hobart",
                  "Melbourne", "Perth", "Sydney", "UTC"];
  var TZ_INFO = {
    Adelaide:  { std: 570, dst: 630 },
    Brisbane:  { std: 600, dst: 600 },
    Canberra:  { std: 600, dst: 660 },
    Darwin:    { std: 570, dst: 570 },
    Hobart:    { std: 600, dst: 660 },
    Melbourne: { std: 600, dst: 660 },
    Perth:     { std: 480, dst: 480 },
    Sydney:    { std: 600, dst: 660 },
    UTC:       { std: 0,   dst: 0 }
  };

  function zoneOffsetMinutes(d) {
    var info = TZ_INFO[settings.timezone] || TZ_INFO.Adelaide;
    if (info.std === info.dst) return info.std;      // no DST in this zone
    // southern-Australian DST: first Sunday in October -> first Sunday in April
    function firstSunday(y, month) {
      var t = new Date(Date.UTC(y, month, 1));
      var add = (7 - t.getUTCDay()) % 7;
      return new Date(Date.UTC(y, month, 1 + add));
    }
    var y = d.getUTCFullYear();
    var start = firstSunday(y, 9);   // October
    var end = firstSunday(y, 3);     // April
    var t = d.getTime();
    var isDst = (t >= start.getTime()) || (t < end.getTime());
    return isDst ? info.dst : info.std;
  }

  // Always 24-hour "HH:MM". Derive it directly rather than via
  // toLocaleTimeString: this Chromium build ignores the hour12 hint and can
  // return a 12-hour string, which is what made the OSD show AM/PM.
  function localTimeStr() {
    var d = new Date();
    var off = zoneOffsetMinutes(d);
    var t = new Date(d.getTime() + off * 60000);
    return p2(t.getUTCHours()) + ":" + p2(t.getUTCMinutes());
  }

  var eitNextCache = {};

  function eitNextRefresh(lcn) {
    if (!nat || typeof nat.Ag_dvb_getNextEvent !== "function") return null;
    var nx = null;
    try { nx = parseEit(nat.Ag_dvb_getNextEvent(0, lcn, "eng")); } catch (e) { return null; }
    if (nx) eitNextCache[lcn] = nx;
    return nx;
  }

  // DVB EIT start times are UTC (EN 300 468), not broadcast local time, so they
  // need the same Adelaide conversion as the XMLTV guide. Printing them raw made
  // "next at 19:00" read as 08:30.
  function fmtEitClock(ms) {
    if (!ms) return null;
    var off = zoneOffsetMinutes(new Date(ms));
    var d = new Date(ms + off * 60000);
    return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
  }

  var osdEl = null, osdTimer = null;
  var osdLcn = 0, osdUntil = 0;   // which channel the visible banner belongs to, and for how long

  // A <table> rather than a CSS grid: table cells align columns with no
  // dependency on the font, and table layout is supported everywhere. Grid
  // looked correct but never appeared on the box.
  function ensureOsd() {
    if (osdEl) return osdEl;
    osdEl = document.createElement("div");
    osdEl.dataset.hermesOurs = "1";
    osdEl.style.cssText =
      "position:fixed;left:60px;bottom:60px;padding:16px 26px;background:rgba(0,12,4,0.92);" +
      "border:2px solid #00ff66;color:#00ff66;font:28px monospace;border-radius:8px;" +
      "z-index:2147483647;pointer-events:none;display:none";
    document.body.appendChild(osdEl);
    return osdEl;
  }

  function channelOsdShow(lcn, now, next, ms) {
    try {
      var el = ensureOsd();
      el.textContent = "";
      var tbl = document.createElement("table");
      tbl.style.borderCollapse = "collapse";
      // The SUI stylesheet styles td/table elements, so colour and size do NOT
      // inherit here — set them explicitly on the table and every cell.
      tbl.style.color = "#00ff66";
      tbl.style.font = "28px monospace";
      function row(a, b, c) {
        var tr = document.createElement("tr");
        var cells = [a, b, c];
        for (var i = 0; i < cells.length; i++) {
          var td = document.createElement("td");
          td.textContent = cells[i];
          td.style.paddingRight = "28px";
          td.style.whiteSpace = "nowrap";
          td.style.verticalAlign = "top";
          td.style.color = "#00ff66";
          td.style.fontSize = "28px";
          td.style.fontFamily = "monospace";
          td.style.lineHeight = "1.35";
          td.style.background = "transparent";
          tr.appendChild(td);
        }
        tbl.appendChild(tr);
      }
      row(localTimeStr(), "CH " + lcn, "Now: " + ((now && now.name) ? now.name : "-"));
      var nextLine;
      if (next && next.name) {
        var at = fmtEitClock(next.start);
        nextLine = at ? ("Next at " + at + ": " + next.name) : ("Next: " + next.name);
      } else {
        nextLine = "Next: -";
      }
      row("", "", nextLine);
      el.appendChild(tbl);
      el.style.display = "block";
      osdLcn = lcn;
      osdUntil = Date.now() + (ms || 6000);
      if (osdTimer) clearTimeout(osdTimer);
      osdTimer = setTimeout(function () { try { el.style.display = "none"; } catch (e) {} }, ms || 6000);
      report("osd_show", { lcn: lcn, now: !!(now && now.name), next: !!(next && next.name) });
    } catch (e) {
      report("osd_error", String(e).slice(0, 120));
    }
  }

  // Re-show the Now/Next banner on demand (DOWN while watching live). Refresh
  // the EIT caches first: after a retune the tables may not have arrived when the
  // user asks, and a stale/empty cache would paint "Next: -".
  function reshowOsd() {
    if (!current) return;
    var now = eitRefresh(current);
    var next = eitNextCache[current];
    if (!next) next = eitNextRefresh(current);
    channelOsdShow(current, now || eitCache[current], next, now ? 6000 : 9000);
    if (!now) pollPresent(current, 8);
  }

  // Patch a missing "Now" into the banner that is already on screen. Without
  // this, a banner shown before the present event decoded stayed "Now: -" until
  // the owner changed channel and came back.
  function pollPresent(lcn, tries) {
    if (tries <= 0) return;
    setTimeout(function () {
      if (osdLcn !== lcn || Date.now() > osdUntil) return;
      var ev = null;
      try { ev = eitRefresh(lcn); } catch (e) {}
      if (ev && ev.name) {
        var nx = eitNextCache[lcn] || eitNextRefresh(lcn);
        channelOsdShow(lcn, ev, nx, Math.max(2000, osdUntil - Date.now()));
        report("osd_now_filled", { lcn: lcn });
        return;
      }
      pollPresent(lcn, tries - 1);
    }, 2500);
  }



  // ---------- external command channel ----------
  // Polls /root/hermes_cmd.txt (2 s) so tests can be driven from the shell
  // without rebooting. Also the seed of the scheduler. Commands:
  //   rec <lcn> <seconds>   start a recording on another channel
  //   stop                  stop the current recording
  //   stat                  report live channel + recording state
  var CMD_PATH = "/root/hermes_cmd.txt";
  var testRecTimer = null;

  function startTestRecording(lcn, secs) {
    if (recId !== null) { report("test_rec_busy", { rec: recId }); return; }
    try {
      recId = hw.createRecording();
      recName = "TEST CH " + lcn;
      recLcn = lcn;
      recSince = Date.now();
      recHandle = hw.startDvbRecording(lcn, recId);
      names[recId] = recName;
      report("test_rec_start", { lcn: lcn, id: recId, handle: recHandle, live: current, secs: secs });
      var myId = recId;
      if (testRecTimer) clearTimeout(testRecTimer);
      testRecTimer = setTimeout(function () {
        var stillId = recId;
        stopRecording();
        report("test_rec_auto_stop", { id: stillId });
      }, secs * 1000);
    } catch (e) {
      recId = null; recHandle = null;
      report("test_rec_error", String(e).slice(0, 120));
    }
  }

  function pollCommand() {
    var txt = null;
    try { txt = readTextFile(CMD_PATH); } catch (e) { return; }
    if (!txt) return;
    txt = String(txt).replace(/\r/g, "").trim();
    if (!txt) return;
    writeTextFile(CMD_PATH, "");
    var p = txt.split(/\s+/);
    var cmd = String(p[0] || "").toLowerCase();
    if (cmd === "rec") {
      startTestRecording(Number(p[1]) || 0, Number(p[2]) || 30);
    } else if (cmd === "stop") {
      stopRecording();
      report("test_rec_stop_cmd", {});
    } else if (cmd === "seekpct") {
      var pctl = Number(p[1]) || 95;
      var totv = 0;
      try { totv = Number(nat.Ag_playBack_getTotalTime()) || 0; } catch (e) {}
      if (totv > 0) {
        var target = Math.floor(totv * pctl / 100);
        try { nat.Ag_playBack_seek(target); } catch (e) {}
        report("test_seek", { pct: pctl, target: target, total: totv });
      }
    } else if (cmd === "play") {
      var n = Number(p[1]) || 0;
      loadItems();
      if (items.length) {
        sel = Math.max(0, Math.min(items.length - 1, n));
        report("test_play", { sel: sel, id: items[sel].id, dur: items[sel].dur });
        playItem();
      }
    } else if (cmd === "seektest") {
      var sd = Number(p[1]) || 30, sn = Math.min(40, Number(p[2]) || 12);
      var done = 0;
      seekCalls = 0;
      var iv = setInterval(function () {
        seekBy(sd);
        if (++done >= sn) clearInterval(iv);
      }, 80);
      setTimeout(function () {
        var cur = 0;
        try { cur = Number(nat.Ag_playBack_getCurrentTime()) || 0; } catch (e) {}
        report("test_seek_burst", {
          presses: sn, delta: sd, askedFor: seekTarget, actual: cur,
          nativeSeeks: seekCalls, pending: seekPending, text: pbText()
        });
      }, 1600);
    } else if (cmd === "tstoggle") {
      tsTogglePause();
    } else if (cmd === "tssync") {
      tsSync();
    } else if (cmd === "tsseekraw") {
      var rawv = Number(p[1]);
      var before = tsPositionSec();
      var rv = tsCall("Ag_timeShift_seek", [rawv]);
      setTimeout(function () {
        report("ts_seekraw", { arg: rawv, result: rv, before: before, after: tsPositionSec(),
                               rec: tsCall("Ag_timeShift_getRecordTime") });
      }, 1500);
    } else if (cmd === "tsseek") {
      tsSeekBy(Number(p[1]) || 30);
    } else if (cmd === "tsmode") {
      report("ts_mode", {
        mode: tsMode, active: tsActive, pos: tsPositionSec(),
        behind: behindLiveText(), info: tsInfo(),
        osdShown: !!(tsEls && tsEls.el.style.display === "block"),
        osdText: tsEls ? (tsEls.title.textContent + " | " + tsEls.fill.style.width +
                          " | " + tsEls.time.textContent + " | " + tsEls.fin.textContent) : ""
      });
    } else if (cmd === "tsstart") {
      if (tsStart(Number(p[1]) * 60)) tsMode = "live";
    } else if (cmd === "tsstop") {
      tsStop("command");
    } else if (cmd === "tsinfo") {
      report("ts_info", tsInfo());
    } else if (cmd === "tsprobe") {
      // read-only: getters only, nothing is started or sized
      var ts = {};
      var names = ["Ag_timeShift_getStatus", "Ag_timeShift_getBufferSize",
                   "Ag_timeShift_getRecordTime", "Ag_timeShift_getPlayTime",
                   "Ag_timeShift_getTotalTime", "Ag_timeShift_getspeed"];
      for (var ti = 0; ti < names.length; ti++) {
        var fn = names[ti];
        if (typeof nat[fn] !== "function") { ts[fn] = "missing"; continue; }
        try { ts[fn] = String(nat[fn]()); } catch (e) { ts[fn] = "ERR " + String(e).slice(0, 60); }
        ts[fn + ".len"] = nat[fn].length;
      }
      report("ts_probe", ts);
    } else if (cmd === "pbstop") {
      if (state === "PLAYBACK") stopPlayback();
    } else if (cmd === "pause") {
      if (pbId !== null && state === "PLAYBACK") {
        if (pbPaused) { nat.Ag_playBack_resume(); pbPaused = false; }
        else { nat.Ag_playBack_pause(); pbPaused = true; }
        renderPlayback(true);
        var rc = pbEl.getBoundingClientRect();
        var tr = pbEls.time.getBoundingClientRect();
        var fr = pbEls.fin.getBoundingClientRect();
        report("test_pause", {
          paused: pbPaused, text: pbText(),
          box: { left: Math.round(rc.left), width: Math.round(rc.width), height: Math.round(rc.height) },
          timeLeft: Math.round(tr.left), finRight: Math.round(fr.right),
          innerRight: Math.round(rc.right - 22)
        });
      }
    } else if (cmd === "tz") {
      var want = String(p[1] || "").trim();
      if (TZ_ZONES.indexOf(want) < 0) {
        report("tz_bad", { want: want, zones: TZ_ZONES });
      } else {
        applyChoice("timezone", want);
        report("tz_set", { tz: settings.timezone, offsetMin: zoneOffsetMinutes(new Date()) });
      }
    } else if (cmd === "tztest") {
      var keepTz = settings.timezone, out = {};
      for (var zi = 0; zi < TZ_ZONES.length; zi++) {
        settings.timezone = TZ_ZONES[zi];
        var offMin = zoneOffsetMinutes(new Date());
        out[TZ_ZONES[zi]] = offMin + " min  now " + localTimeStr();
      }
      settings.timezone = keepTz;
      report("tztest", { zones: out, active: keepTz, activeOffset: zoneOffsetMinutes(new Date()) });
    } else if (cmd === "webmeta") {
      writeWebMeta();
    } else if (cmd === "confirmtest") {
      askConfirm("RESCAN CHANNELS?", "Takes about 3 minutes",
                 "ENTER starts    any other key cancels",
                 function () { report("confirmtest_ok", {}); });
      report("confirmtest", {
        shown: !!(confirmEl && confirmEl.style.display === "flex"),
        text: confirmEl ? confirmEl.textContent : "",
        armed: !!confirmCb
      });
      // leave the dialog up for two seconds, then dismiss it without acting
      setTimeout(function () { closeConfirm(); }, 2000);
    } else if (cmd === "rows") {
      var keep = setPane;
      setPane = 0;
      var g = settingsRows().map(function (r) { return r.type + ":" + (r.label || "-"); });
      setPane = 1;
      var rr = settingsRows().map(function (r) { return r.type + ":" + (r.label || "-"); });
      setPane = keep;
      report("settings_rows", { guide: g, rec: rr });
    } else if (cmd === "rescan") {
      rescanChannels();
    } else if (cmd === "cleanup") {
      maintRun("manual", true);
    } else if (cmd === "maint") {
      maintAudit();
    } else if (cmd === "reload") {
      loadSettings();          // settings edits can be tested without a reboot
      loadTimers();
      report("timers_reloaded", { count: timers.length });
    } else if (cmd === "stat") {
      var files = -1;
      try { files = hw.getRecordingCount(); } catch (e) {}
      report("stat", { live: current, rec: recId, lcn: recLcn, files: files });
    }
  }


  // ---------- scheduled recordings ----------
  // The firmware timer API is a stub on this build (every call returns -1), so
  // the schedule lives here: timers are persisted to /root/hermes_timers.txt and
  // a 20 s tick starts/stops recordings through the path that does work.
  // "First to start wins": if something is already recording when a timer falls
  // due, that timer is marked skipped rather than pre-empting the recording.
  // Stored as JSON: a pipe-joined string came out as "test1" + NUL padding -
  // right length, wrong bytes - while JSON.stringify (used by report() and the
  // names file path) writes correctly. JSON also avoids escaping titles.
  function loadTimers() {
    timers = [];
    var txt = readTextFile(TIMERS_PATH);
    if (!txt) return;
    var arr = null;
    try { arr = JSON.parse(String(txt)); } catch (e) { arr = null; }
    if (!arr || arr.length === undefined) return;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (!t) continue;
      timers.push({
        id: String(t.id), lcn: Number(t.lcn), start: Number(t.start), dur: Number(t.dur),
        title: String(t.title || ""), ep: String(t.ep || ""), sub: String(t.sub || ""),
        series: !!t.series,
        pre: Number(t.pre), post: Number(t.post), state: String(t.state || "armed")
      });
    }
    timers.sort(function (a, b) { return a.start - b.start; });
  }

  function saveTimers() {
    var plain = [];
    for (var i = 0; i < timers.length; i++) {
      var t = timers[i];
      plain.push({
        id: t.id, lcn: t.lcn, start: t.start, dur: t.dur,
        title: t.title, ep: t.ep || "", sub: t.sub || "", series: !!t.series,
        pre: t.pre, post: t.post, state: t.state
      });
    }
    var text = JSON.stringify(plain);
    var ok = writeTextFile(TIMERS_PATH, text);
    if (!ok) report("timers_save_failed", { len: text.length, count: plain.length });
  }

  function timerLog(msg) {
    var prev = readTextFile(TIMER_LOG) || "";
    var lines = String(prev).split("\n");
    if (lines.length && !lines[lines.length - 1]) lines.pop();
    var d = new Date();
    lines.push(p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + " UTC  " + msg);
    if (lines.length > 200) lines = lines.slice(lines.length - 200);
    writeTextFile(TIMER_LOG, lines.join("\n") + "\n");
  }


  // ---------- series link ----------
  // One row per series, re-armed to the next matching episode, rather than
  // exploding the list into dozens of timers.
  function findNextEpisode(lcn, title, afterMs) {
    if (!guideLoaded) { try { if (!loadGuide()) return null; } catch (e) { return null; } }
    var arr = guideByLcn[String(lcn)] || [];
    var off = offsetFor(lcn);
    var key = String(title).toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (p.s + off <= afterMs) continue;
      if (String(p.title).toLowerCase() !== key) continue;
      return p;
    }
    return null;
  }

  function dayAdl(ms) {
    var off = zoneOffsetMinutes(new Date(ms));
    var d = new Date(ms + off * 60000);
    return String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
  }

  // Only SxxEyy with 0-99 in BOTH parts is a real episode number. Broadcasters
  // reuse the field for strand ids - S2026E1112 on Racing Review (year+month+day,
  // because several meetings air per day), S2016E304 on home shopping, S01E261 on
  // long-running strands - and those must not count as unique episodes.
  function normEp(s) {
    var m = /^S(\d{1,2})E(\d{1,2})$/i.exec(String(s || "").trim());
    if (!m) return "";
    return "S" + p2(Number(m[1])) + "E" + p2(Number(m[2]));
  }

  // Duplicate check: same programme NAME, same LCN, and the same episode. The
  // episode is the SxxEyy code; when a programme has no usable code we fall back
  // to the episode title (sub-title), which is what actually differs for strands
  // like the racing recap. Without either we cannot tell two airings apart, so we
  // never suppress (and the link is refused at the point it is enabled).
  function alreadyHaveEpisode(lcn, title, ep, sub) {
    var n = normEp(ep);
    var key = String(title).toLowerCase();
    var s = String(sub || "").trim().toLowerCase();
    if (!n && !s) return false;
    for (var id in names) {
      if (!names.hasOwnProperty(id)) continue;
      if (String(names[id]).toLowerCase() !== key) continue;
      var ch = String(recChannel[id] || "");
      if (ch && ch.indexOf(String(lcn) + " ") !== 0) continue;
      if (n) {
        if (normEp(recEp[id]) === n) return true;
      } else if (String(recSub[id] || "").trim().toLowerCase() === s) {
        return true;
      }
    }
    return false;
  }

  function armAtProgramme(t, p) {
    var off = offsetFor(t.lcn);
    t.start = Math.floor((p.s + off) / 1000);
    t.dur = Math.max(60, Math.round((p.e - p.s) / 1000));
    t.ep = p.ep || "";
    t.sub = p.sub || "";
    t.state = "armed";
  }

  function advanceSeries(t, afterMs) {
    var nxt = findNextEpisode(t.lcn, t.title, afterMs);
    if (nxt) {
      if (!normEp(nxt.ep) && !String(nxt.sub || "").trim()) {
        // a matching title is not enough: with no episode code and no episode
        // title the next airing cannot be distinguished from the one just made
        if (t.state !== "waiting") {
          timerLog("NO EPISODE INFO  ch" + t.lcn + "  " + t.title + "  (series link stopped)");
          t.state = "waiting";
        }
        return false;
      }
      armAtProgramme(t, nxt);
      timerLog("RE-ARMED  ch" + t.lcn + "  " + t.title + "  " + (nxt.ep || ""));
      return true;
    }
    if (t.state !== "waiting") {   // avoid a log line every 20 s while waiting
      timerLog("WAITING  ch" + t.lcn + "  " + t.title + " (no further episodes in guide)");
    }
    t.state = "waiting";
    return false;
  }

  function schedulerTick() {
    if (!ready) return;
    autoStopCheck();
    if (!timers.length) return;
    var now = Date.now();
    var changed = false;
    for (var i = 0; i < timers.length; i++) {
      var t = timers[i];
      var startMs = t.start * 1000;
      var endMs = startMs + t.dur * 1000;
      var preMs = (isNaN(t.pre) ? settings.pre_pad : t.pre) * 60000;
      var postMs = (isNaN(t.post) ? settings.post_pad : t.post) * 60000;

      if (t.state === "waiting") {
        if (t.series) { if (advanceSeries(t, Date.now())) changed = true; }
        continue;
      }
      if (t.state === "armed") {
        if (now > endMs + postMs) {
          t.state = "missed"; changed = true;
          timerLog("MISSED  ch" + t.lcn + "  " + t.title);
          continue;
        }
        if (now >= startMs - preMs) {
          if (t.series && alreadyHaveEpisode(t.lcn, t.title, t.ep, t.sub)) {
            timerLog("SKIPPED (already recorded)  ch" + t.lcn + "  " + t.title + " " + (t.ep || ""));
            advanceSeries(t, t.start * 1000);
            changed = true;
            continue;
          }
          if (recId !== null) {
            t.state = "skipped"; changed = true;
            timerLog("SKIPPED (already recording)  ch" + t.lcn + "  " + t.title);
            continue;
          }
          try { maintRun("pre-record"); } catch (e) {}   // make room before writing
          try {
            recId = hw.createRecording();
            recLcn = t.lcn;
            recName = t.title;
            recSince = Date.now();
            recHandle = hw.startDvbRecording(t.lcn, recId);
            names[recId] = t.title;
            // the list shows channel from recChannel; timer recordings previously
            // filled only the name, so they appeared with a blank channel column
            var chT = channelName(t.lcn);
            recChannel[recId] = String(t.lcn) + (chT ? " " + chT : "");
            recEp[recId] = normEp(t.ep) || epForChannelTime(t.lcn, Date.now());
            recSub[recId] = t.sub || subForChannelTime(t.lcn, Date.now());
            recDay[recId] = dayAdl(Date.now());
            saveNames();
            t.state = "recording"; changed = true;
            timerLog("START  ch" + t.lcn + "  " + t.title);
            report("timer_start", { id: t.id, lcn: t.lcn, title: t.title });
          } catch (e) {
            t.state = "failed"; changed = true;
            timerLog("FAILED  ch" + t.lcn + "  " + String(e).slice(0, 60));
            report("timer_error", String(e).slice(0, 100));
          }
        }
      } else if (t.state === "recording") {
        if (now >= endMs + postMs) {
          try { hw.stopDvbRecording(recHandle); } catch (e) {}
          report("timer_stop", { id: t.id, lcn: t.lcn });
          timerLog("STOP   ch" + t.lcn + "  " + t.title);
          recId = null; recHandle = null; recLcn = null; recName = null;
          if (t.series) advanceSeries(t, t.start * 1000);
          else t.state = "done";
          changed = true;
        }
      }
    }
    if (changed) saveTimers();
  }

  function renderTimers() {
    var el = uiRoot();
    function line(t) {
      var d = document.createElement("div");
      d.textContent = t;
      return d;
    }
    el.appendChild(line("TIMERS"));
    el.appendChild(line(""));
    if (!timers.length) {
      el.appendChild(line("No timers set."));
      el.appendChild(line(""));
      el.appendChild(line("In the TV guide, select a programme and press RECORD to add one."));
      showHelp();
      return;
    }
    var per = 12, start = 0;
    if (timers.length > per) {
      start = timSel - Math.floor(per / 2);
      if (start < 0) start = 0;
      if (start > timers.length - per) start = timers.length - per;
    }
    function cell(txt, w, flex, align) {
      var s = document.createElement("span");
      s.textContent = txt;
      if (flex) { s.style.flex = "1 1 auto"; }
      else { s.style.flex = "0 0 auto"; s.style.width = w + "px"; }
      // clip every cell: a long XMLTV display-name would otherwise spill over
      // the next column instead of being cut
      s.style.overflow = "hidden";
      s.style.textOverflow = "ellipsis";
      if (align) s.style.textAlign = align;
      s.style.whiteSpace = "nowrap";
      return s;
    }

    function tRow(t, selected) {
      var d = document.createElement("div");
      d.style.display = "flex";
      d.style.alignItems = "baseline";
      // prefer the box's own (short) service name, fall back to the XMLTV
      // display-name which can be long ("ABC TV HD South Australia")
      function chName(lcn) {
        try { var n = channelName(lcn); if (n) return n; } catch (e) {}
        return guideChans[String(lcn)] || "";
      }
      d.appendChild(cell(selected ? ">" : " ", 26, false));
      d.appendChild(cell(fmtDateAdl(t.start * 1000), 130, false));
      d.appendChild(cell(fmtHM(t.start * 1000), 64, false));
      d.appendChild(cell(String(t.lcn), 50, false));
      d.appendChild(cell(chName(t.lcn), 200, false));
      d.appendChild(cell(t.title + (t.series ? "  (S)" : ""), 0, true));
      d.appendChild(cell(t.ep || "", 80, false));
      d.appendChild(cell(t.state, 100, false, "right"));
      if (selected) d.style.color = "#ffffff";
      return d;
    }

    // header, dimmed like the recordings list
    var hdr = tRow({ lcn: "CH", start: Date.now(), title: "PROGRAMME", ep: "EP", state: "STATUS" }, false);
    hdr.style.opacity = "0.7";
    hdr.style.borderBottom = "1px solid #00ff66";
    hdr.style.marginBottom = "6px";
    // replace the placeholder clock/name cells with labels
    var kids = hdr.children;
    kids[1].textContent = "DATE";
    kids[2].textContent = "TIME";
    kids[4].textContent = "CHANNEL";
    el.appendChild(hdr);

    var end = Math.min(timers.length, start + per);
    for (var i = start; i < end; i++) {
      // no ">" cursor while the pane is only being previewed from the menu
      el.appendChild(tRow(timers[i], state === "TIMERS" && i === timSel));
    }
    showHelp();
  }

  function enterTimers() {
    state = "TIMERS";
    timSel = 0;
    loadTimers();
    renderTimers();
    report("enter_timers", { count: timers.length });
  }

  // ---------- recording ----------
  function startRecording() {
    if (!ready) { toast("PVR NOT READY"); return; }
    if (recId !== null) { toast("ALREADY RECORDING"); return; }
    try { maintRun("pre-record"); } catch (e) {}   // make room before writing
    try {
      recId = hw.createRecording();
      // prefer the EIT programme title over the channel name
      var ev = eitNow(current);
      var chName = channelName(current);
      recName = (ev && ev.name) ? ev.name : chName;
      recLcn = current;
      recSince = Date.now();
      // End a manual recording at the EIT programme end + post pad instead of
      // running until the owner notices. EIT duration is seconds (verified against
      // a rec_start report: start 00:04:02, duration 5836). Ignore nonsense.
      recEndAt = 0;
      if (ev && ev.start && ev.duration > 0 && ev.duration <= 8 * 3600) {
        recEndAt = ev.start + ev.duration * 1000 + settings.post_pad * 60000;
        if (recEndAt <= Date.now()) recEndAt = 0;   // already past: leave it open
      }
      if (recEndAt) {
        // exact stop, with the 20 s scheduler tick as a safety net
        if (recEndTimer) clearTimeout(recEndTimer);
        recEndTimer = setTimeout(autoStopCheck, Math.max(0, recEndAt - Date.now()));
      }
      recHandle = hw.startDvbRecording(current, recId);
      names[recId] = recName || ("CH " + current);
      recChannel[recId] = String(current) + (chName ? " " + chName : "");
      recEp[recId] = epForChannelTime(current, Date.now());
      recSub[recId] = subForChannelTime(current, Date.now());
      recDay[recId] = dayAdl(Date.now());
      saveNames();
      report("rec_start", {
        id: recId, lcn: current, name: recName, handle: recHandle,
        endAt: recEndAt,
        eit: ev ? { name: ev.name, start: ev.start, duration: ev.duration } : null
      });
      toast("REC  " + (recName || ("CH " + current)) +
            (recEndAt ? "  to " + fmtHM(recEndAt) : ""), 2600);
    } catch (e) {
      recId = null; recHandle = null;
      report("rec_start_error", String(e).slice(0, 90));
      toast("REC FAILED");
    }
  }

  function stopRecording() {
    if (recId === null) { toast("NOT RECORDING"); return; }
    try { hw.stopDvbRecording(recHandle); } catch (e) { report("rec_stop_error", String(e).slice(0, 90)); }
    report("rec_stop", { id: recId, lcn: recLcn, auto: false });
    toast("REC STOPPED");
    if (recEndTimer) { clearTimeout(recEndTimer); recEndTimer = null; }
    recId = null; recHandle = null; recLcn = null; recName = null; recEndAt = 0;
  }

  // Manual REC auto-stop. Called from schedulerTick so it works with no timers.
  function autoStopCheck() {
    if (recId === null || !recEndAt) return;
    if (Date.now() < recEndAt) return;
    try { hw.stopDvbRecording(recHandle); } catch (e) { report("rec_stop_error", String(e).slice(0, 90)); }
    report("rec_stop", { id: recId, lcn: recLcn, auto: true, endAt: recEndAt });
    timerLog("AUTO STOP  ch" + recLcn + "  " + (recName || "") + "  (programme end)");
    toast("REC ENDED  " + (recName || ("CH " + recLcn)), 2600);
    if (recEndTimer) { clearTimeout(recEndTimer); recEndTimer = null; }
    recId = null; recHandle = null; recLcn = null; recName = null; recEndAt = 0;
  }

  // ---------- list ----------
  function parseInfo(info) {
    // hw.getRecordingInfo(i) returns an OBJECT {id, duration(ms), size(KB)}.
    // The raw native Ag_playBack_getFileInfo(i) returns the "@" string
    // "id@0@0@000000@YYYY:MM:DDHH:MM:SS@HH:MM:SS@sizeKB@id" instead.
    if (info && typeof info === "object") {
      return {
        id: Number(info.id) || 0,
        when: "",
        dur: fmtDur(Number(info.duration) / 1000),
        size: fmtSize(info.size),
        sizeRaw: Number(info.size) || 0,
        raw: JSON.stringify(info)
      };
    }
    // "id@0@0@000000@YYYY:MM:DDHH:MM:SS@HH:MM:SS@sizeKB@id"
    var f = String(info || "").split("@");
    var stamp = f[4] || "";
    var yyyy = stamp.slice(0, 4), mm = Number(stamp.slice(5, 7)), dd = Number(stamp.slice(8, 10));
    // "YYYY:MM:DDHH:MM:SS" - day and hour are fused, so slice positions lie for
    // single-digit days. Parse properly, and treat it as UTC.
    var whenMs = 0;
    var sm = /^(\d{4}):(\d{2}):(\d{2})(\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
    if (sm) whenMs = Date.UTC(Number(sm[1]), Number(sm[2]) - 1, Number(sm[3]),
                              Number(sm[4]), Number(sm[5]), Number(sm[6]));
    var when = "";
    if (yyyy && mm >= 1 && mm <= 12 && dd >= 1) {
      when = dd + " " + MONTHS[mm - 1] + " " + yyyy.slice(2);
    }
    return {
      id: Number(f[0]) || 0,
      when: when,
      whenMs: whenMs,
      dur: f[5] || "",
      size: fmtSize(f[6]),
      sizeRaw: Number(f[6]) || 0,
      raw: String(info)
    };
  }

  var loadCursor = 0, loadTimer = null, diagDone = false;

  function buildItem(i) {
    // Prefer the raw native call: it carries the recording date as well as
    // id/duration/size. hw.getRecordingInfo() returns only the latter three.
    var p = null;
    try {
      var rawInfo = nat.Ag_playBack_getFileInfo(i);
      if (rawInfo && String(rawInfo).indexOf("@") > 0) p = parseInfo(rawInfo);
    } catch (e) {}
    if (!p) {
      var info = null;
      try { info = hw.getRecordingInfo(i); } catch (e) { return null; }
      p = parseInfo(info);
    }
    p.num = p.id;
    p.index = i;
    p.name = names[p.id] || null;
    p.channel = recChannel[p.id] || null;
    return p;
  }

  // Load in batches of 100 so opening the list is fast even with thousands of
  // recordings, then keep filling in the background until the whole list is in.
  function loadMore() {
    loadTimer = null;
    if (loadCursor >= totalCount) return;
    var end = Math.min(totalCount, loadCursor + 100);
    for (var i = loadCursor; i < end; i++) {
      var p = buildItem(i);
      if (p) items.push(p);
    }
    loadCursor = end;
    if (state === "LIST" || state === "MENU") renderList();
    if (!diagDone && items.length) {
      diagDone = true;
      var sample = [];
      for (var k = 0; k < Math.min(6, items.length); k++) {
        sample.push({
          idx: items[k].index,
          raw: items[k].raw,
          sizeRaw: items[k].sizeRaw,
          name: items[k].name,
          label: labelFor(items[k])
        });
      }
      var keys = Object.keys(sqlBySize);
      report("diag", { sample: sample, sqlKeys: keys.length, firstKey: keys[0] });
    }
    if (loadCursor < totalCount && totalCount < 5000) {
      loadTimer = setTimeout(loadMore, 120);
    }
  }

  function loadItems() {
    var count = 0;
    try { count = hw.getRecordingCount(); } catch (e) { count = 0; }
    count = Number(count) || 0;
    totalCount = count;
    items = [];
    loadCursor = 0;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    loadMore();
  }

  // MENU: tab bar with the selected tab's content underneath, no cursor yet
  function openMenu() {
    if (!ready) { toast("PVR NOT READY"); return; }
    tab = 0;
    state = "MENU";
    loadItems();
    render();
    report("menu_open", {});
  }

  function enterList() {
    state = "LIST";
    sel = 0;
    loadItems();
    render();
    report("enter_list", {});
  }

  function enterSettings(pane) {
    state = "SETTINGS";
    setPane = (pane === 1) ? 1 : 0;
    setSel = 0;
    loadXmltvStatus();
    render();
    report("enter_settings", {});
  }

  function backToMenu() {
    state = "MENU";
    render();
  }

  function closeMenu() {
    state = "LIVE";
    hideList();
    toast("CH " + current);
  }

  // kept for callers that expect the list directly (playback stop)
  function openList() {
    if (!ready) { toast("PVR NOT READY"); return; }
    state = "LIST";
    loadItems();
    render();
    report("list_open", { count: totalCount });
  }

  function closeList() {
    closeMenu();
  }

  function playItem() {
    if (!items.length) return;
    var it = items[sel];
    // free the decoder BEFORE playback or we get black + frozen position
    try { nat.Ag_dvb_stop(0); } catch (e) { try { nat.Ag_dvb_stop_sync(0); } catch (e2) {} }
    live = false;
    if (tsActive) { tsStop("playback"); tsMode = "off"; tsHide(); }
    pbIndex = it.index; pbNum = it.num; pbId = it.id; pbPaused = false; pbItem = it;
    setTimeout(function () {
      var r = null;
      try { r = nat.Ag_playBack_playPos(it.index, 0); } catch (e) { report("play_error", String(e).slice(0, 90)); }
      report("play_start", { index: it.index, id: it.id, result: r });
      state = "PLAYBACK";
      hideList();               // the menu panel must not sit over the picture
      renderPlayback(true);
      if (uiTimer) clearInterval(uiTimer);
      uiTimer = setInterval(function () {
        if (state === "PLAYBACK") {
          checkViewed();                 // 90%-rule rides the existing 1 s tick
          renderPlayback(false);
        }
      }, 1000);
    }, 1200);
  }

  var pbNum = null, pbId = null;
  var pbItem = null;                  // the list entry being played, for its name

  function stopPlayback() {
    var wasId = pbId;
    try { checkViewed(); } catch (e) {}   // catch a stop that lands between ticks
    try { nat.Ag_playBack_stop(); } catch (e) {}
    if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
    seekPending = false;
    pbItem = null;
    hidePb();
    tune(current, true);
    // Return to the list with the cursor still on the item we were playing.
    openList();
    var idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === wasId) { idx = i; break; }
    }
    if (idx >= 0) { sel = idx; renderList(); }
    report("playback_stopped", { backTo: "list", id: wasId, sel: sel });
  }

  // Rapid UP/DOWN presses are COALESCED: each press moves a pending target and
  // redraws the bar immediately, but only one native seek is issued, 500 ms after
  // the last press. Issuing a seek per press is what made the UI unresponsive -
  // six minutes of seeking is 12 seeks and the decoder never settles.
  var seekPending = false, seekTarget = 0, seekTimer = null, seekCalls = 0;

  function seekBy(delta) {
    var tot = 0;
    try { tot = Number(nat.Ag_playBack_getTotalTime()) || pbTotal || 0; } catch (e) { tot = pbTotal || 0; }
    var base;
    if (seekPending) {
      base = seekTarget;                       // stack onto what is already queued
    } else {
      base = 0;
      try { base = Number(nat.Ag_playBack_getCurrentTime()) || 0; } catch (e) {}
    }
    var target = Math.floor(base + delta);
    if (target < 0) target = 0;
    if (tot > 0 && target > tot - 1) target = tot - 1;   // never sit exactly on the end
    seekTarget = target;
    seekPending = true;
    renderPlayback(true);                      // optimistic redraw: bar and time move now
    toast((delta > 0 ? ">> " : "<< ") + fmtDur(target), 1200);
    if (seekTimer) clearTimeout(seekTimer);
    seekTimer = setTimeout(applySeek, 500);
  }

  function applySeek() {
    seekTimer = null;
    if (!seekPending) return;
    var t = seekTarget;
    seekPending = false;
    try { nat.Ag_playBack_seek(t); seekCalls++; } catch (e) { report("seek_error", String(e).slice(0, 90)); }
    renderPlayback(false);
  }

  function togglePause() {
    if (seekPending) applySeek();        // land the queued seek before changing state
    try {
      if (pbPaused) { nat.Ag_playBack_resume(); pbPaused = false; }
      else { nat.Ag_playBack_pause(); pbPaused = true; }
    } catch (e) {}
    renderPlayback(true);
  }

  // Delete is destructive and there is no recycle bin, so it asks first.
  // ENTER confirms; any other key cancels and is swallowed (so the list does not
  // scroll or tune behind the dialog).
  var confirmEl = null, confirmCb = null, confirmIt = null;

  function askConfirm(title, name, hint, onOk) {
    if (!confirmEl) {
      confirmEl = document.createElement("div");
      confirmEl.dataset.hermesOurs = "1";
      confirmEl.style.cssText =
        "position:fixed;left:0;top:0;width:100%;height:100%;display:none;" +
        "background:rgba(0,0,0,0.70);z-index:2147483647;" +
        "align-items:center;justify-content:center";
      document.body.appendChild(confirmEl);
    }
    // (this used to call labelFor(it) - a leftover from the delete-only version,
    // which threw here and left the callback armed, so the dialog never appeared
    // and the NEXT keypress silently confirmed it)
    var label = String(name || "");
    if (label.length > 46) label = label.slice(0, 45) + "\u2026";

    var tbl = document.createElement("table");
    tbl.style.cssText = "border-collapse:collapse;background:#001a08;" +
      "border:2px solid #00ff66;color:#00ff66;font:24px/1.5 monospace;";
    function line(txt, size, colour) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.style.cssText = "padding:8px 28px;font:inherit;color:" + (colour || "#00ff66") + ";" +
        "font-size:" + (size || 24) + "px;white-space:nowrap;";
      td.textContent = txt;
      tr.appendChild(td);
      tbl.appendChild(tr);
    }
    line(title, 26, "#ffffff");
    line(label, 24, "#00ff66");
    line(hint, 18, "#00a040");

    confirmEl.innerHTML = "";
    confirmEl.appendChild(tbl);
    confirmEl.style.display = "flex";
    // arm the callback only once the dialog is actually on screen
    confirmCb = onOk || null;
    report("confirm_shown", { title: title, name: label });
  }

  function askDelete(it) {
    if (!it) return;
    confirmIt = it;
    askConfirm("DELETE RECORDING?", labelFor(it), "ENTER deletes    any other key cancels",
               function () { doDelete(it); });
  }

  function closeConfirm() {
    if (confirmEl) confirmEl.style.display = "none";
    confirmCb = null;
    confirmIt = null;
  }

  function deleteCurrent() {
    if (!items.length) return;
    askDelete(items[sel]);
  }

  function doDelete(it) {
    if (!it) return;
    var ret = null, ok = false;
    try {
      ret = nat.Ag_playBack_deleteFile(it.index);
      // C convention, not a boolean: 0 means the file was deleted. Testing the
      // raw value for truthiness is what made a successful delete toast FAILED.
      ok = (ret === 0 || ret === "0");
    } catch (e) { report("delete_error", String(e).slice(0, 90)); }
    if (ok && it.id !== null && it.id !== undefined) {
      delete viewed[String(it.id)];
      saveViewed();
    }
    report("delete", { index: it.index, id: it.id, result: ret, ok: ok });
    toast(ok ? "DELETED" : "DELETE FAILED");
    setTimeout(openList, 900);
  }

  // ---------- TV GUIDE ----------
  // Data comes from /root/xmltv/guide.tsv (lcn|start|stop|title, UTC stamps),
  // channels.tsv (lcn|name) and logos.json (lcn -> data: URI). All tiny compared
  // with the 9 MB XML, which is far too slow to read through Ag_textFile_read.
  var guideLoaded = false;
  var guideSig = "";                          // first bytes of guide_channels.txt
  var guideLoadedAt = 0;                      // ms; guide.txt is rebuilt hourly on disk
  var GUIDE_TTL_MS = 30 * 60000;
  var guideChans = {};      // lcn -> display name
  var guideByLcn = {};      // lcn -> [{s,e,title}]
  var logos = {};
  var guideRows = [];
  var guideMaxEnd = 0;
  var gSel = 0, gScroll = 0, gOffset = 0;
  var favourites = {};           // lcn -> true
  var guideOffsets = {};         // lcn -> minutes
  var guideFavOnly = false;
  var guideOpts = false;
  var FAV_PATH = "/root/hermes_favourites.txt";
  var OFF_PATH = "/root/hermes_guide_offsets.txt";

  var G_ROW_H = 84, G_LEFT_W = 176, G_HEADER_H = 34;
  var G_VISIBLE_ROWS = 6, G_WINDOW_MIN = 120, G_STEP_MIN = 30;


  function parseUtcStamp(s) {
    s = String(s || "");
    if (s.length < 12) return 0;
    return Date.UTC(+s.substr(0, 4), +s.substr(4, 2) - 1, +s.substr(6, 2),
                    +s.substr(8, 2), +s.substr(10, 2), +(s.substr(12, 2) || 0));
  }

  function loadGuide() {
    // guide.txt is rebuilt on disk every hour from a rolling 12 h window, but the
    // page used to parse it once and keep that copy for the life of the process.
    // Twelve hours after boot every programme in memory is in the past, so every
    // row draws no blocks and the guide looks blank. Re-read after the TTL.
    // A city change rewrites guide_channels.txt within seconds, but the TTL would
    // keep the old city's rows on screen for up to 30 minutes. The channel list is
    // under 1 KB, so read it as a signature: same channels + fresh = no reload.
    var sig = "";
    try { sig = String(readTextFile("/root/guide_channels.txt") || "").slice(0, 4000); } catch (e) {}
    if (guideLoaded && sig === guideSig && (Date.now() - guideLoadedAt) < GUIDE_TTL_MS) return true;
    if (guideLoaded && guideSig && sig !== guideSig) report("guide_city_changed", { reload: true });
    var hadGuide = guideLoaded;
    var t0 = Date.now();
    var gTxt = null, gPath = "";
    var cands = ["/root/guide.txt", "/root/xmltv/guide.tsv"];
    for (var ci = 0; ci < cands.length; ci++) {
      gTxt = readTextFile(cands[ci]);
      if (gTxt && gTxt.length > 4) { gPath = cands[ci]; break; }
      gTxt = null;
    }
    if (!gTxt) {
      var diag = {};
      var probe = ["/root/a1.txt", "/root/a2.txt", "/root/a4.tsv", "/root/a5.json",
                   "/root/hermes_rec_names.txt"];
      try {
        var pp = new window.AVPlayer();
        for (var di = 0; di < probe.length; di++) {
          var f = -1;
          try { f = pp.Ag_textFile_open(probe[di]); } catch (e) { f = "E"; }
          diag["p" + di] = f;
        }
      } catch (e3) {}
      report("guide_missing", diag);
      guideLoaded = hadGuide;          // keep the stale copy rather than blanking the UI
      return hadGuide;
    }
    var chTxt = readTextFile("/root/guide_channels.txt") || readTextFile("/root/xmltv/channels.tsv");
    var lTxt = readTextFile("/root/guide_logos.json") || readTextFile("/root/xmltv/logos.json");
    if (lTxt) { try { logos = JSON.parse(lTxt) || {}; } catch (e) { logos = {}; } }

    var lns = String(chTxt || "").split("\n");
    for (var i = 0; i < lns.length; i++) {
      var ln = lns[i].replace(/\r/g, "");
      if (!ln) continue;
      var p = ln.split("|");
      if (p.length >= 2 && p[0]) guideChans[p[0]] = p[1];
    }

    guideByLcn = {};
    guideMaxEnd = 0;
    var rowsIn = String(gTxt).split("\n");
    var kept = 0;
    for (var k = 0; k < rowsIn.length; k++) {
      var r = rowsIn[k].replace(/\r/g, "");
      if (!r) continue;
      var f = r.split("|");
      if (f.length < 4) continue;
      var s = parseUtcStamp(f[1]), e = parseUtcStamp(f[2]);
      if (!s || !e || e <= s) continue;
      var key = f[0];
      if (!guideByLcn[key]) guideByLcn[key] = [];
      guideByLcn[key].push({ s: s, e: e, title: f[3] || "(no title)", desc: f[4] || "",
                             sub: f[5] || "", ep: normEp(f[6] || "") });
      if (e > guideMaxEnd) guideMaxEnd = e;
      kept++;
    }
    for (var key2 in guideByLcn) {
      if (guideByLcn.hasOwnProperty(key2)) {
        guideByLcn[key2].sort(function (a, b) { return a.s - b.s; });
      }
    }

    loadFavourites();
    loadOffsets();
    recomputeGuideMaxEnd();
    buildGuideRows();
    guideLoaded = true;
    guideLoadedAt = Date.now();
    try { guideSig = String(readTextFile("/root/guide_channels.txt") || "").slice(0, 4000); } catch (e) { guideSig = ""; }
    report("guide_loaded", {
      path: gPath, programmes: kept, rows: guideRows.length,
      xmlChannels: Object.keys(guideByLcn).length, logos: Object.keys(logos).length,
      ms: Date.now() - t0
    });
    return true;
  }

  // Blanket 30 min lookback: at 17:55 the window starts at 17:00 instead of 17:30,
  // so the half hour just gone stays on screen. The "now" line is drawn from its
  // true timestamp relative to visStart, so it stays in the correct place.
  function guideBaseStart() { return Math.floor(Date.now() / 1800000) * 1800000 - 1800000; }

  // ---------- favourites + per-channel guide offset ----------
  function loadFavourites() {
    favourites = {};
    var txt = readTextFile(FAV_PATH);
    if (!txt) return;
    var lines = String(txt).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/\r/g, "").trim();
      if (ln) favourites[ln] = true;
    }
  }

  function saveFavourites() {
    var out = [];
    for (var k in favourites) if (favourites.hasOwnProperty(k)) out.push(k);
    out.sort(function (a, b) { return Number(a) - Number(b); });
    writeTextFile(FAV_PATH, out.join("\n") + (out.length ? "\n" : ""));
  }

  function loadOffsets() {
    guideOffsets = {};
    var txt = readTextFile(OFF_PATH);
    if (!txt) return;
    var lines = String(txt).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/\r/g, "").trim();
      if (!ln) continue;
      var p = ln.split("\t");
      if (p.length >= 2) {
        var m = Number(p[1]);
        if (!isNaN(m) && m !== 0) guideOffsets[p[0]] = m;
      }
    }
  }

  function saveOffsets() {
    var out = [];
    for (var k in guideOffsets) if (guideOffsets.hasOwnProperty(k)) out.push(k + "\t" + guideOffsets[k]);
    writeTextFile(OFF_PATH, out.join("\n") + (out.length ? "\n" : ""));
  }

  function offsetFor(lcn) { return (guideOffsets[String(lcn)] || 0) * 60000; }

  function recomputeGuideMaxEnd() {
    guideMaxEnd = 0;
    for (var k in guideByLcn) {
      if (!guideByLcn.hasOwnProperty(k)) continue;
      var arr = guideByLcn[k];
      var off = offsetFor(k);
      for (var j = 0; j < arr.length; j++) {
        var e = arr[j].e + off;
        if (e > guideMaxEnd) guideMaxEnd = e;
      }
    }
  }

  function buildGuideRows() {
    guideRows = [];
    for (var m = 0; m < lcns.length; m++) {
      var lcn = lcns[m];
      if (guideFavOnly && !favourites[String(lcn)]) continue;
      var gname = guideChans[String(lcn)];
      var hasData = !!(guideByLcn[String(lcn)] && guideByLcn[String(lcn)].length);
      guideRows.push({
        lcn: lcn,
        name: gname || channelName(lcn) || ("CH " + lcn),
        hasData: hasData
      });
    }
  }

  function guideMaxScroll() {
    if (!guideMaxEnd) return 0;
    var mins = Math.floor((guideMaxEnd - guideBaseStart()) / 60000) - G_WINDOW_MIN + G_STEP_MIN;
    return mins > 0 ? Math.ceil(mins / G_STEP_MIN) * G_STEP_MIN : 0;
  }

  function openGuide() {
    if (!ready) { toast("NOT READY"); return; }
    state = "GUIDE";
    gScroll = 0;
    guideOpts = false;
    if (!loadGuide()) {
      var el = ensureUI();
      el.style.display = "block";
      el.textContent = "";
      var d = document.createElement("div");
      d.textContent = "No guide data cached yet.\n\n" +
        (settings.use_xmltv ? "The XML TV guide has not downloaded yet - check Settings." :
                              "XML TV guide is switched off in Settings.");
      d.style.whiteSpace = "pre";
      el.appendChild(d);
      showHelp();
      return;
    }
    gSel = 0;
    for (var i = 0; i < guideRows.length; i++) {
      if (guideRows[i].lcn === current) { gSel = i; break; }
    }
    gOffset = Math.max(0, Math.min(gSel - 2, Math.max(0, guideRows.length - G_VISIBLE_ROWS)));
    renderGuide();
    report("guide_open", { rows: guideRows.length, sel: gSel, base: guideBaseStart(), win: G_WINDOW_MIN });
  }

  // RECORD in the guide schedules the focused programme, snapshotting the pads.
  // What the highlighted block is. At "now" it is the live programme; once the
  // window has been scrolled it follows the window's left edge, otherwise RIGHT
  // moves the grid but never the selection (and REC cannot reach a future show).
  function focusProgramme(lcn, visStart, nowMs) {
    var progs = guideByLcn[String(lcn)] || [];
    var off = offsetFor(lcn);
    var target = (gScroll > 0) ? visStart : nowMs;
    for (var i = 0; i < progs.length; i++) {
      if (progs[i].e + off > target) return progs[i];
    }
    return null;
  }

  function addTimerForFocus() {
    var row = guideRows[gSel];
    if (!row) return;
    var progs = guideByLcn[String(row.lcn)] || [];
    var off = offsetFor(row.lcn);
    var visStart = guideBaseStart() + gScroll * 60000;
    // Same rule as the highlight, so REC always records the block that looks selected.
    var pick = focusProgramme(row.lcn, visStart, Date.now());
    if (!pick) { toast("NO PROGRAMME"); return; }
    var startSec = Math.floor((pick.s + off) / 1000);
    var durSec = Math.max(60, Math.round((pick.e - pick.s) / 1000));
    for (var t = 0; t < timers.length; t++) {
      if (timers[t].lcn === row.lcn && timers[t].start === startSec) { toast("ALREADY SET"); return; }
    }
    timers.push({
      id: String(Date.now()), lcn: row.lcn, start: startSec, dur: durSec,
      title: pick.title, ep: pick.ep || "", sub: pick.sub || "", series: false,
      pre: settings.pre_pad, post: settings.post_pad, state: "armed"
    });
    timers.sort(function (a, b) { return a.start - b.start; });
    saveTimers();
    timerLog("ADDED  ch" + row.lcn + "  " + pick.title);
    toast("TIMER SET  " + pick.title, 2600);
    report("timer_added", { lcn: row.lcn, start: startSec, dur: durSec, title: pick.title });
  }

  function closeGuide() {
    state = "LIVE";
    guideOpts = false;
    hideList();
    toast("CH " + current);
  }

  function fmtDateAdl(ms) {
    var off = zoneOffsetMinutes(new Date(ms));
    var d = new Date(ms + off * 60000);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2);
  }

  // The box clock is UTC and XMLTV stamps are UTC here, so both sides are
  // unambiguous; only the display needs Adelaide wall-clock time.
  function fmtHM(ms) {
    var off = zoneOffsetMinutes(new Date(ms));
    var d = new Date(ms + off * 60000);
    return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
  }

  // A dim dashed placeholder for an interval no programme covers. Keeps the grid
  // honest (it never invents a title) while making a gap impossible to mistake
  // for a missing row.
  function gapCell(lane, a, b, pxPerMin, visStart, timelineW) {
    var l = Math.max(0, (a - visStart) / 60000 * pxPerMin);
    var r = Math.min(timelineW, (b - visStart) / 60000 * pxPerMin);
    var w = r - l;
    if (w < 4) return;
    var el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = l + "px";
    el.style.width = (w - 2) + "px";
    el.style.top = "4px";
    el.style.bottom = "4px";
    el.style.boxSizing = "border-box";
    el.style.border = "1px dashed rgba(0,255,102,0.28)";
    el.style.borderRadius = "4px";
    el.style.background = "rgba(0,0,0,0.10)";
    el.style.overflow = "hidden";
    el.style.padding = "3px 6px";
    if (w > 110) {
      var t = document.createElement("div");
      t.textContent = "no guide data";
      t.style.fontSize = "13px";
      t.style.opacity = "0.5";
      t.style.whiteSpace = "nowrap";
      t.style.color = "#00ff66";
      el.appendChild(t);
    }
    lane.appendChild(el);
  }

  function renderGuide() {
    var el = ensureUI();
    el.style.display = "block";
    el.textContent = "";
    el.style.padding = "0";

    var panelW = window.innerWidth - 100 - 4;
    var timelineW = panelW - G_LEFT_W;
    var pxPerMin = timelineW / G_WINDOW_MIN;
    // The grid always starts on a 30-minute boundary (the one before "now"), so
    // it never jumps as you move between channels with long and short programmes.
    // Anything already running is clipped to the boundary and drawn from x=0, but
    // still labelled with its true start and end times.
    var base = guideBaseStart();
    var visStart = base + gScroll * 60000;
    var nowMs = Date.now();

    // time ruler
    var head = document.createElement("div");
    head.style.position = "relative";
    head.style.height = G_HEADER_H + "px";
    head.style.borderBottom = "2px solid #00ff66";
    head.style.marginLeft = G_LEFT_W + "px";
    var tickStart = Math.ceil(visStart / 1800000) * 1800000;
    for (var tt = tickStart; tt <= visStart + G_WINDOW_MIN * 60000; tt += 1800000) {
      var m = (tt - visStart) / 60000;
      var tick = document.createElement("span");
      tick.textContent = fmtHM(tt);
      tick.style.position = "absolute";
      tick.style.left = (m * pxPerMin) + "px";
      tick.style.top = "0";
      tick.style.fontSize = "20px";
      tick.style.borderLeft = "1px solid rgba(0,255,102,0.5)";
      tick.style.paddingLeft = "6px";
      head.appendChild(tick);
    }
    var lbl = document.createElement("span");
    lbl.textContent = "GUIDE";
    lbl.style.position = "absolute";
    lbl.style.left = "-" + (G_LEFT_W - 6) + "px";
    lbl.style.fontSize = "20px";
    head.appendChild(lbl);
    el.appendChild(head);

    var focusDesc = "";
    var rowsWrap = document.createElement("div");
    rowsWrap.style.position = "relative";
    var last = Math.min(gOffset + G_VISIBLE_ROWS, guideRows.length);
    for (var r = gOffset; r < last; r++) {
      var row = guideRows[r];
      var isSel = (r === gSel);
      var off = offsetFor(row.lcn);
      var offMin = Math.round(off / 60000);

      var rowEl = document.createElement("div");
      rowEl.style.position = "relative";
      rowEl.style.height = G_ROW_H + "px";
      rowEl.style.borderBottom = "1px solid rgba(0,255,102,0.25)";
      rowEl.style.background = isSel ? "rgba(0,255,102,0.18)" : "transparent";

      // left column: logo, then channel name
      var left = document.createElement("div");
      left.style.position = "absolute";
      left.style.left = "0";
      left.style.top = "0";
      left.style.width = (G_LEFT_W - 8) + "px";
      left.style.height = "100%";
      left.style.overflow = "hidden";
      left.style.textAlign = "center";
      var uri = logos[String(row.lcn)];
      if (uri) {
        var img = document.createElement("img");
        img.src = uri;
        img.style.maxHeight = "44px";
        img.style.maxWidth = (G_LEFT_W - 16) + "px";
        img.style.marginTop = "8px";
        img.style.display = "block";
        img.style.marginLeft = "auto";
        img.style.marginRight = "auto";
        left.appendChild(img);
      }
      var nm = document.createElement("div");
      nm.textContent = row.lcn + "  " + row.name + (offMin ? "  (" + (offMin > 0 ? "+" : "") + offMin + "m)" : "");
      nm.style.fontSize = "15px";
      nm.style.whiteSpace = "nowrap";
      nm.style.overflow = "hidden";
      nm.style.textOverflow = "ellipsis";
      nm.style.padding = "2px 4px 0 4px";
      nm.style.color = isSel ? "#ffffff" : "#00ff66";
      left.appendChild(nm);
      rowEl.appendChild(left);

      // programme lane
      var lane = document.createElement("div");
      lane.style.position = "absolute";
      lane.style.left = G_LEFT_W + "px";
      lane.style.right = "0";
      lane.style.top = "0";
      lane.style.height = "100%";
      rowEl.appendChild(lane);

      var progs = guideByLcn[String(row.lcn)] || [];
      var focusP = isSel ? focusProgramme(row.lcn, visStart, nowMs) : null;
      if (focusP) focusDesc = focusP.title + "  (" + fmtHM(focusP.s + off) + " - " + fmtHM(focusP.e + off) + ")" +
                               (focusP.desc ? "\n" + focusP.desc : "");
      var drawn = 0;
      for (var q = 0; q < progs.length; q++) {
        var p = progs[q];
        var ps = p.s + off, pe = p.e + off;
        if (pe <= visStart || ps >= visStart + G_WINDOW_MIN * 60000) continue;
        var leftPx = Math.max(0, (ps - visStart) / 60000 * pxPerMin);
        var rightPx = Math.min(timelineW, (pe - visStart) / 60000 * pxPerMin);
        var wPx = rightPx - leftPx;
        if (wPx < 6) continue;
        var isFocus = (p === focusP);
        var blk = document.createElement("div");
        blk.style.position = "absolute";
        blk.style.left = leftPx + "px";
        blk.style.width = (wPx - 3) + "px";
        blk.style.top = "4px";
        blk.style.bottom = "4px";
        blk.style.overflow = "hidden";
        // without border-box the padding+border push each block ~11 px past its
        // slot, which reads as neighbouring programmes overlapping by a minute
        blk.style.boxSizing = "border-box";
        blk.style.border = isFocus ? "2px solid #ffffff" : "1px solid rgba(0,255,102,0.55)";
        blk.style.borderRadius = "4px";
        blk.style.padding = "3px 6px";
        blk.style.background = isFocus ? "rgba(0,255,102,0.30)" :
                               (isSel ? "rgba(0,255,102,0.10)" : "rgba(0,0,0,0.25)");
        // the lookback slot can already have aired; dim it so "now" stays obvious
        if (pe <= nowMs) blk.style.opacity = "0.55";

        var t1 = document.createElement("div");
        t1.textContent = p.title;
        t1.style.fontSize = "17px";
        t1.style.whiteSpace = "nowrap";
        t1.style.overflow = "hidden";
        t1.style.textOverflow = "ellipsis";
        t1.style.color = (isSel || isFocus) ? "#ffffff" : "#00ff66";
        blk.appendChild(t1);

        var t2 = document.createElement("div");
        t2.textContent = fmtHM(ps) + " - " + fmtHM(pe);
        t2.style.fontSize = "14px";
        t2.style.opacity = "0.85";
        blk.appendChild(t2);

        lane.appendChild(blk);
        drawn++;
      }

      // Fill the uncovered intervals. A per-channel offset (GREEN/YELLOW) slides
      // every block, so a gap in the published schedule - or the empty stretch
      // before the first programme guide.txt carries - can end up under the
      // "now" line and read as a blank programme.
      var winEnd = visStart + G_WINDOW_MIN * 60000;
      var cursor = visStart;
      for (var gq = 0; gq < progs.length; gq++) {
        var gs = progs[gq].s + off, ge = progs[gq].e + off;
        if (ge <= visStart) continue;
        if (gs >= winEnd) break;
        if (gs > cursor) gapCell(lane, cursor, Math.min(gs, winEnd), pxPerMin, visStart, timelineW);
        if (ge > cursor) cursor = ge;
      }
      if (cursor < winEnd) gapCell(lane, cursor, winEnd, pxPerMin, visStart, timelineW);

      if (!drawn) {
        var none = document.createElement("div");
        none.textContent = row.hasData ? "" : "No programme guide information for this channel";
        none.style.position = "absolute";
        none.style.left = "8px";
        none.style.top = G_ROW_H / 2 - 10 + "px";
        none.style.fontSize = "16px";
        none.style.opacity = "0.7";
        lane.appendChild(none);
      }
      rowsWrap.appendChild(rowEl);
    }
    el.appendChild(rowsWrap);

    // mark "now" only when it falls inside the window - scrolling keeps its true
    // position instead of pinning a line to the middle of the grid
    var nowT = nowMs;
    if (nowT >= visStart && nowT <= visStart + G_WINDOW_MIN * 60000) {
      var nl = document.createElement("div");
      nl.style.position = "absolute";
      nl.style.left = (G_LEFT_W + (nowT - visStart) / 60000 * pxPerMin - 1) + "px";
      nl.style.top = "0";
      nl.style.bottom = "0";
      nl.style.width = "2px";
      nl.style.background = "rgba(255,255,255,0.55)";
      nl.style.pointerEvents = "none";
      rowsWrap.appendChild(nl);
    }

    // footer carries the highlighted programme's description, when it has one
    var foot = document.createElement("div");
    foot.style.fontSize = "15px";
    foot.style.lineHeight = "1.25";
    foot.style.opacity = "0.9";
    foot.style.padding = "2px 2px";
    foot.style.maxHeight = "58px";
    foot.style.overflow = "hidden";
    foot.textContent = focusDesc || "";
    el.appendChild(foot);

    // channel options, opened with LEFT while the grid is at "now"
    if (guideOpts) {
      var rowS = guideRows[gSel];
      var lcnS = rowS ? rowS.lcn : current;
      var isFav = !!favourites[String(lcnS)];
      var offS = guideOffsets[String(lcnS)] || 0;
      var pop = document.createElement("div");
      pop.dataset.hermesOurs = "1";
      pop.style.position = "absolute";
      pop.style.right = "18px";
      pop.style.bottom = "56px";
      pop.style.padding = "14px 20px";
      pop.style.border = "2px solid #ffffff";
      pop.style.background = "rgba(0,12,4,0.96)";
      pop.style.color = "#00ff66";
      pop.style.font = "17px/1.55 monospace";
      pop.style.whiteSpace = "pre";
      pop.style.zIndex = "10";
      pop.textContent =
        "CH " + lcnS + "  " + (rowS ? rowS.name : "") + "\n" +
        "RED     Favourite: " + (isFav ? "ON" : "OFF") + "\n" +
        "GREEN   Guide -30 min     YELLOW   Guide +30 min\n" +
        "BLUE    Showing: " + (guideFavOnly ? "favourites" : "all channels") + "\n" +
        "Offset: " + (offS > 0 ? "+" : "") + offS + " min\n" +
        "BACK    close";
      el.appendChild(pop);
    }

    showHelp();
  }

  // ---------- key handling ----------
  function onKey(e) {
    var kc = e.keyCode || e.which || 0;
    var kn = String((e && e.key) || "");

    // modal delete confirmation is handled before the state machine
    if (confirmCb) {
      var cb = confirmCb;
      closeConfirm();
      if (kc === K.OK) cb();
      return;
    }

    if (state === "MENU") {
      if (kc === K.LEFT || kc === K.RIGHT) {
        tab = (tab + (kc === K.RIGHT ? 1 : -1) + TABS.length) % TABS.length;
        // preview: refresh the pane that is now showing, without taking focus
        if (tab === 1) { timSel = 0; loadTimers(); }
        else if (tab === 2 || tab === 3) { setSel = 0; }
        render();
        report("menu_tab", { tab: tab });
        return;
      }
      if (kc === K.OK) {
        if (tab === 0) enterList();
        else if (tab === 1) enterTimers();
        else enterSettings(tab === 3 ? 1 : 0);
        return;
      }
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { closeMenu(); return; }
      return;
    }

    if (state === "SETTINGS") {
      var rows = settingsRows();
      if (kc === K.UP) { setSel = nextSelectable(setSel, -1); render(); return; }
      if (kc === K.DOWN) { setSel = nextSelectable(setSel, 1); render(); return; }
      if (kc === K.OK) {
        var r = rows[setSel];
        if (r && r.type === "toggle") {
          if (r.key === "use_xmltv") {
            settings.use_xmltv = !settings.use_xmltv;
            saveSettings();
            toast("XML TV guide " + (settings.use_xmltv ? "ON" : "OFF"), 2200);
          } else if (r.key === "mark_viewed") {
            settings.mark_viewed = !settings.mark_viewed;
            saveSettings();
            toast("Viewed tracking " + (settings.mark_viewed ? "ON" : "OFF"), 2200);
          } else if (r.key === "ts_enabled") {
            settings.ts_enabled = !settings.ts_enabled;
            saveSettings();
            toast("Live buffer " + (settings.ts_enabled ? "ON" : "OFF"), 2200);
            if (settings.ts_enabled) { tsEnsureBuffer(); } else { tsStop("disabled"); tsMode = "off"; }
          } else if (r.key === "maint_enabled") {
            settings.maint_enabled = !settings.maint_enabled;
            saveSettings();
            toast("Auto-delete " + (settings.maint_enabled ? "ON" : "OFF"), 2200);
          } else if (r.key === "maint_dryrun") {
            settings.maint_dryrun = !settings.maint_dryrun;
            saveSettings();
            toast("Cleanup dry run " + (settings.maint_dryrun ? "ON" : "OFF"), 2200);
          }
          render();
          return;
        }
        if (r && r.type === "choice") {
          var ci2 = r.options.indexOf(settings[r.key]);
          if (ci2 < 0) ci2 = 0;
          applyChoice(r.key, r.options[(ci2 + 1) % r.options.length]);
          render();
          return;
        }
        if (r && r.type === "action" && r.key === "guide_refresh") {
          try { writeTextFile("/root/xmltv/refresh_req", "1"); } catch (e) {}
          toast("GUIDE REFRESH REQUESTED\nTAKES UP TO 5 MIN", 3000);
          report("guide_refresh", { city: settings.guide_city });
          render();
          return;
        }
        if (r && r.type === "action" && r.key === "scan_channels") {
          askConfirm("RESCAN CHANNELS?", "Takes about 3 minutes",
                     "ENTER starts    any other key cancels",
                     function () { state = "LIVE"; rescanChannels(); });
          return;
        }
        if (r && r.type === "action" && r.key === "maint_run") {
          maintRun("manual", true);
          render();
        }
        return;
      }
      if (kc === K.LEFT || kc === K.RIGHT) {
        var nr = rows[setSel];
        if (nr && nr.type === "choice") {
          var ci = nr.options.indexOf(settings[nr.key]);
          if (ci < 0) ci = 0;
          ci = (ci + (kc === K.RIGHT ? 1 : -1) + nr.options.length) % nr.options.length;
          applyChoice(nr.key, nr.options[ci]);
          render();
          return;
        }
        if (nr && nr.type === "number") {
          // NOT "step": a hoisted var of that name shadows step(dir) for the
          // whole handler and silently breaks CH+/CH-.
          var stepVal = (kc === K.LEFT ? -1 : 1) * (nr.step || 1);
          var nv = Math.min(nr.max, Math.max(nr.min, nr.value + stepVal));
          if (nr.key === "pre_pad") settings.pre_pad = nv;
          else if (nr.key === "post_pad") settings.post_pad = nv;
          else if (nr.key === "viewed_pct") settings.viewed_pct = nv;
          else if (nr.key === "maint_free_gb") settings.maint_free_gb = nv;
          else if (nr.key === "protect_hours") settings.protect_hours = nv;
          else if (nr.key === "ts_buffer_min") {
            settings.ts_buffer_min = nv;
            if (tsActive) { tsStop("resize"); tsMode = "off"; tsEnsureBuffer(); }
          }
          saveSettings();
          render();
        }
        return;
      }
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { backToMenu(); return; }
      return;
    }

    if (state === "TIMERS") {
      if (kc === K.UP) { timSel = Math.max(0, timSel - 1); renderTimers(); return; }
      if (kc === K.DOWN) { timSel = Math.min(Math.max(0, timers.length - 1), timSel + 1); renderTimers(); return; }
      if (kc === K.OK) {
        var st = timers[timSel];
        if (st) {
          if (!st.series && !normEp(st.ep) && !String(st.sub || "").trim()) {
            // Without an episode code or an episode title two airings cannot be
            // told apart, so a link would either skip a real episode or record
            // the same one twice.
            toast("NO EPISODE INFO\nCAN'T SERIES LINK", 2600);
            return;
          }
          st.series = !st.series;
          // turning series on for a finished/skipped timer jumps it to the next
          // matching episode so the link takes effect immediately
          if (st.series && (st.state === "done" || st.state === "missed" ||
                            st.state === "skipped" || st.state === "waiting")) {
            advanceSeries(st, Date.now());
          }
          saveTimers();
          renderTimers();
          toast(st.series ? "SERIES LINK ON" : "SERIES LINK OFF");
        }
        return;
      }
      if (kc === K.REC) {
        if (timers[timSel]) {
          var gone = timers[timSel];
          var wasRecording = (gone.state === "recording");
          timers.splice(timSel, 1);
          saveTimers();
          if (wasRecording && recId !== null) {
            // the timer owns this recording; leaving it would orphan a recording
            // that nothing will ever stop
            try { hw.stopDvbRecording(recHandle); } catch (e) {}
            report("timer_stop", { id: gone.id, lcn: gone.lcn, by: "delete" });
            recId = null; recHandle = null; recLcn = null; recName = null;
            timerLog("DELETED + REC STOPPED  ch" + gone.lcn + "  " + gone.title);
          } else {
            timerLog("DELETED  ch" + gone.lcn + "  " + gone.title);
          }
          timSel = Math.max(0, Math.min(timSel, timers.length - 1));
          renderTimers();
          toast(wasRecording ? "TIMER DELETED, REC STOPPED" : "TIMER DELETED");
        }
        return;
      }
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { backToMenu(); return; }
      return;
    }

    if (state === "GUIDE") {
      if (kc === K.BACK && guideOpts) { guideOpts = false; renderGuide(); return; }
      if (kc === K.REC) { addTimerForFocus(); return; }

      if (kc === K.BLUE) {
        guideFavOnly = !guideFavOnly;
        var keepLcn = guideRows[gSel] ? guideRows[gSel].lcn : current;
        buildGuideRows();
        if (!guideRows.length) { guideFavOnly = false; buildGuideRows(); toast("NO FAVOURITES YET", 2200); }
        gSel = 0;
        for (var bi = 0; bi < guideRows.length; bi++) {
          if (guideRows[bi].lcn === keepLcn) { gSel = bi; break; }
        }
        gOffset = Math.max(0, Math.min(gSel - 2, Math.max(0, guideRows.length - G_VISIBLE_ROWS)));
        renderGuide();
        toast(guideFavOnly ? "FAVOURITES ONLY" : "ALL CHANNELS", 2200);
        return;
      }

      if (kc === K.RED) {
        var lcnR = guideRows[gSel] ? guideRows[gSel].lcn : current;
        if (favourites[String(lcnR)]) { delete favourites[String(lcnR)]; toast("FAV REMOVED CH " + lcnR, 2200); }
        else { favourites[String(lcnR)] = true; toast("FAV ADDED CH " + lcnR, 2200); }
        saveFavourites();
        if (guideFavOnly) {
          buildGuideRows();
          if (!guideRows.length) { guideFavOnly = false; buildGuideRows(); }
          gSel = Math.max(0, Math.min(gSel, guideRows.length - 1));
          gOffset = Math.max(0, Math.min(gSel - 2, Math.max(0, guideRows.length - G_VISIBLE_ROWS)));
        }
        renderGuide(); return;
      }

      if (kc === K.GREEN || kc === K.YELLOW) {
        var lcnO = guideRows[gSel] ? guideRows[gSel].lcn : current;
        var dO = (kc === K.GREEN) ? -30 : 30;
        guideOffsets[String(lcnO)] = (guideOffsets[String(lcnO)] || 0) + dO;
        if (guideOffsets[String(lcnO)] === 0) delete guideOffsets[String(lcnO)];
        saveOffsets();
        recomputeGuideMaxEnd();
        renderGuide();
        toast("GUIDE " + (dO > 0 ? "+" : "") + dO + " MIN  CH " + lcnO, 2200);
        return;
      }

      if (kc === K.UP || kc === K.DOWN) {
        gSel = (kc === K.UP) ? Math.max(0, gSel - 1) : Math.min(guideRows.length - 1, gSel + 1);
        if (gSel < gOffset) gOffset = gSel;
        if (gSel >= gOffset + G_VISIBLE_ROWS) gOffset = gSel - G_VISIBLE_ROWS + 1;
        renderGuide(); return;
      }
      if (kc === K.LEFT || kc === K.RIGHT) {
        var gmax2 = guideMaxScroll();
        if (kc === K.LEFT) {
          if (gScroll > 0) { gScroll = Math.max(0, gScroll - G_STEP_MIN); renderGuide(); }
          else { guideOpts = !guideOpts; renderGuide(); }
        } else if (gScroll < gmax2) {
          gScroll = Math.min(gmax2, gScroll + G_STEP_MIN); renderGuide();
        }
        var fpRow = guideRows[gSel];
        var fp = fpRow ? focusProgramme(fpRow.lcn, guideBaseStart() + gScroll * 60000, Date.now()) : null;
        report("guide_scroll", { scroll: gScroll, focus: fp ? fp.title : null, start: fp ? fp.s : 0 });
        return;
      }
      if (kc === K.OK) {
        var selRow = guideRows[gSel];
        if (selRow) {
          current = selRow.lcn;
          closeGuide();
          tune(selRow.lcn, true);
          report("guide_tune", { lcn: selRow.lcn });
        }
        return;
      }
      if (kc === K.BACK || kc === K.EXIT || kc === K.GUIDE || kc === K.MENU) {
        closeGuide(); return;
      }
      return;
    }

    if (state === "LIST") {
      if (kc === K.UP) { sel = (sel - 1 + items.length) % Math.max(items.length, 1); renderList(); return; }
      if (kc === K.DOWN) { sel = (sel + 1) % Math.max(items.length, 1); renderList(); return; }
      if (kc === K.RIGHT) {
        sel = Math.min(Math.max(items.length - 1, 0), sel + 12); renderList(); return;
      }
      if (kc === K.LEFT) {
        sel = Math.max(0, sel - 12); renderList(); return;
      }
      if (kc === K.OK) { playItem(); return; }
      if (kc === K.REC) { deleteCurrent(); return; }
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { backToMenu(); return; }
      return;
    }

    if (state === "PLAYBACK") {
      if (kc === K.PLAY) { togglePause(); return; }
      if (kc === K.FF || kc === K.RIGHT) { seekBy(30); return; }
      if (kc === K.RW || kc === K.LEFT) { seekBy(-30); return; }
      if (kc === K.STOP || kc === K.BACK || kc === K.EXIT) { stopPlayback(); return; }
      return;
    }

    // LIVE
    if (kc === K.PLAY) { tsTogglePause(); return; }
    if (kc === K.STOP) { if (tsMode === "paused" || tsMode === "behind") { tsSync(); return; } }
    if (kc === K.RIGHT) { if (tsActive) { tsSeekBy(+30); return; } }
    if (kc === K.LEFT) { if (tsActive) { tsSeekBy(-30); return; } }
    if (kc === K.DOWN) { reshowOsd(); return; }
    if (kc === K.REC) { if (recId !== null) stopRecording(); else startRecording(); return; }
    if (kc === K.MENU || kc === K.APPS) { openMenu(); return; }
    if (kc === K.CHUP || kn === "ChannelUp" || kn === "PageUp") { commitDigits(); step(+1); return; }
    if (kc === K.CHDN || kn === "ChannelDown" || kn === "PageDown") { commitDigits(); step(-1); return; }
    if (kc >= 48 && kc <= 57) {
      digits += String(kc - 48);
      toast("CH " + digits, 1200);
      if (digitTimer) clearTimeout(digitTimer);
      digitTimer = setTimeout(commitDigits, 2000);
      return;
    }
    if (kc === K.GUIDE) { openGuide(); return; }
    if (digits) commitDigits();
  }


  // ---------- storage / maintenance ----------
  // The PVR index is newest-first (index 0 = most recent), so "oldest" means
  // walking the index backwards. Dates in the index are not trustworthy for
  // ordering: stamps have been seen months in the future, so age comes from
  // position, not from the stamp.
  var diskCache = { freeKB: 0, totalKB: 0, apiFreeKB: 0, dfAt: 0, at: 0 };

  // The native call over-reports free space by ~70 GB on this unit, so df wins
  // whenever the wrapper's 5-minute sample is fresh. The API value is kept for
  // comparison in the report rather than trusted.
  function diskKB() {
    try { diskCache.apiFreeKB = Number(nat.Ag_record_getDiskFreeSize()) || 0; } catch (e) {}
    try { diskCache.totalKB = Number(nat.Ag_record_getDiskTotalSize()) || 0; } catch (e) {}
    diskCache.freeKB = diskCache.apiFreeKB;
    var txt = readTextFile("/root/hermes_storage.txt");
    if (txt) {
      // "<epoch> /dev/sda1 <totalKB> <usedKB> <availKB> <use%> <mount>"
      var f = String(txt).trim().split(/\s+/);
      var at = Number(f[0]) || 0;
      var avail = Number(f[4]) || 0;
      if (avail > 0 && at > 0 && (Date.now() / 1000 - at) < 1200) {
        diskCache.freeKB = avail;
        diskCache.dfAt = at * 1000;
      }
    }
    diskCache.at = Date.now();
    return diskCache;
  }

  function seenCount() {
    var c = 0;
    for (var k in viewed) if (viewed.hasOwnProperty(k)) c++;
    return c;
  }

  function storageText() {
    var d = diskCache.totalKB ? diskCache : diskKB();
    if (!d.totalKB) return "-";
    return Math.round(d.freeKB / 1048576) + " GB free of " + Math.round(d.totalKB / 1048576) +
           " GB    " + totalCount + " recs    " + seenCount() + " viewed";
  }

  // Read-only: works out the order it would delete in and reports it. Deletes
  // nothing. Order is viewed-oldest-first, then unviewed-oldest-first, skipping
  // the recording in progress, the file being played, and anything newer than
  // settings.protect_hours.
  function maintAudit() {
    var d = diskKB();
    var n = 0;
    try { n = Number(hw.getRecordingCount()) || 0; } catch (e) {}
    var rows = [];
    for (var i = 0; i < n; i++) {
      var it = buildItem(i);
      if (!it) continue;
      rows.push({
        idx: i, id: it.id, name: labelFor(it), kb: Number(it.sizeRaw) || 0,
        seen: !!viewed[String(it.id)],
        live: (recId !== null && it.id === recId),
        playing: (pbId !== null && it.id === pbId),
        stamp: it.when || ""
      });
    }
    var freeGB = d.freeKB / 1048576;
    var viewedQ = [], unseenQ = [];
    for (var k = rows.length - 1; k >= 0; k--) {     // backwards = oldest first
      var r = rows[k];
      if (r.live || r.playing) continue;
      (r.seen ? viewedQ : unseenQ).push(r);
    }
    var target = Number(settings.maint_free_gb) || 0;
    var plan = [], acc = 0;
    function take(q) {
      for (var j = 0; j < q.length && freeGB + acc < target; j++) {
        plan.push({ idx: q[j].idx, id: q[j].id, name: q[j].name,
                    gb: +(q[j].kb / 1048576).toFixed(2), seen: q[j].seen });
        acc += q[j].kb / 1048576;
      }
    }
    take(viewedQ);
    take(unseenQ);

    // the order it *would* use, shown even when no space is needed
    var order = [];
    for (var q = 0; q < 12; q++) {
      var src = (q < viewedQ.length) ? viewedQ[q] : unseenQ[q - viewedQ.length];
      if (!src) break;
      order.push({ idx: src.idx, name: src.name,
                   gb: +(src.kb / 1048576).toFixed(2), seen: src.seen });
    }
    var out = {
      at: Date.now(), count: rows.length,
      freeGB: +freeGB.toFixed(1), apiFreeGB: +(d.apiFreeKB / 1048576).toFixed(1),
      totalGB: +(d.totalKB / 1048576).toFixed(1), dfAge: d.dfAt ? Math.round((Date.now() - d.dfAt) / 1000) : -1,
      targetGB: target, viewed: viewedQ.length, unviewed: unseenQ.length,
      wouldFreeGB: +acc.toFixed(1), planCount: plan.length,
      plan: plan.slice(0, 60), order: order,
      sample: rows.slice(0, 4).concat(rows.slice(-4))
    };
    writeTextFile("/root/hermes_maint_report.json", JSON.stringify(out));
    report("maint_audit", {
      count: out.count, freeGB: out.freeGB, apiFreeGB: out.apiFreeGB, dfAge: out.dfAge,
      targetGB: target, order: order,
      viewed: out.viewed, unviewed: out.unviewed,
      planCount: out.planCount, wouldFreeGB: out.wouldFreeGB,
      first: plan.slice(0, 5)
    });
    return out;
  }


  // ---------- cleanup (live) ----------
  var MAINT_LOG = "/root/hermes_maint_log.txt";

  function maintLog(msg) {
    var prev = readTextFile(MAINT_LOG) || "";
    var lines = String(prev).split("\n");
    if (lines.length && !lines[lines.length - 1]) lines.pop();
    var d = new Date();
    lines.push(p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + " UTC  " + msg);
    if (lines.length > 300) lines = lines.slice(lines.length - 300);
    writeTextFile(MAINT_LOG, lines.join("\n") + "\n");
  }

  // Deletes until free space is back above the threshold.
  // Order: viewed oldest first, then unviewed oldest first. Never touches the
  // recording in progress or the file being played, and (when protect_hours is
  // set) stops at anything newer than that.
  //
  // Index handling: Ag_playBack_deleteFile takes a POSITION, and removing an
  // entry shifts every later position down by one. So after each deletion the
  // queue's stored positions are decremented, rather than trusting stale indices
  // or re-walking a 480-entry index twenty times.
  function maintRun(reason, force) {
    if (!force && !settings.maint_enabled) return null;
    var target = Number(settings.maint_free_gb) || 0;
    if (target <= 0) return null;

    var d = diskKB();
    var freeGB = d.freeKB / 1048576;
    if (freeGB >= target) {
      report("maint_skip", { reason: reason, freeGB: +freeGB.toFixed(1), targetGB: target });
      if (reason === "manual") { toast("NO CLEANUP NEEDED\n" + Math.round(freeGB) + " GB FREE", 2600); }
      return null;
    }

    var n = 0;
    try { n = Number(hw.getRecordingCount()) || 0; } catch (e) {}
    var viewedQ = [], unseenQ = [];
    var protectHours = Number(settings.protect_hours) || 0;
    var protectMs = protectHours * 3600000;
    var now = Date.now();
    for (var i = n - 1; i >= 0; i--) {          // backwards = oldest first
      var it = buildItem(i);
      if (!it) continue;
      if (recId !== null && it.id === recId) continue;      // recording now
      if (pbId !== null && it.id === pbId) continue;        // playing now
      // Stamps from the index have been seen a day in the future, so age is
      // checked by POSITION as well: index 0 is the newest entry and one entry
      // averages about an hour, so the newest protect_hours entries are kept.
      // Either test protecting the file is enough to skip it.
      if (protectMs > 0 && i < protectHours) continue;
      var ageMs = it.whenMs ? (now - it.whenMs) : 0;
      if (protectMs > 0 && ageMs > 0 && ageMs < protectMs) continue;
      var row = { idx: i, id: it.id, name: labelFor(it), kb: Number(it.sizeRaw) || 0,
                  seen: !!viewed[String(it.id)] };
      (row.seen ? viewedQ : unseenQ).push(row);
    }

    var queue = viewedQ.concat(unseenQ);
    var dry = !!settings.maint_dryrun;
    var gone = 0, freed = 0, failed = 0;

    while (queue.length && freeGB < target && gone < 20) {
      var c = queue.shift();
      if (dry) {
        maintLog("WOULD DELETE  " + c.name + "  " + (c.kb / 1048576).toFixed(2) + " GB  (" + (c.seen ? "viewed" : "unviewed") + ")");
        freed += c.kb / 1048576;
        freeGB += c.kb / 1048576;
        gone++;
        continue;
      }
      var ret = null;
      try { ret = nat.Ag_playBack_deleteFile(c.idx); } catch (e) { ret = "throw:" + String(e).slice(0, 40); }
      if (!(ret === 0 || ret === "0")) {
        maintLog("DELETE FAILED  " + c.name + "  idx " + c.idx + "  ret " + ret);
        failed++;
        break;                                 // index state is suspect now
        }
      maintLog("DELETED  " + c.name + "  " + (c.kb / 1048576).toFixed(2) + " GB  (" + (c.seen ? "viewed" : "unviewed") + ")  reason " + reason);
      if (c.id !== null && c.id !== undefined) {
        delete viewed[String(c.id)];
        delete recChannel[String(c.id)];
        delete recEp[String(c.id)];
        delete recDay[String(c.id)];
        delete recSub[String(c.id)];
      }
      freed += c.kb / 1048576;
      freeGB += c.kb / 1048576;
      gone++;
      for (var z = 0; z < queue.length; z++) {
        if (queue[z].idx > c.idx) queue[z].idx -= 1;
      }
    }

    if (!dry) {
      saveViewed();
      saveNames();
      diskKB();
    }
    // freeGB here is the loop's own estimate: df is sampled by the shell every
    // 5 min, so re-reading it immediately would report the pre-deletion figure.
    var out = { reason: reason, dry: dry, deleted: gone, failed: failed,
                freedGB: +freed.toFixed(2), freeGB: +freeGB.toFixed(1),
                targetGB: target };
    report("maint_run", out);
    maintLog("RUN " + reason + "  " + (dry ? "DRY RUN " : "") + "deleted " + gone +
             "  freed " + out.freedGB + " GB  free now " + out.freeGB + " GB  target " + target + " GB");
    if (reason === "manual") {
      toast((dry ? "DRY RUN: " : "DELETED ") + gone + "\n" + Math.round(out.freeGB) + " GB FREE", 3000);
    }
    return out;
  }


  // ---------- live pause buffer (timeshift / PLTV) ----------
  // Units are the vendor's: getters return SECONDS, seek takes MILLISECONDS,
  // stop takes an argument. Pausing straight from live needs playPltvBuffer()
  // first, and the first pause reports position 0 - both handled in the UI layer.
  var tsActive = false, tsLenSec = 1800;

  function tsCall(name, args) {
    try {
      if (typeof nat[name] !== "function") return "missing";
      return nat[name].apply(nat, args || []);
    } catch (e) {
      report("ts_error", name + " " + String(e).slice(0, 80));
      return "ERR";
    }
  }

  function tsInfo() {
    return {
      active: tsActive,
      status: tsCall("Ag_timeShift_getStatus"),
      rec: tsCall("Ag_timeShift_getRecordTime"),
      play: tsCall("Ag_timeShift_getPlayTime"),
      total: tsCall("Ag_timeShift_getTotalTime"),
      speed: tsCall("Ag_timeShift_getspeed"),
      size: tsCall("Ag_timeShift_getBufferSize")
    };
  }

  function tsStart(secs) {
    if (!ready) return false;
    if (tsActive) return true;
    var len = Math.max(300, Math.min(14400, Number(secs) || tsLenSec));
    tsLenSec = len;
    var set = tsCall("Ag_timeShift_setBufferSize", [len]);
    var started = tsCall("Ag_timeShift_startRecording");
    tsActive = (started === 0);
    report("ts_start", { len: len, set: set, start: started, active: tsActive });
    // watchdog: a buffer that never fills means the tuner is in a state we do not
    // understand, so unwind instead of leaving it half-started
    setTimeout(function () {
      if (!tsActive) return;
      var rec = Number(tsCall("Ag_timeShift_getRecordTime"));
      if (!(rec > 0)) {
        report("ts_dead", tsInfo());
        tsStop("watchdog");
      } else {
        report("ts_ok", tsInfo());
      }
    }, 6000);
    return tsActive;
  }

  function tsStop(why) {
    if (!tsActive) return null;
    var r = tsCall("Ag_timeShift_stop", [1]);
    tsActive = false;
    report("ts_stop", { result: r, why: why || "" });
    return r;
  }


  // ---------- timeshift UI ----------
  // tsMode: off | live (buffering, watching live) | behind | paused
  var tsMode = "off";
  var tsSeekTimer = null, tsSeekTarget = null;
  var tsEls = null;

  function tsEnsureEl() {
    if (tsEls) return tsEls;
    tsEls = makeOsdBox(70);
    tsEls.el.style.display = "none";
    return tsEls;
  }

  // The buffer OSD appears only while paused. Playing behind live, and watching
  // live, show nothing at all.
  function tsHide() { if (tsEls) tsEls.el.style.display = "none"; }

  // The buffer's own clock, in seconds. getPlayTime only counts from the head of
  // the buffer, so once the buffer has wrapped the true position has to be
  // reconstructed - exactly as the stock wrapper does.
  function tsPositionSec() {
    if (tsSeekTarget !== null) return tsSeekTarget;
    var rec = Number(tsCall("Ag_timeShift_getRecordTime"));
    var play = Number(tsCall("Ag_timeShift_getPlayTime"));
    var total = Number(tsCall("Ag_timeShift_getTotalTime"));
    if (!(rec > 0)) return 0;
    if (total > rec) return Math.max(0, rec - (total - play));
    return Math.max(0, play);
  }

  function tsUpdate() {
    if (!tsActive || tsMode !== "paused") { tsHide(); return; }
    var b = tsEnsureEl();
    var rec = Number(tsCall("Ag_timeShift_getRecordTime")) || 0;
    var pos = tsPositionSec();
    var pct = rec > 0 ? Math.min(100, Math.floor((pos / rec) * 100)) : 0;
    var ev = null;
    try { ev = eitNow(current); } catch (e) {}
    var name = (ev && ev.name) ? ev.name : (channelName(current) || ("CH " + current));
    b.title.textContent = "Paused: " + name;
    b.fill.style.width = pct + "%";
    b.pct.textContent = pct + "%";
    b.time.textContent = fmtDur(pos) + " / " + fmtDur(rec);
    b.fin.textContent = "LIVE -" + fmtDur(Math.max(0, rec - pos));
    b.el.style.display = "block";
  }

  function tsEnsureBuffer() {
    if (tsActive) return true;
    var ok = tsStart((Number(settings.ts_buffer_min) || 30) * 60);
    if (ok) tsMode = "live";
    return ok;
  }

  function tsTogglePause() {
    if (!tsEnsureBuffer()) { toast("BUFFER UNAVAILABLE"); return; }
    if (tsMode === "paused") {
      tsCall("Ag_timeShift_resume");
      tsMode = "behind";
    } else {
      // vendor quirk: playback must be moved onto the buffer before pausing,
      // and the first pause reports position 0
      if (tsMode === "live") tsCall("Ag_timeShift_play");
      tsCall("Ag_timeShift_pause");
      tsMode = "paused";
    }
    report("ts_toggle", { mode: tsMode, pos: tsPositionSec() });
    tsUpdate();
  }

  function tsSync() {
    if (!tsActive) return;
    tsCall("Ag_timeShift_sync");
    tsMode = "live";
    report("ts_sync", tsInfo());
    toast("LIVE", 1600);
    tsUpdate();
  }

  // coalesced like the recording OSD: presses move a target and redraw, one seek
  // is issued after the presses stop
  function tsSeekBy(delta) {
    if (!tsEnsureBuffer()) return;
    if (tsMode === "live") { tsCall("Ag_timeShift_play"); tsMode = "behind"; }
    var rec = Number(tsCall("Ag_timeShift_getRecordTime")) || 0;
    var base = (tsSeekTarget !== null) ? tsSeekTarget : tsPositionSec();
    var t = base + delta;
    if (t < 0) t = 0;
    if (rec > 0 && t > rec - 1) t = rec - 1;      // never past the head
    tsSeekTarget = t;
    var wasPaused = (tsMode === "paused");
    tsUpdate();
    toast((delta > 0 ? ">> " : "<< ") + fmtDur(behindLiveText()), 1200);
    if (tsSeekTimer) clearTimeout(tsSeekTimer);
    tsSeekTimer = setTimeout(function () {
      tsSeekTimer = null;
      var pos = tsSeekTarget;
      tsSeekTarget = null;
      // SECONDS, not milliseconds: the vendor multiplies getters by 1000 for
      // display only. Sending ms jumps to the buffer head (out of range) silently.
      tsCall("Ag_timeShift_seek", [Math.round(pos)]);
      // the firmware resumes playback on seek, so re-pause if we came from paused
      if (wasPaused) {
        setTimeout(function () {
          tsCall("Ag_timeShift_pause");
          tsMode = "paused";
          tsUpdate();
          report("ts_seek_paused", { pos: tsPositionSec(), mode: tsMode });
        }, 400);
      } else {
        tsMode = "behind";
        tsUpdate();
      }
      report("ts_seek", { pos: pos, wasPaused: wasPaused });
    }, 400);
  }

  function behindLiveText() {
    var rec = Number(tsCall("Ag_timeShift_getRecordTime")) || 0;
    var pos = tsPositionSec();
    return Math.max(0, rec - pos);
  }

  function tsRetune() {
    // a retune invalidates the buffer: stop it, and start a fresh one if enabled
    if (tsActive) { tsStop("retune"); tsMode = "off"; }
    if (settings.ts_enabled) {
      setTimeout(function () { if (state === "LIVE") tsEnsureBuffer(); }, 3000);
    }
  }


  // ---------- tuner rescan ----------
  // Hybroad_Base.dvbAutoScan() cannot be used from here: it wipes the channel
  // list, then waits for its own CHANNEL_SCAN_BLOCK_END event and polls through
  // top.scheduler - neither of which an injected script sees, so it silently
  // reports 0% forever. The natives it wraps are straightforward, so the stages
  // are driven directly, in the vendor's own band plan:
  //   stage 0  177500 kHz, 7 MHz steps, 8 transponders
  //   stage 1  522500 kHz, 7 MHz steps, 43 transponders
  // Ag_dvb_getAutoScanProgress() is a percentage OF THE CURRENT STAGE.
  var SCAN_STAGES = [[177500, 7000, 8], [522500, 7000, 43]];
  var scanning = false, scanStage = 0, scanBox = null, scanTimer = null;
  var scanStartedAt = 0, scanFound = 0;

  function scanBoxEl() {
    if (scanBox) return scanBox;
    scanBox = makeOsdBox(70);
    scanBox.el.style.display = "none";
    return scanBox;
  }

  function scanShow(pct, found) {
    var b = scanBoxEl();
    var p = Math.max(0, Math.min(100, Math.round(pct)));
    scanFound = found;
    b.title.textContent = "Scanning channels";
    b.fill.style.width = p + "%";
    b.pct.textContent = p + "%";
    b.time.textContent = found + " found";
    b.fin.textContent = "step " + (scanStage + 1) + " of " + SCAN_STAGES.length;
    b.el.style.display = "block";
  }

  function scanHide() { if (scanBox) scanBox.el.style.display = "none"; }

  function scanCount() {
    try { return Number(nat.Ag_dvb_Channel_GetCount(0)) || 0; } catch (e) { return 0; }
  }

  // Native staged scan. Hybroad_Base.dvbAutoScan() cannot be used here: it wipes
  // the channel list, then waits for its own CHANNEL_SCAN_BLOCK_END event and
  // polls through top.scheduler, neither of which an injected script sees, so it
  // reports 0% forever - and it has already deleted the list by then. These are
  // the calls it wraps, in the vendor's own band plan. Nothing is deleted: a
  // failed scan must never leave the box with no channels.
  function rescanChannels() {
    if (scanning) { toast("SCAN ALREADY RUNNING"); return; }
    if (recId !== null) { toast("CAN'T SCAN WHILE RECORDING"); return; }

    scanning = true;
    scanStage = 0;
    scanStartedAt = Date.now();
    if (tsActive) { tsStop("rescan"); tsMode = "off"; tsHide(); }
    report("scan_start", { before: lcns.length, via: "native" });
    scanShow(0, 0);
    startScanStage();

    setTimeout(function () {
      if (!scanning) return;
      failScan("no completion within 8 minutes");
    }, 480000);
  }

  function startScanStage() {
    var st = SCAN_STAGES[scanStage];
    var r = null;
    try { r = nat.Ag_dvb_startScan(0, st[0], st[1], st[2], 7); } catch (e) { r = "throw:" + String(e).slice(0, 60); }
    report("scan_stage", { stage: scanStage, freq: st[0], count: st[2], result: r });

    if (r !== 0 && r !== "0") {             // not accepted: do not wait it out
      failScan("startScan rejected: " + r);
      return;
    }

    var lastP = -1, still = 0;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(function () {
      if (!scanning) { clearInterval(scanTimer); scanTimer = null; return; }
      var p = 0, cnt = 0;
      try { p = Number(nat.Ag_dvb_getAutoScanProgress()) || 0; } catch (e) {}
      cnt = scanCount();
      scanShow((scanStage + p / 100) / SCAN_STAGES.length * 100, cnt);

      if (p >= 99.5) { stageFinished(); return; }
      if (p === lastP) {
        if (++still >= 12) { stageFinished(); return; }   // progress stalls at a stage end
      } else { still = 0; lastP = p; }
      if (Date.now() - scanStartedAt > 480000) { failScan("timeout"); }
    }, 1000);
  }

  function stageFinished() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    scanStage++;
    if (scanStage >= SCAN_STAGES.length) { scanDone(); return; }
    scanShow(scanStage * 100 / SCAN_STAGES.length, scanCount());
    startScanStage();
  }

  function failScan(why) {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    scanning = false;
    scanHide();
    report("scan_error", why);
    toast("SCAN FAILED\n" + why, 3600);
    tune(current, true);
  }

  function scanDone() {
    if (!scanning) return;
    scanning = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    var n = scanCount();
    var list = [];
    for (var i = 0; i < n; i++) {
      var l = null;
      try { l = Number(nat.Ag_dvb_GetLogicalChannelNumberByIndex(0, i)); } catch (e) {}
      if (l > 0 && list.indexOf(l) < 0) list.push(l);
    }
    lcns = list.sort(function (a, b) { return a - b; });
    scanHide();
    var target = lcns.indexOf(Number(current)) >= 0 ? current
               : (lcns.indexOf(7) >= 0 ? 7 : lcns[0]);
    if (target) { current = target; tune(current, true); }
    report("scan_done", { channels: lcns.length, found: n, ms: Date.now() - scanStartedAt });
    toast("SCAN DONE\n" + lcns.length + " CHANNELS", 3200);
  }

  // ---------- boot ----------
  function pvrInit() {
    try { nat.Ag_record_init(); } catch (e) { report("pvr_init_error", String(e).slice(0, 90)); return; }
    var waited = 0;
    var iv = setInterval(function () {
      waited += 2000;
      var c = null, tot = null;
      try { c = hw.getRecordingCount(); } catch (e) {}
      try { tot = nat.Ag_record_getDiskTotalSize(); } catch (e) {}
      if (Number(c) >= 0 && Number(tot) > 0) {
        clearInterval(iv); ready = true;
        if (settings.ts_enabled) {
          setTimeout(function () {
            if (state === "LIVE" && !tsActive) tsEnsureBuffer();
          }, 4000);
        }
        loadNames();
        loadSqlNames();
        loadViewed();
        setInterval(pollCommand, 2000);
        loadTimers();
        schedulerTick();
        setInterval(schedulerTick, 20000);
        // refresh the timeshift readout while watching behind live or paused
        setInterval(function () {
          if (tsActive && tsMode === "paused") { try { tsUpdate(); } catch (e) {} }
        }, 1000);
        // storage guard: every 15 min, no-op unless below the threshold
        setInterval(function () { try { maintRun("auto"); } catch (e) {} }, 900000);
        // baseline storage audit, once the box has settled after boot
        setTimeout(function () { try { maintAudit(); } catch (e) {} }, 45000);
        report("pvr_ready", { count: c, diskTotal: tot, waitedMs: waited });
        // warm the guide cache and prove the files are readable end to end,
        // without needing someone to press the TV Guide button
        setTimeout(function () {
          try {
            var ok = loadGuide();
            if (!ok) report("guide_selftest_missing", {});
          } catch (e) { report("guide_selftest_err", String(e).slice(0, 120)); }
        }, 20000);
      } else if (waited >= 90000) {
        clearInterval(iv);
        report("pvr_timeout", { waitedMs: waited });
      }
    }, 2000);
  }

  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > 300) { clearInterval(timer); return; }
    t = window.top;
    if (!t || !t.hardware || typeof t.hardware.playDvb !== "function") return;
    hw = t.hardware; nat = hw.hardware;
    if (!nat || typeof nat.Ag_dvb_Channel_GetCount !== "function") return;
    var count = 0;
    try { count = nat.Ag_dvb_Channel_GetCount(0); } catch (e) {}
    if (!(count > 0)) return;

    clearInterval(timer);

    var list = [];
    for (var i = 0; i < count; i++) {
      var n = null;
      try { n = nat.Ag_dvb_GetLogicalChannelNumberByIndex(0, i); } catch (e) {}
      if (n !== null && n !== undefined) list.push(Number(n));
    }
    lcns = list.filter(function (x) { return !isNaN(x) && x > 0; }).sort(function (a, b) { return a - b; });

    // ONE listener only. Two (window + document) would fire every action twice —
    // e.g. RECORD would start and immediately stop a recording.
    try { window.addEventListener("keydown", onKey, true); } catch (e) {}

    if (!lcns.length) {
      // Zero channels: tuning would throw and take the whole harness with it.
      // Scan first, from this point in startup, which is where the engine's
      // scanner is known to work (it fails silently once playback is running).
      report("no_channels", {});
      setTimeout(function () { try { rescanChannels(); } catch (e) { report("scan_boot_error", String(e).slice(0, 100)); } }, 1500);
      loadGuideCities();
      loadSettings();
      pvrInit();
      report("boot", { channels: 0, lcns: 0, vw: window.innerWidth, vh: window.innerHeight });
      setInterval(hideSUI, 3000);
      return;
    }
    current = lcns.indexOf(7) >= 0 ? 7 : lcns[0];
    // start the EIT scan BEFORE the first tune so the present/next tables have a
    // head start; otherwise the boot banner often opens with "Now: -"
    eitStart();
    // settings must be loaded BEFORE the first tune: tune() arms the live buffer
    // when ts_enabled is set, and at boot it was still reading the default (off),
    // so the buffer only ever started on the first channel change
    loadGuideCities();
    loadSettings();
    tune(current, true);
    setInterval(hideSUI, 3000);
    pvrInit();
    report("boot", { channels: count, lcns: lcns.length, vw: window.innerWidth, vh: window.innerHeight });
    // hand the web page builder its titles once the box has settled
    setTimeout(function () { try { writeWebMeta(); } catch (e) { report("web_meta_fail", String(e)); } }, 25000);
  }, 1000);

  // Instant hide: a style rule applies as soon as this script is parsed, which
  // beats any timer. Our own overlays carry data-hermesOurs so they survive.
  (function cssHide() {
    try {
      var st = document.createElement("style");
      st.dataset.hermesOurs = "1";
      st.textContent = "body > *:not([data-hermes-ours]){display:none !important}";
      (document.head || document.documentElement).appendChild(st);
      hideSUI();
    } catch (e) {}
  })();

  // Kill the "Welcome to Fetch" flash: the SUI paints its welcome surface during
  // startup, long before the app is ready enough for the normal 3 s cadence, so
  // hide it aggressively (~125 ms) for the first ~15 s.
  (function earlyHide() {
    var n = 0;
    var iv = setInterval(function () {
      hideSUI();
      if (++n > 120) clearInterval(iv);
    }, 125);
  })();
})();
