'use strict';

/* Users: login form, "Abmelden", user management for admins (the server checks every right). */

const Users = (() => {
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /** Full page login form instead of the app. */
  function showLogin(title) {
    document.title = title || 'SmartView';
    $('title').textContent = title || 'SmartView';
    $('pageTitle').textContent = '';
    for (const id of ['nav', 'side', 'editBtn', 'backBtn', 'editBar', 'conn', 'clock']) $(id).hidden = true;
    $('menuBtn').hidden = true;
    const main = $('main');
    main.innerHTML = '';
    const box = el('form', 'sheet form login');
    box.innerHTML = '<h3>' + icon('lock') + '<span class="grow">Anmelden</span></h3>' +
      '<label for="lgName">Name</label><input id="lgName" type="text" autocomplete="username" autocapitalize="none" required>' +
      '<label for="lgPw">Passwort / PIN</label><input id="lgPw" type="password" autocomplete="current-password" required>' +
      '<p class="hint">Dieses Gerät bleibt angemeldet, bis du dich abmeldest.</p>' +
      '<div class="row"><button type="submit" class="primary">Anmelden</button></div>';
    main.appendChild(box);
    try {
      const last = localStorage.getItem('sv.user');
      if (last) $('lgName').value = last;
    } catch (e) {
      // ignore
    }
    ($('lgName').value ? $('lgPw') : $('lgName')).focus();
    box.onsubmit = async e => {
      e.preventDefault();
      const name = $('lgName').value.trim();
      try {
        await api('login', { method: 'POST', body: JSON.stringify({ name, password: $('lgPw').value }) });
        try {
          localStorage.setItem('sv.user', name);
        } catch (err) {
          // ignore
        }
        location.reload();
      } catch (err) {
        $('lgPw').value = '';
        toast(err.message, true);
      }
    };
  }

  async function logout() {
    await api('logout', { method: 'POST', body: '{}' }).catch(() => {});
    location.reload();
  }

  /** Entries for the menu: who is logged in, log out, manage users. */
  function menuItems(box) {
    const me = SV.me || {};
    let html = '';
    if (me.usersEnabled) {
      html += '<p class="hint">Angemeldet als <b>' + esc(me.name) + '</b>' + (me.admin ? ' (Administrator)' : '') + '</p>';
    }
    if (me.manageUsers) html += '<button type="button" class="item" data-users>' + icon('shield') + 'Benutzer verwalten</button>';
    if (me.usersEnabled) html += '<button type="button" class="item" data-logout>' + icon('close') + 'Abmelden</button>';
    box.innerHTML = html;
    const u = box.querySelector('[data-users]');
    if (u) u.onclick = () => {
      box.closest('.overlay').remove();
      manage();
    };
    const l = box.querySelector('[data-logout]');
    if (l) l.onclick = logout;
  }

  // ---------------- user management ----------------

  async function manage() {
    let data;
    try {
      data = await api('users');
    } catch (e) {
      return toast(e.message, true);
    }
    const users = data.users.map(u => ({ ...u, password: '' }));
    const ov = el('div', 'overlay');
    const sh = el('div', 'sheet wide form users');
    ov.appendChild(sh);
    document.body.appendChild(ov);
    const close = () => ov.remove();

    const draw = () => {
      sh.innerHTML = '<h3><span class="grow">Benutzer</span><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></h3>' +
        (data.emergency ? '<p class="hint bad">Benutzer sind in den Instanz-Einstellungen ausgeschaltet (Notfall) – jeder kommt ohne Anmeldung hinein.</p>' : '') +
        (users.length ? '' : '<p class="hint">Noch keine Benutzer: SmartView ist für jeden offen, der die Adresse kennt. Sobald du den ersten Benutzer (Administrator) anlegst, muss sich jedes Gerät einmal anmelden.</p>');
      users.forEach((u, i) => sh.appendChild(userBox(u, i)));
      const bar = el('div', 'buttons');
      bar.innerHTML = '<button type="button" data-add>+ Benutzer</button><span class="grow"></span><button type="button" data-cancel>Abbrechen</button><button type="button" class="primary" data-save>Speichern</button>';
      sh.appendChild(bar);
      sh.querySelector('[data-x]').onclick = close;
      bar.querySelector('[data-cancel]').onclick = close;
      bar.querySelector('[data-add]').onclick = () => {
        users.push({ id: '', name: '', password: '', admin: users.length === 0, pages: 'all', control: true, intercom: true, open: true });
        draw();
        const inputs = sh.querySelectorAll('.ubox:last-of-type input[type=text]');
        if (inputs.length) inputs[0].focus();
      };
      bar.querySelector('[data-save]').onclick = save;
    };

    const userBox = (u, i) => {
      const b = el('div', 'ubox' + (u.open ? ' open' : ''));
      const summary = u.admin ? 'Administrator' : (u.pages === 'all' ? 'alle Seiten' : u.pages.length + ' Seite(n)') + (u.control ? ', schalten' : ', nur ansehen') + (u.intercom ? ', Klingel' : '');
      const head = el('div', 'uhead', icon(u.admin ? 'shield' : 'home') + '<span class="grow"><b>' + esc(u.name || 'Neuer Benutzer') + '</b><small>' + esc(summary) + (u.sessions ? ' · ' + u.sessions + ' Gerät(e) angemeldet' : '') + '</small></span><span class="chev">' + (u.open ? '▲' : '▼') + '</span>');
      head.onclick = () => {
        u.open = !u.open;
        draw();
      };
      b.appendChild(head);
      if (!u.open) return b;
      const body = el('div', 'ubody');
      body.innerHTML =
        '<label>Name</label><input type="text" data-k="name" maxlength="40" autocomplete="off">' +
        '<label>' + (u.id ? 'Neues Passwort / PIN' : 'Passwort / PIN') + '</label><input type="password" data-k="password" autocomplete="new-password" placeholder="' + (u.id ? 'leer = unverändert' : 'mindestens 4 Zeichen') + '">' +
        '<label class="check"><input type="checkbox" data-k="admin"> Administrator (alles sehen, bearbeiten, Benutzer verwalten)</label>' +
        '<div data-rights' + (u.admin ? ' hidden' : '') + '>' +
        '<label class="check"><input type="checkbox" data-k="control"> Darf schalten (sonst nur ansehen)</label>' +
        '<label class="check"><input type="checkbox" data-k="intercom"> Klingel, Sprechanlage und Anrufliste</label>' +
        '<label>Sichtbare Seiten</label><label class="check"><input type="checkbox" data-all> Alle Seiten (auch neue)</label>' +
        '<div class="pagelist"' + (u.pages === 'all' ? ' hidden' : '') + '>' +
        data.pages.map(p => '<label class="check"><input type="checkbox" data-page="' + esc(p.id) + '"> ' + esc(p.name) + '</label>').join('') + '</div></div>' +
        '<div class="row"><button type="button" class="danger" data-del>Benutzer löschen</button></div>';
      b.appendChild(body);
      const q = s => body.querySelector(s);
      q('[data-k=name]').value = u.name;
      q('[data-k=name]').oninput = e => (u.name = e.target.value);
      q('[data-k=password]').value = u.password;
      q('[data-k=password]').oninput = e => (u.password = e.target.value);
      for (const k of ['admin', 'control', 'intercom']) {
        q('[data-k=' + k + ']').checked = Boolean(u[k]);
        q('[data-k=' + k + ']').onchange = e => {
          u[k] = e.target.checked;
          if (k === 'admin') q('[data-rights]').hidden = u.admin;
        };
      }
      q('[data-all]').checked = u.pages === 'all';
      q('[data-all]').onchange = e => {
        u.pages = e.target.checked ? 'all' : [];
        q('.pagelist').hidden = e.target.checked;
        for (const c of body.querySelectorAll('[data-page]')) c.checked = false;
      };
      for (const c of body.querySelectorAll('[data-page]')) {
        c.checked = Array.isArray(u.pages) && u.pages.includes(c.dataset.page);
        c.onchange = () => {
          u.pages = [...body.querySelectorAll('[data-page]')].filter(x => x.checked).map(x => x.dataset.page);
        };
      }
      q('[data-del]').onclick = () => {
        if (!confirm('Benutzer „' + (u.name || 'neu') + '“ löschen?')) return;
        users.splice(i, 1);
        draw();
      };
      return b;
    };

    const save = async () => {
      try {
        await api('users', { method: 'PUT', body: JSON.stringify(users.map(u => ({ id: u.id, name: u.name, password: u.password, admin: u.admin, pages: u.pages, control: u.control, intercom: u.intercom }))) });
        toast('Benutzer gespeichert');
        close();
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        toast(e.message, true);
      }
    };

    ov.addEventListener('click', e => {
      if (e.target === ov) close();
    });
    draw();
  }

  return { showLogin, menuItems, manage, logout };
})();
