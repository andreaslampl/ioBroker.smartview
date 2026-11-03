'use strict';

/*
 * Household appliances (washer, dryer, dishwasher, ...): does a device run right now? Used by the adapter (state machine
 * off -> run -> done, messages) and by the page (fallback while the adapter's status is not there yet).
 * Sources: power (W, e.g. a Shelly plug; kW by the object's unit) or a status data point (e.g. Home Connect
 * BSH_Common_Status_OperationState: ...OperationState.Run / Finished / Ready).
 * st(id) returns {val, unit, states, missing} or null.
 */
(function (root) {
    const TEXT = { off: 'Aus', run: 'Läuft', done: 'Fertig' };
    const DEFAULT_RUN = 'Run;DelayedStart;Pause';
    const DEFAULT_DONE = 'Finished';

    function tokens(s) {
        return String(s || '')
            .split(/[;,]/)
            .map(x => x.trim())
            .filter(Boolean);
    }

    /** value matches one of the tokens: numbers exactly, texts contained (case-insensitive) in the value or its states text */
    function matches(info, list) {
        if (!info || info.missing || info.val === null || info.val === undefined) {
            return false;
        }
        const raw = String(info.val);
        const text = info.states && info.states[raw] !== undefined ? String(info.states[raw]) : '';
        return tokens(list).some(t => {
            if (/^-?\d+(\.\d+)?$/.test(t)) {
                return Number(raw) === Number(t) || (text !== '' && text === t);
            }
            const l = t.toLowerCase();
            return raw.toLowerCase().includes(l) || text.toLowerCase().includes(l);
        });
    }

    /** watts of a power data point (kW / MW by unit) or null */
    function watts(info) {
        if (!info || info.missing || info.val === null || info.val === undefined || info.val === '') {
            return null;
        }
        const n = Number(String(info.val).replace(',', '.'));
        if (!Number.isFinite(n)) {
            return null;
        }
        const u = String(info.unit || '').trim().toLowerCase();
        return u === 'kw' ? n * 1000 : u === 'mw' ? n * 1e6 : n;
    }

    /**
     * 'state' or 'power': a device set to "Leistung" whose data point holds a text (e.g. Home Connect
     * "BSH.Common.EnumType.OperationState.Run") is read as a status - easy to pick the wrong kind in the editor
     */
    function kindOf(dev, st) {
        if (dev.kind === 'state') {
            return 'state';
        }
        const info = dev.state ? st(dev.state) : null;
        const v = info && !info.missing ? info.val : null;
        return typeof v === 'string' && v.trim() !== '' && !Number.isFinite(Number(v.replace(',', '.'))) ? 'state' : 'power';
    }

    /**
     * What the data point says now: {run: true|false|null (unknown), done: true when the status says finished, w}
     * @param {object} dev {kind: 'power'|'state', state, onW, runAt, doneAt}
     */
    function reading(dev, st) {
        const info = dev.state ? st(dev.state) : null;
        if (kindOf(dev, st) === 'state') {
            if (!info || info.missing || info.val === null || info.val === undefined) {
                return { run: null, done: false };
            }
            return { run: matches(info, dev.runAt || DEFAULT_RUN), done: matches(info, dev.doneAt || DEFAULT_DONE) };
        }
        const w = watts(info);
        return { run: w === null ? null : w >= (Number(dev.onW) > 0 ? Number(dev.onW) : 10), done: false, w };
    }

    /** remaining time from an optional data point: seconds (Home Connect) or minutes (unit min) -> ms, or null */
    function remaining(dev, st) {
        const info = dev.remain ? st(dev.remain) : null;
        if (!info || info.missing || info.val === null || info.val === undefined || info.val === '') {
            return null;
        }
        const n = Number(info.val);
        if (!Number.isFinite(n) || n <= 0) {
            return null;
        }
        const u = String(info.unit || '').trim().toLowerCase();
        return n * (u === 'min' ? 60000 : u === 'h' ? 3600000 : 1000);
    }

    const api = { TEXT, DEFAULT_RUN, DEFAULT_DONE, matches, watts, reading, remaining, kindOf };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AppLogic = api;
    }
})(this);
