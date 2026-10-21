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
 * tile = { id, type, label, icon, size, device, x, y, ...type fields (see TYPES) }
 */

const fs = require('node:fs');
const path = require('node:path');

/** Tile types: data point fields (w = written by the page) and other options. */
const TYPES = {
    switch: { states: { state: 'w', status: 'r' }, options: ['invert'] },
    dimmer: { states: { state: 'w', switchState: 'w', status: 'r' }, options: [] },
    blind: { states: { state: 'w', stop: 'w', status: 'r' }, options: ['closed100'] },
    value: { states: { state: 'r' }, options: ['unit', 'decimals', 'texts', 'highlight'] },
    button: { states: { state: 'w' }, options: ['value', 'confirm'] },
    // room controller: setpoint, actual, humidity, operating mode (write + feedback), heating/valve, window
    thermostat: {
        states: { state: 'w', setStatus: 'r', status: 'r', humidity: 'r', mode: 'w', modeStatus: 'r', heating: 'r', window: 'r' },
        options: ['step', 'unit', 'min', 'max', 'modes'],
    },
    camera: { states: {}, options: ['camera'] },
    link: { states: {}, options: ['url'] },
    page: { states: {}, options: ['target'] },
    multi: { states: {}, options: ['rows'] }, // rows: [{label, state, unit, decimals}] - read only
    heading: { states: {}, options: [] },
};

const ICONS = [
    'bulb', 'lamp', 'power', 'socket', 'blind', 'window', 'door', 'garage', 'gate', 'lock', 'alarm', 'shield',
    'motion', 'thermometer', 'heat', 'drop', 'fan', 'sun', 'moon', 'bolt', 'energy', 'camera', 'bell', 'music',
    'tv', 'scene', 'home', 'fire', 'water', 'car', 'tree', 'info', 'star', 'gauge',
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
    if (plan) {
        out.x = clamp(num(t.x, 50), 0, 100);
        out.y = clamp(num(t.y, 50), 0, 100);
    }
    for (const key of Object.keys(TYPES[type].states)) {
        const id = str(t[key], 300).trim();
        if (id) {
            out[key] = id;
        }
    }
    for (const key of TYPES[type].options) {
        if (t[key] === undefined || t[key] === '') {
            continue;
        }
        if (key === 'invert' || key === 'closed100' || key === 'confirm') {
            out[key] = Boolean(t[key]);
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
        } else if (key === 'highlight') {
            out[key] = ['none', 'on', 'off'].includes(t[key]) ? t[key] : 'none';
        } else {
            out[key] = str(t[key], key === 'url' ? 1000 : 300);
        }
    }
    return out;
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
            for (const r of t.rows || []) {
                if (r.state) {
                    read.add(r.state);
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

module.exports = { TYPES, ICONS, cleanLayout, stateIds, cameraIds, defaultLayout, LayoutStore };
