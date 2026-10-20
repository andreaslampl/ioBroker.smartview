'use strict';

/* SmartView: pages with tiles or floor plans, live values over /ws, commands, cameras, doorbell, push. */

const $ = id => document.getElementById(id);
const SV = {
  layout: null,
  draft: null, // copy being edited
  editing: false,
  allowEdit: false,
  icons: [],
  states: {}, // id -> {val, ack, ts, unit, type, states, missing}
  writable: new Set(),
  page: null,
  ws: null,
  connected: false,
  sheet: null, // {tile, el} open control sheet
  cam: null, // full screen camera {el, id, ring}
  ringDismissed: false,
  dragging: false,
};

// ---------------- helpers ----------------

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function api(path, options = {}) {
  const res = await fetch('api/' + path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...options });
  if (!res.ok) {
    let text = await res.text();
    try {
      text = JSON.parse(text).error || text;
    } catch (e) {
      // plain text
    }
    throw new Error(text || 'HTTP ' + res.status);
  }
  return res.status === 204 ? null : res.json();
}

function toast(text, error) {
  const t = $('toast');
  t.textContent = text;
  t.className = error ? 'error' : '';
  t.style.display = text ? 'block' : 'none';
  clearTimeout(toast.timer);
  if (text) toast.timer = setTimeout(() => toast(''), error ? 6000 : 2500);
}

function device() {
  const forced = new URLSearchParams(location.search).get('device');
  if (forced === 'phone' || forced === 'touch') return forced;
  return window.innerWidth < 700 ? 'phone' : 'touch';
}

function layout() {
  return SV.editing ? SV.draft : SV.layout;
}

function st(id) {
  return id ? SV.states[id] : undefined;
}

function val(id) {
  const s = st(id);
  return s ? s.val : undefined;
}

function truthy(v) {
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return Boolean(v);
}

