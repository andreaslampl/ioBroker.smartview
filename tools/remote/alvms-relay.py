#!/usr/bin/env python3
"""Andreas L.-Arts VMS – Tunnel-Server („Relay“) für einen eigenen Server im Internet (z. B. IONOS-VPS).

Wozu: Die VMS zuhause (bzw. bei Freunden) baut von sich aus Verbindungen zu diesem Server auf – am Router
muss kein Port geöffnet werden. Wer https://<name>.duckdns.org aufruft, landet hier und wird an die richtige
VMS durchgereicht.

Sicherheit:
  * Der Server reicht die Verbindung nur VERSCHLÜSSELT durch (TLS bis zur VMS). Das Zertifikat liegt bei
    der VMS – dieser Server kann weder Bilder noch Passwörter sehen.
  * Jede VMS hat einen eigenen Schlüssel. Eine VMS kann sich nur für ihre eigene Adresse anmelden.
  * Nur Python 3.8+ nötig, keine Zusatzpakete.

Benutzung (auf dem Server, als root):
    python3 alvms-relay.py install                 # einrichten (systemd-Dienst, Port 443)
    python3 alvms-relay.py install --port 8443     # anderer Port, falls 443 schon belegt ist
    alvms-relay add <name>.duckdns.org <schlüssel> # eine VMS freischalten (Zeile aus der VMS kopieren)
    alvms-relay remove <name>.duckdns.org
    alvms-relay list
    alvms-relay status                             # verbundene VMS
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import os
import shutil
import subprocess
import sys
import time

VERSION = "1.0"
CONF_DIR = "/etc/alvms-relay"
SITES = os.path.join(CONF_DIR, "sites.json")
STATUS = "/run/alvms-relay/status.json"
INSTALL_DIR = "/opt/alvms-relay"
UNIT = "/etc/systemd/system/alvms-relay.service"

MAX_IDLE_PER_SITE = 32       # bereitstehende Verbindungen je VMS
MAX_CLIENTS_PER_IP = 64      # gleichzeitige Verbindungen je Besucher-Adresse
WAIT_FOR_SITE = 10           # s: so lange auf eine freie Verbindung der VMS warten
PING_EVERY = 25              # s
HANDSHAKE_TIMEOUT = 10

log = logging.getLogger("alvms-relay")


# ------------------------------------------------------------------ Konfiguration
def load_sites(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return {k.lower(): v for k, v in (data.get("sites") or {}).items()}
    except FileNotFoundError:
        return {}


def save_sites(path: str, sites: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sites": sites}, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# ------------------------------------------------------------------ TLS: Servernamen (SNI) lesen
def parse_sni(hello: bytes) -> str | None:
    """Servernamen aus dem TLS-ClientHello lesen (ohne zu entschlüsseln)."""
    try:
        if len(hello) < 5 or hello[0] != 0x16:
            return None
        p = 5
        if hello[p] != 0x01:                       # Handshake-Typ ClientHello
            return None
        p += 4 + 2 + 32                            # Typ+Länge, Version, Zufall
        p += 1 + hello[p]                          # Sitzungs-ID
        p += 2 + int.from_bytes(hello[p:p + 2], "big")   # Cipher-Suites
        p += 1 + hello[p]                          # Kompression
        end = p + 2 + int.from_bytes(hello[p:p + 2], "big")
        p += 2
        while p + 4 <= end:
            typ = int.from_bytes(hello[p:p + 2], "big")
            ln = int.from_bytes(hello[p + 2:p + 4], "big")
            p += 4
            if typ == 0:                           # server_name
                q = p + 2
                while q + 3 <= p + ln:
                    nt = hello[q]
                    nl = int.from_bytes(hello[q + 1:q + 3], "big")
                    if nt == 0:
                        return hello[q + 3:q + 3 + nl].decode("ascii", "ignore").lower().rstrip(".")
                    q += 3 + nl
                return None
            p += ln
    except (IndexError, ValueError):
        return None
    return None


# ------------------------------------------------------------------ Relay
class Idle:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.since = time.time()


class Relay:
    def __init__(self, sites_path: str):
        self.sites_path = sites_path
        self.sites = load_sites(sites_path)
        self.sites_mtime = self._mtime()
        self.idle: dict[str, list[Idle]] = {}
        self.cond = asyncio.Condition()
        self.nonces: dict[str, float] = {}
        self.per_ip: dict[str, int] = {}
        self.stats: dict[str, dict] = {}

    def _mtime(self) -> float:
        try:
            return os.stat(self.sites_path).st_mtime
        except OSError:
            return 0.0

    def reload(self) -> None:
        m = self._mtime()
        if m != self.sites_mtime:
            old = self.sites
            self.sites, self.sites_mtime = load_sites(self.sites_path), m
            log.info("Freigeschaltete VMS: %d", len(self.sites))
            # Schlüssel geändert oder entfernt -> bereitstehende Verbindungen dieser VMS trennen
            for dom, tok in old.items():
                if self.sites.get(dom) != tok:
                    for c in self.idle.pop(dom, []):
                        c.writer.close()

    # -------------------------------------------------------------- VMS meldet sich (Steuerverbindung)
    async def control(self, first: bytes, reader, writer) -> None:
        line = first + await asyncio.wait_for(reader.readline(), HANDSHAKE_TIMEOUT)
        parts = line.decode("ascii", "ignore").split()
        # ALVMS1 <domain> <zeit> <zufall> <hmac>
        if len(parts) != 5 or parts[0] != "ALVMS1":
            writer.close()
            return
        _, domain, ts, nonce, mac = parts
        domain = domain.lower()
        self.reload()
        token = self.sites.get(domain)
        now = time.time()
        ok = bool(token) and ts.isdigit() and abs(now - int(ts)) < 300 and nonce not in self.nonces
        if ok:
            want = hmac.new(token.encode(), f"{domain}|{ts}|{nonce}".encode(), hashlib.sha256).hexdigest()
            ok = hmac.compare_digest(want, mac)
        if not ok:
            await asyncio.sleep(1)
            writer.write(b"ERR Adresse nicht freigeschaltet oder Schluessel falsch\n")
            await writer.drain()
            writer.close()
            return
        self.nonces[nonce] = now
        for k in [k for k, t in self.nonces.items() if now - t > 600]:
            del self.nonces[k]
        async with self.cond:
            pool = self.idle.setdefault(domain, [])
            if len(pool) >= MAX_IDLE_PER_SITE:
                writer.write(b"ERR zu viele Verbindungen\n")
                await writer.drain()
                writer.close()
                return
            writer.write(b"OK\n")
            await writer.drain()
            pool.append(Idle(reader, writer))
            st = self.stats.setdefault(domain, {"since": now, "served": 0})
            st["last"] = now
            self.cond.notify_all()

    async def take(self, domain: str) -> Idle | None:
        deadline = time.time() + WAIT_FOR_SITE
        async with self.cond:
            while True:
                pool = self.idle.get(domain) or []
                while pool:
                    c = pool.pop(0)
                    if not c.writer.is_closing():
                        return c
                left = deadline - time.time()
                if left <= 0:
                    return None
                try:
                    await asyncio.wait_for(self.cond.wait(), left)
                except asyncio.TimeoutError:
                    return None

    async def ping_loop(self) -> None:
        """Bereitstehende Verbindungen prüfen (tote rausnehmen). Während des Pings ist sie nicht vergeben."""
        while True:
            await asyncio.sleep(5)
            now = time.time()
            due = []
            async with self.cond:
                for dom, pool in self.idle.items():
                    for c in list(pool):
                        if now - c.since > PING_EVERY:
                            pool.remove(c)
                            due.append((dom, c))
            for dom, c in due:
                asyncio.ensure_future(self._ping(dom, c))
            self.write_status()

    async def _ping(self, dom: str, c: Idle) -> None:
        try:
            c.writer.write(b"P")
            await c.writer.drain()
            r = await asyncio.wait_for(c.reader.readexactly(1), 10)
            if r != b"p":
                raise ValueError
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError):
            c.writer.close()
            return
        c.since = time.time()
        async with self.cond:
            self.idle.setdefault(dom, []).append(c)
            self.cond.notify_all()

    # -------------------------------------------------------------- Besucher
    async def handle(self, reader, writer) -> None:
        peer = (writer.get_extra_info("peername") or ("?",))[0]
        if self.per_ip.get(peer, 0) >= MAX_CLIENTS_PER_IP:
            writer.close()
            return
        self.per_ip[peer] = self.per_ip.get(peer, 0) + 1
        try:
            first = await asyncio.wait_for(reader.readexactly(1), HANDSHAKE_TIMEOUT)
            if first == b"A":
                return await self.control(first, reader, writer)
            if first != b"\x16":
                writer.close()
                return
            rest = await asyncio.wait_for(read_client_hello_rest(reader), HANDSHAKE_TIMEOUT)
            hello = first + rest
            domain = parse_sni(hello)
            self.reload()
            if not domain or domain not in self.sites:
                writer.close()
                return
            c = await self.take(domain)
            if not c:
                log.info("%s: keine Verbindung der VMS frei (offline?)", domain)
                writer.close()
                return
            c.writer.write(b"G" + peer.encode() + b"\n" + hello)
            await c.writer.drain()
            self.stats.setdefault(domain, {"since": time.time(), "served": 0})["served"] += 1
            await pipe_both(reader, writer, c.reader, c.writer)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError):
            writer.close()
        finally:
            n = self.per_ip.get(peer, 1) - 1
            if n <= 0:
                self.per_ip.pop(peer, None)
            else:
                self.per_ip[peer] = n

    def write_status(self) -> None:
        try:
            os.makedirs(os.path.dirname(STATUS), exist_ok=True)
            data = {d: {"bereit": len(self.idle.get(d) or []), **self.stats.get(d, {})} for d in self.sites}
            with open(STATUS, "w", encoding="utf-8") as f:
                json.dump({"time": time.time(), "sites": data}, f)
        except OSError:
            pass


async def read_client_hello_rest(reader: asyncio.StreamReader) -> bytes:
    head = await reader.readexactly(4)
    ln = int.from_bytes(head[2:4], "big")
    if ln > 16384 + 2048:
        raise ValueError("zu groß")
    return head + await reader.readexactly(ln)


async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            dst.close()
        except OSError:
            pass


async def pipe_both(r1, w1, r2, w2) -> None:
    await asyncio.gather(pipe(r1, w2), pipe(r2, w1))


async def serve(port: int, sites_path: str) -> None:
    relay = Relay(sites_path)
    server = await asyncio.start_server(relay.handle, host=None, port=port, reuse_address=True)
    log.info("ALVMS-Relay %s läuft auf Port %d, %d VMS freigeschaltet", VERSION, port, len(relay.sites))
    asyncio.ensure_future(relay.ping_loop())
    async with server:
        await server.serve_forever()


# ------------------------------------------------------------------ Verwaltung
def need_root() -> None:
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        sys.exit("Bitte als root ausführen (sudo).")


def cmd_install(args) -> None:
    need_root()
    os.makedirs(INSTALL_DIR, exist_ok=True)
    os.makedirs(CONF_DIR, exist_ok=True)
    target = os.path.join(INSTALL_DIR, "alvms-relay.py")
    if os.path.abspath(__file__) != target:
        shutil.copy2(os.path.abspath(__file__), target)
    os.chmod(target, 0o755)
    if not os.path.exists(SITES):
        save_sites(SITES, {})
    link = "/usr/local/bin/alvms-relay"
    if not os.path.exists(link):
        os.symlink(target, link)
    unit = f"""[Unit]
