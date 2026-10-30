'use strict';

/*
 * "Haus verlassen" / "Ankommen": what the button does, computed from the other tiles of the layout. Used by the page
 * (window.SceneLogic, preview in the sheet) and by the adapter (require, runs the commands - also delayed and when
 * triggered from ioBroker). st(id) returns the state info {val, type, states, missing} or null.
 */
(function (root) {
  const Win = typeof module === 'object' && module.exports ? require('./winlogic') : root.WinLogic;

  // keep in sync with app.js LAYER_ICON (symbols on the layer "licht"); a switch without symbol shows the bulb
  const LIGHT_ICONS = ['bulb', 'lamp', 'walllamp', 'ceiling', 'lantern'];

  function truthy(v) {
    if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
    return Boolean(v);
  }

  const known = v => v !== null && v !== undefined;
  const same = (a, b) => known(a) && b !== undefined && b !== '' && String(a) === String(b);

  /** a value from the settings ("5", "true", "Normal") as the data point wants it */
  function typed(v, s) {
    const t = String(v).trim();
    if (s && s.type === 'string') return t;
    if (t === 'true' || t === 'false') return t === 'true';
    return t !== '' && Number.isFinite(Number(t)) ? Number(t) : t;
  }

  function isLight(t) {
    if (t.type !== 'switch' && t.type !== 'dimmer') return false;
    if (t.layer) return t.layer === 'licht';
    return t.type === 'dimmer' || LIGHT_ICONS.includes(t.icon || 'bulb');
  }

  function valOf(st, id) {
    const s = id ? st(id) : null;
    return s && !s.missing ? s.val : undefined;
  }

  function isOn(st, t) {
    if (t.type === 'dimmer') {
      if (t.switchState && known(valOf(st, t.switchState)) && !truthy(valOf(st, t.switchState))) return false;
      const lvl = Number(valOf(st, t.status || t.state));
      return (Number.isFinite(lvl) && lvl > 0) || (Boolean(t.switchState) && truthy(valOf(st, t.switchState)) && !t.state);
    }
    const v = valOf(st, t.status || t.state);
    if (!known(v)) return null;
    return Boolean(t.invert) !== truthy(v);
  }

  /** command value of a blind for `open` % (boolean up/down object or position, closed100 / posInvert) */
  function blindValue(st, t, open) {
    const s = st(t.state);
    if (s && s.type === 'boolean') return t.closed100 ? open > 0 : open === 0;
    return Boolean(t.closed100) !== Boolean(t.posInvert) ? 100 - open : open;
  }

  const areasOf = t => [t, ...(Array.isArray(t.areas) ? t.areas : [])];
  const circuitsOf = t => [t, ...(Array.isArray(t.circuits) ? t.circuits : [])];
  const roomsOf = t => [t, ...(Array.isArray(t.rooms) ? t.rooms : [])];

  function areaMode(st, a) {
    const v = valOf(st, a.status);
    return same(v, a.valueArm) ? 'armed' : same(v, a.valueHome) ? 'home' : same(v, a.valueOff) ? 'off' : 'other';
  }

  /**
   * @param {object} t the leave / arrive tile
   * @param {object[]} tiles all tiles of the layout
   * @param {Function} st state info by id
   * @param {object} o locked(tile) -> reason or '', dark (true / false / undefined = unknown)
   * @returns {{groups: [string, number][], now: Map, later: Map, warn: string[], alarm: object[]}}
   */
  function plan(t, tiles, st, o = {}) {
    const now = new Map();
    const later = new Map();
    const groups = [];
    const warn = [];
    const alarm = [];
    const delayed = t.type === 'leave' && Number(t.delayMin) > 0;
    const step = (label, into, fn) => {
      const before = into.size;
      const add = (id, v) => id && !now.has(id) && !later.has(id) && into.set(id, v);
      fn(add);
      if (into.size > before) groups.push([label + (into === later ? ' (nach ' + t.delayMin + ' min)' : ''), into.size - before]);
    };
    const leave = t.type === 'leave';
    const extra = group => (Array.isArray(t.extra) ? t.extra : []).filter(e => e.state && (e.group || 'other') === group);
    // own data points: the value from the settings, else off / on (lights) or down / up (KNX blinds: 1 = down)
    const extraValue = (e, def) => (e.value === '' || e.value === undefined ? def : typed(e.value, st(e.state)));
    const chosen = (list, x) => !Array.isArray(list) || !list.length || list.includes(x.id);

    if (leave && t.lightsOff) {
      step('Lichter aus', now, add => {
        for (const x of tiles) {
          // "nur diese Lichter": every ticked switch / dimmer; else all lights
          const sel = Array.isArray(t.lightTiles) && t.lightTiles.length;
          if (sel ? !t.lightTiles.includes(x.id) || (x.type !== 'switch' && x.type !== 'dimmer') : !isLight(x)) continue;
          if (isOn(st, x) === false) continue;
          if (x.type === 'switch') add(x.state, Boolean(x.invert));
          else if (x.switchState) add(x.switchState, false);
          else add(x.state, 0);
        }
        for (const e of extra('light')) add(e.state, extraValue(e, false));
      });
    }
    if (!leave && ((Array.isArray(t.lights) && t.lights.length) || extra('light').length)) {
      if (t.onlyDark && o.dark === false) {
        warn.push('Lichter bleiben aus – es ist hell');
      } else {
        step('Licht an' + (t.onlyDark && o.dark === undefined ? ' (wenn dunkel)' : ''), now, add => {
          for (const x of tiles) {
            if (!(t.lights || []).includes(x.id) || (x.type !== 'switch' && x.type !== 'dimmer') || isOn(st, x)) continue;
            if (x.type === 'switch') add(x.state, !x.invert);
            else if (x.switchState) add(x.switchState, true);
            else add(x.state, 100);
          }
          for (const e of extra('light')) add(e.state, extraValue(e, true));
        });
      }
    }
    if ((leave && t.blindsDown) || (!leave && t.blindsUp)) {
      step(leave ? 'Rollläden zu / Markisen ein' : 'Rollläden auf', delayed ? later : now, add => {
        for (const x of tiles) {
          if (x.type !== 'blind' || !x.state || !chosen(t.blindTiles, x)) continue;
          if (!leave && x.kind === 'awning') continue; // awnings stay in when coming home
          const reason = o.locked ? o.locked(x) : '';
          if (reason) {
            warn.push((x.label || 'Rollladen') + ' gesperrt (' + reason + ')');
            continue;
          }
          add(x.state, blindValue(st, x, leave && x.kind !== 'awning' ? 0 : 100));
        }
        for (const e of extra('blind')) add(e.state, extraValue(e, leave));
      });
    }
    if (t.heatMode) {
      step('Heizung auf „' + t.heatMode + '“', now, add => {
        for (const x of tiles.filter(y => y.type === 'thermostat')) {
          for (const c of circuitsOf(x)) {
            if (c.mode && !same(valOf(st, c.mode), t.heatMode)) add(c.mode, typed(t.heatMode, st(c.mode)));
          }
        }
      });
    }
    const alarmId = leave ? t.alarmArm : t.alarmOff;
    if (alarmId) {
      const a = tiles.find(x => x.type === 'alarm' && x.id === alarmId);
      if (!a || !a.control) {
        warn.push('Alarmanlage: Kachel fehlt oder „Schalten erlauben“ ist nicht gesetzt');
      } else {
        step(leave ? 'Alarmanlage scharf' : 'Alarmanlage unscharf', delayed ? later : now, add => {
          for (const area of areasOf(a)) {
            const value = leave ? area.valueArm : area.valueOff;
            if (!area.command || !known(value) || value === '') continue;
            const mode = areaMode(st, area);
            if (leave ? mode === 'armed' : mode === 'off') continue;
            if (leave && area.ready && known(valOf(st, area.ready)) && !truthy(valOf(st, area.ready))) {
              const open = area.openText ? String(valOf(st, area.openText) || '') : '';
              warn.push((area.label || a.label || 'Alarm') + ': nicht scharfschaltbereit' + (open ? ' – offen: ' + open : ''));
            }
            add(area.command, typed(value, st(area.command)));
            alarm.push({ label: area === a ? a.label || 'Alarmanlage' : area.label || 'Bereich', status: area.status, value: leave ? area.valueArm : area.valueOff });
          }
        });
      }
    }
    if (leave && t.radioOff) {
      step('Radio aus', now, add => {
        for (const x of tiles.filter(y => y.type === 'radio')) for (const r of roomsOf(x)) if (r.playing && truthy(valOf(st, r.playing))) add(r.playing, false);
      });
    }
    if (leave && t.climateOff) {
      step('Entfeuchter / Klima aus', now, add => {
        for (const x of tiles) if (x.type === 'climate' && x.state && isOn(st, x)) add(x.state, Boolean(x.invert));
      });
    }
    step('Weitere Datenpunkte', now, add => {
      for (const e of extra('other')) if (e.value !== '') add(e.state, typed(e.value, st(e.state)));
    });
    if (leave) {
      // open windows: window overviews and contact tiles
      const open = new Set();
      for (const x of tiles) {
        const list = x.type === 'windows' ? Win.states(x, st) : x.type === 'contact' ? Win.states({ windows: [{ ...x, label: x.label }] }, st) : [];
        for (const w of list) if (w.status === 'open' || w.status === 'tilt') open.add((w.label || 'Fenster') + ' ' + Win.TEXT[w.status]);
      }
      if (open.size) warn.unshift('Offen: ' + [...open].join(', '));
    }
    return { groups, now, later, warn, alarm };
  }

  /** all ids the button would write (for the PIN and permission check) */
  const ids = p => [...p.now.keys(), ...p.later.keys()];

  const api = { plan, ids, isLight, typed, truthy };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SceneLogic = api;
})(this);
