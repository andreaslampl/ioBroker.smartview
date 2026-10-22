'use strict';

/* SmartView: pages with tiles or floor plans, live values over /ws, commands, cameras, doorbell, push. */

const $ = id => document.getElementById(id);
const SV = {
  layout: null,
  draft: null, // copy being edited
  editing: false,
  allowEdit: false,
  me: null, // {usersEnabled, name, admin, control, manageUsers}
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

const DEFAULT_ICON = { energy: 'energy', windows: 'window', html: 'grid', page: 'home', multi: 'gauge', switch: 'bulb', dimmer: 'bulb', blind: 'blind', value: 'gauge', button: 'scene', thermostat: 'thermometer', camera: 'camera', link: 'link', heading: 'info' };

function tileIcon(t) {
  return t.icon || DEFAULT_ICON[t.type] || 'info';
}

function tileIds(t) {
  return ['state', 'status', 'switchState', 'stop', 'setStatus', 'humidity', 'mode', 'modeStatus', 'heating', 'window'].map(k => t[k])
    .concat((t.rows || []).map(r => r.state))
    .concat((t.windows || []).flatMap(w => [w.state, w.tilt]))
    .filter(Boolean);
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
  const cur = toNum(val(thermoSetId(t)));
  const s = st(t.state) || {};
  const min = t.min !== undefined ? t.min : s.min;
  const max = t.max !== undefined ? t.max : s.max;
  let next = Math.round((cur + dir * step) * 100) / 100;
  if (min !== undefined && min !== null) next = Math.max(min, next);
  if (max !== undefined && max !== null) next = Math.min(max, next);
  send(t.state, next);
}

/** Setpoint shown: the controller's feedback when there is one (until a command is pending). */
function thermoSetId(t) {
  const cmd = st(t.state);
  if (!t.setStatus || (cmd && cmd.ack === false && Date.now() - (cmd.ts || 0) < 10000)) return t.state;
  return t.setStatus;
}

/** Operating modes as [[value, text]]: own texts, texts of the data point, or KNX HVAC modes. */
function thermoModes(t) {
  let map = parseTexts(t.modes);
  if (!Object.keys(map).length) {
    const s = st(t.modeStatus) || st(t.mode) || {};
    map = s.states && typeof s.states === 'object' && Object.keys(s.states).length ? s.states : { 1: 'Komfort', 2: 'Standby', 3: 'Nacht', 4: 'Frostschutz' };
  }
  return Object.entries(map).map(([k, v]) => [k, String(v)]);
}

function thermoMode(t) {
  const id = t.modeStatus || t.mode;
  if (!id) return null;
  const v = val(id);
  if (v === null || v === undefined) return { key: '', text: '–' };
  const hit = thermoModes(t).find(([k]) => k === String(v));
  return { key: String(v), text: hit ? hit[1] : String(v) };
}

/** Heating: on/off data point or valve position in %. */
function thermoHeat(t) {
  if (!t.heating) return null;
  const v = val(t.heating);
  if (typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)))) {
    const n = Math.round(Number(v));
    return { on: n > 0, text: n > 0 ? 'Heizt ' + n + ' %' : 'Ventil zu' };
  }
  return { on: truthy(v), text: truthy(v) ? 'Heizt' : 'Heizt nicht' };
}

function thermoWindowOpen(t) {
  return Boolean(t.window) && truthy(val(t.window));
}

/** Short info for tiles and rows: mode, humidity, heating, window. */
function thermoChips(t) {
  const out = [];
  const m = thermoMode(t);
  if (m) out.push(m.text);
  if (t.humidity) out.push(fmt({ decimals: 0, unit: '%' }, t.humidity).text + ' % rF');
  const h = thermoHeat(t);
  if (h && h.on) out.push('🔥');
  if (thermoWindowOpen(t)) out.push('Fenster offen');
  return out;
}

function sendMode(t, key) {
  const s = st(t.mode) || {};
  send(t.mode, s.type !== 'string' && key !== '' && Number.isFinite(Number(key)) ? Number(key) : key);
}

/** Highlight state of a tile: 'on', 'alert' or ''. */
// ---------------- window overview ----------------

/** "3 Min.", "4 Std. 8 Min.", "12 Tage 18 Std." */
function since(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 1) return 'gerade eben';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d) return d + (d === 1 ? ' Tag ' : ' Tage ') + h + ' Std.';
  if (h) return h + ' Std. ' + min + ' Min.';
  return min + ' Min.';
}

