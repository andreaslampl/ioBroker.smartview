'use strict';

/*
 * Layout of the visualization: pages with tiles; a page of type "plan" shows a floor plan image
 * with the same tiles as markers (x/y in percent of the image).
 *
 * layout = {
 *   title, theme: 'dark'|'light'|'auto',
 *   showDate, hideNav,                     // optional: date in the header, no page bar (menu tiles)
 *   side: { enabled, top: [pageId], bottom: [pageId] },  // optional split screen on the touch PC
 *   pages: [{ id, name, icon, type: 'tiles'|'list'|'plan', image, tiles: [tile] }],
 *   ring: { state, camera, door, intercom },  // doorbell: show the camera when `state` is true;
 *                                            // intercom 'livecam.N' = ring tone, answer, call list via livecam
 *   push: [{ id, enabled, state, cond, value, title, text, page, channels: { app, telegram, whatsapp } }],
 *   telegram: { instance: 'telegram.N'|'', users, ring },  // push rules also via the telegram adapter;
 *                                                          // ring = photo of the doorbell camera
 *   whatsapp: { instance: 'whatsapp-cmb.N'|'', phone, ring },  // CallMeBot: text only
 * }
 * tile = { id, type, label, icon, size, device, x, y, homekit, hkId, ...type fields (see TYPES) }
 *   homekit: device type in homekit-easy ('' = not in HomeKit), hkId: linked homekit-easy device (lib/homekit.js)
 */

const fs = require('node:fs');
const path = require('node:path');
const { cleanChoice } = require('./homekit');

/** Tile types: data point fields (w = written by the page) and other options. */
const TYPES = {
    switch: { states: { state: 'w', status: 'r' }, options: ['invert'] },
    dimmer: { states: { state: 'w', switchState: 'w', status: 'r' }, options: [] },
    // blind or awning; optional wind/rain protection: drives to a safe position and locks (main.js)
    blind: { states: { state: 'w', stop: 'w', status: 'r', windAlarm: 'r', rainAlarm: 'r' }, options: ['closed100', 'posInvert', 'kind', 'windMin', 'protect', 'lockTime', 'lockUnit'] },
    // gate: separate open/close data points or one (true/false or impulse), optional end positions
    gate: { states: { open: 'w', close: 'w', state: 'w', stop: 'w', posOpen: 'r', posClosed: 'r' }, options: ['gateMode', 'single', 'impulse', 'confirm'] },
    value: { states: { state: 'r' }, options: ['unit', 'decimals', 'texts', 'highlight'] },
    button: { states: { state: 'w' }, options: ['value', 'confirm'] },
    // room controller: setpoint, actual, humidity, operating mode (write + feedback), heating/valve, window
    thermostat: {
        states: { state: 'w', setStatus: 'r', status: 'r', humidity: 'r', mode: 'w', modeStatus: 'r', heating: 'r', window: 'r' },
        // circuits: more heating circuits in the same tile (switched on the tile); the own fields are circuit 1
        options: ['step', 'unit', 'min', 'max', 'modes', 'circLabel', 'circuits'],
    },
    camera: { states: {}, options: ['camera'] },
    link: { states: {}, options: ['url'] },
    page: { states: {}, options: ['target'] },
    multi: { states: {}, options: ['rows'] }, // rows: [{label, state, unit, decimals}] - read only
    // HTML text from a data point (e.g. a script's table), scripts removed
    html: { states: { state: 'r' }, options: [] },
    // window overview: windows [{label, state (contact, true = open), tilt (optional, true = tilted), invert}]
    // group: windows with the same area are shown as one entry; onlyOpen: closed ones hidden; warnMin: highlighted when
    // open longer; warnWhen (e.g. rain, alarm armed) + warnText: warning while it is true and a window is open
    windows: { states: { warnWhen: 'r' }, options: ['windows', 'onlyOpen', 'warnMin', 'warnText', 'notify'] },
    // alarm system: status (with the values for off / armed / internally armed), command, alarm, error text of the
    // last setting; `area` = NOX area (nox_alarmzentrale.N.areas.M) fills the empty fields
    // ready / openText / alarmText: ready to arm, open detectors, detectors in alarm; `areas` = more areas switched
    // with ‹ › on the tile (the tile's own fields are area 1, `areaLabel` its name)
    alarm: { states: { status: 'r', command: 'w', alarm: 'r', error: 'r', ready: 'r', openText: 'r', alarmText: 'r' }, options: ['area', 'valueOff', 'valueArm', 'valueHome', 'areaLabel', 'areas'] },
    heading: { states: {}, options: [] },
    // energy flow of the energie adapter: state = <instance>.live (JSON), set from `instance`
    energy: { states: { state: 'r' }, options: ['instance', 'show'] },
    // wallbox: values of a wallbox adapter (charger 'versicharge.N' fills them), mode of energie's surplus charging
    wallbox: { states: { state: 'r', status: 'r', plugged: 'r', energy: 'r', mode: 'w', ctrl: 'r', current: 'w' }, options: ['charger', 'instance'] },
    // a floor plan page shown as a tile (several plans on one page, each in its own size)
    planview: { states: {}, options: ['target'] },
};

