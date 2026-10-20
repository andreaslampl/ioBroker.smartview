'use strict';

/* Edit mode: pages, tiles, floor plan markers (tap to add, drag to move), doorbell and push rules. */

const TYPE_LABELS = {
  switch: 'Schalter / Taster (Ein/Aus)',
  dimmer: 'Dimmer',
  blind: 'Rollladen / Jalousie',
  value: 'Anzeige (Wert, Text, Kontakt)',
  button: 'Taste (schreibt einen Wert, z. B. Szene)',
  thermostat: 'Heizung / Sollwert',
  camera: 'Kamera',
  link: 'Link / andere Seite',
  heading: 'Überschrift',
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
    ['state', 'Position (Datenpunkt)', 'state-w'],
    ['stop', 'Stopp (optional)', 'state-w'],
    ['status', 'Rückmeldung Position (optional)', 'state-r'],
    ['closed100', '100 % = geschlossen (KNX, Shelly je nach Einstellung)', 'check', 'Ohne Haken: 100 % = offen'],
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
    ['status', 'Istwert (optional)', 'state-r'],
    ['step', 'Schritt', 'number', 'Standard 0,5'],
    ['unit', 'Einheit', 'text', 'Standard °C'],
  ],
  camera: [['camera', 'Kamera (aus dem livecam-Adapter)', 'camera']],
  link: [['url', 'Adresse', 'text', 'z. B. http://192.168.1.x:8096/radio – http-Seiten öffnen sich am iPhone (HTTPS) in einem eigenen Fenster']],
  heading: [],
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

  async function save() {
    try {
      const saved = await api('layout', { method: 'PUT', body: JSON.stringify(SV.draft) });
      SV.layout = saved;
      SV.editing = false;
      SV.draft = null;
      render();
      toast('Gespeichert');
    } catch (e) {
      toast('Speichern fehlgeschlagen: ' + e.message, true);
    }
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
      const typeSel = field(body, 'Art', select(Object.entries(TYPE_LABELS).filter(([k]) => !(isPlan && k === 'heading')), t.type));
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
        else if (kind.startsWith('select:')) inputs[key] = field(body, label, select(kind.slice(7).split(';').map(x => x.split('=')), t[key] || 'none'), help);
        else if (kind === 'camera') cameraField(body, t[key]).then(s => (inputs[key] = s));
        else inputs[key] = field(body, label, textInput(t[key]), help);
      }
      if (t.type !== 'heading') iconField(body, t.icon || DEFAULT_ICON[t.type], name => (t.icon = name));
      if (!isPlan && t.type !== 'heading') inputs.size = field(body, 'Größe', select([['1', 'normal'], ['w', 'breit (2 Spalten)'], ['l', 'groß (2 × 2)']], t.size || '1'));
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
        if (input.type === 'checkbox') t[key] = input.checked;
        else if (input.type === 'number') t[key] = input.value === '' ? undefined : Number(input.value);
        else t[key] = input.value.trim();
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
    const type = field(body, 'Art', select([['tiles', 'Kacheln'], ['plan', 'Grundriss (Bild mit Symbolen)']], p.type), 'Beim Grundriss lädst du ein Bild hoch und setzt Taster, Lichter, Kontakte usw. auf den Plan.');
    if (!isNew && p.tiles.length) type.disabled = true;
    iconField(body, p.icon, n => (p.icon = n));
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
    file.accept = 'image/png,image/jpeg,image/svg+xml,image/webp,image/gif';
    file.hidden = true;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = page.image ? 'Anderes Bild wählen' : 'Bild wählen';
    pick.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 20e6) return toast('Bild ist zu groß (max. 20 MB)', true);
      try {
        toast('Bild wird hochgeladen …');
        const res = await fetch('api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f, credentials: 'same-origin' });
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
    hint.textContent = page.image ? 'Auf den Plan tippen = Symbol setzen · Symbol ziehen = verschieben · Symbol antippen = bearbeiten' : 'PNG, JPG oder SVG, z. B. ein Foto oder Export des Grundrisses';
    bar.appendChild(hint);
    return bar;
  }

  function planClick(e, page, plan) {
    if (e.target.closest('.marker')) return;
    const r = plan.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
    const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
    addTile(page, { x, y });
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

    const h1 = document.createElement('h3');
    h1.textContent = 'Klingel';
    h1.style.marginTop = '22px';
    body.appendChild(h1);
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = 'Wenn der Datenpunkt „läutet“ ein wird, zeigt SmartView die Kamera groß – mit „Tür öffnen“. Beim livecam-Adapter: livecam.0.intercom.ringing und livecam.0.intercom.openDoor.';
    body.appendChild(help);
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
        inp.title = field(box, 'Titel', textInput(r.title));
        inp.title.placeholder = 'z. B. Alarm Garage';
        inp.text = field(box, 'Text', textInput(r.text));
        inp.text.placeholder = 'z. B. Tor ist seit 10 Minuten offen ({value})';
        inp.page = field(box, 'Beim Antippen öffnen', select([['', 'Startseite']].concat(SV.draft.pages.map(p => [p.id, p.name])), r.page || ''));
        ruleInputs.push(inp);
        rulesBox.appendChild(box);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Mitteilung';
      add.onclick = () => {
        collectRules();
        rules.push({ id: newId(rules, 'r'), enabled: true, state: '', cond: 'true', value: '', title: '', text: '', page: '' });
        drawRules();
      };
      rulesBox.appendChild(add);
    }

    function collectRules() {
      ruleInputs.forEach((inp, i) => {
        rules[i] = { ...rules[i], enabled: inp.enabled.checked, state: inp.state.value.trim(), cond: inp.cond.value, value: inp.value.value, title: inp.title.value, text: inp.text.value, page: inp.page.value };
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
      l.ring = { state: ringState.value.trim(), camera: ringCam ? ringCam.value : l.ring.camera, door: door.value.trim() };
      l.push = rules;
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

  return { start, addTile, editTile, addPage, editPage, planTools, planClick, markerDown };
})();