/** Status of each window: closed / tilt / open (tilt contact wins), time since the last change. */
function windowStates(t) {
  return (t.windows || []).map(w => {
    const a = w.state ? st(w.state) : null;
    const b = w.tilt ? st(w.tilt) : null;
    const known = (a && !a.missing && a.val !== null && a.val !== undefined) || (b && !b.missing && b.val !== null && b.val !== undefined);
    const open = a && a.val !== null && a.val !== undefined ? (w.invert ? !truthy(a.val) : truthy(a.val)) : false;
    const tilt = b ? truthy(b.val) : false;
    const status = !known ? 'unknown' : tilt ? 'tilt' : open ? 'open' : 'closed';
    const ts = Math.max((a && (a.lc || a.ts)) || 0, (b && (b.lc || b.ts)) || 0);
    return { label: w.label || (w.state || w.tilt || '').split('.').pop(), status, ts };
  });
}

const WIN_TEXT = { open: 'offen', tilt: 'gekippt', closed: 'geschlossen', unknown: 'unbekannt' };

function windowsHtml(t) {
  const list = windowStates(t);
  const open = list.filter(w => w.status === 'open').length;
  const tilt = list.filter(w => w.status === 'tilt').length;
  const sum = open || tilt ? [open ? open + ' offen' : '', tilt ? tilt + ' gekippt' : ''].filter(Boolean).join(' · ') : 'alle geschlossen';
  return '<div class="whead">' + icon(tileIcon(t)) + '<span class="grow">' + esc(t.label || 'Fenster') + '</span><span class="wsum' + (open ? ' bad' : tilt ? ' warn' : '') + '">' + esc(sum) + '</span></div>' +
    '<div class="wlist">' + list.map(w =>
      '<div class="win ' + w.status + '"><span class="wic">' + icon(w.status === 'open' ? 'win-open' : w.status === 'tilt' ? 'win-tilt' : 'win-closed') + '</span><span class="wname">' + esc(w.label) + '</span>' +
      '<span class="wst">' + WIN_TEXT[w.status] + (w.ts && w.status !== 'unknown' ? ' <small>seit ' + since(w.ts) + '</small>' : '') + '</span></div>').join('') + '</div>';
}

function tileState(t) {
  if (t.type === 'windows') return windowStates(t).some(w => w.status === 'open') ? 'alert' : '';
  if (t.type === 'switch') return switchOn(t) ? 'on' : '';
  if (t.type === 'dimmer') return dimOn(t) ? 'on' : '';
  if (t.type === 'blind') return '';
  if (t.type === 'thermostat') return thermoHeat(t) && thermoHeat(t).on ? 'on' : '';
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
  if (SV.me && SV.me.control === false) return toast('Nur ansehen – du darfst hier nicht schalten', true);
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

function sidePages() {
  const l = layout();
  if (!l.side || !l.side.enabled || device() !== 'touch') return null;
  const get = ids => ids.map(id => l.pages.find(p => p.id === id)).filter(Boolean);
  const top = get(l.side.top);
  const bottom = get(l.side.bottom);
  return top.length || bottom.length ? { top, bottom } : null;
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
  // without page bar: "zurück" leads to the first page (the menu)
  $('backBtn').hidden = !(l.hideNav && !SV.editing && page && l.pages[0] && page.id !== l.pages[0].id);
  tickClock();
  renderNav();
  renderPage();
  renderSide();
  if (typeof Intercom !== 'undefined') Intercom.sync();
}

function renderNav() {
  const nav = $('nav');
  nav.textContent = '';
  const l = layout();
  const side = sidePages();
  const inSide = new Set(side ? side.top.concat(side.bottom).map(p => p.id) : []);
  for (const p of l.pages) {
    // pages shown in the right panel need no entry on the touch PC (still there in edit mode)
    if (inSide.has(p.id) && !SV.editing) continue;
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
  nav.hidden = !SV.editing && (l.hideNav || nav.children.length < 2);
  $('app').classList.toggle('nonav', nav.hidden);
}

function renderPage() {
  const main = $('main');
  main.textContent = '';
  const page = SV.page;
  if (!page) {
    main.innerHTML = SV.me && SV.me.usersEnabled && !SV.me.admin
      ? '<p class="muted">Für dich sind keine Seiten freigegeben. Bitte den Administrator fragen.</p>'
      : '<p class="muted">Noch keine Seite. Oben auf ✎ tippen und mit „+ Seite“ beginnen.</p>';
    return;
  }
  renderPageInto(main, page);
}

/** Content of a page (tiles, list or floor plan) into a container. */
function renderPageInto(box, page) {
  if (page.type === 'plan') return renderPlan(box, page);
  if (page.type === 'list') return renderList(box, page);
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const t of visibleTiles(page)) grid.appendChild(renderTile(t, page));
  if (SV.editing) {
    const add = document.createElement('div');
    add.className = 'tile addtile';
    add.innerHTML = icon('plus') + '<span>Kachel</span>';
    add.onclick = () => Editor.addTile(page);
    grid.appendChild(add);
    Editor.sortable(grid, page, '.tile[data-tile]');
  }
  box.appendChild(grid);
}

/** Optional split screen on the touch PC: panels with tabs on the right. */
function renderSide() {
  const side = $('side');
  const pages = sidePages();
  $('app').classList.toggle('split', Boolean(pages));
  side.hidden = !pages;
  side.textContent = '';
  if (!pages) return;
  SV.sideTab = SV.sideTab || {};
  for (const [key, list] of [['top', pages.top], ['bottom', pages.bottom]]) {
    if (!list.length) continue;
    const box = document.createElement('section');
    box.className = 'sidebox';
    const tabs = document.createElement('div');
    tabs.className = 'sidetabs';
    const cur = list.find(p => p.id === SV.sideTab[key]) || list[0];
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name;
      b.className = p.id === cur.id ? 'active' : '';
      b.onclick = () => {
        SV.sideTab[key] = p.id;
        renderSide();
      };
      tabs.appendChild(b);
    }
    if (list.length > 1) box.appendChild(tabs);
    const content = document.createElement('div');
    content.className = 'sidecontent';
    renderPageInto(content, cur);
    box.appendChild(content);
    side.appendChild(box);
  }
}

