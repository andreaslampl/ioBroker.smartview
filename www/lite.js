/*
 * SmartView Lite: a plain page for old devices (iPad with iOS 9 Safari), opened at /lite.
 * Written in ES5 on purpose (no arrow functions, let/const, classes, template strings, fetch, Promise chains,
 * Array.includes, closest …) - the tests parse it as ECMAScript 5. Same API and websocket as the app, so
 * users, rights and PINs apply unchanged. Only simple tiles: switch, dimmer, blind, button (also with entries),
 * value, multi, thermostat (set point), heading, camera (single pictures, tap = big). Everything else stays in the normal app.
 */
(function () {
  'use strict';

  var S = { layout: null, page: null, states: {}, writable: {}, ws: null, retry: 1000, pending: null };
  var SUPPORTED = { heading: 1, 'switch': 1, dimmer: 1, blind: 1, button: 1, value: 1, multi: 1, thermostat: 1, camera: 1 };
  var camSrc = {}; // camera -> last loaded picture (shown right away after a re-render, no white flash)

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(text, err) {
    var t = $('toast');
    t.textContent = text;
    t.className = err ? 'err' : '';
    t.style.display = text ? 'block' : 'none';
    clearTimeout(toast.timer);
    if (text) toast.timer = setTimeout(function () { toast(''); }, err ? 5000 : 2000);
  }

  function xhr(method, url, body, cb) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = function () {
      if (r.readyState !== 4) return;
      var data = null;
      try {
        data = JSON.parse(r.responseText);
      } catch (e) {
        data = null;
      }
      cb(r.status, data);
    };
    r.send(body ? JSON.stringify(body) : null);
  }

  function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'ON';
  }

  function st(id) {
    return id ? S.states[id] : null;
  }

  function val(id) {
    var s = st(id);
    return s ? s.val : undefined;
  }

  function known(id) {
    var s = st(id);
    return Boolean(s && !s.missing && s.val !== null && s.val !== undefined && s.val !== '');
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function canWrite(id) {
    return Boolean(id && S.writable[id]);
  }

  /** "a=b;c=d" -> {a: 'b', c: 'd'} */
  function texts(s) {
    var out = {};
    var parts = String(s || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].indexOf('=');
      if (k > 0) out[parts[i].slice(0, k).trim()] = parts[i].slice(k + 1).trim();
    }
    return out;
  }

  function fmt(id, opt) {
    opt = opt || {};
    var s = st(id);
    if (!s || s.missing || s.val === null || s.val === undefined) return '–';
    var v = s.val;
    var own = texts(opt.texts);
    if (own[String(v)] !== undefined) return own[String(v)];
    if (s.states && s.states[String(v)] !== undefined) return String(s.states[String(v)]);
    if (typeof v === 'boolean') return v ? 'Ein' : 'Aus';
    var n = typeof v === 'number' ? v : null;
    if (n === null) return String(v);
    var d = opt.decimals !== undefined && opt.decimals !== '' && opt.decimals !== null ? Number(opt.decimals) : Math.abs(n) >= 100 ? 0 : 1;
    var text = (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
    var unit = opt.unit || s.unit || '';
    return text + (unit ? ' ' + unit : '');
  }

  // ---------------- tiles ----------------

  /** link tiles ("Verknüpfung"): fields of the original, own label */
  function resolve(t) {
    if (t.type !== 'ref' || !t.ref) return t;
    var parts = String(t.ref).split('/');
    var pages = S.layout.pages;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].id !== parts[0]) continue;
      for (var j = 0; j < pages[i].tiles.length; j++) {
        var o = pages[i].tiles[j];
        if (o.id === parts[1] && o.type !== 'ref') {
          var copy = {};
          for (var k in o) copy[k] = o[k];
          copy.id = t.id;
          if (t.label) copy.label = t.label;
          return copy;
        }
      }
    }
    return t;
  }

  function merge(base, extra) {
    var o = {};
    var k;
    for (k in base) o[k] = base[k];
    for (k in extra) o[k] = extra[k];
    return o;
  }

  /** several entries in one tile (central functions, scenes): the tile's own data point is entry 1 */
  function entries(t) {
    if (!t.entries || !t.entries.length) return null;
    var list = [];
    if (t.state) list.push(merge(t, { entries: null, label: t.entryLabel || t.label || 'Eintrag 1' }));
    for (var i = 0; i < t.entries.length; i++) {
      var e = t.entries[i];
      list.push(merge(t, { entries: null, label: e.label || 'Eintrag ' + (i + 2), state: e.state, status: e.status || '', stop: e.stop || '', sendMode: e.sendMode || '', value: e.value }));
    }
    return list;
  }

  /** heating circuits: the tile's own fields are circuit 1 */
  function circuits(t) {
    if (!t.circuits || !t.circuits.length) return [t];
    var list = [merge(t, { label: t.circLabel || t.label })];
    for (var i = 0; i < t.circuits.length; i++) list.push(merge(t, merge(t.circuits[i], { label: t.circuits[i].label || 'Kreis ' + (i + 2) })));
    return list;
  }

  function switchOn(t) {
    var v = val(t.status || t.state);
    return t.invert ? !truthy(v) : truthy(v);
  }

  /** a switch that always sends one value / push button knows its state only from the status data point */
  function switchKnown(t) {
    if ((t.sendMode === 'true' || t.sendMode === 'false' || t.sendMode === 'push') && !t.status) return false;
    return known(t.status || t.state);
  }

  function dimLevel(t) {
    return num(val(t.status || t.state)) || 0;
  }

  function dimOn(t) {
    if (t.switchState) return truthy(val(t.switchState));
    return dimLevel(t) > 0;
  }

  function blindText(t) {
    var s = st(t.status || t.state);
    if (!s || s.missing || s.val === null || s.val === undefined || typeof s.val === 'boolean') return '';
    var p = num(s.val);
    if (p === null) return '';
    var open = Boolean(t.closed100) !== Boolean(t.posInvert) ? 100 - p : p;
    if (t.kind === 'awning') return open >= 99 ? 'Eingefahren' : open <= 1 ? 'Ausgefahren' : Math.round(100 - open) + ' % aus';
    return open >= 99 ? 'Offen' : open <= 1 ? 'Zu' : Math.round(open) + ' % offen';
  }

  function blindWrite(t, openPercent) {
    var s = st(t.state);
    if (s && s.type === 'boolean') {
      var down = openPercent === 0;
      return send(t.state, t.closed100 ? !down : down);
    }
    send(t.state, Boolean(t.closed100) !== Boolean(t.posInvert) ? 100 - openPercent : openPercent);
  }

  function thermoStep(t, dir) {
    var cur = num(val(t.state));
    if (cur === null) cur = num(val(t.setStatus));
    if (cur === null) return toast('Sollwert unbekannt', true);
    var step = num(t.step) || 0.5;
    var s = st(t.state) || {};
    var min = num(t.min);
    var max = num(t.max);
    if (min === null) min = num(s.min) !== null ? num(s.min) : 5;
    if (max === null) max = num(s.max) !== null ? num(s.max) : 35;
    var next = Math.round((cur + dir * step) * 100) / 100;
    send(t.state, Math.max(min, Math.min(max, next)));
  }

  // ---------------- commands ----------------

  function send(id, value, pin) {
    if (!canWrite(id)) return toast('Nicht freigegeben', true);
    if (!S.ws || S.ws.readyState !== 1) return toast('Keine Verbindung zum ioBroker', true);
    S.pending = { id: id, val: value };
    var msg = { type: 'set', id: id, val: value };
    if (pin) msg.pin = pin;
    S.ws.send(JSON.stringify(msg));
  }

  function hold(id, down) {
    if (!canWrite(id) || !S.ws || S.ws.readyState !== 1) return;
    S.ws.send(JSON.stringify({ type: 'set', id: id, val: down, hold: true }));
  }

  /** what a button does: [tile, action] */
  function act(t, a) {
    if (a === 'on') {
      if (t.type === 'dimmer') {
        if (t.switchState) send(t.switchState, true);
        else send(t.state, 100);
      } else send(t.state, !t.invert);
    } else if (a === 'off') {
      if (t.type === 'dimmer') {
        if (t.switchState) send(t.switchState, false);
        else send(t.state, 0);
      } else send(t.state, Boolean(t.invert));
    } else if (a === 'toggle') {
      act(t, switchOn(t) ? 'off' : 'on');
    } else if (a === 'dimup' || a === 'dimdown') {
      var cur = dimOn(t) ? dimLevel(t) : 0;
      var next = Math.max(0, Math.min(100, Math.round((cur + (a === 'dimup' ? 10 : -10)) / 10) * 10));
      if (t.switchState && next > 0 && !dimOn(t)) send(t.switchState, true);
      if (t.state) send(t.state, next);
    } else if (a === 'up') blindWrite(t, 100);
    else if (a === 'down') blindWrite(t, 0);
    else if (a === 'stop') send(t.stop, true);
    else if (a === 'press') {
      if (t.confirm && !window.confirm((t.label || 'Aktion') + ' wirklich auslösen?')) return;
      send(t.state, t.value === undefined || t.value === '' ? true : t.value);
    } else if (a === 'plus') thermoStep(t, 1);
    else if (a === 'minus') thermoStep(t, -1);
  }

  // ---------------- rendering ----------------

  var actions = []; // index -> {t, a} of the buttons on screen

  function button(t, a, text, pri) {
    actions.push({ t: t, a: a });
    return '<button type="button" data-n="' + (actions.length - 1) + '"' + (pri ? ' class="pri"' : '') + '>' + text + '</button>';
  }

  function pushButton(t, text) {
    return '<button type="button" class="pri" data-push="' + esc(t.state) + '">' + esc(text) + '</button>';
  }

  function row(cls, name, sub, value, btns) {
    return '<div class="row' + (cls ? ' ' + cls : '') + '"><div class="name">' + (cls === 'on' || cls === 'off' ? '<span class="lamp"></span>' : '') + esc(name) +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' + (value !== '' ? '<div class="val">' + esc(value) + '</div>' : '') +
      (btns ? '<div class="btns">' + btns + '</div>' : '') + '</div>';
  }

  function switchRow(t) {
    var k = switchKnown(t);
    var cls = k ? (switchOn(t) ? 'on' : 'off') : '';
    if (!canWrite(t.state)) return row(cls, t.label, '', k ? (switchOn(t) ? 'Ein' : 'Aus') : '–', '');
    if (t.sendMode === 'push') return row(cls, t.label, k ? (switchOn(t) ? 'Ein' : 'Aus') : 'Taster', '', pushButton(t, 'Drücken'));
    return row(cls, t.label, '', k ? (switchOn(t) ? 'Ein' : 'Aus') : '', button(t, 'off', 'Aus') + button(t, 'on', 'Ein', true));
  }

  function blindRow(t) {
    var w = t.kind === 'awning' ? ['Ein', 'Aus'] : ['Auf', 'Ab'];
    if (!canWrite(t.state)) return row('', t.label, '', blindText(t) || '–', '');
    return row('', t.label, '', blindText(t), button(t, 'up', w[0]) + (t.stop && canWrite(t.stop) ? button(t, 'stop', 'Stopp') : '') + button(t, 'down', w[1]));
  }

  function buttonRow(t) {
    return row('', t.label, '', '', canWrite(t.state) ? button(t, 'press', 'Auslösen', true) : '');
  }

  function tileHtml(t0) {
    var t = resolve(t0);
    if (!SUPPORTED[t.type]) return '';
    var list;
    var html = '';
    var i;
    if (t.type === 'heading') return '<h2>' + esc(t.label) + '</h2>';
    if ((t.type === 'switch' || t.type === 'blind' || t.type === 'button') && (list = entries(t))) {
      html = '<h2>' + esc(t.label || '') + '</h2><div class="sub">';
      for (i = 0; i < list.length; i++) html += t.type === 'switch' ? switchRow(list[i]) : t.type === 'blind' ? blindRow(list[i]) : buttonRow(list[i]);
      return html + '</div>';
    }
    if (t.type === 'switch') return switchRow(t);
    if (t.type === 'blind') return blindRow(t);
    if (t.type === 'button') return buttonRow(t);
    if (t.type === 'dimmer') {
      var on = dimOn(t);
      var btns = canWrite(t.state) || canWrite(t.switchState) ? button(t, 'off', 'Aus') + button(t, 'dimdown', '−') + button(t, 'dimup', '+') + button(t, 'on', 'Ein', true) : '';
      return row(on ? 'on' : 'off', t.label, '', on ? Math.round(dimLevel(t)) + ' %' : 'Aus', btns);
    }
    if (t.type === 'value') {
      var v = val(t.state);
      var alert = (t.highlight === 'on' && truthy(v)) || (t.highlight === 'off' && known(t.state) && !truthy(v));
      return row(alert ? 'alert' : '', t.label, '', fmt(t.state, t), '');
    }
    if (t.type === 'multi') {
      var rows = t.rows || [];
      html = '<div class="row multi"><div class="name">' + esc(t.label) + '</div><div style="flex:1;-webkit-flex:1">';
      for (i = 0; i < rows.length; i++) html += '<div class="line"><span>' + esc(rows[i].label) + '</span><b>' + esc(fmt(rows[i].state, rows[i])) + '</b></div>';
      return html + '</div></div>';
    }
    if (t.type === 'camera') {
      if (!t.camera) return '';
      return '<div class="cam" data-big="' + esc(t.camera) + '" data-name="' + esc(t.label || '') + '"><div class="camname">' + esc(t.label || '') + '</div>' +
        '<img class="camimg" alt="" data-cam="' + esc(t.camera) + '"' + (camSrc[t.camera] ? ' src="' + esc(camSrc[t.camera]) + '"' : '') + '></div>';
    }
    if (t.type === 'thermostat') {
      list = circuits(t);
      for (i = 0; i < list.length; i++) {
        var c = list[i];
        var set = known(c.state) ? c.state : c.setStatus;
        var sub = (known(c.status) ? 'Ist ' + fmt(c.status, { unit: c.unit || '°C', decimals: 1 }) : '') + (known(c.humidity) ? '  ·  ' + fmt(c.humidity, { unit: '%', decimals: 0 }) : '');
        var b = !t.fixedSet && canWrite(c.state) ? button(c, 'minus', '−') + button(c, 'plus', '+') : '';
        html += row('', c.label, sub, 'Soll ' + fmt(set, { unit: c.unit || '°C', decimals: 1 }), b);
      }
      return html;
    }
    return '';
  }

  function visible(t) {
    return t.device !== 'phone';
  }

  function render() {
    if (!S.layout) return;
    var pages = [];
    var i;
    for (i = 0; i < S.layout.pages.length; i++) if (!S.layout.pages[i].hidden || S.layout.pages[i].id === S.page) pages.push(S.layout.pages[i]);
    var cur = null;
    for (i = 0; i < pages.length; i++) if (pages[i].id === S.page) cur = pages[i];
    if (!cur) cur = pages[0];
    S.page = cur ? cur.id : null;
    var nav = '';
    for (i = 0; i < pages.length; i++) nav += '<a href="#' + encodeURIComponent(pages[i].id) + '"' + (pages[i] === cur ? ' class="sel"' : '') + '>' + esc(pages[i].name || pages[i].id) + '</a>';
    $('pages').innerHTML = nav;
    actions = [];
    var html = '';
    if (cur) for (i = 0; i < cur.tiles.length; i++) if (visible(cur.tiles[i])) html += tileHtml(cur.tiles[i]);
    $('main').innerHTML = html || '<p class="hint">Auf dieser Seite gibt es nichts, was SmartView Lite anzeigen kann.<br>(Grundrisse, Sprechanlage, Energie usw. nur in der normalen App.)</p>';
  }

  // render at most every 300 ms (many state changes at once)
  var renderTimer = null;
  function later() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      render();
    }, 300);
  }

  // ---------------- cameras: single pictures (old Safari cannot show video streams reliably) ----------------

  function loadCam(img) {
    if (img.getAttribute('data-loading') === '1') return;
    var cam = img.getAttribute('data-cam');
    var url = '/cam/' + encodeURIComponent(cam) + '.jpg?t=' + new Date().getTime();
    img.setAttribute('data-loading', '1');
    img.onload = function () {
      camSrc[cam] = url;
      img.setAttribute('data-loading', '0');
    };
    img.onerror = function () {
      setTimeout(function () { img.setAttribute('data-loading', '0'); }, 3000);
    };
    img.src = url;
  }

  setInterval(function () {
    if (document.hidden) return;
    var imgs = document.getElementsByClassName('camimg');
    for (var i = 0; i < imgs.length; i++) loadCam(imgs[i]);
  }, 1500);

  function openCam(cam, name) {
    closeCam();
    var ov = document.createElement('div');
    ov.id = 'camov';
    ov.innerHTML = '<div class="bar"><span>' + esc(name) + '</span><button type="button" id="camclose">Schließen</button></div>' +
      '<img class="camimg" alt="" data-cam="' + esc(cam) + '"' + (camSrc[cam] ? ' src="' + esc(camSrc[cam]) + '"' : '') + '>';
    document.body.appendChild(ov);
    $('camclose').onclick = closeCam;
    loadCam(ov.getElementsByTagName('img')[0]);
  }

  function closeCam() {
    var ov = $('camov');
    if (ov) ov.parentNode.removeChild(ov);
  }

  document.addEventListener('click', function (e) {
    var c = target(e.target, 'data-big');
    if (c) openCam(c.getAttribute('data-big'), c.getAttribute('data-name'));
  });

  // ---------------- input ----------------

  function target(el, attr) {
    while (el && el !== document) {
      if (el.getAttribute && el.getAttribute(attr) !== null) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    var b = target(e.target, 'data-n');
    if (!b) return;
    var x = actions[Number(b.getAttribute('data-n'))];
    if (x) act(x.t, x.a);
  });

  // push buttons: pressed while the finger is down
  var pushed = null;
  function pushDown(e) {
    var b = target(e.target, 'data-push');
    if (!b) return;
    if (e.type === 'touchstart') e.preventDefault();
    pushed = b;
    b.className += ' pressed';
    hold(b.getAttribute('data-push'), true);
  }
  function pushUp() {
    if (!pushed) return;
    var b = pushed;
    pushed = null;
    b.className = b.className.replace(/\s*pressed/g, '');
    hold(b.getAttribute('data-push'), false);
  }
  document.addEventListener('touchstart', pushDown, false);
  document.addEventListener('mousedown', function (e) {
    if (!pushed) pushDown(e);
  }, false);
  document.addEventListener('touchend', pushUp, false);
  document.addEventListener('touchcancel', pushUp, false);
  document.addEventListener('mouseup', pushUp, false);

  window.addEventListener('hashchange', function () {
    S.page = decodeURIComponent(location.hash.slice(1));
    try {
      localStorage.setItem('sv.lite.page', S.page);
    } catch (e) {
      // private mode
    }
    render();
    window.scrollTo(0, 0);
  });

  // ---------------- connection ----------------

  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    S.ws = ws;
    ws.onopen = function () {
      S.retry = 1000;
      $('dot').className = '';
    };
    ws.onmessage = function (ev) {
      var m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.type === 'init') {
        S.states = m.states || {};
        S.writable = {};
        for (var i = 0; i < (m.writable || []).length; i++) S.writable[m.writable[i]] = true;
        render();
      } else if (m.type === 'state') {
        S.states[m.id] = m.state;
        later();
      } else if (m.type === 'layout') {
        // layout saved: pages, rights and writable data points may have changed
        location.reload();
      } else if (m.type === 'pin') {
        var p = S.pending;
        if (m.result === 'need' && p && p.id === m.id) {
          var pin = window.prompt('PIN eingeben');
          if (pin) send(p.id, p.val, pin);
        } else if (m.result === 'wrong') toast('Falsche PIN', true);
        else if (m.result === 'locked') toast('Zu viele Fehlversuche – 5 Minuten gesperrt', true);
      } else if (m.type === 'error') {
        toast(m.text, true);
      }
    };
    ws.onclose = function () {
      $('dot').className = 'off';
      setTimeout(connect, S.retry);
      S.retry = Math.min(S.retry * 2, 30000);
    };
  }

  function loginForm(title) {
    $('pages').innerHTML = '';
    $('main').innerHTML = '<form class="login"><h2>' + esc(title || 'SmartView') + ' – Anmelden</h2>' +
      '<input name="name" placeholder="Name" autocapitalize="off" autocorrect="off"><input name="password" type="password" placeholder="Passwort">' +
      '<button type="submit">Anmelden</button></form>';
    var f = $('main').getElementsByTagName('form')[0];
    f.onsubmit = function (e) {
      e.preventDefault();
      xhr('POST', '/api/login', { name: f.elements.name.value, password: f.elements.password.value }, function (status, data) {
        if (status === 200) return start();
        toast((data && data.error) || 'Anmeldung fehlgeschlagen', true);
      });
    };
  }

  function loadLayout(cb) {
    xhr('GET', '/api/layout', null, function (status, data) {
      if (status === 401) return loginForm(data && data.title);
      if (status !== 200 || !data) {
        $('main').innerHTML = '<p class="hint">SmartView nicht erreichbar (' + status + ').<br>Mit Zugangsschlüssel: /lite?key=…</p>';
        return;
      }
      S.layout = data.layout;
      $('title').textContent = S.layout.title || 'SmartView';
      render();
      if (cb) cb();
    });
  }

  function start() {
    loadLayout(function () {
      if (!S.ws) connect();
    });
  }

  function clock() {
    var d = new Date();
    $('clock').textContent = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  try {
    S.page = location.hash ? decodeURIComponent(location.hash.slice(1)) : localStorage.getItem('sv.lite.page');
  } catch (e) {
    S.page = null;
  }
  clock();
  setInterval(clock, 10000);
  start();
})();
