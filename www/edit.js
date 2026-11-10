'use strict';

/* Edit mode: pages, tiles, floor plan markers (tap to add, drag to move), doorbell and push rules. */

const TYPE_LABELS = {
  switch: 'Schalter / Taster (Ein/Aus)',
  dimmer: 'Dimmer',
  color: 'Farblicht / RGBW (z. B. Shelly RGBW, mit KNX-Taster)',
  robot: 'Saugroboter / Mähroboter (jede Marke)',
  car: 'Auto (Akku, Reichweite, Laden – jede Marke)',
  blind: 'Rollladen / Jalousie',
  value: 'Anzeige (Wert, Text, Kontakt)',
  button: 'Taste (schreibt einen Wert, z. B. Szene)',
  thermostat: 'Heizung / Raumregler',
  camera: 'Kamera',
  link: 'Link / andere Webseite',
  page: 'Seite öffnen (Menü-Knopf)',
  multi: 'Mehrere Werte (z. B. 3 Temperaturen)',
  html: 'HTML-Anzeige (Text mit HTML aus einem Datenpunkt)',
  windows: 'Fensterübersicht (offen / gekippt / zu)',
  appliances: 'Haushaltsgeräte (Waschmaschine, Trockner … – Aus / Läuft / Fertig)',
  heading: 'Überschrift',
  energy: 'Energiefluss (PV, Netz, Batterie – Adapter energie)',
  gate: 'Tor / Garagentor',
  planview: 'Grundriss / Lageplan (Grundriss-Seite als Kachel)',
  wallbox: 'Wallbox (Laden, PV-Überschuss)',
  alarm: 'Alarmanlage (scharf / unscharf)',
  radio: 'Webradio (Adapter sonos-radio)',
  contact: 'Fensterkontakt / Magnetkontakt (z. B. im Lageplan)',
  climate: 'Luftentfeuchter / Klimagerät',
  leave: 'Haus verlassen (alles aus mit einem Knopf)',
  arrive: 'Ankommen (Alarm aus, Heizung, Licht)',
  fire: 'Brandmeldeanlage (FC20 / Cerberus PRO)',
  firedet: 'Brandmelder / Sounder einzeln (FC20, für den Lageplan)',
  ref: 'Verknüpfung zu einer anderen Kachel (z. B. im Lageplan)',
};