function renderTile(t, page) {
  const el = document.createElement('div');
  el.className = 'tile ' + t.type + ' size-' + (t.size || '1');
  el.dataset.tile = t.id;
  el.dataset.page = page.id;
  el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  fillTile(el, t);
  if (!SV.editing && Timers.supports(t)) Timers.longPress(el, () => openSheet(t));
  el.addEventListener('click', e => {
    if (SV.editing) return Editor.justDragged() || Editor.editTile(page, t);
    if (e.target.closest('button, input')) return;
    tileTap(t);
  });
  return el;
}

// ---------------- list page (rows like a classic touch panel) ----------------

function renderList(box, page) {
  const list = document.createElement('div');
  list.className = 'list';
  for (const t of visibleTiles(page)) {
    const el = document.createElement('div');
    el.className = 'lrow ' + t.type;
    el.dataset.tile = t.id;
    el.dataset.page = page.id;
    el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
    fillRow(el, t);
    if (!SV.editing && Timers.supports(t)) Timers.longPress(el, () => openSheet(t));
    el.addEventListener('click', e => {
      if (SV.editing) return Editor.justDragged() || Editor.editTile(page, t);
      if (e.target.closest('button, input')) return;
      if (['camera', 'link', 'page', 'thermostat', 'value', 'multi', 'dimmer', 'blind'].includes(t.type)) tileTap(t);
    });
    list.appendChild(el);
  }
  if (SV.editing) {
    const add = document.createElement('div');
    add.className = 'lrow addrow';
    add.innerHTML = icon('plus') + '<span>Eintrag</span>';
    add.onclick = () => Editor.addTile(page);
    list.appendChild(add);
    Editor.sortable(list, page, '.lrow[data-tile]');
  }
  box.appendChild(list);
}

/**
 * HTML from a data point (e.g. a table made by a script), shown in a shadow root so its styles stay
 * inside. Scripts, event handlers, frames, forms and javascript: links are removed - a data point
 * must not be able to run code in SmartView (which can switch things).
 */
function safeHtml(text) {
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(text === null || text === undefined ? '' : text), 'text/html');
  doc.body.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,input,button,textarea,select,noscript,template').forEach(n => n.remove());
  for (const n of doc.body.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      const v = a.value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
      if (name.startsWith('on') || (/^(href|src|xlink:href|action|formaction|srcset|poster|background)$/.test(name) && /^(javascript|vbscript|data:text\/html)/.test(v))) {
        n.removeAttribute(a.name);
      }
    }
    // pictures of the ioBroker web adapter (VIS): "/vis.0/…/img.png" or "img/x.png" -> through SmartView
    if (n.tagName === 'IMG' && n.getAttribute('src')) {
      const src = n.getAttribute('src').trim();
      if (src.startsWith('/') && !src.startsWith('//')) n.setAttribute('src', 'web' + src);
      else if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) n.setAttribute('src', 'web/vis-2/' + src);
    }
  }
  return doc.body.innerHTML;
}

