# SmartView von unterwegs – ohne VPN-App und ohne offenen Port

Zwei einfache Wege, beide **ohne Portfreigabe am Router**. Den Weg wählst du in den Instanz-Einstellungen von SmartView
(Abschnitt „Zugriff von unterwegs“). Status, Adresse mit QR-Code und die Zeile für den Server stehen danach in SmartView
unter **Menü → Fernzugang** (nur für Administratoren, nur im Heimnetz).

| Weg | Was man braucht | Adresse für unterwegs |
|---|---|---|
| **Tailscale Funnel** | kostenloses Tailscale-Konto, Tailscale auf dem ioBroker-Rechner | `https://<rechner>.<tailnet>.ts.net` |
| **Eigener Server** | eigener Server im Internet (z. B. IONOS-VPS) mit `alvms-relay.py` (dasselbe Programm wie bei der VMS) | `https://<name>.duckdns.org` |

(Der dritte, ältere Weg – eigener VPS mit WireGuard und Caddy – steht in `ANLEITUNG.md`.)

## Sicherheit (gilt für beide Wege)

- Nach außen ist **nur SmartView** erreichbar – nie die ioBroker-Admin-Seite.
- Von außen ist immer eine **Anmeldung mit Benutzer, Passwort und dem Code aus der Authenticator-App** nötig. Ohne angelegte
  Benutzer ist SmartView von außen ganz gesperrt.
- **Zwei-Faktor und Fernzugang lassen sich nur im Heimnetz ändern.**
- Beim Einrichten der Zwei-Faktor-Anmeldung zeigt SmartView **10 Wiederherstellungs-Codes** (einmal!) – ausdrucken. Jeder
  Code funktioniert einmal, falls das Handy verloren geht (Anmeldeseite: „Handy verloren? Wiederherstellungs-Code“).
- Falsche Anmeldungen werden je Besucher-Adresse gezählt (5 Fehlversuche → Sperre).

**Zuerst im Heimnetz:** Menü → Benutzer verwalten (Benutzer anlegen), dann für jeden Benutzer Menü → Zwei-Faktor einrichten.

## Weg 1: Tailscale Funnel

1. Auf dem **ioBroker-Rechner** Tailscale installieren und anmelden:
   ```
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   sudo tailscale set --operator=iobroker
   ```
   (Der Link aus `tailscale up` im Browser öffnen und mit dem Tailscale-Konto anmelden.)
2. In SmartView: Instanz-Einstellungen → Zugriff von unterwegs → Weg **Tailscale Funnel**, Port 443 (8443 oder 10000, falls
   auf diesem Rechner schon etwas anderes Funnel auf 443 benutzt) → Speichern.
3. SmartView → Menü → **Fernzugang**. Beim ersten Mal steht dort „Bei Tailscale freischalten“: antippen, in der
   Tailscale-Verwaltung HTTPS / Funnel erlauben, dann „Erneut versuchen“.
4. Fertig: Die Adresse (mit QR-Code) am Handy öffnen und als Web-App auf den Home-Bildschirm legen.

Grenzen: Funnel leitet nur TCP weiter – zum **Sprechen** mit der Sprechanlage von unterwegs braucht es zusätzlich einen
TURN-Server (siehe unten). Klingel-Anzeige, Bild und Tür öffnen gehen auch ohne. Die Bandbreite ist begrenzt.

## Weg 2: eigener Server (z. B. IONOS-VPS)

Derselbe Server kann **VMS und SmartView gleichzeitig** bedienen – jeweils mit eigenem DuckDNS-Namen und eigenem Schlüssel.

1. **Programm auf den Server** (nur Python 3.8+ nötig, liegt hier als `alvms-relay.py`; bei der VMS schon eingerichtet?
   dann diesen Schritt überspringen):
   ```
   sudo python3 alvms-relay.py install          # Dienst auf Port 443 (oder: install --port 8443)
   ```
   Beim Anbieter TCP 443 eingehend erlauben (IONOS: Cloud Panel → Netzwerk → Firewall-Richtlinien).
2. **Zweiter DuckDNS-Name**, z. B. `mein-smartview.duckdns.org`, auf die **IP des Servers** stellen (auf duckdns.org).
3. **Zertifikat** für diesen Namen mit dem **acme-Adapter** holen (DuckDNS, DNS-01 – wie beim ersten Namen). Der Name kann in
   dieselbe Sammlung wie der erste oder in eine eigene.
4. In SmartView: Instanz-Einstellungen → Zugriff von unterwegs → Weg **Eigener Server**: Adresse des Servers, Port (443),
   Name für unterwegs (`mein-smartview.duckdns.org`), ggf. die Zertifikats-Sammlung → Speichern.
5. SmartView → Menü → **Fernzugang**: die Zeile `sudo alvms-relay add mein-smartview.duckdns.org <schlüssel>` kopieren und
   am Server ausführen. SmartView verbindet sich innerhalb einer Minute („verbunden mit …“). Kontrolle am Server:
   `alvms-relay status`.

Der Server reicht nur die **verschlüsselte** Verbindung durch – das Zertifikat liegt bei SmartView, der Server sieht weder
Passwörter noch Bilder. „Neuer Schlüssel“ im Fernzugang-Fenster macht den alten ungültig (dann die neue Zeile am Server
ausführen).

## Sprechanlage von unterwegs (TURN-Server)

Der Ton läuft über WebRTC (UDP) – Funnel und der eigene Server leiten nur TCP weiter. Damit man von unterwegs auch **reden**
kann, braucht es einen **TURN-Server (coturn)**, am einfachsten auf demselben eigenen Server:

1. Am Server: `sudo bash turn-setup.sh` (liegt im livecam-Adapter unter `tools/`). Es zeigt am Ende die Adresse und das Geheimnis.
2. Beim Anbieter eingehend erlauben: **UDP 3478** und **UDP 49160-49200** (IONOS: Cloud Panel → Netzwerk → Firewall-Richtlinien).
3. Firewall daheim: der ioBroker darf **UDP zum Server, Port 3478** senden.
4. In **livecam** (Instanz-Einstellungen, Sprechanlage): „TURN-Server“ `turn:<server>:3478` und „TURN-Geheimnis“ eintragen.

SmartView braucht dafür nichts – es bekommt die Zugangsdaten (12 Stunden gültig) von livecam. Das Geheimnis bleibt im ioBroker,
der Ton bleibt verschlüsselt. Ist der TURN-Server nicht erreichbar, geht der Ton daheim wie bisher.

## Hinweise

- **Push von unterwegs:** Web-Push hängt an der Adresse. Wer die Web-App über die Adresse für unterwegs installiert, schaltet
  dort Menü → Mitteilungen **einmal neu** ein.
- Links in Telegram / WhatsApp / Push zeigen automatisch auf die Adresse für unterwegs (außer in den Einstellungen ist eine
  andere „Adresse von außen“ eingetragen).
- Datenpunkte `smartview.0.info.remote` (Status) und `info.remoteUrl` (Adresse) – z. B. für eine Meldung, wenn der
  Fernzugang ausfällt.
