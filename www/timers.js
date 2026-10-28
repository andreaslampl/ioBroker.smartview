'use strict';

/* Time switch editor for switch, dimmer and blind tiles (long press on the tile, or ⏰ in its sheet). */

const Timers = (() => {
  let data = { timers: {}, sun: null, location: false };
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const ACTIONS = {
    switch: [['on', 'Ein'], ['off', 'Aus']],
    dimmer: [['on', 'Ein (100 %)'], ['off', 'Aus'], ['level', 'Helligkeit …']],
    blind: [['up', 'Auf'], ['down', 'Ab'], ['position', 'Position (% offen) …']],
  };

  async function load() {
    try {
      data = await api('timers');
    } catch (e) {
      // older adapter or no connection: no timers
    }
    for (const el of document.querySelectorAll('[data-tile]')) {
      const t = findTile(el.dataset.page, el.dataset.tile);
      if (t) mark(el, t);
    }
  }

  /** "page/tile" of a tile of the saved layout. */
  function keyOf(t) {
    const page = SV.layout.pages.find(p => p.tiles.some(x => x.id === t.id && x.state === t.state && x.type === t.type));
    return page ? page.id + '/' + t.id : null;
  }

  function supports(t) {
    // a PIN protected tile gets no time switch (it would switch without the PIN)
    return Boolean(ACTIONS[t.type] && (t.state || t.switchState)) && !t.pin && !(SV.me && SV.me.control === false);
  }

  function timerOf(t) {
    const k = keyOf(t);
    return k ? data.timers[k] : null;
  }

  function active(t) {
    const tm = timerOf(t);
    return Boolean(tm && tm.enabled && tm.entries.some(e => e.enabled));
  }

  /** ⏰ on tiles, rows and markers with an active time switch. */
  function mark(el, t) {
    let b = el.querySelector(':scope > .tbadge');
    if (!supports(t) || !active(t)) {
      if (b) b.remove();
      return;
    }
    if (!b) {
      b = document.createElement('span');
      b.className = 'tbadge';
      b.textContent = '⏰';
      b.title = 'Zeitschaltuhr aktiv';
      el.appendChild(b);
    }
  }

  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function nextText(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    const day = d.toDateString() === today.toDateString() ? 'heute' : d.toDateString() === tomorrow.toDateString() ? 'morgen' : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return 'nächste: ' + day + ' ' + hhmm(ms);
  }

  function open(t) {
    const key = keyOf(t);
    if (!key) return toast('Zuerst die Ansicht speichern', true);
    if (!supports(t)) return toast('Zeitschaltuhr gibt es für Schalter, Dimmer und Rollläden', true);
    closeSheet();
    const cur = timerOf(t) || { enabled: true, entries: [] };
    const tm = JSON.parse(JSON.stringify(cur));
    const ov = document.createElement('div');
    ov.className = 'overlay';
    const sh = document.createElement('div');
    sh.className = 'sheet wide form timers';
    ov.appendChild(sh);
    document.body.appendChild(ov);
    const close = () => ov.remove();

    function draw() {
      sh.innerHTML = '<h3>⏰<span class="grow">Zeitschaltuhr – ' + esc(t.label || '') + '</span><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></h3>';
      sh.querySelector('[data-x]').onclick = close;
      const info = document.createElement('div');
      info.className = 'help';
      info.textContent = data.sun
        ? 'Heute: Sonnenaufgang ' + hhmm(data.sun.rise) + ', Sonnenuntergang ' + hhmm(data.sun.set) + '. Geschaltet wird vom ioBroker – auch wenn kein Gerät offen ist.'
        : data.location === false
          ? 'Für Sonnenauf-/-untergang fehlt der Standort: ioBroker → Einstellungen (System) → Breiten- und Längengrad eintragen.'
          : 'Geschaltet wird vom ioBroker – auch wenn kein Gerät offen ist.';
      sh.appendChild(info);
      const all = document.createElement('label');
      all.className = 'check';
      all.innerHTML = '<input type="checkbox"' + (tm.enabled ? ' checked' : '') + '> Zeitschaltuhr aktiv';
      all.querySelector('input').onchange = e => (tm.enabled = e.target.checked);
      sh.appendChild(all);

      tm.entries.forEach((e, i) => {
        const box = document.createElement('div');
        box.className = 'rule tentry' + (e.enabled ? '' : ' off');
        // days
        const days = document.createElement('div');
        days.className = 'days';
        DAYS.forEach((d, j) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = d;
          b.className = e.days.includes(j + 1) ? 'sel' : '';
          b.onclick = () => {
            e.days = e.days.includes(j + 1) ? e.days.filter(x => x !== j + 1) : e.days.concat(j + 1).sort();
            draw();
          };
          days.appendChild(b);
        });
        const quick = document.createElement('select');
        quick.innerHTML = '<option value="">…</option><option value="all">täglich</option><option value="work">Mo–Fr</option><option value="weekend">Sa–So</option>';
        quick.onchange = () => {
          e.days = quick.value === 'work' ? [1, 2, 3, 4, 5] : quick.value === 'weekend' ? [6, 7] : [1, 2, 3, 4, 5, 6, 7];
          draw();
        };
        days.appendChild(quick);
        box.appendChild(days);
        // when
        const row = document.createElement('div');
        row.className = 'trow';
        const at = document.createElement('select');
        at.innerHTML = '<option value="time">Uhrzeit</option><option value="sunrise">Sonnenaufgang</option><option value="sunset">Sonnenuntergang</option>';
        at.value = e.at;
        at.onchange = () => {
          e.at = at.value;
          draw();
        };
        row.appendChild(at);
        if (e.at === 'time') {
          const time = document.createElement('input');
          time.type = 'time';
          time.value = e.time;
          time.onchange = () => (e.time = time.value || e.time);
          row.appendChild(time);
        } else {
          const off = document.createElement('input');
          off.type = 'number';
          off.step = '5';
          off.value = e.offset || 0;
          off.title = 'Minuten vorher (−) oder nachher (+)';
          off.onchange = () => (e.offset = Number(off.value) || 0);
          row.appendChild(off);
          const u = document.createElement('span');
          u.className = 'muted';
          u.textContent = 'min (−30 = 30 min vorher)';
          row.appendChild(u);
        }
        box.appendChild(row);
        // what
        const row2 = document.createElement('div');
        row2.className = 'trow';
        const act = document.createElement('select');
        for (const [v, txt] of ACTIONS[t.type]) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = txt;
          act.appendChild(o);
        }
        act.value = e.action;
        act.onchange = () => {
          e.action = act.value;
          if ((e.action === 'level' || e.action === 'position') && e.value === undefined) e.value = 50;
          draw();
        };
        row2.appendChild(act);
        if (e.action === 'level' || e.action === 'position') {
          const v = document.createElement('input');
          v.type = 'number';
          v.min = '0';
          v.max = '100';
          v.step = '5';
          v.value = e.value === undefined ? 50 : e.value;
          v.onchange = () => (e.value = Number(v.value));
          row2.appendChild(v);
          const u = document.createElement('span');
          u.className = 'muted';
          u.textContent = '%';
          row2.appendChild(u);
        }
        box.appendChild(row2);
        // footer
        const foot = document.createElement('div');
        foot.className = 'trow';
        const en = document.createElement('label');
        en.className = 'check';
        en.innerHTML = '<input type="checkbox"' + (e.enabled ? ' checked' : '') + '> aktiv';
        en.querySelector('input').onchange = ev => {
          e.enabled = ev.target.checked;
          box.classList.toggle('off', !e.enabled);
        };
        foot.appendChild(en);
        const nx = document.createElement('span');
        nx.className = 'muted grow';
        nx.textContent = nextText(e.next);
        foot.appendChild(nx);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Entfernen';
        del.onclick = () => {
          tm.entries.splice(i, 1);
          draw();
        };
        foot.appendChild(del);
        box.appendChild(foot);
        sh.appendChild(box);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Schaltzeit';
      add.onclick = () => {
        const last = tm.entries[tm.entries.length - 1];
        const first = ACTIONS[t.type][0][0];
        tm.entries.push({ id: 'e' + Date.now().toString(36), enabled: true, days: [1, 2, 3, 4, 5, 6, 7], at: 'time', time: '07:00', offset: 0, action: last && last.action === first ? ACTIONS[t.type][1][0] : first });
        draw();
      };
      sh.appendChild(add);

      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      buttons.innerHTML = '<span class="grow"></span>';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Abbrechen';
      cancel.onclick = close;
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'primary';
      save.textContent = 'Speichern';
      save.onclick = async () => {
        try {
          if (tm.entries.some(e => !e.days.length)) return toast('Bei jeder Schaltzeit mindestens einen Tag wählen', true);
          await api('timers/' + key, { method: 'PUT', body: JSON.stringify(tm) });
          await load();
          toast('Zeitschaltuhr gespeichert');
          close();
        } catch (err) {
          toast('Speichern fehlgeschlagen: ' + err.message, true);
        }
      };
      buttons.append(cancel, save);
      sh.appendChild(buttons);
    }
    draw();
  }

  /** Long press (0.6 s) on an element opens the sheet of the tile; the following click is swallowed. */
  function longPress(el, fn) {
    let timer = null;
    let start = null;
    let fired = false;
    el.addEventListener('pointerdown', e => {
      fired = false;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => {
        fired = true;
        fn();
      }, 600);
    });
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointermove', e => {
      if (start && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 10) cancel();
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener(
      'click',
      e => {
        if (fired) {
          fired = false;
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  return { load, open, mark, supports, longPress, active };
})();
