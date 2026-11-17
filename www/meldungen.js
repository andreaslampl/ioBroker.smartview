'use strict';

/*
 * "Meldungen": the messages SmartView sent (push, Telegram, WhatsApp), kept a few days by the adapter.
 * Opened from the menu ⚙ or by tapping a push (URL ?log=<id>, that message is highlighted). Unseen ones are
 * counted per device (localStorage sv.logSeen) and shown on the menu button.
 */

/* global SV, $, api, esc, icon, toast, closeSheet */

const Meldungen = (() => {
  let entries = [];
  let keep = 7;
  let sheet = null;

  function seen() {
    try {
      return Number(localStorage.getItem('sv.logSeen')) || 0;
    } catch (e) {
      return 0;
    }
  }

  function markSeen() {
    try {
      localStorage.setItem('sv.logSeen', String(Date.now()));
    } catch (e) {
      // ignore
    }
    badge();
  }

  function unseen() {
    const since = seen();
    return entries.filter(e => e.ts > since).length;
  }

  function badge() {
    const btn = $('menuBtn');
    if (!btn) return;
    const n = unseen();
    if (n) btn.dataset.count = n > 99 ? '99+' : String(n);
    else delete btn.dataset.count;
  }

  async function load() {
    try {
      const r = await api('pushlog');
      entries = r.entries || [];
      keep = r.keep || 7;
    } catch (e) {
      return false;
    }
    badge();
    if (sheet && document.body.contains(sheet)) fill(sheet.querySelector('.loglist'));
    return true;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Heute';
    if (d.toDateString() === y.toDateString()) return 'Gestern';
    return d.toLocaleDateString('de-AT', { weekday: 'long', day: 'numeric', month: 'numeric' });
  }

  function pageName(id) {
    const p = SV.layout && SV.layout.pages.find(x => x.id === id);
    return p ? p.name : '';
  }

  function fill(box, highlight) {
    if (!box) return;
    if (!entries.length) {
      box.innerHTML = '<div class="muted">Keine Meldungen in den letzten ' + keep + ' Tagen.</div>';
      return;
    }
    const since = seen();
    let html = '';
    let day = '';
    for (const e of entries) {
      const label = dayLabel(e.ts);
      if (label !== day) {
        day = label;
        html += '<h4 class="logday">' + esc(label) + '</h4>';
      }
      const time = new Date(e.ts).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
      const ways = [e.ways && e.ways.app ? 'App' : '', e.ways && e.ways.telegram ? 'Telegram' : '', e.ways && e.ways.whatsapp ? 'WhatsApp' : ''].filter(Boolean).join(', ');
      const page = e.page && pageName(e.page);
      html += '<div class="logitem' + (e.id === highlight ? ' hl' : '') + (e.ts > since ? ' new' : '') + '" data-id="' + esc(e.id) + '">' +
        '<div class="logtime">' + esc(time) + '</div><div class="logtext"><b>' + esc(e.title) + '</b>' +
        (e.body ? '<div>' + esc(e.body) + '</div>' : '') +
        '<div class="muted small">' + esc(ways) + '</div></div>' +
        (page ? '<button type="button" class="logpage" data-page="' + esc(e.page) + '" title="Seite öffnen, zu der diese Meldung gehört"><small>zur Seite</small>' + esc(page) + ' ›</button>' : '') + '</div>';
    }
    box.innerHTML = html;
    for (const b of box.querySelectorAll('[data-page]')) {
      b.onclick = () => {
        close();
        location.hash = encodeURIComponent(b.dataset.page);
      };
    }
    const hl = highlight && box.querySelector('.logitem.hl');
    if (hl) hl.scrollIntoView({ block: 'center' });
  }

  function close() {
    if (sheet) sheet.remove();
    sheet = null;
  }

  async function show(highlight) {
    if (typeof closeSheet === 'function') closeSheet();
    close();
    const ov = document.createElement('div');
    ov.className = 'overlay bottom';
    ov.innerHTML = '<div class="sheet wide meldungen"><h3>' + icon('bell') + '<span class="grow">Meldungen</span><button type="button" class="iconbtn" data-close>' + icon('close') + '</button></h3>' +
      '<div class="loglist"><div class="muted">Lade …</div></div><div class="help">Gesendete Mitteilungen der letzten <span data-keep>' + keep + '</span> Tage (Einstellung beim Bearbeiten unter ⚙ → Mitteilungen).</div></div>';
    ov.addEventListener('click', e => {
      if (e.target === ov) close();
    });
    ov.querySelector('[data-close]').onclick = close;
    document.body.appendChild(ov);
    sheet = ov;
    const ok = await load();
    if (sheet !== ov) return;
    ov.querySelector('[data-keep]').textContent = keep;
    if (!ok) {
      ov.querySelector('.loglist').innerHTML = '<div class="muted">Meldungen konnten nicht geladen werden.</div>';
      return;
    }
    fill(ov.querySelector('.loglist'), highlight);
    markSeen();
  }

  /** menu ⚙: "Meldungen (n neu)" */
  function menuItem(box) {
    if (!box) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    const n = unseen();
    b.innerHTML = icon('bell') + 'Meldungen' + (n ? ' <b class="lognew">' + n + ' neu</b>' : '');
    b.onclick = () => {
      box.closest('.overlay').remove();
      show();
    };
    box.appendChild(b);
  }

  /** after the app started: count, and open the list when a push was tapped (?log=<id>) */
  function start() {
    const params = new URLSearchParams(location.search);
    const id = params.get('log');
    if (id) {
      params.delete('log');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      show(id);
    } else {
      load();
    }
  }

  return { start, load, show, menuItem };
})();