/** Fields per tile type: [key, label, kind, help]; kind: state-w, state-r, text, number, check, select:<opts>, camera */
const TYPE_FIELDS = {
  switch: [
    ['state', 'Schalten (Datenpunkt)', 'state-w'],
    ['status', 'Rückmeldung (optional)', 'state-r', 'Status-Datenpunkt, z. B. KNX-Rückmelde-Adresse'],
    ['invert', 'Umgekehrt (true = aus)', 'check'],
    ['sendMode', 'Senden', 'select:=Ein = true, Aus = false (normal);true=immer nur true senden (Stromstoß / Umschalten);false=immer nur false senden;push=Taster: drücken = true, loslassen = false', 'Bei „nur true“, „nur false“ und Taster zeigt die Kachel Ein/Aus nur mit Rückmelde-Datenpunkt. Dann wird auch nichts gesendet, wenn er schon so steht (z. B. Zeitschaltuhr „Ein“ bei schon eingeschaltetem Licht). Taster mit „Umgekehrt“: drücken = false, loslassen = true.'],
    ['pushTime', 'Taster: mindestens gedrückt (Sekunden, optional)', 'number', 'Standard 0,5 s. Auch Zeitschaltuhr, „Haus verlassen“ und Ein/Aus im Bedienfenster drücken so lange.'],
    ['also', 'Weitere Datenpunkte (werden gleich mitgeschaltet)', 'statelist', 'z. B. mehrere Lichter oder Steckdosen mit einer Kachel – sie bekommen denselben Befehl (auch von Zeitschaltuhr und „Haus verlassen“).'],
    ['onDelay', 'Einschaltverzögerung (Sekunden, optional)', 'number', 'Ein wird erst nach dieser Zeit ausgeführt. Ein neuer Befehl bricht das Warten ab. Die Kachel zeigt „Ein in …“.'],
    ['offDelay', 'Ausschaltverzögerung (Sekunden, optional)', 'number', 'Aus wird erst nach dieser Zeit ausgeführt, z. B. Lüfter-Nachlauf.'],
    ['autoOff', 'Automatisch aus nach (Minuten, optional)', 'number', 'Treppenhauslicht: nach dem Einschalten geht es nach dieser Zeit wieder aus. Neues Ein startet die Zeit neu.'],
    ['entryLabel', 'Name dieses Eintrags (nur mit weiteren Einträgen)', 'text', 'Mit weiteren Einträgen öffnet ein Tipp auf die Kachel eine Liste mit allen – die Felder oben sind Eintrag 1 (leer lassen, wenn nur die Liste gebraucht wird).'],
    ['entries', 'Weitere Einträge (optional, z. B. Zentralfunktionen)', 'entries'],
  ],
  dimmer: [
    ['state', 'Helligkeit 0–100 % (Datenpunkt)', 'state-w'],
    ['switchState', 'Ein/Aus (optional)', 'state-w', 'Wenn der Dimmer einen eigenen Schalt-Datenpunkt hat'],
    ['status', 'Rückmeldung Helligkeit (optional)', 'state-r'],
    ['also', 'Weitere Datenpunkte (werden gleich mitgeschaltet)', 'statelist', 'z. B. mehrere Lichter oder Steckdosen mit einer Kachel – sie bekommen denselben Befehl (auch von Zeitschaltuhr und „Haus verlassen“).'],
    ['onDelay', 'Einschaltverzögerung (Sekunden, optional)', 'number', 'Ein wird erst nach dieser Zeit ausgeführt. Ein neuer Befehl bricht das Warten ab. Die Kachel zeigt „Ein in …“.'],
    ['offDelay', 'Ausschaltverzögerung (Sekunden, optional)', 'number', 'Aus wird erst nach dieser Zeit ausgeführt, z. B. Lüfter-Nachlauf.'],
    ['autoOff', 'Automatisch aus nach (Minuten, optional)', 'number', 'Treppenhauslicht: nach dem Einschalten geht es nach dieser Zeit wieder aus. Neues Ein startet die Zeit neu.'],
  ],
  car: [
    ['carSrc', 'Auto (Adapter vw-connect, tesla-motors, bmw …)', 'cardev', 'Beim Übernehmen sucht SmartView die Datenpunkte des Autos selbst (Akku, Reichweite, Laden, Stecker, verriegelt, km-Stand, Position …) und trägt sie unten ein. Fehlendes selbst wählen.'],
    ['soc', 'Akku %', 'state-r'],
    ['range', 'Reichweite (km)', 'state-r'],
    ['charging', 'Ladezustand', 'state-r', 'Text oder Zahl, z. B. CHARGE_STATE_CHARGING'],
    ['power', 'Ladeleistung (kW)', 'state-r'],
    ['plugged', 'Stecker angesteckt', 'state-r'],
    ['target', 'Ziel-Ladestand %', 'state-r'],
    ['locked', 'Verriegelt', 'state-r'],
    ['mileage', 'Kilometerstand', 'state-r'],
    ['lat', 'Position Breite', 'state-r'],
    ['lon', 'Position Länge', 'state-r'],
    ['updated', 'Daten vom (Zeit)', 'state-r', 'z. B. VW: _dataset_created_on (VW liefert nur alle 15 min, wenn das Auto aktiv ist)'],
    ['climate', 'Taste: Klimatisierung ein/aus (optional)', 'state-w', 'Nur wenn der Adapter das Auto steuern kann (bei VW über das EU-Data-Act-Portal nicht).'],
    ['charge', 'Taste: Laden ein/aus (optional)', 'state-w'],
  ],
  robot: [
    ['robotKind', 'Gerät', 'select:vacuum=Saugroboter;mower=Mähroboter'],
    ['robotSrc', 'Roboter (Adapter dreame / husqvarna-automower / roomba)', 'robotdev', 'Füllt beim Übernehmen die Felder unten selbst aus (leere Felder bzw. die dieses Adapters). Andere Marken: „keiner“ und die Felder selbst wählen.'],
    ['status', 'Zustand', 'state-r'],
    ['texts', 'Texte für den Zustand (optional)', 'text', 'z. B. 1=Saugt;2=Bereit;6=Lädt – leer = Texte des Datenpunkts'],
    ['runAt', 'Arbeitet bei (optional)', 'text', 'Werte oder Texte mit ; getrennt, bei denen die Kachel „aktiv“ leuchtet, z. B. MOWING;LEAVING oder 1;5'],
    ['battery', 'Akku %', 'state-r'],
    ['error', 'Fehler (optional)', 'state-r', '0 / leer = kein Fehler, sonst rot'],
    ['connected', 'Verbunden (optional)', 'state-r'],
    ['start', 'Taste: Start (Mähen / Saugen)', 'state-w', 'Bekommt true'],
    ['resume', 'Taste: Nach Plan (optional)', 'state-w'],
    ['pause', 'Taste: Pause (optional)', 'state-w'],
    ['stop', 'Taste: Stopp (optional)', 'state-w'],
    ['home', 'Taste: Zur Station / Parken', 'state-w'],
    ['homeNext', 'Taste: Parken bis zum nächsten Plan (optional)', 'state-w'],
    ['areaId', 'Arbeitsbereich: Nummer (optional)', 'state-w', 'Husqvarna: Bereiche werden beim Übernehmen aus dem Adapter geholt (Knöpfe „Mähen: …“).'],
    ['areaStart', 'Arbeitsbereich: Start-Taste (optional)', 'state-w'],
    ['confirm', 'Taste: Fehler quittieren (optional)', 'state-w'],
    ['confirmable', 'Fehler quittierbar (optional)', 'state-r', 'true = Knopf „Fehler quittieren“ erscheint (ohne Datenpunkt: bei jedem Fehler)'],
    ['dirty', 'Sperrzonen nicht synchron (optional)', 'state-r', 'true = Sperrzonen können gerade nicht umgeschaltet werden (Husqvarna stayOutZones.dirty)'],
    ['mapMode', 'Karte im Bedienfenster', 'select:=automatisch (vom Roboter: Dreame = Kartenseite, Automower = GPS);none=keine;url=Kartenseite eines Adapters (z. B. Dreame);image=Kartenbild aus einem Datenpunkt;gps=GPS-Position auf eigenem Bild (z. B. Automower)'],
    ['mapUrl', 'Kartenseite (Adresse)', 'text', 'Dreame: web:/dreame/?did=<Geräte-ID> (wird mit der Vorlage gesetzt). web:/… = web-Adapter auf dem gleichen Rechner; sonst http(s)://…'],
    ['mapImage', 'Kartenbild (Datenpunkt)', 'state-r', 'Datenpunkt mit Bild (data:image… / Base64 / Adresse)'],
    ['lat', 'GPS Breite', 'state-r'],
    ['lon', 'GPS Länge', 'state-r'],
    ['track', 'Spur (Liste der Positionen, optional)', 'state-r', 'Husqvarna: positions.positions'],
    ['mapImg', 'Gartenbild für GPS', 'robotmap'],
  ],
  color: [
    ['state', 'Ein/Aus (Datenpunkt)', 'state-w', 'Shelly RGBW2: …lights.Switch – Shelly Plus RGBW PM: …RGBW0.Switch'],
    ['bright', 'Helligkeit 0–100 %', 'state-w', 'Shelly RGBW2: …lights.gain – Shelly Plus RGBW PM: …RGBW0.Brightness. Nötig zum Dimmen.'],
    ['rgb', 'Farbe (Text)', 'state-w', 'Shelly Plus RGBW PM: …RGBW0.Color (#rrggbb) – Shelly RGBW2: …lights.rgbw (#rrggbbww). Oder unten die einzelnen Kanäle.'],
    ['white', 'Weiß-Kanal (optional)', 'state-w', 'Shelly Plus RGBW PM: …RGBW0.White – Shelly RGBW2: …lights.white. Für Warmweiß über den W-Kanal.'],
    ['red', 'Rot-Kanal (optional, statt Farbe als Text)', 'state-w', 'z. B. Shelly RGBW2 …lights.red (0–255) oder ein KNX-Kanal (0–100 %, nach dem Höchstwert des Datenpunkts)'],
    ['green', 'Grün-Kanal (optional)', 'state-w'],
    ['blue', 'Blau-Kanal (optional)', 'state-w'],
    ['colors', 'Farben zum Blättern', 'text', 'Name=Farbe, mit ; getrennt. Farbe: #rrggbb, w = Weiß-Kanal (w50 = halb), fx = Farbwechsel. Leer = ' + 'Warmweiß=w;Kaltweiß=#ffffff;Rot=#ff0000;Orange=#ff5000;Grün=#00ff00;Blau=#0000ff;Lila=#8000ff;Farbwechsel=fx'],
    ['fxTime', 'Farbwechsel: Sekunden für eine Runde', 'number', 'Standard 60 – kleiner = schneller. Läuft im Adapter, auch ohne offene Seite; dimmbar.'],
    ['knxSwitch', 'KNX-Taster: Schalten (optional)', 'state-r', 'Gruppenadresse des Tastenpaars (Schalten/Dimmen). Oben kurz: ein – wenn schon an: nächste Farbe. Unten kurz: aus.'],
    ['knxDim', 'KNX-Taster: Dimmen (optional)', 'state-r', 'Dimm-Gruppenadresse (DPT 3.007) des gleichen Tastenpaars. Lang drücken: heller / dunkler, loslassen = Stopp.'],
    ['knxStatus', 'Rückmeldung an KNX: Ein/Aus (optional)', 'state-r', 'Eigene Gruppenadresse für die Status-LED des Tasters – nicht die Schalt-Adresse von oben. SmartView schreibt sie.'],
    ['knxBright', 'Rückmeldung an KNX: Helligkeit (optional)', 'state-r', 'Eigene Gruppenadresse (DPT 5.001), SmartView schreibt sie.'],
  ],
  blind: [
    ['state', 'Position % oder Auf/Ab (Datenpunkt)', 'state-w', 'Positions-Datenpunkt (0–100 %) oder Auf/Ab-Objekt (true/false)'],
    ['stop', 'Stopp (optional)', 'state-w'],
    ['status', 'Rückmeldung Position (optional)', 'state-r'],
    ['closed100', 'Auf/Ab umdrehen', 'check', 'Haken setzen, wenn Auf und Ab vertauscht sind (bei Position: 100 % = zu; bei Auf/Ab-Objekt: true = auf)'],
    ['posInvert', 'Prozent umdrehen (0 % ↔ 100 %)', 'check', 'Nur für die Position in %: Haken setzen, wenn Prozent verkehrt angezeigt bzw. gefahren wird (z. B. 100 % = offen). Auf/Ab (true/false) bleibt davon unberührt.'],
    ['kind', 'Art', 'select:blind=Rollladen / Jalousie;awning=Markise (Einfahren / Ausfahren)'],
    ['windAlarm', 'Windalarm (optional)', 'state-r', 'true = Alarm – oder eine Windgeschwindigkeit mit Grenzwert darunter'],
    ['windMin', 'Windalarm ab (optional)', 'number', 'Nur wenn der Datenpunkt eine Windgeschwindigkeit ist, z. B. 40 (km/h). Leer = true/false.'],
    ['rainAlarm', 'Regenalarm (optional)', 'state-r', 'true = Regen'],
    ['protect', 'Bei Wind- oder Regenalarm', 'select:up=automatisch Auf / Einfahren;down=automatisch Ab;none=nicht fahren, nur sperren'],
    ['lockTime', 'Sperre nach dem Alarm', 'number', 'Solange ein Alarm ansteht, ist immer gesperrt. Danach noch so lange (0 = sofort frei).'],
    ['lockUnit', 'Einheit der Sperre', 'select:min=Minuten;s=Sekunden'],
    ['also', 'Weitere Rollläden (fahren gleich mit)', 'statelist', 'Position bzw. Auf/Ab-Objekt weiterer Rollläden – sie bekommen denselben Befehl, auch beim Wind- / Regenschutz.'],
    ['entryLabel', 'Name dieses Eintrags (nur mit weiteren Einträgen)', 'text', 'Mit weiteren Einträgen öffnet ein Tipp auf die Kachel eine Liste mit allen – die Felder oben sind Eintrag 1 (leer lassen, wenn nur die Liste gebraucht wird).'],
    ['entries', 'Weitere Einträge (optional, z. B. Zentralfunktionen)', 'entries'],
  ],
  planview: [
    ['target', 'Grundriss-Seite', 'planpage'],
    ['openPlan', 'Tippen neben die Symbole öffnet die Grundriss-Seite', 'check', 'Ohne Haken passiert beim Tippen auf eine freie Stelle des Plans nichts – nur die Symbole reagieren.'],
  ],
  gate: [
    ['gateKind', 'Art', 'select:gate=Tor / Tür mit Antrieb (fährt zu);lock=Tür mit Motorschloss / Türöffner (nichts fährt)', 'Bei Motorschloss darf auch ohne Lichtschranke per Zeitschaltuhr bzw. „automatisch“ zugesperrt werden – es bewegt sich ja nichts, das jemanden einklemmen könnte.'],
    ['gateMode', 'Ansteuerung', 'select:separate=getrennte Datenpunkte für Auf und Zu;single=ein Datenpunkt für Auf und Zu'],
    ['open', 'Auf (Datenpunkt)', 'state-w', 'nur bei getrennten Datenpunkten'],
    ['close', 'Zu (Datenpunkt)', 'state-w', 'nur bei getrennten Datenpunkten'],
    ['state', 'Auf/Zu (Datenpunkt)', 'state-w', 'nur bei einem Datenpunkt'],
    ['single', 'Ein Datenpunkt: Befehl', 'select:level=true = auf, false = zu;impulse=Taster-Impuls (jeder Impuls fährt bzw. stoppt)'],
    ['impulse', 'Getrennte Datenpunkte als Impuls senden (true, nach 1 s wieder false)', 'check'],
    ['stop', 'Stopp (optional)', 'state-w'],
    ['posOpen', 'Position oben / offen (optional)', 'state-r', 'Endlage, true = ganz offen'],
    ['posClosed', 'Position unten / zu (optional)', 'state-r', 'Endlage, true = ganz geschlossen'],
    ['confirm', 'Vorher nachfragen', 'check'],
    ['autoClose', 'Automatisch schließen nach (Minuten, optional)', 'number', 'Ist das Tor so lange offen, schickt der Adapter einmal „Zu“ (auch ohne offene Seite). Braucht eine Endlage (oben oder unten) und den Haken darunter.'],
    ['autoSafe', 'Der Antrieb hat eine Lichtschranke / Schließkantensicherung', 'check', 'Ohne diesen Haken wird nie automatisch geschlossen (bei Art „Motorschloss“ nicht nötig). Der Antrieb selbst muss beim Schließen auf Hindernisse reagieren – SmartView sieht nicht, ob jemand darunter steht.'],
    ['barrier', 'Lichtschranke (optional)', 'state-r', 'true = unterbrochen: dann wird nicht geschlossen, sondern gewartet, bis sie frei ist.'],
    ['barrierInvert', 'Lichtschranke umgekehrt (true = frei)', 'check'],
    ['autoNotify', 'Mitteilung beim automatischen Schließen', 'check', 'Push / Telegram / WhatsApp – und eine Warnung, wenn das Tor 2 Minuten danach noch nicht zu ist.'],
    ['channels', 'Mitteilung senden an', 'channels'],
  ],
  value: [
    ['state', 'Datenpunkt', 'state-r'],
    ['unit', 'Einheit (leer = vom Datenpunkt)', 'text'],
    ['decimals', 'Nachkommastellen (leer = automatisch)', 'number'],
    ['texts', 'Texte (optional)', 'text', 'z. B. true=Offen;false=Zu oder 0=Unscharf;1=Scharf'],
    ['highlight', 'Rot hervorheben', 'select:none=nie;on=wenn Ein / true;off=wenn Aus / false'],
  ],
  button: [
    ['state', 'Datenpunkt', 'state-w'],
    ['value', 'Wert, der geschrieben wird', 'text', 'leer = true; Zahl oder Text möglich'],
    ['confirm', 'Vorher nachfragen', 'check'],
    ['entryLabel', 'Name dieses Eintrags (nur mit weiteren Einträgen)', 'text', 'Mit weiteren Einträgen öffnet ein Tipp auf die Kachel eine Liste mit allen – die Felder oben sind Eintrag 1 (leer lassen, wenn nur die Liste gebraucht wird).'],
    ['entries', 'Weitere Einträge (optional, z. B. Zentralfunktionen)', 'entries'],
  ],
  thermostat: [
    ['circLabel', 'Name dieses Kreises (optional)', 'text', 'Nur nötig, wenn es unten weitere Kreise gibt – z. B. „Fußbodenheizung“. Die Felder hier sind Kreis 1.'],
    ['state', 'Sollwert (Datenpunkt)', 'state-w'],
    ['fixedSet', 'Sollwert nur anzeigen (nicht verstellbar)', 'check', 'Haken: keine − / + Knöpfe, SmartView nimmt für den Sollwert auch keine Befehle an. Betriebsart bleibt umschaltbar.'],
    ['setStatus', 'Rückmeldung Sollwert (optional)', 'state-r', 'Aktueller Sollwert vom Regler, z. B. KNX-Status'],
    ['status', 'Raumtemperatur Ist (optional)', 'state-r'],
    ['humidity', 'Luftfeuchte (optional)', 'state-r'],
    ['mode', 'Betriebsart umschalten (optional)', 'state-w', 'z. B. KNX HVAC-Modus (1 = Komfort, 2 = Standby, 3 = Nacht, 4 = Frostschutz)'],
    ['modeStatus', 'Rückmeldung Betriebsart (optional)', 'state-r'],
    ['modes', 'Betriebsarten (optional)', 'text', 'Tasten zum Umschalten, Wert=Text, z. B. 0=Standby;1=Automatik;4=Normal; leer = Texte des Datenpunkts „Betriebsart umschalten“ oder 1=Komfort;2=Standby;3=Nacht;4=Frostschutz. Die Rückmeldung wird mit ihren eigenen Texten angezeigt.'],
    ['heating', 'Heizt gerade / Stellgröße % (optional)', 'state-r', 'Ein/Aus oder Ventilstellung in %'],
    ['window', 'Fenster (optional)', 'state-r', 'Zeigt „Fenster offen“'],
    ['step', 'Schritt', 'number', 'Standard 0,5'],
    ['min', 'Sollwert min. (optional)', 'number', 'leer = vom Datenpunkt'],
    ['max', 'Sollwert max. (optional)', 'number', 'leer = vom Datenpunkt'],
    ['unit', 'Einheit', 'text', 'Standard °C'],
    ['circuits', 'Weitere Heizkreise / Räume (optional)', 'circuits'],
  ],
  camera: [['camera', 'Kamera (aus dem livecam-Adapter)', 'camera']],
  link: [['url', 'Adresse', 'text', 'z. B. http://192.168.1.x:8096/radio – http-Seiten öffnen sich am iPhone (HTTPS) in einem eigenen Fenster']],
  page: [['target', 'Seite, die geöffnet wird', 'page']],
  multi: [['rows', 'Werte', 'rows']],
  appliances: [
    ['devices', 'Geräte', 'devices'],
    ['notify', 'Mitteilung, wenn ein Gerät fertig ist (Push / Telegram / WhatsApp)', 'check', 'Über die Wege, die in den Einstellungen eingerichtet sind.'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['onlyActive', 'Nur laufende / fertige Geräte anzeigen', 'check', 'Platz sparen: Geräte, die aus sind, werden ausgeblendet.'],
    ['doneHours', '„Fertig“ verschwindet nach (Stunden, optional)', 'number', 'Leer oder 0 = bis man auf die Zeile tippt (oder das Gerät wieder startet). Bei Home Connect auch, wenn die Tür geöffnet wird.'],
  ],
  windows: [
    ['windows', 'Fenster', 'windows'],
    ['onlyOpen', 'Nur offene / gekippte anzeigen', 'check', 'Sind alle zu, steht nur die Überschrift mit „alle geschlossen“ da.'],
    ['warnMin', 'Hervorheben, wenn länger offen als (Minuten, optional)', 'number', 'z. B. 15 – dann wird das Fenster rot mit ⚠. Leer = nie.'],
    ['warnWhen', 'Warnen, wenn (optional)', 'state-r', 'z. B. Regen, Alarmanlage scharf oder Heizung an: Ist dieser Datenpunkt true und etwas offen, wird es rot markiert und der Warntext erscheint.'],
    ['warnText', 'Warntext (optional)', 'text', 'z. B. „Regen!“ – Standard „Achtung“'],
    ['notify', 'Mitteilung senden (Push / Telegram / WhatsApp)', 'check', 'Wenn ein Fenster länger als die Minuten oben offen ist und wenn „Warnen, wenn“ eintritt, während etwas offen ist – über die Wege, die in den Einstellungen eingerichtet sind.'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['wordOpen', 'Wort für „offen“ (optional)', 'text', 'Die Übersicht geht auch für anderes, z. B. Lichter: „an“ / „aus“ und „alle Lichter sind aus“. Leer = Fenster-Wörter.'],
    ['wordTilt', 'Wort für „gekippt“ (optional)', 'text'],
    ['wordClosed', 'Wort für „geschlossen“ (optional)', 'text'],
    ['wordAll', 'Text, wenn nichts offen ist (optional)', 'text', 'z. B. „alle Lichter sind aus“ – Standard „alle“ + Wort für geschlossen'],
    ['iconOpen', 'Symbol für „offen“', 'iconsel'],
    ['iconTilt', 'Symbol für „gekippt“', 'iconsel'],
    ['iconClosed', 'Symbol für „geschlossen“', 'iconsel'],
    ['openColor', 'Farbe, wenn offen', 'select:bad=rot (Warnung);on=gelb wie eingeschaltet'],
  ],
  alarm: [
    ['area', 'Bereich aus NOX- oder SPC-Adapter (optional)', 'alarmarea', 'Füllt beim Übernehmen die leeren Felder unten (Zustand, Befehl, Alarm, bereit, Werte) und ist nötig für „Melder anzeigen“.'],
    ['status', 'Zustand (Datenpunkt)', 'state-r', 'z. B. Bereichszustand als Zahl'],
    ['command', 'Befehl (optional)', 'state-w', 'Datenpunkt zum Scharf-/Unscharfschalten – leer = nur Anzeige'],
    ['valueOff', 'Wert für „Unscharf“', 'text', 'NOX: 1, SPC: 0'],
    ['valueArm', 'Wert für „Scharf“', 'text', 'NOX: 5, SPC: 3'],
    ['valueHome', 'Wert für „Intern scharf“ (optional)', 'text', 'SPC: 1 (Teilscharf A)'],
    ['alarm', 'Alarm (optional)', 'state-r', 'true = Alarm – die Kachel blinkt rot'],
    ['error', 'Fehlertext (optional)', 'state-r', 'z. B. warum das Scharfschalten scheiterte'],
    ['ready', 'Scharfschaltbereit (optional)', 'state-r', 'true = bereit; NOX / SPC: areas.N.ready (NOX braucht dort die Exportliste)'],
    ['openText', 'Offene Melder (optional)', 'state-r', 'Text, z. B. „MK Küche 1, MK Bad“; NOX: areas.N.openInputs'],
    ['alarmText', 'Ausgelöste Melder (optional)', 'state-r', 'NOX: areas.N.alarmInputs'],
    ['ack', 'Quittieren (optional)', 'state-w', 'Taste „Alarm quittieren“ im Bedienfenster (nur mit „Schalten erlauben“, PIN wird abgefragt). NOX: control.ackAll – wird mit dem Bereich automatisch eingetragen.'],
    ['control', 'Schalten erlauben (scharf / unscharf, Melder ab- und einschalten)', 'check', 'Ohne Haken ist die Kachel nur Anzeige – auch der ioBroker nimmt dann keine Befehle von ihr an. Mit Haken am besten zusätzlich eine PIN setzen.'],
    ['showDetectors', 'Melder anzeigen (NOX / SPC)', 'check', 'Beim Speichern werden die Melder jedes Bereichs aus dem NOX- bzw. SPC-Adapter geholt (NOX braucht dort die Exportliste). Im Bedienfenster: offen / zu / abgeschaltet, mit „Schalten erlauben“ auch Abschalten / Einschalten (nur NOX). Neue Melder: Kachel nochmal speichern.'],
    ['notify', 'Mitteilung bei Alarm (Push / Telegram / WhatsApp)', 'check', '„🚨 ALARM Wohnhaus“ mit den ausgelösten Meldern, für jeden Bereich – über die Wege aus den Einstellungen.'],
    ['notifyMode', 'Mitteilung auch bei scharf / unscharf', 'check', 'z. B. „Garage: scharf“, wenn ein Bereich umschaltet – egal ob von SmartView, Bedienteil oder Schlüsselschalter.'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['areaLabel', 'Name dieses Bereichs (nur bei mehreren Bereichen)', 'text', 'z. B. Wohnhaus'],
    ['areas', 'Weitere Bereiche (optional)', 'areas'],
  ],
  ref: [
    ['ref', 'Original-Kachel', 'reftile', 'Zeigt genau diese Kachel: gleiche Datenpunkte, Einstellungen, PIN und Zeitschaltuhr. Ändern nur beim Original – die Verknüpfung zieht mit. Eigene Position, Größe, Beschriftung (leer = vom Original) und Ebene.'],
  ],
  firedet: [
    ['fireSrc', 'Melder / Sounder', 'firedev', 'Liste aus dem FC20-Adapter. Beim Speichern werden Zustand, Alarm, Störung, Abschaltung und Betriebsart selbst eingetragen, die Beschriftung auch (wenn leer).'],
    ['fdKind', 'Symbol', 'select:=automatisch (aus der Zentrale);smoke=Rauchmelder;heat=Wärmemelder;manual=Handmelder;sounder=Sounder', 'Automatisch: aus der Objektart der Zentrale. Ein eigenes Symbol (Feld „Symbol“ unten) geht auch.'],
    ['control', 'Abschalten / Einschalten erlauben', 'check', 'Ohne Haken nur Anzeige. Mit Haken am besten eine PIN setzen. Der FC20-Adapter braucht dafür „Befehle erlauben“.'],
  ],
  fire: [
    ['panel', 'FC20-Instanz', 'fc20panel', 'Füllt die Datenpunkte unten (Adapter fc20-cerberus-bacnet).'],
    ['control', 'Schalten erlauben (Akustik ab, Rücksetzen, Melder ab- / einschalten)', 'check', 'Ohne Haken nur Anzeige – auch der ioBroker nimmt dann keine Befehle von ihr an. Mit Haken am besten eine PIN setzen. Der FC20-Adapter braucht dafür „Befehle erlauben“.'],
    ['showDetectors', 'Melder anzeigen', 'check', 'Beim Speichern werden die Melder der Zentrale geholt (Ordner „Melder“). Im Bedienfenster: Zustand, mit „Schalten erlauben“ Abschalten / Einschalten. Neue Melder: Kachel nochmal speichern.'],
    ['notify', 'Mitteilung bei Brandalarm und Voralarm (Push / Telegram / WhatsApp)', 'check', '„🔥 BRANDALARM“ mit den Meldern – über die Wege aus den Einstellungen.'],
    ['notifyFault', 'Mitteilung auch bei Störung', 'check'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['alarm', 'Alarm', 'state-r'],
    ['alarmText', 'Melder im Alarm (Text)', 'state-r'],
    ['preAlarm', 'Voralarm', 'state-r'],
    ['fault', 'Störung', 'state-r'],
    ['faultText', 'Störungen (Text)', 'state-r'],
    ['disabled', 'Abschaltung aktiv', 'state-r'],
    ['disabledText', 'Abgeschaltet (Text)', 'state-r'],
    ['lastMsg', 'Letzte Meldung', 'state-r'],
    ['connection', 'Verbindung zur Zentrale', 'state-r'],
    ['silence', 'Akustik ab (Taste)', 'state-w'],
    ['reset', 'Rücksetzen (Taste)', 'state-w'],
  ],
  leave: [
    ['lightsOff', 'Lichter aus', 'check', 'Ohne Auswahl unten: alle Schalter und Dimmer auf der Ebene „Licht“ (nach Symbol oder Ebene im Kachel-Dialog) – Steckdosen bleiben an.'],
    ['lightsFrom', 'Lichter aus', 'select:both=Kacheln der Seite und zusätzliche Datenpunkte;points=nur die zusätzlichen Datenpunkte (unten)'],
    ['lightTiles', 'Nur diese Lichter (nichts angehakt = alle Lichter)', 'lighttiles'],
    ['blindsDown', 'Rollläden zu, Markisen ein', 'check'],
    ['blindsFrom', 'Rollläden aus', 'select:both=Kacheln der Seite und zusätzliche Datenpunkte;points=nur die zusätzlichen Datenpunkte (unten)'],
    ['blindTiles', 'Nur diese Rollläden (nichts angehakt = alle)', 'blindtiles'],
    ['heatMode', 'Heizung auf Betriebsart (optional)', 'text', 'Wert für alle Heizungs-Kacheln mit Betriebsart, z. B. KNX 2 = Standby. Leer = Heizung bleibt.'],
    ['alarmArm', 'Alarmanlage scharf schalten (optional)', 'alarmtile', 'Braucht dort „Schalten erlauben“; ihre PIN wird einmal abgefragt.'],
    ['alarmAreas', 'Diese Bereiche (nichts angehakt = alle)', 'alarmareas'],
    ['radioOff', 'Radio aus', 'check'],
    ['climateOff', 'Luftentfeuchter / Klimageräte aus', 'check'],
    ['extra', 'Zusätzliche Datenpunkte aus dem ioBroker', 'extra'],
    ['delayMin', 'Rollläden (und Alarmanlage) erst nach (Minuten, optional)', 'number', 'Zeit zum Hinausgehen – Lichter, Heizung, Radio sofort. „Ankommen“ bricht das Warten ab.'],
    ['alarmDelayMin', 'Alarmanlage scharf nach (Minuten, optional)', 'number', 'Eigene Zeit nur für die Alarmanlage, z. B. 3 – leer = mit den Rollläden (Zeile darüber), 0 = sofort.'],
    ['alarmNotify', 'Mitteilung, ob die Alarmanlage scharf ist', 'check', '90 s nach dem Scharfschalten: „Alarmanlage scharf ✓“ oder „Alarmanlage NICHT scharf“ mit den Bereichen – auch ohne den Haken „Mitteilung senden“ unten.'],
    ['notify', 'Mitteilung senden (Push / Telegram / WhatsApp)', 'check', 'Was geschaltet wurde – und eine Warnung, wenn die Alarmanlage 90 s danach nicht scharf ist.'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['external', 'Auch von ioBroker / Alexa / Apple Home auslösbar (ohne PIN!)', 'check', 'Legt smartview.0.scenes.<Seite>_<Kachel> an (Taste, true = auslösen), z. B. für homekit-easy, logik oder ein Skript. Achtung: dort wird keine PIN abgefragt.'],
  ],
  arrive: [
    ['alarmOff', 'Alarmanlage unscharf schalten (optional)', 'alarmtile', 'Ihre PIN wird einmal abgefragt.'],
    ['alarmAreas', 'Diese Bereiche (nichts angehakt = alle)', 'alarmareas'],
    ['extAlarm', 'Alarm auch über den Datenpunkt unscharf schalten (ohne PIN!)', 'check', 'Nur wichtig mit „Auch von ioBroker / Alexa / Apple Home auslösbar“: ohne diesen Haken schaltet der Datenpunkt alles andere, die Alarmanlage bleibt aber scharf (mit Hinweis in der Mitteilung). Scharf schalten über „Haus verlassen“ geht immer.'],
    ['heatMode', 'Heizung auf Betriebsart (optional)', 'text', 'z. B. KNX 1 = Komfort. Leer = Heizung bleibt.'],
    ['lights', 'Diese Lichter einschalten', 'lighttiles'],
    ['onlyDark', 'Lichter nur, wenn es dunkel ist', 'check', 'Nach Sonnenauf- und -untergang (Standort aus den ioBroker-Systemeinstellungen).'],
    ['blindsUp', 'Rollläden auf (Markisen bleiben ein)', 'check'],
    ['blindsFrom', 'Rollläden aus', 'select:both=Kacheln der Seite und zusätzliche Datenpunkte;points=nur die zusätzlichen Datenpunkte (unten)'],
    ['blindTiles', 'Nur diese Rollläden (nichts angehakt = alle)', 'blindtiles'],
    ['extra', 'Zusätzliche Datenpunkte aus dem ioBroker', 'extra'],
    ['notify', 'Mitteilung senden (Push / Telegram / WhatsApp)', 'check'],
    ['channels', 'Mitteilung senden an', 'channels'],
    ['external', 'Auch von ioBroker / Alexa / Apple Home auslösbar (ohne PIN!)', 'check', 'Legt smartview.0.scenes.<Seite>_<Kachel> an (Taste). Achtung: ohne PIN – z. B. Alarm unscharf per Sprachbefehl nur, wenn du das wirklich willst.'],
  ],
  contact: [
    ['state', 'Kontakt (true = offen)', 'state-r', 'Magnetkontakt des Fensters bzw. der Tür'],
    ['tilt', 'Zweiter Kontakt / Kipp-Kontakt (optional)', 'state-r'],
    ['logic', 'Auswertung', 'select:tilt=Kontakt 1 offen, Kontakt 2 gekippt;both=ein Kontakt offen: gekippt, beide: offen;table=eigene Tabelle', 'wie in der Fensterübersicht'],
    ['map', 'Tabelle (nur bei „eigene Tabelle“)', 'text', '4 Buchstaben z/t/o für: beide zu, nur 1 offen, nur 2 offen, beide offen – z. B. ztoo'],
    ['invert', 'Kontakt 1 umgekehrt (true = zu)', 'check'],
    ['invert2', 'Kontakt 2 umgekehrt (true = zu)', 'check'],
    ['hideClosed', 'Wenn zu, ausblenden (Lageplan)', 'check', 'Das Symbol erscheint nur, wenn offen (rot) oder gekippt (orange). Im Bearbeiten-Modus bleibt es sichtbar.'],
  ],
  climate: [
    ['climKind', 'Gerät', 'select:dehum=Luftentfeuchter (Soll in % Luftfeuchte);ac=Klimagerät (Soll in °C)'],
    ['state', 'Ein/Aus (Datenpunkt)', 'state-w'],
    ['status', 'Rückmeldung Ein/Aus (optional)', 'state-r'],
    ['invert', 'Ein/Aus umgekehrt', 'check'],
    ['target', 'Sollwert (optional)', 'state-w', 'Luftentfeuchter: Ziel-Luftfeuchte in %, Klimagerät: Solltemperatur'],
    ['step', 'Schritt für − / + (optional)', 'number', 'Standard: 5 (%) bzw. 0,5 (°C)'],
    ['min', 'Sollwert mindestens (optional)', 'number'],
    ['max', 'Sollwert höchstens (optional)', 'number'],
    ['humidity', 'Luftfeuchte Ist (optional)', 'state-r'],
    ['temp', 'Temperatur Ist (optional)', 'state-r'],
    ['mode', 'Betriebsart (optional)', 'state-w', 'z. B. Kühlen / Entfeuchten / Lüften'],
    ['modes', 'Texte der Betriebsarten (optional)', 'text', 'z. B. 0=Auto;1=Kühlen;2=Entfeuchten;3=Lüften – leer = Texte des Datenpunkts'],
    ['fan', 'Lüfterstufe (optional)', 'state-w'],
    ['fans', 'Texte der Lüfterstufen (optional)', 'text', 'z. B. 1=Leise;2=Mittel;3=Stark – leer = Texte des Datenpunkts'],
    ['alarm', 'Störung / Wassertank voll (optional)', 'state-r', 'true = Kachel rot'],
    ['sensors', 'Räume (Feuchte / Temperatur)', 'sensors'],
    ['auto', 'Automatik nach Luftfeuchte', 'check', 'SmartView schaltet ein, wenn der Mittelwert der Räume (ohne Räume: die Luftfeuchte oben) „Ein ab“ erreicht, und aus, wenn er auf „Aus bei“ fällt – auch ohne offene Seite. Dazwischen kann man von Hand schalten.'],
    ['autoOn', 'Ein ab (% Luftfeuchte)', 'number', 'z. B. 65'],
    ['autoOff', 'Aus bei (% Luftfeuchte)', 'number', 'z. B. 55 – muss kleiner sein als „Ein ab“'],
  ],
  radio: [
    ['station', 'Raum: Sender-Datenpunkt', 'state-w', 'sonos-radio.0.rooms.<Raum>.station – Lautstärke, Stopp, Titel und Gruppe ergänzt SmartView beim Übernehmen selbst. Die Senderknöpfe kommen aus der Senderliste des Adapters.'],
    ['roomLabel', 'Name dieses Raums (nur bei mehreren Räumen)', 'text', 'z. B. Küche'],
    ['rooms', 'Weitere Räume (optional)', 'rooms'],
  ],
  html: [['state', 'Datenpunkt mit HTML', 'state-r', 'z. B. eine Tabelle, die ein Skript erzeugt (javascript.0.…). Skripte im HTML werden nicht ausgeführt.']],
  heading: [],
  wallbox: [
    ['carTile', 'Auto-Kachel (optional)', 'cartile', 'Zeigt in der Wallbox-Kachel „Auto 63 % · 241 km“, solange ein Auto angesteckt ist; antippen öffnet die Auto-Kachel.'],
    ['charger', 'Wallbox-Instanz', 'charger', 'Füllt die Datenpunkte unten aus (Adapter versicharge). Andere Wallboxen: Datenpunkte selbst wählen.'],
    ['instance', 'Überschussladen (Energie-Instanz)', 'energy', 'Lademodus PV / Min+PV / Schnell / Aus vom Adapter „energie“ (Reiter Wallbox in dessen Einstellungen)'],
    ['state', 'Ladeleistung (W)', 'state-r'],
    ['status', 'Zustand (Text)', 'state-r'],
    ['plugged', 'Auto angesteckt (optional)', 'state-r'],
    ['energy', 'Geladen in kWh (optional)', 'state-r'],
    ['mode', 'Lademodus (optional)', 'state-w'],
    ['ctrl', 'Laderegelung (Text, optional)', 'state-r'],
    ['current', 'Ladestrom in A (optional)', 'state-w', 'Mit − / + einstellbar, wenn der Lademodus „Manuell“ ist oder es keinen Lademodus gibt'],
  ],
  energy: [
    ['instance', 'Energie-Instanz', 'energy'],
    ['show', 'Anzeige', 'select:flow=nur Energiefluss;stats=Energiefluss und Tageswerte;today=nur Tageswerte (Heute);chart=nur Tagesverlauf (Kurve)', 'Für einzeln verschiebbare Teile mehrere Kacheln anlegen, z. B. eine mit Fluss, eine mit Tageswerten, eine mit Kurve. Antippen öffnet immer die große Ansicht.'],
  ],
};

const Editor = (() => {
  let cameras = null;
  const names = {};

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function newId(list, prefix) {
    let i = 1;
    while (list.some(x => x.id === prefix + i)) i++;
    return prefix + i;
  }

  function start() {
    SV.draft = clone(SV.raw || SV.layout); // raw: links stay links
    // homekit-easy installed? then tiles get "auch in Apple Home"
    api('homekit').then(h => (SV.hk = h)).catch(() => (SV.hk = null));
    SV.editing = true;
    closeCam();
    closeSheet();
    render();
  }

  function changed() {
    return JSON.stringify(SV.draft) !== JSON.stringify(SV.layout);
  }

  function cancel() {
    if (changed() && !confirm('Änderungen verwerfen?')) return;
    SV.editing = false;
    SV.draft = null;
    render();
  }

  const hasHomekit = l => Boolean(l && l.pages.some(p => p.tiles.some(t => t.homekit)));

  async function save() {
    SV.saving = true;
    try {
      const hk = SV.hk && SV.hk.instance && (hasHomekit(SV.layout) || hasHomekit(SV.draft));
      const saved = await api('layout', { method: 'PUT', body: JSON.stringify(SV.draft) });
      SV.raw = saved;
      SV.layout = RefLogic.resolveAll(saved);
      SV.editing = false;
      SV.draft = null;
      render();
      toast('Gespeichert');
      if (hk) homekitResult();
      // reconnect: the server sends the values of newly used data points with the new init
      if (SV.ws) SV.ws.close();
    } catch (e) {
      toast('Speichern fehlgeschlagen: ' + e.message, true);
    } finally {
      SV.saving = false;
    }
  }

  /** What homekit-easy did with the tiles after saving. */
  async function homekitResult() {
    try {
      const { last } = await api('homekit');
      if (!last) return;
      if (last.error) toast('Gespeichert – Apple Home (homekit-easy): ' + last.error, true);
      else if (last.created || last.updated || last.removed) {
        toast('Gespeichert – Apple Home: ' + [[last.created, 'neu'], [last.updated, 'geändert'], [last.removed, 'entfernt']].filter(x => x[0]).map(x => x[0] + ' ' + x[1]).join(', '));
      }
    } catch (e) {
      // only information
    }
  }

  // ---------------- homekit-easy ----------------

  /** Sensible HomeKit type for a tile (same rules as lib/homekit.js defaultType). */
  function hkDefault(t) {
    const list = SV.hk.choices[t.type];
    if (t.type === 'switch') return { bulb: 'light', lamp: 'light', socket: 'outlet', fan: 'fan' }[t.icon] || 'switch';
    if (t.type === 'value') {
      const unit = String(t.unit || '').toLowerCase();
      if (unit === '%' || t.icon === 'drop') return 'humidity';
      if (unit === 'lx' || unit === 'lux') return 'lux';
      if (unit === 'ppm') return 'co2';
      return { window: 'contact', door: 'contact', motion: 'motion', fire: 'smoke', water: 'leak' }[t.icon] || 'temperature';
    }
    return list[0];
  }

  /** "auch in Apple Home" in the tile dialog; value = homekit-easy device type or ''. */
  function homekitField(body, t) {
    const box = document.createElement('div');
    box.className = 'hkbox';
    body.appendChild(box);
    const c = check('auch in Apple Home (' + SV.hk.instance + ')', Boolean(t.homekit));
    box.appendChild(c);
    const list = SV.hk.choices[t.type];
    const row = document.createElement('div');
    box.appendChild(row);
    const sel = list.length > 1 ? field(row, 'in Apple Home als', select(list.map(k => [k, SV.hk.labels[k]]), t.homekit || hkDefault(t))) : null;
    const h = document.createElement('div');
    h.className = 'help';
    h.textContent = t.hkId
      ? 'Verknüpft mit dem Gerät „' + t.hkId + '“ aus homekit-easy: Änderungen hier gehen beim Speichern auch dorthin. Haken weg = nicht mehr verknüpft, das Gerät bleibt in homekit-easy.'
      : 'Wird beim Speichern in homekit-easy angelegt und aktuell gehalten (Name = Beschriftung). Haken weg oder Kachel löschen = das Gerät verschwindet dort wieder.' + (SV.hk.running ? '' : ' ' + SV.hk.instance + ' läuft gerade nicht – abgeglichen wird, sobald es läuft.');
    box.appendChild(h);
    const show = () => (row.hidden = !c.input.checked);
    c.input.onchange = show;
    show();
    return { type: 'custom', get: () => (c.input.checked ? (sel ? sel.value : list[0]) : '') };
  }

  /** Take over devices from homekit-easy as tiles of this page. */
  async function importHomekit(page, done) {
    const d = dialog('Aus homekit-easy übernehmen');
    const body = document.createElement('div');
    body.innerHTML = '<p class="muted">Geräte werden geladen …</p>';
    d.sh.appendChild(body);
    let res;
    try {
      res = await api('homekit/devices');
    } catch (e) {
      res = { error: e.message };
    }
    if (res.error) {
      body.innerHTML = '<p class="hint">' + esc(res.error) + '</p>';
      return;
    }
    const linked = new Set(SV.draft.pages.flatMap(p => p.tiles.map(t => t.hkId).filter(Boolean)));
    body.textContent = '';
    const intro = document.createElement('p');
    intro.className = 'help';
    intro.textContent = 'Die gewählten Geräte werden Kacheln auf „' + (page.name || 'dieser Seite') + '“ und bleiben mit homekit-easy verknüpft – nichts doppelt anlegen.';
    body.appendChild(intro);
    const picks = [];
    for (const dev of res.devices) {
      const why = !dev.tile ? 'geht nicht als Kachel' : linked.has(dev.id) ? 'schon in SmartView' : '';
      const c = check(dev.name + ' – ' + dev.typeLabel + (why ? ' (' + why + ')' : ''), false);
      c.input.disabled = Boolean(why);
      if (why) c.classList.add('muted');
      body.appendChild(c);
      if (!why) picks.push([c.input, dev]);
    }
    if (!res.devices.length) body.insertAdjacentHTML('beforeend', '<p class="muted">In homekit-easy sind noch keine Geräte.</p>');
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const all = document.createElement('button');
    all.type = 'button';
    all.textContent = 'Alle';
    all.onclick = () => picks.forEach(([i]) => (i.checked = true));
    const grow = document.createElement('span');
    grow.className = 'grow';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = 'Übernehmen';
    ok.onclick = () => {
      const chosen = picks.filter(([i]) => i.checked).map(([, dev]) => dev);
      chosen.forEach((dev, n) => {
        const t = Object.assign({ id: newId(page.tiles, 't'), size: '1', device: 'all' }, dev.tile);
        if (page.type === 'plan') Object.assign(t, { x: 10 + ((n * 10) % 80), y: 10 + Math.floor(n / 8) * 10 });
        page.tiles.push(t);
      });
      d.close();
      if (done) done();
      render();
      if (chosen.length) toast(chosen.length + ' Kachel(n) übernommen – „Speichern“ nicht vergessen.');
    };
    buttons.append(all, grow, ok);
    body.appendChild(buttons);
  }

  // ---------------- dialog helpers ----------------

  function dialog(title) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    const sh = document.createElement('div');
    sh.className = 'sheet wide form';
    sh.innerHTML = '<h3><span class="grow">' + esc(title) + '</span><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></h3>';
    ov.appendChild(sh);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    sh.querySelector('[data-x]').onclick = close;
    return { ov, sh, close };
  }

  function field(box, label, input, help) {
    const l = document.createElement('label');
    l.textContent = label;
    box.appendChild(l);
    box.appendChild(input);
    if (help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = help;
      box.appendChild(h);
    }
    return input;
  }

  function textInput(value, type = 'text') {
    const i = document.createElement('input');
    i.type = type;
    if (type === 'number') i.step = 'any';
    i.value = value === undefined || value === null ? '' : value;
    return i;
  }

  function select(options, value) {
    const s = document.createElement('select');
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      s.appendChild(o);
    }
    s.value = value;
    return s;
  }

  /** areas of the NOX / SPC adapters (found by their state / mode data point), as a selection */
  function areaSelect(value) {
    const s = select([['', '(kein Bereich)']].concat(value ? [[value, value]] : []), value || '');
    api('objects')
      .then(data => {
        const seen = new Map();
        for (const o of data.states || data.list || []) {
          const m = /^((?:nox_alarmzentrale|spc-edp)\.\d+\.areas\.\d+)\.(state|mode)$/.exec(o.id);
          if (m && !seen.has(m[1])) seen.set(m[1], (data.folders || {})[m[1]] || '');
        }
        const cur = s.value;
        s.textContent = '';
        const opts = [['', seen.size ? '(kein Bereich)' : '(keine NOX-/SPC-Bereiche gefunden)']].concat(
          [...seen].sort((a, b) => a[0].localeCompare(b[0], 'de', { numeric: true })).map(([id, name]) => [id, (name ? name + ' – ' : '') + id]),
        );
        if (cur && !seen.has(cur)) opts.push([cur, cur + ' (nicht gefunden)']);
        for (const [v, txt] of opts) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = txt;
          s.appendChild(o);
        }
        s.value = cur;
      })
      .catch(() => {});
    return s;
  }

  function check(label, value) {
    const l = document.createElement('label');
    l.className = 'check';
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = Boolean(value);
    l.appendChild(i);
    l.appendChild(document.createTextNode(label));
    l.input = i;
    return l;
  }

  /** Name (when picked) and current value of a data point under its field. */
  async function stateName(id, el) {
    el.textContent = '';
    el.classList.remove('missing');
    if (!id) return;
    // the adapter knows it does not exist (no object): say so clearly, the tile shows ⚠
    const known = SV.states && SV.states[id];
    if (known && known.missing) {
      el.textContent = '⚠ Diesen Datenpunkt gibt es nicht – mit 📂 Auswählen neu wählen oder mit ✕ entfernen';
      el.classList.add('missing');
      return;
    }
    let v;
    try {
      v = (await api('values', { method: 'POST', body: JSON.stringify([id]) }))[id];
    } catch (e) {
      return;
    }
    const value = v === null || v === undefined ? '⚠ kein Wert – ID prüfen' : 'aktuell: ' + (typeof v === 'object' ? JSON.stringify(v) : String(v));
    el.textContent = (names[id] ? names[id] + ' · ' : '') + value;
  }

  /** Text field with 📂 object browser. */
  function stateField(box, label, value, forOutput, help) {
    const row = document.createElement('div');
    row.className = 'staterow';
    const input = textInput(value);
    input.placeholder = 'z. B. knx.0.EG.Licht.Wohnzimmer';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '📂 Auswählen';
    // remove a data point picked by mistake
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clearbtn';
    clear.textContent = '✕';
    clear.title = 'Datenpunkt entfernen';
    clear.setAttribute('aria-label', 'Datenpunkt entfernen');
    row.appendChild(input);
    row.appendChild(btn);
    row.appendChild(clear);
    field(box, label, row, help);
    const nameEl = document.createElement('div');
    nameEl.className = 'statename';
    box.appendChild(nameEl);
    stateName(value, nameEl);
    const showClear = () => (clear.style.visibility = input.value.trim() ? 'visible' : 'hidden');
    showClear();
    input.addEventListener('input', showClear);
    input.onchange = () => {
      stateName(input.value.trim(), nameEl);
      showClear();
    };
    clear.onclick = () => {
      input.value = '';
      stateName('', nameEl);
      showClear();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    btn.onclick = async () => {
      const r = await Picker.open({ api, title: (forOutput ? 'Datenpunkt zum Schalten wählen' : 'Datenpunkt zum Anzeigen wählen') + ' – ' + label, current: input.value.trim(), forOutput });
      if (r) {
        input.value = r.id;
        names[r.id] = r.name || '';
        stateName(r.id, nameEl);
        showClear();
      }
    };
    return input;
  }

  function iconField(box, value, onPick) {
    const grid = document.createElement('div');
    grid.className = 'iconpick';
    for (const name of SV.icons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = ICON_LABELS[name] || name;
      b.innerHTML = icon(name);
      if (name === value) b.classList.add('sel');
      b.onclick = () => {
        for (const x of grid.children) x.classList.remove('sel');
        b.classList.add('sel');
        onPick(name);
      };
      grid.appendChild(b);
    }
    field(box, 'Symbol', grid);
    return grid;
  }

  async function cameraField(box, value) {
    const s = select([['', '(keine)']], value || '');
    field(box, 'Kamera (aus dem livecam-Adapter)', s, 'Die Kameras werden im livecam-Adapter eingerichtet.');
    try {
      cameras = cameras || (await api('cameras'));
    } catch (e) {
      cameras = [];
    }
    for (const c of cameras) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + ' (' + c.id + ')';
      s.appendChild(o);
    }
    if (value && !cameras.some(c => c.id === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value + ' (nicht gefunden)';
      s.appendChild(o);
    }
    s.value = value || '';
    return s;
  }

  /** Instance of the energie adapter for the energy flow tile. */
  /** wallbox tile: instance of the versicharge adapter ('' = choose the data points by hand) */
  async function chargerField(box, value, label, help) {
    const s = select([['', '(keine – Datenpunkte selbst wählen)']], value || '');
    field(box, label, s, help);
    let list = [];
    try {
      list = (await api('energy')).chargers || [];
    } catch (e) {
      // not installed
    }
    for (const id of list.concat(value && !list.includes(value) ? [value] : [])) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id + (list.includes(id) ? '' : ' (nicht gefunden)');
      s.appendChild(o);
    }
    s.value = value === undefined ? list[0] || '' : value || '';
    return s;
  }

  /**
   * More data points of ioBroker for "Haus verlassen" / "Ankommen": name, data point, value, group. Lights and blinds go
   * with their tick (blinds delayed), "Sonstiges" always.
   */
  function extraField(box, rows, type) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    const leave = type === 'leave';
    field(box, 'Zusätzliche Datenpunkte aus dem ioBroker (optional)', wrap, 'Auch Geräte ohne Kachel. „Licht“ und „Rollladen“ zählen zu ihrem Haken (Rollläden mit der Verzögerung), „Sonstiges“ wird immer geschrieben. Wert leer: Licht ' + (leave ? 'aus (false)' : 'an (true)') + ', Rollladen ' + (leave ? 'ab (true, KNX 1 = ab)' : 'auf (false)') + '.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => ({ label: x.label.value.trim(), state: x.state.value.trim(), value: x.value.value.trim(), group: x.group.value }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name (optional)', textInput(r.label));
        x.label.placeholder = 'z. B. Gartenlicht';
        x.state = stateField(b, 'Datenpunkt', r.state, true);
        x.group = field(b, 'Gruppe', select([['light', 'Licht'], ['blind', 'Rollladen'], ['other', 'Sonstiges']], r.group || 'light'));
        x.value = field(b, 'Wert (optional)', textInput(r.value));
        x.value.placeholder = 'z. B. false, 0, 100 oder 2';
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Datenpunkt entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Datenpunkt';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '', group: 'light' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state) };
  }

  /** instance of the FC20 adapter (fills the fire tile's data points) */
  async function fc20Field(box, value, label, help) {
    const s = select([['', '(keine – Datenpunkte selbst wählen)']], value || '');
    field(box, label, s, help);
    let list = [];
    try {
      list = (await api('energy')).fc20 || [];
    } catch (e) {
      // not installed
    }
    for (const id of list.concat(value && !list.includes(value) ? [value] : [])) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id + (list.includes(id) ? '' : ' (nicht gefunden)');
      s.appendChild(o);
    }
    s.value = value === undefined ? list[0] || '' : value || '';
    return s;
  }

  /** one detector / sounder of the FC20 adapters (value = channel id) */
  async function fireDevField(box, value, label, help) {
    const s = select([['', '(wählen)']], value || '');
    field(box, label, s, help);
    let list = [];
    try {
      list = (await api('energy')).fireDevs || [];
    } catch (e) {
      // FC20 adapter not installed
    }
    const words = { smoke: 'Rauchmelder', heat: 'Wärmemelder', manual: 'Handmelder', sounder: 'Sounder' };
    const groups = {};
    for (const d of list) {
      const g = groups[d.panel] || (groups[d.panel] = document.createElement('optgroup'));
      g.label = d.panel;
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label + ' – ' + (words[d.kind] || d.kind);
      g.appendChild(o);
    }
    Object.values(groups).forEach(g => s.appendChild(g));
    if (value && !list.some(d => d.id === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value + ' (nicht gefunden)';
      s.appendChild(o);
    }
    if (!list.length) field(box, '', document.createElement('span'), 'Keine Melder gefunden – ist der FC20-Adapter installiert und mit der Zentrale verbunden?');
    s.value = value || '';
    return s;
  }

  /** car folder of a car adapter (value = folder) */
  async function carField(box, value, label, help) {
    const s = select([['', '(keines – Datenpunkte selbst wählen)']], value || '');
    field(box, label, s, help);
    let list = [];
    try {
      list = (await api('energy')).cars || [];
    } catch (e) {
      // no car adapter
    }
    for (const r of list.concat(value && !list.some(r => r.id === value) ? [{ id: value, label: value + ' (nicht gefunden)' }] : [])) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label;
      s.appendChild(o);
    }
    s.value = value || '';
    return s;
  }

  /** robot device of the dreame / husqvarna-automower adapters (value = device prefix); also sets "Gerät" */
  async function robotField(box, value, label, help, kindInput) {
    const s = select([['', '(keiner – Datenpunkte selbst wählen)']], value || '');
    field(box, label, s, help);
    let list = [];
    try {
      list = (await api('energy')).robots || [];
    } catch (e) {
      // adapters not installed
    }
    // older tiles stored any data point of the device: select the device it belongs to
    const owner = list.find(r => value && value.startsWith(r.id + '.'));
    if (owner) value = owner.id;
    const known = list.some(r => r.id === value);
    for (const r of list.concat(value && !known ? [{ id: value, label: value + ' (nicht gefunden)' }] : [])) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label;
      o.dataset.kind = r.kind || '';
      s.appendChild(o);
    }
    s.value = value || '';
    s.onchange = () => {
      const k = s.selectedOptions[0] && s.selectedOptions[0].dataset.kind;
      const ki = kindInput();
      if (k && ki) ki.value = k;
    };
    return s;
  }

  async function energyField(box, value, own) {
    const s = select([['', own ? '(keines)' : '(wählen)']], value || '');
    field(box, own ? own[0] : 'Energie-Instanz', s, own ? own[1] : 'Datenpunkte, Modbus-Faktoren usw. werden im Adapter „energie“ eingestellt.');
    let list = [];
    try {
      list = (await api('energy')).instances;
    } catch (e) {
      // not installed
    }
    for (const id of list.concat(value && !list.includes(value) ? [value] : [])) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id + (list.includes(id) ? '' : ' (nicht gefunden)');
      s.appendChild(o);
    }
    if (!list.length) field(box, '', document.createTextNode('Der Adapter „energie“ ist nicht installiert: iobroker url https://github.com/andreaslampl/ioBroker.energie'));
    s.value = value || list[0] || '';
    return s;
  }

  /** Editor for the rows of a "several values" tile. */
  function rowsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Werte (bis zu 8)', wrap, 'Ein Wert = groß angezeigt, mehrere = als kleine Liste (wie Helligkeit Ost/West)');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => ({ label: x.label.value.trim(), state: x.state.value.trim(), unit: x.unit.value.trim(), decimals: x.decimals.value === '' ? undefined : Number(x.decimals.value) }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Bezeichnung', textInput(r.label));
        x.label.placeholder = 'z. B. Ost';
        x.state = stateField(b, 'Datenpunkt', r.state, false);
        x.unit = field(b, 'Einheit (leer = vom Datenpunkt)', textInput(r.unit));
        x.decimals = field(b, 'Nachkommastellen (leer = automatisch)', textInput(r.decimals, 'number'));
        if (list.length > 1) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'danger';
          del.textContent = 'Wert entfernen';
          del.style.marginTop = '8px';
          del.onclick = () => {
            const cur = read();
            cur.splice(i, 1);
            list.splice(0, list.length, ...cur);
            draw();
          };
          b.appendChild(del);
        }
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      if (list.length < 8) {
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = '+ Wert';
        add.onclick = () => {
          const cur = read();
          cur.push({ label: '', state: '' });
          list.splice(0, list.length, ...cur);
          draw();
        };
        wrap.appendChild(add);
      }
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state) };
  }

  /** Household appliances: name, symbol, power data point (Shelly) or status data point (Home Connect). */
  function devicesField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Geräte', wrap, 'Leistung (z. B. Shelly Plug, W) oder Status (z. B. Home Connect „OperationState“) – aus beliebigen Adaptern.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () =>
      rowInputs.map(x => {
        const o = { label: x.label.value.trim(), icon: x.icon.value, kind: x.kind.value, state: x.state.value.trim(), remain: x.remain.value.trim() };
        if (o.kind === 'power') {
          o.onW = Number(x.onW.value) || 10;
          o.offMin = x.offMin.value === '' ? 3 : Number(x.offMin.value);
        } else {
          o.runAt = x.runAt.value.trim();
          o.doneAt = x.doneAt.value.trim();
        }
        return o;
      });
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name', textInput(r.label));
        x.label.placeholder = 'z. B. Trockner';
        x.icon = field(b, 'Symbol', select([['washer', 'Waschmaschine'], ['dryer', 'Trockner'], ['dishwasher', 'Geschirrspüler'], ['oven', 'Backofen'], ['socket', 'Steckdose'], ['bolt', 'Strom']], r.icon || 'washer'));
        x.kind = field(b, 'Erkennung', select([['power', 'Leistung (z. B. Shelly Plug)'], ['state', 'Status (z. B. Home Connect)']], r.kind || 'power'));
        x.state = stateField(b, 'Datenpunkt', r.state, false);
        const pw = document.createElement('div');
        x.onW = field(pw, 'Läuft ab (W)', textInput(r.onW === undefined ? '10' : String(r.onW)), 'Darüber gilt das Gerät als laufend (eine Minute lang, damit kurze Knitterschutz-Drehungen nicht zählen). Standby liegt meist unter 5 W.');
        x.offMin = field(pw, 'Fertig, wenn so lange darunter (Minuten)', textInput(r.offMin === undefined ? '3' : String(r.offMin)), 'Pausen im Programm (Einweichen, Abkühlen) sollen nicht als „fertig“ zählen – beim Trockner eher 5.');
        b.appendChild(pw);
        const sp = document.createElement('div');
        x.runAt = field(sp, 'Läuft bei (optional)', textInput(r.runAt || ''), 'Standard: Run;DelayedStart;Pause (Home Connect). Mehrere mit ; trennen, Text darf Teil des Werts sein, Zahlen genau.');
        x.runAt.placeholder = 'Run;DelayedStart;Pause';
        x.doneAt = field(sp, 'Fertig bei (optional)', textInput(r.doneAt || ''), 'Standard: Finished. Endet der Lauf mit einem anderen Wert (abgebrochen), gibt es keine Mitteilung.');
        x.doneAt.placeholder = 'Finished';
        b.appendChild(sp);
        x.remain = stateField(b, 'Restzeit (optional)', r.remain, false);
        const show = () => {
          pw.style.display = x.kind.value === 'power' ? '' : 'none';
          sp.style.display = x.kind.value === 'state' ? '' : 'none';
        };
        x.kind.addEventListener('change', show);
        show();
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Gerät entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        for (const [txt, dir] of [['▲', -1], ['▼', 1]]) {
          const mv = document.createElement('button');
          mv.type = 'button';
          mv.textContent = txt;
          mv.onclick = () => {
            const cur = read();
            const j = i + dir;
            if (j < 0 || j >= cur.length) return;
            [cur[i], cur[j]] = [cur[j], cur[i]];
            list.splice(0, list.length, ...cur);
            draw();
          };
          tools.appendChild(mv);
        }
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Gerät';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '', icon: 'washer', kind: 'power', state: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state) };
  }

  /** Window overview: per window name, contact, optional tilt contact, inverted. */
  function windowsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Fenster', wrap, 'Pro Fenster die Magnetkontakte (true = offen) und wie sie ausgewertet werden – je nach Verdrahtung.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () =>
      rowInputs.map(x => ({
        label: x.label.value.trim(),
        group: x.group.value.trim(),
        state: x.state.value.trim(),
        tilt: x.tilt.value.trim(),
        invert: x.invert.input.checked,
        invert2: x.invert2.input.checked,
        logic: x.logic.value,
        map: x.map.map(m => m.value).join(''),
      }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name', textInput(r.label));
        x.label.placeholder = 'z. B. Fenster links';
        x.group = field(b, 'Bereich (optional)', textInput(r.group), 'Fenster mit gleichem Bereich (z. B. „Küche“) stehen als eine Zeile da: „Küche – Fenster links offen“.');
        x.group.placeholder = 'z. B. Küche';
        x.logic = field(b, 'Auswertung', select([
          ['tilt', 'Kontakt 1 = offen, Kontakt 2 = gekippt'],
          ['both', 'ein Kontakt offen = gekippt, beide offen = offen'],
          ['table', 'eigene Tabelle'],
        ], r.logic || 'tilt'));
        x.state = stateField(b, 'Kontakt 1', r.state, false);
        x.invert = check('Kontakt 1 umgekehrt (true = geschlossen)', r.invert);
        b.appendChild(x.invert);
        x.tilt = stateField(b, 'Kontakt 2 (optional)', r.tilt, false);
        x.invert2 = check('Kontakt 2 umgekehrt (true = geschlossen)', r.invert2);
        b.appendChild(x.invert2);
        // own table: status for each combination of the two contacts
        const tbl = document.createElement('div');
        tbl.className = 'wintable';
        const map = /^[zto]{4}$/.test(r.map || '') ? r.map : 'ztoo';
        x.map = ['beide zu', 'nur Kontakt 1 offen', 'nur Kontakt 2 offen', 'beide offen'].map((txt, k) => field(tbl, txt, select([['z', 'zu'], ['t', 'gekippt'], ['o', 'offen']], map[k])));
        b.appendChild(tbl);
        const showTable = () => (tbl.style.display = x.logic.value === 'table' ? '' : 'none');
        x.logic.addEventListener('change', showTable);
        showTable();
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Fenster entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        for (const [txt, dir] of [['▲', -1], ['▼', 1]]) {
          const mv = document.createElement('button');
          mv.type = 'button';
          mv.textContent = txt;
          mv.onclick = () => {
            const cur = read();
            const j = i + dir;
            if (j < 0 || j >= cur.length) return;
            [cur[i], cur[j]] = [cur[j], cur[i]];
            list.splice(0, list.length, ...cur);
            draw();
          };
          tools.appendChild(mv);
        }
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Fenster';
      add.onclick = () => {
        const cur = read();
        // a new window takes the wiring of the one before (usually all windows are wired the same)
        const prev = cur[cur.length - 1];
        cur.push({ label: '', group: prev ? prev.group : '', state: '', tilt: '', logic: prev ? prev.logic : 'tilt', map: prev ? prev.map : 'ztoo', invert: prev ? prev.invert : false, invert2: prev ? prev.invert2 : false });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state || r.tilt) };
  }

  /**
   * PIN protection of a tile: the server stores only a hash and checks every command (also from other tiles that
   * write the same data point); the field never shows the PIN. Result: digits = new PIN, true = keep, '' = none.
   */
  function pinField(box, t) {
    const had = t.pin === true;
    const wrap = document.createElement('div');
    const inp = textInput('', 'password');
    inp.inputMode = 'numeric';
    inp.autocomplete = 'new-password';
    inp.placeholder = had ? 'PIN gesetzt – leer lassen = bleibt' : 'leer = kein Schutz';
    field(wrap, 'PIN-Schutz (4–8 Ziffern, optional)', inp, 'Vor jedem Schalten wird die PIN abgefragt und vom ioBroker geprüft (5 Fehlversuche = 5 Minuten gesperrt). Keine Zeitschaltuhr für diese Kachel. Achtung: Apple Home / Alexa fragen diese PIN nicht ab.');
    let del = null;
    if (had) {
      del = check('PIN entfernen', false);
      wrap.appendChild(del);
    }
    box.appendChild(wrap);
    return {
      type: 'custom',
      get: () => {
        const v = inp.value.trim();
        if (v) {
          if (!/^\d{4,8}$/.test(v)) {
            toast('PIN: 4 bis 8 Ziffern', true);
            return had ? true : undefined;
          }
          return v;
        }
        return had && !(del && del.input.checked) ? true : undefined;
      },
    };
  }

  /** More heating circuits of a heating tile: same data points as circuit 1, switched with ‹ › on the tile. */
  function circuitsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Weitere Heizkreise / Räume', wrap, 'Jeder Kreis mit eigenem Sollwert, Ist-Temperatur, Betriebsart … Auf der Kachel wird mit ‹ › umgeschaltet, im Bedienfenster mit Knöpfen.');
    const keys = [
      ['state', 'Sollwert', true],
      ['setStatus', 'Rückmeldung Sollwert (optional)', false],
      ['status', 'Ist-Temperatur (optional)', false],
      ['humidity', 'Luftfeuchte (optional)', false],
      ['mode', 'Betriebsart umschalten (optional)', true],
      ['modeStatus', 'Rückmeldung Betriebsart (optional)', false],
      ['heating', 'Heizt / Stellgröße % (optional)', false],
      ['window', 'Fenster (optional)', false],
    ];
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => Object.assign({ label: x.label.value.trim(), modes: x.modes.value.trim() }, ...keys.map(([k]) => ({ [k]: x[k].value.trim() }))));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name des Kreises', textInput(r.label));
        x.label.placeholder = 'z. B. Heizkörper, Warmwasser, Bad';
        for (const [k, label, w] of keys) {
          x[k] = stateField(b, label, r[k], w);
          // mode texts right after the mode data points: every circuit has its own numbers
          if (k === 'modeStatus') x.modes = field(b, 'Betriebsarten dieses Kreises (optional)', textInput(r.modes), 'Wert=Text; z. B. 0=Standby;1=Automatik;2=Normal – leer = Texte des Datenpunkts „Betriebsart umschalten“');
        }
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Kreis entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Kreis';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state || r.status || r.mode || r.modeStatus) };
  }

  /** More entries of a switch / blind / button tile (central functions, scenes): name + data points, chosen in the sheet. */
  function entriesField(box, rows, type) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, type === 'button' ? 'Weitere Einträge (z. B. Szenen)' : 'Weitere Einträge (z. B. Licht Zentral Aus, EG, OG …)', wrap,
      'Ein Tipp auf die Kachel öffnet eine Liste mit allen Einträgen, jeder mit eigenen Tasten. Die Einstellungen der Kachel (Umgekehrt, Auf/Ab umdrehen …) gelten für alle.');
    const keys = type === 'switch' ? [['state', 'Schalten', true], ['status', 'Rückmeldung (optional)', false]]
      : type === 'blind' ? [['state', 'Auf/Ab oder Position', true], ['stop', 'Stopp (optional)', true], ['status', 'Rückmeldung Position (optional)', false]]
        : [['state', 'Datenpunkt', true]];
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => {
      const o = { label: x.label.value.trim() };
      for (const [k] of keys) o[k] = x[k].value.trim();
      if (x.sendMode) o.sendMode = x.sendMode.value;
      if (x.value) o.value = x.value.value.trim();
      return o;
    });
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name', textInput(r.label));
        x.label.placeholder = type === 'button' ? 'z. B. Kino' : type === 'blind' ? 'z. B. Rollos EG' : 'z. B. Licht OG Zentral Aus';
        for (const [k, label, w] of keys) x[k] = stateField(b, label, r[k], w);
        if (type === 'switch') {
          x.sendMode = field(b, 'Senden', select([['', 'Ein = true, Aus = false (normal)'], ['true', 'immer nur true'], ['false', 'immer nur false'], ['push', 'Taster: drücken = true, loslassen = false']], r.sendMode || ''));
        }
        if (type === 'button') x.value = field(b, 'Wert', textInput(r.value), 'leer = true');
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const mk = (text, fn, cls) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          if (cls) btn.className = cls;
          btn.textContent = text;
          btn.onclick = () => {
            const cur = read();
            fn(cur);
            list.splice(0, list.length, ...cur);
            draw();
          };
          tools.appendChild(btn);
        };
        if (i > 0) mk('↑', cur => cur.splice(i - 1, 0, cur.splice(i, 1)[0]));
        if (i < list.length - 1) mk('↓', cur => cur.splice(i + 1, 0, cur.splice(i, 1)[0]));
        mk('Eintrag entfernen', cur => cur.splice(i, 1), 'danger');
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Eintrag';
      add.onclick = () => {
        const cur = read();
        // same kind of data point as the row before (e.g. all central objects of one actuator)
        const last = cur[cur.length - 1];
        cur.push({ label: '', sendMode: last ? last.sendMode : '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state) };
  }

  /** Values next to the clock (e.g. outside temperatures and humidity): name, data point, unit, decimals. */
  function headerField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Werte in der Kopfzeile neben der Uhr (Touch-PC)', wrap, 'z. B. mehrere Außentemperaturen und Außenfeuchten. Name optional (z. B. „Nord“), Einheit leer = vom Datenpunkt.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => {
      const o = { label: x.label.value.trim(), state: x.state.value.trim(), unit: x.unit.value.trim() };
      if (x.dec.value !== '') o.decimals = Number(x.dec.value);
      return o;
    });
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name (optional)', textInput(r.label));
        x.label.placeholder = 'z. B. Außen Nord';
        x.state = stateField(b, 'Datenpunkt', r.state, false);
        x.unit = field(b, 'Einheit (optional)', textInput(r.unit));
        x.unit.placeholder = 'z. B. °C oder %';
        x.dec = field(b, 'Nachkommastellen', select([['', 'automatisch'], ['0', '0'], ['1', '1'], ['2', '2']], r.decimals === undefined ? '' : String(r.decimals)));
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Wert entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Wert';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { get: () => read().filter(r => r.state) };
  }

  /** Rooms of a dehumidifier / air conditioner tile: name, humidity, temperature (read only, mean for the automatic). */
  /**
   * Garden picture for the GPS position: upload, then tap two places and give their coordinates (Google Maps: right
   * click -> the first line copies them). The mower's current position is offered, e.g. for the charging station.
   */
  function robotMapField(box, t) {
    const wrap = document.createElement('div');
    field(box, 'Gartenbild für GPS', wrap, 'Satelliten-Screenshot (z. B. Google Maps, Norden oben) oder Plan hochladen. Dann zwei weit auseinander liegende Stellen antippen und deren Koordinaten eingeben – z. B. die Ladestation (Mäher steht dort: Vorschlag übernehmen) und eine Hausecke (Google Maps: Rechtsklick auf die Stelle → oberste Zeile = Koordinaten kopiert).');
    let img = t.mapImg || '';
    let pts = (RobotLogic.parseCal(t.cal) || []).map(p => ({ ...p }));
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.hidden = true;
    const pick = document.createElement('button');
    pick.type = 'button';
    const info = document.createElement('div');
    info.className = 'muted';
    const frame = document.createElement('div');
    frame.className = 'robmap calib';
    const draw = () => {
      pick.textContent = img ? 'Anderes Bild wählen' : 'Bild wählen';
      frame.innerHTML = img ? '<img class="robimg" src="files/' + encodeURIComponent(img) + '" alt="">' + pts.map((p, i) => '<span class="robdot" style="left:' + p.x + '%;top:' + p.y + '%">' + (i + 1) + '</span>').join('') : '';
      info.textContent = !img ? 'Noch kein Bild.' : pts.length < 2 ? 'Jetzt Punkt ' + (pts.length + 1) + ' auf dem Bild antippen.' : 'Eingemessen (Punkt 1 und 2). Antippen setzt Punkt 1 neu.';
    };
    frame.addEventListener('click', ev => {
      const im = frame.querySelector('img');
      if (!im) return;
      const r = im.getBoundingClientRect();
      const x = Math.round(((ev.clientX - r.left) / r.width) * 1000) / 10;
      const y = Math.round(((ev.clientY - r.top) / r.height) * 1000) / 10;
      const gv = id => (id && SV.states[id] && SV.states[id].val !== null && SV.states[id].val !== '' ? Number(SV.states[id].val) : NaN);
      const cur = Number.isFinite(gv(t.lat)) && Number.isFinite(gv(t.lon)) ? gv(t.lat) + ', ' + gv(t.lon) : '';
      const txt = prompt('Koordinaten dieser Stelle (Breite, Länge) – z. B. 46.52, 14.30' + (cur ? '\nVorschlag = aktuelle Position des Mähers' : ''), cur);
      const m = /(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/.exec(txt || '');
      if (!m) return;
      const p = { x, y, lat: Number(m[1].replace(',', '.')), lon: Number(m[2].replace(',', '.')) };
      pts = pts.length >= 2 ? [p] : [...pts, p];
      draw();
    });
    file.onchange = async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      try {
        toast('Bild wird hochgeladen …');
        const res = await fetch('api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f, credentials: 'same-origin' });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || res.status);
        img = j.file;
        pts = [];
        draw();
      } catch (e) {
        toast('Hochladen fehlgeschlagen: ' + e.message, true);
      }
    };
    pick.onclick = () => file.click();
    wrap.append(pick, file, info, frame);
    draw();
    return {
      img: { type: 'custom', get: () => img },
      cal: { type: 'custom', get: () => (pts.length === 2 ? pts.map(p => p.x + ',' + p.y + '=' + p.lat + ',' + p.lon).join(';') : '') },
    };
  }

  /** list of data points (one picker per row, + adds one) */
  function stateListField(box, label, help, ids) {
    const wrap = document.createElement('div');
    field(box, label, wrap, help);
    const list = ids.slice();
    let inputs = [];
    const read = () => inputs.map(i => i.value.trim()).filter(Boolean);
    function draw() {
      wrap.textContent = '';
      inputs = list.map(id => stateField(wrap, '', id, true));
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Datenpunkt';
      add.onclick = () => {
        list.splice(0, list.length, ...read(), '');
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: read };
  }

  function sensorsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Räume (optional)', wrap, 'Luftfeuchte und Temperatur mehrerer Räume – im Bedienfenster einzeln und als Mittelwert, auf der Kachel der Mittelwert.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => ({ label: x.label.value.trim(), humidity: x.humidity.value.trim(), temp: x.temp.value.trim() }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name des Raums', textInput(r.label));
        x.label.placeholder = 'z. B. Keller';
        x.humidity = stateField(b, 'Luftfeuchte', r.humidity, false);
        x.temp = stateField(b, 'Temperatur (optional)', r.temp, false);
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Raum entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Raum';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.humidity || r.temp) };
  }

  /** More rooms of a radio tile: name + station data point, switched with ‹ › on the tile. */
  function radioRoomsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Weitere Räume', wrap, 'Auf der Kachel wird mit ‹ › umgeschaltet, im Bedienfenster mit Knöpfen. Pro Raum nur den Sender-Datenpunkt wählen.');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => ({ label: x.label.value.trim(), station: x.station.value.trim() }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name des Raums', textInput(r.label));
        x.label.placeholder = 'z. B. Terrasse';
        x.station = stateField(b, 'Sender-Datenpunkt', r.station, true);
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Raum entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Raum';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.station) };
  }

  /** More areas of an alarm tile: same fields as area 1, switched with ‹ › on the tile. */
  function alarmAreasField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Weitere Bereiche', wrap, 'Jeder Bereich mit eigenem Zustand und Befehl. Auf der Kachel wird mit ‹ › umgeschaltet, im Bedienfenster mit Knöpfen. Ein Alarm in einem anderen Bereich wird immer angezeigt.');
    const states = [
      ['status', 'Zustand', false],
      ['command', 'Befehl (optional)', true],
      ['alarm', 'Alarm (optional)', false],
      ['error', 'Fehlertext (optional)', false],
      ['ready', 'Scharfschaltbereit (optional)', false],
      ['openText', 'Offene Melder (optional)', false],
      ['alarmText', 'Ausgelöste Melder (optional)', false],
    ];
    const texts = [['area', 'Bereich aus NOX- oder SPC-Adapter (optional)', 'z. B. nox_alarmzentrale.0.areas.2 oder spc-edp.0.areas.2 – füllt die leeren Felder beim Übernehmen'], ['valueOff', 'Wert für „Unscharf“', 'NOX: 1'], ['valueArm', 'Wert für „Scharf“', 'NOX: 5'], ['valueHome', 'Wert für „Intern scharf“ (optional)', '']];
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => Object.assign({ label: x.label.value.trim() }, ...texts.map(([k]) => ({ [k]: x[k].value.trim() })), ...states.map(([k]) => ({ [k]: x[k].value.trim() }))));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name des Bereichs', textInput(r.label));
        x.label.placeholder = 'z. B. Garage';
        for (const [k, label, help] of texts) x[k] = field(b, label, k === 'area' ? areaSelect(r[k]) : textInput(r[k]), help || undefined);
        for (const [k, label, w] of states) x[k] = stateField(b, label, r[k], w);
        const tools = document.createElement('div');
        tools.className = 'buttons';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Bereich entfernen';
        del.onclick = () => {
          const cur = read();
          cur.splice(i, 1);
          list.splice(0, list.length, ...cur);
          draw();
        };
        tools.appendChild(del);
        b.appendChild(tools);
        rowInputs.push(x);
        wrap.appendChild(b);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Bereich';
      add.onclick = () => {
        const cur = read();
        cur.push({ label: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.status || r.command || r.area) };
  }

  // ---------------- tiles ----------------

  function addTile(page, pos) {
    const t = { id: newId(page.tiles, 't'), type: 'switch', label: '', size: '1', device: 'all' };
    if (pos) Object.assign(t, pos);
    editTile(page, t, true);
  }

  function editTile(page, original, isNew) {
    const t = clone(original);
    const isPlan = page.type === 'plan';
    const d = dialog(isNew ? (isPlan ? 'Symbol hinzufügen' : 'Kachel hinzufügen') : isPlan ? 'Symbol bearbeiten' : 'Kachel bearbeiten');
    const body = document.createElement('div');
    d.sh.appendChild(body);
    const inputs = {};

    function build() {
      body.textContent = '';
      for (const k of Object.keys(inputs)) delete inputs[k];
      if (isNew && SV.hk && SV.hk.instance) {
        const imp = document.createElement('button');
        imp.type = 'button';
        imp.className = 'hkimport';
        imp.textContent = 'Aus homekit-easy übernehmen …';
        imp.onclick = () => importHomekit(page, d.close);
        body.appendChild(imp);
      }
      const typeSel = field(body, 'Art', select(Object.entries(TYPE_LABELS).filter(([k]) => !(isPlan && (k === 'heading' || k === 'planview'))), t.type));
      typeSel.onchange = () => {
        collect();
        t.type = typeSel.value;
        build();
      };
      inputs.label = field(body, 'Beschriftung', textInput(t.label));
      for (const [key, label, kind, help] of TYPE_FIELDS[t.type]) {
        if (kind === 'state-w' || kind === 'state-r') inputs[key] = stateField(body, label, t[key], kind === 'state-w', help);
        else if (kind === 'reftile') {
          const opts = [['', '(Kachel wählen)']];
          for (const p of SV.draft.pages) {
            for (const x of p.tiles) {
              if (x.type === 'ref' || x.type === 'heading' || x === t) continue;
              opts.push([p.id + '/' + x.id, (x.label || TYPE_LABELS[x.type] || x.type) + ' – ' + p.name]);
            }
          }
          inputs[key] = field(body, label, select(opts, t[key] || ''), help);
        } else if (kind === 'fc20panel') fc20Field(body, t[key], label, help).then(s => (inputs[key] = s));
        else if (kind === 'firedev') fireDevField(body, t[key], label, help).then(s => (inputs[key] = s));
        else if (kind === 'extra') inputs[key] = extraField(body, t[key] || [], t.type);
        else if (kind === 'iconsel') {
          const opts = [['', 'Fenster-Symbol (Standard)']].concat(Object.keys(ICON_LABELS).map(n => [n, ICON_LABELS[n]]));
          inputs[key] = field(body, label, select(opts, t[key] || ''), help);
        }
        else if (kind === 'lighttiles' || kind === 'blindtiles') {
          const box = document.createElement('div');
          box.className = 'checks';
          const chosen = new Set(t[key] || []);
          const boxes = [];
          const want = kind === 'blindtiles' ? ['blind'] : ['switch', 'dimmer', 'color'];
          for (const p of SV.draft.pages) {
            for (const x of p.tiles.filter(y => want.includes(y.type))) {
              const c = check((x.label || x.state || x.id) + ' (' + p.name + ')', chosen.has(x.id));
              c.input.value = x.id;
              boxes.push(c.input);
              box.appendChild(c);
            }
          }
          if (!boxes.length) box.textContent = kind === 'blindtiles' ? 'Noch keine Rollladen-Kacheln.' : 'Noch keine Schalter- oder Dimmer-Kacheln.';
          field(body, label, box);
          inputs[key] = { type: 'custom', get: () => boxes.filter(i => i.checked).map(i => i.value) };
        } else if (kind === 'alarmtile') {
          const alarms = SV.draft.pages.flatMap(p => p.tiles.filter(x => x.type === 'alarm').map(x => [x.id, (x.label || 'Alarmanlage') + ' (' + p.name + ')' + (x.control ? '' : ' – Schalten nicht erlaubt')]));
          inputs[key] = field(body, label, select([['', '(nicht scharf schalten)']].concat(alarms), t[key] || ''), help);
        } else if (kind === 'cartile') {
          const cars = SV.draft.pages.flatMap(p => p.tiles.filter(x => x.type === 'car').map(x => [x.id, (x.label || 'Auto') + ' (' + p.name + ')']));
          inputs[key] = field(body, label, select([['', '(keine)']].concat(cars), t[key] || ''), help);
        } else if (kind === 'channels') {
          // which ways this tile's messages take (not set = all that are set up under "Allgemein")
          const ch = t[key] || { app: true, telegram: true, whatsapp: true };
          const row = document.createElement('div');
          row.className = 'chanrow';
          const boxes = {};
          for (const [k, txt] of [['app', 'App-Push'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp']]) {
            const c = check(txt, ch[k] !== false);
            row.appendChild(c);
            boxes[k] = c.input;
          }
          field(body, label, row, 'Nur was unter ⚙ Allgemein eingerichtet ist, kommt auch an.');
          inputs[key] = { type: 'custom', get: () => ({ app: boxes.app.checked, telegram: boxes.telegram.checked, whatsapp: boxes.whatsapp.checked }) };
        } else if (kind === 'alarmareas') {
          // areas of the alarm tile chosen just above; redrawn when that choice changes
          const wrap = document.createElement('div');
          wrap.className = 'checks';
          field(body, label, wrap, help);
          const picked = new Set(Array.isArray(t[key]) ? t[key] : []);
          const src = inputs.alarmArm || inputs.alarmOff;
          const draw = () => {
            const at = src && SV.draft.pages.flatMap(p => p.tiles).find(x => x.type === 'alarm' && x.id === src.value);
            wrap.textContent = '';
            const areas = at ? [at, ...(at.areas || [])] : [];
            wrap.parentElement && (wrap.previousElementSibling.style.display = wrap.style.display = areas.length > 1 ? '' : 'none');
            areas.forEach((a, i) => {
              const c = check(i === 0 ? at.areaLabel || at.label || 'Bereich 1' : a.label || 'Bereich ' + (i + 1), picked.has(i));
              c.input.dataset.idx = i;
              c.input.onchange = () => (c.input.checked ? picked.add(i) : picked.delete(i));
              wrap.appendChild(c);
            });
          };
          if (src) src.addEventListener('change', () => {
            picked.clear();
            draw();
          });
          draw();
          inputs[key] = { type: 'custom', get: () => [...picked].sort((x, y) => x - y) };
        } else if (kind === 'check') {
          // a new "Haus verlassen" tile starts with the lights ticked
          const c = check(label, t[key] === undefined && t.type === 'leave' && key === 'lightsOff' ? true : t[key]);
          body.appendChild(c);
          inputs[key] = c.input;
          if (help) {
            const h = document.createElement('div');
            h.className = 'help';
            h.textContent = help;
            body.appendChild(h);
          }
        } else if (kind === 'alarmarea') inputs[key] = field(body, label, areaSelect(t[key]), help);
        else if (kind === 'number') inputs[key] = field(body, label, textInput(t[key], 'number'), help);
        else if (kind.startsWith('select:')) {
          const opts = kind.slice(7).split(';').map(x => x.split('='));
          inputs[key] = field(body, label, select(opts, t[key] || opts[0][0]), help);
        } else if (kind === 'energy') energyField(body, t[key], t.type === 'wallbox' ? [label, help] : null).then(s => (inputs[key] = s));
        else if (kind === 'charger') chargerField(body, t[key], label, help).then(s => (inputs[key] = s));
        else if (kind === 'cardev') carField(body, t[key], label, help).then(s => (inputs[key] = s));
        else if (kind === 'robotdev') robotField(body, t[key], label, help, () => inputs.robotKind).then(s => (inputs[key] = s));
        else if (kind === 'camera') cameraField(body, t[key]).then(s => (inputs[key] = s));
        else if (kind === 'planpage') inputs[key] = field(body, label, select([['', '(wählen)']].concat(SV.draft.pages.filter(p => p.type === 'plan').map(p => [p.id, p.name])), t[key] || ''), 'Zuerst eine Seite der Art „Grundriss“ anlegen. Beschriftung leer = Name der Seite. In den Seiten-Einstellungen kann die Grundriss-Seite aus der Seitenleiste ausgeblendet werden.');
        else if (kind === 'page') inputs[key] = field(body, label, select([['', '(wählen)']].concat(SV.draft.pages.filter(p => p.id !== page.id).map(p => [p.id, p.name])), t[key] || ''), 'Beschriftung leer = Name der Seite');
        else if (kind === 'rows') inputs[key] = rowsField(body, t[key] || [{ label: '', state: '' }]);
        else if (kind === 'windows') inputs[key] = windowsField(body, t[key] || [{ label: '', state: '', tilt: '' }]);
        else if (kind === 'devices') inputs[key] = devicesField(body, t[key] || [{ label: '', kind: 'power', state: '', icon: 'washer' }]);
        else if (kind === 'circuits') inputs[key] = circuitsField(body, t[key] || []);
        else if (kind === 'entries') inputs[key] = entriesField(body, t[key] || [], t.type);
        else if (kind === 'areas') inputs[key] = alarmAreasField(body, t[key] || []);
        else if (kind === 'rooms') inputs[key] = radioRoomsField(body, t[key] || []);
        else if (kind === 'sensors') inputs[key] = sensorsField(body, t[key] || []);
        else if (kind === 'statelist') inputs[key] = stateListField(body, label, help, t[key] || []);
        else if (kind === 'robotmap') {
          const r = robotMapField(body, t);
          inputs.mapImg = r.img;
          inputs.cal = r.cal;
        }
        else inputs[key] = field(body, label, textInput(t[key]), help);
      }
      if (t.type !== 'heading') {
        const pick = iconField(body, t.icon || DEFAULT_ICON[t.type], name => (t.icon = name));
        // rotate the symbol (preview in the symbol list)
        const rot = field(body, 'Symbol drehen', select([0, 45, 90, 135, 180, 225, 270, 315].map(d => [String(d), d + '°']), String(t.rotate || 0)));
        const show = () => pick.style.setProperty('--rot', rot.value + 'deg');
        rot.addEventListener('change', show);
        show();
        inputs.rotate = { type: 'custom', get: () => Number(rot.value) };
      }
      if (page.type === 'plan' && t.type !== 'heading') {
        // layer (Gewerk) for the show/hide buttons on the plan; automatic = by type and symbol
        const auto = LAYERS.find(l => l[0] === tileLayer({ ...t, layer: '' }));
        inputs.layer = field(body, 'Ebene im Lageplan', select([['', 'automatisch (' + auto[1] + ')']].concat(LAYERS.map(l => [l[0], l[1]])), t.layer || ''), 'Für die Knöpfe oben am Lageplan, mit denen man z. B. Licht oder Jalousien ein- und ausblendet');
      }
      if (TYPE_FIELDS[t.type].some(f => f[2] === 'state-w')) inputs.pin = pinField(body, t);
      if (SV.hk && SV.hk.instance && SV.hk.choices[t.type]) inputs.homekit = homekitField(body, t);
      if (page.type === 'tiles' && t.type !== 'heading') {
        // own size: empty = default of the type; the grip ◢ on the tile does the same
        const def = freeSpan({ ...t, sw: 0, sh: 0 }, 12);
        const sizeRow = document.createElement('div');
        sizeRow.className = 'sizerow';
        body.appendChild(sizeRow);
        const opts = (n, d) => [['', 'Standard (' + d + ')']].concat(Array.from({ length: n }, (_, i) => [String(i + 1), String(i + 1)]));
        const sw = field(sizeRow, 'Breite (Spalten)', select(opts(6, def.w), t.sw ? String(t.sw) : ''));
        const sh = field(sizeRow, 'Höhe (Reihen)', select(opts(6, AUTO_H.includes(t.type) ? 'automatisch' : def.h), t.sh ? String(t.sh) : ''));
        inputs.sw = { type: 'custom', get: () => Number(sw.value) || undefined };
        inputs.sh = { type: 'custom', get: () => Number(sh.value) || undefined };
        const h = document.createElement('div');
        h.className = 'help';
        h.textContent = 'Oder im Bearbeiten-Modus am Griff ◢ unten rechts an der Kachel ziehen.';
        sizeRow.appendChild(h);
      }
      inputs.device = field(body, 'Anzeigen auf', select([['all', 'allen Geräten'], ['phone', 'nur Handy'], ['touch', 'nur Touch-PC / großem Bildschirm']], t.device || 'all'));

      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      if (!isNew) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Löschen';
        del.onclick = () => {
          if (!confirm('„' + (t.label || TYPE_LABELS[t.type]) + '“ löschen?')) return;
          page.tiles = page.tiles.filter(x => x.id !== original.id);
          d.close();
          render();
        };
        buttons.appendChild(del);
        if (!isPlan) {
          for (const [txt, dir] of [['◀', -1], ['▶', 1]]) {
            const mv = document.createElement('button');
            mv.type = 'button';
            mv.textContent = txt;
            mv.title = dir < 0 ? 'nach vorne' : 'nach hinten';
            mv.onclick = () => {
              const i = page.tiles.findIndex(x => x.id === original.id);
              const j = i + dir;
              if (i < 0 || j < 0 || j >= page.tiles.length) return;
              [page.tiles[i], page.tiles[j]] = [page.tiles[j], page.tiles[i]];
              render();
            };
            buttons.appendChild(mv);
          }
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Kopieren …';
        copy.onclick = () => {
          collect();
          d.close();
          copyDialog(page, t, original);
        };
        buttons.appendChild(copy);
      }
      const grow = document.createElement('span');
      grow.className = 'grow';
      buttons.appendChild(grow);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Abbrechen';
      cancel.onclick = d.close;
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'primary';
      ok.textContent = 'Übernehmen';
      ok.onclick = () => {
        collect();
        const i = page.tiles.findIndex(x => x.id === original.id);
        if (i >= 0) page.tiles[i] = t;
        else page.tiles.push(t);
        d.close();
        render();
      };
      buttons.appendChild(cancel);
      buttons.appendChild(ok);
      body.appendChild(buttons);
    }

    function collect() {
      for (const [key, input] of Object.entries(inputs)) {
        if (input.type === 'custom') t[key] = input.get();
        else if (input.type === 'checkbox') t[key] = input.checked;
        else if (input.type === 'number') t[key] = input.value === '' ? undefined : Number(input.value);
        else t[key] = input.value.trim();
      }
      if (!t.homekit) {
        delete t.homekit;
        delete t.hkId;
      }
    }
    build();
  }

  /** Copies of a tile: how many, onto which page, numbered labels. Same data points (change them afterwards). */
  function copyDialog(page, t, original) {
    const d = dialog('Kachel kopieren');
    const body = document.createElement('div');
    d.sh.appendChild(body);
    const count = field(body, 'Wie viele Kopien?', textInput('1'), '1 bis 30. Die Kopien haben dieselben Datenpunkte – danach je Kopie den Datenpunkt ändern.');
    count.type = 'number';
    count.min = 1;
    count.max = 30;
    const target = field(body, 'Auf Seite', select(SV.draft.pages.map(p => [p.id, p.name + (p.id === page.id ? ' (diese Seite)' : '')]), page.id));
    const numbered = check('Beschriftung fortlaufend nummerieren (z. B. Licht 2, Licht 3 …)', true);
    body.appendChild(numbered);
    // keep the original's changes made in the dialog before copying
    const i0 = page.tiles.findIndex(x => x.id === original.id);
    if (i0 >= 0) page.tiles[i0] = t;
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.onclick = d.close;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = 'Kopieren';
    ok.onclick = () => {
      const n = Math.max(1, Math.min(30, Math.round(Number(count.value)) || 1));
      const tp = SV.draft.pages.find(p => p.id === target.value) || page;
      // "Licht 3" -> Licht 4, 5 …; "Licht" -> Licht 2, 3 …
      const m = /^(.*?)(\s*)(\d+)$/.exec(t.label || '');
      const base = m ? m[1] : t.label || '';
      let num = m ? Number(m[3]) : 1;
      let at = tp === page ? page.tiles.findIndex(x => x.id === t.id) + 1 : tp.tiles.length;
      for (let k = 0; k < n; k++) {
        const c = clone(t);
        c.id = newId(tp.tiles, 't');
        delete c.hkId; // own HomeKit device
        delete c.gx; // free grid: the next free cell
        delete c.gy;
        if (c.pin === true) c.pinFrom = page.id + '/' + t.id; // same PIN as the original (set on the server)
        if (numbered.input.checked && base) c.label = base + (m ? m[2] || ' ' : ' ') + ++num;
        if (tp.type === 'plan') {
          // symbols side by side, a little apart
          const x0 = Number.isFinite(Number(t.x)) ? Number(t.x) : 10;
          const y0 = Number.isFinite(Number(t.y)) ? Number(t.y) : 10;
          c.x = Math.min(97, x0 + 4 * (k + 1));
          c.y = Math.min(97, y0 + (x0 + 4 * (k + 1) > 97 ? 4 : 0));
        } else {
          delete c.x;
          delete c.y;
        }
        tp.tiles.splice(at++, 0, c);
      }
      d.close();
      render();
      toast(n + (n === 1 ? ' Kopie' : ' Kopien') + ' auf „' + tp.name + '“ – Datenpunkte anpassen und Speichern nicht vergessen.');
    };
    buttons.append(grow, cancel, ok);
    body.appendChild(buttons);
  }

  // ---------------- pages ----------------

  function addPage() {
    const l = SV.draft;
    editPage({ id: newId(l.pages, 'p'), name: '', icon: 'home', type: 'tiles', tiles: [], image: '' }, true);
  }

  function editPage(original, isNew) {
    const l = SV.draft;
    const p = clone(original);
    const d = dialog(isNew ? 'Seite hinzufügen' : 'Seite bearbeiten');
    const body = document.createElement('div');
    d.sh.appendChild(body);
    const name = field(body, 'Name', textInput(p.name));
    name.placeholder = 'z. B. Erdgeschoss';
    // plan <-> tiles/list only while the page is empty (markers have positions, tiles don't)
    let kinds = [['tiles', 'Kacheln'], ['list', 'Liste (Zeilen mit EIN/AUS, wie beim Gira)'], ['plan', 'Grundriss (Bild mit Symbolen)']];
    if (!isNew && p.tiles.length) kinds = p.type === 'plan' ? kinds.slice(2) : kinds.slice(0, 2);
    const type = field(body, 'Art', select(kinds, p.type), 'Kacheln und Liste lassen sich jederzeit tauschen. Beim Grundriss lädst du ein Bild hoch und setzt Taster, Lichter, Kontakte usw. auf den Plan.');
    iconField(body, p.icon, n => (p.icon = n));
    // floor plan: how big the symbols are on the plan
    const msBox = document.createElement('div');
    body.appendChild(msBox);
    const ms = field(msBox, 'Symbolgröße auf dem Grundriss', select([['xs', 'sehr klein'], ['s', 'klein'], ['m', 'normal'], ['l', 'groß']], p.markerSize || 'm'), 'Für Lagepläne mit vielen Symbolen „klein“ oder „sehr klein“ wählen.');
    const hid = check('In der Seitenleiste ausblenden (z. B. Grundriss nur als Kachel verwenden)', p.hidden);
    body.appendChild(hid);
    // own phone order (set by moving tiles on the phone): can be dropped here
    const phr = p.phoneOrder && p.phoneOrder.length ? check('Eigene Handy-Reihenfolge zurücksetzen (Handy zeigt wieder die Reihenfolge des großen Bildschirms)', false) : null;
    if (phr) body.appendChild(phr);
    // tile page: free grid (place tiles anywhere, gaps allowed)
    const frBox = document.createElement('div');
    body.appendChild(frBox);
    const fr = check('Kacheln frei platzieren (Raster, Lücken möglich)', p.free);
    frBox.appendChild(fr);
    const colsBox = document.createElement('div');
    frBox.appendChild(colsBox);
    const cols = field(colsBox, 'Spalten im Raster', select([3, 4, 5, 6, 7, 8, 9, 10, 12].map(n => [String(n), String(n)]), String(p.cols || 6)), 'Im Bearbeiten-Modus Kachel auf ein leeres Feld oder auf eine andere Kachel ziehen (tauschen). Am Handy stehen die Kacheln einfach untereinander – ihre Reihenfolge dort lässt sich am Handy eigens verschieben.');
    // tile page: scaled to the screen (any browser / resolution looks the same)
    const fitBox = document.createElement('div');
    body.appendChild(fitBox);
    const fit = field(fitBox, 'An Bildschirm anpassen', select([['', 'nein (wie bisher)'], ['width', 'Breite – alles mitskalieren, senkrecht scrollen'], ['screen', 'Ganzer Bildschirm – alles sichtbar, kein Scrollen']], p.fit || ''), 'Die Seite wird für die Entwurfsbreite angeordnet und dann auf jedem Bildschirm gleichmäßig vergrößert oder verkleinert (auch Schrift und Symbole im Grundriss) – wie „Skalieren“ in VIS. Am Handy und im Bearbeiten-Modus wird nicht skaliert.');
    // only this device (localStorage, see app.js pageFit) or all devices (layout)
    let ownFit = null;
    try {
      ownFit = JSON.parse(localStorage.getItem('sv.fit.' + p.id) || 'null');
    } catch (e) {
      ownFit = null;
    }
    if (ownFit && ownFit.fit) fit.value = ownFit.fit === 'off' ? '' : ownFit.fit;
    const fitWhere = field(fitBox, 'Anpassen gilt für', select([['all', 'alle Geräte (außer Handy)'], ['device', 'nur dieses Gerät (dieser Browser)']], ownFit && ownFit.fit ? 'device' : 'all'), 'z. B. nur den Touch-PC anpassen und am großen PC-Monitor die normale Ansicht lassen. Pro Gerät geht es auch ohne Bearbeiten: Menü ⚙ → „… anpassen (dieses Gerät)“.');
    const dwBox = document.createElement('div');
    fitBox.appendChild(dwBox);
    const mainW = () => {
      const m = document.getElementById('main');
      const c = getComputedStyle(m);
      return Math.round(m.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight));
    };
    const dw = field(dwBox, 'Entwurfsbreite (Pixel)', textInput(p.designW || mainW(), 'number'), 'Breite, für die die Seite gestaltet ist – am besten die Breite des Hauptgeräts (z. B. Touch-PC).');
    const take = document.createElement('button');
    take.type = 'button';
    take.textContent = 'Breite dieses Bildschirms übernehmen';
    take.onclick = () => (dw.value = mainW());
    dwBox.appendChild(take);
    const showMs = () => {
      msBox.hidden = type.value !== 'plan';
      frBox.hidden = type.value !== 'tiles';
      colsBox.hidden = !fr.input.checked;
      dwBox.hidden = !fit.value;
    };
    fit.addEventListener('change', showMs);
    type.addEventListener('change', showMs);
    fr.input.addEventListener('change', showMs);
    showMs();
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    if (!isNew) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Seite löschen';
      del.onclick = () => {
        if (!confirm('Seite „' + p.name + '“ mit allen Kacheln löschen?')) return;
        l.pages = l.pages.filter(x => x.id !== p.id);
        d.close();
        render();
      };
      buttons.appendChild(del);
      for (const [txt, dir] of [['▲', -1], ['▼', 1]]) {
        const mv = document.createElement('button');
        mv.type = 'button';
        mv.textContent = txt;
        mv.onclick = () => {
          const i = l.pages.findIndex(x => x.id === p.id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= l.pages.length) return;
          [l.pages[i], l.pages[j]] = [l.pages[j], l.pages[i]];
          render();
        };
        buttons.appendChild(mv);
      }
    }
    const grow = document.createElement('span');
    grow.className = 'grow';
    buttons.appendChild(grow);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.onclick = d.close;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = 'Übernehmen';
    ok.onclick = () => {
      p.name = name.value.trim() || 'Seite';
      p.type = type.value;
      p.markerSize = ms.value;
      p.hidden = hid.input.checked;
      p.free = type.value === 'tiles' && fr.input.checked;
      p.designW = Math.round(Number(dw.value)) || mainW();
      if (fitWhere.value === 'device') {
        // only here: remembered in this browser, the page itself keeps no fit for the other devices
        try {
          localStorage.setItem('sv.fit.' + p.id, JSON.stringify({ fit: fit.value || 'off', designW: p.designW }));
        } catch (e) {
          // private mode
        }
        p.fit = '';
      } else {
        try {
          localStorage.removeItem('sv.fit.' + p.id);
        } catch (e) {
          // ignore
        }
        p.fit = fit.value;
      }
      p.cols = Number(cols.value);
      if (phr && phr.input.checked) delete p.phoneOrder;
      const i = l.pages.findIndex(x => x.id === p.id);
      const cur = i >= 0 ? l.pages[i] : null;
      const next = { ...p, tiles: cur ? cur.tiles : [], image: cur ? cur.image : '' };
      if (i >= 0) l.pages[i] = next;
      else l.pages.push(next);
      d.close();
      location.hash = encodeURIComponent(p.id);
      render();
    };
    buttons.appendChild(cancel);
    buttons.appendChild(ok);
    body.appendChild(buttons);
    name.focus();
  }

  // ---------------- floor plan ----------------

  function planTools(page) {
    const bar = document.createElement('div');
    bar.className = 'plantools';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/svg+xml,image/webp,image/gif,application/pdf,.pdf';
    file.hidden = true;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = page.image ? 'Anderes Bild wählen' : 'Bild wählen';
    pick.onclick = () => file.click();
    file.onchange = async () => {
      let f = file.files[0];
      file.value = '';
      if (!f) return;
      let name = f.name;
      try {
        if (/\.pdf$/i.test(name) || f.type === 'application/pdf') {
          toast('PDF wird in ein Bild umgewandelt …');
          f = await pdfToPng(f);
          if (!f) return;
          name = name.replace(/\.pdf$/i, '') + '.png';
        }
        if (f.size > 20e6) return toast('Bild ist zu groß (max. 20 MB)', true);
        toast('Bild wird hochgeladen …');
        const res = await fetch('api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: f, credentials: 'same-origin' });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || res.status);
        page.image = j.file;
        toast('Bild übernommen – jetzt auf den Plan tippen, um Symbole zu setzen');
        render();
      } catch (e) {
        toast('Hochladen fehlgeschlagen: ' + e.message, true);
      }
    };
    bar.appendChild(pick);
    bar.appendChild(file);
    if (page.image) bar.appendChild(fireAllButton(page));
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = page.image ? 'Auf den Plan tippen = Symbol setzen · Symbol ziehen = verschieben · Symbol antippen = bearbeiten' : 'PNG, JPG, SVG oder PDF (z. B. der Plan vom Architekten) – PDFs werden automatisch in ein Bild umgewandelt';
    bar.appendChild(hint);
    return bar;
  }

  /** floor plan: one symbol per detector / sounder of the FC20 that is not on this plan yet, in rows at the top left */
  function fireAllButton(page) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '🔥 Alle Brandmelder hinzufügen';
    b.title = 'Legt für jeden Melder und Sounder der Brandmeldezentrale (FC20-Adapter) ein Symbol an – danach an ihren Platz ziehen';
    b.onclick = async () => {
      let list = [];
      try {
        list = (await api('energy')).fireDevs || [];
      } catch (e) {
        // ignore
      }
      if (!list.length) return toast('Keine Melder gefunden – FC20-Adapter installiert und verbunden?', true);
      const have = new Set(page.tiles.map(t => t.fireSrc).filter(Boolean));
      const add = list.filter(d => !have.has(d.id));
      if (!add.length) return toast('Alle Melder sind schon auf diesem Plan');
      if (!confirm(add.length + ' Symbole für Brandmelder / Sounder hinzufügen? Sie stehen danach oben links und werden an ihren Platz gezogen.')) return;
      add.forEach((d, i) => {
        page.tiles.push({
          id: newId(page.tiles, 't'), type: 'firedet', label: d.label, fireSrc: d.id, fdAuto: d.kind, layer: 'brand', size: '1', device: 'all',
          x: 4 + (i % 12) * 7.5, y: 5 + Math.floor(i / 12) * 9,
        });
      });
      render();
      toast(add.length + ' Symbole hinzugefügt – an ihren Platz ziehen und dann Speichern');
    };
    return b;
  }

  /**
   * PDF (e.g. the architect's plan) -> PNG in the browser with pdf.js: choose the page, render it
   * sharp (about 3000 px, below the canvas limit of iPhones) and cut away white margins.
   */
  async function pdfToPng(file) {
    let pdfjs;
    try {
      pdfjs = await import('./vendor/pdf.min.mjs');
    } catch (e) {
      throw new Error('PDF-Unterstützung kann in diesem Browser nicht geladen werden – bitte als PNG speichern');
    }
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let n = 1;
    if (doc.numPages > 1) {
      const a = prompt('Die PDF hat ' + doc.numPages + ' Seiten. Auf welcher Seite ist der Grundriss? (1–' + doc.numPages + ')', '1');
      if (a === null) return null;
      n = Math.min(doc.numPages, Math.max(1, parseInt(a, 10) || 1));
    }
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const long = Math.max(base.width, base.height);
    let scale = 3000 / long;
    // at most ~16 million pixels (iOS canvas limit)
    scale = Math.min(scale, Math.sqrt(16e6 / (base.width * base.height)));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const out = trimWhite(canvas);
    doc.destroy();
    return new Promise((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error('Umwandeln fehlgeschlagen'))), 'image/png'));
  }

  /** Cut away white margins (with a little border left). */
  function trimWhite(canvas) {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return canvas;
    const pad = Math.round(Math.max(w, h) * 0.015);
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad);
    y1 = Math.min(h - 1, y1 + pad);
    if (x1 - x0 > w * 0.97 && y1 - y0 > h * 0.97) return canvas;
    const c = document.createElement('canvas');
    c.width = x1 - x0 + 1;
    c.height = y1 - y0 + 1;
    c.getContext('2d').drawImage(canvas, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  function planClick(e, page, plan) {
    if (e.target.closest('.marker')) return;
    const r = plan.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
    const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
    addTile(page, { x, y });
  }

  // ---------------- move tiles and list rows by dragging ----------------

  let droppedAt = 0;

  /** true right after a drag ended: the click that follows must not open the tile dialog */
  function justDragged() {
    return Date.now() - droppedAt < 300;
  }

  /** Scrolling ancestor of an element (#main, side panel or the page). */
  function scroller(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  }

  /**
   * Reorder the children `selector` of `box` by dragging; the new order is written to page.tiles.
   * Mouse: drag after a few pixels. Touch: hold ~0.35 s, then drag (a quick swipe still scrolls).
   */
  function sortable(box, page, selector) {
    let drag = null;

    const begin = (el, x, y) => {
      const r = el.getBoundingClientRect();
      drag = { el, off: { x: x - r.left, y: y - r.top }, scroll: scroller(box), x, y };
      box.classList.add('sorting');
      el.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(15);
      place();
      drag.timer = setInterval(autoScroll, 30);
    };

    const place = () => {
      const { el, off, x, y } = drag;
      el.style.transform = '';
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${x - off.x - r.left}px, ${y - off.y - r.top}px)`;
    };

    const free = box.classList.contains('free');

    const moveTo = (x, y) => {
      drag.x = x;
      drag.y = y;
      const hit = document.elementFromPoint(x, y);
      if (free) {
        // free grid: an empty cell or another tile (they swap places)
        const over = hit && (hit.closest('.cell') || hit.closest(selector));
        const target = over && over !== drag.el && over.parentElement === box ? over : null;
        if (target !== drag.target) {
          if (drag.target) drag.target.classList.remove('over');
          if (target) target.classList.add('over');
          drag.target = target;
        }
        place();
        return;
      }
      const target = hit && hit.closest(selector);
      if (target && target !== drag.el && target.parentElement === box) {
        const items = [...box.querySelectorAll(selector)];
        box.insertBefore(drag.el, items.indexOf(target) < items.indexOf(drag.el) ? target : target.nextSibling);
      }
      place();
    };

    // near the top or bottom edge the page scrolls along
    const autoScroll = () => {
      const s = drag.scroll;
      const r = s === document.scrollingElement ? { top: 0, bottom: innerHeight } : s.getBoundingClientRect();
      const dy = drag.y < r.top + 60 ? -12 : drag.y > r.bottom - 60 ? 12 : 0;
      if (!dy) return;
      s.scrollTop += dy;
      moveTo(drag.x, drag.y);
    };

    const finish = () => {
      if (!drag) return;
      clearInterval(drag.timer);
      if (free) {
        const t = page.tiles.find(x => x.id === drag.el.dataset.tile);
        const target = drag.target;
        drag = null;
        droppedAt = Date.now();
        if (t && target) {
          const cols = Number(box.dataset.cols) || 6;
          if (target.classList.contains('cell')) {
            t.gx = Math.min(Number(target.dataset.gx), cols - freeSpan(t, cols).w + 1);
            t.gy = Number(target.dataset.gy);
          } else {
            const o = page.tiles.find(x => x.id === target.dataset.tile);
            if (o) [t.gx, t.gy, o.gx, o.gy] = [o.gx, o.gy, t.gx, t.gy];
          }
          // tiles in the way get the next free place
          layoutFree(page.tiles, cols, t.id);
          toast('Verschoben – „Speichern“ nicht vergessen.');
        }
        render();
        return;
      }
      const ids = [...box.querySelectorAll(selector)].map(el => el.dataset.tile);
      drag = null;
      droppedAt = Date.now();
      if (box.dataset.phone) {
        // phone: own order, the big screens keep theirs (hidden tiles of other devices stay at their place)
        const shown = new Set(ids);
        const prev = byPhoneOrder(page.free ? page.tiles.slice().sort((a, b) => a.gy - b.gy || a.gx - b.gx) : page.tiles, page).map(t => t.id);
        let k = 0;
        const next = prev.map(id => (shown.has(id) ? ids[k++] : id));
        if (next.join() !== prev.join()) {
          page.phoneOrder = next;
          toast('Reihenfolge am Handy geändert – „Speichern“ nicht vergessen. Am großen Bildschirm bleibt alles, wie es ist.');
        }
        render();
        return;
      }
      const old = page.tiles.map(t => t.id).join();
      page.tiles.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      if (page.tiles.map(t => t.id).join() !== old) toast('Reihenfolge geändert – „Speichern“ nicht vergessen.');
      render();
    };

    // mouse and pen
    // size grip ◢: columns / rows follow the pointer, cell by cell
    box.addEventListener('pointerdown', e => {
      const h = e.target.closest('.sizeh');
      if (!h || e.button !== 0) return;
      const el = h.closest(selector);
      if (!el || el.parentElement !== box) return;
      const t = page.tiles.find(x => x.id === el.dataset.tile);
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const cs = getComputedStyle(box);
      const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean).map(parseFloat);
      const cols = tracks.length || 1;
      const gap = parseFloat(cs.columnGap) || 12;
      const colW = tracks[0] || 150;
      const rowH = parseFloat(cs.getPropertyValue('--th')) || 132;
      const r = el.getBoundingClientRect();
      const free = box.classList.contains('free');
      let w = 0;
      let hh = 0;
      el.classList.add('resizing');
      const move = ev => {
        ev.preventDefault();
        w = Math.max(1, Math.min(cols, Math.round((ev.clientX - r.left + gap) / (colW + gap))));
        hh = Math.max(1, Math.min(8, Math.round((ev.clientY - r.top + gap) / (rowH + gap))));
        sizeTile(el, { ...t, sh: hh }, w, hh, free);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        droppedAt = Date.now();
        if (w && hh) {
          t.sw = w;
          t.sh = hh;
          if (free) layoutFree(page.tiles, Number(box.dataset.cols) || 6, t.id);
          toast('Größe ' + w + ' × ' + hh + ' – „Speichern“ nicht vergessen.');
        }
        render();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });

    box.addEventListener('pointerdown', e => {
      if (e.target.closest('.sizeh')) return;
      // the grip ⠿ works for every pointer at once; elsewhere touch uses the long press below
      const grip = e.target.closest('.dragh');
      if ((e.pointerType === 'touch' && !grip) || e.button !== 0) return;
      const el = e.target.closest(selector);
      if (!el || el.parentElement !== box) return;
      const sx = e.clientX;
      const sy = e.clientY;
      if (grip) {
        e.preventDefault();
        begin(el, sx, sy);
      }
      const move = ev => {
        if (!drag) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 8) return;
          begin(el, sx, sy);
        }
        ev.preventDefault();
        moveTo(ev.clientX, ev.clientY);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        finish();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });

    // touch: long press starts the drag, otherwise the finger scrolls as usual
    box.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || e.target.closest('.dragh, .sizeh')) return;
      const el = e.target.closest(selector);
      if (!el || el.parentElement !== box) return;
      const t0 = e.touches[0];
      const sx = t0.clientX;
      const sy = t0.clientY;
      let last = { x: sx, y: sy };
      const hold = setTimeout(() => begin(el, last.x, last.y), 350);
      const move = ev => {
        const t = ev.touches[0];
        last = { x: t.clientX, y: t.clientY };
        if (!drag) {
          if (Math.abs(last.x - sx) + Math.abs(last.y - sy) > 10) end();
          return;
        }
        ev.preventDefault();
        moveTo(last.x, last.y);
      };
      const end = () => {
        clearTimeout(hold);
        removeEventListener('touchmove', move);
        removeEventListener('touchend', end);
        removeEventListener('touchcancel', end);
        finish();
      };
      addEventListener('touchmove', move, { passive: false });
      addEventListener('touchend', end);
      addEventListener('touchcancel', end);
    }, { passive: true });

    // no native drag of pictures (it would cancel the move)
    box.addEventListener('dragstart', e => e.preventDefault());

    // no context menu / text selection from the long press
    box.addEventListener('contextmenu', e => {
      if (e.target.closest(selector)) e.preventDefault();
    });
  }

  function markerDown(e, page, t, el) {
    e.preventDefault();
    e.stopPropagation();
    const plan = el.parentElement;
    const r = plan.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6) moved = true;
      if (!moved) return;
      const x = Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100));
      const y = Math.min(100, Math.max(0, ((ev.clientY - r.top) / r.height) * 100));
      el.style.left = x + '%';
      el.style.top = y + '%';
      t.x = Math.round(x * 10) / 10;
      t.y = Math.round(y * 10) / 10;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) editTile(page, t);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ---------------- general settings, doorbell, push rules ----------------

  function settings() {
    const l = SV.draft;
    const d = dialog('Allgemein & Mitteilungen');
    const body = document.createElement('div');
    d.sh.appendChild(body);
    const title = field(body, 'Titel', textInput(l.title));
    const theme = field(body, 'Design', select([['dark', 'Dunkel'], ['light', 'Hell'], ['auto', 'wie das Gerät']], l.theme));

    const h0 = document.createElement('h3');
    h0.textContent = 'Darstellung (optional)';
    h0.style.marginTop = '22px';
    body.appendChild(h0);
    const showDate = check('Datum in der Kopfzeile anzeigen (Touch-PC)', l.showDate);
    body.appendChild(showDate);
    const header = headerField(body, l.header || []);
    const hideNav = check('Seitenleiste ausblenden – Navigation nur über „Seite öffnen“-Kacheln und „zurück“', l.hideNav);
    body.appendChild(hideNav);
    const hn = document.createElement('div');
    hn.className = 'help';
    hn.textContent = 'Wie ein Menü: die erste Seite enthält „Seite öffnen“-Kacheln für die Bereiche, „zurück“ führt immer zur ersten Seite.';
    body.appendChild(hn);
    const sideOn = check('Geteilter Bildschirm am Touch-PC: rechts feste Bereiche mit Reitern', l.side.enabled);
    body.appendChild(sideOn);
    const sideBox = document.createElement('div');
    body.appendChild(sideBox);
    const sideChecks = { top: [], bottom: [] };
    for (const [key, label] of [['top', 'Rechts oben (z. B. Kameras, Photovoltaik)'], ['bottom', 'Rechts unten (z. B. Wetterstation)']]) {
      const lab = document.createElement('label');
      lab.textContent = label;
      sideBox.appendChild(lab);
      for (const p of l.pages) {
        const c = check(p.name, l.side[key].includes(p.id));
        c.input.value = p.id;
        sideBox.appendChild(c);
        sideChecks[key].push(c.input);
      }
    }
    const sh = document.createElement('div');
    sh.className = 'help';
    sh.textContent = 'Die gewählten Seiten erscheinen am Touch-PC rechts als Reiter (nicht mehr in der Seitenleiste). Am Handy bleiben sie normale Seiten.';
    sideBox.appendChild(sh);
    const showSide = () => {
      sideBox.hidden = !sideOn.input.checked;
    };
    sideOn.input.onchange = showSide;
    showSide();

    const h1 = document.createElement('h3');
    h1.textContent = 'Klingel';
    h1.style.marginTop = '22px';
    body.appendChild(h1);
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = 'Wenn der Datenpunkt „läutet“ ein wird, zeigt SmartView die Kamera groß – mit „Tür öffnen“. Beim livecam-Adapter: livecam.0.intercom.ringing und livecam.0.intercom.openDoor.';
    body.appendChild(help);
    // door intercom of the livecam adapter: ring tone, answering, call list
    const icSel = field(body, 'Sprechstelle (livecam-Adapter)', select([['', 'keine – nur Kamerabild beim Läuten']], l.ring.intercom || ''),
      'Mit Sprechstelle: Klingelton, Abheben/Sprechen, Tür öffnen und Anrufliste wie an der Kamerawand. Die Felder darunter braucht es dann nicht (Kamera = Ersatz, falls die Sprechstelle keine meldet).');
    api('cameras').then(list => {
      for (const inst of [...new Set(list.map(c => c.id.split('.').slice(0, 2).join('.')))]) {
        const o = document.createElement('option');
        o.value = inst;
        o.textContent = inst;
        icSel.appendChild(o);
      }
      icSel.value = l.ring.intercom || '';
    }).catch(() => {});
    const ringState = stateField(body, 'Läutet (Datenpunkt)', l.ring.state, false);
    if (!l.ring.state) ringState.placeholder = 'livecam.0.intercom.ringing';
    let ringCam = null;
    cameraField(body, l.ring.camera).then(s => (ringCam = s));
    const door = stateField(body, 'Tür öffnen (optional)', l.ring.door, true);
    if (!l.ring.door) door.placeholder = 'livecam.0.intercom.openDoor';
    const dndFrom = field(body, 'Nicht stören automatisch von (HH:MM, optional)', textInput(l.ring.dndFrom), 'Kein Klingelton in dieser Zeit, z. B. 22:00 bis 07:00 – das Bild erscheint trotzdem. Jederzeit auch über ⚙ → „Nicht stören“ oder den Datenpunkt smartview.0.ring.dnd.');
    dndFrom.placeholder = '22:00';
    const dndTo = field(body, 'bis (HH:MM)', textInput(l.ring.dndTo));
    dndTo.placeholder = '07:00';
    const dndQuiet = check('Während „Nicht stören“ auch keine Klingel-Mitteilungen (Telegram / WhatsApp)', l.ring.dndQuiet);
    body.appendChild(dndQuiet);

    const h2 = document.createElement('h3');
    h2.textContent = 'Mitteilungen (Push)';
    h2.style.marginTop = '22px';
    body.appendChild(h2);
    const help2 = document.createElement('div');
    help2.className = 'help';
    help2.textContent = 'Eine Mitteilung wird gesendet, wenn die Bedingung eintritt (nicht wiederholt, solange sie erfüllt bleibt). {value} im Text = aktueller Wert. Empfangen: am Gerät im Menü ⚙ „Mitteilungen aktivieren“.';
    body.appendChild(help2);
    // messengers (telegram / whatsapp-cmb adapter): for phones where no certificate may be installed
    function messenger(o) {
      const cfg = o.cfg;
      const sel = field(body, o.label, select([['', 'nein']], cfg.instance || ''), o.help);
      const box = document.createElement('div');
      body.appendChild(box);
      const who = field(box, o.whoLabel, textInput(cfg[o.whoKey]), o.whoHelp);
      const ring = check(o.ringLabel, cfg.ring);
      box.appendChild(ring);
      const test = document.createElement('button');
      test.type = 'button';
      test.textContent = o.name + ' testen';
      test.style.marginTop = '8px';
      test.onclick = async () => {
        try {
          const r = await api(o.api + '/test', { method: 'POST', body: '{}' });
          toast(r.sent === null ? o.name + '-Adapter antwortet nicht – läuft er?' : r.sent ? 'An ' + o.name + ' gesendet' : o.failed, !r.sent);
        } catch (e) {
          toast(e.message, true);
        }
      };
      box.appendChild(test);
      let saved = cfg.instance || '';
      const show = () => {
        box.hidden = !sel.value && !saved;
      };
      sel.addEventListener('change', () => {
        saved = '';
        show();
      });
      api(o.api).then(r => {
        for (const inst of r.instances) {
          const opt = document.createElement('option');
          opt.value = inst;
          opt.textContent = inst;
          sel.appendChild(opt);
        }
        if (cfg.instance && !r.instances.includes(cfg.instance)) {
          const opt = document.createElement('option');
          opt.value = cfg.instance;
          opt.textContent = cfg.instance + ' (nicht gefunden)';
          sel.appendChild(opt);
        }
        sel.value = cfg.instance || '';
        show();
      }).catch(() => {});
      show();
      return () => ({ instance: sel.value, [o.whoKey]: who.value.trim(), ring: ring.input.checked });
    }
    const tgGet = messenger({
      name: 'Telegram',
      api: 'telegram',
      cfg: l.telegram || { instance: '', users: '', ring: false },
      label: 'Auch über Telegram senden',
      help: 'Braucht den Telegram-Adapter in ioBroker (Bot von @BotFather, im Telegram-Chat mit dem Bot einmal /start und dann „/password <Passwort>“ senden). Gut für Handys, auf denen kein Zertifikat installiert werden darf.',
      whoKey: 'users',
      whoLabel: 'Telegram-Empfänger (optional)',
      whoHelp: 'Vorname oder Telegram-Benutzername, mehrere mit Komma. Leer = alle, die beim Bot angemeldet sind.',
      ringLabel: 'Beim Läuten ein Foto der Klingel-Kamera per Telegram senden',
      failed: 'Nicht gesendet – beim Bot zuerst /start senden',
    });
    const waGet = messenger({
      name: 'WhatsApp',
      api: 'whatsapp',
      cfg: l.whatsapp || { instance: '', phone: '', ring: false },
      label: 'Auch über WhatsApp senden',
      help: 'Braucht den Adapter whatsapp-cmb (CallMeBot) mit API-Key. Nur Text, keine Bilder.',
      whoKey: 'phone',
      whoLabel: 'WhatsApp-Nummer (optional)',
      whoHelp: 'z. B. +43664…; leer = die Nummer aus der whatsapp-cmb-Instanz.',
      ringLabel: 'Beim Läuten „Es läutet“ per WhatsApp senden',
      failed: 'Nicht gesendet – API-Key und Nummer in whatsapp-cmb prüfen (Log)',
    });

    const rulesBox = document.createElement('div');
    rulesBox.className = 'rules';
    body.appendChild(rulesBox);
    const rules = clone(l.push);
    const ruleInputs = [];

    function drawRules() {
      rulesBox.textContent = '';
      ruleInputs.length = 0;
      rules.forEach((r, i) => {
        const box = document.createElement('div');
        box.className = 'rule';
        const head = document.createElement('div');
        head.className = 'head';
        const en = check('aktiv', r.enabled);
        head.appendChild(en);
        const grow = document.createElement('span');
        grow.className = 'grow';
        head.appendChild(grow);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Entfernen';
        del.onclick = () => {
          collectRules();
          rules.splice(i, 1);
          drawRules();
        };
        head.appendChild(del);
        box.appendChild(head);
        const inp = { enabled: en.input };
        inp.state = stateField(box, 'Datenpunkt', r.state, false);
        inp.cond = field(box, 'Wenn', select([['true', 'Ein / true wird'], ['false', 'Aus / false wird'], ['eq', 'gleich Wert wird'], ['ne', 'ungleich Wert wird'], ['gt', 'größer als Wert wird'], ['lt', 'kleiner als Wert wird'], ['change', 'sich ändert (jedes Mal)']], r.cond));
        inp.value = field(box, 'Wert (für gleich/größer/kleiner)', textInput(r.value));
        // "länger als": the condition has to hold this long without interruption
        const delayBox = document.createElement('div');
        box.appendChild(delayBox);
        inp.delay = field(delayBox, 'länger als (Minuten)', textInput(r.delay || '', 'number'), '0 oder leer = sofort. Sonst erst, wenn es so lange ununterbrochen gilt, z. B. Fenster länger als 15 Minuten offen.');
        inp.delay.min = '0';
        // optional second condition
        const andOn = check('und zusätzlich wenn …', Boolean(r.and));
        box.appendChild(andOn);
        const andBox = document.createElement('div');
        andBox.className = 'andbox';
        box.appendChild(andBox);
        const a = r.and || { state: '', cond: 'true', value: '' };
        inp.and = {
          on: andOn.input,
          state: stateField(andBox, 'Datenpunkt', a.state, false),
          cond: field(andBox, 'ist', select([['true', 'Ein / true'], ['false', 'Aus / false'], ['eq', 'gleich Wert'], ['ne', 'ungleich Wert'], ['gt', 'größer als Wert'], ['lt', 'kleiner als Wert']], a.cond)),
          value: field(andBox, 'Wert', textInput(a.value)),
        };
        const showRule = () => {
          andBox.hidden = !andOn.input.checked;
          delayBox.hidden = inp.cond.value === 'change';
        };
        andOn.input.addEventListener('change', showRule);
        inp.cond.addEventListener('change', showRule);
        showRule();
        inp.title = field(box, 'Titel', textInput(r.title));
        inp.title.placeholder = 'z. B. Alarm Garage';
        inp.text = field(box, 'Text', textInput(r.text));
        inp.text.placeholder = 'z. B. Tor ist seit 10 Minuten offen ({value})';
        inp.page = field(box, 'Beim Antippen öffnen', select([['', 'Startseite']].concat(SV.draft.pages.map(p => [p.id, p.name])), r.page || ''));
        const ch = r.channels || { app: true, telegram: true, whatsapp: true };
        const lab = document.createElement('label');
        lab.textContent = 'Senden an';
        box.appendChild(lab);
        const row = document.createElement('div');
        row.className = 'chanrow';
        inp.channels = {};
        for (const [k, t] of [['app', 'App'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp']]) {
          const c = check(t, ch[k]);
          row.appendChild(c);
          inp.channels[k] = c.input;
        }
        box.appendChild(row);
        ruleInputs.push(inp);
        rulesBox.appendChild(box);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Mitteilung';
      add.onclick = () => {
        collectRules();
        rules.push({ id: newId(rules, 'r'), enabled: true, state: '', cond: 'true', value: '', title: '', text: '', page: '', channels: { app: true, telegram: true, whatsapp: true } });
        drawRules();
      };
      rulesBox.appendChild(add);
    }

    function collectRules() {
      ruleInputs.forEach((inp, i) => {
        const and = inp.and.on.checked && inp.and.state.value.trim() ? { state: inp.and.state.value.trim(), cond: inp.and.cond.value, value: inp.and.value.value } : null;
        rules[i] = { ...rules[i], enabled: inp.enabled.checked, state: inp.state.value.trim(), cond: inp.cond.value, value: inp.value.value, delay: Number(inp.delay.value) || 0, and, title: inp.title.value, text: inp.text.value, page: inp.page.value, channels: { app: inp.channels.app.checked, telegram: inp.channels.telegram.checked, whatsapp: inp.channels.whatsapp.checked } };
      });
    }
    drawRules();

    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const grow = document.createElement('span');
    grow.className = 'grow';
    buttons.appendChild(grow);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.onclick = d.close;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = 'Übernehmen';
    ok.onclick = () => {
      collectRules();
      l.title = title.value.trim() || 'SmartView';
      l.theme = theme.value;
      l.showDate = showDate.input.checked;
      l.header = header.get();
      l.hideNav = hideNav.input.checked;
      l.side = {
        enabled: sideOn.input.checked,
        top: sideChecks.top.filter(i => i.checked).map(i => i.value),
        bottom: sideChecks.bottom.filter(i => i.checked).map(i => i.value),
      };
      l.ring = {
        state: ringState.value.trim(),
        camera: ringCam ? ringCam.value : l.ring.camera,
        door: door.value.trim(),
        intercom: icSel.value,
        dndFrom: dndFrom.value.trim(),
        dndTo: dndTo.value.trim(),
        dndQuiet: dndQuiet.input.checked,
      };
      l.push = rules;
      l.telegram = tgGet();
      l.whatsapp = waGet();
      d.close();
      render();
    };
    buttons.appendChild(cancel);
    buttons.appendChild(ok);
    body.appendChild(buttons);
  }

  $('editCancel').onclick = cancel;
  $('editSave').onclick = save;
  $('layoutSettings').onclick = settings;
  window.addEventListener('beforeunload', e => {
    if (SV.editing && changed()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  return { start, addTile, editTile, addPage, editPage, planTools, planClick, markerDown, sortable, justDragged };
})();