/** options with a fixed set of values (first = default) */
const SELECTS = {
    kind: ['blind', 'awning'],
    protect: ['up', 'down', 'none'],
    lockUnit: ['min', 's'],
    gateMode: ['separate', 'single'],
    single: ['level', 'impulse'],
};

/** floor plan layers (Gewerke) a tile can be put on; '' = automatic by type and symbol (app.js tileLayer) */
const LAYERS = ['licht', 'beschattung', 'klima', 'fenster', 'sicherheit', 'brand', 'kamera', 'energie', 'sonstiges'];

const ICONS = [
    'bulb', 'lamp', 'walllamp', 'ceiling', 'lantern', 'awning', 'power', 'socket', 'blind', 'window', 'door', 'garage', 'gate', 'lock', 'alarm', 'shield',
    'motion', 'thermometer', 'heat', 'drop', 'fan', 'sun', 'moon', 'bolt', 'energy', 'camera', 'bell', 'music',
    'tv', 'scene', 'home', 'fire', 'water', 'car', 'charger', 'tree', 'info', 'star', 'gauge',
];

const str = (v, max = 200) => String(v === undefined || v === null ? '' : v).slice(0, max);
const num = (v, def) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ident = (v, def) => (v !== undefined && v !== null && /^[\w-]{1,40}$/.test(String(v)) ? String(v) : def);

