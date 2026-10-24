'use strict';

/* Edit mode: pages, tiles, floor plan markers (tap to add, drag to move), doorbell and push rules. */

const TYPE_LABELS = {
  switch: 'Schalter / Taster (Ein/Aus)',
  dimmer: 'Dimmer',
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
  heading: 'Überschrift',
  energy: 'Energiefluss (PV, Netz, Batterie – Adapter energie)',
  gate: 'Tor / Garagentor',
  planview: 'Grundriss / Lageplan (Grundriss-Seite als Kachel)',
  wallbox: 'Wallbox (Laden, PV-Überschuss)',
};

/** Fields per tile type: [key, label, kind, help]; kind: state-w, state-r, text, number, check, select:<opts>, camera */
const TYPE_FIELDS = {
  switch: [
    ['state', 'Schalten (Datenpunkt)', 'state-w'],
    ['status', 'Rückmeldung (optional)', 'state-r', 'Status-Datenpunkt, z. B. KNX-Rückmelde-Adresse'],
    ['invert', 'Umgekehrt (true = aus)', 'check'],
  ],
  dimmer: [
    ['state', 'Helligkeit 0–100 % (Datenpunkt)', 'state-w'],
    ['switchState', 'Ein/Aus (optional)', 'state-w', 'Wenn der Dimmer einen eigenen Schalt-Datenpunkt hat'],
    ['status', 'Rückmeldung Helligkeit (optional)', 'state-r'],
  ],
  blind: [
    ['state', 'Position % oder Auf/Ab (Datenpunkt)', 'state-w', 'Positions-Datenpunkt (0–100 %) oder Auf/Ab-Objekt (true/false)'],
    ['stop', 'Stopp (optional)', 'state-w'],
    ['status', 'Rückmeldung Position (optional)', 'state-r'],
    ['closed100', 'Auf/Ab umdrehen', 'check', 'Haken setzen, wenn Auf und Ab vertauscht sind (bei Position: 100 % = zu; bei Auf/Ab-Objekt: true = auf)'],
    ['kind', 'Art', 'select:blind=Rollladen / Jalousie;awning=Markise (Einfahren / Ausfahren)'],
    ['windAlarm', 'Windalarm (optional)', 'state-r', 'true = Alarm – oder eine Windgeschwindigkeit mit Grenzwert darunter'],
    ['windMin', 'Windalarm ab (optional)', 'number', 'Nur wenn der Datenpunkt eine Windgeschwindigkeit ist, z. B. 40 (km/h). Leer = true/false.'],
    ['rainAlarm', 'Regenalarm (optional)', 'state-r', 'true = Regen'],
    ['protect', 'Bei Wind- oder Regenalarm', 'select:up=automatisch Auf / Einfahren;down=automatisch Ab;none=nicht fahren, nur sperren'],
    ['lockTime', 'Sperre nach dem Alarm', 'number', 'Solange ein Alarm ansteht, ist immer gesperrt. Danach noch so lange (0 = sofort frei).'],
    ['lockUnit', 'Einheit der Sperre', 'select:min=Minuten;s=Sekunden'],
  ],
  planview: [['target', 'Grundriss-Seite', 'planpage']],
  gate: [
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
  ],
  thermostat: [
    ['state', 'Sollwert (Datenpunkt)', 'state-w'],
    ['setStatus', 'Rückmeldung Sollwert (optional)', 'state-r', 'Aktueller Sollwert vom Regler, z. B. KNX-Status'],
    ['status', 'Raumtemperatur Ist (optional)', 'state-r'],
    ['humidity', 'Luftfeuchte (optional)', 'state-r'],
    ['mode', 'Betriebsart umschalten (optional)', 'state-w', 'z. B. KNX HVAC-Modus (1 = Komfort, 2 = Standby, 3 = Nacht, 4 = Frostschutz)'],
    ['modeStatus', 'Rückmeldung Betriebsart (optional)', 'state-r'],
    ['modes', 'Betriebsarten (optional)', 'text', 'Wert=Text; leer = Texte des Datenpunkts oder 1=Komfort;2=Standby;3=Nacht;4=Frostschutz'],
    ['heating', 'Heizt gerade / Stellgröße % (optional)', 'state-r', 'Ein/Aus oder Ventilstellung in %'],
    ['window', 'Fenster (optional)', 'state-r', 'Zeigt „Fenster offen“'],
    ['step', 'Schritt', 'number', 'Standard 0,5'],
    ['min', 'Sollwert min. (optional)', 'number', 'leer = vom Datenpunkt'],
    ['max', 'Sollwert max. (optional)', 'number', 'leer = vom Datenpunkt'],
    ['unit', 'Einheit', 'text', 'Standard °C'],
  ],
  camera: [['camera', 'Kamera (aus dem livecam-Adapter)', 'camera']],
  link: [['url', 'Adresse', 'text', 'z. B. http://192.168.1.x:8096/radio – http-Seiten öffnen sich am iPhone (HTTPS) in einem eigenen Fenster']],
  page: [['target', 'Seite, die geöffnet wird', 'page']],
  multi: [['rows', 'Werte', 'rows']],
  windows: [['windows', 'Fenster', 'windows']],
  html: [['state', 'Datenpunkt mit HTML', 'state-r', 'z. B. eine Tabelle, die ein Skript erzeugt (javascript.0.…). Skripte im HTML werden nicht ausgeführt.']],
  heading: [],
  wallbox: [
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
    SV.draft = clone(SV.layout);
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
      SV.layout = saved;
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
    if (!id) return;
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
    row.appendChild(input);
    row.appendChild(btn);
    field(box, label, row, help);
    const nameEl = document.createElement('div');
    nameEl.className = 'statename';
    box.appendChild(nameEl);
    stateName(value, nameEl);
    input.onchange = () => stateName(input.value.trim(), nameEl);
    btn.onclick = async () => {
      const r = await Picker.open({ api, title: (forOutput ? 'Datenpunkt zum Schalten wählen' : 'Datenpunkt zum Anzeigen wählen') + ' – ' + label, current: input.value.trim(), forOutput });
      if (r) {
        input.value = r.id;
        names[r.id] = r.name || '';
        stateName(r.id, nameEl);
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

  /** Window overview: per window name, contact, optional tilt contact, inverted. */
  function windowsField(box, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    field(box, 'Fenster', wrap, 'Pro Fenster den Magnetkontakt (true = offen). Gekippt nur, wenn es einen eigenen Kipp-Kontakt gibt (true = gekippt).');
    const list = rows.map(r => ({ ...r }));
    let rowInputs = [];
    const read = () => rowInputs.map(x => ({ label: x.label.value.trim(), state: x.state.value.trim(), tilt: x.tilt.value.trim(), invert: x.invert.input.checked }));
    function draw() {
      wrap.textContent = '';
      rowInputs = [];
      list.forEach((r, i) => {
        const b = document.createElement('div');
        b.className = 'rule';
        const x = {};
        x.label = field(b, 'Name', textInput(r.label));
        x.label.placeholder = 'z. B. Küche';
        x.state = stateField(b, 'Kontakt (offen)', r.state, false);
        x.tilt = stateField(b, 'Kipp-Kontakt (optional)', r.tilt, false);
        x.invert = check('Kontakt umgekehrt (true = geschlossen)', r.invert);
        b.appendChild(x.invert);
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
        cur.push({ label: '', state: '', tilt: '' });
        list.splice(0, list.length, ...cur);
        draw();
      };
      wrap.appendChild(add);
    }
    draw();
    return { type: 'custom', get: () => read().filter(r => r.state || r.tilt) };
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
        else if (kind === 'check') {
          const c = check(label, t[key]);
          body.appendChild(c);
          inputs[key] = c.input;
          if (help) {
            const h = document.createElement('div');
            h.className = 'help';
            h.textContent = help;
            body.appendChild(h);
          }
        } else if (kind === 'number') inputs[key] = field(body, label, textInput(t[key], 'number'), help);
        else if (kind.startsWith('select:')) {
          const opts = kind.slice(7).split(';').map(x => x.split('='));
          inputs[key] = field(body, label, select(opts, t[key] || opts[0][0]), help);
        } else if (kind === 'energy') energyField(body, t[key], t.type === 'wallbox' ? [label, help] : null).then(s => (inputs[key] = s));
        else if (kind === 'charger') chargerField(body, t[key], label, help).then(s => (inputs[key] = s));
        else if (kind === 'camera') cameraField(body, t[key]).then(s => (inputs[key] = s));
        else if (kind === 'planpage') inputs[key] = field(body, label, select([['', '(wählen)']].concat(SV.draft.pages.filter(p => p.type === 'plan').map(p => [p.id, p.name])), t[key] || ''), 'Zuerst eine Seite der Art „Grundriss“ anlegen. Beschriftung leer = Name der Seite. In den Seiten-Einstellungen kann die Grundriss-Seite aus der Seitenleiste ausgeblendet werden.');
        else if (kind === 'page') inputs[key] = field(body, label, select([['', '(wählen)']].concat(SV.draft.pages.filter(p => p.id !== page.id).map(p => [p.id, p.name])), t[key] || ''), 'Beschriftung leer = Name der Seite');
        else if (kind === 'rows') inputs[key] = rowsField(body, t[key] || [{ label: '', state: '' }]);
        else if (kind === 'windows') inputs[key] = windowsField(body, t[key] || [{ label: '', state: '', tilt: '' }]);
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
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.textContent = 'Kopieren';
          copy.onclick = () => {
            collect();
            const c = clone(t);
            c.id = newId(page.tiles, 't');
            delete c.hkId; // the copy gets its own HomeKit device
            const i = page.tiles.findIndex(x => x.id === original.id);
            page.tiles.splice(i + 1, 0, c);
            d.close();
            render();
            editTile(page, c);
          };
          buttons.appendChild(copy);
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
    // tile page: free grid (place tiles anywhere, gaps allowed)
    const frBox = document.createElement('div');
    body.appendChild(frBox);
    const fr = check('Kacheln frei platzieren (Raster, Lücken möglich)', p.free);
    frBox.appendChild(fr);
    const colsBox = document.createElement('div');
    frBox.appendChild(colsBox);
    const cols = field(colsBox, 'Spalten im Raster', select([3, 4, 5, 6, 7, 8, 9, 10, 12].map(n => [String(n), String(n)]), String(p.cols || 6)), 'Im Bearbeiten-Modus Kachel auf ein leeres Feld oder auf eine andere Kachel ziehen (tauschen). Am Handy stehen die Kacheln einfach untereinander.');
    const showMs = () => {
      msBox.hidden = type.value !== 'plan';
      frBox.hidden = type.value !== 'tiles';
      colsBox.hidden = !fr.input.checked;
    };
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
      p.cols = Number(cols.value);
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
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = page.image ? 'Auf den Plan tippen = Symbol setzen · Symbol ziehen = verschieben · Symbol antippen = bearbeiten' : 'PNG, JPG, SVG oder PDF (z. B. der Plan vom Architekten) – PDFs werden automatisch in ein Bild umgewandelt';
    bar.appendChild(hint);
    return bar;
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
      l.hideNav = hideNav.input.checked;
      l.side = {
        enabled: sideOn.input.checked,
        top: sideChecks.top.filter(i => i.checked).map(i => i.value),
        bottom: sideChecks.bottom.filter(i => i.checked).map(i => i.value),
      };
      l.ring = { state: ringState.value.trim(), camera: ringCam ? ringCam.value : l.ring.camera, door: door.value.trim(), intercom: icSel.value };
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