function toNum(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseTexts(texts) {
  const map = {};
  for (const part of String(texts || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return map;
}

/** Value as text, with texts map, common.states, decimals and unit. */
function fmt(t, id, opts = {}) {
  const s = st(id);
  if (!s || s.missing || s.val === null || s.val === undefined) return { text: '–', unit: '' };
  const v = s.val;
  const map = parseTexts(t.texts);
  if (map[String(v)] !== undefined) return { text: map[String(v)], unit: '' };
  if (s.states && s.states[String(v)] !== undefined) return { text: String(s.states[String(v)]), unit: '' };
  if (typeof v === 'boolean') {
    const [on, off] = boolTexts(s.role) || [opts.onText || 'Ein', opts.offText || 'Aus'];
    return { text: v ? on : off, unit: '' };
  }
  const unit = t.unit !== undefined && t.unit !== '' ? t.unit : s.unit || '';
  if (typeof v === 'number') {
    const d = t.decimals !== undefined ? t.decimals : Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1;
    return { text: v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }), unit };
  }
  return { text: typeof v === 'object' ? JSON.stringify(v) : String(v), unit };
}

/** Texts for true/false by the role of the data point (contacts, motion, alarms). */
function boolTexts(role) {
  role = String(role || '');
  if (/window|door|contact|lock|opening/.test(role)) return /lock/.test(role) ? ['Offen', 'Verriegelt'] : ['Offen', 'Zu'];
  if (/motion|presence/.test(role)) return ['Bewegung', 'Ruhe'];
  if (/alarm|fire|smoke|water|leak|warning|error|maintenance/.test(role)) return ['Alarm', 'OK'];
  return null;
}

const DEFAULT_ICON = { switch: 'bulb', dimmer: 'bulb', blind: 'blind', value: 'gauge', button: 'scene', thermostat: 'thermometer', camera: 'camera', link: 'link', heading: 'info' };

function tileIcon(t) {
  return t.icon || DEFAULT_ICON[t.type] || 'info';
}

function tileIds(t) {
  return ['state', 'status', 'switchState', 'stop'].map(k => t[k]).filter(Boolean);
}

// ---------------- tile logic ----------------

function switchOn(t) {
  const v = val(t.status || t.state);
  return t.invert ? !truthy(v) : truthy(v);
}

function dimLevel(t) {
  return toNum(val(t.status || t.state));
}

function dimOn(t) {
  if (t.switchState && val(t.switchState) !== undefined && val(t.switchState) !== null) {
    if (!truthy(val(t.switchState))) return false;
  }
  return dimLevel(t) > 0 || (Boolean(t.switchState) && truthy(val(t.switchState)) && !t.state);
}

/** Blind position as percent open (0 = closed, 100 = open). */
function blindOpen(t) {
  const p = toNum(val(t.status || t.state));
  return t.closed100 ? 100 - p : p;
}

function blindText(t) {
  const s = st(t.status || t.state);
  if (!s || s.missing || s.val === null || s.val === undefined) return '–';
  const o = Math.round(blindOpen(t));
  return o >= 99 ? 'Offen' : o <= 1 ? 'Zu' : o + ' % offen';
}

function blindWrite(t, openPercent) {
  send(t.state, t.closed100 ? 100 - openPercent : openPercent);
}

function lastLevel(t) {
  try {
    return Number(localStorage.getItem('sv.level.' + t.state)) || 100;
  } catch (e) {
    return 100;
  }
}

function rememberLevel(t, v) {
  if (v > 0) {
    try {
      localStorage.setItem('sv.level.' + t.state, String(v));
    } catch (e) {
      // ignore
    }
  }
}

function toggle(t) {
  if (t.type === 'switch') {
    if (!t.state) return toast('Kein Datenpunkt eingestellt', true);
    const on = switchOn(t);
    send(t.state, t.invert ? on : !on);
  } else if (t.type === 'dimmer') {
    const on = dimOn(t);
    if (t.switchState) {
      send(t.switchState, !on);
      if (!on && t.state && dimLevel(t) === 0) send(t.state, lastLevel(t));
    } else if (t.state) {
      if (on) rememberLevel(t, dimLevel(t));
      send(t.state, on ? 0 : lastLevel(t));
    }
  }
}

function press(t) {
  if (!t.state) return toast('Kein Datenpunkt eingestellt', true);
  if (t.confirm && !confirm((t.label || 'Aktion') + ' wirklich auslösen?')) return;
  const v = t.value === undefined || t.value === '' ? true : t.value;
  send(t.state, v);
}

function thermoStep(t, dir) {
  const step = t.step || 0.5;
  const cur = toNum(val(t.state));
  const s = st(t.state) || {};
  let next = Math.round((cur + dir * step) * 100) / 100;
  if (s.min !== undefined && s.min !== null) next = Math.max(s.min, next);
  if (s.max !== undefined && s.max !== null) next = Math.min(s.max, next);
  send(t.state, next);
}

/** Highlight state of a tile: 'on', 'alert' or ''. */
function tileState(t) {
  if (t.type === 'switch') return switchOn(t) ? 'on' : '';
  if (t.type === 'dimmer') return dimOn(t) ? 'on' : '';
  if (t.type === 'blind') return '';
  if (t.type === 'value' && t.highlight && t.highlight !== 'none') {
    const s = st(t.state);
    if (!s || s.val === null || s.val === undefined) return '';
    const on = truthy(s.val);
    return (t.highlight === 'on' && on) || (t.highlight === 'off' && !on) ? 'alert' : '';
  }
  return '';
}

function missing(t) {
  return tileIds(t).some(id => st(id) && st(id).missing);
}

// ---------------- commands ----------------

function send(id, value) {
  if (!id) return;
  if (!SV.ws || SV.ws.readyState !== 1) return toast('Keine Verbindung zum ioBroker', true);
  SV.ws.send(JSON.stringify({ type: 'set', id, val: value }));
  // show the new value right away; the confirmed value replaces it
  const s = SV.states[id] || {};
  SV.states[id] = { ...s, val: value, ack: false, ts: Date.now(), missing: false };
  refresh(id);
}

// ---------------- rendering ----------------

function applyTheme() {
  let theme = (layout() && layout().theme) || 'dark';
  try {
    theme = localStorage.getItem('sv.theme') || theme;
  } catch (e) {
    // ignore
  }
  document.documentElement.dataset.theme = theme;
}

function visibleTiles(page) {
  const dev = device();
  return page.tiles.filter(t => SV.editing || t.device === 'all' || !t.device || t.device === dev);
}

function currentPage() {
  const l = layout();
  const id = decodeURIComponent(location.hash.slice(1));
  return l.pages.find(p => p.id === id) || l.pages[0] || null;
}

function render() {
  const l = layout();
  if (!l) return;
  applyTheme();
  document.title = l.title;
  $('title').textContent = l.title;
  const page = currentPage();
  SV.page = page;
  $('pageTitle').textContent = page ? page.name : '';
  document.body.classList.toggle('editing', SV.editing);
  $('editBar').hidden = !SV.editing;
  $('editBtn').hidden = !SV.allowEdit || SV.editing;
  renderNav();
  renderPage();
}

function renderNav() {
  const nav = $('nav');
  nav.textContent = '';
  const l = layout();
  for (const p of l.pages) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'navitem' + (SV.page && p.id === SV.page.id ? ' active' : '');
    b.innerHTML = icon(p.type === 'plan' && p.icon === 'home' ? 'map' : p.icon) + '<span class="lbl">' + esc(p.name) + '</span>';
    b.onclick = () => {
      location.hash = encodeURIComponent(p.id);
    };
    if (SV.editing) {
      const cfg = document.createElement('span');
      cfg.className = 'cfg';
      cfg.innerHTML = icon('edit');
      cfg.title = 'Seite bearbeiten';
      cfg.onclick = e => {
        e.stopPropagation();
        Editor.editPage(p);
      };
      b.appendChild(cfg);
    }
    nav.appendChild(b);
  }
  if (SV.editing) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'navitem navadd';
    add.innerHTML = icon('plus') + '<span class="lbl">Seite</span>';
    add.onclick = () => Editor.addPage();
    nav.appendChild(add);
  }
  nav.hidden = !SV.editing && l.pages.length < 2;
  document.getElementById('app').classList.toggle('nonav', nav.hidden);
}

