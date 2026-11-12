# SmartView-Touch-PC mit Linux (Kiosk)

Für schwache Touch-PCs (z. B. Celeron N2930 mit 2 GB, auf dem Windows 11 zu langsam ist): ein schlankes Linux
(**Ubuntu Server** oder Debian, beides ohne Desktop) startet direkt in SmartView im Vollbild – Touch, Lautsprecher und
Mikrofon für die Sprechanlage, Wecken des Monitors beim Klingeln. Sonst läuft nichts.

- **Ubuntu Server** (LTS): das Skript nimmt dort **Google Chrome** (Ubuntu hat Chromium nur noch als „Snap“, das ist
  langsamer und macht im Kiosk Probleme).
- **Debian**: etwas schlanker, nimmt Chromium.

**Wichtig:** Ubuntu **Server**, nicht Ubuntu Desktop – der Desktop (GNOME) ist für 2 GB zu schwer.

**Tipp:** auf eine **zweite mSATA-SSD** installieren und die Windows-SSD aufheben – dann kann man jederzeit zurück.

## Was man braucht

- USB-Stick (mind. 4 GB) – wird gelöscht
- USB-Tastatur (nur für die Einrichtung)
- Netzwerkkabel am Touch-PC (für die Installation)
- Die Adresse von SmartView (z. B. `https://deinname.duckdns.org`) und die IP des ioBroker

## 1. USB-Stick vorbereiten (an einem anderen PC)

