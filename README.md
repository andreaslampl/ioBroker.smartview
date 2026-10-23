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
- **Größe:** Jede Kachel startet in ihrer Standardgröße. Im Bearbeiten-Modus am Griff **◢** unten rechts ziehen
  (Spalten × Reihen) oder im Kachel-Dialog „Breite“ / „Höhe“ wählen; „Standard“ stellt sie zurück. Am Handy wird
  eine Kachel nie breiter als der Bildschirm.
- **Frei platzieren:** ✎ → Seite bearbeiten → „Kacheln frei platzieren (Raster)“ und Spaltenzahl. Dann Kachel auf
  ein leeres Feld ziehen (Lücken bleiben) oder auf eine andere Kachel (die beiden tauschen). Am Handy stehen die
  Kacheln einfach untereinander, in der Reihenfolge Zeile für Zeile.
- Verschieben am einfachsten über den **Griff ⠿** (blaues Feld an jeder Kachel im Bearbeiten-Modus): anfassen und
  ziehen, mit Finger oder Maus.
- Verschieben geht auch direkt: Kachel oder Listeneintrag mit der Maus ziehen bzw. mit dem Finger
  kurz halten (ca. ½ Sekunde) und dann ziehen; danach „Speichern“.
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
| Fensterübersicht | pro Fenster Name, Magnetkontakt (true = offen), optional Kipp-Kontakt und „umgekehrt“ | geschlossen (grün) / gekippt (orange) / offen (rot) mit „seit …“; oben die Anzahl offener Fenster |
| HTML-Anzeige | Datenpunkt mit HTML-Text, z. B. eine Tabelle aus einem Skript (wie das VIS-Widget „Basic HTML“; dort steht er als `{datenpunkt}`) | aktualisiert sich live; Bilder des web-Adapters (VIS-Symbole) werden über SmartView geladen; Größe „groß“ = volle Breite |
| Wallbox | Wallbox-Instanz (versicharge) und Energie-Instanz, oder Datenpunkte selbst | antippen = Lademodus, Details (siehe unten) |
| Überschrift | – | – |

Kontakte, Bewegungsmelder und Alarme zeigen automatisch „Offen/Zu“, „Bewegung/Ruhe“ bzw.
„Alarm/OK“ (nach der Rolle des Datenpunkts). Werte mit Texten im Objekt (z. B. 0 = Unscharf)
erscheinen als Text.

### Jalousien / Rollläden

Datenpunkt: Position in % oder ein Auf/Ab-Objekt (true/false, z. B. KNX 1-Bit: false = auf, true = ab).
Sind Auf und Ab vertauscht, den Haken **„Auf/Ab umdrehen“** setzen.

**Markise und Wind-/Regenschutz:** Unter „Art“ Markise wählen (Knöpfe Einfahren/Ausfahren). Optional
**Windalarm** (true/false oder Windgeschwindigkeit mit Grenzwert) und **Regenalarm**: Kommt ein Alarm, fährt
der Adapter die Markise bzw. den Rollladen selbst in die sichere Position (Auf/Einfahren, Ab oder nur sperren)
– auch wenn kein Gerät offen ist. Solange der Alarm ansteht und danach noch die eingestellte **Sperrzeit**
(Sekunden oder Minuten) gehen keine Befehle durch, auch keine Zeitschaltuhr. Die Kachel zeigt 🔒 mit Grund
bzw. Restzeit.

### Tor / Garagentor

- **Getrennte Datenpunkte** für Auf und Zu (optional als Impuls: true, nach 1 s false) oder **ein Datenpunkt**:
  true = auf / false = zu, oder **Taster-Impuls** (jeder Impuls fährt bzw. stoppt).
- **Stopp** optional, **Endlagen** „Position oben“ und „Position unten“ optional → Anzeige offen / geschlossen /
  fährt.
- Ist das Tor schon offen und man drückt Auf, kommt **„… ist schon offen“** und es wird nichts gesendet (ebenso
  „schon zu“). Beim Taster-Impuls mit unbekannter Stellung wird vorher nachgefragt; optional immer nachfragen.

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

**Lagepläne als Kachel:** Kachel-Art „Grundriss / Lageplan“ zeigt eine Grundriss-Seite samt Symbolen (bedienbar)
auf einer normalen Kachel-Seite – so passen mehrere Lagepläne auf eine Seite, jeder in eigener Größe und frei
platzierbar. Antippen neben die Symbole öffnet den Plan groß. Die Grundriss-Seiten selbst kann man in den
Seiten-Einstellungen „In der Seitenleiste ausblenden“; bearbeitet werden sie weiter dort (Symbole setzen/ziehen).