function renderPage() {
  const main = $('main');
  main.textContent = '';
  const page = SV.page;
  if (!page) {
    main.innerHTML = '<p class="muted">Noch keine Seite. Oben auf ✎ tippen und mit „+ Seite“ beginnen.</p>';
    return;
  }
  if (page.type === 'plan') return renderPlan(main, page);
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const t of visibleTiles(page)) grid.appendChild(renderTile(t));
  if (SV.editing) {
    const add = document.createElement('div');
    add.className = 'tile addtile';
    add.innerHTML = icon('plus') + '<span>Kachel</span>';
    add.onclick = () => Editor.addTile(page);
    grid.appendChild(add);
  }
  main.appendChild(grid);
}

function renderTile(t) {
  const el = document.createElement('div');
  el.className = 'tile ' + t.type + ' size-' + (t.size || '1');
  el.dataset.tile = t.id;
  el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  fillTile(el, t);
  el.addEventListener('click', e => {
    if (SV.editing) return Editor.editTile(SV.page, t);
    if (e.target.closest('button, input')) return;
    tileTap(t);
  });
  return el;
}

function tileTap(t) {
  if (t.type === 'switch' || t.type === 'dimmer') return toggle(t);
  if (t.type === 'button') return press(t);
  if (t.type === 'camera') return openCam(t.camera, t.label);
  if (t.type === 'link') return openLink(t);
  if (t.type === 'blind' || t.type === 'thermostat' || t.type === 'value') return openSheet(t);
}

