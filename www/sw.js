'use strict';

/*
 * Service worker: shows push messages and opens SmartView when one is tapped (the list "Meldungen").
 * Every received push is also remembered on the device (Cache Storage), so that outside the home network a
 * tap still shows the messages: navigations that do not reach the ioBroker within 10 s get an offline page
 * with this list instead of the browser's error page.
 */

const LOG_CACHE = 'sv-meldungen';
const LOG_KEY = 'sv-meldungen.json';
const OFFLINE_AFTER = 10000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function readLog() {
  try {
    const c = await caches.open(LOG_CACHE);
    const r = await c.match(LOG_KEY);
    const data = r ? await r.json() : null;
    return data && Array.isArray(data.list) ? data : { keep: 7, list: [] };
  } catch (e) {
    return { keep: 7, list: [] };
  }
}

async function remember(msg) {
  if (!msg.id) return;
  const data = await readLog();
  const keep = Math.min(90, Math.max(1, Number(msg.keep) || data.keep || 7));
  const cutoff = Date.now() - keep * 86400000;
  const list = data.list.filter(e => e.id !== msg.id && e.ts >= cutoff);
  list.unshift({ id: String(msg.id), ts: Number(msg.ts) || Date.now(), title: String(msg.title || ''), body: String(msg.body || '') });
  const c = await caches.open(LOG_CACHE);
  await c.put(LOG_KEY, new Response(JSON.stringify({ keep, list: list.slice(0, 200) }), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('push', event => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch (e) {
    msg = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(msg.title || 'SmartView', {
        body: msg.body || '',
        tag: msg.tag || undefined,
        renotify: Boolean(msg.tag),
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        data: { url: msg.url || './' },
      }),
      remember(msg).catch(() => {}),
    ]),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

// ---------------- offline: SmartView is only reachable at home (or via VPN / VPS) ----------------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function offlinePage(request) {
  const { keep, list } = await readLog();
  const cutoff = Date.now() - keep * 86400000;
  let highlight = '';
  try {
    highlight = new URL(request.url).searchParams.get('log') || '';
  } catch (e) {
    // ignore
  }
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  let day = '';
  let rows = '';
  for (const e of list.filter(x => x.ts >= cutoff)) {
    const d = new Date(e.ts);
    const label = d.toDateString() === today ? 'Heute' : d.toDateString() === yesterday ? 'Gestern' : d.toLocaleDateString('de-AT', { weekday: 'long', day: 'numeric', month: 'numeric' });
    if (label !== day) {
      day = label;
      rows += '<h4>' + esc(label) + '</h4>';
    }
    rows += '<div class="it' + (e.id === highlight ? ' hl' : '') + '"><span class="t">' + esc(d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })) +
      '</span><div><b>' + esc(e.title) + '</b>' + (e.body ? '<div>' + esc(e.body) + '</div>' : '') + '</div></div>';
  }
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#0d1117"><title>SmartView – offline</title><style>' +
    'body{margin:0;font:16px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;padding:max(16px,env(safe-area-inset-top)) 16px 24px}' +
    '.box{max-width:640px;margin:0 auto}.off{border:1px solid #f0883e;border-radius:12px;padding:12px 14px;margin:8px 0 16px;background:#21170f}' +
    '.off b{color:#f0883e}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #30363d;background:#21262d;color:#e6edf3;margin-top:10px}' +
    'h1{font-size:20px;margin:6px 0}h4{margin:14px 0 4px;font-size:13px;color:#9aa3ad;text-transform:uppercase;letter-spacing:.04em}' +
    '.it{display:flex;gap:12px;padding:10px;border:1px solid #30363d;border-radius:12px;margin:6px 0;overflow-wrap:anywhere}.it.hl{border-color:#f85149;box-shadow:0 0 0 2px #f85149 inset}' +
    '.t{font-weight:600;min-width:44px;font-variant-numeric:tabular-nums}.muted{color:#9aa3ad}</style></head><body><div class="box">' +
    '<h1>Meldungen</h1><div class="off"><b>Offline</b> – keine Verbindung zum ioBroker. SmartView ist nur im Heimnetz (WLAN) oder über VPN erreichbar.' +
    '<br><button type="button" onclick="location.reload()">Erneut versuchen</button></div>' +
    '<div class="muted">Auf diesem Gerät empfangene Mitteilungen (letzte ' + keep + ' Tage):</div>' +
    (rows || '<p class="muted">Noch keine Mitteilungen auf diesem Gerät gespeichert.</p>') + '</div></body></html>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', event => {
  // only page loads; everything else (api, ws, pictures) goes to the network as before
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    new Promise(resolve => {
      let done = false;
      const fallback = () => {
        if (done) return;
        done = true;
        resolve(offlinePage(event.request));
      };
      const timer = setTimeout(fallback, OFFLINE_AFTER);
      fetch(event.request).then(
        res => {
          clearTimeout(timer);
          if (!done) {
            done = true;
            resolve(res);
          }
        },
        () => {
          clearTimeout(timer);
          fallback();
        },
      );
    }),
  );
});
