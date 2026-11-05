'use strict';

/*
 * Robot tile (vacuum / lawn mower, any brand): status texts, "working", templates for adapters (dreame,
 * husqvarna-automower), GPS position on an own picture (two calibration points). Page + adapter (layout.js).
 */
(function (root) {
    const MOWER_TEXTS = 'MOWING=Mäht;GOING_HOME=Fährt heim;CHARGING=Lädt;LEAVING=Fährt los;PARKED_IN_CS=Geparkt;STOPPED_IN_GARDEN=Steht im Garten;NOT_APPLICABLE=Manueller Start nötig;UNKNOWN=Unbekannt';
    const DREAME_TEXTS = '1=Saugt;2=Bereit;3=Pause;4=Fehler;5=Fährt zur Station;6=Lädt;7=Wischt;8=Trocknet;9=Wäscht;13=Geladen';
    const DREAME_MOWER_TEXTS = '1=Mäht;2=Bereit;3=Pause;5=Fährt heim;6=Lädt;11=Kartiert;13=Geladen;14=Update';

    /**
     * Data points of a known adapter from any data point of the device (picked in `device`):
     * {prefix, adapter, fields, options} or null
     */
    function template(deviceId, kind) {
        const id = String(deviceId || '');
        let m = /^(husqvarna-automower\.\d+\.[^.]+)/.exec(id);
        if (m) {
            const p = m[1];
            return {
                prefix: p,
                adapter: 'husqvarna',
                fields: {
                    status: `${p}.mower.activity`,
                    battery: `${p}.battery.batteryPercent`,
                    error: `${p}.mower.errorCode`,
                    start: `${p}.ACTIONS.start.START`,
                    resume: `${p}.ACTIONS.RESUMESCHEDULE`,
                    pause: `${p}.ACTIONS.PAUSE`,
                    home: `${p}.ACTIONS.PARKUNTILFURTHERNOTICE`,
                    homeNext: `${p}.ACTIONS.PARKUNTILNEXTSCHEDULE`,
                    connected: `${p}.metadata.connected`,
                    lat: `${p}.positions.latitude`,
                    lon: `${p}.positions.longitude`,
                    track: `${p}.positions.positions`,
                    areaId: `${p}.ACTIONS.startInWorkArea.workAreaId`,
                    areaStart: `${p}.ACTIONS.startInWorkArea.STARTINWORKAREA`,
                },
                options: { robotKind: 'mower', texts: MOWER_TEXTS, runAt: 'MOWING;LEAVING;GOING_HOME', mapMode: 'gps' },
            };
        }
        m = /^(dreame\.\d+)\.([^.]+)/.exec(id);
        if (m) {
            const p = `${m[1]}.${m[2]}`;
            const mower = kind === 'mower';
            return {
                prefix: p,
                adapter: 'dreame',
                fields: mower
                    ? { status: `${p}.status.status`, battery: `${p}.status.battery-level`, error: `${p}.status.error`, start: `${p}.remote.start-mow`, pause: `${p}.remote.pause-mow`, home: `${p}.remote.start-charge`, stop: `${p}.remote.stop-mow` }
                    : { status: `${p}.status.state`, battery: `${p}.status.battery-level`, error: `${p}.status.error`, start: `${p}.remote.start-clean`, pause: `${p}.remote.pause`, home: `${p}.remote.return-to-dock`, stop: `${p}.remote.stop` },
                options: { robotKind: mower ? 'mower' : 'vacuum', texts: mower ? DREAME_MOWER_TEXTS : DREAME_TEXTS, runAt: mower ? '1;5' : '1;5;7', mapMode: 'url', mapUrl: `web:/dreame/?did=${encodeURIComponent(m[2])}` },
            };
        }
        return null;
    }

    /** "1=Saugt;2=Bereit" -> {1: 'Saugt', 2: 'Bereit'} */
    function parseTexts(s) {
        const out = {};
        for (const part of String(s || '').split(';')) {
            const i = part.indexOf('=');
            if (i > 0) {
                out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
            }
        }
        return out;
    }

    /** status text: own texts, else the data point's states, else the value */
    function statusText(t, info) {
        if (!info || info.missing || info.val === null || info.val === undefined || info.val === '') {
            return '';
        }
        const raw = String(info.val);
        const own = parseTexts(t.texts);
        if (own[raw] !== undefined) {
            return own[raw];
        }
        if (info.states && info.states[raw] !== undefined) {
            return String(info.states[raw]);
        }
        return raw;
    }

    /** working (mowing / cleaning / on its way): value or its text contains one of runAt (numbers exact) */
    function working(t, info) {
        if (!info || info.missing || info.val === null || info.val === undefined) {
            return false;
        }
        const raw = String(info.val);
        const text = info.states && info.states[raw] !== undefined ? String(info.states[raw]) : '';
        const list = String(t.runAt || 'MOWING;LEAVING;GOING_HOME;CLEANING;Cleaning;Mowing;Returning')
            .split(/[;,]/)
            .map(x => x.trim())
            .filter(Boolean);
        return list.some(tok => (/^-?\d+$/.test(tok) ? raw === tok : raw.toLowerCase().includes(tok.toLowerCase()) || text.toLowerCase().includes(tok.toLowerCase())));
    }

    /** an error code / text that means something (0, '', false, NO_ERROR = none) */
    function hasError(info) {
        if (!info || info.missing) {
            return false;
        }
        const v = info.val;
        if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') {
            return false;
        }
        return !/^(no_?error|none|ok|null|\[\])$/i.test(String(v).trim());
    }

    /** "x1,y1=lat1,lon1;x2,y2=lat2,lon2" (x/y in % of the picture) -> [{x, y, lat, lon}, …] or null */
    function parseCal(s) {
        const pts = String(s || '')
            .split(';')
            .map(p => {
                const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*=\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(p);
                return m ? { x: Number(m[1]), y: Number(m[2]), lat: Number(m[3]), lon: Number(m[4]) } : null;
            })
            .filter(Boolean);
        if (pts.length < 2 || pts[0].lat === pts[1].lat || pts[0].lon === pts[1].lon) {
            return null;
        }
        return pts.slice(0, 2);
    }

    /** GPS -> position in % on the picture (north up, picture not rotated, like a map screenshot) */
    function toXY(cal, lat, lon) {
        if (!cal || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
            return null;
        }
        const [a, b] = cal;
        return {
            x: a.x + ((Number(lon) - a.lon) * (b.x - a.x)) / (b.lon - a.lon),
            y: a.y + ((Number(lat) - a.lat) * (b.y - a.y)) / (b.lat - a.lat),
        };
    }

    /** track from a JSON list [{latitude, longitude}] (husqvarna positions.positions) or [[lat, lon]] */
    function parseTrack(v) {
        let list = v;
        if (typeof v === 'string') {
            try {
                list = JSON.parse(v);
            } catch {
                return [];
            }
        }
        if (!Array.isArray(list)) {
            return [];
        }
        return list
            .map(p => (Array.isArray(p) ? { lat: Number(p[0]), lon: Number(p[1]) } : p && typeof p === 'object' ? { lat: Number(p.latitude !== undefined ? p.latitude : p.lat), lon: Number(p.longitude !== undefined ? p.longitude : p.lon) } : null))
            .filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
            .slice(0, 1000);
    }

    const api = { MOWER_TEXTS, DREAME_TEXTS, template, parseTexts, statusText, working, hasError, parseCal, toXY, parseTrack };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.RobotLogic = api;
    }
})(this);