function fillTile(el, t) {
  const stt = tileState(t);
  el.classList.toggle('on', stt === 'on');
  el.classList.toggle('alert', stt === 'alert');
  el.classList.toggle('missing', missing(t));
  el.classList.toggle('tap', t.type !== 'heading');
  const label = '<div class="lbl">' + esc(t.label || '') + '</div>';
  const ic = '<span class="tic">' + icon(tileIcon(t)) + '</span>';
  let html = '';
  switch (t.type) {
    case 'heading':
      html = esc(t.label);
      break;
    case 'switch':
      html = '<div class="row1">' + ic + '<span class="tval">' + (val(t.status || t.state) === undefined || val(t.status || t.state) === null ? '–' : switchOn(t) ? 'Ein' : 'Aus') + '</span></div>' + label;
      break;
    case 'dimmer': {
      const on = dimOn(t);
      html = '<div class="row1">' + ic + '<span class="tval">' + (on ? Math.round(dimLevel(t)) + ' %' : 'Aus') + '</span></div>' + label;
      if (t.state) html += '<input type="range" min="0" max="100" step="1" value="' + Math.round(dimLevel(t)) + '" aria-label="Helligkeit">';
      break;
    }
    case 'blind':
      html = '<div class="row1">' + ic + '<span class="tval">' + blindText(t) + '</span></div>' + label +
        '<div class="ctl"><button type="button" data-a="up" aria-label="Auf">' + icon('up') + '</button>' +
        (t.stop ? '<button type="button" data-a="stop" aria-label="Stopp">' + icon('stop') + '</button>' : '') +
        '<button type="button" data-a="down" aria-label="Ab">' + icon('down') + '</button></div>';
      break;
    case 'value': {
      const f = fmt(t, t.state);
      html = '<div class="row1">' + ic + '</div><div class="big">' + esc(f.text) + (f.unit ? '<small>' + esc(f.unit) + '</small>' : '') + '</div>' + label;
      break;
    }
    case 'button':
      html = '<div class="row1">' + ic + '</div>' + label;
      break;
    case 'thermostat': {
      // tap opens the sheet with − / +
      const f = fmt({ decimals: 1, unit: t.unit }, t.state);
      const a = t.status ? fmt({ decimals: 1, unit: t.unit }, t.status) : null;
      html = '<div class="row1">' + ic + '<span class="tval">' + (a ? 'Ist ' + esc(a.text) + ' ' + esc(a.unit || '°C') : '') + '</span></div>' +
        '<div class="big">' + esc(f.text) + '<small>' + esc(f.unit || '°C') + '</small></div>' + label;
      break;
    }
    case 'camera':
      html = (t.camera ? '<img class="camimg" alt="" data-cam="' + esc(t.camera) + '">' : '<div class="planempty">Keine Kamera gewählt</div>') + '<span class="camlbl">' + esc(t.label || '') + '</span>';
      break;
    case 'link':
      html = '<div class="row1">' + ic + '</div>' + label;
      break;
  }
  if (missing(t)) html += '<span class="warnmark" title="Datenpunkt nicht gefunden">⚠</span>';
  el.innerHTML = html;
  bindControls(el, t);
  if (t.type === 'camera') {
    const img = el.querySelector('img.camimg');
    if (img) loadCam(img);
    startCams();
  }
}

function bindControls(el, t) {
  for (const b of el.querySelectorAll('button[data-a]')) {
    b.onclick = e => {
      e.stopPropagation();
      if (SV.editing) return Editor.editTile(SV.page, t);
      const a = b.dataset.a;
      if (a === 'up') blindWrite(t, 100);
      else if (a === 'down') blindWrite(t, 0);
      else if (a === 'stop') send(t.stop, true);
      else if (a === 'plus') thermoStep(t, 1);
      else if (a === 'minus') thermoStep(t, -1);
      else if (a === 'on') t.type === 'switch' ? send(t.state, !t.invert) : t.switchState ? send(t.switchState, true) : send(t.state, lastLevel(t));
      else if (a === 'off') t.type === 'switch' ? send(t.state, Boolean(t.invert)) : t.switchState ? send(t.switchState, false) : (rememberLevel(t, dimLevel(t)), send(t.state, 0));
      else if (a === 'press') press(t);
      else if (a === 'open') openCam(t.camera, t.label);
    };
  }
  for (const r of el.querySelectorAll('input[type=range]')) {
    const out = el.querySelector('[data-out]');
    r.addEventListener('pointerdown', e => {
      e.stopPropagation();
      SV.dragging = true;
    });
    r.addEventListener('click', e => e.stopPropagation());
    r.addEventListener('input', () => {
      if (out) out.textContent = r.dataset.kind === 'blind' ? r.value + ' % offen' : r.value + ' %';
    });
    r.addEventListener('change', () => {
      SV.dragging = false;
      if (SV.editing) return;
      const v = Number(r.value);
      if (r.dataset.kind === 'blind') blindWrite(t, v);
      else {
        rememberLevel(t, v);
        send(t.state, v);
      }
    });
  }
}

