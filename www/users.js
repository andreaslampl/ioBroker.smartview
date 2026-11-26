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
  function showLogin(title, twofa) {
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
      (twofa ? '<label for="lgCode">Code aus der Authenticator-App</label><input id="lgCode" type="text" inputmode="numeric" maxlength="12" autocomplete="one-time-code" autocapitalize="none" required>' +
        '<button type="button" class="link" data-rec>Handy verloren? Wiederherstellungs-Code eingeben</button>' : '') +
      '<p class="hint">' + (twofa ? '🌍 Zugriff von unterwegs: Anmeldung nur mit Passwort und dem 6-stelligen Code aus der Authenticator-App. ' : '') + 'Dieses Gerät bleibt angemeldet, bis du dich abmeldest.</p>' +
      '<div class="row"><button type="submit" class="primary">Anmelden</button></div>';
    main.appendChild(box);
    const rec = box.querySelector('[data-rec]');
    if (rec) rec.onclick = () => {
      // recovery codes contain letters: normal keyboard
      $('lgCode').setAttribute('inputmode', 'text');
      $('lgCode').placeholder = 'abcde-fghij';
      $('lgCode').focus();
      rec.hidden = true;
    };
    keyboard(box);
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
        await api('login', { method: 'POST', body: JSON.stringify({ name, password: $('lgPw').value, code: twofa ? $('lgCode').value : undefined }) });
        try {
          localStorage.setItem('sv.user', name);
        } catch (err) {
          // ignore
        }
        location.reload();
      } catch (err) {
        $('lgPw').value = '';
        if (twofa) $('lgCode').value = '';
        toast(err.message, true);
      }
    };
  }

  // ---------------- on-screen keyboard (touch PC in kiosk mode has none) ----------------

  const OSK = {
    abc: ['1234567890ß', 'qwertzuiopü', 'asdfghjklöä', 'yxcvbnm-.'],
    sym: ['1234567890', '!@#$%&*()=', '+/\\:;\'"?,_', '<>[]{}€§~^|'],
  };

  /** Keyboard below the login form on touch screens: opens by itself on touch devices without their own keyboard. */
  function keyboard(form) {
    const touch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    if (!touch) return;
    const ownKeyboard = /iPhone|iPad|iPod|Android|Macintosh/.test(navigator.userAgent); // phones/tablets bring their own
    const inputs = [...form.querySelectorAll('input')];
    let target = inputs.find(i => i === document.activeElement) || inputs[0];
    let layer = 'abc';
    let shift = false;
    const toggle = el('button', 'osktoggle', '⌨ Bildschirmtastatur');
    toggle.type = 'button';
    form.appendChild(toggle);
    const kb = el('div', 'osk');
    kb.hidden = true;
    form.after(kb);
    for (const i of inputs) i.addEventListener('focus', () => (target = i));
    const draw = () => {
      const rows = OSK[layer].map(r => [...r].map(ch => {
        const c = shift && layer === 'abc' ? ch.toUpperCase() : ch;
        return '<button type="button" data-ch="' + esc(c) + '">' + esc(c) + '</button>';
      }).join(''));
      rows[3] = '<button type="button" class="wide' + (shift ? ' on' : '') + '" data-k="shift">⇧</button>' + rows[3] + '<button type="button" class="wide" data-k="back">⌫</button>';
      rows.push('<button type="button" class="wide" data-k="layer">' + (layer === 'abc' ? '?123' : 'abc') + '</button>' +
        '<button type="button" class="space" data-ch=" ">Leerzeichen</button>' +
        '<button type="button" class="wide" data-k="hide">▾</button>' +
        '<button type="button" class="wide enter" data-k="enter">⏎</button>');
      kb.innerHTML = rows.map(r => '<div class="oskrow">' + r + '</div>').join('');
    };
    const show = on => {
      kb.hidden = !on;
      toggle.hidden = on;
      // no native keyboard on top of ours (phones)
      for (const i of inputs) {
        if (on) i.setAttribute('inputmode', 'none');
        else if (i.id === 'lgCode') i.setAttribute('inputmode', 'numeric');
        else i.removeAttribute('inputmode');
      }
      if (on) draw();
    };
    // keep the focus (and caret) in the input while keys are pressed
    kb.addEventListener('pointerdown', e => e.preventDefault());
    kb.addEventListener('mousedown', e => e.preventDefault());
    kb.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !target) return;
      target.focus();
      const ch = b.dataset.ch;
      if (ch !== undefined) {
        const a = target.selectionStart ?? target.value.length;
        const z = target.selectionEnd ?? target.value.length;
        if (target.maxLength > 0 && target.value.length - (z - a) >= target.maxLength) return;
        try {
          target.setRangeText(ch, a, z, 'end');
        } catch (err) {
          target.value += ch; // inputs without selection API
        }
        if (shift) {
          shift = false;
          draw();
        }
        return;
      }
      const k = b.dataset.k;
      if (k === 'back') {
        const a = target.selectionStart ?? target.value.length;
        const z = target.selectionEnd ?? target.value.length;
        try {
          if (a === z && a > 0) target.setRangeText('', a - 1, z, 'end');
          else target.setRangeText('', a, z, 'end');
        } catch (err) {
          target.value = target.value.slice(0, -1);
        }
      } else if (k === 'shift') {
        shift = !shift;
        draw();
      } else if (k === 'layer') {
        layer = layer === 'abc' ? 'sym' : 'abc';
        shift = false;
        draw();
      } else if (k === 'hide') {
        show(false);
      } else if (k === 'enter') {
        const next = inputs[inputs.indexOf(target) + 1];
        if (next) next.focus();
        else form.requestSubmit();
      }
    });
    toggle.onclick = () => {
      show(true);
      target.focus();
    };
    if (!ownKeyboard) show(true);
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
    if (me.usersEnabled && me.name) html += '<button type="button" class="item" data-twofa>' + icon('lock') + 'Zwei-Faktor für Zugriff von unterwegs: ' + (me.totp ? 'ein' : 'aus') + '</button>';
    if (me.admin && !me.external) html += '<button type="button" class="item" data-remote>' + icon('globe') + 'Fernzugang (von unterwegs)</button>';
    if (me.manageUsers) html += '<button type="button" class="item" data-users>' + icon('shield') + 'Benutzer verwalten</button>';
    if (me.usersEnabled) html += '<button type="button" class="item" data-logout>' + icon('close') + 'Abmelden</button>';
    box.innerHTML = html;
    const u = box.querySelector('[data-users]');
    if (u) u.onclick = () => {
      box.closest('.overlay').remove();
      manage();
    };
    const tf = box.querySelector('[data-twofa]');
    if (tf) tf.onclick = () => {
      box.closest('.overlay').remove();
      twofa();
    };
    const rm = box.querySelector('[data-remote]');
    if (rm) rm.onclick = () => {
      box.closest('.overlay').remove();
      remote();
    };
    const l = box.querySelector('[data-logout]');
    if (l) l.onclick = logout;
  }

  // ---------------- own authenticator ----------------

  async function twofa() {
    const me = SV.me || {};
    const ov = el('div', 'overlay');
    const sh = el('form', 'sheet form twofa');
    ov.appendChild(sh);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => {
      if (e.target === ov) close();
    });
    const head = '<h3>' + icon('lock') + '<span class="grow">Zwei-Faktor-Anmeldung</span><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></h3>';
    const vpsHint = '<p class="hint">Nur für den Zugriff <b>von unterwegs</b> (Fernzugang über Tailscale Funnel, eigenen Server oder VPS). Im Heimnetz wird der Code nie verlangt.</p>';
    const codeField = '<label for="tfCode">6-stelliger Code aus der App</label><input id="tfCode" type="text" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" required>';
    const showCodes = codes => {
      sh.onsubmit = e => e.preventDefault();
      sh.innerHTML = head + '<p class="hint ok">Fertig. Dies sind deine <b>Wiederherstellungs-Codes</b> – jeder funktioniert einmal, falls das Handy verloren geht. ' +
        'Jetzt ausdrucken oder sicher aufbewahren, sie werden <b>nur jetzt</b> angezeigt.</p>' +
        '<pre class="reccodes">' + codes.map(esc).join('\n') + '</pre>' +
        '<div class="row"><button type="button" data-copy>Kopieren</button><button type="button" data-print>Drucken</button><button type="button" class="primary" data-done>Fertig</button></div>';
      sh.querySelector('[data-x]').onclick = () => location.reload();
      sh.querySelector('[data-done]').onclick = () => location.reload();
      sh.querySelector('[data-copy]').onclick = () => {
        try {
          navigator.clipboard.writeText(codes.join('\n'));
          toast('Kopiert');
        } catch (err) {
          toast('Kopieren nicht möglich – bitte abschreiben', true);
        }
      };
      sh.querySelector('[data-print]').onclick = () => {
        const w = window.open('', '_blank');
        if (!w) return toast('Drucken nicht möglich (Popup gesperrt)', true);
        w.document.write('<title>SmartView Wiederherstellungs-Codes</title><h2>SmartView – Wiederherstellungs-Codes (' + esc(me.name || '') + ')</h2><pre style="font-size:18px">' + codes.map(esc).join('\n') + '</pre><p>Jeder Code funktioniert einmal.</p>');
        w.document.close();
        w.print();
      };
    };
    const wire = (url, done) => {
      sh.querySelector('[data-x]').onclick = close;
      sh.onsubmit = async e => {
        e.preventDefault();
        const target = e.submitter && e.submitter.dataset.url ? e.submitter.dataset.url : url;
        try {
          const r = await api(target, { method: 'POST', body: JSON.stringify({ code: $('tfCode').value }) });
          if (r && r.recovery) return showCodes(r.recovery);
          toast(done);
          close();
          setTimeout(() => location.reload(), 600);
        } catch (err) {
          $('tfCode').value = '';
          toast(err.message, true);
        }
      };
    };
    if (me.external) {
      sh.innerHTML = head + '<p class="hint">Zwei-Faktor lässt sich nur <b>im Heimnetz</b> einrichten oder ändern.</p>' +
        (me.totp ? '<p class="hint ok">Eingerichtet · Wiederherstellungs-Codes übrig: ' + (me.recoveryLeft || 0) + '</p>' : '');
      sh.querySelector('[data-x]').onclick = close;
      return;
    }
    if (me.totp) {
      sh.innerHTML = head + vpsHint + '<p class="hint ok">Eingerichtet: Für den Zugriff von außen braucht es Passwort und den Code aus der Authenticator-App.</p>' +
        '<p class="hint">Wiederherstellungs-Codes übrig: <b>' + (me.recoveryLeft || 0) + '</b>. Neue Codes oder Ausschalten (z. B. neues Handy): aktuellen Code eingeben.</p>' +
        codeField + '<div class="row"><button type="submit" data-url="2fa/recovery">Neue Wiederherstellungs-Codes</button><button type="submit" class="danger">Ausschalten</button></div>';
      return wire('2fa/off', 'Zwei-Faktor ausgeschaltet');
    }
    sh.innerHTML = head + '<p class="hint">Wird geladen …</p>';
    sh.querySelector('[data-x]').onclick = close;
    let d;
    try {
      d = await api('2fa/start', { method: 'POST', body: '{}' });
    } catch (err) {
      close();
      return toast(err.message, true);
    }
    sh.innerHTML = head + vpsHint +
      '<p class="hint">1. In <b>Microsoft Authenticator</b> (oder Google Authenticator) auf <b>+</b> → „Anderes Konto“ und diesen QR-Code scannen:</p>' +
      '<div class="qr">' + d.qr + '</div>' +
      '<p class="hint">Kein Scannen möglich (QR-Code auf dem eigenen Handy)? ' + (/iPhone|iPad|Android/.test(navigator.userAgent) ? '<a href="' + esc(d.uri) + '">In der App öffnen</a> oder ' : '') + 'Schlüssel von Hand eingeben: <code class="secret">' + esc(d.secret) + '</code></p>' +
      '<p class="hint">2. Den Code eingeben, den die App jetzt zeigt:</p>' + codeField +
      '<div class="row"><button type="submit" class="primary">Einrichten</button></div>';
    wire('2fa/confirm', 'Zwei-Faktor eingerichtet');
    $('tfCode').focus();
  }

  // ---------------- remote access (admins, at home) ----------------

  async function remote() {
    const ov = el('div', 'overlay');
    const sh = el('div', 'sheet form remote');
    ov.appendChild(sh);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => {
      if (e.target === ov) close();
    });
    const head = '<h3>' + icon('globe') + '<span class="grow">Fernzugang</span><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></h3>';
    const draw = async () => {
      let d;
      try {
        d = await api('remote');
      } catch (err) {
        close();
        return toast(err.message, true);
      }
      const mode = { funnel: 'Tailscale Funnel', relay: 'Eigener Server' }[d.mode] || 'Aus';
      const cls = d.state === 'on' ? 'ok' : d.state === 'off' ? '' : 'bad';
      let html = head + '<p class="hint">Art: <b>' + mode + '</b> (umstellen in den Instanz-Einstellungen von SmartView, Abschnitt „Zugriff von unterwegs“)</p>' +
        '<p class="hint ' + cls + '">' + esc(d.text || '') + '</p>';
      if (d.link) html += '<div class="row"><a class="btn primary" href="' + esc(d.link) + '" target="_blank" rel="noopener">Bei Tailscale freischalten</a><button type="button" data-retry>Erneut versuchen</button></div>';
      else if (d.mode === 'funnel') html += '<div class="row"><button type="button" data-retry>Erneut prüfen</button></div>';
      if (d.url) {
        html += '<p class="hint">Adresse für unterwegs:</p><p><code class="secret">' + esc(d.url) + '</code></p>' +
          '<div class="qr">' + (d.qr || '') + '</div><div class="row"><button type="button" data-copy>Adresse kopieren</button></div>';
      }
      if (d.addLine) {
        html += '<p class="hint">Am eigenen Server (einmal, als root) diese Zeile ausführen:</p><pre class="reccodes">' + esc(d.addLine) + '</pre>' +
          '<div class="row"><button type="button" data-copyline>Zeile kopieren</button><button type="button" class="danger" data-newkey>Neuer Schlüssel</button></div>' +
          '<details class="guide"><summary>Kurzanleitung eigener Server</summary><ol>' +
          '<li>Auf dem Server <code>alvms-relay.py</code> (liegt bei SmartView unter tools/remote) einmal mit <code>sudo python3 alvms-relay.py install</code> einrichten (Port 443, oder <code>--port 8443</code>).</li>' +
          '<li>Beim Anbieter (IONOS: Cloud Panel → Netzwerk → Firewall) TCP 443 eingehend erlauben.</li>' +
          '<li>Einen zweiten DuckDNS-Namen auf die IP des Servers zeigen lassen; das Zertifikat dafür holt der acme-Adapter (DuckDNS, DNS-01).</li>' +
          '<li>Die Zeile oben am Server ausführen – SmartView verbindet sich innerhalb einer Minute.</li></ol></details>';
      }
      if (d.withoutTotp && d.withoutTotp.length) {
        html += '<p class="hint bad">Ohne Zwei-Faktor (kommen von unterwegs nicht hinein): ' + d.withoutTotp.map(esc).join(', ') + '</p>';
      }
      if (!d.usersEnabled && d.mode) html += '<p class="hint bad">Es sind keine Benutzer angelegt – von unterwegs ist SmartView gesperrt.</p>';
      sh.innerHTML = html;
      sh.querySelector('[data-x]').onclick = close;
      const on = (sel, fn) => {
        const b = sh.querySelector(sel);
        if (b) b.onclick = fn;
      };
      const act = async action => {
        try {
          await api('remote/action', { method: 'POST', body: JSON.stringify({ action }) });
          draw();
        } catch (err) {
          toast(err.message, true);
        }
      };
      on('[data-retry]', () => act('retry'));
      on('[data-newkey]', () => {
        if (confirm('Neuen Schlüssel erzeugen? Danach muss die neue Zeile am Server ausgeführt werden.')) act('newkey');
      });
      const copy = text => {
        try {
          navigator.clipboard.writeText(text);
          toast('Kopiert');
        } catch (err) {
          toast('Kopieren nicht möglich', true);
        }
      };
      on('[data-copy]', () => copy(d.url));
      on('[data-copyline]', () => copy(d.addLine));
    };
    sh.innerHTML = head + '<p class="hint">Wird geladen …</p>';
    sh.querySelector('[data-x]').onclick = close;
    draw();
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
      const head = el('div', 'uhead', icon(u.admin ? 'shield' : 'home') + '<span class="grow"><b>' + esc(u.name || 'Neuer Benutzer') + '</b><small>' + esc(summary) + (u.totp ? ' · 🔐 Authenticator' : '') + (u.sessions ? ' · ' + u.sessions + ' Gerät(e) angemeldet' : '') + '</small></span><span class="chev">' + (u.open ? '▲' : '▼') + '</span>');
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
        (u.totp ? '<label class="check"><input type="checkbox" data-k="totpReset"> Authenticator zurücksetzen (z. B. Handy verloren – muss dann neu eingerichtet werden)</label>' : '') +
        '<div class="row"><button type="button" class="danger" data-del>Benutzer löschen</button></div>';
      b.appendChild(body);
      const q = s => body.querySelector(s);
      q('[data-k=name]').value = u.name;
      q('[data-k=name]').oninput = e => (u.name = e.target.value);
      q('[data-k=password]').value = u.password;
      q('[data-k=password]').oninput = e => (u.password = e.target.value);
      for (const k of ['admin', 'control', 'intercom', 'totpReset']) {
        if (!q('[data-k=' + k + ']')) continue;
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
        await api('users', { method: 'PUT', body: JSON.stringify(users.map(u => ({ id: u.id, name: u.name, password: u.password, admin: u.admin, pages: u.pages, control: u.control, intercom: u.intercom, totpReset: Boolean(u.totpReset) }))) });
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

  return { showLogin, menuItems, manage, logout, twofa, remote };
})();
