'use strict';

/*
 * Color light (RGBW, e.g. Shelly RGBW2 / Plus RGBW PM): color presets, color formats of the data points, KNX dimming
 * telegrams. Used by the adapter (lib/colorlight.js: KNX push button, color changer) and by the page (display).
 */
(function (root) {
    // Name=value; value: #rrggbb, w / w<percent> (white channel), fx (color changer), also combined: "#ffffff w30"
    const DEFAULT_COLORS = 'Warmweiß=w;Kaltweiß=#ffffff;Rot=#ff0000;Orange=#ff5000;Grün=#00ff00;Blau=#0000ff;Lila=#8000ff;Farbwechsel=fx';
    // white light by RGB only (no white channel)
    const WARM_RGB = [255, 150, 60];

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function hex2(n) {
        return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
    }

    /** '#rrggbb' -> [r, g, b] (0-255) or null */
    function hexRgb(s) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
        return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null;
    }

    function rgbHex(rgb) {
        return '#' + rgb.map(hex2).join('');
    }

    /** "Rot=#ff0000;Warmweiß=w;Farbwechsel=fx" -> [{label, rgb, white (0-1), fx}] */
    function parseColors(text) {
        const src = String(text || '').trim() || DEFAULT_COLORS;
        const out = [];
        for (const part of src.split(';')) {
            const i = part.indexOf('=');
            if (i < 0) {
                continue;
            }
            const label = part.slice(0, i).trim();
            const spec = part.slice(i + 1).trim().toLowerCase();
            if (!label || !spec) {
                continue;
            }
            const c = { label, rgb: [0, 0, 0], white: 0, fx: false };
            let ok = false;
            for (const tok of spec.split(/\s+/)) {
                if (tok === 'fx') {
                    c.fx = ok = true;
                } else if (/^w\d*$/.test(tok)) {
                    c.white = tok.length > 1 ? clamp(Number(tok.slice(1)), 0, 100) / 100 : 1;
                    ok = true;
                } else if (hexRgb(tok)) {
                    c.rgb = hexRgb(tok);
                    ok = true;
                }
            }
            if (ok) {
                out.push(c);
            }
        }
        return out.slice(0, 24);
    }

    /** value of a color data point: '#rrggbb', '#rrggbbww' (Shelly RGBW2 lights.rgbw), 'r,g,b' or 'r,g,b,w' -> {rgb, w} */
    function parseColor(v) {
        const s = String(v === undefined || v === null ? '' : v).trim();
        let m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
        if (m) {
            return { rgb: hexRgb(m[1]), w: m[2] !== undefined ? parseInt(m[2], 16) : undefined };
        }
        m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d{1,3}))?$/.exec(s);
        if (m) {
            return { rgb: [m[1], m[2], m[3]].map(x => clamp(Number(x), 0, 255)), w: m[4] !== undefined ? clamp(Number(m[4]), 0, 255) : undefined };
        }
        return null;
    }

    /** color in the same format as the data point holds now (sample); w = 0-255 for '#rrggbbww' */
    function formatColor(rgb, w, sample) {
        const s = String(sample === undefined || sample === null ? '' : sample).trim();
        if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(s)) {
            return rgb.map(Math.round).join(',') + ',' + Math.round(w || 0);
        }
        if (/^\d{1,3}\s*,/.test(s)) {
            return rgb.map(Math.round).join(',');
        }
        if (/^#?[0-9a-f]{8}$/i.test(s)) {
            return rgbHex(rgb) + hex2(w || 0);
        }
        return rgbHex(rgb);
    }

    /** hue 0-360 at full saturation -> [r, g, b] 0-255 */
    function hueRgb(h) {
        const x = (((h % 360) + 360) % 360) / 60;
        const i = Math.floor(x);
        const f = x - i;
        const q = 1 - f;
        const v = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6];
        return v.map(c => Math.round(c * 255));
    }

    /**
     * KNX relative dimming (DPT 3.007) as it arrives in ioBroker: raw 4 bit (bit 3 = up, bits 0-2 = step, 0 = stop),
     * {decr_incr, data} (also as JSON text), a signed number (+ up, - down, 0 stop) or true/false (up/down)
     * -> 'up' | 'down' | 'stop' | null
     */
    function dimDir(v) {
        if (typeof v === 'string') {
            const s = v.trim();
            if (/^[{[]/.test(s)) {
                try {
                    return dimDir(JSON.parse(s));
                } catch {
                    return null;
                }
            }
            if (/^(up|heller|increase)$/i.test(s)) {
                return 'up';
            }
            if (/^(down|dunkler|decrease)$/i.test(s)) {
                return 'down';
            }
            if (/^(stop|stopp)$/i.test(s)) {
                return 'stop';
            }
            v = s === '' ? NaN : Number(s);
        }
        if (v && typeof v === 'object') {
            const dir = v.decr_incr !== undefined ? v.decr_incr : v.direction;
            const step = v.data !== undefined ? v.data : v.stepcode !== undefined ? v.stepcode : v.step;
            if (Number(step) === 0) {
                return 'stop';
            }
            return Number(dir) === 1 || dir === true ? 'up' : 'down';
        }
        if (typeof v === 'boolean') {
            return v ? 'up' : 'down';
        }
        const n = Number(v);
        if (!Number.isFinite(n)) {
            return null;
        }
        if (Number.isInteger(n) && n >= 0 && n <= 15) {
            if ((n & 7) === 0) {
                return 'stop';
            }
            return n & 8 ? 'up' : 'down';
        }
        return n > 0 ? 'up' : n < 0 ? 'down' : 'stop';
    }

    const truthy = v => v === true || v === 1 || v === 'true' || v === '1' || v === 'on' || v === 'ON';

    /**
     * What the light shows now: {on, bright (0-100 or null), rgb, w (0-1), css}
     * @param {object} t tile; get(id) -> value
     */
    function current(t, get, maxOf) {
        const n = id => (id ? Number(get(id)) : NaN);
        const scale = id => {
            const m = Number(maxOf ? maxOf(id) : NaN);
            return m > 0 ? m : 255;
        };
        let rgb = null;
        let w;
        if (t.rgb) {
            const c = parseColor(get(t.rgb));
            if (c) {
                rgb = c.rgb;
                w = c.w !== undefined ? c.w / 255 : undefined;
            }
        }
        if (!rgb && (t.red || t.green || t.blue)) {
            rgb = [t.red, t.green, t.blue].map(id => (Number.isFinite(n(id)) ? clamp((n(id) / scale(id)) * 255, 0, 255) : 0));
        }
        if (t.white && Number.isFinite(n(t.white))) {
            w = clamp(n(t.white) / scale(t.white), 0, 1);
        }
        const b = n(t.bright);
        const bright = Number.isFinite(b) ? clamp(b, 0, 100) : null;
        const on = t.state ? truthy(get(t.state)) : bright !== null ? bright > 0 : false;
        // shown color: white part mixed in as warm white
        const base = rgb || [0, 0, 0];
        const ww = w || 0;
        const mix = base.map((c, i) => clamp(Math.max(c, WARM_RGB[i] * ww), 0, 255));
        const css = Math.max(...mix) > 0 ? rgbHex(mix) : '';
        return { on, bright, rgb: base, w: ww, css };
    }

    /** index of the preset that matches the current color (not the color changer), else -1 */
    function matchPreset(colors, cur, hasWhite) {
        const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) <= 6);
        return colors.findIndex(c => {
            if (c.fx) {
                return false;
            }
            if (hasWhite) {
                return near(c.rgb, cur.rgb) && Math.abs(c.white - cur.w) <= 0.03;
            }
            return near(rgbOnly(c), cur.rgb);
        });
    }

    /** a preset's color for a light without white channel (white part mixed in as warm white) */
    function rgbOnly(c) {
        return c.rgb.map((x, i) => clamp(Math.max(x, WARM_RGB[i] * c.white), 0, 255));
    }

    const api = { DEFAULT_COLORS, WARM_RGB, parseColors, parseColor, formatColor, hexRgb, rgbHex, hueRgb, dimDir, current, matchPreset, rgbOnly, truthy };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.ColorLogic = api;
    }
})(this);