function renderHtml(host, value) {
  if (!host) return;
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>:host{display:block;overflow:auto;color:inherit;font:inherit}table{border-collapse:collapse;max-width:100%}img,svg{max-width:100%}</style>' +
    (value === null || value === undefined || value === '' ? '<span style="opacity:.6">–</span>' : safeHtml(value));
}

function fillRow(el, t) {
  if (t.type === 'energy') return energyTile(el, t);
  const stt = tileState(t);
  el.classList.toggle('on', stt === 'on');
  el.classList.toggle('alert', stt === 'alert');
  el.classList.toggle('missing', missing(t));
  const head = '<span class="lic">' + icon(tileIcon(t)) + '</span><span class="lname">' + esc(t.label || '') + '</span>';
  let ctl = '';
  switch (t.type) {
    case 'heading':
      el.innerHTML = '<span class="lname">' + esc(t.label) + '</span>';
      return;
    case 'windows':
      el.classList.add('htmlrow');
      el.innerHTML = windowsHtml(t);
      return;
    case 'html':
      el.classList.add('htmlrow');
      el.innerHTML = (t.label ? '<div class="hlabel">' + esc(t.label) + '</div>' : '') + '<div class="htmlhost"></div>' + (missing(t) ? '<span class="warnmark" title="Datenpunkt nicht gefunden">⚠</span>' : '');
      renderHtml(el.querySelector('.htmlhost'), val(t.state));
      return;
    case 'switch': {
      const known = val(t.status || t.state) !== undefined && val(t.status || t.state) !== null;
      ctl = '<button type="button" class="lon" data-a="on">EIN</button><button type="button" class="loff" data-a="off">AUS</button>' +
        '<span class="lamp' + (known ? (switchOn(t) ? ' on' : ' off') : '') + '"></span>';
      break;
    }
    case 'dimmer': {
      const lvl = Math.round(dimOn(t) ? dimLevel(t) : 0);
      ctl = '<button type="button" data-a="dimdown" aria-label="dunkler">' + icon('minus') + '</button><button type="button" data-a="dimup" aria-label="heller">' + icon('plus') + '</button>' +
        '<span class="lbar"><span style="width:' + lvl + '%"></span></span><span class="lval">' + lvl + ' %</span>';
      break;
    }
    case 'blind':
      ctl = '<button type="button" data-a="up" aria-label="Auf">' + icon('up') + '</button><button type="button" data-a="down" aria-label="Ab">' + icon('down') + '</button>' +
        (t.stop ? '<button type="button" data-a="stop">STOPP</button>' : '') + '<span class="lval">' + blindText(t) + '</span>';
      break;
    case 'thermostat': {
      const f = fmt({ decimals: 1, unit: t.unit }, thermoSetId(t));
      const a = t.status ? fmt({ decimals: 1, unit: t.unit }, t.status) : null;
      const sub = (a ? ['Ist ' + a.text + ' ' + (a.unit || '°C')] : []).concat(thermoChips(t)).join(' · ');
      ctl = (sub ? '<span class="lsub">' + esc(sub) + '</span>' : '') +
        '<button type="button" data-a="minus" aria-label="weniger">' + icon('minus') + '</button><span class="lval">' + esc(f.text) + ' ' + esc(f.unit || '°C') + '</span><button type="button" data-a="plus" aria-label="mehr">' + icon('plus') + '</button>';
      break;
    }
    case 'value': {
      const f = fmt(t, t.state);
      ctl = '<span class="lval big">' + esc(f.text) + (f.unit ? ' ' + esc(f.unit) : '') + '</span>';
      break;
    }
    case 'multi':
      ctl = '<span class="lmulti">' + (t.rows || []).map(r => {
        const f = fmt({ decimals: r.decimals, unit: r.unit }, r.state);
        return '<span><small>' + esc(r.label) + '</small> ' + esc(f.text) + (f.unit ? ' ' + esc(f.unit) : '') + '</span>';
      }).join('') + '</span>';
      break;
    case 'button':
      ctl = '<button type="button" data-a="press">Auslösen</button>';
      break;
    case 'camera':
      el.innerHTML = head + (t.camera ? '<img class="camimg lcam" alt="" data-cam="' + esc(t.camera) + '">' : '');
      const img = el.querySelector('img.camimg');
      if (img) {
        loadCam(img);
        startCams();
      }
      return;
    case 'link':
    case 'page':
      ctl = '<span class="lval">›</span>';
      break;
  }
  el.innerHTML = head + '<span class="lctl">' + ctl + '</span>' + (missing(t) ? '<span class="warnmark" title="Datenpunkt nicht gefunden">⚠</span>' : '');
  bindControls(el, t);
  Timers.mark(el, t);
}

