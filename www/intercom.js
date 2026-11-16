'use strict';

/*
 * Door intercom from the livecam adapter (when "Sprechstelle" is set under ⚙ Allgemein): ring tone,
 * answer and talk (WebRTC directly with livecam), reject/hang up, open the door, call list.
 * Same protocol as livecam's camera wall; SmartView relays it on /intercom/ws.
 */

const Intercom = (() => {
  let ws = null;
  let retry = 1000;
  let inst = '';
  let state = { state: 'idle' };
  let view = {};
  let pc = null;
  let mic = null;
  let answering = false; // "Abheben" tapped, call is being set up
  let actx = null; // Web Audio for the volume sliders (speaker and microphone gain up to 300 %)
  let outGain = null;
  let micGain = null;
  let overlay = null;
  let dismissed = false;
  let ringOn = false;
  const tones = typeof toneEngine === 'function' ? toneEngine() : null;

  function deviceRings() {
    try {
      return localStorage.getItem('sv.ringtone') !== 'off';
    } catch (e) {
      return true;
    }
  }

  function toneName() {
    // an own sound file of livecam ("custom") is not available here
    return view.ringTone && view.ringTone !== 'custom' ? view.ringTone : 'dingdong';
  }

  function volume() {
    return Math.min(100, Math.max(0, Number(view.ringVolume) || 70)) / 100;
  }

  /** "Nicht stören" of the adapter (switch or time window): ring silently */
  function dnd() {
    return Boolean(typeof SV !== 'undefined' && SV.dnd && SV.dnd.on);
  }

  function ring(on) {
    on = on && deviceRings() && !dnd() && Boolean(tones);
    if (on === ringOn) return; // state messages repeat while ringing: do not restart the melody
    ringOn = on;
    if (!on) return tones && tones.stop();
    tones.play(toneName(), volume(), { loop: true, onError: () => toast('Klingelton blockiert: im Browser Ton/Autoplay für diese Seite erlauben', true) });
  }

  /** Browsers allow sound only after a first touch: unlock the audio with it. */
  function unlockAudio() {
    if (!tones) return;
    const once = () => {
      document.removeEventListener('pointerdown', once, true);
      if (ringOn) return; // already ringing: the sound runs
      try {
        tones.play('dingdong', 0, {});
        setTimeout(() => !ringOn && tones.stop(), 50);
      } catch (e) {
        // ignore
      }
    };
    document.addEventListener('pointerdown', once, true);
  }

  /** Connect when an intercom is configured (called after every render). */
  function sync() {
    // the saved layout, not the one being edited: the server only knows the saved one
    const want = (SV.layout && SV.layout.ring.intercom) || '';
    if (want === inst) return;
    inst = want;
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    state = { state: 'idle' };
    update();
    if (inst) connect();
  }

  function connect() {
    if (!inst) return;
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'intercom/ws');
    ws = sock;
    sock.onopen = () => {
      retry = 1000;
    };
    sock.onmessage = async ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        state = msg;
        update();
      } else if (msg.type === 'view') {
        view = msg;
      } else if (msg.type === 'answer' && pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'error') {
        toast(msg.message, true);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      state = { state: 'idle' };
      update();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
  }

  function sendMsg(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else toast('Keine Verbindung zur Sprechstelle', true);
  }

  function cameraId() {
    return state.camera ? inst + '.cameras.' + state.camera : SV.layout.ring.camera;
  }

  // ---------------- call screen ----------------

  function update() {
    const s = state.state;
    const ringing = s === 'ringing';
    if (s === 'idle') {
      dismissed = false;
      cleanup();
      closeCall();
    } else if (!dismissed && !SV.editing && (ringing || state.mine)) {
      if (ringing && !overlay && typeof Screen !== 'undefined') Screen.ring();
      openCall();
    } else if (overlay && !ringing && !state.mine) {
      closeCall(); // answered on another device
    }
    ring(ringing && !dismissed);
    if (overlay) fillCall();
    const missed = $('missedBtn');
    if (missed) {
      missed.hidden = !state.missed || !inst;
      missed.textContent = '🔔 ' + (state.missed || 0);
      missed.title = state.missed + ' verpasste Anrufe';
    }
  }

  function openCall() {
    if (overlay) return;
    closeSheet();
    closeCam();
    overlay = document.createElement('div');
    overlay.className = 'camfull call ring';
    overlay.innerHTML = '<img alt=""><div class="bar"><span class="name"></span><span class="callbtns"></span></div>' +
      '<div class="callvol" hidden><label><span>🔊</span><input type="range" min="0" max="300" step="10" data-lv="vol"><b></b></label>' +
      '<label><span>🎤</span><input type="range" min="0" max="300" step="10" data-lv="mic"><b></b></label></div><audio autoplay></audio>';
    for (const r of overlay.querySelectorAll('input[data-lv]')) {
      r.value = level(r.dataset.lv);
      r.nextElementSibling.textContent = r.value + ' %';
      r.addEventListener('input', () => {
        r.nextElementSibling.textContent = r.value + ' %';
        setLevel(r.dataset.lv, Number(r.value));
      });
    }
    const cam = cameraId();
    if (cam) overlay.querySelector('img').src = 'cam/' + encodeURIComponent(cam) + '.mjpeg';
    document.body.appendChild(overlay);
  }

  function closeCall() {
    if (!overlay) return;
    overlay.querySelector('img').src = '';
    overlay.remove();
    overlay = null;
  }

  function fillCall() {
    const s = state.state;
    const ringing = s === 'ringing';
    const mine = state.mine;
    overlay.classList.toggle('ring', ringing);
    overlay.querySelector('.name').textContent = ringing ? 'Es läutet' + (state.caller ? ' – ' + state.caller : '')
      : s === 'connecting' ? 'Verbinde …'
      : s === 'active' ? (mine ? 'Gespräch läuft' : 'Gespräch an einem anderen Gerät') : '';
    const box = overlay.querySelector('.callbtns');
    const buttons = [];
    if (ringing) buttons.push(['answer', 'Abheben', 'answer']);
    if (ringing) buttons.push(['hangup', 'Ablehnen', 'hangup']);
    else if (mine) buttons.push(['hangup', 'Auflegen', 'hangup']);
    if (state.doorAvailable || (s === 'active' && mine)) buttons.push(['door', 'Tür öffnen', 'door']);
    buttons.push(['close', ringing ? 'Ausblenden' : 'Schließen', '']);
    // volume sliders only while this device has the call
    overlay.querySelector('.callvol').hidden = !(mine && !ringing && s !== 'idle');
    const sig = buttons.map(b => b[0]).join();
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    for (const [action, text, cls] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = () => act(action, b);
      box.appendChild(b);
    }
  }

  function act(action, btn) {
    if (action === 'answer') {
      // a slow start (microphone, connection) must not answer twice: the second tap is ignored
      if (answering) return;
      answering = true;
      btn.disabled = true;
      btn.textContent = 'Verbinde …';
      answer().catch(e => toast(e.message, true)).finally(() => {
        answering = false;
        if (overlay && state.state === 'ringing' && !pc) {
          btn.disabled = false;
          btn.textContent = 'Abheben';
        }
      });
    }
    else if (action === 'hangup') sendMsg({ type: 'hangup' });
    else if (action === 'door') {
      sendMsg({ type: 'door' });
      btn.disabled = true;
      setTimeout(() => (btn.disabled = false), 3000);
      toast('Tür wird geöffnet');
    } else if (action === 'close') {
      dismissed = true;
      ring(false);
      closeCall();
    }
  }

  async function answer() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Mikrofon nicht verfügbar: ' + (window.isSecureContext ? 'der Browser bietet kein Mikrofon an.'
        : 'diese Adresse ist nicht sicher – SmartView über https öffnen oder die Adresse im Browser freigeben (siehe Anleitung).'), true);
      return;
    }
    if (!ws || ws.readyState !== 1) return toast('Keine Verbindung zur Sprechstelle', true);
    ring(false);
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (e.name !== 'NotFoundError' && e.name !== 'NotReadableError') {
        toast('Kein Zugriff auf das Mikrofon (' + e.name + '): im Browser erlauben' + (window.top !== window ? ' bzw. beim iframe allow="microphone" eintragen' : ''), true);
        update();
        return;
      }
      // no usable microphone: answer anyway, listen only and open the door
      mic = null;
      toast(e.name === 'NotFoundError' ? 'Kein Mikrofon gefunden: nur Zuhören möglich' : 'Mikrofon von einem anderen Programm belegt: nur Zuhören möglich', true);
    }
    pc = new RTCPeerConnection();
    if (mic) {
      // microphone through a gain (slider 🎤); without Web Audio the plain track
      let send = mic;
      const ctx = audioCtx();
      if (ctx) {
        try {
          micGain = ctx.createGain();
          micGain.gain.value = level('mic') / 100;
          const dest = ctx.createMediaStreamDestination();
          ctx.createMediaStreamSource(mic).connect(micGain).connect(dest);
          send = dest.stream;
        } catch {
          micGain = null;
          send = mic;
        }
      }
      for (const t of send.getTracks()) pc.addTrack(t, send);
    } else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = ev => {
      const a = overlay && overlay.querySelector('audio');
      if (!a) return;
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      // Chromium only passes a remote WebRTC stream to Web Audio while a (muted) element plays it
      a.srcObject = stream;
      const ctx = audioCtx();
      outGain = null;
      if (ctx) {
        try {
          outGain = ctx.createGain();
          outGain.gain.value = level('vol') / 100;
          ctx.createMediaStreamSource(stream).connect(outGain).connect(ctx.destination);
          a.muted = true;
        } catch {
          outGain = null;
        }
      }
      if (!outGain) a.volume = Math.min(1, level('vol') / 100);
      a.play().catch(() => {});
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 2000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc && pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          res();
        }
      });
    });
    sendMsg({ type: 'answer', sdp: pc.localDescription.sdp });
  }

  // ---------------- volume (per device, 0-300 %) ----------------

  function audioCtx() {
    try {
      if (!actx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (C) actx = new C();
      }
      if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    } catch {
      actx = null;
    }
    return actx;
  }

  function level(key) {
    try {
      const v = localStorage.getItem('sv.call.' + key);
      const n = Number(v);
      if (v !== null && v !== '' && n >= 0 && n <= 300) return n;
    } catch {
      // no storage: default
    }
    return 100;
  }

  function setLevel(key, v) {
    try {
      localStorage.setItem('sv.call.' + key, String(v));
    } catch {
      // only for this call
    }
    if (key === 'mic' && micGain) micGain.gain.value = v / 100;
    if (key === 'vol') {
      if (outGain) outGain.gain.value = v / 100;
      else {
        const a = overlay && overlay.querySelector('audio');
        if (a) a.volume = Math.min(1, v / 100);
      }
    }
  }

  function cleanup() {
    for (const g of [outGain, micGain]) {
      try {
        if (g) g.disconnect();
      } catch {
        // already gone
      }
    }
    outGain = null;
    micGain = null;
    if (pc) {
      pc.close();
      pc = null;
    }
    if (mic) {
      mic.getTracks().forEach(t => t.stop());
      mic = null;
    }
  }

  // ---------------- call list ----------------

  const RESULT = { missed: 'Verpasst', answered: 'Angenommen', rejected: 'Abgelehnt' };

  async function showCalls() {
    closeSheet();
    const ov = document.createElement('div');
    ov.className = 'overlay bottom';
    ov.innerHTML = '<div class="sheet wide calls"><h3>' + icon('bell') + '<span class="grow">Anrufe</span><button type="button" class="iconbtn" data-close>' + icon('close') + '</button></h3><div class="calllist muted">Lade …</div><div class="row"><button type="button" data-seen>Alle als gesehen markieren</button></div></div>';
    ov.addEventListener('click', e => {
      if (e.target === ov) ov.remove();
    });
    ov.querySelector('[data-close]').onclick = () => ov.remove();
    ov.querySelector('[data-seen]').onclick = () => {
      sendMsg({ type: 'seen' });
      ov.remove();
    };
    document.body.appendChild(ov);
    const list = ov.querySelector('.calllist');
    try {
      const entries = await api('intercom/history');
      list.className = 'calllist';
      list.textContent = entries.length ? '' : 'Noch keine Anrufe.';
      const photos = entries.filter(x => x.image);
      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'callitem ' + e.result + (e.seen ? '' : ' new');
        if (e.image) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = 'api/intercom/history/' + e.id + '.jpg';
          img.alt = '';
          img.title = 'Antippen = groß';
          // tap = the photo full screen (small touch screens), ‹ › through the other calls' photos
          img.onclick = ev => {
            ev.stopPropagation();
            showPhoto(photos, photos.indexOf(e));
          };
          item.appendChild(img);
        }
        const text = document.createElement('div');
        const when = new Date(e.time).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        text.innerHTML = '<b>' + esc(RESULT[e.result] || e.result) + '</b> ' + esc(when) + (e.duration ? ' (' + e.duration + ' s)' : '') + (e.caller ? '<br><small>' + esc(e.caller) + '</small>' : '');
        item.appendChild(text);
        list.appendChild(item);
      }
    } catch (err) {
      list.textContent = 'Anrufliste nicht verfügbar: ' + err.message;
    }
  }

  function callCaption(e) {
    const when = new Date(e.time).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (RESULT[e.result] || e.result) + ' · ' + when + (e.caller ? ' · ' + e.caller : '');
  }

  /** photo of a call full screen: tap / ✕ / Esc closes, ‹ › or swipe for the previous / next call */
  function showPhoto(photos, index) {
    if (!photos.length || index < 0) return;
    let i = index;
    const ov = document.createElement('div');
    ov.className = 'photoview';
    ov.innerHTML = '<img alt=""><div class="pvbar"><button type="button" class="iconbtn" data-prev aria-label="Neuer">‹</button><span class="pvcap grow"></span>' +
      '<button type="button" class="iconbtn" data-next aria-label="Älter">›</button><button type="button" class="iconbtn" data-x aria-label="Schließen">' + icon('close') + '</button></div>';
    const img = ov.querySelector('img');
    // no native picture drag (it would swallow the swipe)
    img.draggable = false;
    img.addEventListener('dragstart', ev => ev.preventDefault());
    const show = () => {
      img.src = 'api/intercom/history/' + photos[i].id + '.jpg';
      ov.querySelector('.pvcap').textContent = callCaption(photos[i]) + (photos.length > 1 ? '  (' + (i + 1) + '/' + photos.length + ')' : '');
      ov.querySelector('[data-prev]').disabled = i === 0;
      ov.querySelector('[data-next]').disabled = i === photos.length - 1;
    };
    const close = () => {
      ov.remove();
      document.removeEventListener('keydown', key);
    };
    const step = d => {
      const n = i + d;
      if (n >= 0 && n < photos.length) {
        i = n;
        show();
      }
    };
    const key = ev => {
      if (ev.key === 'Escape') close();
      else if (ev.key === 'ArrowLeft') step(-1);
      else if (ev.key === 'ArrowRight') step(1);
    };
    ov.querySelector('[data-prev]').onclick = ev => {
      ev.stopPropagation();
      step(-1);
    };
    ov.querySelector('[data-next]').onclick = ev => {
      ev.stopPropagation();
      step(1);
    };
    ov.querySelector('[data-x]').onclick = ev => {
      ev.stopPropagation();
      close();
    };
    let x0 = null;
    ov.addEventListener('pointerdown', ev => (x0 = ev.clientX));
    ov.addEventListener('pointerup', ev => {
      const dx = x0 === null ? 0 : ev.clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
      else if (ev.target === img || ev.target === ov) close();
    });
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    show();
  }

  /** Entries for the ⚙ menu. */
  function menuItems(box) {
    if (!inst) return;
    const calls = document.createElement('button');
    calls.type = 'button';
    calls.className = 'item';
    calls.innerHTML = icon('bell') + 'Anrufliste' + (state.missed ? ' (' + state.missed + ' verpasst)' : '');
    calls.onclick = () => {
      box.closest('.overlay').remove();
      showCalls();
    };
    const tone = document.createElement('button');
    tone.type = 'button';
    tone.className = 'item';
    const label = () => icon('music') + 'Klingelton an diesem Gerät: <b>' + (deviceRings() ? 'Ein' : 'Aus') + '</b>';
    tone.innerHTML = label();
    tone.onclick = () => {
      try {
        localStorage.setItem('sv.ringtone', deviceRings() ? 'off' : 'on');
      } catch (e) {
        // ignore
      }
      tone.innerHTML = label();
    };
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'item';
    test.innerHTML = icon('bell') + 'Klingelton testen (' + esc((typeof TONE_LABELS === 'object' && TONE_LABELS[toneName()]) || toneName()) + ')';
    test.onclick = () => {
      if (!tones) return;
      tones.play(toneName(), volume(), { loop: false });
    };
    box.append(calls, tone, test);
  }

  $('missedBtn').onclick = showCalls;
  unlockAudio();

  /** switched on while it rings: stop the tone at once */
  function dndChanged() {
    if (dnd() && ringOn) {
      ringOn = false;
      if (tones) tones.stop();
    }
  }

  return { sync, menuItems, active: () => Boolean(inst), dndChanged, showCalls };
})();
