'use strict';

/*
 * Color light tiles (RGBW) in the adapter, so they work without an open page:
 *   - KNX push button with ONE rocker (parameterized "Schalten/Dimmen"): short top (1) = on, when on = next color,
 *     short bottom (0) = off, long = dim brighter / darker (DPT 3.007, stop on release)
 *   - color changer ("Farbwechsel"): hue runs round in `fxTime` seconds, brightness stays dimmable
 *   - feedback to KNX: on/off (knxStatus) and brightness (knxBright) for the button's LED / display
 * Commands from the page come through command() too (preset, own color, color changer, on/off).
 */
const C = require('../www/colorlogic');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class ColorLights {
    /**
     * @param {object} io {get(id) -> value, max(id) -> number|undefined, set(id, val) -> Promise, log, changed(status)}
     * @param {object} [opt] {dimMs, dimStep, fxMs} (tests shorten them)
     */
    constructor(io, opt = {}) {
        this.io = io;
        this.dimMs = opt.dimMs || 300;
        this.dimStep = opt.dimStep || 5;
        this.fxMs = opt.fxMs || 2000;
        this.tiles = new Map();
        this.mem = new Map();
        this.watch = new Map();
        this.warned = new Set();
    }

    /** the color tiles of the layout: [{key 'page/tile', tile}] */
    update(list) {
        this.tiles = new Map(list.map(x => [x.key, x.tile]));
        for (const key of [...this.mem.keys()]) {
            if (!this.tiles.has(key)) {
                this._stopFx(key);
                this._stopDim(key);
                this.mem.delete(key);
            }
        }
        this.watch = new Map();
        for (const [key, t] of this.tiles) {
            for (const role of ['knxSwitch', 'knxDim', 'state', 'bright']) {
                if (t[role]) {
                    if (!this.watch.has(t[role])) {
                        this.watch.set(t[role], []);
                    }
                    this.watch.get(t[role]).push({ key, role });
                }
            }
        }
    }

    stop() {
        for (const key of this.mem.keys()) {
            this._stopFx(key);
            this._stopDim(key);
        }
    }

    /** for the page: {key: {fx, idx}} */
    status() {
        const out = {};
        for (const [key, m] of this.mem) {
            if (this.tiles.has(key)) {
                out[key] = { fx: m.fx, idx: m.idx };
            }
        }
        return out;
    }

    _m(key) {
        if (!this.mem.has(key)) {
            this.mem.set(key, { idx: -1, fx: false, resume: false, hue: 0, fxTimer: null, dim: null, lastStatus: undefined, lastBright: undefined });
        }
        return this.mem.get(key);
    }

    _get(id) {
        return id ? this.io.get(id) : undefined;
    }

    _scale(id) {
        const m = Number(this.io.max ? this.io.max(id) : NaN);
        return m > 0 ? m : 255;
    }

    _cur(t) {
        return C.current(t, id => this._get(id), id => (this.io.max ? this.io.max(id) : undefined));
    }

    _set(t, id, val) {
        if (!id) {
            return Promise.resolve();
        }
        return Promise.resolve(this.io.set(id, val)).catch(err => this.io.log.warn(`${t.label || 'Farblicht'}: ${id}: ${err.message}`));
    }

    _changed() {
        if (this.io.changed) {
            this.io.changed(this.status());
        }
    }

    /** a state of the layout changed; own = written by this adapter (echo, not a button press) */
    onState(id, state, own) {
        for (const { key, role } of this.watch.get(id) || []) {
            const t = this.tiles.get(key);
            const m = this._m(key);
            const val = state ? state.val : null;
            if (role === 'knxSwitch') {
                if (!own && val !== null && val !== undefined) {
                    this.command(key, C.truthy(val) ? 'next' : 'off', null, 'KNX').catch(() => {});
                }
            } else if (role === 'knxDim') {
                if (own || val === null || val === undefined) {
                    continue;
                }
                const dir = C.dimDir(val);
                if (dir) {
                    this.command(key, 'dim', dir, 'KNX').catch(() => {});
                } else if (!this.warned.has(id)) {
                    this.warned.add(id);
                    this.io.log.warn(`${t.label || key}: Dimm-Telegramm ${JSON.stringify(val)} von ${id} nicht verstanden (erwartet KNX DPT 3.007)`);
                }
            } else if (role === 'state') {
                const on = C.truthy(val);
                if (!on) {
                    // switched off (also from elsewhere): color changer pauses, comes back with the next "on"
                    if (m.fx) {
                        m.resume = true;
                        this._stopFx(key);
                        this._changed();
                    }
                    this._stopDim(key);
                }
                if (t.knxStatus && on !== m.lastStatus) {
                    m.lastStatus = on;
                    this._set(t, t.knxStatus, on);
                }
            } else if (role === 'bright') {
                const b = Math.round(Number(val));
                if (t.knxBright && Number.isFinite(b) && b !== m.lastBright) {
                    m.lastBright = b;
                    this._set(t, t.knxBright, b);
                }
            }
        }
    }

    /**
     * toggle | on | off | next (off: on, on: next color) | preset (arg index) | rgb (arg '#rrggbb') | fx | dim (arg up/down/stop)
     */
    async command(key, action, arg, source = '') {
        const t = this.tiles.get(key);
        if (!t) {
            return;
        }
        const m = this._m(key);
        const colors = C.parseColors(t.colors);
        const cur = this._cur(t);
        this.io.log.debug(`${t.label || key}: ${action}${arg !== null && arg !== undefined ? ` ${arg}` : ''}${source ? ` (${source})` : ''}`);
        switch (action) {
            case 'toggle':
                return this.command(key, cur.on ? 'off' : 'on', null, source);
            case 'on':
                await this._on(t, cur);
                if (m.resume) {
                    this._startFx(key);
                }
                break;
            case 'off':
                if (m.fx) {
                    m.resume = true;
                }
                this._stopFx(key);
                this._stopDim(key);
                if (t.state) {
                    await this._set(t, t.state, false);
                } else {
                    await this._set(t, t.bright, 0);
                }
                break;
            case 'next': {
                if (!cur.on) {
                    return this.command(key, 'on', null, source);
                }
                if (!colors.length) {
                    return;
                }
                const at = m.idx >= 0 && m.idx < colors.length ? m.idx : m.fx ? -1 : C.matchPreset(colors, cur, this._hasWhite(t));
                await this._apply(key, t, colors, (at + 1) % colors.length);
                break;
            }
            case 'preset': {
                const i = Number(arg);
                if (Number.isInteger(i) && i >= 0 && i < colors.length) {
                    await this._apply(key, t, colors, i);
                }
                break;
            }
            case 'rgb': {
                const rgb = C.hexRgb(arg);
                if (!rgb) {
                    return;
                }
                this._stopFx(key);
                m.resume = false;
                m.idx = -1;
                await this._writeColor(t, rgb, 0);
                await this._ensureOn(t);
                break;
            }
            case 'fx': {
                const i = colors.findIndex(c => c.fx);
                m.idx = i;
                await this._ensureOn(t);
                this._startFx(key);
                break;
            }
            case 'dim':
                this._dim(key, t, arg, cur);
                return;
            default:
                return;
        }
        this._changed();
    }

    _hasWhite(t) {
        if (t.white) {
            return true;
        }
        const c = t.rgb ? C.parseColor(this._get(t.rgb)) : null;
        return Boolean(c && c.w !== undefined);
    }

    async _on(t, cur) {
        if (t.state) {
            await this._set(t, t.state, true);
        } else if (t.bright && !(cur.bright > 0)) {
            await this._set(t, t.bright, 100);
        }
    }

    async _ensureOn(t) {
        const cur = this._cur(t);
        if (!cur.on) {
            await this._on(t, cur);
        }
    }

    async _apply(key, t, colors, i) {
        const m = this._m(key);
        const c = colors[i];
        m.idx = i;
        m.resume = false;
        if (c.fx) {
            await this._ensureOn(t);
            this._startFx(key);
            return;
        }
        this._stopFx(key);
        await this._writeColor(t, this._hasWhite(t) ? c.rgb : C.rgbOnly(c), this._hasWhite(t) ? c.white : 0);
        await this._ensureOn(t);
    }

    /** rgb 0-255, white 0-1 into the light's data points (combined color string and/or channels) */
    async _writeColor(t, rgb, white) {
        const jobs = [];
        if (t.rgb) {
            jobs.push(this._set(t, t.rgb, C.formatColor(rgb, white * 255, this._get(t.rgb))));
        }
        [t.red, t.green, t.blue].forEach((id, i) => {
            if (id) {
                jobs.push(this._set(t, id, Math.round((rgb[i] / 255) * this._scale(id))));
            }
        });
        if (t.white) {
            jobs.push(this._set(t, t.white, Math.round(white * this._scale(t.white))));
        }
        await Promise.all(jobs);
    }

    _startFx(key) {
        const t = this.tiles.get(key);
        const m = this._m(key);
        m.fx = true;
        m.resume = false;
        if (m.fxTimer) {
            return;
        }
        const period = clamp(Number(t.fxTime) || 60, 10, 3600) * 1000;
        const tick = () => {
            m.hue = (m.hue + (360 * this.fxMs) / period) % 360;
            this._writeColor(t, C.hueRgb(m.hue), 0);
        };
        tick();
        m.fxTimer = setInterval(tick, this.fxMs);
    }

    _stopFx(key) {
        const m = this.mem.get(key);
        if (!m) {
            return;
        }
        m.fx = false;
        if (m.fxTimer) {
            clearInterval(m.fxTimer);
            m.fxTimer = null;
        }
    }

    _stopDim(key) {
        const m = this.mem.get(key);
        if (m && m.dim) {
            clearInterval(m.dim.timer);
            clearTimeout(m.dim.limit);
            m.dim = null;
        }
    }

    /** dimming while the button is held: a step every dimMs until stop (or 15 s, if the stop telegram got lost) */
    _dim(key, t, dir, cur) {
        this._stopDim(key);
        if (dir !== 'up' && dir !== 'down') {
            return;
        }
        if (!t.bright) {
            if (!this.warned.has(`${key}#bright`)) {
                this.warned.add(`${key}#bright`);
                this.io.log.warn(`${t.label || key}: Dimmen braucht den Datenpunkt „Helligkeit“`);
            }
            return;
        }
        const m = this._m(key);
        let lvl = cur.bright === null ? 50 : cur.bright;
        let off = !cur.on;
        if (off) {
            if (dir === 'down') {
                return;
            }
            lvl = 0; // from off: start dark and get brighter
        }
        const step = () => {
            lvl = clamp(Math.round(lvl + (dir === 'up' ? this.dimStep : -this.dimStep)), 1, 100);
            this._set(t, t.bright, lvl);
            if (off) {
                off = false;
                this._on(t, { bright: lvl });
            }
            if (lvl === 100 || lvl === 1) {
                this._stopDim(key);
            }
        };
        m.dim = { timer: setInterval(step, this.dimMs), limit: setTimeout(() => this._stopDim(key), 15000) };
        step();
    }
}

module.exports = { ColorLights };