function cleanTile(t, i, plan) {
    const type = TYPES[t && t.type] ? t.type : 'switch';
    const out = {
        id: ident(t.id, `t${i + 1}`),
        type,
        label: str(t.label, 60),
        icon: ICONS.includes(t.icon) ? t.icon : '',
        size: ['1', '2', 'w', 'l'].includes(t.size) ? t.size : '1',
        device: ['all', 'phone', 'touch'].includes(t.device) ? t.device : 'all',
    };
    if (LAYERS.includes(t.layer)) {
        out.layer = t.layer;
    }
    // PIN protection: only the hash is stored (lib/pin.js), checked by the server
    if (/^s1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(String(t.pinHash || ''))) {
        out.pinHash = t.pinHash;
    }
    // symbol rotated in degrees (e.g. a wall lamp towards its wall on the floor plan)
    const rot = Math.round(num(t.rotate, 0)) % 360;
    if (rot) {
        out.rotate = (rot + 360) % 360;
    }
    // own size in columns / rows (empty = default of the type and `size`)
    if (!plan) {
        for (const [k, max] of [['sw', 12], ['sh', 8]]) {
            if (Number.isInteger(Number(t[k])) && Number(t[k]) >= 1 && t[k] !== '' && t[k] !== null) {
                out[k] = clamp(Number(t[k]), 1, max);
            }
        }
    }
    if (plan) {
        out.x = clamp(num(t.x, 50), 0, 100);
        out.y = clamp(num(t.y, 50), 0, 100);
    } else if (Number.isInteger(Number(t.gx)) && Number.isInteger(Number(t.gy)) && t.gx !== '' && t.gy !== '') {
        // free grid (page.free): column and row, 1-based
        out.gx = clamp(Number(t.gx), 1, 12);
        out.gy = clamp(Number(t.gy), 1, 300);
    }
    for (const key of Object.keys(TYPES[type].states)) {
        const id = str(t[key], 300).trim();
        if (id) {
            out[key] = id;
        }
    }
    if (type === 'energy') {
        const inst = /^energie\.\d+$/.test(String(t.instance || '')) ? String(t.instance) : '';
        if (inst) {
            out.state = `${inst}.live`;
        } else {
            delete out.state;
        }
    }
    if (type === 'wallbox') {
        fillWallbox(out, t);
    }
    if (type === 'alarm') {
        fillAlarm(out, t);
    }
    const hk = cleanChoice(type, t.homekit);
    if (hk) {
        out.homekit = hk;
        if (ident(t.hkId, '')) {
            out.hkId = ident(t.hkId, '');
        }
    }
    for (const key of TYPES[type].options) {
        if (t[key] === undefined || t[key] === '') {
            continue;
        }
        if (key === 'invert' || key === 'closed100' || key === 'posInvert' || key === 'confirm' || key === 'impulse' || key === 'onlyOpen' || key === 'notify') {
            out[key] = Boolean(t[key]);
        } else if (key === 'windMin' || key === 'lockTime' || key === 'warnMin') {
            if (Number.isFinite(Number(t[key]))) {
                out[key] = clamp(Number(t[key]), 0, key === 'lockTime' ? 86400 : key === 'warnMin' ? 10080 : 1000);
            }
        } else if (SELECTS[key]) {
            out[key] = SELECTS[key].includes(t[key]) ? t[key] : SELECTS[key][0];
        } else if (key === 'decimals' || key === 'step') {
            out[key] = clamp(num(t[key], key === 'step' ? 0.5 : 1), 0, key === 'step' ? 100 : 6);
        } else if (key === 'min' || key === 'max') {
            if (Number.isFinite(Number(t[key]))) {
                out[key] = clamp(Number(t[key]), -100, 1000);
            }
        } else if (key === 'target') {
            out[key] = ident(t[key], '');
        } else if (key === 'rows') {
            out[key] = (Array.isArray(t.rows) ? t.rows : []).slice(0, 8).map(r => {
                const row = { label: str(r && r.label, 40), state: str(r && r.state, 300).trim(), unit: str(r && r.unit, 20) };
                if (r && r.decimals !== undefined && r.decimals !== '' && r.decimals !== null) {
                    row.decimals = clamp(num(r.decimals, 1), 0, 6);
                }
                return row;
            });
        } else if (key === 'windows') {
            out[key] = (Array.isArray(t.windows) ? t.windows : []).slice(0, 60).map(w => ({
                label: str(w && w.label, 40),
                ...(str(w && w.group, 40).trim() ? { group: str(w && w.group, 40).trim() } : {}),
                state: str(w && w.state, 300).trim(),
                tilt: str(w && w.tilt, 300).trim(),
                invert: Boolean(w && w.invert),
                invert2: Boolean(w && w.invert2),
                // tilt: contact 1 = open, contact 2 = tilted (tilt wins); both: one contact open = tilted, both = open;
                // table: own status per combination (map = 4 letters z/t/o for 1+2 closed, 1 open, 2 open, both open)
                logic: ['both', 'table'].includes(w && w.logic) ? w.logic : 'tilt',
                map: /^[zto]{4}$/.test(String((w && w.map) || '')) ? w.map : 'ztoo',
            }));
        } else if (key === 'circuits') {
            out[key] = (Array.isArray(t.circuits) ? t.circuits : []).slice(0, 12).map(c => {
                const o = { label: str(c && c.label, 40) };
                if (c && str(c.modes, 300).trim()) {
                    o.modes = str(c.modes, 300).trim();
                }
                for (const k of Object.keys(TYPES.thermostat.states)) {
                    const id = str(c && c[k], 300).trim();
                    if (id) {
                        o[k] = id;
                    }
                }
                return o;
            });
        } else if (key === 'areas') {
            out[key] = (Array.isArray(t.areas) ? t.areas : []).slice(0, 12).map(a => {
                const o = { label: str(a && a.label, 40) };
                for (const k of [...Object.keys(TYPES.alarm.states), 'area', 'valueOff', 'valueArm', 'valueHome']) {
                    const v = str(a && a[k], 300).trim();
                    if (v) {
                        o[k] = v;
                    }
                }
                fillAlarm(o, a || {});
                return o;
            }).filter(a => a.status || a.command);
        } else if (key === 'circLabel' || key === 'warnText' || key === 'areaLabel') {
            out[key] = str(t[key], 40);
        } else if (key === 'charger') {
            out[key] = /^versicharge\.\d+$/.test(String(t[key])) ? String(t[key]) : '';
        } else if (key === 'instance') {
            out[key] = /^energie\.\d+$/.test(String(t[key])) ? String(t[key]) : '';
        } else if (key === 'show') {
            out[key] = ['stats', 'today', 'chart'].includes(t[key]) ? t[key] : 'flow';
        } else if (key === 'highlight') {
            out[key] = ['none', 'on', 'off'].includes(t[key]) ? t[key] : 'none';
        } else {
            out[key] = str(t[key], key === 'url' ? 1000 : 300);
        }
    }
    return out;
}

