'use strict';

/*
 * Waste collection calendar (iCal/ICS, e.g. the "Müll App" by Symvaro: app.muellapp.com/ical/...): parsing, waste kinds
 * with colours, grouping by day. UMD like winlogic.js: the adapter fetches and parses, the page shows.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.WasteLogic = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    // first match wins; colours as usual in Austria (paper red, packaging yellow, bio brown, residual grey/black)
    const KINDS = [
        { key: 'sperr', re: /sperr/i, label: 'Sperrmüll', color: '#8e24aa' },
        { key: 'problem', re: /problem|schadstoff|sonderm/i, label: 'Problemstoffe', color: '#fb8c00' },
        { key: 'bio', re: /bio|kompost|grün(schnitt|abfall)|strauch/i, label: 'Bio', color: '#8d6e63' },
        { key: 'papier', re: /papier|karton|kartonag/i, label: 'Altpapier', color: '#e53935' },
        { key: 'gelb', re: /gelb|leichtverpack|verpackung|plastik|kunststoff|lvp/i, label: 'Gelber Sack', color: '#f5c518' },
        { key: 'glas', re: /glas/i, label: 'Glas', color: '#43a047' },
        { key: 'metall', re: /metall|dose/i, label: 'Metall', color: '#1e88e5' },
        { key: 'rest', re: /rest/i, label: 'Restmüll', color: '#6b7280' },
    ];
    const OTHER = { key: 'other', label: '', color: '#9aa3ad' };
    const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

    function kindOf(title) {
        return KINDS.find(k => k.re.test(String(title || ''))) || OTHER;
    }

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    /** 'YYYY-MM-DD' of a Date in local time */
    function dayKey(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function addDays(key, n) {
        const [y, m, d] = key.split('-').map(Number);
        return dayKey(new Date(y, m - 1, d + n));
    }

    function unescape(v) {
        return String(v).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
    }

    /** DTSTART value -> 'YYYY-MM-DD' (date values as they are, UTC times converted to local time) */
    function parseDate(v) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(String(v).trim());
        if (!m) {
            return '';
        }
        if (m[7]) {
            return dayKey(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
        }
        return m[1] + '-' + m[2] + '-' + m[3];
    }

    /** simple RRULE (DAILY / WEEKLY / MONTHLY, INTERVAL, COUNT, UNTIL) - collection calendars are mostly single events */
    function expand(start, rule, untilKey) {
        const p = {};
        for (const part of String(rule).split(';')) {
            const [k, v] = part.split('=');
            p[k.toUpperCase()] = v;
        }
        const step = Math.max(1, Number(p.INTERVAL) || 1);
        const count = Number(p.COUNT) || 0;
        const until = p.UNTIL ? parseDate(p.UNTIL) : '';
        const out = [];
        let cur = start;
        for (let i = 0; i < 1000; i++) {
            if ((count && out.length >= count) || (until && cur > until) || cur > untilKey) {
                break;
            }
            out.push(cur);
            if (p.FREQ === 'DAILY') {
                cur = addDays(cur, step);
            } else if (p.FREQ === 'WEEKLY') {
                cur = addDays(cur, 7 * step);
            } else if (p.FREQ === 'MONTHLY') {
                const [y, m, d] = cur.split('-').map(Number);
                cur = dayKey(new Date(y, m - 1 + step, d));
            } else {
                break;
            }
        }
        return out;
    }

    /**
     * ICS text -> [{date: 'YYYY-MM-DD', title}] sorted by date. `horizon` = last day for repeating events.
     */
    function parse(text, horizon) {
        const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
        const out = [];
        const end = horizon || addDays(dayKey(new Date()), 400);
        let ev = null;
        for (const line of lines) {
            if (line === 'BEGIN:VEVENT') {
                ev = { ex: [] };
                continue;
            }
            if (line === 'END:VEVENT') {
                if (ev && ev.date && ev.title) {
                    const dates = ev.rrule ? expand(ev.date, ev.rrule, end) : [ev.date];
                    for (const date of dates) {
                        if (!ev.ex.includes(date)) {
                            out.push({ date, title: ev.title });
                        }
                    }
                }
                ev = null;
                continue;
            }
            if (!ev) {
                continue;
            }
            const i = line.indexOf(':');
            if (i < 0) {
                continue;
            }
            const name = line.slice(0, i).split(';')[0].toUpperCase();
            const value = line.slice(i + 1);
            if (name === 'DTSTART') {
                ev.date = parseDate(value);
            } else if (name === 'SUMMARY') {
                ev.title = unescape(value);
            } else if (name === 'RRULE') {
                ev.rrule = value;
            } else if (name === 'EXDATE') {
                ev.ex.push(...value.split(',').map(parseDate));
            }
        }
        const seen = new Set();
        return out.filter(e => {
            const k = e.date + '|' + e.title;
            if (seen.has(k)) {
                return false;
            }
            seen.add(k);
            return true;
        }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
    }

    /** words of the "hide" option (e.g. "Sperrmüll; Problemstoffe") */
    function hidden(title, hide) {
        const words = String(hide || '').split(/[;,]/).map(w => w.trim().toLowerCase()).filter(Boolean);
        const t = String(title).toLowerCase();
        return words.some(w => t.includes(w));
    }

    /** entries from today on, grouped by day: [{date, items: [{title, source, kind}]}] */
    function days(entries, today, maxDays, hide) {
        const last = addDays(today, Math.max(0, (maxDays || 14) - 1));
        const map = new Map();
        for (const e of entries || []) {
            if (e.date < today || e.date > last || hidden(e.title, hide)) {
                continue;
            }
            if (!map.has(e.date)) {
                map.set(e.date, []);
            }
            map.get(e.date).push({ title: e.title, source: e.source || '', kind: kindOf(e.title) });
        }
        return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, items]) => ({ date, items }));
    }

    /** "Heute" / "Morgen" / "Do 14.11." */
    function dayText(date, today) {
        if (date === today) {
            return 'Heute';
        }
        if (date === addDays(today, 1)) {
            return 'Morgen';
        }
        const [y, m, d] = date.split('-').map(Number);
        return WEEKDAYS[new Date(y, m - 1, d).getDay()] + ' ' + pad(d) + '.' + pad(m) + '.';
    }

    return { KINDS, kindOf, parse, days, dayText, dayKey, addDays, hidden };
});
