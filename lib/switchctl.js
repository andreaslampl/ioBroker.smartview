'use strict';

/*
 * Switch / dimmer / blind tiles with extras, run in the adapter (so time switches, scenes and wind protection get them too):
 *   - `also`: more data points that get the same command
 *   - `onDelay` / `offDelay` (s): the command is carried out later; a new command cancels the waiting one
 *   - `autoOff` (min): switched off again after this time (staircase light), a new "on" starts it again
 * Waiting commands are shown on the tile ({key: {at, on}}).
 */
const truthy = v => v === true || v === 1 || v === 'true' || v === '1' || v === 'on' || v === 'ON';

class SwitchCtl {
    /**
     * @param {object} io {write(id, val) -> Promise (plain write), log, changed(status)}
     */
    constructor(io) {
        this.io = io;
        this.byId = new Map();
        this.pending = new Map(); // key -> {timer, at, on}
    }

    /** tiles of the saved layout: [{key, tile}] */
    update(list) {
        this.byId = new Map();
        const keys = new Set();
        for (const { key, tile } of list) {
            const t = tile;
            const hasExtra = (t.also || []).length || t.onDelay > 0 || t.offDelay > 0 || t.autoOff > 0;
            if (!hasExtra || !['switch', 'dimmer', 'blind'].includes(t.type)) {
                continue;
            }
            keys.add(key);
            for (const role of ['state', 'switchState', 'stop']) {
                if (t[role] && !this.byId.has(t[role])) {
                    this.byId.set(t[role], { key, tile: t, role });
                }
            }
        }
        for (const key of [...this.pending.keys()]) {
            if (!keys.has(key)) {
                this._clear(key);
            }
        }
        this._changed();
    }

    handles(id) {
        return this.byId.has(id);
    }

    stop() {
        for (const key of [...this.pending.keys()]) {
            this._clear(key);
        }
    }

    status() {
        const out = {};
        for (const [key, p] of this.pending) {
            out[key] = { at: p.at, on: p.on };
        }
        return out;
    }

    _changed() {
        if (this.io.changed) {
            this.io.changed(this.status());
        }
    }

    _clear(key) {
        const p = this.pending.get(key);
        if (p) {
            clearTimeout(p.timer);
            this.pending.delete(key);
        }
    }

    _schedule(key, sec, on, fn) {
        this._clear(key);
        const timer = setTimeout(() => {
            this.pending.delete(key);
            this._changed();
            fn().catch(err => this.io.log.warn(`${key}: ${err.message}`));
        }, sec * 1000);
        this.pending.set(key, { timer, at: Date.now() + sec * 1000, on });
        this._changed();
    }

    /** does the command switch on? null for blinds (no delays there) */
    _isOn(t, role, val) {
        if (t.type === 'switch') {
            return truthy(val) !== Boolean(t.invert);
        }
        if (t.type === 'dimmer') {
            return role === 'switchState' ? truthy(val) : Number(val) > 0;
        }
        return null;
    }

    /** a command to one of the tile's data points (from the page, a time switch, a scene …) */
    async command(id, val) {
        const { key, tile: t, role } = this.byId.get(id);
        if (role === 'stop') {
            this._clear(key);
            this._changed();
            return this._write(t, id, val);
        }
        const on = this._isOn(t, role, val);
        const delay = on === null ? 0 : Number(on ? t.onDelay : t.offDelay) || 0;
        const p = this.pending.get(key);
        // the page may send two commands for one tap (dimmer: on/off + level): wait for both together
        if (delay > 0 && p && p.on === on && p.writes) {
            p.writes.push([id, val]);
            return;
        }
        this._clear(key);
        if (delay > 0) {
            this.io.log.info(`${t.label || key}: ${on ? 'Ein' : 'Aus'} in ${delay} s`);
            const writes = [[id, val]];
            this._schedule(key, delay, on, async () => {
                for (const [wid, wval] of writes) {
                    await this._apply(key, t, wid, wval, on);
                }
            });
            this.pending.get(key).writes = writes;
            return;
        }
        this._changed();
        await this._apply(key, t, id, val, on);
    }

    async _apply(key, t, id, val, on) {
        await this._write(t, id, val);
        if (on && t.autoOff > 0) {
            const off = t.type === 'switch' ? [t.state, Boolean(t.invert)] : t.switchState ? [t.switchState, false] : [t.state, 0];
            this._schedule(key, t.autoOff * 60, false, () => this._write(t, off[0], off[1]));
        }
    }

    /** the tile's own data point and all `also` ones */
    async _write(t, id, val) {
        const jobs = [this.io.write(id, val)];
        if (id === t.state || id === t.switchState) {
            for (const a of t.also || []) {
                jobs.push(Promise.resolve(this.io.write(a, val)).catch(err => this.io.log.warn(`${t.label || id}: ${a}: ${err.message}`)));
            }
        }
        await Promise.all(jobs);
    }
}

module.exports = { SwitchCtl, truthy };