/** Data point changed: redraw tiles, markers and the open sheet that show it. */
function refresh(id) {
  const sel = '[data-ids~="' + CSS.escape(id) + '"]';
  for (const el of document.querySelectorAll(sel)) {
    if (el.contains(document.activeElement) && document.activeElement.type === 'range' && SV.dragging) continue;
    const t = findTile(el.dataset.tile);
    if (!t) continue;
    if (el.classList.contains('marker')) fillMarker(el, t);
    else if (el.classList.contains('sheet')) fillSheet(el, t);
    else fillTile(el, t);
  }
  if (layout() && id === layout().ring.state) checkRing();
}

function findTile(id) {
  const page = SV.page;
  return page ? page.tiles.find(t => t.id === id) : null;
}

// ---------------- floor plan ----------------

function renderPlan(main, page) {
  const tools = SV.editing ? Editor.planTools(page) : document.createElement('div');
  tools.classList.add('plantools');
  if (page.image) {
    // zoom for small screens
    for (const [txt, f] of [['+', 1.5], ['−', 1 / 1.5]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = f > 1 ? 'Vergrößern' : 'Verkleinern';
      b.onclick = () => {
        SV.planZoom = SV.planZoom || {};
        SV.planZoom[page.id] = Math.min(4, Math.max(1, Math.round(planZoom(page) * f * 100) / 100));
        renderPage();
      };
      tools.insertBefore(b, tools.firstChild);
    }
  }
  if (tools.children.length) main.appendChild(tools);
  const wrap = document.createElement('div');
  wrap.className = 'planwrap';
  if (!page.image) {
    wrap.innerHTML = '<div class="planempty">' + (SV.editing ? 'Noch kein Grundriss – oben „Bild wählen“ tippen.' : 'Noch kein Grundriss hinterlegt.') + '</div>';
    main.appendChild(wrap);
    return;
  }
  const plan = document.createElement('div');
  plan.className = 'plan';
  const zoom = planZoom(page);
  plan.style.width = zoom * 100 + '%';
  const img = document.createElement('img');
  img.className = 'planimg';
  img.src = 'files/' + encodeURIComponent(page.image);
  img.alt = page.name;
  plan.appendChild(img);
  for (const t of visibleTiles(page)) plan.appendChild(renderMarker(t, page));
  if (SV.editing) plan.addEventListener('click', e => Editor.planClick(e, page, plan));
  wrap.appendChild(plan);
  main.appendChild(wrap);
  // fit the plan to the height of the screen on wide screens
  img.onload = () => {
    if (zoom === 1 && device() === 'touch') {
      const maxH = wrap.clientHeight || window.innerHeight - 120;
      const ratio = img.naturalWidth / img.naturalHeight;
      const w = Math.min(wrap.clientWidth, maxH * ratio);
      plan.style.width = w + 'px';
    }
  };
}

function planZoom(page) {
  return (SV.planZoom && SV.planZoom[page.id]) || 1;
}

function renderMarker(t, page) {
  const el = document.createElement('div');
  el.className = 'marker ' + t.type;
  el.dataset.tile = t.id;
  el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  el.style.left = t.x + '%';
  el.style.top = t.y + '%';
  fillMarker(el, t);
  if (SV.editing) {
    el.addEventListener('pointerdown', e => Editor.markerDown(e, page, t, el));
  } else {
    el.addEventListener('click', () => {
      if (t.type === 'switch' || t.type === 'button') return tileTap(t);
      if (t.type === 'camera') return openCam(t.camera, t.label);
      if (t.type === 'link') return openLink(t);
      openSheet(t);
    });
  }
  return el;
}

function fillMarker(el, t) {
  const stt = tileState(t);
  el.classList.toggle('on', stt === 'on');
  el.classList.toggle('alert', stt === 'alert');
  el.classList.toggle('cam', t.type === 'camera');
  let v = '';
  if (t.type === 'value') {
    const f = fmt(t, t.state);
    v = f.text + (f.unit ? ' ' + f.unit : '');
  } else if (t.type === 'dimmer') v = dimOn(t) ? Math.round(dimLevel(t)) + ' %' : '';
  else if (t.type === 'blind') v = blindText(t);
  else if (t.type === 'thermostat') {
    const f = fmt({ decimals: 1, unit: t.unit }, t.status || t.state);
    v = f.text + (f.unit ? ' ' + f.unit : ' °C');
  }
  el.title = t.label || '';
  el.innerHTML = '<div class="dot">' + icon(tileIcon(t)) + '</div>' + (v ? '<div class="mval">' + esc(v) + '</div>' : '');
}

// ---------------- control sheet ----------------

function openSheet(t) {
  closeSheet();
  const ov = document.createElement('div');
  ov.className = 'overlay bottom';
  const sh = document.createElement('div');
  sh.className = 'sheet';
  sh.dataset.tile = t.id;
  sh.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  ov.appendChild(sh);
  ov.addEventListener('click', e => {
    if (e.target === ov) closeSheet();
  });
  document.body.appendChild(ov);
  SV.sheet = { tile: t, el: ov };
  fillSheet(sh, t);
}

function closeSheet() {
  if (SV.sheet) {
    SV.sheet.el.remove();
    SV.sheet = null;
  }
}

function fillSheet(sh, t) {
  let body = '';
  if (t.type === 'switch') {
    body = '<div class="bigval">' + (switchOn(t) ? 'Ein' : 'Aus') + '</div><div class="row"><button type="button" data-a="off">Aus</button><button type="button" data-a="on" class="primary">Ein</button></div>';
  } else if (t.type === 'dimmer') {
    body = '<div class="bigval" data-out>' + (dimOn(t) ? Math.round(dimLevel(t)) + ' %' : 'Aus') + '</div>' +
      (t.state ? '<input type="range" min="0" max="100" step="1" value="' + Math.round(dimLevel(t)) + '">' : '') +
      '<div class="row"><button type="button" data-a="off">Aus</button><button type="button" data-a="on" class="primary">Ein</button></div>';
  } else if (t.type === 'blind') {
    body = '<div class="bigval" data-out>' + blindText(t) + '</div>' +
      '<input type="range" data-kind="blind" min="0" max="100" step="5" value="' + Math.round(blindOpen(t)) + '">' +
      '<div class="row"><button type="button" data-a="up">' + icon('up') + 'Auf</button>' +
      (t.stop ? '<button type="button" data-a="stop">' + icon('stop') + 'Stopp</button>' : '') +
      '<button type="button" data-a="down">' + icon('down') + 'Ab</button></div>';
  } else if (t.type === 'thermostat') {
    const f = fmt({ decimals: 1, unit: t.unit }, t.state);
    const a = t.status ? fmt({ decimals: 1, unit: t.unit }, t.status) : null;
    body = '<div class="bigval">' + esc(f.text) + ' ' + esc(f.unit || '°C') + '</div>' + (a ? '<p class="muted" style="text-align:center">Ist: ' + esc(a.text) + ' ' + esc(a.unit || '°C') + '</p>' : '') +
      '<div class="row"><button type="button" data-a="minus">' + icon('minus') + '</button><button type="button" data-a="plus">' + icon('plus') + '</button></div>';
  } else if (t.type === 'value') {
    const f = fmt(t, t.state);
    const s = st(t.state);
    body = '<div class="bigval">' + esc(f.text) + (f.unit ? ' <small>' + esc(f.unit) + '</small>' : '') + '</div>' +
      (s && s.ts ? '<p class="muted" style="text-align:center">aktualisiert ' + new Date(s.ts).toLocaleString('de-DE') + '</p>' : '');
  } else if (t.type === 'button') {
    body = '<div class="row"><button type="button" data-a="press" class="primary">Auslösen</button></div>';
  }
  sh.innerHTML = '<h3>' + icon(tileIcon(t)) + '<span class="grow">' + esc(t.label || '') + '</span><button type="button" class="iconbtn" data-close aria-label="Schließen">' + icon('close') + '</button></h3>' + body;
  sh.querySelector('[data-close]').onclick = closeSheet;
  bindControls(sh, t);
}

// ---------------- cameras ----------------

let camTimer = null;
/** Next single image of a camera tile (only one request per tile at a time). */
function loadCam(img) {
  if (img.dataset.loading === '1') return;
  img.dataset.loading = '1';
  const done = () => {
    img.dataset.loading = '0';
  };
  img.onload = done;
  img.onerror = () => setTimeout(done, 3000);
  img.src = 'cam/' + encodeURIComponent(img.dataset.cam) + '.jpg?t=' + Date.now();
}

function startCams() {
  if (camTimer) return;
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    for (const img of document.querySelectorAll('img.camimg')) loadCam(img);
  };
  camTimer = setInterval(tick, device() === 'phone' ? 1500 : 1000);
}