Description=Andreas L.-Arts VMS Relay (Tunnel ohne offenen Port)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 {target} serve --port {args.port}
Restart=always
RestartSec=3
DynamicUser=yes
StateDirectory=alvms-relay
RuntimeDirectory=alvms-relay
ReadOnlyPaths={CONF_DIR}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
"""
    with open(UNIT, "w", encoding="utf-8") as f:
        f.write(unit)
    os.chmod(SITES, 0o644)       # DynamicUser muss lesen können; Schlüssel sind nur Prüfwerte je VMS
    subprocess.call(["systemctl", "daemon-reload"])
    subprocess.call(["systemctl", "enable", "--now", "alvms-relay"])
    subprocess.call(["systemctl", "restart", "alvms-relay"])
    print(f"\nFertig. Der Relay-Dienst läuft auf Port {args.port}.")
    print("Wichtig: In der Firewall des Servers (bei IONOS: Cloud Panel -> Netzwerk -> Firewall)")
    print(f"TCP-Port {args.port} eingehend erlauben.")
    print("Danach je VMS:  alvms-relay add <name>.duckdns.org <schlüssel>   (Zeile steht in der VMS)\n")


def cmd_add(args) -> None:
    need_root()
    sites = load_sites(SITES)
    sites[args.domain.lower()] = args.key
    save_sites(SITES, sites)
    os.chmod(SITES, 0o644)
    print(f"{args.domain} freigeschaltet ({len(sites)} VMS). Die VMS verbindet sich innerhalb einer Minute.")


def cmd_remove(args) -> None:
    need_root()
    sites = load_sites(SITES)
    if sites.pop(args.domain.lower(), None) is None:
        sys.exit("nicht gefunden")
    save_sites(SITES, sites)
    os.chmod(SITES, 0o644)
    print(f"{args.domain} entfernt.")


def cmd_list(_args) -> None:
    for d in sorted(load_sites(SITES)):
        print(d)


def cmd_status(_args) -> None:
    try:
        with open(STATUS, encoding="utf-8") as f:
            st = json.load(f)
    except OSError:
        sys.exit("Kein Status – läuft der Dienst? (systemctl status alvms-relay)")
    for d, s in sorted(st["sites"].items()):
        state = "verbunden" if s.get("bereit") else "NICHT verbunden"
        print(f"{d:40s} {state:16s} Aufrufe: {s.get('served', 0)}")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Andreas L.-Arts VMS Relay")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=443)
    s.add_argument("--sites", default=SITES)
    i = sub.add_parser("install")
    i.add_argument("--port", type=int, default=443)
    a = sub.add_parser("add")
    a.add_argument("domain")
    a.add_argument("key")
    r = sub.add_parser("remove")
    r.add_argument("domain")
    sub.add_parser("list")
    sub.add_parser("status")
    args = ap.parse_args()
    if args.cmd == "serve":
        try:
            asyncio.run(serve(args.port, args.sites))
        except KeyboardInterrupt:
            pass
    else:
        {"install": cmd_install, "add": cmd_add, "remove": cmd_remove, "list": cmd_list,
         "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    main()