/** Alarm tile with a NOX area (nox_alarmzentrale.N.areas.M): its data points and values for empty fields. */
function fillAlarm(out, t) {
    const area = String(t.area || '').trim();
    if (!/^[a-z][\w-]*\.\d+\.areas\.\d+$/.test(area)) {
        return;
    }
    out.area = area;
    for (const [key, sub] of [['status', 'state'], ['command', 'setState'], ['alarm', 'alarm'], ['error', 'error'], ['ready', 'ready'], ['openText', 'openInputs'], ['alarmText', 'alarmInputs']]) {
        if (!out[key]) {
            out[key] = `${area}.${sub}`;
        }
    }
    if (!str(t.valueOff, 40)) {
        out.valueOff = '1';
    }
    if (!str(t.valueArm, 40)) {
        out.valueArm = '5';
    }
}

/** Data points a tile writes (for the PIN check). */
function tileWriteIds(t) {
    const ids = new Set();
    for (const [key, mode] of Object.entries(TYPES[t.type].states)) {
        if (mode === 'w' && t[key]) {
            ids.add(t[key]);
        }
    }
    for (const c of t.circuits || []) {
        for (const [key, mode] of Object.entries(TYPES.thermostat.states)) {
            if (mode === 'w' && c[key]) {
                ids.add(c[key]);
            }
        }
    }
    for (const a of t.areas || []) {
        if (a.command) {
            ids.add(a.command);
        }
    }
    return [...ids];
}

/** Wallbox tile: data points of the chosen instances, for fields left empty (or still pointing to another instance). */
function fillWallbox(out, t) {
    const charger = /^versicharge\.\d+$/.test(String(t.charger || '')) ? t.charger : '';
    const energie = /^energie\.\d+$/.test(String(t.instance || '')) ? t.instance : '';
    const fill = (key, inst, re, sub) => {
        if (inst && (!out[key] || re.test(out[key]))) {
            out[key] = `${inst}.${sub}`;
        }
    };
    const vc = /^versicharge\.\d+\./;
    fill('state', charger, vc, 'power.total');
    fill('status', charger, vc, 'status.text');
    fill('plugged', charger, vc, 'status.plugged');
    fill('energy', charger, vc, 'energy.session');
    fill('current', charger, vc, 'control.current');
    const en = /^energie\.\d+\.wallbox\./;
    fill('mode', energie, en, 'wallbox.mode');
    fill('ctrl', energie, en, 'wallbox.status');
}

/** Where a push rule goes; older layouts had via: 'all' | 'app' | 'telegram'. */
function channels(r) {
    if (r.channels && typeof r.channels === 'object') {
        return { app: Boolean(r.channels.app), telegram: Boolean(r.channels.telegram), whatsapp: Boolean(r.channels.whatsapp) };
    }
    return { app: r.via !== 'telegram', telegram: r.via !== 'app', whatsapp: !r.via || r.via === 'all' };
}