function openCam(id, name, ring) {
  if (!id) return toast('Keine Kamera gewählt', true);
  closeCam();
  const el = document.createElement('div');
  el.className = 'camfull' + (ring ? ' ring' : '');
  const door = ring && layout().ring.door;
  el.innerHTML = '<img alt="">' + '<div class="bar"><span class="name">' + esc(ring ? 'Es läutet' + (name ? ' – ' + name : '') : name || '') + '</span>' +
    (door ? '<button type="button" class="door" data-door>Tür öffnen</button>' : '') + '<button type="button" data-close>Schließen</button></div>';
  el.querySelector('img').src = 'cam/' + encodeURIComponent(id) + '.mjpeg';
  el.querySelector('[data-close]').onclick = () => {
    if (ring) SV.ringDismissed = true;
    closeCam();
  };
  const d = el.querySelector('[data-door]');
  if (d) d.onclick = () => {
    send(layout().ring.door, true);
    toast('Tür wird geöffnet');
  };
  document.body.appendChild(el);
  SV.cam = { el, id, ring: Boolean(ring) };
}

function closeCam() {
  if (SV.cam) {
    // stop the stream
    const img = SV.cam.el.querySelector('img');
    if (img) img.src = '';
    SV.cam.el.remove();
    SV.cam = null;
  }
}

