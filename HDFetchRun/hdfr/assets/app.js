/* HDFetchRun phase 2 - on-box UI.
 *
 * Only this page can drive the tuner: the Ag_* bridge belongs to the webview.
 * The daemon (hdfrd) just serves these files and answers /api/*, so all UI and
 * tuning state lives here, and the page reports what it does to /api/log so it
 * can be inspected remotely.
 *
 * Rules this file follows:
 *   - nothing is drawn until a key is pressed (the page overlays live video);
 *   - every Ag_* call is wrapped, because they return -1 on failure and some
 *     throw when the tuner has not been initialised;
 *   - the scan is the SUI's own sequence, driven by polling rather than the
 *     SUI's event bus.
 */
(function () {
  "use strict";

  var K = {
    UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
    OK: 1073741994, MENU: 1073742338, BACK: 213, EXIT: 203,
    CHUP: 1073741869, CHDOWN: 1073741867
  };

  /* VHF then UHF: start kHz, step kHz, channel count. Copied from the vendor's
   * own scan tables (Hybroad_Base), which is what this hardware uses. */
  var SCAN_STAGES = [[177500, 7000, 8], [522500, 7000, 43]];
  var STALL_MS = 20000;      // no progress for this long = treat the stage as done
  var STAGE_MAX_MS = 240000; // hard cap per stage
  var OSD_MS = 3000;

  var osdEl, osdCh, osdName, menuEl, menuRows, msgEl;
  var p = null;
  var channels = [];
  var idx = 0;
  var mode = "boot";          // boot | live | menu | confirm | scan | error
  var menuSel = 0;
  var daemon = {};
  var osdTimer = null;
  var scanState = null;
  var lastKey = 0, lastKeyAt = 0;

  /* ---------- helpers -------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  function log(msg) {
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "/api/log?msg=" + encodeURIComponent(msg), true);
      x.send();
    } catch (e) { }
  }

  function call(fn, args) {
    try {
      return p[fn].apply(p, args || []);
    } catch (e) {
      log("call " + fn + " threw: " + e);
      return "throw:" + e;
    }
  }

  function num(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  function player() {
    try {
      if (typeof AVPlayer !== "undefined") { return AVPlayer; }
      if (window.AVPlayer) { return window.AVPlayer; }
    } catch (e) { }
    return null;
  }

  function channelName(raw) {
    var m = /"channelName0"\s*:\s*"([^"]*)"/.exec(String(raw));
    return m ? m[1] : String(raw).slice(0, 40);
  }

  /* ---------- display -------------------------------------------------- */

  function showOsd(text, name) {
    osdCh.textContent = text || "";
    osdName.textContent = name || "";
    osdEl.className = "";
    if (osdTimer) { clearTimeout(osdTimer); }
    osdTimer = setTimeout(hideOsd, OSD_MS);
  }

  function hideOsd() {
    osdEl.className = "hidden";
    osdTimer = null;
  }

  function showMsg(main, sub) {
    msgEl.innerHTML = "";
    var a = document.createElement("div");
    a.textContent = main;
    msgEl.appendChild(a);
    if (sub) {
      var b = document.createElement("div");
      b.className = "sub";
      b.textContent = sub;
      msgEl.appendChild(b);
    }
    msgEl.className = "";
  }

  function hideMsg() { msgEl.className = "hidden"; }

  /* ---------- channels and tuning -------------------------------------- */

  function readChannels() {
    channels = [];
    var n = num(call("Ag_dvb_Channel_GetCount", [0]));
    for (var i = 0; i < n; i++) {
      var lcn = num(call("Ag_dvb_GetLogicalChannelNumberByIndex", [0, i]));
      var name = channelName(call("Ag_dvb_GetChannelNameByIndex", [0, lcn]));
      // The multiplex frequency lets the daemon tell a stuck recording tuner
      // from a full pool (same call the vendor UI uses).
      var freq = num(call("Ag_dvb_GetFrequencyByLCN", [0, lcn]));
      if (lcn > 0) { channels.push({ lcn: lcn, name: name, freq: freq > 0 ? freq : 0 }); }
    }
    log("channels read: " + channels.length);
    postChannels();
    return channels.length;
  }

  /* The daemon serves /lineup.json but cannot read the tuner, so the page hands
     it the channel list. */
  function postChannels() {
    var x = new XMLHttpRequest();
    x.open("POST", "/api/channels", true);
    x.setRequestHeader("Content-Type", "application/json");
    x.onload = function () { log("channels posted: " + x.status); };
    x.send(JSON.stringify({ channels: channels }));
  }

  function tune(lcn, why) {
    call("Ag_dvb_stop", [0]);
    var r = call("Ag_dvb_play", [0, lcn]);
    log("tune lcn=" + lcn + " why=" + why + " r=" + r);
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].lcn === lcn) { idx = i; break; }
    }
    var c = channels[idx] || { lcn: lcn, name: "" };
    if (r === 0 || r === "0") { showOsd("CH " + c.lcn, c.name); reportViewing(c); }
    return r;
  }

  function step(delta) {
    if (!channels.length) { return; }
    idx = (idx + delta + channels.length) % channels.length;
    tune(channels[idx].lcn, "key");
  }

  /* ---------- scan (mirrors Hybroad_Base.dvbAutoScan) ------------------- */

  function startScan() {
    mode = "scan";
    hideOsd();
    call("Ag_dvb_stop", [0]);
    showMsg("Scanning for channels", "clearing the old channel list");
    log("scan: deleteChannelList -> " + call("Ag_dvb_deleteChannelList"));
    scanState = { stage: 0, startedAt: Date.now(), lastProg: -1, lastChange: Date.now() };
    setTimeout(nextStage, 1200);
  }

  function nextStage() {
    if (scanState.stage >= SCAN_STAGES.length) { finishScan(); return; }
    var s = SCAN_STAGES[scanState.stage];
    var r = call("Ag_dvb_startScan", [0, s[0], s[1], s[2], 7]);
    log("scan: stage " + scanState.stage + " startScan(" + s.join(",") + ") -> " + r);
    scanState.startedAt = Date.now();
    scanState.lastProg = -1;
    scanState.lastChange = Date.now();
    setTimeout(pollScan, 1500);
  }

  function pollScan() {
    if (!scanState) { return; }
    var prog = num(call("Ag_dvb_getAutoScanProgress"));
    var count = num(call("Ag_dvb_Channel_GetCount", [0]));
    var stageNo = scanState.stage + 1;
    showMsg("Scanning for channels",
            "stage " + stageNo + "/" + SCAN_STAGES.length + "   " + prog + "%   found " + count);
    if (prog !== scanState.lastProg) {
      scanState.lastProg = prog;
      scanState.lastChange = Date.now();
    }
    var stalled = Date.now() - scanState.lastChange > STALL_MS;
    var overrun = Date.now() - scanState.startedAt > STAGE_MAX_MS;
    if (prog >= 100 || stalled || overrun) {
      log("scan: stage " + scanState.stage + " done prog=" + prog +
          (stalled ? " (stalled)" : overrun ? " (timeout)" : ""));
      scanState.stage++;
      setTimeout(nextStage, 800);
    } else {
      setTimeout(pollScan, 1000);
    }
  }

  function finishScan() {
    scanState = null;
    var n = readChannels();
    log("scan: finished, " + n + " channels");
    if (n) {
      hideMsg();
      mode = "live";
      tune(channels[0].lcn, "after-scan");
    } else {
      mode = "error";
      showMsg("No channels found", "check the aerial, then use Menu > Scan for channels");
    }
  }

  /* ---------- menu ----------------------------------------------------- */

  function menuItems() {
    var items = [
      { k: "Jellyfin", v: daemonUrl() || "unknown", act: null },
      { k: "IPTV playlist", v: daemonUrl() ? daemonUrl() + "playlist.m3u" : "unknown", act: null },
      { k: "XMLTV guide", v: daemonUrl() ? daemonUrl() + "guide.xml" : "unknown", act: null },
      { k: "TVH API", v: daemonUrl() ? daemonUrl() + "api/serverinfo" : "unknown", act: null },
      { k: "Channels", v: channels.length + " stored", act: null },
      { k: "Scan for channels", v: "clears the list, stops live TV", act: askScan },
      { k: "Refresh guide", v: guideSummary(), act: refreshGuide },
      { k: "Guide city", v: (guide && guide.city) || "?", act: openCityPicker },
      { k: "Debug harness", v: daemon.debug ? "on" : "off", act: toggleDebug },
      { k: "Tuned channels", v: (daemon.streams && daemon.streams.length) ? daemon.streams.join(", ") : "none", act: null },
      { k: "Viewing Live", v: viewingSummary(), act: null },
      { k: "Recording tuners", v: daemon.tuner_warning ? daemon.tuner_warning : "ok", act: null },
      { k: "Boot count", v: (daemon.boot_count || 0) + " of 3 (resets after 90s)", act: null },
      { k: "Version", v: (daemon.version || "?") + "  (phase " + (daemon.phase || "?") + ")", act: null }
    ];
    return items;
  }

  function daemonUrl() {
    if (!daemon.ip || daemon.ip === "no address yet") { return ""; }
    return "http://" + daemon.ip + ":" + daemon.http_port + "/";
  }

  function buildMenu() {
    var items = menuItems();
    var actionable = [];
    menuRows.innerHTML = "";
    for (var i = 0; i < items.length; i++) {
      var tr = document.createElement("tr");
      var tdK = document.createElement("td");
      tdK.className = "k";
      tdK.textContent = items[i].k + (items[i].act ? "  *" : "");
      var tdV = document.createElement("td");
      tdV.className = "v";
      tdV.textContent = items[i].v;
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      if (items[i].act) { actionable.push({ row: tr, act: items[i].act }); }
      menuRows.appendChild(tr);
    }
    if (menuSel >= actionable.length) { menuSel = actionable.length - 1; }
    if (menuSel < 0) { menuSel = 0; }
    for (var j = 0; j < actionable.length; j++) {
      if (j === menuSel) { actionable[j].row.className = "sel"; }
    }
    return actionable;
  }

  function openMenu() {
    mode = "menu";
    hideOsd();
    buildMenu();
    menuEl.className = "";
    log("menu open");
  }

  function closeMenu() {
    menuEl.className = "hidden";
    mode = "live";
    log("menu close");
  }

  function askScan() {
    mode = "confirm";
    menuEl.className = "hidden";
    showMsg("Scan for channels?", "this clears the stored list - OK to start, Back to cancel");
    log("scan: confirm shown");
  }

  /* ---------- guide (EPG) ------------------------------------------------ */

  var guide = null;

  function viewingSummary() {
    var v = daemon.viewing_lcn;
    if (!v || !v.lcn) { return "none"; }
    return v.lcn + (v.name ? " " + v.name : "");
  }

  /* Only the page can see what the vendor player is tuned to, so it reports the
     channel after every tune; the menu shows it next to the streamed channels. */
  function reportViewing(c) {
    var x = new XMLHttpRequest();
    x.open("POST", "/api/device?lcn=" + c.lcn + "&name=" + encodeURIComponent(c.name || ""), true);
    x.send();
  }

  function guideSummary() {
    if (!guide) return "unknown";
    if (guide.refreshing) return "refreshing...";
    if (guide.size) return "updated " + (guide.age_hours || 0) + "h ago, " + Math.round(guide.size / 1048576) + " MB";
    return "not downloaded" + (guide.last_error ? ": " + guide.last_error : "");
  }

  function pollGuide() {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/guide", true);
    x.onload = function () {
      if (x.status !== 200) return;
      try { guide = JSON.parse(x.responseText); } catch (e) { return; }
      buildMenu();
    };
    x.send();
  }

  function refreshGuide() {
    var x = new XMLHttpRequest();
    x.open("POST", "/api/guide", true);
    x.onload = function () {
      log(x.status === 200 ? "guide: refresh requested" : "guide refresh failed: " + x.status);
      pollGuide();
    };
    x.send();
  }

  /* ---------- guide city picker ----------------------------------------- */

  var cities = [];
  var citySel = 0;
  var PICKER_ROWS = 7;

  function loadCities() {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/cities", true);
    x.onload = function () {
      if (x.status !== 200) { return; }
      try { cities = JSON.parse(x.responseText).cities || []; } catch (e) { return; }
      for (var i = 0; i < cities.length; i++) {
        if (guide && cities[i] === guide.city) { citySel = i; }
      }
    };
    x.send();
  }

  function openCityPicker() {
    mode = "picker";
    hideOsd();
    if (!cities.length) { loadCities(); }
    renderPicker();
    menuEl.className = "";
    log("guide city picker");
  }

  function renderPicker() {
    menuRows.innerHTML = "";
    if (!cities.length) {
      var wait = document.createElement("tr");
      var td = document.createElement("td");
      td.className = "k";
      td.textContent = "loading city list...";
      wait.appendChild(td);
      menuRows.appendChild(wait);
      return;
    }
    /* Scroll a window of rows: 51 cities is far too many to fit on a TV. */
    var first = citySel - Math.floor(PICKER_ROWS / 2);
    if (first < 0) { first = 0; }
    if (first > cities.length - PICKER_ROWS) { first = Math.max(0, cities.length - PICKER_ROWS); }
    for (var i = first; i < Math.min(cities.length, first + PICKER_ROWS); i++) {
      var tr = document.createElement("tr");
      var tdK = document.createElement("td");
      tdK.className = "k";
      tdK.textContent = cities[i];
      var tdV = document.createElement("td");
      tdV.className = "v";
      tdV.textContent = (guide && cities[i] === guide.city) ? "current" : "";
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      if (i === citySel) { tr.className = "sel"; }
      menuRows.appendChild(tr);
    }
  }

  function pickCity() {
    if (!cities.length) { return; }
    var name = cities[citySel];
    var x = new XMLHttpRequest();
    x.open("POST", "/api/guide/city?name=" + encodeURIComponent(name), true);
    x.onload = function () {
      if (x.status === 200) {
        log("guide city -> " + name + " (downloading)");
        closeMenu();
        pollGuide();
        setTimeout(pollGuide, 4000);
      } else {
        log("guide city change failed: " + x.status);
      }
    };
    x.send();
  }

  function toggleDebug() {
    var want = !daemon.debug;
    var x = new XMLHttpRequest();
    x.open("GET", "/api/debug?enabled=" + (want ? 1 : 0), true);
    x.onload = function () {
      if (x.status === 200) {
        daemon.debug = want;
        log("debug harness -> " + (want ? "on" : "off") + " (applies to the debug shell at next boot)");
        buildMenu();
      } else {
        log("debug toggle failed: " + x.status);
      }
    };
    x.send();
  }

  /* ---------- remote commands (support + phase 3 spike) ---------------- */

  var cmdBusy = false;
  var rec = { handle: null, id: null, timer: null, file: null };

  function pvrNames(cb) {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/pvr?t=" + new Date().getTime(), true);
    x.timeout = 5000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) { return; }
      if (x.status !== 200) { cb(null); return; }
      var d;
      try { d = JSON.parse(x.responseText); } catch (e) { cb(null); return; }
      var names = {};
      for (var i = 0; i < d.files.length; i++) { names[d.files[i].name] = d.files[i].size; }
      cb(names);
    };
    x.send();
  }

  function pollCommands() {
    if (cmdBusy) { return; }
    var x = new XMLHttpRequest();
    x.open("GET", "/api/next?t=" + new Date().getTime(), true);
    x.timeout = 4000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || x.status !== 200) { return; }
      var c;
      try { c = JSON.parse(x.responseText); } catch (e) { return; }
      if (!c || !c.id) { return; }
      log("cmd " + c.id + ": " + c.cmd + " " + (c.arg || ""));
      if (c.cmd === "rec_test") { cmdBusy = true; recTest(c); return; }
      if (c.cmd === "rec_stop") { cmdBusy = true; recStop(c); return; }
      if (c.cmd === "stream_start") { cmdBusy = true; streamStart(c); return; }
      if (c.cmd === "stream_stop") { cmdBusy = true; streamStop(c); return; }
      if (c.cmd === "stream_stopid") { streamStopID(c); return; }
      if (c.cmd === "setfile") { cmdBusy = true; setFile(c); return; }
      if (c.cmd === "pvrscan") {
        // Inventory only: entries whose id looks like one of ours (created today,
        // ids around 7.7e8). The owner's library ids are around 3.4e8.
        var out = [];
        var n = num(call("Ag_playBack_rangeFile", [0, 0]));
        out.push("count=" + n);
        for (var i = 0; i < n; i++) {
          var info = String(call("Ag_playBack_getFileInfo", [i]));
          var f = info.split("@");
          var id = num(f[0]);
          if (id > 700000000) { out.push(i + ":" + id + ":" + f[4]); }
        }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "pvrtop") {
        var out = [];
        var n = num(call("Ag_playBack_rangeFile", [0, 0]));
        out.push("count=" + n);
        for (var i = 0; i < 4 && i < n; i++) {
          out.push(i + ":" + String(call("Ag_playBack_getFileInfo", [i])).slice(0, 90));
        }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "recdir") {
        // Point the recorder's output at a directory. Used only to test whether
        // the vendor setting is honoured per start; the value is restored
        // immediately afterwards.
        var f = p.Ag_record_NFSDirectorySet;
        if (typeof f !== "function") { report(c, false, "NFSDirectorySet missing"); cmdBusy = false; return; }
        var r = call("Ag_record_NFSDirectorySet", [String(c.arg)]);
        report(c, true, "arity=" + f.length + " set(" + c.arg + ")=" + r);
        cmdBusy = false;
        return;
      }
      if (c.cmd === "recbyid") {
        // Resolve a recording id through the vendor PVR index. This is the only
        // authoritative link between the id Ag_record_create() returned and the
        // file the box is writing: the index entry carries that recording's size.
        var id = num(c.arg);
        var idx = call("Ag_playBack_getIndexByID", [id]);
        if (num(idx) < 0) { report(c, false, "id " + id + " not in index"); cmdBusy = false; return; }
        var info = String(call("Ag_playBack_getFileInfo", [num(idx)]));
        report(c, true, "index=" + idx + " info=" + info.replace(/ /g, "_"));
        cmdBusy = false;
        return;
      }
      if (c.cmd === "pvrdeleteid") {
        // Delete through the vendor index, never by unlink: an unlinked file
        // leaves a stale index entry and the box then reuses the name for the
        // next recording, truncating whatever was there.
        var want = String(c.arg);
        var n = num(call("Ag_playBack_rangeFile", [0, 0]));
        var found = -1;
        for (var i = 0; i < n; i++) {
          var info = String(call("Ag_playBack_getFileInfo", [i]));
          if (info.split("@")[0] === want) { found = i; break; }
        }
        if (found < 0) { report(c, false, "id " + want + " not in PVR index"); cmdBusy = false; return; }
        var del = call("Ag_playBack_deleteFile", [found]);
        report(c, true, "deleted index=" + found + " id=" + want + " r=" + del);
        cmdBusy = false;
        return;
      }
      if (c.cmd === "pvrlist") {
        var out = [];
        var n = call("Ag_playBack_rangeFile", [0, 0]);
        out.push("count=" + n);
        var c0 = num(n);
        for (var i = Math.max(0, c0 - 6); i < c0; i++) {
          out.push(i + ":" + String(call("Ag_playBack_getFileInfo", [i])).slice(0, 90));
        }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "pvrdelete") {
        var idx = num(c.arg);
        var r = call("Ag_playBack_deleteFile", [idx]);
        report(c, true, "delete(" + idx + ")=" + r);
        return;
      }
      if (c.cmd === "timerprobe") {
        var out = [];
        var n = -1;
        try { n = p.Ag_record_getNoOfTimer(); } catch (e) { out.push("noOfTimer:throw"); }
        out.push("noOfTimer=" + n);
        for (var i = 0; i < (n > 0 ? n : 0); i++) {
          try { out.push("t" + i + "=" + JSON.stringify(p.Ag_record_getTimerInfoByIndex(i)).slice(0, 140)); } catch (e) { out.push("t" + i + ":throw"); }
        }
        try { out.push("recErr=" + JSON.stringify(p.Ag_record_getTimerRecError())); } catch (e) { out.push("recErr:throw"); }
        try { out.push("tuners=" + JSON.stringify(p.Ag_record_getTunerIndexByLCN(15))); } catch (e) { out.push("tuners:throw"); }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "recprobe2") {
        var out = [];
        try { out.push("recStatus()=" + JSON.stringify(p.Ag_record_getRecordStatus())); } catch (e) { out.push("recStatus():throw"); }
        for (var h = 0; h < 4; h++) {
          try { out.push("status(" + h + ")=" + JSON.stringify(p.Ag_record_getStatus(h))); } catch (e) { out.push("status(" + h + "):throw"); }
        }
        for (var i = 0; i < 4; i++) {
          try { out.push("info(" + i + ")=" + JSON.stringify(p.Ag_record_getInfo(i)).slice(0, 80)); } catch (e) { out.push("info(" + i + "):throw"); }
        }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "recprobe") {
        var out = [];
        var fns = ["Ag_record_stop", "Ag_record_stopIPAndID", "Ag_record_getRecordStatus",
                   "Ag_record_getStatus", "Ag_record_getInfo", "Ag_record_getNoOfFile",
                   "Ag_record_getTunerIndexByLCN"];
        for (var i = 0; i < fns.length; i++) {
          var f = p[fns[i]];
          out.push(fns[i].replace("Ag_record_", "") + "=" + (typeof f) + "/" + (f ? f.length : "-"));
        }
        try { out.push("noOfFile=" + JSON.stringify(p.Ag_record_getNoOfFile())); } catch (e) { out.push("noOfFile:throw"); }
        try { out.push("noOfFile0=" + JSON.stringify(p.Ag_record_getNoOfFile(0))); } catch (e) { out.push("noOfFile0:throw"); }
        for (var h = 0; h < 2; h++) {
          try { out.push("status(" + h + ")=" + JSON.stringify(p.Ag_record_getRecordStatus(h))); } catch (e) { out.push("status(" + h + "):throw"); }
        }
        report(c, true, out.join(" | "));
        return;
      }
      if (c.cmd === "bridge") {
        /* Debug: list bridge members whose name matches the regex in arg, with
           their declared arity. Read-only - nothing is called. */
        var re = new RegExp(c.arg || ".", "i"), hits = [];
        for (var bk in p) { if (re.test(bk)) { hits.push(bk + "/" + (typeof p[bk] === "function" ? p[bk].length : typeof p[bk])); } }
        report(c, true, hits.length + ": " + hits.join(","));
        return;
      }
      if (c.cmd === "bridgecall") {
        /* Debug: call one read-only getter, arg "Name|a1|a2"; numeric args are
           passed as numbers. Only names starting Ag_dvb_Get/Ag_dvb_get. */
        var parts = String(c.arg).split("|"), fn = parts.shift();
        if (!/^Ag_dvb_[Gg]et/.test(fn)) { report(c, false, "only Ag_dvb_get* getters"); return; }
        var args = parts.map(function (x) { return /^-?\d+$/.test(x) ? Number(x) : x; });
        var r = call(fn, args);
        report(c, true, fn + "(" + args.join(",") + ") = " + JSON.stringify(r));
        return;
      }
      if (c.cmd === "reclist") {
        var names = [];
        for (var k in p) { if (/record/i.test(k)) { names.push(k); } }
        report(c, true, names.join(","));
        return;
      }
      if (c.cmd === "ua") { report(c, true, navigator.userAgent + " | appVersion=" + navigator.appVersion); return; }
      if (c.cmd === "reload") {
        /* Deploying app.js does not reload this webview, so a reboot used to be
           the only way to pick up a UI change. Report first, then reload. */
        report(c, true, "reloading");
        setTimeout(function () { location.reload(); }, 300);
        return;
      }
      report(c, false, "unknown command");
    };
    x.send();
  }

  function report(c, ok, detail) {
    log("report " + c.id + " ok=" + ok + " " + detail);
    var x = new XMLHttpRequest();
    x.open("POST", "/api/report", true);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(JSON.stringify({ id: c.id, cmd: c.cmd, ok: ok, detail: detail }));
  }

  /* The recorder is the one thing on this box that has wedged the whole system:
     Ag_record_create() before Ag_record_init() finished put it in a watchdog
     reboot loop. Nothing here touches create() until the PVR reports ready. */
  function ensurePvr(cb) {
    var count = num(call("Ag_playBack_rangeFile", [0, 0]));
    if (count >= 0) {
      cb(true, count, num(call("Ag_record_getDiskTotalSize")));
      return;
    }
    log("rec: not initialised, calling Ag_record_init");
    call("Ag_record_init", []);
    var t0 = Date.now();
    (function poll() {
      var c = num(call("Ag_playBack_rangeFile", [0, 0]));
      var disk = num(call("Ag_record_getDiskTotalSize"));
      if (c >= 0 && disk > 0) { cb(true, c, disk); return; }
      if (Date.now() - t0 > 180000) { cb(false, c, disk); return; }
      setTimeout(poll, 1000);
    })();
  }

  function recTest(c) {
    var lcn = num(c.arg) || (channels[idx] && channels[idx].lcn) || 0;
    var before = null;
    log("rec: test start lcn=" + lcn);
    pvrNames(function (names) {
      before = names || {};
      log("rec: pvr baseline " + Object.keys(before).length + " files");
      ensurePvr(startIt);
    });

    function startIt(ready, count, disk) {
      log("rec: ready=" + ready + " count=" + count + " diskTotal=" + disk);
      if (!ready) {
        report(c, false, "pvr not ready count=" + count + " disk=" + disk);
        cmdBusy = false;
        return;
      }
      var id = call("Ag_record_create", []);
      log("rec: create -> id=" + id);
      if (num(id) <= 0) {
        report(c, false, "create failed id=" + id);
        cmdBusy = false;
        return;
      }
      var h = call("Ag_record_startByLCNAndID", [lcn, id]);
      log("rec: startByLCNAndID(" + lcn + "," + id + ") -> " + h);
      /* The vendor API returns 0 on success here, so 0 is a valid handle. Only
         a thrown call or -1 means failure. */
      if (h === -1 || String(h).indexOf("throw:") === 0) {
        report(c, false, "start failed handle=" + h + " id=" + id);
        cmdBusy = false;
        return;
      }
      rec = { handle: h, id: id, timer: null, file: null };
      log("rec: getInfo=" + call("Ag_record_getInfo", [h]) +
          " getRecInfo=" + call("Ag_record_getRecInfo", [h]));

      /* The file name is NOT the id create() returns, so discover it: the new
         .mpg in the PVR directory that was not there before the start. */
      var probes = 0;
      var finder = setInterval(function () {
        pvrNames(function (now) {
          if (!now) { return; }
          for (var n in now) {
            if (!before.hasOwnProperty(n)) {
              rec.file = n;
              clearInterval(finder);
              log("rec: file=" + n + " size=" + now[n]);
              return;
            }
          }
          if (++probes > 20) {
            clearInterval(finder);
            log("rec: no new .mpg appeared within 10s");
          }
        });
      }, 500);

      var ticks = 0, lastStatus = "?";
      rec.timer = setInterval(function () {
        lastStatus = call("Ag_record_getStatus", [h]);
        log("rec: status=" + lastStatus + " t=" + ticks + "s file=" + rec.file);
        if (++ticks >= 12) {
          clearInterval(rec.timer);
          rec.timer = null;
          var stopped = call("Ag_record_stop", [h]);
          log("rec: stop(" + h + ") -> " + stopped);
          report(c, true, "id=" + id + " handle=" + h + " lcn=" + lcn +
                 " file=" + rec.file + " lastStatus=" + lastStatus + " stop=" + stopped);
          rec = { handle: null, id: null, timer: null, file: null };
          cmdBusy = false;
        }
      }, 1000);
    }
  }

  function recStop(c) {
    /* Always stop handle 0 as well: a recording started by an older build may
       not have a handle recorded in this page's memory. */
    var stopped = call("Ag_record_stop", [rec.handle === null ? 0 : rec.handle]);
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    log("rec: stop(" + (rec.handle === null ? 0 : rec.handle) + ") -> " + stopped +
        " (id was " + rec.id + ")");
    report(c, true, "stop=" + stopped);
    rec = { handle: null, id: null, timer: null, file: null };
    cmdBusy = false;
  }

  /* ---------- streaming (phase 3) --------------------------------------
   * One recording per requested LCN. The daemon cannot start it, so it asks
   * here; the file name is discovered from /api/pvr because the recorder's
   * create() id is not the file number.
   */
  var recs = {};    // lcn -> { handle, id, file }

  function streamStart(c) {
    var lcn = num(c.arg);
    log("stream: start lcn=" + lcn);
    ensurePvr(function (ready) {
      if (!ready) { report(c, false, "pvr not ready"); cmdBusy = false; return; }
      var id = call("Ag_record_create", []);
      if (num(id) <= 0) { report(c, false, "create failed id=" + id); cmdBusy = false; return; }
      var h = call("Ag_record_startByLCNAndID", [lcn, id]);
      if (h === -1 || String(h).indexOf("throw:") === 0) {
        report(c, false, "start failed h=" + h + " id=" + id);
        cmdBusy = false;
        return;
      }
      // Answer as soon as the recorder is running. The daemon runs on this box
      // and watches /mnt/usb1/PVR itself, so waiting here for the file to appear
      // only delays the first byte -- and IPTV scanners give up after 5 seconds.
      recs[lcn] = { handle: h, id: id, file: "" };
      report(c, true, "id=" + id + " handle=" + h + " lcn=" + lcn);
      cmdBusy = false;
    });
  }

  /* The daemon resolves the filename itself (it can see the PVR directory) and
     sends it here, so stopping can still delete the file. */
  /* Stop by the id returned by Ag_record_create, which is the record object
     nexus itself stops (NEXUS_Record_Stop), rather than the value returned by
     startByLCNAndID. */
  function streamStopID(c) {
    var parts = String(c.arg).split("|");
    var lcn = num(parts[0]);
    var id = num(parts[1]);
    var r = recs[lcn];
    if (!id && r) { id = r.id; }
    var stopped = call("Ag_record_stop", [id]);
    delete recs[lcn];
    log("stream: stopid lcn=" + lcn + " id=" + id + " -> " + stopped);
    report(c, true, "stopid=" + stopped);
    cmdBusy = false;
  }

  function setFile(c) {
    var parts = String(c.arg).split("|");
    var lcn = num(parts[0]);
    if (recs[lcn]) { recs[lcn].file = parts[1] || ""; }
    log("stream: lcn=" + lcn + " file=" + (parts[1] || "?"));
    report(c, true, "set file " + (parts[1] || "?"));
    cmdBusy = false;
  }

  function streamStop(c) {
    // The daemon sends "lcn|handle": the handle lets us stop the recorder even
    // if this page's map was cleared by a reload, which used to leave the
    // recorder running until the box ran out of slots.
    var parts = String(c.arg).split("|");
    var lcn = num(parts[0]);
    var r = recs[lcn];
    var handle = parts.length > 1 && parts[1] !== "" ? num(parts[1]) : (r ? r.handle : null);
    if (handle === null || handle === undefined) {
      report(c, true, "no handle for lcn=" + lcn);
      cmdBusy = false;
      return;
    }
    var stopped = call("Ag_record_stop", [handle]);
    delete recs[lcn];
    var file = r ? r.file : "";
    log("stream: stop lcn=" + lcn + " handle=" + handle + " -> " + stopped +
        " (file " + (file || "unknown") + " left for the daemon to delete by index)");
    if (!file) {
      // The daemon deletes the file itself once the stop is acknowledged.
      report(c, true, "stop=" + stopped + " deleted=(daemon)");
      cmdBusy = false;
      return;
    }
    // The daemon removes the file through the vendor PVR index
    // (Ag_playBack_deleteFile). It must not be unlinked here: an unlinked file
    // leaves a stale index entry and the box then reuses the name for the next
    // recording, truncating whatever was there.
    report(c, true, "stop=" + stopped + " file=" + file);
    cmdBusy = false;
  }

  /* ---------- keys ----------------------------------------------------- */

  function onKey(e) {
    var kc = (e && (e.keyCode || e.which)) || 0;
    var now = new Date().getTime();
    if (kc === lastKey && now - lastKeyAt < 200) { return; }
    lastKey = kc; lastKeyAt = now;
    handle(kc);
    if (e && e.preventDefault) { e.preventDefault(); }
  }

  function handle(kc) {
    if (mode === "boot") {
      if (kc === K.MENU) { openMenu(); }
      return;
    }
    if (mode === "error") {
      if (kc === K.MENU || kc === K.OK) { openMenu(); }
      return;
    }
    if (mode === "confirm") {
      if (kc === K.OK) { hideMsg(); startScan(); }
      else if (kc === K.BACK || kc === K.EXIT) { hideMsg(); mode = "live"; }
      return;
    }
    if (mode === "scan") { return; }        // ignore input while scanning

    if (mode === "picker") {
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { mode = "menu"; buildMenu(); return; }
      if (!cities.length) { loadCities(); return; }
      if (kc === K.UP || kc === K.CHUP) { citySel = (citySel - 1 + cities.length) % cities.length; renderPicker(); return; }
      if (kc === K.DOWN || kc === K.CHDOWN) { citySel = (citySel + 1) % cities.length; renderPicker(); return; }
      if (kc === K.OK) { pickCity(); return; }
      return;
    }

    if (mode === "menu") {
      if (kc === K.BACK || kc === K.EXIT || kc === K.MENU) { closeMenu(); return; }
      var items = buildMenu();
      if (!items.length) { return; }
      if (kc === K.UP) { menuSel = (menuSel - 1 + items.length) % items.length; buildMenu(); return; }
      if (kc === K.DOWN) { menuSel = (menuSel + 1) % items.length; buildMenu(); return; }
      if (kc === K.OK) { items[menuSel].act(); return; }
      return;
    }

    /* live */
    if (kc === K.MENU || kc === K.OK) { openMenu(); return; }
    if (kc === K.UP || kc === K.CHUP) { step(1); return; }
    if (kc === K.DOWN || kc === K.CHDOWN) { step(-1); return; }
    if (kc === K.BACK) { hideOsd(); return; }
  }

  /* ---------- boot ----------------------------------------------------- */

  function fetchState() {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/state?t=" + new Date().getTime(), true);
    x.timeout = 4000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || x.status !== 200) { return; }
      try { daemon = JSON.parse(x.responseText); } catch (e) { return; }
      // The daemon forgets what the box is tuned to whenever it restarts, and
      // the page only reports on a tune, so re-assert it while it reads empty
      // and we are actually showing live TV. Without this the menu says "none"
      // until the viewer next changes channel.
      if (!daemon.viewing_lcn || !daemon.viewing_lcn.lcn) {
        // Report whatever the vendor player is last known to be tuned to, even
        // while the menu is up: the player keeps showing that channel.
        if (channels[idx] && channels[idx].lcn) { reportViewing(channels[idx]); }
      }
      if (mode === "menu") { buildMenu(); }
    };
    x.send();
  }

  function boot() {
    osdEl = $("osd");
    osdCh = $("osd-ch");
    osdName = $("osd-name");
    menuEl = $("menu");
    menuRows = $("menu-rows");
    msgEl = $("msg");

    try {
      window.addEventListener("keydown", onKey, true);
      document.addEventListener("keydown", onKey, true);
    } catch (e) { }

    fetchState();
    setInterval(fetchState, 10000);
    setInterval(pollCommands, 500);
    pollGuide();
    setInterval(pollGuide, 15000);
    loadCities();
    /* Re-post the channel list now and then: the daemon keeps it on disk, but a
       daemon restart must not leave /lineup.json empty until the next boot. */
    setInterval(function () { if (channels.length) { postChannels(); } }, 60000);

    var A = player();
    if (!A) {
      mode = "error";
      showMsg("HDFetchRun: no AVPlayer", "the browser page loaded without the native bridge");
      log("boot: no AVPlayer");
      return;
    }
    try { p = new A(); } catch (e) {
      mode = "error";
      showMsg("HDFetchRun: AVPlayer failed", String(e));
      return;
    }

    /* The SUI's initTuner(): without this the tuner refuses to play. */
    var initR = call("Ag_dvb_init", [1]);
    var winR = call("Ag_video_setWindow", [0, 0, screen.width, screen.height]);
    log("boot: init=" + initR + " setWindow(" + screen.width + "x" + screen.height + ")=" + winR);

    var n = readChannels();
    if (!n) {
      /* Do not assume a scan has ever been done. */
      log("boot: no channels, scanning");
      startScan();
    } else {
      mode = "live";
      tune(channels[0].lcn, "boot");
    }
  }

  boot();
})();