/** Validate a layout from the editor. */
function cleanLayout(l) {
    l = l && typeof l === 'object' ? l : {};
    const pages = (Array.isArray(l.pages) ? l.pages : []).slice(0, 50).map((p, i) => {
        const type = p && ['plan', 'list'].includes(p.type) ? p.type : 'tiles';
        const seen = new Set();
        const tiles = (Array.isArray(p && p.tiles) ? p.tiles : []).slice(0, 300).map((t, j) => {
            const tile = cleanTile(t || {}, j, type === 'plan');
            while (seen.has(tile.id)) {
                tile.id += 'x';
            }
            seen.add(tile.id);
            return tile;
        });
        return {
            id: ident(p && p.id, `p${i + 1}`),
            name: str(p && p.name, 40) || `Seite ${i + 1}`,
            icon: ICONS.includes(p && p.icon) ? p.icon : 'home',
            type,
            image: type === 'plan' && /^[\w.-]+$/.test(String(p.image || '')) ? String(p.image) : '',
            // floor plan: size of the symbols (xs, s, m, l)
            ...(type === 'plan' ? { markerSize: ['xs', 's', 'l'].includes(p.markerSize) ? p.markerSize : 'm' } : {}),
            // not in the page bar (e.g. a floor plan only used in "Grundriss" tiles)
            ...(p.hidden ? { hidden: true } : {}),
            // tile page with a free grid: tiles at gx/gy, empty cells allowed
            ...(type === 'tiles' && p.free ? { free: true, cols: clamp(Math.round(num(p.cols, 6)), 3, 12) } : {}),
            // page scaled to the screen (tiles, list, plan): laid out at designW px, then zoomed (width) or fitted (screen)
            ...(['width', 'screen'].includes(p.fit) ? { fit: p.fit, designW: clamp(Math.round(num(p.designW, 1280)), 320, 4000) } : {}),
            tiles,
        };
    });
    const ring = l.ring || {};
    const tg = l.telegram || {};
    const wa = l.whatsapp || {};
    const side = l.side || {};
    const pageIds = new Set(pages.map(p => p.id));
    const sideList = v => (Array.isArray(v) ? v : []).map(String).filter(id => pageIds.has(id)).slice(0, 10);
    return {
        title: str(l.title, 40) || 'SmartView',
        theme: ['dark', 'light', 'auto'].includes(l.theme) ? l.theme : 'dark',
        showDate: Boolean(l.showDate),
        hideNav: Boolean(l.hideNav),
        side: { enabled: Boolean(side.enabled), top: sideList(side.top), bottom: sideList(side.bottom) },
        pages,
        ring: {
            state: str(ring.state, 300).trim(),
            camera: str(ring.camera, 300).trim(),
            door: str(ring.door, 300).trim(),
            intercom: /^livecam\.\d+$/.test(String(ring.intercom || '')) ? String(ring.intercom) : '',
        },
        push: (Array.isArray(l.push) ? l.push : []).slice(0, 100).map((r, i) => ({
            id: ident(r && r.id, `r${i + 1}`),
            enabled: !r || r.enabled !== false,
            state: str(r && r.state, 300).trim(),
            cond: ['true', 'false', 'eq', 'ne', 'gt', 'lt', 'change'].includes(r && r.cond) ? r.cond : 'true',
            value: str(r && r.value, 100),
            // only when the condition holds this long (minutes, 0 = at once)
            delay: r && r.cond !== 'change' ? clamp(num(r.delay, 0), 0, 1440) : 0,
            // optional second condition ("und zusätzlich")
            and:
                r && r.and && str(r.and.state, 300).trim()
                    ? { state: str(r.and.state, 300).trim(), cond: ['true', 'false', 'eq', 'ne', 'gt', 'lt'].includes(r.and.cond) ? r.and.cond : 'true', value: str(r.and.value, 100) }
                    : null,
            title: str(r && r.title, 80),
            text: str(r && r.text, 300),
            page: str(r && r.page, 40),
            channels: channels(r || {}),
        })),
        telegram: {
            instance: /^telegram\.\d+$/.test(String(tg.instance || '')) ? String(tg.instance) : '',
            users: str(tg.users, 200).trim(),
            ring: Boolean(tg.ring),
        },
        whatsapp: {
            instance: /^whatsapp-cmb\.\d+$/.test(String(wa.instance || '')) ? String(wa.instance) : '',
            phone: str(wa.phone, 40).replace(/[^\d+]/g, ''),
            ring: Boolean(wa.ring),
        },
    };
}