function checkRing() {
  const r = layout().ring;
  if (!r.state || !r.camera) return;
  const ringing = truthy(val(r.state));
  if (ringing && !SV.ringDismissed && !(SV.cam && SV.cam.ring) && !SV.editing) {
    closeSheet();
    openCam(r.camera, '', true);
  } else if (!ringing) {
    SV.ringDismissed = false;
    if (SV.cam && SV.cam.ring) closeCam();
  }
}

function openLink(t) {
  if (!t.url) return toast('Keine Adresse eingestellt', true);
  const url = t.url;
  // an http page cannot be shown inside an https page
  if (location.protocol === 'https:' && /^http:/i.test(url)) {
    window.open(url, '_blank');
    return;
  }
  closeCam();
  const el = document.createElement('div');
  el.className = 'camfull linkfull';
  el.innerHTML = '<iframe allow="microphone; autoplay; fullscreen"></iframe><div class="bar"><span class="name">' + esc(t.label || '') + '</span><button type="button" data-close>Schließen</button></div>';
  el.querySelector('iframe').src = url;
  el.querySelector('[data-close]').onclick = closeCam;
  document.body.appendChild(el);
  SV.cam = { el, id: null, ring: false };
}

// ---------------- menu, push ----------------

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

async function pushSubscription() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!window.isSecureContext) throw new Error('Mitteilungen gehen nur über HTTPS – siehe „Zertifikat installieren“.');
  if (isIos() && !standalone()) throw new Error('Am iPhone zuerst „Zum Home-Bildschirm“ und SmartView von dort starten.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Dieser Browser unterstützt keine Mitteilungen.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt (Einstellungen → Mitteilungen → SmartView).');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('push/key');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)), c => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const name = (isIos() ? 'iPhone' : navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Gerät';
  await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), name }) });
}

async function disablePush() {
  const sub = await pushSubscription();
  if (sub) {
    await api('push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }
}

async function openMenu() {
  closeSheet();
  const ov = document.createElement('div');
  ov.className = 'overlay bottom';
  ov.innerHTML = '<div class="sheet menu"><h3>' + icon('menu') + '<span class="grow">Einstellungen</span><button type="button" class="iconbtn" data-close>' + icon('close') + '</button></h3><div data-push class="muted">Mitteilungen werden geprüft …</div>' +
    '<button type="button" class="item" data-cert>' + icon('lock') + 'Zertifikat installieren / HTTPS</button>' +
    (document.fullscreenEnabled ? '<button type="button" class="item" data-full>' + icon('fullscreen') + 'Vollbild</button>' : '') +
    '<button type="button" class="item" data-theme>' + icon('moon') + 'Hell / Dunkel</button>' +
    '<button type="button" class="item" data-reload>' + icon('home') + 'Neu laden</button></div>';
  ov.addEventListener('click', e => {
    if (e.target === ov) ov.remove();
  });
  document.body.appendChild(ov);
  ov.querySelector('[data-close]').onclick = () => ov.remove();
  ov.querySelector('[data-cert]').onclick = () => window.open('zertifikat', '_blank');
  ov.querySelector('[data-reload]').onclick = () => location.reload();
  ov.querySelector('[data-theme]').onclick = () => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem('sv.theme', cur);
    } catch (e) {
      // ignore
    }
    applyTheme();
  };
  const full = ov.querySelector('[data-full]');
  if (full) full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  renderPushMenu(ov.querySelector('[data-push]'));
}

