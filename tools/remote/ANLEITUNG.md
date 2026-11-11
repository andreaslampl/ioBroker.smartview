# SmartView von unterwegs – ohne VPN am Handy

Mit einem eigenen Server im Internet (z. B. einem **Debian-VPS bei IONOS**, auf dem schon RustDesk läuft) ist SmartView
unter einer eigenen Adresse wie `https://smartview.deine-firma.at` erreichbar – zu Hause und unterwegs, ohne VPN-App.

```
Handy ──https──▶ VPS (Caddy, Let's-Encrypt-Zertifikat) ──WireGuard-Tunnel──▶ ioBroker zu Hause (SmartView)
```

- Der **ioBroker baut den Tunnel selbst auf** (von innen nach außen) – am Router zu Hause wird **nichts** geöffnet.
- Über den Tunnel erreicht der VPS **nur SmartView** – nicht die ioBroker-Admin-Seite oder sonst etwas.
- Von außen ist in SmartView **immer eine Anmeldung** nötig: Passwort **und** der 6-stellige Code aus der
  **Authenticator-App** (Microsoft oder Google Authenticator). Ohne Benutzer bleibt es gesperrt.
- Optional: von außen **Kacheln mit PIN gesperrt** (Alarm, Tür …) oder **nur ansehen**.

**Was von außen nicht geht:** mit der Sprechanlage **reden** (das Gespräch läuft direkt zwischen Handy und ioBroker).
Die Klingel-Mitteilung, das Kamerabild und alles Schalten gehen.

## Was man braucht

- Den VPS mit Debian und SSH-Zugang als root (`sudo -i`)
- Bei IONOS eine **Subdomain**, z. B. `smartview.deine-firma.at`
- SSH-Zugang zum ioBroker (Linux)

## 1. Bei IONOS vorbereiten

1. **Subdomain anlegen** (Domains & SSL → deine Domain → Subdomain) und bei DNS einen **A-Eintrag** auf die
   **IP-Adresse des VPS** setzen. Nicht auf das Webhosting zeigen lassen!
2. **Firewall des VPS** (Server & Cloud → dein Server → Netzwerk → Firewall-Richtlinien) – diese Regeln hinzufügen:
   - TCP **80** (für das Let's-Encrypt-Zertifikat)
   - TCP **443** (https)
   - UDP **51820** (WireGuard-Tunnel)

   Die RustDesk-Regeln bleiben, wie sie sind.

Ein paar Minuten warten, bis die Subdomain bekannt ist.

## 2. Auf dem VPS

Per SSH auf den VPS, dann:

```
sudo -i
wget https://raw.githubusercontent.com/andreaslampl/ioBroker.smartview/main/tools/remote/vps-setup.sh
bash vps-setup.sh
```

Es fragt die Subdomain und den SmartView-Port (Enter = 8098). Am Ende stehen **zwei Zeilen**, die du am ioBroker
eingibst. Die zweite ist sehr lang – sie enthält den Schlüssel für den ioBroker, also nur dorthin kopieren.

## 3. Am ioBroker

Per SSH auf den ioBroker-Rechner, `sudo -i`, dann die zwei Zeilen vom VPS einfügen. Am Ende sollte
**„Tunnel steht“** kommen.

## 4. In SmartView

1. **Benutzer anlegen**, falls noch nicht geschehen (im Heimnetz: Menü → Benutzer). Ohne Benutzer ist der Zugang von
   außen gesperrt.
2. **Authenticator einrichten** – jeder Benutzer einmal, **im Heimnetz**: SmartView öffnen, anmelden, Menü →
   **„Zwei-Faktor (Authenticator)“**. In Microsoft Authenticator auf **+** → „Anderes Konto (Google, Facebook usw.)“ und
   den QR-Code scannen, dann den Code aus der App eingeben → „Einrichten“.
   Handy verloren? Ein Administrator setzt es unter Benutzer verwalten → „Authenticator zurücksetzen“ zurück.
3. ioBroker-Admin → Instanzen → **SmartView** → Einstellungen, Abschnitt „Zugriff von außen“:
   - **Adresse(n) des Vermittlers:** `10.77.0.1`
   - **Von außen:** alles wie zu Hause / Kacheln mit PIN nicht schaltbar / nur ansehen
   - **Zusätzlich den Code aus der Authenticator-App:** angehakt lassen
   - **Adresse von außen:** `https://smartview.deine-firma.at` – dann gehen die Links in Telegram/WhatsApp/Push
     überall
4. Speichern.

## 5. Am iPhone

1. In Safari `https://smartview.deine-firma.at` öffnen und anmelden (Name, Passwort, Code aus der Authenticator-App).
   Das iPhone bleibt angemeldet, bis du dich abmeldest – der Code wird nur beim Anmelden gebraucht.
2. Teilen → **Zum Home-Bildschirm** (die neue Adresse ist für das iPhone eine neue App).
3. In der App: Menü → **Mitteilungen einschalten** (Push muss für die neue Adresse einmal neu erlaubt werden).

Ein eigenes Zertifikat am iPhone ist nicht nötig – es ist ein normales Let's-Encrypt-Zertifikat.

**Tipp:** Die neue Adresse geht auch zu Hause (dann über den VPS, mit Anmeldung). Der Touch-PC bleibt bei der
Adresse im Heimnetz – dort klingelt und spricht er wie bisher.

## Wenn etwas nicht geht

- **„Tunnel steht“ kommt nicht:** IONOS-Firewall UDP 51820 offen? Subdomain zeigt auf den VPS (`ping smartview.…`)?
  Am ioBroker `wg show` – bei „latest handshake“ muss eine Zeit stehen.
- **Seite lädt nicht / Zertifikatsfehler:** am VPS `journalctl -u caddy -n 50` – meist ist Port 80 in der IONOS-Firewall
  noch zu oder die Subdomain zeigt noch woanders hin.
- **„SmartView von außen gesperrt“:** in SmartView sind noch keine Benutzer angelegt.
- **„… zuerst im Heimnetz einrichten“:** dieser Benutzer hat noch keinen Authenticator (Schritt 4.2).
- **Code wird nicht angenommen:** die Uhrzeit am Handy muss stimmen (automatisch stellen). Jeder Code gilt nur einmal.
- **502 Bad Gateway:** Tunnel weg oder SmartView läuft nicht; am VPS `ping 10.77.0.2`.
- Ausschalten: am ioBroker `systemctl disable --now wg-quick@svtunnel` – dann ist SmartView von außen sofort weg.