function pageName(id) {
  const p = layout().pages.find(x => x.id === id);
  return p ? p.name : '';
}

function pageIcon(id) {
  const p = layout().pages.find(x => x.id === id);
  return p ? p.icon : 'home';
}

function tileTap(t) {
  if (t.type === 'page') {
    if (t.target) location.hash = encodeURIComponent(t.target);
    return;
  }
  if (t.type === 'multi' || t.type === 'energy') return openSheet(t);
  if (t.type === 'switch' || t.type === 'dimmer') return toggle(t);
  if (t.type === 'button') return press(t);
  if (t.type === 'camera') return openCam(t.camera, t.label);
  if (t.type === 'link') return openLink(t);
  if (t.type === 'blind' || t.type === 'thermostat' || t.type === 'value') return openSheet(t);
}

function fillTile(el, t) {
  if (t.type === 'energy') return energyTile(el, t);
  const stt = tileState(t);
  el.classList.toggle('on', stt === 'on');
  el.classList.toggle('alert', stt === 'alert');
  el.classList.toggle('missing', missing(t));
  el.classList.toggle('tap', !['heading', 'html', 'windows'].includes(t.type));
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
      const f = fmt({ decimals: 1, unit: t.unit }, thermoSetId(t));
      const a = t.status ? fmt({ decimals: 1, unit: t.unit }, t.status) : null;
      const chips = thermoChips(t);
      html = '<div class="row1">' + ic + '<span class="tval">' + (a ? 'Ist ' + esc(a.text) + ' ' + esc(a.unit || '°C') : '') + '</span></div>' +
        '<div class="big">' + esc(f.text) + '<small>' + esc(f.unit || '°C') + '</small></div>' +
        (chips.length ? '<div class="tsub">' + esc(chips.join(' · ')) + '</div>' : '') + label;
      break;
    }
    case 'camera':
      html = (t.camera ? '<img class="camimg" alt="" data-cam="' + esc(t.camera) + '">' : '<div class="planempty">Keine Kamera gewählt</div>') + '<span class="camlbl">' + esc(t.label || '') + '</span>';
      break;
    case 'link':
      html = '<div class="row1">' + ic + '</div>' + label;
      break;
    case 'page':
      // menu button: name top left, large symbol bottom right
      html = '<div class="pname">' + esc(t.label || pageName(t.target)) + '</div><span class="pic">' + icon(t.icon || pageIcon(t.target)) + '</span>';
      break;
    case 'html':
      html = (t.label ? '<div class="hlabel">' + esc(t.label) + '</div>' : '') + '<div class="htmlhost"></div>';
      break;
    case 'windows':
      html = windowsHtml(t);
      break;
    case 'multi': {
      const rows = t.rows || [];
      if (rows.length === 1) {
        const f = fmt({ decimals: rows[0].decimals, unit: rows[0].unit }, rows[0].state);
        html = '<div class="row1">' + ic + '</div><div class="big">' + esc(f.text) + (f.unit ? '<small>' + esc(f.unit) + '</small>' : '') + '</div>' + label;
      } else {
        html = '<div class="mhead">' + ic + '<span class="mlabel">' + esc(t.label || '') + '</span></div><div class="mrows">' + rows.map(r => {
          const f = fmt({ decimals: r.decimals, unit: r.unit }, r.state);
          return '<div class="mrow"><span>' + esc(r.label) + '</span><b>' + esc(f.text) + (f.unit ? ' ' + esc(f.unit) : '') + '</b></div>';
        }).join('') + '</div>';
      }
      break;
    }
  }
  if (missing(t)) html += '<span class="warnmark" title="Datenpunkt nicht gefunden">⚠</span>';
  el.innerHTML = html;
  if (t.type === 'html') renderHtml(el.querySelector('.htmlhost'), val(t.state));
  bindControls(el, t);
  Timers.mark(el, t);
  el.classList.toggle('multirow', t.type === 'multi' && (t.rows || []).length > 1);
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
      if (SV.editing) {
        const p = pageOf(el);
        return p && Editor.editTile(p, t);
      }
      const a = b.dataset.a;
      if (a === 'dimup' || a === 'dimdown') {
        const cur = dimOn(t) ? dimLevel(t) : 0;
        const next = Math.max(0, Math.min(100, Math.round((cur + (a === 'dimup' ? 10 : -10)) / 10) * 10));
        if (t.switchState && next > 0 && !dimOn(t)) send(t.switchState, true);
        if (t.state) send(t.state, next);
        else if (t.switchState) send(t.switchState, next > 0);
        return;
      }
      if (a === 'up') blindWrite(t, 100);
      else if (a === 'down') blindWrite(t, 0);
      else if (a === 'stop') send(t.stop, true);
      else if (a === 'plus') thermoStep(t, 1);
      else if (a === 'minus') thermoStep(t, -1);
      else if (a === 'mode') sendMode(t, b.dataset.v);
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
    const t = el.classList.contains('sheet') ? SV.sheet && SV.sheet.tile : findTile(el.dataset.page, el.dataset.tile);
    if (!t) continue;
    if (el.classList.contains('lrow')) fillRow(el, t);
    else if (el.classList.contains('marker')) fillMarker(el, t);
    else if (el.classList.contains('sheet')) fillSheet(el, t);
    else fillTile(el, t);
  }
  if (layout() && id === layout().ring.state) checkRing();
}

