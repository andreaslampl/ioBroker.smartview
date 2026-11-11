#!/bin/bash
# SmartView from outside without VPN on the phone: run once as root on an own Debian VPS (e.g. IONOS, next to RustDesk).
# Installs WireGuard (the ioBroker at home connects OUT to this server - no port forwarding at home) and Caddy
# (https with a Let's Encrypt certificate for your subdomain, forwards everything through the tunnel to SmartView).
#   bash vps-setup.sh
# Before: subdomain (A record) -> IP of this VPS; IONOS firewall: TCP 80, TCP 443, UDP 51820 open.
# Run it again any time: keys are kept, the domain can be changed.
set -euo pipefail

DOMAIN="${DOMAIN:-}"        # e.g. smartview.example.com
SV_PORT="${SV_PORT:-8098}"  # SmartView HTTP port on the ioBroker
WG_PORT="${WG_PORT:-51820}"
NET=10.77.0               # tunnel: .1 = this VPS, .2 = ioBroker

if [ "$(id -u)" != 0 ]; then
    echo "Bitte als root starten (sudo -i, dann: bash vps-setup.sh)" >&2
    exit 1
fi
if [ -z "$DOMAIN" ]; then
    read -r -p "Subdomain für SmartView (z. B. smartview.deine-firma.at): " DOMAIN
fi
DOMAIN="$(printf '%s' "$DOMAIN" | sed -E 's#^https?://##; s#/.*$##')"
[ -n "$DOMAIN" ] || { echo "Keine Domain angegeben" >&2; exit 1; }
read -r -p "SmartView-Port (HTTP) am ioBroker [$SV_PORT]: " p || true
SV_PORT="${p:-$SV_PORT}"

# ports 80/443 must be free for Caddy (RustDesk uses 21114-21119, not these)
busy="$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)"
if [ -n "$busy" ]; then
    echo "Port 80 oder 443 wird schon von einem anderen Programm benutzt:" >&2
    echo "$busy" >&2
    echo "Dann bitte melden – Caddy muss anders eingebunden werden." >&2
    exit 1
fi

echo "== Pakete =="
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y wireguard-tools caddy curl

echo "== WireGuard =="
umask 077
mkdir -p /etc/wireguard
cd /etc/wireguard
[ -f sv-server.key ] || wg genkey >sv-server.key
[ -f sv-iobroker.key ] || wg genkey >sv-iobroker.key
wg pubkey <sv-server.key >sv-server.pub
wg pubkey <sv-iobroker.key >sv-iobroker.pub
cat >/etc/wireguard/svtunnel.conf <<EOF
# SmartView tunnel (tools/remote/vps-setup.sh)
[Interface]
Address = $NET.1/24
ListenPort = $WG_PORT
PrivateKey = $(cat sv-server.key)

[Peer]
# ioBroker at home
PublicKey = $(cat sv-iobroker.pub)
AllowedIPs = $NET.2/32
EOF
systemctl enable wg-quick@svtunnel >/dev/null 2>&1
systemctl restart wg-quick@svtunnel

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow "$WG_PORT/udp" >/dev/null
fi

echo "== Caddy (https für $DOMAIN) =="
umask 022
CF=/etc/caddy/Caddyfile
BLOCK="# smartview-begin
$DOMAIN {
	encode gzip
	reverse_proxy $NET.2:$SV_PORT
}
# smartview-end"
if [ -f "$CF" ] && grep -q "smartview-begin" "$CF"; then
    # replace our old block (domain or port changed)
    awk '/# smartview-begin/{skip=1} !skip{print} /# smartview-end/{skip=0}' "$CF" >"$CF.new"
    printf '%s\n' "$BLOCK" >>"$CF.new"
    mv "$CF.new" "$CF"
elif [ -f "$CF" ] && grep -q "/usr/share/caddy" "$CF"; then
    # Debian's example file -> ours
    cp "$CF" "$CF.orig"
    printf '%s\n' "$BLOCK" >"$CF"
else
    [ -f "$CF" ] && cp "$CF" "$CF.bak-$(date +%Y%m%d%H%M%S)"
    printf '%s\n' "$BLOCK" >>"$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# everything the ioBroker needs, in one line (contains its private key - only copy it to the ioBroker)
CLIENT="[Interface]
Address = $NET.2/32
PrivateKey = $(cat /etc/wireguard/sv-iobroker.key)

[Peer]
PublicKey = $(cat /etc/wireguard/sv-server.pub)
Endpoint = $DOMAIN:$WG_PORT
AllowedIPs = $NET.1/32
PersistentKeepalive = 25
#port=$SV_PORT"
CODE="$(printf '%s\n' "$CLIENT" | base64 -w0)"

echo
echo "Fertig auf dem VPS."
echo
echo "Jetzt am ioBroker (per SSH, als root: sudo -i) diese ZWEI Zeilen eingeben:"
echo
echo "  wget -O iobroker-setup.sh https://raw.githubusercontent.com/andreaslampl/ioBroker.smartview/main/tools/remote/iobroker-setup.sh"
echo "  bash iobroker-setup.sh $CODE"
echo
echo "(Die lange Zeile enthält den Schlüssel des ioBroker – nirgends sonst hinkopieren.)"
echo "Danach in der SmartView-Instanz: Adresse des Vermittlers = $NET.1, Adresse von außen = https://$DOMAIN"
