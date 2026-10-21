# ioBroker.smartview

**SmartView** – Visualisierung für Handy und Touch-PC: Kacheln und Grundrisse direkt in der App
einrichten, Live-Werte, Kameras aus dem livecam-Adapter, Klingel mit „Tür öffnen“ und
Push-Mitteilungen aufs iPhone (auch außerhalb des WLANs). Dieselbe Seite passt sich an: am Handy
Reiter unten, am großen Bildschirm Seitenleiste.

## Installation

```
iob url https://github.com/andreaslampl/ioBroker.smartview
```

Instanz anlegen, dann SmartView über den Link der Instanz (Weltkugel) öffnen:

| Adresse | Wofür |
| --- | --- |
| `http://<ioBroker-IP>:8098/` | Touch-PC, VIS-2 (HTML-Widget/iframe), schnell ausprobieren |
| `https://<ioBroker-IP>:8099/` | iPhone-App mit Mitteilungen (Zertifikat nötig, siehe unten) |
| `http://<ioBroker-IP>:8098/zertifikat` | Anleitung und Download des Zertifikats |

## Einrichten

Oben rechts **✎** antippen:

- **+ Seite** – Name, Symbol und Art: **Kacheln**, **Liste** oder **Grundriss**.
- **+ Kachel** – Art wählen, Beschriftung, Datenpunkt mit **📂 Auswählen** (Objektbaum mit Suche),
  Symbol, Größe, und ob die Kachel überall, nur am Handy oder nur am Touch-PC erscheint.
- Kachel antippen = bearbeiten, ◀ ▶ verschieben, Kopieren, Löschen.
- **⚙ Allgemein & Mitteilungen** – Titel, Design, Klingel, Push-Regeln.
- **Speichern** – alle Geräte zeigen sofort die neue Ansicht.

Wenn alles fertig ist, kann man in den Instanz-Einstellungen **„Bearbeiten in der App erlauben“**
ausschalten.

### Kachel-Arten

| Art | Datenpunkte | Bedienung |
| --- | --- | --- |
| Schalter / Taster | Schalten, optional Rückmeldung (z. B. KNX-Status) | antippen = ein/aus |
| Dimmer | Helligkeit 0–100, optional Ein/Aus, Rückmeldung | antippen = ein/aus, Schieberegler |
| Rollladen | Position, optional Stopp, Rückmeldung; „100 % = geschlossen“ für KNX | ▲ ■ ▼, antippen = Schieberegler |
| Anzeige | beliebiger Wert mit Einheit, Texte (`true=Offen;false=Zu`), rot hervorheben | antippen = Details |
| Taste | schreibt einen festen Wert (Szene, Tor-Impuls), optional mit Rückfrage | antippen |
| Heizung / Raumregler | Sollwert, optional: Rückmeldung Sollwert, Raumtemperatur, Luftfeuchte, Betriebsart + Rückmeldung, Heizt/Stellgröße, Fenster | antippen = − / +, Betriebsart umschalten |
| Kamera | Kamera aus dem livecam-Adapter | antippen = Vollbild |
| Link | andere Webseite (z. B. Sonos-Radio, Kamerawand) | antippen = öffnet sie |
| Seite öffnen | – (Menü-Knopf für eine SmartView-Seite) | antippen = wechselt zur Seite |
| Mehrere Werte | bis zu 8 Datenpunkte mit Bezeichnung (z. B. Helligkeit Ost/West, 3 Temperaturfühler) | antippen = groß anzeigen |
| Überschrift | – | – |

Kontakte, Bewegungsmelder und Alarme zeigen automatisch „Offen/Zu“, „Bewegung/Ruhe“ bzw.
„Alarm/OK“ (nach der Rolle des Datenpunkts). Werte mit Texten im Objekt (z. B. 0 = Unscharf)
erscheinen als Text.

### Heizung / Raumregler

Nur der Sollwert ist Pflicht, alles andere kommt dazu, wenn es eingetragen ist:

- **Betriebsart**: Knöpfe zum Umschalten, der aktive ist blau (aus der Rückmeldung). Standard sind die
  KNX-HVAC-Modi `1=Komfort;2=Standby;3=Nacht;4=Frostschutz`; hat der Datenpunkt eigene Texte, werden
  diese verwendet. Eigene Liste im Feld „Betriebsarten“, z. B. `0=Aus;1=Heizen;2=Kühlen`.
