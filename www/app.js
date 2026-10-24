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

const DEFAULT_ICON = { wallbox: 'charger', planview: 'map', gate: 'gate', energy: 'energy', windows: 'window', html: 'grid', page: 'home', multi: 'gauge', switch: 'bulb', dimmer: 'bulb', blind: 'blind', value: 'gauge', button: 'scene', thermostat: 'thermometer', camera: 'camera', link: 'link', heading: 'info' };

function tileIcon(t) {
  return t.icon || DEFAULT_ICON[t.type] || 'info';
}

/** Symbol of a tile, rotated when set in the tile dialog. */
function tileIc(t) {
  const svg = icon(tileIcon(t));
  return t.rotate ? svg.replace('<svg ', '<svg style="transform:rotate(' + Number(t.rotate) + 'deg)" ') : svg;
}

function tileIds(t) {
  return ['state', 'status', 'switchState', 'stop', 'setStatus', 'humidity', 'mode', 'modeStatus', 'heating', 'window', 'windAlarm', 'rainAlarm', 'open', 'close', 'posOpen', 'posClosed', 'plugged', 'energy', 'ctrl', 'current'].map(k => t[k])
    .concat((t.rows || []).map(r => r.state))
    .concat((t.circuits || []).flatMap(c => CIRC_KEYS.map(k => c[k])))
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
  const lock = blindLock(t);
  if (lock) return lockText(lock);
  const s = st(t.status || t.state);
  if (!s || s.missing || s.val === null || s.val === undefined) return '–';
  // an up/down object (true/false) says nothing about the position
  if (s.type === 'boolean' || typeof s.val === 'boolean') return '';
  const o = Math.round(blindOpen(t));
  // awning: "open" = retracted
  if (t.kind === 'awning') return o >= 99 ? 'Eingefahren' : o <= 1 ? 'Ausgefahren' : 100 - o + ' % ausgefahren';
  return o >= 99 ? 'Offen' : o <= 1 ? 'Zu' : o + ' % offen';
}

/** Words for the blind buttons (awning: retract / extend). */
function blindWords(t) {
  return t.kind === 'awning' ? ['Einfahren', 'Ausfahren'] : ['Auf', 'Ab'];
}

// ---------------- wind/rain lock (set by the adapter, sent as {type:'locks'}) ----------------

function tileKey(t) {
  for (const p of layout().pages) if (p.tiles.includes(t)) return p.id + '/' + t.id;
  return '';
}

function blindLock(t) {
  return t.type === 'blind' && SV.locks ? SV.locks[tileKey(t)] || null : null;
}

