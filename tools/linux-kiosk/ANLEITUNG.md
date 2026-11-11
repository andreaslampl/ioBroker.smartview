# SmartView-Touch-PC mit Linux (Kiosk)

Für schwache Touch-PCs (z. B. Celeron N2930 mit 2 GB, auf dem Windows 11 zu langsam ist): ein schlankes Debian-Linux
startet direkt in SmartView im Vollbild – Touch, Lautsprecher und Mikrofon für die Sprechanlage, Wecken des Monitors
beim Klingeln. Sonst läuft nichts.

**Tipp:** auf eine **zweite mSATA-SSD** installieren und die Windows-SSD aufheben – dann kann man jederzeit zurück.

## Was man braucht

- USB-Stick (mind. 4 GB) – wird gelöscht
- USB-Tastatur (nur für die Einrichtung)
- Netzwerkkabel am Touch-PC (für die Installation)
- Die Adresse von SmartView (z. B. `https://deinname.duckdns.org`) und die IP des ioBroker

## 1. USB-Stick vorbereiten (an einem anderen PC)

1. Debian herunterladen: <https://www.debian.org/distrib/netinst> → **amd64** (`debian-13.x.x-amd64-netinst.iso`).
2. Mit **Rufus** (<https://rufus.ie>) oder **balenaEtcher** die ISO auf den Stick schreiben.

## 2. Debian installieren

1. Neue SSD einsetzen, Stick und Tastatur anstecken, einschalten.
2. Beim Einschalten ins **Bootmenü** (meist **F7**, **F11** oder **F12**; sonst mit **Entf** ins BIOS und dort den
   USB-Stick als erstes Startgerät wählen) und den **USB-Stick (UEFI)** starten.
3. **„Install“** (nicht „Graphical install“ nötig) und durchklicken:
   - Sprache **Deutsch**, Standort **Österreich**, Tastatur **Deutsch**
   - Rechnername z. B. `smartview-touch`, Domain leer lassen
   - **Root-Passwort** vergeben und gut merken
   - einen normalen Benutzer anlegen (z. B. `admin`) – wird nur für die Wartung gebraucht
   - Partitionierung: **„Geführt – vollständige Festplatte verwenden“**, die SSD wählen, „Alle Dateien auf eine Partition“
   - **Softwareauswahl:** alles **abwählen** außer **„SSH-Server“** und **„Standard-Systemwerkzeuge“**
     (keine Desktop-Umgebung, kein GNOME!)
   - GRUB auf die SSD installieren
4. Stick abziehen, neu starten. Es kommt eine schwarze Anmeldung (`smartview-touch login:`).

## 3. SmartView-Kiosk einrichten

Als **root** anmelden (Benutzer `root`, das Root-Passwort), dann:

```
wget https://raw.githubusercontent.com/andreaslampl/ioBroker.smartview/main/tools/linux-kiosk/kiosk-setup.sh
bash kiosk-setup.sh
```

Das Skript fragt:

- **Adresse, die der Touch-PC zeigen soll** – z. B. `https://deinname.duckdns.org` (mit https geht das Mikrofon ohne
  Umwege). Ohne DuckDNS: `http://192.168.1.10:8098`.
- **SmartView im Heimnetz für die Klingel-Abfrage** – `http://<IP des ioBroker>:8098`
- **Zugangsschlüssel** – leer lassen, wenn in SmartView keiner gesetzt ist
- bei einer DuckDNS-Adresse: **IP des ioBroker** – damit der Name auch ohne Internet gefunden wird

Es installiert alles (ein paar Minuten), dann: `reboot`.

Nach dem Neustart startet der Touch-PC von selbst in SmartView. Beim **ersten Klingeln** sollte der Klingelton kommen;
**Abheben** und Sprechen testen.

## Einstellungen und Wartung

- Einstellungen ändern: an der Tastatur **Strg+Alt+F2**, als root anmelden, `nano /etc/smartview-kiosk.conf`, speichern,
  `reboot`. Zurück zu SmartView: **Strg+Alt+F1**.
  - `SCREEN_OFF_MIN` – Monitor aus nach so vielen Minuten ohne Berühren (`0` = nie). Antippen oder Klingeln weckt ihn.
  - `WAKE_DURING_DND` – `1` = auch bei „Nicht stören“ wecken (Bild ohne Klingelton)
- Aus der Ferne: `ssh admin@smartview-touch` (bzw. die IP), dann `su -`.
- Sicherheits-Updates kommen automatisch; jeden **Sonntag um 4:17** startet der Touch-PC neu.
- Lautstärke: `wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.8` (0.0 – 1.0), Mikrofon: `…@DEFAULT_AUDIO_SOURCE@…`.
- Zurück zu Windows: einfach die alte SSD wieder einsetzen.

## Wenn etwas nicht geht

- **Schwarzer Bildschirm statt SmartView:** Strg+Alt+F2, als root `cat /home/kiosk/.local/share/xorg/Xorg.0.log | tail`
  – oder die Adresse in `/etc/smartview-kiosk.conf` prüfen.
- **Kein Ton / kein Mikrofon:** als root `su - kiosk -c 'wpctl status'` – dort müssen Lautsprecher und Mikrofon
  auftauchen.
- **Touch reagiert nicht:** meist ein USB-Touch, der ohne Treiber geht; sonst Ausgabe von `lsusb` schicken.