- **Rückmeldung Sollwert**: angezeigt wird der Wert, den der Regler meldet (nach einem Tastendruck
  kurz der gesendete Wert).
- **Heizt gerade / Stellgröße**: Ein/Aus oder Ventilstellung in % – die Kachel leuchtet, solange geheizt wird.
- Raumtemperatur, Luftfeuchte und „Fenster offen“ stehen klein auf der Kachel und groß im Bedienfeld.
- **Sollwert min./max.**: Grenzen für − / + (leer = vom Datenpunkt).

### Zeitschaltuhr

Bei **Schaltern, Dimmern und Rollläden**: **lange auf die Kachel drücken** (auch in Listen und auf dem
Grundriss) → **⏰ Zeitschaltuhr**. Beliebig viele Schaltzeiten, je mit

- **Wochentagen** (einzeln antippen oder schnell „täglich“, „Mo–Fr“, „Sa–So“),
- **Uhrzeit** oder **Sonnenaufgang / Sonnenuntergang** mit Verschiebung in Minuten (−30 = 30 min vorher),
- **Aktion**: Ein / Aus, Dimmer auf %, Rollladen Auf / Ab / Position.

Geschaltet wird **vom ioBroker** – auch wenn kein Gerät offen ist. Kacheln mit aktiver Zeitschaltuhr
zeigen ⏰. Für Sonnenauf-/-untergang braucht ioBroker den Standort (Einstellungen → System → Breiten-
und Längengrad). Verpasste Zeiten (z. B. während eines Neustarts) werden nicht nachgeholt; eine
Schaltzeit, die bis zu 5 Minuten zu spät erkannt wird, schaltet noch. Die Zeitschaltuhren liegen in
`timers.json` im Datenverzeichnis und lassen sich auch einstellen, wenn „Bearbeiten“ gesperrt ist.

### Liste

Seite der Art **Liste**: eine Zeile pro Eintrag – Licht mit **EIN / AUS** und Statuslampe, Dimmer mit
**− / +** und Balken, Rollladen mit **▲ ▼ STOPP**, Heizung mit − Sollwert +, Werte rechts. Gut bei
vielen Lichtern am Touch-PC. Kacheln und Liste lassen sich jederzeit umschalten (Seite bearbeiten).

### Optionale Darstellung (wie beim Gira-HomeServer)

Unter ⚙ **Allgemein & Mitteilungen → Darstellung** – alles standardmäßig aus:

- **Datum in der Kopfzeile** (Touch-PC).
- **Seitenleiste ausblenden** – Navigation wie ein Menü: die erste Seite bekommt „Seite öffnen“-Kacheln
  für die Bereiche, oben erscheint **zurück**.
- **Geteilter Bildschirm am Touch-PC** – rechts oben und rechts unten feste Bereiche mit Reitern,
  z. B. oben Kameras | Photovoltaik, unten Wetterstation. Am Handy bleiben das normale Seiten.

### Grundriss

Seite der Art **Grundriss** anlegen → **Bild wählen** (PNG, JPG, SVG, WebP, GIF oder **PDF**, bis
20 MB). Eine PDF (z. B. der Plan vom Architekten) wird im Browser in ein Bild umgewandelt: bei
mehreren Seiten wird nachgefragt, welche, weiße Ränder werden abgeschnitten. Danach **auf den
Plan tippen**, wo ein Taster, Licht, Kontakt, Rollladen oder eine Kamera sitzt → Art und Datenpunkt wählen. Symbole lassen sich ziehen. In der Ansicht schaltet ein
Antippen Schalter und Tasten direkt; Dimmer, Rollläden, Heizung und Werte öffnen ein Bedienfeld,
Kameras das Vollbild. Leuchtende Symbole = ein, rot = Alarm. Mit **− / +** zoomen (am Handy).

### Klingel und Sprechstelle

Unter ⚙ **Allgemein & Mitteilungen → Klingel**:

- **Sprechstelle (livecam-Adapter)** wählen, z. B. `livecam.0` – dann kann SmartView alles wie die
  Kamerawand: **Klingelton** (Melodie und Lautstärke wie in livecam unter `/tones` gewählt),
  **Abheben und Sprechen**, **Ablehnen / Auflegen**, **Tür öffnen**, rotes **🔔 n** oben bei verpassten
  Anrufen und die **Anrufliste mit Fotos** (auch im Menü ⚙). Läutet es, erscheint die Kamera der
  läutenden Station groß; abgehoben wird an dem Gerät, an dem man zuerst „Abheben“ tippt.