function lockText(l) {
  if (!l.until) return '🔒 ' + l.reason;
  const s = Math.max(0, Math.round((l.until - Date.now()) / 1000));
  return '🔒 noch ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Blind locked: say why instead of sending. */
function blindBlocked(t) {
  const l = blindLock(t);
  if (!l) return false;
  toast((t.kind === 'awning' ? 'Markise' : 'Rollladen') + ' gesperrt: ' + l.reason + (l.until ? ' – ' + lockText(l).replace('🔒 ', '') : ' (solange der Alarm ansteht)'), true);
  return true;
}

/** the server sends the remaining time; the end is counted with this device's clock */
function clientLocks(locks) {
  const out = {};
  for (const [k, l] of Object.entries(locks || {})) out[k] = { reason: l.reason, until: l.left ? Date.now() + l.left : null };
  return out;
}

function refreshLocked() {
  for (const p of layout() ? layout().pages : []) for (const t of p.tiles) if (t.type === 'blind' && (t.windAlarm || t.rainAlarm)) refresh(t.state || t.status);
}

// ---------------- gate ----------------

/** open | closed | moving | unknown from the end position data points */
function gateStatus(t) {
  const on = id => truthy(val(id));
  const known = id => id && val(id) !== undefined && val(id) !== null;
  if (!known(t.posOpen) && !known(t.posClosed)) return 'unknown';
  if (known(t.posOpen) && on(t.posOpen)) return 'open';
  if (known(t.posClosed) && on(t.posClosed)) return 'closed';
  if (t.posOpen && t.posClosed) return 'moving';
  return t.posOpen ? 'closed' : 'open';
}

function gateText(t) {
  return { open: 'Offen', closed: 'Geschlossen', moving: 'Fährt / Zwischenstellung', unknown: '' }[gateStatus(t)];
}

/** Open / close / stop with checks: already open or closed -> say so, nothing is sent. */
function gateCmd(t, dir) {
  const name = t.label || 'Das Tor';
  const stt = gateStatus(t);
  if (dir === 'open' && stt === 'open') return toast(name + ' ist schon offen');
  if (dir === 'close' && stt === 'closed') return toast(name + ' ist schon zu');
  const single = t.gateMode === 'single';
  const impulse = single ? t.single === 'impulse' : t.impulse;
  if (single && t.single === 'impulse' && dir !== 'stop' && (stt === 'unknown' || stt === 'moving')) {
    if (!confirm('Stellung von „' + name + '“ unbekannt. Impuls trotzdem senden? Das Tor fährt dann in die nächste Richtung oder bleibt stehen.')) return;
  } else if (t.confirm && dir !== 'stop' && !confirm(name + (dir === 'open' ? ' öffnen?' : ' schließen?'))) return;
  const id = dir === 'stop' ? t.stop : single ? t.state : dir === 'open' ? t.open : t.close;
  if (!id) return toast('Kein Datenpunkt für ' + (dir === 'open' ? 'Auf' : dir === 'close' ? 'Zu' : 'Stopp'), true);
  if (single && t.single === 'level' && dir !== 'stop') return send(id, dir === 'open');
  if (impulse) return pulse(id);
  send(id, true);
}

function pulse(id) {
  if (SV.me && SV.me.control === false) return toast('Nur ansehen – du darfst hier nicht schalten', true);
  if (!SV.ws || SV.ws.readyState !== 1) return toast('Keine Verbindung zum ioBroker', true);
  SV.ws.send(JSON.stringify({ type: 'pulse', id, ms: 1000 }));
}

function gateButtons(t, big) {
  const b = (a, ic, txt) => '<button type="button" data-a="' + a + '" aria-label="' + txt + '">' + icon(ic) + (big ? txt : '') + '</button>';
  return b('gopen', 'up', 'Auf') + (t.stop ? b('gstop', 'stop', 'Stopp') : '') + b('gclose', 'down', 'Zu');
}

// ---------------- wallbox (adapter versicharge + surplus charging of energie) ----------------

const WB_MODES = { pv: 'PV', minpv: 'Min+PV', fast: 'Schnell', off: 'Aus', manual: 'Manuell' };

function wbModes(t) {
  const s = st(t.mode) || {};
  const map = s.states && typeof s.states === 'object' && Object.keys(s.states).length ? s.states : WB_MODES;
  return Object.entries(map).map(([k, v]) => [k, String(v)]);
}

function wbModeText(t) {
  const v = val(t.mode);
  const hit = wbModes(t).find(([k]) => k === String(v));
  return hit ? hit[1] : '';
}

function wbPower(t) {
  const v = Number(val(t.state));
  return t.state && val(t.state) !== null && val(t.state) !== undefined && Number.isFinite(v) ? v : null;
}

function wbCharging(t) {
  const p = wbPower(t);
  return p !== null ? p >= 50 : /^Lädt/.test(String(val(t.status) || ''));
}

function wbFault(t) {
  return /Fehler|Störung/.test(String(val(t.status) || ''));
}

/** big value: power while charging, else the mode */
function wbBig(t) {
  const p = wbPower(t);
  if (wbCharging(t) && p !== null) return EnergyView.fmtW(p);
  return wbModeText(t) || (p !== null ? EnergyView.fmtW(p) : '–');
}

function wbLine(t) {
  const plugged = t.plugged ? val(t.plugged) : undefined;
  const status = String(val(t.status) || (plugged === undefined || plugged === null ? '' : truthy(plugged) ? 'Auto angesteckt' : 'Kein Auto angesteckt'));
  // while waiting the control's text says more ("Wartet auf Überschuss", "Startet in 0:40");
  // a limit (heat pump, import limit, "not ready in time") is shown while charging too
  const ctrl = t.ctrl ? String(val(t.ctrl) || '') : '';
  if (!ctrl || /Kein Auto/.test(status) || wbFault(t)) return status;
  return !wbCharging(t) || wbLimited(t) ? ctrl : status;
}

/** energie limits the car (heat pump runs, import limit) */
function wbLimited(t) {
  return Boolean(t.ctrl) && /Wärmepumpe|Bezugsgrenze/.test(String(val(t.ctrl) || ''));
}

function wbModeButtons(t) {
  const cur = String(val(t.mode));
  return wbModes(t).map(([k, v]) => '<button type="button" data-a="wbmode" data-v="' + esc(k) + '"' + (k === cur ? ' class="primary"' : '') + '>' + esc(v) + '</button>').join('');
}

/** manual current (only when energie does not control: mode Manuell or no mode data point) */
function wbManual(t) {
  return t.current && (!t.mode || String(val(t.mode)) === 'manual');
}

function wbCurrentStep(t, d) {
  const s = st(t.current) || {};
  const max = Number.isFinite(Number(s.max)) && Number(s.max) >= 6 ? Number(s.max) : 32;
  const cur = Number(val(t.current)) || 0;
  const next = d > 0 ? (cur < 6 ? 6 : Math.min(max, Math.floor(cur) + 1)) : cur <= 6 ? 0 : Math.ceil(cur) - 1;
  send(t.current, next);
}

function blindWrite(t, openPercent) {
  if (blindBlocked(t)) return;
  const s = st(t.state);
  if (s && s.type === 'boolean') {
    // up/down object (KNX DPT 1.008: false = up, true = down); "Auf/Ab umdrehen" swaps it
    if (openPercent > 0 && openPercent < 100) return toast('Zwischenwerte gehen nur mit einem Positions-Datenpunkt (%)', true);
    const down = openPercent === 0;
    return send(t.state, t.closed100 ? !down : down);
  }
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

// ---------------- heating circuits: one tile, several circuits to switch between ----------------

const CIRC_KEYS = ['state', 'setStatus', 'status', 'humidity', 'mode', 'modeStatus', 'heating', 'window'];

/** [{label, state, …}] - the tile's own fields are circuit 1; null without extra circuits */
function thermoCircuits(t) {
  if (!Array.isArray(t.circuits) || !t.circuits.length) return null;
  const pick = (c, label) => Object.assign({ label, modes: c.modes || '' }, ...CIRC_KEYS.map(k => ({ [k]: c[k] || '' })));
  return [pick(t, t.circLabel || 'Kreis 1')].concat(t.circuits.map((c, i) => pick(c, c.label || 'Kreis ' + (i + 2))));
}

/** chosen circuit per tile and device */
function circKey(t) {
  return 'sv.circ.' + t.id + '.' + (t.label || '');
}

function circIndex(t, n) {
  try {
    return Math.min(n - 1, Math.max(0, Number(localStorage.getItem(circKey(t))) || 0));
  } catch (e) {
    return SV.circ && SV.circ[circKey(t)] ? Math.min(n - 1, SV.circ[circKey(t)]) : 0;
  }
}

/** the tile as seen with its chosen circuit (all display and control code works on this) */
function thermoCur(t) {
  const list = thermoCircuits(t);
  if (!list) return t;
  const i = circIndex(t, list.length);
  const out = { ...t, _circ: i, _circs: list };
  for (const k of CIRC_KEYS) out[k] = list[i][k];
  // mode texts belong to the circuit (FBH: 4 = Normal, radiators: 2 = Normal)
  out.modes = list[i].modes;
  return out;
}

function circSwitch(t, i) {
  const list = thermoCircuits(t);
  if (!list) return;
  const n = ((i % list.length) + list.length) % list.length;
  try {
    localStorage.setItem(circKey(t), String(n));
  } catch (e) {
    SV.circ = SV.circ || {};
    SV.circ[circKey(t)] = n;
  }
  const sheetOpen = document.querySelector('.sheet[data-tile="' + CSS.escape(t.id) + '"]');
  renderPage();
  renderSide();
  if (sheetOpen) openSheet(t);
}

/** ‹ circuit › on the tile, or chips in the sheet */
function circSwitcher(c, chips) {
  if (!c._circs) return '';
  if (chips) return '<div class="row modes circs">' + c._circs.map((x, i) => '<button type="button" data-a="circsel" data-v="' + i + '"' + (i === c._circ ? ' class="primary"' : '') + '>' + esc(x.label) + '</button>').join('') + '</div>';
  return '<div class="circsw"><button type="button" data-a="circ" data-v="-1" aria-label="voriger Kreis">‹</button><span>' + esc(c._circs[c._circ].label) + '</span><button type="button" data-a="circ" data-v="1" aria-label="nächster Kreis">›</button></div>';
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

/**
 * Mode buttons as [[value, text]]: own texts, texts of the data point that is written ("Betriebsart umschalten"),
 * or KNX HVAC modes. Never from the feedback/status data point - its numbers may mean something else
 * (Ochsner: status 1 = Normal Heizbetrieb, mode 1 = Automatik).
 */
function thermoModes(t) {
  let map = parseTexts(t.modes);
  if (!Object.keys(map).length) {
    const s = st(t.mode) || {};
    map = s.states && typeof s.states === 'object' && Object.keys(s.states).length ? s.states : { 1: 'Komfort', 2: 'Standby', 3: 'Nacht', 4: 'Frostschutz' };
  }
  return Object.entries(map).map(([k, v]) => [k, String(v)]);
}

/** button to highlight: the value of the mode data point itself */
function thermoModeKey(t) {
  if (!t.mode) return '';
  const v = val(t.mode);
  return v === null || v === undefined ? '' : String(v);
}

/** mode shown as text: the feedback/status data point with its own texts, else the mode data point */
function thermoMode(t) {
  if (t.modeStatus) {
    const v = val(t.modeStatus);
    if (v === null || v === undefined) return { key: '', text: '–' };
    const s = st(t.modeStatus) || {};
    const text = s.states && typeof s.states === 'object' && s.states[String(v)] !== undefined ? String(s.states[String(v)]) : null;
    return { key: String(v), text: text || String(v) };
  }
  if (!t.mode) return null;
  const k = thermoModeKey(t);
  if (k === '') return { key: '', text: '–' };
  const hit = thermoModes(t).find(([x]) => x === k);
  return { key: k, text: hit ? hit[1] : k };
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
    const has = x => x && !x.missing && x.val !== null && x.val !== undefined;
    const known = has(a) || has(b);
    // contact 1 / contact 2 open (true), each optionally inverted
    const k1 = has(a) ? (w.invert ? !truthy(a.val) : truthy(a.val)) : false;
    const k2 = has(b) ? (w.invert2 ? !truthy(b.val) : truthy(b.val)) : false;
    let status;
    if (!known) status = 'unknown';
    else if (w.logic === 'both') status = k1 && k2 ? 'open' : k1 || k2 ? 'tilt' : 'closed';
    else if (w.logic === 'table') status = { z: 'closed', t: 'tilt', o: 'open' }[String(w.map || 'ztoo')[(k1 ? 1 : 0) + (k2 ? 2 : 0)]] || 'closed';
    else status = k2 ? 'tilt' : k1 ? 'open' : 'closed';
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
  return '<div class="whead">' + tileIc(t) + '<span class="grow">' + esc(t.label || 'Fenster') + '</span><span class="wsum' + (open ? ' bad' : tilt ? ' warn' : '') + '">' + esc(sum) + '</span></div>' +
    '<div class="wlist">' + list.map(w =>
      '<div class="win ' + w.status + '"><span class="wic">' + icon(w.status === 'open' ? 'win-open' : w.status === 'tilt' ? 'win-tilt' : 'win-closed') + '</span><span class="wname">' + esc(w.label) + '</span>' +
      '<span class="wst">' + WIN_TEXT[w.status] + (w.ts && w.status !== 'unknown' ? ' <small>seit ' + since(w.ts) + '</small>' : '') + '</span></div>').join('') + '</div>';
}

function tileState(t) {
  if (t.type === 'windows') return windowStates(t).some(w => w.status === 'open') ? 'alert' : '';
  if (t.type === 'switch') return switchOn(t) ? 'on' : '';
  if (t.type === 'dimmer') return dimOn(t) ? 'on' : '';
  if (t.type === 'blind') return blindLock(t) ? 'alert' : '';
  if (t.type === 'gate') return gateStatus(t) === 'open' ? 'on' : gateStatus(t) === 'moving' ? 'alert' : '';
  if (t.type === 'wallbox') return wbFault(t) ? 'alert' : wbCharging(t) ? 'on' : '';
  if (t.type === 'thermostat') {
    const c = thermoCur(t);
    return thermoHeat(c) && thermoHeat(c).on ? 'on' : '';
  }
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
  return l.pages.find(p => p.id === id) || l.pages.find(p => !p.hidden) || l.pages[0] || null;
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
    if ((inSide.has(p.id) || p.hidden) && !SV.editing) continue;
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

// ---------------- free grid (page.free): tiles at column gx / row gy ----------------

/**
 * Rows a content tile (energy flow, HTML, windows, plan) really needs in the free grid, measured in the browser;
 * kept per tile object, not saved in the layout.
 */
const autoRows = new WeakMap();

/** Columns and rows a tile takes in the free grid. */
function freeSpan(t, cols) {
  if (t.type === 'heading') return { w: cols, h: 1 };
  const s = AUTO_H.includes(t.type)
    ? { w: t.size === 'l' ? cols : t.type === 'planview' ? 3 : 2, h: autoRows.get(t) || 1 }
    : { w: t.size === 'w' || t.size === 'l' ? 2 : 1, h: t.size === 'l' ? 2 : 1 };
  // own size from the tile dialog or the size grip
  if (t.sw) s.w = t.sw;
  if (t.sh) s.h = t.sh;
  return { w: Math.min(s.w, cols), h: s.h };
}

/** tile types whose height follows their content (unless a height is set) */
const AUTO_H = ['html', 'windows', 'energy', 'planview'];

/** Columns/rows of a tile element; fixed height for normal tiles, minimum height for content tiles. */
function sizeTile(el, t, w, h, withRow) {
  el.style.gridColumn = (withRow ? t.gx + ' / ' : '') + 'span ' + w;
  if (withRow || t.sh) el.style.gridRow = (withRow ? t.gy + ' / ' : '') + 'span ' + h;
  const px = 'calc(' + h + ' * var(--th) + ' + (h - 1) + ' * var(--gap))';
  // a content tile with its own height keeps exactly that height (content scrolls / the flow is scaled) - otherwise a
  // taller content would stretch the rows and pull the tiles beside it apart; a plan tile is fitted into it
  el.classList.toggle('fixh', Boolean(AUTO_H.includes(t.type) && t.sh));
  if (AUTO_H.includes(t.type) && !t.sh) el.style.minHeight = '';
  else el.style.height = px;
}

/** Normal grid: own sizes, never wider than the columns there are (phone: 2). */
function applySizes(grid, page) {
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  for (const el of grid.querySelectorAll(':scope > .tile[data-tile]')) {
    const t = page.tiles.find(x => x.id === el.dataset.tile);
    if (t && (t.sw || t.sh || t.type === 'planview')) {
      const s = freeSpan(t, cols);
      sizeTile(el, t, s.w, s.h, false);
    }
  }
}

/** Gives tiles without a (valid) place the first free cell; later tiles that overlap earlier ones move too. */
function layoutFree(tiles, cols, keep) {
  const used = new Set();
  const fits = (gx, gy, s) => {
    if (gx < 1 || gx + s.w - 1 > cols || gy < 1) return false;
    for (let x = gx; x < gx + s.w; x++) for (let y = gy; y < gy + s.h; y++) if (used.has(x + ',' + y)) return false;
    return true;
  };
  const take = (t, s) => {
    for (let x = t.gx; x < t.gx + s.w; x++) for (let y = t.gy; y < t.gy + s.h; y++) used.add(x + ',' + y);
  };
  // the tile just dropped keeps its place, the others make room
  const order = keep ? [tiles.find(t => t.id === keep), ...tiles.filter(t => t.id !== keep)].filter(Boolean) : tiles;
  const later = [];
  for (const t of order) {
    const s = freeSpan(t, cols);
    if (t.type === 'heading') t.gx = 1;
    if (t.gx && t.gy && fits(t.gx, t.gy, s)) take(t, s);
    else later.push(t);
  }
  for (const t of later) {
    const s = freeSpan(t, cols);
    for (let gy = 1; ; gy++) {
      let gx = 1;
      while (gx <= cols && !fits(gx, gy, s)) gx++;
      if (gx <= cols) {
        t.gx = gx;
        t.gy = gy;
        take(t, s);
        break;
      }
    }
  }
  return used;
}

/** Free grid only where the columns are wide enough; on the phone the tiles just follow each other. */
function freeNarrow(box, page) {
  return (box.clientWidth || innerWidth) / (page.cols || 6) < 105;
}

/** Content of a page (tiles, list or floor plan) into a container. */
function renderPageInto(box, page) {
  if (page.type === 'plan') return renderPlan(box, page);
  if (page.type === 'list') return renderList(box, page);
  const grid = document.createElement('div');
  grid.className = 'grid';
  let tiles = visibleTiles(page);
  const free = page.free && !freeNarrow(box, page);
  if (page.free) {
    const cols = page.cols || 6;
    const used = layoutFree(page.tiles, cols);
    tiles = tiles.slice().sort((a, b) => a.gy - b.gy || a.gx - b.gx);
    if (free) {
      grid.classList.add('free');
      grid.style.setProperty('--cols', cols);
    }
    grid.dataset.cols = cols;
    grid._used = used;
  }
  const measure = [];
  for (const t of tiles) {
    const el = renderTile(t, page);
    if (free) {
      const s = freeSpan(t, page.cols || 6);
      sizeTile(el, t, s.w, s.h, true);
      // content tiles keep their natural height and take as many rows as that needs (else one tall row
      // would leave dead space beside them)
      if (AUTO_H.includes(t.type) && !t.sh) {
        el.style.alignSelf = 'start';
        el.style.minHeight = 'var(--th)';
        measure.push([el, t]);
      }
    }
    grid.appendChild(el);
  }
  if (free && SV.editing) {
    // empty cells (plus one more row) to drop tiles on
    const cols = page.cols || 6;
    const rows = Math.max(0, ...page.tiles.map(t => t.gy + freeSpan(t, cols).h - 1)) + 1;
    for (let gy = 1; gy <= rows; gy++) {
      for (let gx = 1; gx <= cols; gx++) {
        if (grid._used.has(gx + ',' + gy)) continue;
        const c = document.createElement('div');
        c.className = 'cell';
        c.dataset.gx = gx;
        c.dataset.gy = gy;
        c.style.gridColumn = String(gx);
        c.style.gridRow = String(gy);
        grid.appendChild(c);
      }
    }
  }
  if (SV.editing) {
    const add = document.createElement('div');
    add.className = 'tile addtile';
    add.innerHTML = icon('plus') + '<span>Kachel</span>';
    add.onclick = () => Editor.addTile(page);
    grid.appendChild(add);
    Editor.sortable(grid, page, '.tile[data-tile]');
  }
  box.appendChild(grid);
  if (!free) applySizes(grid, page);
  if (measure.length) watchRows(grid, measure);
}

/** Rows needed by content tiles; when that changes, the page is laid out again (once per change). */
function watchRows(grid, measure) {
  const css = getComputedStyle(grid);
  const th = parseFloat(css.getPropertyValue('--th')) || 130;
  const gap = parseFloat(css.rowGap) || 12;
  const check = () => {
    let changed = false;
    for (const [el, t] of measure) {
      if (!el.isConnected) continue;
      const rows = Math.max(1, Math.ceil((el.getBoundingClientRect().height + gap - 2) / (th + gap)));
      if (rows !== (autoRows.get(t) || 1)) {
        autoRows.set(t, rows);
        changed = true;
      }
    }
    if (changed && !document.querySelector('.tile.dragging')) {
      clearTimeout(watchRows.timer);
      watchRows.timer = setTimeout(() => {
        renderPage();
        renderSide();
      }, 60);
    }
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => (grid.isConnected ? check() : ro.disconnect()));
    for (const [el] of measure) ro.observe(el);
  } else setTimeout(check, 300);
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
    if (e.target.closest('button, input, .marker')) return;
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
  const head = '<span class="lic">' + tileIc(t) + '</span><span class="lname">' + esc(t.label || '') + '</span>';
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
      ctl = '<button type="button" data-a="up" aria-label="' + blindWords(t)[0] + '">' + icon('up') + '</button><button type="button" data-a="down" aria-label="' + blindWords(t)[1] + '">' + icon('down') + '</button>' +
        (t.stop ? '<button type="button" data-a="stop">STOPP</button>' : '') + '<span class="lval">' + blindText(t) + '</span>';
      break;
    case 'gate':
      ctl = gateButtons(t) + '<span class="lval">' + gateText(t) + '</span>';
      break;
    case 'wallbox':
      ctl = '<span class="lsub' + (wbLimited(t) ? ' wblim' : '') + '">' + esc(wbLine(t)) + '</span><span class="lval">' + esc(wbBig(t)) + '</span>';
      break;
    case 'thermostat': {
      const c = thermoCur(t);
      const f = fmt({ decimals: 1, unit: c.unit }, thermoSetId(c));
      const a = c.status ? fmt({ decimals: 1, unit: c.unit }, c.status) : null;
      const sub = (c._circs ? [c._circs[c._circ].label] : []).concat(a ? ['Ist ' + a.text + ' ' + (a.unit || '°C')] : []).concat(thermoChips(c)).join(' · ');
      ctl = (c._circs ? '<button type="button" data-a="circ" data-v="1" aria-label="nächster Kreis">⇄</button>' : '') + (sub ? '<span class="lsub">' + esc(sub) + '</span>' : '') +
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
  dragHandle(el);
}

/** Edit mode: grip to move a tile at once (touch screens turn a long press into a right click). */
function dragHandle(el) {
  if (SV.editing && !el.querySelector(':scope > .dragh')) el.insertAdjacentHTML('beforeend', '<span class="dragh" title="Ziehen zum Verschieben" aria-label="Verschieben">⠿</span>');
  // tiles (not list rows): grip to change the size
  if (SV.editing && el.classList.contains('tile') && !el.querySelector(':scope > .sizeh')) el.insertAdjacentHTML('beforeend', '<span class="sizeh" title="Ziehen ändert die Größe" aria-label="Größe ändern">◢</span>');
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
  // plan tile: a tap beside the symbols opens the plan page
  if (t.type === 'planview') {
    if (t.target) location.hash = encodeURIComponent(t.target);
    return;
  }
  if (t.type === 'switch' || t.type === 'dimmer') return toggle(t);
  if (t.type === 'button') return press(t);
  if (t.type === 'camera') return openCam(t.camera, t.label);
  if (t.type === 'link') return openLink(t);
  if (t.type === 'blind' || t.type === 'gate' || t.type === 'thermostat' || t.type === 'value' || t.type === 'wallbox') return openSheet(t);
}

function fillTile(el, t) {
  if (t.type === 'energy') return energyTile(el, t);
  if (t.type === 'planview') return planTile(el, t);
  const stt = tileState(t);
  el.classList.toggle('on', stt === 'on');
  el.classList.toggle('alert', stt === 'alert');
  el.classList.toggle('missing', missing(t));
  el.classList.toggle('tap', !['heading', 'html', 'windows'].includes(t.type));
  const label = '<div class="lbl">' + esc(t.label || '') + '</div>';
  const ic = '<span class="tic">' + tileIc(t) + '</span>';
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
        '<div class="ctl"><button type="button" data-a="up" aria-label="' + blindWords(t)[0] + '">' + icon('up') + '</button>' +
        (t.stop ? '<button type="button" data-a="stop" aria-label="Stopp">' + icon('stop') + '</button>' : '') +
        '<button type="button" data-a="down" aria-label="' + blindWords(t)[1] + '">' + icon('down') + '</button></div>';
      break;
    case 'gate':
      html = '<div class="row1">' + ic + '<span class="tval">' + gateText(t) + '</span></div>' + label + '<div class="ctl">' + gateButtons(t) + '</div>';
      break;
    case 'wallbox': {
      const kwh = t.energy ? fmt({ decimals: 1, unit: 'kWh' }, t.energy) : null;
      html = '<div class="row1">' + ic + '<span class="tval">' + esc(kwh && kwh.text !== '–' ? kwh.text + ' kWh' : '') + '</span></div>' +
        '<div class="big">' + esc(wbBig(t)) + '</div><div class="tsub' + (wbLimited(t) ? ' wblim' : '') + '">' + esc(wbLine(t)) + '</div>' + label +
        (t.mode && (t.size === 'l' || (t.sh || 0) >= 2) ? '<div class="ctl wbm">' + wbModeButtons(t) + '</div>' : '');
      break;
    }
    case 'value': {
      const f = fmt(t, t.state);
      html = '<div class="row1">' + ic + '</div><div class="big">' + esc(f.text) + (f.unit ? '<small>' + esc(f.unit) + '</small>' : '') + '</div>' + label;
      break;
    }
    case 'button':
      html = '<div class="row1">' + ic + '</div>' + label;
      break;
    case 'thermostat': {
      // tap opens the sheet with − / +; with several circuits ‹ › switches them on the tile
      const c = thermoCur(t);
      const f = fmt({ decimals: 1, unit: c.unit }, thermoSetId(c));
      const a = c.status ? fmt({ decimals: 1, unit: c.unit }, c.status) : null;
      const chips = thermoChips(c);
      html = '<div class="row1">' + ic + '<span class="tval">' + (a ? 'Ist ' + esc(a.text) + ' ' + esc(a.unit || '°C') : '') + '</span></div>' +
        '<div class="big">' + esc(f.text) + '<small>' + esc(f.unit || '°C') + '</small></div>' +
        (chips.length ? '<div class="tsub">' + esc(chips.join(' · ')) + '</div>' : '') + (c._circs ? circSwitcher(c) : label);
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
  dragHandle(el);
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
      if ((a === 'up' || a === 'down' || a === 'stop') && blindBlocked(t)) return;
      if (a === 'gopen') gateCmd(t, 'open');
      else if (a === 'gclose') gateCmd(t, 'close');
      else if (a === 'gstop') gateCmd(t, 'stop');
      else if (a === 'up') blindWrite(t, 100);
      else if (a === 'down') blindWrite(t, 0);
      else if (a === 'stop') send(t.stop, true);
      else if (a === 'plus') thermoStep(thermoCur(t), 1);
      else if (a === 'minus') thermoStep(thermoCur(t), -1);
      else if (a === 'mode') sendMode(thermoCur(t), b.dataset.v);
      else if (a === 'circ') {
        const c = thermoCur(t);
        circSwitch(t, (c._circ || 0) + Number(b.dataset.v));
      } else if (a === 'circsel') circSwitch(t, Number(b.dataset.v));
      else if (a === 'wbmode') send(t.mode, b.dataset.v);
      else if (a === 'wbplus') wbCurrentStep(t, 1);
      else if (a === 'wbminus') wbCurrentStep(t, -1);
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
  camPop(null);
  const tools = SV.editing ? Editor.planTools(page) : document.createElement('div');
  tools.classList.add('plantools');
  const bar = SV.editing ? null : layerBar(page);
  if (bar && page.image) tools.appendChild(bar);
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
  plan.className = 'plan ms-' + (page.markerSize || 'm');
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

/** A floor plan page as a tile: picture + symbols, scaled to the tile. */
function planTile(el, t) {
  el.classList.add('planview', 'tap');
  const page = layout().pages.find(p => p.id === t.target && p.type === 'plan');
  el.innerHTML = (t.label || page ? '<div class="hlabel">' + esc(t.label || page.name) + '</div>' : '') + '<div class="pvbox"></div>';
  const box = el.querySelector('.pvbox');
  if (!page || !page.image) {
    box.innerHTML = '<div class="planempty">' + (page ? 'Diese Grundriss-Seite hat noch kein Bild.' : 'Grundriss-Seite wählen (✎ → Kachel)') + '</div>';
  } else {
    const plan = document.createElement('div');
    plan.className = 'plan ms-' + (page.markerSize || 'm');
    const img = document.createElement('img');
    img.className = 'planimg';
    img.src = 'files/' + encodeURIComponent(page.image);
    img.alt = page.name;
    plan.appendChild(img);
    for (const mt of visibleTiles(page)) plan.appendChild(renderMarker(mt, page, true));
    box.appendChild(plan);
    const bar = SV.editing ? null : layerBar(page, true);
    if (bar) el.appendChild(bar);
    // with an own height: the whole plan fits into the tile
    const fit = () => {
      if (!t.sh || !img.naturalWidth) return;
      const r = img.naturalWidth / img.naturalHeight;
      plan.style.width = Math.min(box.clientWidth, box.clientHeight * r) + 'px';
    };
    img.onload = fit;
    if (img.complete) fit();
  }
  dragHandle(el);
}

// ---------------- floor plan layers (Gewerke) and camera preview ----------------

const LAYERS = [
  ['licht', 'Licht', 'bulb'],
  ['beschattung', 'Beschattung', 'blind'],
  ['klima', 'Heizung / Klima', 'thermometer'],
  ['fenster', 'Fenster / Türen', 'window'],
  ['sicherheit', 'Sicherheit', 'shield'],
  ['brand', 'Brand', 'fire'],
  ['kamera', 'Kamera', 'camera'],
  ['energie', 'Energie', 'bolt'],
  ['sonstiges', 'Sonstiges', 'info'],
];
const LAYER_TYPE = { camera: 'kamera', blind: 'beschattung', thermostat: 'klima', gate: 'fenster', windows: 'fenster', energy: 'energie', wallbox: 'energie', dimmer: 'licht' };
const LAYER_ICON = {
  bulb: 'licht', lamp: 'licht', walllamp: 'licht', ceiling: 'licht', lantern: 'licht',
  blind: 'beschattung', awning: 'beschattung',
  heat: 'klima', thermometer: 'klima', fan: 'klima', drop: 'klima',
  window: 'fenster', door: 'fenster', garage: 'fenster', gate: 'fenster',
  alarm: 'sicherheit', shield: 'sicherheit', lock: 'sicherheit', motion: 'sicherheit',
  fire: 'brand', camera: 'kamera',
  socket: 'energie', power: 'energie', bolt: 'energie', energy: 'energie', charger: 'energie', car: 'energie',
};

/** layer of a tile: chosen in the dialog, else by type, else by symbol */
function tileLayer(t) {
  if (t.layer && LAYERS.some(l => l[0] === t.layer)) return t.layer;
  return LAYER_TYPE[t.type] || LAYER_ICON[tileIcon(t)] || 'sonstiges';
}

/** hidden layers per plan page and device (only a view setting, not saved in the layout) */
function hiddenLayers(page) {
  try {
    return new Set(JSON.parse(localStorage.getItem('sv.layers.' + page.id) || '[]'));
  } catch (e) {
    return new Set();
  }
}

function setHiddenLayers(page, set) {
  try {
    localStorage.setItem('sv.layers.' + page.id, JSON.stringify([...set]));
  } catch (e) {
    // private mode: only for this view
  }
}

/** buttons to show/hide the layers of a plan (only when it has at least two) */
function layerBar(page, small) {
  const tiles = visibleTiles(page);
  const used = LAYERS.filter(l => tiles.some(t => tileLayer(t) === l[0]));
  if (used.length < 2) return null;
  const hidden = hiddenLayers(page);
  const bar = document.createElement('div');
  bar.className = 'layerbar' + (small ? ' small' : '');
  bar.dataset.page = page.id;
  for (const [key, name, ic] of used) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lchip' + (hidden.has(key) ? ' off' : '');
    b.dataset.layer = key;
    b.title = name + ' ein-/ausblenden';
    b.innerHTML = icon(ic) + (small ? '' : '<span>' + esc(name) + '</span>');
    b.addEventListener('click', e => {
      e.stopPropagation();
      const h = hiddenLayers(page);
      if (h.has(key)) h.delete(key);
      else h.add(key);
      setHiddenLayers(page, h);
      applyLayers(page);
    });
    bar.appendChild(b);
  }
  return bar;
}

/** show/hide the markers of all views of this plan (page and plan tiles); alarms always stay visible (CSS) */
function applyLayers(page) {
  const hidden = hiddenLayers(page);
  const sel = '[data-page="' + CSS.escape(page.id) + '"]';
  for (const m of document.querySelectorAll('.marker' + sel)) m.classList.toggle('lhidden', hidden.has(m.dataset.layer));
  for (const b of document.querySelectorAll('.layerbar' + sel + ' .lchip')) b.classList.toggle('off', hidden.has(b.dataset.layer));
}

/** mouse over a camera symbol: small live picture next to it; null removes it */
function camPop(el, t) {
  const old = document.querySelector('.campop');
  if (old) old.remove();
  if (!el || !document.body.contains(el)) return;
  const box = document.createElement('div');
  box.className = 'campop';
  box.innerHTML = '<img class="camimg" alt="" data-cam="' + esc(t.camera) + '">' + (t.label ? '<span>' + esc(t.label) + '</span>' : '');
  document.body.appendChild(box);
  const r = el.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  const h = w * 0.5625 + 34;
  box.style.width = w + 'px';
  box.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)) + 'px';
  box.style.top = (r.top - h - 10 >= 8 ? r.top - h - 10 : Math.min(window.innerHeight - h - 8, r.bottom + 10)) + 'px';
  loadCam(box.querySelector('img'));
  startCams();
}

function renderMarker(t, page, inTile) {
  const el = document.createElement('div');
  el.className = 'marker ' + t.type;
  el.dataset.tile = t.id;
  el.dataset.page = page.id;
  el.dataset.layer = tileLayer(t);
  if (!SV.editing && hiddenLayers(page).has(el.dataset.layer)) el.classList.add('lhidden');
  el.dataset.ids = ' ' + tileIds(t).join(' ') + ' ';
  el.style.left = t.x + '%';
  el.style.top = t.y + '%';
  fillMarker(el, t);
  if (SV.editing) {
    // inside a plan tile the symbols are moved on the plan page itself
    if (!inTile) el.addEventListener('pointerdown', e => Editor.markerDown(e, page, t, el));
  } else {
    if (Timers.supports(t)) Timers.longPress(el, () => openSheet(t));
    if (t.type === 'camera' && t.camera) {
      el.addEventListener('pointerenter', e => {
        if (e.pointerType === 'mouse') camPop(el, t);
      });
      el.addEventListener('pointerleave', () => camPop(null));
    }
    el.addEventListener('click', e => {
      // inside a plan tile: the tile itself must not react (it would open the plan page)
      if (inTile) e.stopPropagation();
      if (t.type === 'switch' || t.type === 'button') return tileTap(t);
      if (t.type === 'camera') {
        camPop(null);
        return openCam(t.camera, t.label);
      }
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
  else if (t.type === 'gate') v = gateText(t);
  else if (t.type === 'wallbox') v = wbBig(t);
  else if (t.type === 'energy') {
    const d = energyData(t);
    v = d && d.s ? EnergyView.fmtW(d.s.pv) : '';
  }
  else if (t.type === 'windows') {
    const n = windowStates(t).filter(w => w.status !== 'closed' && w.status !== 'unknown').length;
    v = n ? n + ' offen' : '';
  } else if (t.type === 'thermostat') {
    const c = thermoCur(t);
    const f = fmt({ decimals: 1, unit: c.unit }, c.status || c.state);
    v = f.text + (f.unit ? ' ' + f.unit : ' °C');
  }
  el.title = t.label || '';
  el.innerHTML = '<div class="dot">' + tileIc(t) + '</div>' + (v ? '<div class="mval">' + esc(v) + '</div>' : '');
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
  const show = t.show || 'flow';
  el.classList.toggle('eonly', show === 'today' || show === 'chart');
  if (!el._ef || !el.contains(el._ef.box)) {
    // parts: flow (flow, stats), today's values (stats, today), day chart (chart)
    const parts = (show === 'flow' || show === 'stats' ? '<div class="eflow"></div>' : '') + (show === 'stats' || show === 'today' ? '<div class="estats"></div>' : '') + (show === 'chart' ? '<div class="echart"></div>' : '');
    el.innerHTML = (t.label ? '<div class="hlabel">' + esc(t.label) + '</div>' : '') + (t.instance ? parts : '<div class="planempty">Keine Energie-Instanz gewählt</div>');
    const box = el.querySelector('.eflow, .estats, .echart');
    el._ef = { box, flow: el.querySelector('.eflow') ? EnergyView.flow(el.querySelector('.eflow')) : null, chartAt: 0 };
  }
  dragHandle(el);
  const d = energyData(t);
  el.classList.toggle('missing', Boolean(t.instance) && !d);
  if (d && d.s) {
    if (el._ef.flow) el._ef.flow.update(d.s, d.view);
    const st = el.querySelector('.estats');
    if (st) EnergyView.stats(st, d.today, d.s.battery !== null);
  }
  // today's curve: new 5-minute values, so reload every 5 minutes at most
  const ch = el.querySelector('.echart');
  if (ch && t.instance && Date.now() - el._ef.chartAt > 300000) {
    el._ef.chartAt = Date.now();
    api('energy/day?instance=' + encodeURIComponent(t.instance))
      .then(day => (day.error ? Promise.reject(new Error(day.error)) : EnergyView.chart(ch, day)))
      .catch(e => (ch.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'));
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
    const w = blindWords(t);
    body = '<div class="bigval" data-out>' + blindText(t) + '</div>' +
      (blindLock(t) ? '' : '<input type="range" data-kind="blind" min="0" max="100" step="5" value="' + Math.round(blindOpen(t)) + '">') +
      '<div class="row"><button type="button" data-a="up">' + icon('up') + w[0] + '</button>' +
      (t.stop ? '<button type="button" data-a="stop">' + icon('stop') + 'Stopp</button>' : '') +
      '<button type="button" data-a="down">' + icon('down') + w[1] + '</button></div>';
  } else if (t.type === 'gate') {
    body = '<div class="bigval">' + (gateText(t) || '–') + '</div><div class="row">' + gateButtons(t, true) + '</div>';
  } else if (t.type === 'wallbox') {
    const info = [];
    const p = wbPower(t);
    if (t.status || t.plugged) info.push(['Zustand', esc(wbLine(t) === String(val(t.ctrl) || '') ? String(val(t.status) || '–') : wbLine(t))]);
    if (t.ctrl) info.push(['Laderegelung', esc(String(val(t.ctrl) || '–'))]);
    if (p !== null) info.push(['Ladeleistung', esc(EnergyView.fmtW(p))]);
    if (t.energy) info.push(['Geladen', esc(fmt({ decimals: 2, unit: 'kWh' }, t.energy).text) + ' kWh']);
    if (t.current) {
      const c = Number(val(t.current));
      info.push(['Ladestrom', Number.isFinite(c) ? (c >= 6 ? esc(String(c).replace('.', ',')) + ' A' : 'Pause') : '–']);
    }
    body = '<div class="bigval">' + esc(wbBig(t)) + '</div>' +
      (t.mode ? '<div class="row modes">' + wbModeButtons(t) + '</div>' : '') +
      (wbManual(t) ? '<div class="row"><button type="button" data-a="wbminus" aria-label="weniger Strom">' + icon('minus') + '</button><button type="button" data-a="wbplus" aria-label="mehr Strom">' + icon('plus') + '</button></div>' : '') +
      (info.length ? '<div class="mrows sheetrows">' + info.map(([k, v]) => '<div class="mrow"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' : '');
  } else if (t.type === 'thermostat') {
    const c = thermoCur(t);
    const f = fmt({ decimals: 1, unit: c.unit }, thermoSetId(c));
    const u = x => esc(x.unit || '°C');
    const info = [];
    if (c.status) {
      const a = fmt({ decimals: 1, unit: c.unit }, c.status);
      info.push([c._circs ? 'Ist-Temperatur' : 'Raumtemperatur', esc(a.text) + ' ' + u(a)]);
    }
    if (c.humidity) info.push(['Luftfeuchte', esc(fmt({ decimals: 0, unit: '%' }, c.humidity).text) + ' %']);
    const m = thermoMode(c);
    if (m) info.push([c.modeStatus ? 'Status' : 'Betriebsart', esc(m.text)]);
    const h = thermoHeat(c);
    if (h) info.push(['Heizung', esc(h.text)]);
    if (c.window) info.push(['Fenster', thermoWindowOpen(c) ? '<span class="bad">offen</span>' : 'zu']);
    body = circSwitcher(c, true) + '<p class="muted" style="text-align:center;margin:0">Soll' + (c._circs ? ' – ' + esc(c._circs[c._circ].label) : '') + '</p><div class="bigval">' + esc(f.text) + ' ' + u(f) + '</div>' +
      '<div class="row"><button type="button" data-a="minus" aria-label="kälter">' + icon('minus') + '</button><button type="button" data-a="plus" aria-label="wärmer">' + icon('plus') + '</button></div>' +
      (c.mode ? '<div class="row modes">' + thermoModes(c).map(([k, v]) => '<button type="button" data-a="mode" data-v="' + esc(k) + '"' + (thermoModeKey(c) === k ? ' class="primary"' : '') + '>' + esc(v) + '</button>').join('') + '</div>' : '') +
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
  sh.innerHTML = '<h3>' + tileIc(t) + '<span class="grow">' + esc(t.label || '') + '</span><button type="button" class="iconbtn" data-close aria-label="Schließen">' + icon('close') + '</button></h3>' + body;
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
    if (msg.type === 'locks') {
      SV.locks = clientLocks(msg.locks);
      refreshLocked();
    } else if (msg.type === 'init') {
      SV.locks = clientLocks(msg.locks);
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
  let lastNarrow = null;
  window.addEventListener('resize', () => {
    // free grid pages switch to the simple order on narrow screens
    const page = currentPage();
    const narrow = page && page.free ? freeNarrow($('main'), page) : null;
    if (device() !== lastDev || narrow !== lastNarrow) {
      lastDev = device();
      lastNarrow = narrow;
      render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SV.ws && SV.ws.readyState > 1) connect();
  });
  tickClock();
  setInterval(tickClock, 10000);
  // countdown of wind/rain locks
  setInterval(() => SV.locks && Object.values(SV.locks).some(l => l.until) && refreshLocked(), 1000);
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