Symbolgröße pro Grundriss-Seite (✎ → Seite bearbeiten → „Symbolgröße auf dem Grundriss“: sehr klein, klein,
normal, groß) – für Lagepläne mit vielen Symbolen. Jedes Symbol lässt sich im Kachel-Dialog unter
„Symbol drehen“ in 45°-Schritten drehen (z. B. Wandlampe zur Wand).

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

### Energiefluss (PV)

Mit dem Adapter **energie** (`iobroker url https://github.com/andreaslampl/ioBroker.energie`) gibt es die
Kachel-Art **„Energiefluss“**: animierter Fluss PV → Haus, Netz, Batterie und Verbraucher. Anzeige wählbar:
nur Fluss, Fluss mit Tageswerten, nur Tageswerte (Erzeugt, Verbraucht, Bezug, Einspeisung, Autarkie,
Eigenverbrauch) oder nur Tageskurve – für einzeln verschiebbare Teile einfach mehrere Kacheln anlegen.
Antippen öffnet die große Ansicht mit Tageskurve (‹ › blättert durch die letzten Tage). Datenpunkte,
Modbus-Faktoren, die Darstellung (rund/eckig, Linien, Animation, Symbole) und die Anordnung der Symbole
(„Anordnen“ auf der Seite /flow des Adapters) stellt man im Adapter energie ein, nicht in SmartView. Größe „groß“ = volle Breite.

### Wallbox