function findTile(pageId, id) {
  const page = layout().pages.find(p => p.id === pageId);
  return page ? page.tiles.find(t => t.id === id) : null;
}

/** Page of a rendered tile/row/marker element. */
function pageOf(el) {
  const holder = el.closest('[data-page]');
  return holder ? layout().pages.find(p => p.id === holder.dataset.page) : null;
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
  el.dataset.page = page.id;
  el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  el.style.left = t.x + '%';
  el.style.top = t.y + '%';
  fillMarker(el, t);
  if (SV.editing) {
    el.addEventListener('pointerdown', e => Editor.markerDown(e, page, t, el));
  } else {
    if (Timers.supports(t)) Timers.longPress(el, () => openSheet(t));
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
  else if (t.type === 'energy') {
    const d = energyData(t);
    v = d && d.s ? EnergyView.fmtW(d.s.pv) : '';
  }
  else if (t.type === 'windows') {
    const n = windowStates(t).filter(w => w.status !== 'closed' && w.status !== 'unknown').length;
    v = n ? n + ' offen' : '';
  } else if (t.type === 'thermostat') {
    const f = fmt({ decimals: 1, unit: t.unit }, t.status || t.state);
    v = f.text + (f.unit ? ' ' + f.unit : ' °C');
  }
  el.title = t.label || '';
  el.innerHTML = '<div class="dot">' + icon(tileIcon(t)) + '</div>' + (v ? '<div class="mval">' + esc(v) + '</div>' : '');
  Timers.mark(el, t);
}

// ---------------- energy flow (ioBroker.energie, www/energy-view.js) ----------------

function energyData(t) {
  try {
    const v = val(t.state);
    return typeof v === 'string' && v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function energyCss() {
  if (document.getElementById('energyCss')) return;
  const st = document.createElement('style');
  st.id = 'energyCss';
  st.textContent = EnergyView.css;
  document.head.appendChild(st);
}

/** Tile / list row: the flow is built once and then only updated (the animation keeps running). */
function energyTile(el, t) {
  energyCss();
  el.classList.add('energy', 'tap');
  if (el.classList.contains('lrow')) el.classList.add('htmlrow');
  if (!el._ef || !el.contains(el._ef.box)) {
    el.innerHTML = (t.label ? '<div class="hlabel">' + esc(t.label) + '</div>' : '') +
      (t.instance ? '<div class="eflow"></div>' + (t.show === 'stats' ? '<div class="estats"></div>' : '') : '<div class="planempty">Keine Energie-Instanz gewählt</div>');
    const box = el.querySelector('.eflow');
    el._ef = { box, flow: box ? EnergyView.flow(box) : null };
  }
  const d = energyData(t);
  el.classList.toggle('missing', Boolean(t.instance) && !d);
  if (d && d.s && el._ef.flow) {
    el._ef.flow.update(d.s, d.view);
    const st = el.querySelector('.estats');
    if (st) EnergyView.stats(st, d.today, d.s.battery !== null);
  }
}

/** Large view: flow, today's values, day chart with day navigation. */
function energySheet(sh, t) {
  energyCss();
  sh.classList.add('energy');
  if (!sh._ef) {
    sh.innerHTML = '<h3><span class="grow">' + esc(t.label || 'Energiefluss') + '</span><button type="button" class="iconbtn" data-close aria-label="Schließen">' + icon('close') + '</button></h3>' +
      '<div class="egrid"><div class="eflow"></div><div><div class="estats"></div><div class="echead"><b data-title>Tagesverlauf heute</b><span class="grow"></span>' +
      '<button type="button" class="iconbtn" data-prev aria-label="Tag davor">‹</button><button type="button" class="iconbtn" data-next aria-label="Tag danach">›</button></div><div class="echart"></div></div></div>';
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh._ef = { flow: EnergyView.flow(sh.querySelector('.eflow')), date: null, dates: [], today: null };
    const load = async date => {
      try {
        const day = await api('energy/day?instance=' + encodeURIComponent(t.instance) + (date ? '&date=' + date : ''));
        if (day.error) throw new Error(day.error);
        sh._ef.date = date;
        sh._ef.dates = day.dates || [];
        sh._ef.today = sh._ef.today || (!date ? day.date : null);
        sh.querySelector('[data-title]').textContent = date ? new Date(day.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Tagesverlauf heute';
        EnergyView.chart(sh.querySelector('.echart'), day);
        sh.querySelector('[data-prev]').disabled = sh._ef.dates.indexOf(day.date) <= 0;
        sh.querySelector('[data-next]').disabled = !date;
      } catch (e) {
        sh.querySelector('.echart').innerHTML = '<p class="muted">' + esc(e.message) + '</p>';
      }
    };
    sh.querySelector('[data-prev]').onclick = () => {
      const i = sh._ef.dates.indexOf(sh._ef.date || sh._ef.today);
      if (i > 0) load(sh._ef.dates[i - 1]);
    };
    sh.querySelector('[data-next]').onclick = () => {
      const i = sh._ef.dates.indexOf(sh._ef.date);
      const next = sh._ef.dates[i + 1];
      load(next && next !== sh._ef.today ? next : null);
    };
    load(null);
  }
  const d = energyData(t);
  if (d && d.s) {
    sh._ef.flow.update(d.s, d.view);
    EnergyView.stats(sh.querySelector('.estats'), d.today, d.s.battery !== null);
  }
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
  if (t.type === 'energy') return energySheet(sh, t);
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
    const f = fmt({ decimals: 1, unit: t.unit }, thermoSetId(t));
    const u = x => esc(x.unit || '°C');
    const info = [];
    if (t.status) {
      const a = fmt({ decimals: 1, unit: t.unit }, t.status);
      info.push(['Raumtemperatur', esc(a.text) + ' ' + u(a)]);
    }
    if (t.humidity) info.push(['Luftfeuchte', esc(fmt({ decimals: 0, unit: '%' }, t.humidity).text) + ' %']);
    const m = thermoMode(t);
    if (m) info.push(['Betriebsart', esc(m.text)]);
    const h = thermoHeat(t);
    if (h) info.push(['Heizung', esc(h.text)]);
    if (t.window) info.push(['Fenster', thermoWindowOpen(t) ? '<span class="bad">offen</span>' : 'zu']);
    body = '<p class="muted" style="text-align:center;margin:0">Soll</p><div class="bigval">' + esc(f.text) + ' ' + u(f) + '</div>' +
      '<div class="row"><button type="button" data-a="minus" aria-label="kälter">' + icon('minus') + '</button><button type="button" data-a="plus" aria-label="wärmer">' + icon('plus') + '</button></div>' +
      (t.mode ? '<div class="row modes">' + thermoModes(t).map(([k, v]) => '<button type="button" data-a="mode" data-v="' + esc(k) + '"' + (m && m.key === k ? ' class="primary"' : '') + '>' + esc(v) + '</button>').join('') + '</div>' : '') +
      (info.length ? '<div class="mrows sheetrows">' + info.map(([k, v]) => '<div class="mrow"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' : '');
  } else if (t.type === 'value') {
    const f = fmt(t, t.state);
    const s = st(t.state);
    body = '<div class="bigval">' + esc(f.text) + (f.unit ? ' <small>' + esc(f.unit) + '</small>' : '') + '</div>' +
      (s && s.ts ? '<p class="muted" style="text-align:center">aktualisiert ' + new Date(s.ts).toLocaleString('de-DE') + '</p>' : '');
  } else if (t.type === 'button') {
    body = '<div class="row"><button type="button" data-a="press" class="primary">Auslösen</button></div>';
  } else if (t.type === 'windows') {
    body = '<div class="winsheet">' + windowsHtml(t) + '</div>';
  } else if (t.type === 'html') {
    body = '<div class="htmlhost sheethtml"></div>';
  } else if (t.type === 'multi') {
    body = '<div class="mrows sheetrows">' + (t.rows || []).map(r => {
      const f = fmt({ decimals: r.decimals, unit: r.unit }, r.state);
      return '<div class="mrow"><span>' + esc(r.label) + '</span><b>' + esc(f.text) + (f.unit ? ' ' + esc(f.unit) : '') + '</b></div>';
    }).join('') + '</div>';
  }
  sh.innerHTML = '<h3>' + icon(tileIcon(t)) + '<span class="grow">' + esc(t.label || '') + '</span><button type="button" class="iconbtn" data-close aria-label="Schließen">' + icon('close') + '</button></h3>' + body;
  if (Timers.supports(t) && !SV.editing) {
    body = '<div class="row"><button type="button" data-timer>⏰ Zeitschaltuhr' + (Timers.active(t) ? ' (aktiv)' : '') + '</button></div>';
    sh.insertAdjacentHTML('beforeend', body);
    sh.querySelector('[data-timer]').onclick = () => Timers.open(t);
  }
  sh.querySelector('[data-close]').onclick = closeSheet;
  if (t.type === 'html') renderHtml(sh.querySelector('.htmlhost'), val(t.state));
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
  // with the livecam intercom the call screen comes from intercom.js
  if (r.intercom || !r.state || !r.camera) return;
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
  ov.innerHTML = '<div class="sheet menu"><h3>' + icon('menu') + '<span class="grow">Einstellungen</span><button type="button" class="iconbtn" data-close>' + icon('close') + '</button></h3><div data-push class="muted">Mitteilungen werden geprüft …</div><div data-ic></div><div data-users></div>' +
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
  if (typeof Intercom !== 'undefined') Intercom.menuItems(ov.querySelector('[data-ic]'));
  Users.menuItems(ov.querySelector('[data-users]'));
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
      Timers.load();
      checkRing();
    } else if (msg.type === 'state') {
      SV.states[msg.id] = msg.state;
      refresh(msg.id);
    } else if (msg.type === 'timers') {
      Timers.load();
    } else if (msg.type === 'layout') {
      if (SV.saving) return; // our own save, handled in Editor.save
      if (SV.editing) toast('Die Ansicht wurde auf einem anderen Gerät geändert.');
      else loadLayout().then(() => ws.close(), () => location.reload());
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
  const res = await fetch('api/layout', { credentials: 'same-origin', cache: 'no-store' });
  const r = await res.json().catch(() => ({}));
  if (res.status === 401 && r.login) {
    const err = new Error(r.error || 'Bitte anmelden');
    err.login = true;
    err.title = r.title;
    throw err;
  }
  if (!res.ok) throw new Error(r.error || 'HTTP ' + res.status);
  SV.me = r.me || null;
  SV.layout = r.layout;
  SV.allowEdit = r.allowEdit;
  SV.icons = r.icons;
  SV.types = r.types;
}

function tickClock() {
  const d = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const l = layout();
  $('clock').textContent = l && l.showDate ? d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(',', '') + '  ' + time : time;
}

// start when all scripts (timers.js, intercom.js, users.js, edit.js) are loaded: on a slow first load
// the layout can arrive before them ("Timers is not defined")
async function start() {
  $('menuBtn').innerHTML = icon('menu');
  $('editBtn').innerHTML = icon('edit');
  $('menuBtn').onclick = openMenu;
  $('editBtn').onclick = () => Editor.start();
  $('backBtn').innerHTML = icon('back') + '<span>zurück</span>';
  $('backBtn').onclick = () => {
    location.hash = encodeURIComponent(layout().pages[0].id);
  };
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
  // window overview: keep the "seit …" times current
  setInterval(() => {
    for (const el of document.querySelectorAll('.tile.windows, .lrow.windows')) {
      const t = findTile(el.dataset.page, el.dataset.tile);
      if (t) (el.classList.contains('lrow') ? fillRow : fillTile)(el, t);
    }
  }, 30000);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await loadLayout();
    render();
    connect();
  } catch (e) {
    if (e.login) return Users.showLogin(e.title);
    $('main').innerHTML = '<p>Verbindung zum ioBroker fehlgeschlagen: ' + esc(e.message) + '</p>';
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