- Ohne Sprechstelle: Datenpunkt „läutet“, Kamera und optional „Tür öffnen“ – dann zeigt SmartView beim
  Läuten nur das Kamerabild mit „Tür öffnen“.

Im Menü ⚙ lässt sich pro Gerät der **Klingelton ein/aus** schalten und **testen**.

**Mikrofon zum Sprechen:** Browser geben das Mikrofon nur auf sicheren Seiten frei – also SmartView
über **https** (Zertifikat installiert) öffnen, oder am Touch-PC die http-Adresse in Edge unter
`edge://flags/#unsafely-treat-insecure-origin-as-secure` eintragen (wie bei der Kamerawand, nur mit
Port 8098). In VIS-2 als iframe: `allow="microphone; autoplay"`. Der Ton muss einmal durch Antippen
der Seite freigegeben werden (Browser-Regel); im Kiosk-Betrieb hilft
`--autoplay-policy=no-user-gesture-required` in der Edge-Verknüpfung.

### Kameras

Kommen aus dem **livecam-Adapter**. SmartView holt die Bilder selbst und reicht sie weiter – so
funktionieren sie auch auf der HTTPS-Seite und über VPN. Kachel = Einzelbilder (1 pro Sekunde,
schont die Verbindungen), Vollbild = Video (MJPEG).

## iPhone: App und Mitteilungen

1. Am iPhone in **Safari** `http://<ioBroker-IP>:8098/zertifikat` öffnen → **Profil laden** →
   Einstellungen → Profil **installieren** → *Allgemein → Info → Zertifikatsvertrauenseinstellungen*
   → „SmartView CA“ **einschalten**.
2. `https://<ioBroker-IP>:8099/` öffnen → Teilen **□↑** → **Zum Home-Bildschirm**.
3. SmartView **vom Home-Bildschirm** starten → **⚙ → Mitteilungen aktivieren** → erlauben.
   **Test-Mitteilung senden** prüft alles.

Mitteilungen gehen von ioBroker über Apples Push-Dienst ans iPhone – auch im Mobilfunk, **ohne
VPN** (ioBroker braucht nur Internet). Zum Ansehen der Seite von unterwegs braucht es das VPN; in
der WireGuard-App „Bei Bedarf aktivieren“ (alles außer Heim-WLAN) macht das automatisch.

### Push-Regeln

Unter ⚙ **+ Mitteilung**: Datenpunkt, Bedingung (wird Ein / Aus / gleich / größer / kleiner /
ändert sich), Titel, Text (`{value}` = Wert) und welche Seite beim Antippen aufgeht. Gesendet wird
einmal, wenn die Bedingung eintritt.

Aus Skripten/Blockly/Logik: Datenpunkt `smartview.0.push.message` mit Text beschreiben oder mit
JSON `{"title": "Alarm", "text": "Garage offen", "page": "garage"}`.

## Touch-PC

`http://<ioBroker-IP>:8098/` im Browser (Vollbild über ⚙ → Vollbild bzw. Kiosk-Modus) oder in VIS-2
als HTML-Widget: `<iframe src="http://<ioBroker-IP>:8098/" style="width:100%;height:100%;border:0"></iframe>`.
Mit `?device=touch` bzw. `?device=phone` lässt sich die Darstellung erzwingen.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| Port (HTTP) | Standard 8098 |
| HTTPS / Port (HTTPS) | eigenes Zertifikat, Standard 8099 – nötig für Mitteilungen |
| Adresse des ioBroker-Servers | leer = automatisch; kommt auch ins Zertifikat |
| Zugriffsschlüssel | optional; dann auf jedem Gerät einmal mit `?key=…` öffnen |
| Bearbeiten erlauben | aus = Ansicht kann in der App nicht mehr geändert werden |

Geschaltet werden können nur Datenpunkte, die in einer Kachel als Schalt-Datenpunkt eingetragen
sind. Wer SmartView öffnen kann, kann diese schalten – ohne Zugriffsschlüssel jeder im Heimnetz.

Ansicht, hochgeladene Bilder, Zertifikat und angemeldete Geräte liegen im Datenverzeichnis der
Instanz (`layout.json`, `files/`, `certs.json`, `push.json`) und sind in der ioBroker-Sicherung
enthalten.

## Entwicklung

```
npm install
npm test
```

## Lizenz

MIT. Enthält [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0) in `www/vendor/`.