Kachel-Art **„Wallbox“**: Ladeleistung, Zustand (Kein Auto / angesteckt / Lädt / Fehler), in diesem Ladevorgang
geladene kWh und der Lademodus des PV-Überschussladens. Bei der **Siemens VersiCharge** genügt es, die
Wallbox-Instanz (Adapter [versicharge](https://github.com/andreaslampl/ioBroker.versicharge)) und die
Energie-Instanz zu wählen – die Datenpunkte füllt SmartView beim Speichern selbst aus. Andere Wallboxen: die
Datenpunkte selbst wählen.

Antippen öffnet das Bedienfenster mit den Modi **PV / Min+PV / Schnell / Aus / Manuell** (Regelung im Adapter
energie, Reiter „Wallbox“). Im Modus „Manuell“ lässt sich der Ladestrom mit − / + einstellen. Auf einer großen
Kachel (Größe „groß“ oder 2 Zeilen hoch) liegen die Modus-Tasten direkt auf der Kachel.

Schränkt energie das Laden ein (Wärmepumpe läuft, Bezugsgrenze), steht der Grund **orange** auf der Kachel, z. B.
„Pause – Wärmepumpe läuft“ oder „6 A – Wärmepumpe läuft“.

### Kameras

Kommen aus dem **livecam-Adapter**. SmartView holt die Bilder selbst und reicht sie weiter – so
funktionieren sie auch auf der HTTPS-Seite und über VPN. Kachel = Einzelbilder (1 pro Sekunde,
schont die Verbindungen), Vollbild = Video (MJPEG).

### Apple Home (homekit-easy) – nichts doppelt anlegen

Ist der Adapter **homekit-easy** installiert, hat jede Kachel für Licht/Schalter, Dimmer, Rollladen, Heizung,
Anzeige (Sensoren) und Kamera den Haken **„auch in Apple Home“** (bei Schaltern und Anzeigen mit Auswahl,
als was sie in Apple Home erscheinen, z. B. Licht, Steckdose, Temperatursensor, Kontakt). Beim Speichern
legt homekit-easy das Gerät an und hält es aktuell; Haken weg oder Kachel gelöscht = es verschwindet dort
wieder. Gibt es dieselbe Beschriftung auf mehreren Seiten (z. B. „Licht“), heißt das Gerät in Apple Home
„Seite Beschriftung“, z. B. „EG Licht“.

Das geht auch von homekit-easy aus: dort **„Aus SmartView …“** neben „＋ Gerät“ – die gewählten Kacheln
bekommen hier den Haken automatisch.

Wer zuerst mit homekit-easy angefangen hat: **✎ → „+ Kachel“ → „Aus homekit-easy übernehmen …“**, Geräte
anhaken, „Übernehmen“, „Speichern“. Die Kacheln bleiben mit dem Gerät verknüpft.

## Benutzer

Ohne Benutzer ist SmartView offen für jeden im Heimnetz (wie bisher). Mit Benutzern muss sich jedes
Gerät einmal anmelden und bleibt angemeldet, bis man im Menü auf **Abmelden** tippt.

Einrichten: Menü (⚙) → **Benutzer verwalten** → **+ Benutzer**. Der erste Benutzer ist immer
Administrator; wer ihn anlegt, ist danach gleich als dieser angemeldet. Pro Benutzer:

| Recht | Bedeutung |
| --- | --- |
| Administrator | sieht alles, darf bearbeiten (✎) und Benutzer verwalten |
| Darf schalten | ohne Haken nur ansehen (auch keine Zeitschaltuhren) |
| Klingel, Sprechanlage und Anrufliste | ohne Haken kein Klingel-Bild, keine Sprechstelle |
| Sichtbare Seiten | „Alle Seiten“ oder nur die angehakten |

Die Rechte prüft der ioBroker-Server, nicht nur die App: andere Seiten, deren Kameras und
Datenpunkte bekommt der Benutzer gar nicht zu sehen. Nach 5 falschen Passwörtern muss man warten.

Für den Touch-PC am besten einen eigenen Benutzer (z. B. „Touchpanel“) anlegen und dort einmal
anmelden. Passwort vergessen: in den Instanz-Einstellungen **Benutzer ausschalten (Notfall)**
anhaken, SmartView öffnen, neues Passwort setzen, Haken wieder entfernen.

Push-Mitteilungen gehen weiterhin an alle Geräte, auf denen sie aktiviert sind.

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

### Länger als … / und zusätzlich …

Jede Mitteilung kann zusätzlich **„länger als … Minuten“** (erst senden, wenn die Bedingung so lange
ununterbrochen gilt, z. B. Fenster länger als 15 Minuten offen) und **„und zusätzlich wenn …“** (zweiter
Datenpunkt muss auch passen, z. B. Heizung an). Für mehr Logik: im Adapter **logik** den Baustein
„Mitteilung (Push)“ verwenden – er schickt über diese Instanz (Datenpunkt `smartview.0.push.message`).

### Echtes Zertifikat (Let's Encrypt) – nichts am iPhone installieren

Darf auf einem Handy kein Zertifikat installiert werden (z. B. Firmen-iPhone), kann SmartView ein
öffentliches Let's-Encrypt-Zertifikat verwenden. Dem vertraut jedes Gerät von selbst, und die
normalen Mitteilungen funktionieren. Es muss **kein Port** im Router geöffnet werden.

1. **Kostenloser Name bei DuckDNS:** auf duckdns.org anmelden, eine Subdomain anlegen
   (z. B. `meinhaus.duckdns.org`) und bei „current ip“ die **Heimnetz-Adresse des ioBroker**
   eintragen (z. B. `192.168.1.x`). Den **Token** von dort braucht der nächste Schritt.
   (Eine eigene Domain bei einem anderen Anbieter geht auch, wenn der acme-Adapter ihn unterstützt.)
2. **ioBroker-Adapter acme** installieren: E-Mail, Domain `meinhaus.duckdns.org`, Challenge
   **DNS-01** mit **DuckDNS** und dem Token, Sammlung (Collection) z. B. `default`.
   Der Adapter holt das Zertifikat und erneuert es selbst.
3. **SmartView-Instanz:** „Zertifikats-Sammlung des acme-Adapters“ = `default`, „Adresse des
   ioBroker-Servers“ = `meinhaus.duckdns.org`. Instanz neu starten.
4. **iPhone** (im WLAN): in Safari `https://meinhaus.duckdns.org:8099/` öffnen → Teilen →
   **Zum Home-Bildschirm** → von dort starten → ⚙ **Mitteilungen aktivieren**.

Firmen-Handys lassen verschlüsselte Verbindungen oft nur über den Standard-Port durch: dann in der
Instanz **Port (HTTPS) = 443** einstellen und `https://meinhaus.duckdns.org/` (ohne Port) öffnen.
Kommt im acme-Log „KeyID header contained an invalid account URL“, stammt das gespeicherte Konto vom
Testserver (Staging): acme-Instanz löschen, neu anlegen, Staging aus.

Lädt die Adresse im WLAN nicht, blockiert der Router Namen, die auf eine Heimnetz-Adresse zeigen
(DNS-Rebind-Schutz, z. B. FRITZ!Box: Heimnetz → Netzwerk → Netzwerkeinstellungen →
„DNS-Rebind-Schutz“) – dort `meinhaus.duckdns.org` als Ausnahme eintragen. Geräte, die das eigene
SmartView-Zertifikat installiert haben, öffnen SmartView dann ebenfalls über den neuen Namen.

### Telegram (ohne Zertifikat)

Für Handys, auf denen kein Zertifikat installiert werden darf (z. B. Firmen-iPhone), können die
Mitteilungen zusätzlich oder stattdessen über **Telegram** kommen:

1. In ioBroker den Adapter **telegram** installieren. In Telegram bei **@BotFather** mit `/newbot`
   einen Bot anlegen und den Token in der telegram-Instanz eintragen (dort auch ein Passwort setzen).
2. In Telegram den neuen Bot öffnen, `/start` senden und dann `/password <Passwort>` – das Wort
   `password` bleibt gleich, danach das Passwort aus der telegram-Instanz (z. B. `/password Sonne123`).
3. In SmartView: ✎ → ⚙ **Allgemein & Mitteilungen** → „Auch über Telegram senden“: `telegram.0`,
   optional Empfänger (Vorname oder Telegram-Benutzername) → **Telegram testen**.
4. Pro Mitteilung bei „Senden an“ die Haken **App**, **Telegram**, **WhatsApp** setzen.

Die Telegram-Nachricht enthält einen Link „In SmartView öffnen“ (zur gewählten Seite; funktioniert
im WLAN bzw. mit VPN). Optional schickt SmartView beim Läuten ein **Foto der Klingel-Kamera**.
`smartview.0.push.message` geht ebenfalls an Telegram.

### WhatsApp

Über den ioBroker-Adapter **whatsapp-cmb** (Dienst CallMeBot, für den privaten Gebrauch kostenlos):

1. Adapter **whatsapp-cmb** installieren. Wie man den API-Key von CallMeBot bekommt, steht in dessen
   Anleitung (Nummer von CallMeBot als Kontakt speichern, „I allow callmebot to send me messages“
   schicken). API-Key und eigene Nummer in der whatsapp-cmb-Instanz eintragen.
2. In SmartView: ✎ → ⚙ **Allgemein & Mitteilungen** → „Auch über WhatsApp senden“: `whatsapp-cmb.0`,
   optional eine andere Nummer → **WhatsApp testen**.
3. Pro Mitteilung den Haken **WhatsApp** setzen.

WhatsApp über CallMeBot kann **nur Text** – beim Läuten kommt „🔔 Es läutet“ ohne Foto (das Foto gibt
es per Telegram). Der Link in den Nachrichten öffnet SmartView (https, wenn das Let's-Encrypt-Zertifikat
verwendet wird).

## Touch-PC

`http://<ioBroker-IP>:8098/` im Browser (Vollbild über ⚙ → Vollbild bzw. Kiosk-Modus) oder in VIS-2
als HTML-Widget: `<iframe src="http://<ioBroker-IP>:8098/" style="width:100%;height:100%;border:0"></iframe>`.
Mit `?device=touch` bzw. `?device=phone` lässt sich die Darstellung erzwingen.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| Port (HTTP) | Standard 8098 |
| HTTPS / Port (HTTPS) | eigenes Zertifikat, Standard 8099 – nötig für Mitteilungen |
| Zertifikats-Sammlung des acme-Adapters | optional: Let's-Encrypt-Zertifikat statt des eigenen (siehe oben) |
| Adresse des ioBroker-Servers | leer = automatisch; kommt auch ins Zertifikat |
| Zugriffsschlüssel | optional; dann auf jedem Gerät einmal mit `?key=…` öffnen |
| Bearbeiten erlauben | aus = Ansicht kann in der App nicht mehr geändert werden |
| Benutzer ausschalten (Notfall) | lässt alle ohne Anmeldung hinein, z. B. bei vergessenem Passwort |

Geschaltet werden können nur Datenpunkte, die in einer Kachel als Schalt-Datenpunkt eingetragen
sind. Ohne Benutzer kann sie jeder schalten, der SmartView öffnen kann – ohne Zugriffsschlüssel
jeder im Heimnetz.

Ansicht, hochgeladene Bilder, Zertifikat und angemeldete Geräte liegen im Datenverzeichnis der
Instanz (`layout.json`, `files/`, `certs.json`, `push.json`, `users.json` – Passwörter nur als Hash) und sind in der ioBroker-Sicherung
enthalten.

## Entwicklung

```
npm install
npm test
```

## Lizenz

MIT. Enthält [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0) in `www/vendor/`.