async function renderPushMenu(box) {
  let html = '';
  let sub = null;
  let registered = false;
  try {
    sub = await pushSubscription();
    if (sub) registered = (await api('push/status', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })).registered;
  } catch (e) {
    // not supported
  }
  if (!window.isSecureContext) {
    html = '<p class="hint">Mitteilungen gehen nur über <b>HTTPS</b>. Zuerst das Zertifikat installieren und SmartView über die https-Adresse öffnen.</p>';
  } else if (isIos() && !standalone()) {
    html = '<p class="hint">Am iPhone: Teilen <b>□↑</b> → <b>Zum Home-Bildschirm</b>, dann SmartView vom Home-Bildschirm starten und hier Mitteilungen aktivieren.</p>';
  } else if (registered) {
    html = '<button type="button" class="item" data-test>' + icon('bell') + 'Test-Mitteilung senden</button><button type="button" class="item" data-off>' + icon('close') + 'Mitteilungen auf diesem Gerät aus</button>';
  } else {
    html = '<button type="button" class="item primary" data-on>' + icon('bell') + 'Mitteilungen aktivieren</button>';
  }
  box.className = '';
  box.innerHTML = html;
  const on = box.querySelector('[data-on]');
  if (on) on.onclick = async () => {
    try {
      await enablePush();
      toast('Mitteilungen aktiviert');
      renderPushMenu(box);
    } catch (e) {
      toast(e.message, true);
    }
  };
  const off = box.querySelector('[data-off]');
  if (off) off.onclick = async () => {
    await disablePush().catch(() => {});
    toast('Mitteilungen aus');
    renderPushMenu(box);
  };
  const test = box.querySelector('[data-test]');
  if (test) test.onclick = async () => {
    try {
      const r = await api('push/test', { method: 'POST', body: '{}' });
      toast(r.sent ? 'Gesendet an ' + r.sent + ' Gerät(e)' : 'Senden fehlgeschlagen – hat der ioBroker Internet?', !r.sent);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ---------------- connection ----------------

let retry = 1000;
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'ws');
  SV.ws = ws;
  ws.onopen = () => {
    retry = 1000;
    SV.connected = true;
    $('conn').className = 'ok';
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      SV.states = msg.states || {};
      SV.writable = new Set(msg.writable || []);
      render();
      checkRing();
    } else if (msg.type === 'state') {
      SV.states[msg.id] = msg.state;
      refresh(msg.id);
    } else if (msg.type === 'layout') {
      if (SV.editing) toast('Die Ansicht wurde auf einem anderen Gerät geändert.');
      else loadLayout().then(() => ws.close());
    } else if (msg.type === 'error') {
      toast(msg.text, true);
    }
  };
  ws.onclose = () => {
    SV.connected = false;
    $('conn').className = '';
    if (SV.ws === ws) setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

async function loadLayout() {
  const r = await api('layout');
  SV.layout = r.layout;
  SV.allowEdit = r.allowEdit;
  SV.icons = r.icons;
  SV.types = r.types;
}

function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

(async () => {
  $('menuBtn').innerHTML = icon('menu');
  $('editBtn').innerHTML = icon('edit');
  $('menuBtn').onclick = openMenu;
  $('editBtn').onclick = () => Editor.start();
  window.addEventListener('hashchange', () => {
    closeSheet();
    render();
  });
  let lastDev = device();
  window.addEventListener('resize', () => {
    if (device() !== lastDev) {
      lastDev = device();
      render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SV.ws && SV.ws.readyState > 1) connect();
  });
  tickClock();
  setInterval(tickClock, 10000);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await loadLayout();
    render();
    connect();
  } catch (e) {
    $('main').innerHTML = '<p>Verbindung zum ioBroker fehlgeschlagen: ' + esc(e.message) + '</p>';
  }
})();
