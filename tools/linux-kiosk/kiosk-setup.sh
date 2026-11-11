#!/bin/bash
# SmartView kiosk on a small PC with Debian 13 or Ubuntu Server LTS (no desktop): starts straight into SmartView in
# full screen (Chromium / Google Chrome, touch, speaker + microphone for the intercom) and wakes the monitor when the
# doorbell rings. Ubuntu ships Chromium only as a snap (slow, awkward in a kiosk) -> Google Chrome from Google's own
# apt repository there.
#
# Run once as root on a fresh install without desktop (Debian: only "SSH-Server" + "Standard-Systemwerkzeuge"):
#   bash kiosk-setup.sh
# The settings below are asked for when they are empty. Run it again any time to change them.
set -euo pipefail

# ---------------- settings ----------------
SV_URL="${SV_URL:-}"            # what the kiosk shows, e.g. https://deinname.duckdns.org  or  http://192.168.1.10:8098
SV_LOCAL="${SV_LOCAL:-}"        # SmartView in the LAN for the doorbell check (http, port 8098), e.g. http://192.168.1.10:8098
SV_KEY="${SV_KEY:-}"            # access key of SmartView, empty if none is set
HOSTS_NAME="${HOSTS_NAME:-}"    # DuckDNS name to resolve locally (works without internet), e.g. deinname.duckdns.org
HOSTS_IP="${HOSTS_IP:-}"        # LAN IP of the ioBroker for that name
SCREEN_OFF_MIN="${SCREEN_OFF_MIN:-0}"   # monitor off after this many minutes without touching (0 = never)
WAKE_DURING_DND="${WAKE_DURING_DND:-1}" # 1 = wake the monitor also during "Nicht stören"
KIOSK_USER=kiosk

if [ "$(id -u)" != 0 ]; then
    echo "Bitte als root starten (su - , dann: bash kiosk-setup.sh)" >&2
    exit 1
fi

ask() { # ask VAR "question" [default]
    local cur="${!1}"
    if [ -z "$cur" ]; then
        read -r -p "$2${3:+ [$3]}: " cur
        cur="${cur:-${3:-}}"
    fi
    printf -v "$1" '%s' "$cur"
}
ask SV_URL "Adresse, die der Touch-PC zeigen soll (z. B. https://deinname.duckdns.org)"
ask SV_LOCAL "SmartView im Heimnetz für die Klingel-Abfrage (z. B. http://192.168.1.10:8098)"
ask SV_KEY "Zugangsschlüssel von SmartView (leer lassen, wenn keiner)" ""
case "$SV_URL" in
    https://*.duckdns.org*)
        [ -n "$HOSTS_NAME" ] || HOSTS_NAME="$(printf '%s' "$SV_URL" | sed -E 's#^https://([^/:]+).*#\1#')"
        ask HOSTS_IP "IP des ioBroker für $HOSTS_NAME (damit es auch ohne Internet geht)"
        ;;
esac

echo "== Pakete installieren (dauert ein paar Minuten) =="
export DEBIAN_FRONTEND=noninteractive
DISTRO="$(. /etc/os-release && echo "${ID:-debian}")"
apt-get update
apt-get install -y --no-install-recommends \
    xserver-xorg xinit x11-xserver-utils fonts-dejavu-core \
    pipewire pipewire-pulse wireplumber pipewire-alsa alsa-utils \
    curl ca-certificates gnupg dbus-user-session \
    unattended-upgrades
if [ "$DISTRO" = ubuntu ]; then
    # Ubuntu: Chromium only as a snap -> Google Chrome (.deb, updated by apt like everything else)
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        >/etc/apt/sources.list.d/google-chrome.list
    apt-get update
    apt-get install -y google-chrome-stable
    BROWSER=google-chrome-stable
    PROFILE=google-chrome
else
    apt-get install -y chromium
    BROWSER=chromium
    PROFILE=chromium
fi

echo "== Benutzer $KIOSK_USER =="
if ! id "$KIOSK_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$KIOSK_USER"
fi
usermod -aG audio,video,input "$KIOSK_USER"

echo "== Automatisch anmelden auf Bildschirm 1 =="
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF

# the kiosk never sleeps
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

