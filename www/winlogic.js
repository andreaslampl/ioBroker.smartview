'use strict';

/*
 * Window overview logic, used by the page (window.WinLogic) and by the adapter for the window messages
 * (require). st(id) returns the state info {val, lc, ts, missing} or null.
 */
(function (root) {
  const TEXT = { open: 'offen', tilt: 'gekippt', closed: 'geschlossen', unknown: 'unbekannt' };
  const RANK = { open: 3, tilt: 2, unknown: 1, closed: 0 };

  function truthy(v) {
    if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
    return Boolean(v);
  }

  /** Status of each window: closed / tilt / open, time since the last change. */
  function states(t, st) {
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
      return { label: w.label || (w.state || w.tilt || '').split('.').pop(), group: w.group || '', status, ts };
    });
  }

  const active = w => w.status === 'open' || w.status === 'tilt';

  /** the tile's own words (e.g. an / aus for lights), else offen / gekippt / geschlossen */
  function words(t) {
    t = t || {};
    return { open: t.wordOpen || TEXT.open, tilt: t.wordTilt || TEXT.tilt, closed: t.wordClosed || TEXT.closed, unknown: TEXT.unknown, all: t.wordAll || 'alle ' + (t.wordClosed || TEXT.closed) };
  }

  /**
   * Entries: single windows, or one entry per area (`group`) with the worst status, its open/tilted members as
   * detail ("links offen · Tür gekippt") and since when the first of them is open.
   */
  function entries(list, w) {
    const text = w || TEXT;
    const out = [];
    const groups = new Map();
    for (const w of list) {
      if (!w.group) {
        out.push({ ...w, members: [w] });
        continue;
      }
      let g = groups.get(w.group);
      if (!g) {
        g = { label: w.group, group: true, members: [] };
        groups.set(w.group, g);
        out.push(g);
      }
      g.members.push(w);
    }
    for (const g of groups.values()) {
      const m = g.members;
      const worst = m.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
      g.status = m.every(x => x.status === 'unknown') ? 'unknown' : worst.status === 'unknown' ? 'closed' : worst.status;
      const notClosed = m.filter(active);
      g.ts = notClosed.length ? Math.min(...notClosed.map(x => x.ts || Date.now())) : Math.max(0, ...m.map(x => x.ts || 0));
      g.detail = notClosed.map(x => x.label + ' ' + text[x.status]).join(' · ');
    }
    return out;
  }

  /** "Warnen, wenn" is true and something is open or tilted */
  function warn(t, st, list) {
    const s = t.warnWhen ? st(t.warnWhen) : null;
    return Boolean(s && truthy(s.val)) && list.some(active);
  }

  const api = { TEXT, RANK, truthy, states, entries, active, warn, words };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WinLogic = api;
})(this);