/** Data points the page reads, and the ones it may write. */
function stateIds(layout) {
    const read = new Set();
    const write = new Set();
    for (const p of layout.pages) {
        for (const t of p.tiles) {
            for (const [key, mode] of Object.entries(TYPES[t.type].states)) {
                if (t[key]) {
                    read.add(t[key]);
                    if (mode === 'w') {
                        write.add(t[key]);
                    }
                }
            }
            // more heating circuits: same read/write rules as the tile's own fields
            for (const c of t.circuits || []) {
                for (const [key, mode] of Object.entries(TYPES.thermostat.states)) {
                    if (c[key]) {
                        read.add(c[key]);
                        if (mode === 'w') {
                            write.add(c[key]);
                        }
                    }
                }
            }
            // more alarm areas: same read/write rules as the tile's own fields
            for (const a of t.areas || []) {
                for (const [key, mode] of Object.entries(TYPES.alarm.states)) {
                    if (a[key]) {
                        read.add(a[key]);
                        if (mode === 'w') {
                            write.add(a[key]);
                        }
                    }
                }
            }
            for (const r of t.rows || []) {
                if (r.state) {
                    read.add(r.state);
                }
            }
            for (const w of t.windows || []) {
                for (const id of [w.state, w.tilt]) {
                    if (id) {
                        read.add(id);
                    }
                }
            }
        }
    }
    if (layout.ring.state) {
        read.add(layout.ring.state);
    }
    if (layout.ring.door) {
        write.add(layout.ring.door);
    }
    return { read: [...read], write: [...write] };
}

/** Cameras (livecam channel ids) used by the layout. */
function cameraIds(layout) {
    const ids = new Set();
    for (const p of layout.pages) {
        for (const t of p.tiles) {
            if (t.type === 'camera' && t.camera) {
                ids.add(t.camera);
            }
        }
    }
    if (layout.ring.camera) {
        ids.add(layout.ring.camera);
    }
    return [...ids];
}

function defaultLayout() {
    return cleanLayout({
        title: 'SmartView',
        pages: [
            {
                id: 'start',
                name: 'Start',
                icon: 'home',
                tiles: [{ id: 'hint', type: 'heading', label: 'Oben rechts ✎ antippen, um Seiten und Kacheln einzurichten' }],
            },
        ],
    });
}

class LayoutStore {
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'layout.json');
        this.filesDir = path.join(dir, 'files');
        fs.mkdirSync(this.filesDir, { recursive: true });
        try {
            this.layout = cleanLayout(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        } catch {
            this.layout = defaultLayout();
        }
    }

    save(data) {
        this.layout = cleanLayout(data);
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.layout, null, 1));
        fs.renameSync(this.file + '.tmp', this.file);
        return this.layout;
    }

    /** Store an uploaded image (floor plan); returns the file name. */
    saveFile(name, data) {
        const ext = (path.extname(String(name)).toLowerCase().match(/^\.(png|jpe?g|svg|webp|gif)$/) || [])[0];
        if (!ext) {
            throw new Error('Nur Bilder (PNG, JPG, SVG, WebP, GIF) sind erlaubt');
        }
        const base = path.basename(String(name), path.extname(String(name))).replace(/[^\w-]+/g, '_').slice(0, 40) || 'bild';
        const file = `${base}-${Date.now().toString(36)}${ext}`;
        fs.writeFileSync(path.join(this.filesDir, file), data);
        return file;
    }

    filePath(name) {
        return /^[\w.-]+$/.test(name) ? path.join(this.filesDir, name) : null;
    }
}

module.exports = { TYPES, ICONS, LAYERS, cleanLayout, stateIds, tileWriteIds, cameraIds, defaultLayout, LayoutStore };