1. Ubuntu Server herunterladen: <https://ubuntu.com/download/server> → aktuelle **LTS**-Version
   (`ubuntu-xx.04-live-server-amd64.iso`).
   *(Debian statt Ubuntu: <https://www.debian.org/distrib/netinst> → amd64 netinst, siehe Abschnitt „Mit Debian“.)*
2. Mit **Rufus** (<https://rufus.ie>) oder **balenaEtcher** die ISO auf den Stick schreiben.

## 2. Ubuntu Server installieren

1. Neue SSD einsetzen, Stick und Tastatur anstecken, einschalten.
2. Beim Einschalten ins **Bootmenü** (meist **F7**, **F11** oder **F12**; sonst mit **Entf** ins BIOS und dort den
   USB-Stick als erstes Startgerät wählen) und den **USB-Stick (UEFI)** starten, dann „Try or Install Ubuntu Server“.
3. Im Installer (mit Pfeiltasten, Leertaste und Enter):
   - Sprache **Deutsch**, Tastatur **German**
   - Art der Installation: **„Ubuntu Server“** (nicht „minimized“ – da fehlen Werkzeuge)
   - Netzwerk: das Kabel wird automatisch erkannt (DHCP) – einfach weiter
   - Proxy leer lassen, Spiegelserver so lassen
   - Speicher: **„Gesamte Festplatte verwenden“**, die neue SSD wählen, das Häkchen **„Als LVM-Gruppe einrichten“
     entfernen** (sonst nutzt Ubuntu nur die Hälfte der kleinen SSD) – weiter, „Fortfahren“ bestätigen
   - Name, Rechnername z. B. `smartview-touch`, Benutzer z. B. `admin` und ein **Passwort** (gut merken)
   - Ubuntu Pro: **überspringen**
   - **„OpenSSH-Server installieren“ ankreuzen** (für die Wartung aus der Ferne)
   - Die angebotenen **Snaps** (docker, nextcloud …): **nichts auswählen**
4. Warten bis „Installation abgeschlossen“, dann **„Jetzt neu starten“**, Stick abziehen, wenn er dazu auffordert.
   Es kommt eine schwarze Anmeldung (`smartview-touch login:`).

## 3. SmartView-Kiosk einrichten

Mit dem Benutzer anmelden (z. B. `admin` und das Passwort), dann:

```
sudo -i
wget https://raw.githubusercontent.com/andreaslampl/ioBroker.smartview/main/tools/linux-kiosk/kiosk-setup.sh
bash kiosk-setup.sh
```

(`sudo -i` fragt noch einmal das Passwort und macht dich zu root. Bei Debian statt dessen als `root` anmelden.)

Das Skript fragt:

- **Adresse, die der Touch-PC zeigen soll** – z. B. `https://deinname.duckdns.org` (mit https geht das Mikrofon ohne
  Umwege). Ohne DuckDNS: `http://192.168.1.10:8098`.
- **SmartView im Heimnetz für die Klingel-Abfrage** – `http://<IP des ioBroker>:8098`
- **Zugangsschlüssel** – leer lassen, wenn in SmartView keiner gesetzt ist
- bei einer DuckDNS-Adresse: **IP des ioBroker** – damit der Name auch ohne Internet gefunden wird

Es installiert alles (ein paar Minuten), dann: `reboot`.

Nach dem Neustart startet der Touch-PC von selbst in SmartView. Sind in SmartView Benutzer angelegt, kommt einmal die Anmeldung –
dafür erscheint eine **Bildschirmtastatur** (ab SmartView 0.67.2). Danach bleibt der Touch-PC angemeldet. Beim **ersten Klingeln** sollte der Klingelton kommen;
**Abheben** und Sprechen testen.

## Einstellungen und Wartung

- Einstellungen ändern: an der Tastatur **Strg+Alt+F2**, anmelden, `sudo -i`, `nano /etc/smartview-kiosk.conf`, speichern,
  `reboot`. Zurück zu SmartView: **Strg+Alt+F1**.
  - `SCREEN_OFF_MIN` – Monitor aus nach so vielen Minuten ohne Berühren (`0` = nie). Antippen oder Klingeln weckt ihn.
  - `WAKE_DURING_DND` – `1` = auch bei „Nicht stören“ wecken (Bild ohne Klingelton)
- Aus der Ferne (z. B. Windows-Eingabeaufforderung): `ssh admin@smartview-touch` (bzw. die IP), dann `sudo -i`.
- Sicherheits-Updates kommen automatisch; jeden **Sonntag um 4:17** startet der Touch-PC neu.
- Lautstärke: `wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.8` (0.0 – 1.0), Mikrofon: `…@DEFAULT_AUDIO_SOURCE@…`.
- Zurück zu Windows: einfach die alte SSD wieder einsetzen.

## Skript aktualisieren

Neue Version des Kiosk-Skripts übernehmen (die Antworten von vorher bleiben erhalten), als root:

```
wget -O kiosk-setup.sh https://raw.githubusercontent.com/andreaslampl/ioBroker.smartview/main/tools/linux-kiosk/kiosk-setup.sh
bash kiosk-setup.sh
reboot
```

## Wenn etwas nicht geht

- **Schwarzer Bildschirm statt SmartView:** Strg+Alt+F2, anmelden, `sudo -i`, `cat /home/kiosk/.local/share/xorg/Xorg.0.log | tail`
  – oder die Adresse in `/etc/smartview-kiosk.conf` prüfen.
- **Kein Ton / kein Mikrofon:** als root `su - kiosk -c 'wpctl status'` (nur während SmartView läuft) – dort müssen Lautsprecher und Mikrofon
  auftauchen.
- **SmartView füllt nicht den ganzen Bildschirm:** Skript aktualisieren (siehe oben).
- **Touch reagiert nicht:** meist ein USB-Touch, der ohne Treiber geht; sonst Ausgabe von `lsusb` schicken.

## Mit Debian statt Ubuntu

Debian-netinst-ISO auf den Stick, beim Installieren „Install“ wählen, ein **Root-Passwort** vergeben, Partitionierung
„Geführt – vollständige Festplatte verwenden“, bei der **Softwareauswahl alles abwählen außer „SSH-Server“ und
„Standard-Systemwerkzeuge“** (kein GNOME!), GRUB auf die SSD. Danach als `root` anmelden und weiter bei Abschnitt 3 –
das Skript erkennt Debian selbst und nimmt Chromium.