echo "== Einstellungen speichern =="
cat >/etc/smartview-kiosk.conf <<EOF
SV_URL='$SV_URL'
SV_LOCAL='$SV_LOCAL'
SV_KEY='$SV_KEY'
SCREEN_OFF_MIN='$SCREEN_OFF_MIN'
WAKE_DURING_DND='$WAKE_DURING_DND'
BROWSER='$BROWSER'
PROFILE='$PROFILE'
EOF
chmod 644 /etc/smartview-kiosk.conf

if [ -n "$HOSTS_NAME" ] && [ -n "$HOSTS_IP" ]; then
    sed -i "/[[:space:]]$HOSTS_NAME\$/d" /etc/hosts
    printf '%s\t%s\n' "$HOSTS_IP" "$HOSTS_NAME" >>/etc/hosts
fi

echo "== Monitor-Wecker =="
install -m 755 /dev/stdin /usr/local/bin/smartview-wecker <<'EOF'
#!/bin/bash
# Asks SmartView every second whether the doorbell rings (/api/ring) and switches the monitor on (X11 DPMS).
. /etc/smartview-kiosk.conf
url="$SV_LOCAL/api/ring"
[ -n "$SV_KEY" ] && url="$url?key=$SV_KEY"
was=0
while true; do
    r="$(curl -s -m 3 "$url" || true)"
    ringing=0; dnd=0
    case "$r" in *'"ringing":true'*) ringing=1 ;; esac
    case "$r" in *'"dnd":true'*) dnd=1 ;; esac
    if [ "$ringing" = 1 ] && [ "$was" = 0 ] && { [ "$WAKE_DURING_DND" = 1 ] || [ "$dnd" = 0 ]; }; then
        xset dpms force on 2>/dev/null || true
        xset s reset 2>/dev/null || true
    fi
    was="$ringing"
    sleep 1
done
EOF

echo "== Kiosk-Start =="
install -m 755 /dev/stdin /usr/local/bin/smartview-kiosk <<'EOF'
#!/bin/bash
# X session of the kiosk: screen saver / monitor off, sound + microphone on, wake-up script, Chromium (restarted if it ends)
. /etc/smartview-kiosk.conf
xset s off
if [ "${SCREEN_OFF_MIN:-0}" -gt 0 ]; then
    xset +dpms
    xset dpms 0 0 $((SCREEN_OFF_MIN * 60))
else
    xset -dpms
fi
/usr/local/bin/smartview-wecker &
# speaker and microphone: on and loud enough (PipeWire starts with the login)
( sleep 5
  wpctl set-mute @DEFAULT_AUDIO_SINK@ 0 2>/dev/null; wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.8 2>/dev/null
  wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 0 2>/dev/null; wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.9 2>/dev/null ) &
extra=()
case "$SV_URL" in
    http://*) extra+=("--unsafely-treat-insecure-origin-as-secure=$(printf '%s' "$SV_URL" | sed -E 's#^(http://[^/]+).*#\1#')") ;;
esac
prefs="$HOME/.config/${PROFILE:-chromium}/Default/Preferences"
while true; do
    # no "restore pages?" bubble after a power cut
    [ -f "$prefs" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$prefs"
    "${BROWSER:-chromium}" --kiosk --no-first-run --no-default-browser-check --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
        --disable-translate --disable-features=Translate --password-store=basic \
        --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream \
        --overscroll-history-navigation=0 --disable-pinch --check-for-update-interval=31536000 \
        --renderer-process-limit=2 --disk-cache-size=52428800 \
        "${extra[@]}" "$SV_URL"
    sleep 2
done
EOF

KHOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
cat >"$KHOME/.bash_profile" <<'EOF'
# start the kiosk on screen 1 (other screens: Strg+Alt+F2 for a login)
if [ -z "${DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
    exec startx /usr/local/bin/smartview-kiosk -- -nocursor
fi
EOF
chown "$KIOSK_USER:$KIOSK_USER" "$KHOME/.bash_profile"

echo "== Sicherheits-Updates automatisch, jeden Sonntag 4:17 Neustart =="
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
echo '17 4 * * 0 root /sbin/reboot' >/etc/cron.d/smartview-kiosk-reboot

echo
echo "Fertig. Jetzt neu starten:  reboot"
echo "Einstellungen später ändern: nano /etc/smartview-kiosk.conf  (dann reboot)"
