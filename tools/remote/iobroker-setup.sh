#!/bin/bash
# SmartView from outside: second step, run as root on the ioBroker host (Linux) with the code printed by vps-setup.sh:
#   bash iobroker-setup.sh <code>
# Sets up the WireGuard tunnel to the VPS (outgoing, no port forwarding). Through the tunnel the VPS may only reach
# the SmartView port - not ioBroker admin or anything else on this machine.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
    echo "Bitte als root starten (sudo -i, dann: bash iobroker-setup.sh <Code>)" >&2
    exit 1
fi
CODE="${1:-}"
[ -n "$CODE" ] || { echo "Code fehlt – die Zeile steht am Ende von vps-setup.sh" >&2; exit 1; }
CONF="$(printf '%s' "$CODE" | base64 -d 2>/dev/null)" || { echo "Code ist nicht vollständig kopiert" >&2; exit 1; }
printf '%s' "$CONF" | grep -q '^\[Peer\]' || { echo "Code ist nicht vollständig kopiert" >&2; exit 1; }
PORT="$(printf '%s\n' "$CONF" | sed -n 's/^#port=\([0-9]\+\)$/\1/p')"
PORT="${PORT:-8098}"

echo "== Pakete =="
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends wireguard-tools nftables iproute2

echo "== Tunnel =="
umask 077
mkdir -p /etc/wireguard
{
    # [Interface] + firewall for the tunnel: the VPS reaches only SmartView (and ping)
    printf '%s\n' "$CONF" | sed '/^#port=/d' | awk -v port="$PORT" '
        { print }
        /^\[Interface\]/ {
            print "PostUp = nft add table inet svtunnel; nft add chain inet svtunnel in \"{ type filter hook input priority -10; }\"; nft add rule inet svtunnel in iifname %i ct state established,related accept; nft add rule inet svtunnel in iifname %i tcp dport " port " accept; nft add rule inet svtunnel in iifname %i icmp type echo-request accept; nft add rule inet svtunnel in iifname %i drop"
            print "PostDown = nft delete table inet svtunnel"
        }'
} >/etc/wireguard/svtunnel.conf
systemctl enable wg-quick@svtunnel >/dev/null 2>&1
systemctl restart wg-quick@svtunnel

echo "== Verbindung prüfen =="
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ping -c1 -W2 10.77.0.1 >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
done
if [ "$ok" = 1 ]; then
    echo "Tunnel steht: der VPS (10.77.0.1) ist erreichbar."
else
    echo "Der VPS antwortet noch nicht. Prüfen: IONOS-Firewall UDP 51820 offen? Subdomain zeigt auf den VPS?" >&2
    echo "Status: wg show" >&2
fi
echo
echo "Jetzt in ioBroker → Instanzen → SmartView → Einstellungen:"
echo "  Adresse(n) des Vermittlers: 10.77.0.1"
echo "  Adresse von außen: https://<deine Subdomain>"
echo "und in SmartView Benutzer anlegen (Menü → Benutzer) – ohne Benutzer bleibt der Zugang von außen gesperrt."
