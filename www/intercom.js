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

  function ring(on) {
    on = on && deviceRings() && Boolean(tones);
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
    overlay.innerHTML = '<img alt=""><div class="bar"><span class="name"></span><span class="callbtns"></span></div><audio autoplay></audio>';
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
    if (action === 'answer') answer().catch(e => toast(e.message, true));
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
    if (mic) for (const t of mic.getTracks()) pc.addTrack(t, mic);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = ev => {
      const a = overlay && overlay.querySelector('audio');
      if (!a) return;
      a.srcObject = ev.streams[0] || new MediaStream([ev.track]);
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

  function cleanup() {
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
      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'callitem ' + e.result + (e.seen ? '' : ' new');
        if (e.image) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = 'api/intercom/history/' + e.id + '.jpg';
          img.alt = '';
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

  return { sync, menuItems, active: () => Boolean(inst) };
})();
