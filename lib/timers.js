'use strict';

/*
 * Time switches for switch, dimmer and blind tiles. Stored in timers.json separate from the layout,
 * so they can be changed in the app without edit mode:
 *   { "<pageId>/<tileId>": { enabled, entries: [{ id, enabled, days: [1..7] (1 = Monday),
 *       at: 'time'|'sunrise'|'sunset', time: 'HH:MM', offset: minutes, action, value }] } }
 * action: switch 'on'|'off'; dimmer 'on'|'off'|'level'; blind 'up'|'down'|'position' (value = % open).
 * The scheduler runs in the adapter (switches without any browser open). An entry fires once per
 * day when its time has come (up to 5 min late, e.g. after a busy moment); times that already
 * passed when the adapter starts are not caught up.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sunTimes } = require('./sun');

const ACTIONS = { switch: ['on', 'off'], dimmer: ['on', 'off', 'level'], blind: ['up', 'down', 'position'] };
const LATE = 5 * 60000;

function cleanEntry(e, i, type) {
    e = e && typeof e === 'object' ? e : {};
    const days = [...new Set((Array.isArray(e.days) ? e.days : []).map(Number).filter(d => d >= 1 && d <= 7))].sort();
    const at = ['time', 'sunrise', 'sunset'].includes(e.at) ? e.at : 'time';
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(e.time || ''));
    const time = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : '07:00';
    const actions = ACTIONS[type] || ACTIONS.switch;
    const action = actions.includes(e.action) ? e.action : actions[0];
    const out = {
        id: /^[\w-]{1,20}$/.test(String(e.id || '')) ? String(e.id) : `e${i + 1}`,
        enabled: e.enabled !== false,
        days: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
        at,
        time,
        offset: Math.max(-240, Math.min(240, Math.round(Number(e.offset) || 0))),
        action,
    };
    if (action === 'level' || action === 'position') {
        out.value = Math.max(0, Math.min(100, Math.round(Number(e.value)))) || 0;
    }
    return out;
}

function cleanTimer(t, type) {
    t = t && typeof t === 'object' ? t : {};
    const seen = new Set();
    const entries = (Array.isArray(t.entries) ? t.entries : []).slice(0, 20).map((e, i) => {
        const c = cleanEntry(e, i, type);
        while (seen.has(c.id)) {
            c.id += 'x';
        }
        seen.add(c.id);
        return c;
    });
    return { enabled: t.enabled !== false, entries };
}

/** Weekday 1 (Monday) .. 7 (Sunday) */
function weekday(ms) {
    return ((new Date(ms).getDay() + 6) % 7) + 1;
}

class Timers {
    /**
     * @param {object} o
     * @param {string} o.dir instance data directory
     * @param {(key: string) => object|null} o.tile tile for "page/tile" (null when deleted)
     * @param {(tile: object, action: string, value: number, key: string, entry: object) => Promise} o.fire
     * @param {{latitude: number, longitude: number}|null} o.location
     */
    constructor({ dir, tile, fire, location = null, log, now = () => Date.now() }) {
        this.file = path.join(dir, 'timers.json');
        this.tile = tile;
        this.fire = fire;
        this.location = location;
        this.log = log;
        this.now = now;
        this.fired = new Map(); // "key/entry" -> trigger time already handled
        try {
            this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
        } catch {
            this.data = {};
        }
        this._markPast();
    }

    _write() {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }

    /** Save the timer of one tile (from the app). */
    set(key, timer) {
        const tile = this.tile(key);
        if (!tile || !ACTIONS[tile.type]) {
            throw new Error('Zeitschaltuhr nur für Schalter, Dimmer und Rollläden');
        }
        const clean = cleanTimer(timer, tile.type);
        if (clean.entries.length) {
            this.data[key] = clean;
        } else {
            delete this.data[key];
        }
        this._write();
        this._markPast(key);
        return clean;
    }

    /** Trigger time of an entry on the day of `dayMs` (null without location for sun times). */
    timeOn(entry, dayMs) {
        const d = new Date(dayMs);
        if (entry.at === 'time') {
            const [h, m] = entry.time.split(':').map(Number);
            d.setHours(h, m, 0, 0);
            return d.getTime();
        }
        if (!this.location) {
            return null;
        }
        const sun = sunTimes(dayMs, this.location.latitude, this.location.longitude);
        const base = entry.at === 'sunrise' ? sun.rise : sun.set;
        // whole minutes, so the app shows the same time that is switched
        return Math.round((base + entry.offset * 60000) / 60000) * 60000;
    }

    /** Next trigger time of an entry (within 8 days) or null. */
    next(entry, from = this.now()) {
        for (let i = 0; i < 9; i++) {
            const day = new Date(from);
            day.setHours(12, 0, 0, 0);
            day.setDate(day.getDate() + i);
            const t = this.timeOn(entry, day.getTime());
            if (t !== null && t > from && entry.days.includes(weekday(t))) {
                return t;
            }
        }
        return null;
    }

    /** Times that are already over today count as done (no catching up after a restart or a change). */
    _markPast(onlyKey) {
        const now = this.now();
        for (const [key, timer] of Object.entries(this.data)) {
            if (onlyKey && key !== onlyKey) {
                continue;
            }
            for (const e of timer.entries) {
                const t = this.timeOn(e, now);
                if (t !== null && t <= now) {
                    this.fired.set(`${key}/${e.id}`, t);
                }
            }
        }
    }

    /** Called every few seconds: fire what is due. */
    tick() {
        const now = this.now();
        for (const [key, timer] of Object.entries(this.data)) {
            if (!timer.enabled) {
                continue;
            }
            const tile = this.tile(key);
            if (!tile) {
                continue;
            }
            for (const e of timer.entries) {
                if (!e.enabled) {
                    continue;
                }
                const t = this.timeOn(e, now);
                const id = `${key}/${e.id}`;
                if (t === null || t > now || now - t > LATE || this.fired.get(id) === t || !e.days.includes(weekday(t))) {
                    continue;
                }
                this.fired.set(id, t);
                Promise.resolve(this.fire(tile, e.action, e.value, key, e)).catch(err => this.log.warn(`Timer ${key}: ${err.message}`));
            }
        }
    }

    /** All timers with the next trigger time per entry, for the app. */
    list() {
        const out = {};
        for (const [key, timer] of Object.entries(this.data)) {
            out[key] = { ...timer, entries: timer.entries.map(e => ({ ...e, next: this.next(e) })) };
        }
        return out;
    }

    sunToday() {
        if (!this.location) {
            return null;
        }
        return sunTimes(this.now(), this.location.latitude, this.location.longitude);
    }

    start(intervalMs = 15000) {
        this.timer = setInterval(() => this.tick(), intervalMs);
    }

    stop() {
        clearInterval(this.timer);
    }
}

module.exports = { Timers, cleanTimer, weekday, ACTIONS };
