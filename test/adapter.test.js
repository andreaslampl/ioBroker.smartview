'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const https = require('node:https');
const path = require('node:path');
const WebSocket = require('ws');
const { install, demoHouse } = require('./fake-iobroker');

install();

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

/** Fake livecam: /cam/<id>.jpg, /history, intercom on /ws */
async function fakeLivecam() {
    const received = [];
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/history')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ id: 1, time: '2026-10-20T10:00:00Z', result: 'missed', caller: 'Haustuer', image: false }]));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from(`JPEG ${req.url}`));
    });
    const wss = new WebSocket.WebSocketServer({ server, path: '/ws' });
    wss.on('connection', ws => {
        ws.send(JSON.stringify({ type: 'state', state: 'ringing', caller: 'Haustuer', camera: 'haustuer', mine: false, missed: 1 }));
        ws.send(JSON.stringify({ type: 'view', ringTone: 'westminster', ringVolume: 60 }));
        ws.on('message', d => received.push(JSON.parse(d.toString())));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, wss, received, base: `http://127.0.0.1:${server.address().port}` };
}

/** A port nobody uses right now (asked from the OS, not guessed). */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function startAdapter(t, config = {}, before = () => {}) {
    const port = await freePort();
    const httpsPort = await freePort();
    const cam = await fakeLivecam();
    const adapter = require('../main.js')({ config: { port, httpsPort, publicHost: '127.0.0.1', ...config } });
    demoHouse(adapter, cam.base);
    before(adapter);
    const pushed = [];
    adapter.pushSender = async (sub, payload) => pushed.push(JSON.parse(payload));
    adapter.emit('ready');
    await until(() => adapter.foreign['smartview.0.info.connection'] && adapter.foreign['smartview.0.info.connection'].val === true, 30000);
    t.after(async () => {
        await new Promise(resolve => adapter.emit('unload', resolve));
        for (const c of cam.wss.clients) {
            c.terminate();
        }
        cam.server.close();
    });
    const base = `http://127.0.0.1:${port}/`;
    const api = async (p, opts = {}) => {
        const res = await fetch(base + 'api/' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
        const text = await res.text();
        return { status: res.status, body: text && res.headers.get('content-type').includes('json') ? JSON.parse(text) : text };
    };
    return { adapter, port, httpsPort, base, api, pushed, cam };
}

function wsClient(url, headers) {
    const ws = new WebSocket(url, { headers });
    const msgs = [];
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    return { ws, msgs, open: new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject)) };
}

const LAYOUT = {
    title: 'Haus',
    pages: [
        {
            id: 'start',
            name: 'Start',
            tiles: [
                { id: 'l1', type: 'switch', label: 'Licht', state: 'knx.0.EG.Licht.Wohnzimmer' },
                { id: 'f1', type: 'value', label: 'Fenster', state: 'knx.0.EG.Fenster.Kueche' },
                { id: 'c1', type: 'camera', label: 'Haustür', camera: 'livecam.0.cameras.haustuer' },
            ],
        },
        { id: 'eg', name: 'EG', type: 'plan', tiles: [{ id: 'd1', type: 'dimmer', label: 'Essen', state: 'knx.0.EG.Licht.Essen_Dimmer', x: 30, y: 60 }] },
    ],
    ring: { state: 'livecam.0.intercom.ringing', camera: 'livecam.0.cameras.haustuer', door: 'livecam.0.intercom.openDoor' },
    push: [{ id: 'r1', state: 'knx.0.EG.Fenster.Kueche', cond: 'true', title: 'Fenster', text: 'Küchenfenster offen' }],
};

test('adapter: layout, live values, commands only for layout data points, push rule, cameras, upload, https', async t => {
    const { adapter, port, httpsPort, base, api, pushed } = await startAdapter(t);
    assert.match(adapter.foreign['smartview.0.info.httpsUrl'].val, /^https:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(await (await fetch(base)).text(), /app\.js/);
    assert.match(await (await fetch(base + 'zertifikat')).text(), /Zum Home-Bildschirm/);
    // pdf.js for the PDF import of floor plans is served as module
    const pdfjs = await fetch(base + 'vendor/pdf.min.mjs');
    assert.equal(pdfjs.status, 200);
    assert.match(pdfjs.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(base + 'vendor/../main.js')).status, 404);
    const manifest = await (await fetch(base + 'manifest.json')).json();
    assert.equal(manifest.display, 'standalone');

    // editor saves the layout -> data points get subscribed
    const saved = await api('layout', { method: 'PUT', body: JSON.stringify(LAYOUT) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.pages[1].tiles[0].x, 30);
    assert.ok(adapter.subs.has('knx.0.EG.Licht.Essen_Dimmer'));
    assert.equal((await api('layout')).body.layout.title, 'Haus');

    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    const init = c.msgs.find(m => m.type === 'init');
    assert.equal(init.states['knx.0.EG.Licht.Wohnzimmer'].val, false);
    assert.equal(init.states['knx.0.EG.Fenster.Kueche'].role, 'sensor.window');
    assert.deepEqual(init.writable.sort(), ['knx.0.EG.Licht.Essen_Dimmer', 'knx.0.EG.Licht.Wohnzimmer', 'livecam.0.intercom.openDoor']);

    // command: written as command (ack=false) with the data point's type, the confirmation comes back live
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: 1 }));
    await until(() => adapter.writes.length === 1);
    assert.deepEqual(adapter.writes[0], ['knx.0.EG.Licht.Wohnzimmer', true, false]);
    await until(() => c.msgs.some(m => m.type === 'state' && m.id === 'knx.0.EG.Licht.Wohnzimmer' && m.state.ack === true && m.state.val === true));
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Essen_Dimmer', val: '40' }));
    await until(() => adapter.writes.length === 2);
    assert.deepEqual(adapter.writes[1], ['knx.0.EG.Licht.Essen_Dimmer', 40, false]);

    // not in the layout or only displayed -> refused
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Fenster.Kueche', val: false }));
    c.ws.send(JSON.stringify({ type: 'set', id: 'system.adapter.admin.0.alive', val: false }));
    await until(() => c.msgs.filter(m => m.type === 'error').length === 2);
    assert.equal(adapter.writes.length, 2);

    // a phone registers for push
    const reg = await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/xyz', keys: { p256dh: 'p', auth: 'a' } }, name: 'iPhone' }) });
    assert.equal(reg.status, 200);
    assert.equal(adapter.foreign['smartview.0.push.devices'].val, 1);
    // push rule: window opens -> one message; stays open -> no second one
    adapter.change('knx.0.EG.Fenster.Kueche', false);
    await new Promise(r => setTimeout(r, 50));
    adapter.change('knx.0.EG.Fenster.Kueche', true);
    await until(() => pushed.length === 1);
    assert.deepEqual(pushed[0], { title: 'Fenster', body: 'Küchenfenster offen', url: './', tag: 'r1' });
    adapter.change('knx.0.EG.Fenster.Kueche', true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pushed.length, 1);
    // push.message state
    await adapter.onStateChange('smartview.0.push.message', { val: '{"title":"Hallo","text":"Test","page":"eg"}', ack: false });
    assert.deepEqual(pushed[1], { title: 'Hallo', body: 'Test', url: './#eg' });

    // cameras: list and image through the proxy
    const cams = await api('cameras');
    assert.deepEqual(cams.body.map(x => x.id), ['livecam.0.cameras.einfahrt', 'livecam.0.cameras.haustuer']);
    const img = await fetch(base + 'cam/' + encodeURIComponent('livecam.0.cameras.haustuer') + '.jpg');
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(await img.text(), /^JPEG \/cam\/haustuer\.jpg\?fresh=1$/);
    assert.equal((await fetch(base + 'cam/' + encodeURIComponent('knx.0.x') + '.jpg')).status, 404);

    // floor plan upload
    const up = await fetch(base + 'api/upload?name=Grundriss%20EG.png', { method: 'POST', body: Buffer.from('PNGDATA') });
    const { file } = await up.json();
    assert.match(file, /^Grundriss_EG-[a-z0-9]+\.png$/);
    const f = await fetch(base + 'files/' + file);
    assert.equal(f.headers.get('content-type'), 'image/png');
    assert.equal(await f.text(), 'PNGDATA');
    assert.equal((await fetch(base + 'api/upload?name=boese.html', { method: 'POST', body: 'x' })).status, 400);

    // https with the own CA
    const certs = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'certs.json'), 'utf8'));
    const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: httpsPort, path: '/api/push/key', ca: certs.ca.cert }, res => {
            let d = '';
            res.on('data', x => (d += x));
            res.on('end', () => resolve(d));
        }).on('error', reject);
    });
    assert.match(JSON.parse(body).publicKey, /^[A-Za-z0-9_-]+$/);
    const ca = await fetch(base + 'smartview.mobileconfig');
    assert.match(await ca.text(), /PayloadContent/);
});

test('adapter: access key protects API and live values, cookie after the first visit; editing can be locked', async t => {
    const { port, base } = await startAdapter(t, { accessKey: 'geheim', allowEdit: false });
    assert.equal((await fetch(base + 'api/layout')).status, 403);
    const first = await fetch(base + 'api/layout?key=geheim');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).allowEdit, false);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + 'api/layout', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + 'api/layout', { method: 'PUT', headers: { cookie }, body: '{}' })).status, 403);
    const manifest = await (await fetch(base + 'manifest.json', { headers: { cookie } })).json();
    assert.equal(manifest.start_url, './?key=geheim');

    const denied = wsClient(`ws://127.0.0.1:${port}/ws`);
    await assert.rejects(denied.open);
    const ok = wsClient(`ws://127.0.0.1:${port}/ws`, { cookie });
    t.after(() => ok.ws.close());
    await ok.open;
    await until(() => ok.msgs.some(m => m.type === 'init'));
});

test('adapter: door intercom of livecam relayed on /intercom/ws, call list, ring tones', async t => {
    const { port, base, api, cam } = await startAdapter(t);
    // without an intercom chosen: refused
    const none = wsClient(`ws://127.0.0.1:${port}/intercom/ws`);
    await none.open;
    await until(() => none.msgs.some(m => m.type === 'error'));

    await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [], ring: { intercom: 'livecam.0' } }) });
    assert.equal((await api('layout')).body.layout.ring.intercom, 'livecam.0');
    const c = wsClient(`ws://127.0.0.1:${port}/intercom/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'state') && c.msgs.some(m => m.type === 'view'));
    assert.equal(c.msgs.find(m => m.type === 'state').state, 'ringing');
    c.ws.send(JSON.stringify({ type: 'answer', sdp: 'v=0' }));
    c.ws.send(JSON.stringify({ type: 'door' }));
    await until(() => cam.received.length === 2);
    assert.deepEqual(cam.received.map(m => m.type), ['answer', 'door']);
    // one upstream connection per browser (livecam must know who answered)
    assert.equal(cam.wss.clients.size, 1);

    const hist = await api('intercom/history');
    assert.equal(hist.body[0].result, 'missed');
    const tones = await (await fetch(base + 'tones-engine.js')).text();
    assert.match(tones, /const toneEngine = function toneEngine\(\)/);
    assert.match(tones, /westminster/);
});

test('adapter: intercom address from the livecam instance settings when no camera URL states exist', async t => {
    const { adapter, port, cam } = await startAdapter(t);
    for (const id of Object.keys(adapter.foreign).filter(x => x.startsWith('livecam.0.cameras.'))) {
        delete adapter.foreign[id];
    }
    adapter.objects['system.adapter.livecam.0'] = { type: 'instance', common: { name: 'livecam' }, native: { port: Number(new URL(cam.base).port), accessKey: '' } };
    await fetch(`http://127.0.0.1:${port}/api/layout`, { method: 'PUT', body: JSON.stringify({ pages: [], ring: { intercom: 'livecam.0' } }) });
    const c = wsClient(`ws://127.0.0.1:${port}/intercom/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'state'));
    assert.equal(c.msgs.find(m => m.type === 'state').state, 'ringing');
});


test('adapter: time switches per tile via the API, writes like the buttons', async t => {
    const { adapter, api } = await startAdapter(t);
    await api('layout', {
        method: 'PUT',
        body: JSON.stringify({
            pages: [
                {
                    id: 'eg',
                    tiles: [
                        { id: 'l1', type: 'switch', state: 'knx.0.EG.Licht.Wohnzimmer', invert: false },
                        { id: 'd1', type: 'dimmer', state: 'knx.0.EG.Licht.Essen_Dimmer' },
                        { id: 'r1', type: 'blind', state: 'knx.0.EG.Rollladen.Wohnzimmer', closed100: true },
                        { id: 'r2', type: 'blind', state: 'knx.0.EG.Rollladen.Wohnzimmer', closed100: true, posInvert: true },
                        { id: 'v1', type: 'value', state: 'knx.0.EG.Fenster.Kueche' },
                    ],
                },
            ],
        }),
    });
    const put = await api('timers/eg/l1', { method: 'PUT', body: JSON.stringify({ entries: [{ days: [1, 2, 3], at: 'time', time: '07:15', action: 'on' }] }) });
    assert.equal(put.status, 200);
    assert.equal((await api('timers/eg/v1', { method: 'PUT', body: JSON.stringify({ entries: [{}] }) })).status, 400);
    const got = (await api('timers')).body;
    assert.equal(got.timers['eg/l1'].entries[0].time, '07:15');
    assert.ok(got.timers['eg/l1'].entries[0].next > Date.now());

    const tile = id => adapter.tileByKey(`eg/${id}`);
    await adapter.fireTimer(tile('l1'), 'on', undefined, { at: 'time', time: '07:15' });
    await adapter.fireTimer(tile('d1'), 'level', 30, { at: 'sunset', offset: -15 });
    await adapter.fireTimer(tile('r1'), 'down', undefined, { at: 'time', time: '20:00' });
    await adapter.fireTimer(tile('r1'), 'position', 25, { at: 'time', time: '21:00' });
    assert.deepEqual(adapter.writes.slice(-4), [
        ['knx.0.EG.Licht.Wohnzimmer', true, false],
        ['knx.0.EG.Licht.Essen_Dimmer', 30, false],
        ['knx.0.EG.Rollladen.Wohnzimmer', 100, false], // closed100: down = 100
        ['knx.0.EG.Rollladen.Wohnzimmer', 75, false], // 25 % open
    ]);
    // "Prozent umdrehen" swaps the percent meaning again: 100 = open
    await adapter.fireTimer(tile('r2'), 'position', 25, { at: 'time', time: '21:00' });
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.EG.Rollladen.Wohnzimmer', 25, false]);
});

test('adapter: users - login, own pages only, watch-only users cannot switch, only admins edit', async t => {
    const { adapter, port, base, api } = await startAdapter(t);
    assert.equal((await api('layout', { method: 'PUT', body: JSON.stringify(LAYOUT) })).status, 200);
    // without users: open as before
    const open = (await api('layout')).body;
    assert.equal(open.me.usersEnabled, false);
    assert.equal(open.me.manageUsers, true);

    // the first user must be an admin; whoever creates it is logged in
    assert.equal((await api('users', { method: 'PUT', body: JSON.stringify([{ name: 'Kind', password: '1234', pages: ['start'] }]) })).status, 400);
    assert.equal((await api('users', { method: 'PUT', body: JSON.stringify([{ name: 'Andi', password: '12' , admin: true }]) })).status, 400);
    const first = await fetch(base + 'api/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ name: 'Andi', password: 'geheim1', admin: true }]) });
    assert.equal(first.status, 200);
    const adminCookie = first.headers.get('set-cookie').split(';')[0];
    assert.match(adminCookie, /^sv_session=/);
    assert.ok(!fs.readFileSync(path.join(adapter.dataDir, 'users.json'), 'utf8').includes('geheim1'));

    // now everything needs a login
    const anon = await api('layout');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.login, true);
    assert.equal((await fetch(base + 'cam/livecam.0.cameras.haustuer.jpg')).status, 401);
    await assert.rejects(wsClient(`ws://127.0.0.1:${port}/ws`).open);

    const as = cookie => (p, opts = {}) => api(p, { ...opts, headers: { 'Content-Type': 'application/json', Cookie: cookie } });
    const admin = as(adminCookie);
    const me = (await admin('layout')).body;
    assert.equal(me.me.name, 'Andi');
    assert.equal(me.allowEdit, true);
    assert.equal(me.layout.pages.length, 2);

    // admin adds a watch-only user for the start page without doorbell
    const list = (await admin('users')).body.users;
    const saved = await admin('users', { method: 'PUT', body: JSON.stringify([...list, { name: 'Gast', password: '4711', pages: ['start'], control: false, intercom: false }]) });
    assert.equal(saved.status, 200);
    assert.equal((await admin('layout')).status, 200, 'admin stays logged in');

    const login = async (name, password) => fetch(base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
    assert.equal((await login('Gast', 'falsch')).status, 403);
    const ok = await login('gast', '4711');
    assert.equal(ok.status, 200);
    const guestCookie = ok.headers.get('set-cookie').split(';')[0];
    const guest = as(guestCookie);
    const gl = (await guest('layout')).body;
    assert.deepEqual(gl.layout.pages.map(p => p.id), ['start']);
    assert.equal(gl.layout.ring.door, '');
    assert.deepEqual(gl.layout.push, []);
    assert.equal(gl.allowEdit, false);
    assert.equal(gl.me.control, false);
    assert.equal((await guest('layout', { method: 'PUT', body: JSON.stringify(LAYOUT) })).status, 403);
    assert.equal((await guest('users')).status, 403);
    assert.equal((await guest('objects')).status, 403);
    assert.equal((await guest('timers/start/l1', { method: 'PUT', body: '{"entries":[]}' })).status, 403);
    // camera of its page yes, others no
    assert.equal((await fetch(base + 'cam/livecam.0.cameras.haustuer.jpg', { headers: { Cookie: guestCookie } })).status, 200);
    assert.equal((await fetch(base + 'cam/livecam.0.cameras.einfahrt.jpg', { headers: { Cookie: guestCookie } })).status, 403);

    // live values: only its page, no writing
    const c = wsClient(`ws://127.0.0.1:${port}/ws`, { Cookie: guestCookie });
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    const init = c.msgs.find(m => m.type === 'init');
    assert.ok(init.states['knx.0.EG.Licht.Wohnzimmer']);
    assert.equal(init.states['knx.0.EG.Licht.Essen_Dimmer'], undefined);
    assert.equal(init.states['livecam.0.intercom.ringing'], undefined);
    assert.deepEqual(init.writable, []);
    const writes = adapter.writes.length;
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: true }));
    await until(() => c.msgs.some(m => m.type === 'error'));
    assert.equal(adapter.writes.length, writes);
    adapter.change('knx.0.EG.Licht.Essen_Dimmer', 10);
    adapter.change('knx.0.EG.Licht.Wohnzimmer', true);
    await until(() => c.msgs.some(m => m.type === 'state' && m.id === 'knx.0.EG.Licht.Wohnzimmer'));
    assert.ok(!c.msgs.some(m => m.type === 'state' && m.id === 'knx.0.EG.Licht.Essen_Dimmer'));

    // admin allows switching -> same connection may write now
    const users = (await admin('users')).body.users.map(u => (u.name === 'Gast' ? { ...u, control: true } : u));
    assert.equal((await admin('users', { method: 'PUT', body: JSON.stringify(users) })).status, 200);
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: false }));
    await until(() => adapter.writes.length > writes);
    // the dimmer of the other page stays locked
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Essen_Dimmer', val: 50 }));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!adapter.writes.some(w => w[0] === 'knx.0.EG.Licht.Essen_Dimmer' && w[1] === 50));

    // log out ends the session; deleting the user ends it too
    assert.equal((await guest('logout', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await guest('layout')).status, 401);
    c.ws.close();

    // brute force: wait after 5 wrong attempts
    for (let i = 0; i < 5; i++) {
        await login('Andi', 'nein');
    }
    const blocked = await login('Andi', 'geheim1');
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /warten/);
});

test('adapter: users switched off in the instance settings (forgotten password)', async t => {
    const { adapter, api } = await startAdapter(t, { usersOff: true });
    const { UserStore } = require('../lib/users');
    const store = new UserStore(adapter.dataDir);
    assert.equal(store.enabled, false);
    // users exist, but the emergency switch lets everybody in to set a new password
    adapter.server.users.save([{ name: 'Andi', password: 'vergessen', admin: true }], []);
    const r = await api('layout');
    assert.equal(r.status, 200);
    assert.equal(r.body.me.admin, true);
    assert.equal((await api('users')).body.emergency, true);
});

test('adapter: push rules also via the telegram adapter, doorbell photo, test button', async t => {
    const { adapter, api, pushed } = await startAdapter(t);
    adapter.objects['system.adapter.telegram.0'] = { type: 'instance', common: { name: 'telegram' } };
    assert.deepEqual((await api('telegram')).body.instances, ['telegram.0']);
    assert.equal((await api('telegram/test', { method: 'POST', body: '{}' })).status, 400);
    const layout = {
        ...LAYOUT,
        push: [
            { id: 'r1', state: 'knx.0.EG.Fenster.Kueche', cond: 'false', title: 'Fenster', text: 'Küche <zu>', page: 'eg' },
            { id: 'r2', state: 'knx.0.EG.Licht.Kueche', cond: 'false', title: 'Licht aus', via: 'app' },
            { id: 'r3', state: 'knx.0.EG.Licht.Wohnzimmer', cond: 'true', title: 'Licht an', via: 'telegram' },
        ],
        telegram: { instance: 'telegram.0', users: 'Andi', ring: true },
    };
    // push subscription so app pushes are sent
    adapter.push.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }, 'iPhone');
    const saved = await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    assert.equal(saved.body.telegram.instance, 'telegram.0');
    // older layouts: via 'telegram' -> channels
    assert.deepEqual(saved.body.push[2].channels, { app: false, telegram: true, whatsapp: false });
    adapter.sent = [];

    adapter.change('knx.0.EG.Fenster.Kueche', false);
    adapter.change('knx.0.EG.Licht.Kueche', false);
    adapter.change('knx.0.EG.Licht.Wohnzimmer', true);
    await until(() => adapter.sent.length >= 2 && pushed.length >= 2);
    const texts = adapter.sent.map(s => s.message.text);
    assert.equal(adapter.sent[0].instance, 'telegram.0');
    assert.equal(adapter.sent[0].message.user, 'Andi');
    assert.match(texts[0], /<b>Fenster<\/b>\nKüche &lt;zu&gt;/);
    assert.match(texts[0], /href="http:\/\/127\.0\.0\.1:\d+\/#eg"/);
    assert.ok(!texts.some(x => /Licht aus/.test(x)), 'app only');
    assert.ok(texts.some(x => /Licht an/.test(x)));
    assert.ok(!pushed.some(p => p.title === 'Licht an'), 'telegram only');
    assert.ok(pushed.some(p => p.title === 'Licht aus'));

    // doorbell: picture of the ring camera
    adapter.sent = [];
    adapter.change('livecam.0.intercom.ringing', true);
    await until(() => adapter.sent.length === 1);
    assert.equal(adapter.sent[0].message.type, 'photo');
    assert.ok(Buffer.isBuffer(adapter.sent[0].message.text));
    assert.match(adapter.sent[0].message.text.toString(), /JPEG \/cam\/haustuer\.jpg/);
    assert.match(adapter.sent[0].message.caption, /Es läutet/);
    adapter.change('livecam.0.intercom.ringing', true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.sent.length, 1, 'only when it starts ringing');

    const test = await api('telegram/test', { method: 'POST', body: '{}' });
    assert.equal(test.body.sent, 1);
    // push.message goes to telegram too
    adapter.sent = [];
    adapter.change('smartview.0.push.message', 'Hallo', false);
    await until(() => adapter.sent.length === 1);
});

test('adapter: Let\'s Encrypt certificate from the acme adapter (nothing to install), renewed without restart', async t => {
    const { createCa, createServerCert } = require('../lib/certs');
    const le = createCa('Fake LE');
    const first = createServerCert(le, ['home.example.org']);
    const collection = c => ({ from: 'system.adapter.acme.0', key: c.key, cert: c.cert, chain: [c.cert, le.cert], domains: ['home.example.org'], staging: false, tsExpires: Date.now() + 80 * 86400000 });
    const { adapter, httpsPort, base } = await startAdapter(t, { certCollection: 'default', publicHost: '127.0.0.1' }, a => {
        a.objects['system.certificates'] = { type: 'config', common: {}, native: { collections: { default: collection(first) } } };
    });
    // links use the domain of the certificate
    assert.match(adapter.foreign['smartview.0.info.httpsUrl'].val, /^https:\/\/home\.example\.org:\d+\/$/);
    const peer = () =>
        new Promise((resolve, reject) => {
            // the device trusts the public CA - not the own SmartView CA
            const req = https.get({ host: '127.0.0.1', servername: 'home.example.org', port: httpsPort, path: '/manifest.json', ca: le.cert, agent: false }, res => {
                const fp = res.socket.getPeerCertificate().fingerprint256;
                res.resume();
                resolve(fp);
            });
            req.on('error', reject);
        });
    const fp1 = await peer();
    assert.ok(fp1);
    assert.match(await (await fetch(base + 'zertifikat')).text(), /nichts installiert werden/);

    // acme renews -> new certificate without restart
    const second = createServerCert(le, ['home.example.org']);
    adapter.objects['system.certificates'].native.collections.default = collection(second);
    adapter.emit('objectChange', 'system.certificates', adapter.objects['system.certificates']);
    await until(async () => (await peer()) !== fp1);
});

test('adapter: push rules via WhatsApp (whatsapp-cmb, text only), per rule channels, doorbell text', async t => {
    const { adapter, api } = await startAdapter(t);
    adapter.objects['system.adapter.whatsapp-cmb.0'] = { type: 'instance', common: { name: 'whatsapp-cmb' } };
    assert.deepEqual((await api('whatsapp')).body.instances, ['whatsapp-cmb.0']);
    const layout = {
        ...LAYOUT,
        push: [
            { id: 'r1', state: 'knx.0.EG.Fenster.Kueche', cond: 'false', title: 'Fenster', text: 'Küche zu', page: 'eg', channels: { app: false, telegram: false, whatsapp: true } },
            { id: 'r2', state: 'knx.0.EG.Licht.Kueche', cond: 'false', title: 'Licht aus', channels: { app: true, telegram: true, whatsapp: false } },
        ],
        whatsapp: { instance: 'whatsapp-cmb.0', phone: '+43 664 123', ring: true },
    };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    assert.equal(saved.whatsapp.phone, '+43664123');
    adapter.sent = [];
    adapter.change('knx.0.EG.Fenster.Kueche', false);
    adapter.change('knx.0.EG.Licht.Kueche', false);
    await until(() => adapter.sent.length >= 1);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].instance, 'whatsapp-cmb.0');
    assert.equal(adapter.sent[0].message.phone, '+43664123');
    assert.match(adapter.sent[0].message.text, /^\*Fenster\*\nKüche zu\nhttp:\/\/127\.0\.0\.1:\d+\/#eg$/);
    adapter.sent = [];
    adapter.change('livecam.0.intercom.ringing', true);
    await until(() => adapter.sent.length === 1);
    assert.match(adapter.sent[0].message.text, /Es läutet/);
    assert.equal((await api('whatsapp/test', { method: 'POST', body: '{}' })).body.sent, true);
});

test('adapter: pictures of the web adapter (VIS) are passed through for the HTML tile, only images', async t => {
    const web = http.createServer((req, res) => {
        if (req.url === '/vis.0/main/img/fenster_zu.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(Buffer.from('PNGDATA'));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => web.listen(0, '127.0.0.1', r));
    t.after(() => web.close());
    const { adapter, base } = await startAdapter(t);
    adapter.objects['system.adapter.web.0'] = { type: 'instance', common: { enabled: true }, native: { port: web.address().port, bind: '0.0.0.0', secure: false } };
    const r = await fetch(base + 'web/vis.0/main/img/fenster_zu.png');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'PNGDATA');
    assert.equal((await fetch(base + 'web/vis.0/main/project.json')).status, 404, 'only pictures');
    assert.equal((await fetch(base + 'web/vis.0/../../etc/passwd.png')).status, 404);
});

test('adapter: tiles with "auch in HomeKit" become homekit-easy devices, its devices can become tiles', async t => {
    const { adapter, api } = await startAdapter(t);
    // no homekit-easy yet: nothing is sent
    assert.equal((await api('homekit')).body.instance, '');
    adapter.objects['system.adapter.homekit-easy.0'] = { type: 'instance', common: { name: 'homekit-easy' } };
    adapter.foreign['system.adapter.homekit-easy.0.alive'] = { val: true, ack: true };
    adapter.hkCache = null;
    const syncs = [];
    adapter.handlers = {
        'homekit-easy.0': (command, message) => {
            if (command === 'sync') {
                syncs.push(message.devices);
                return { ok: true, created: message.devices.length, updated: 0, removed: 0 };
            }
            return {
                devices: [
                    { id: 'own', type: 'light', name: 'Licht Bad', state: 'knx.0.OG.Licht.Bad', status: 'knx.0.OG.Licht.Bad_Status' },
                    { id: 'temp', type: 'temperature', name: 'Temperatur Bad', state: 'knx.0.OG.Temp.Bad' },
                    { id: 'gar', type: 'garage', name: 'Garage', command: 'x' },
                    { id: 'sv-eg-l1', type: 'light', name: 'Licht', state: 'knx.0.EG.Licht.Wohnzimmer', source: 'smartview.0' },
                ],
                types: { light: 'Licht (Ein/Aus)', temperature: 'Temperatur', garage: 'Garagentor' },
            };
        },
    };
    const info = (await api('homekit')).body;
    assert.deepEqual([info.instance, info.running, info.choices.switch[0]], ['homekit-easy.0', true, 'light']);

    // take over from homekit-easy: own devices only, garage cannot be a tile
    const hk = (await api('homekit/devices')).body.devices;
    assert.deepEqual(hk.map(d => d.id), ['own', 'temp', 'gar']);
    assert.deepEqual(hk[0].tile, { type: 'switch', label: 'Licht Bad', homekit: 'light', hkId: 'own', icon: 'bulb', state: 'knx.0.OG.Licht.Bad', status: 'knx.0.OG.Licht.Bad_Status' });
    assert.equal(hk[1].tile.unit, '°C');
    assert.equal(hk[2].tile, null);

    const layout = {
        title: 'Haus',
        pages: [
            {
                id: 'eg',
                name: 'EG',
                tiles: [
                    { id: 'l1', type: 'switch', label: 'Licht', state: 'knx.0.EG.Licht.Wohnzimmer', homekit: 'light' },
                    { id: 'b1', type: 'blind', label: 'Rollladen', state: 'knx.0.EG.Rollladen', closed100: true, homekit: 'blind' },
                    { id: 'x1', type: 'switch', label: 'Steckdose', state: 'knx.0.EG.Steckdose' },
                ],
            },
            { id: 'og', name: 'OG', tiles: [{ id: 'l1', type: 'switch', label: 'Licht', state: 'knx.0.OG.Licht', homekit: 'nonsense' }, { ...hk[0].tile, id: 'l2' }] },
        ],
    };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    assert.equal(saved.pages[1].tiles[0].homekit, 'light', 'unknown type -> first choice');
    assert.equal(saved.pages[1].tiles[1].hkId, 'own');
    assert.equal(syncs.length, 1);
    assert.deepEqual(
        syncs[0].map(d => [d.id, d.type, d.name]),
        [['sv-eg-l1', 'light', 'EG Licht'], ['sv-eg-b1', 'blind', 'Rollladen'], ['sv-og-l1', 'light', 'OG Licht'], ['own', 'light', 'Licht Bad']],
    );
    assert.equal(syncs[0][1].closed100, true);
    assert.equal((await api('homekit')).body.last.created, 4);

    // all ticks removed: an empty list, so homekit-easy removes SmartView's devices; after that nothing more
    await api('layout', { method: 'PUT', body: JSON.stringify({ ...layout, pages: [{ id: 'eg', name: 'EG', tiles: [] }] }) });
    assert.deepEqual(syncs[1], []);
    await api('layout', { method: 'PUT', body: JSON.stringify({ ...layout, pages: [{ id: 'eg', name: 'EG', tiles: [] }] }) });
    assert.equal(syncs.length, 2);

    // homekit-easy stopped: clear message, nothing lost
    adapter.foreign['system.adapter.homekit-easy.0.alive'] = { val: false, ack: true };
    adapter.hkCache = null;
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    assert.match((await api('homekit')).body.last.error, /läuft nicht/);
    assert.equal(syncs.length, 2);
});

test('adapter: homekit-easy takes over tiles ("Aus SmartView übernehmen"): tick set, saved, synced', async t => {
    const { adapter, api } = await startAdapter(t);
    adapter.objects['system.adapter.homekit-easy.0'] = { type: 'instance', common: { name: 'homekit-easy' } };
    adapter.foreign['system.adapter.homekit-easy.0.alive'] = { val: true, ack: true };
    const syncs = [];
    adapter.handlers = { 'homekit-easy.0': (command, message) => (syncs.push(message.devices), { ok: true, created: message.devices.length, updated: 0, removed: 0 }) };
    await api('layout', {
        method: 'PUT',
        body: JSON.stringify({
            pages: [
                {
                    id: 'eg',
                    name: 'EG',
                    tiles: [
                        { id: 'l1', type: 'switch', label: 'Licht', icon: 'bulb', state: 'knx.0.EG.Licht.Wohnzimmer' },
                        { id: 'w1', type: 'value', label: 'Temperatur', unit: '°C', state: 'knx.0.EG.Temp' },
                        { id: 'n1', type: 'switch', label: 'ohne Datenpunkt' },
                        { id: 'k1', type: 'link', label: 'Link', url: 'http://x' },
                    ],
                },
            ],
        }),
    });
    const ask = (from, command, message) =>
        new Promise(resolve => {
            const n = (adapter.sent || []).length;
            adapter.emit('message', { from: `system.adapter.${from}`, command, message, callback: { id: 7 } });
            const timer = setInterval(() => {
                const r = (adapter.sent || []).slice(n).find(x => x.command === command && x.instance === `system.adapter.${from}`);
                if (r) {
                    clearInterval(timer);
                    resolve(r.message);
                }
            }, 10);
        });
    const { tiles } = await ask('homekit-easy.0', 'tiles', {});
    assert.deepEqual(tiles.map(x => [x.tile, x.default, x.homekit]), [['l1', 'light', ''], ['w1', 'temperature', '']]);
    const r = await ask('homekit-easy.0', 'link', { tiles: [{ page: 'eg', tile: 'l1', homekit: 'outlet' }, { page: 'eg', tile: 'w1' }, { page: 'eg', tile: 'k1' }] });
    assert.deepEqual(r, { ok: true, linked: 2, created: 2, error: undefined });
    const saved = (await api('layout')).body.layout;
    assert.deepEqual(saved.pages[0].tiles.map(x => x.homekit || ''), ['outlet', 'temperature', '', '']);
    assert.deepEqual(syncs.at(-1).map(d => d.id), ['sv-eg-l1', 'sv-eg-w1']);
    // only homekit-easy may do this
    assert.match((await ask('javascript.0', 'link', { tiles: [] })).error, /not allowed/);
});

test('adapter: energy flow tile reads energie.N.live, day chart only for visible tiles', async t => {
    const { adapter, api } = await startAdapter(t);
    adapter.objects['system.adapter.energie.0'] = { type: 'instance', common: { name: 'energie' } };
    adapter.add('energie.0.live', { name: 'live', type: 'string', role: 'json' }, JSON.stringify({ s: { pv: 4200, house: 900 } }));
    adapter.handlers = { 'energie.0': (command, message) => ({ date: message.date || '2026-10-22', points: [{ t: 1, pv: 100, house: 50 }], dates: ['2026-10-22'] }) };
    assert.deepEqual((await api('energy')).body.instances, ['energie.0']);
    const layout = { pages: [{ id: 'pv', name: 'PV', tiles: [{ id: 'e1', type: 'energy', instance: 'energie.0', state: 'javascript.0.evil', show: 'stats', size: 'l' }] }] };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    assert.equal(saved.pages[0].tiles[0].state, 'energie.0.live', 'state always from the instance');
    assert.ok(adapter.subs.has('energie.0.live'));
    const day = (await api('energy/day?instance=energie.0&date=2026-10-21')).body;
    assert.equal(day.date, '2026-10-21');
    assert.equal((await api('energy/day?instance=energie.1')).status, 403);
});

test('adapter: push rules "länger als" and "und zusätzlich"', async t => {
    const { adapter, api, pushed } = await startAdapter(t);
    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'BOr8x', auth: 'a' } };
    await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub, name: 'iPhone' }) });
    const layout = {
        ...LAYOUT,
        push: [
            // window open longer than 0.005 min (300 ms) and the light on
            { id: 'r1', state: 'knx.0.EG.Fenster.Kueche', cond: 'true', delay: 0.005, and: { state: 'knx.0.EG.Licht.Kueche', cond: 'true' }, title: 'Fenster', text: 'Küche offen', channels: { app: true } },
        ],
    };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    assert.deepEqual([saved.push[0].delay, saved.push[0].and.state], [0.005, 'knx.0.EG.Licht.Kueche']);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    adapter.change('knx.0.EG.Licht.Kueche', false);
    adapter.change('knx.0.EG.Fenster.Kueche', false);
    await wait(100);
    pushed.length = 0;
    // open, but the light is off: nothing
    adapter.change('knx.0.EG.Fenster.Kueche', true);
    await wait(500);
    assert.equal(pushed.length, 0);
    // light on: both true now, but only after the delay
    adapter.change('knx.0.EG.Licht.Kueche', true);
    await wait(100);
    assert.equal(pushed.length, 0, 'not yet');
    await wait(400);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].body, 'Küche offen');
    // closed again before the delay is over: nothing
    adapter.change('knx.0.EG.Fenster.Kueche', false);
    await wait(50);
    adapter.change('knx.0.EG.Fenster.Kueche', true);
    await wait(100);
    adapter.change('knx.0.EG.Fenster.Kueche', false);
    await wait(500);
    assert.equal(pushed.length, 1);
});

test('adapter: awning retracts on wind/rain, stays locked, gate impulse', async t => {
    const { adapter, api, port } = await startAdapter(t, {}, a => {
        a.add('0_userdata.0.Regen', { name: 'Regen', type: 'boolean', role: 'sensor.rain', write: false }, false);
        a.add('knx.0.Tor.Taster', { name: 'Tor', type: 'boolean', role: 'button', write: true }, false);
        a.add('knx.0.Tor.Zu', { name: 'Tor zu', type: 'boolean', role: 'sensor', write: false }, true);
    });
    const layout = {
        pages: [
            {
                id: 'aussen',
                name: 'Außen',
                tiles: [
                    // wind as speed (m/s), alarm from 10; locked 1 s after the alarm
                    { id: 'mk', type: 'blind', kind: 'awning', label: 'Markise', state: 'knx.0.EG.Rollladen.Wohnzimmer', windAlarm: '0_userdata.0.Wetter.Wind', windMin: 10, rainAlarm: '0_userdata.0.Regen', protect: 'up', lockTime: 1, lockUnit: 's' },
                    { id: 'tor', type: 'gate', label: 'Tor', gateMode: 'single', single: 'impulse', state: 'knx.0.Tor.Taster', posClosed: 'knx.0.Tor.Zu' },
                ],
            },
        ],
    };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    assert.deepEqual([saved.pages[0].tiles[0].kind, saved.pages[0].tiles[0].windMin, saved.pages[0].tiles[1].single], ['awning', 10, 'impulse']);
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    adapter.writes.length = 0;

    // rain: drives to "up" (open = retracted) and locks
    adapter.change('0_userdata.0.Regen', true);
    await until(() => adapter.writes.some(w => w[0] === 'knx.0.EG.Rollladen.Wohnzimmer'));
    assert.deepEqual(adapter.writes.find(w => w[0] === 'knx.0.EG.Rollladen.Wohnzimmer'), ['knx.0.EG.Rollladen.Wohnzimmer', 100, false]);
    await until(() => c.msgs.some(m => m.type === 'locks' && m.locks['aussen/mk']));
    assert.equal(c.msgs.filter(m => m.type === 'locks').pop().locks['aussen/mk'].reason, 'Regenalarm');
    // the page cannot move it now
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Rollladen.Wohnzimmer', val: 0 }));
    await until(() => c.msgs.some(m => m.type === 'error' && /Gesperrt \(Regenalarm/.test(m.text)));
    // wind on top: no second drive; rain gone: wind still locks
    adapter.change('0_userdata.0.Wetter.Wind', 14);
    adapter.change('0_userdata.0.Regen', false);
    await until(() => c.msgs.filter(m => m.type === 'locks').pop().locks['aussen/mk'].reason === 'Windalarm');
    assert.equal(adapter.writes.filter(w => w[0] === 'knx.0.EG.Rollladen.Wohnzimmer').length, 1);
    // wind gone: locked another second, then free
    adapter.change('0_userdata.0.Wetter.Wind', 3);
    await until(() => (c.msgs.filter(m => m.type === 'locks').pop().locks['aussen/mk'] || {}).left > 0);
    await until(() => !c.msgs.filter(m => m.type === 'locks').pop().locks['aussen/mk'], 3000);
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Rollladen.Wohnzimmer', val: 0 }));
    await until(() => adapter.writes.some(w => w[0] === 'knx.0.EG.Rollladen.Wohnzimmer' && w[1] === 0));

    // gate impulse: true, false after the pulse
    c.ws.send(JSON.stringify({ type: 'pulse', id: 'knx.0.Tor.Taster', ms: 200 }));
    await until(() => adapter.writes.filter(w => w[0] === 'knx.0.Tor.Taster').length === 2, 2000);
    assert.deepEqual(adapter.writes.filter(w => w[0] === 'knx.0.Tor.Taster').map(w => w[1]), [true, false]);
});

test('adapter: PIN protected tiles - hash only on the server, every command checked, wrong PINs locked, time switch only with PIN', async t => {
    const { adapter, port, api } = await startAdapter(t);
    const layout = {
        pages: [{ id: 'a', name: 'A', tiles: [
            { id: 'door', type: 'switch', label: 'Türöffner', state: 'knx.0.EG.Licht.Wohnzimmer', pin: '4711' },
            { id: 'free', type: 'dimmer', label: 'Essen', state: 'knx.0.EG.Licht.Essen_Dimmer' },
        ] }],
    };
    const saved = await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    assert.equal(saved.body.pages[0].tiles[0].pin, true);
    assert.equal(saved.body.pages[0].tiles[0].pinHash, undefined, 'the hash never leaves the server');
    assert.match(adapter.store.layout.pages[0].tiles[0].pinHash, /^s1\$/);
    const got = await api('layout');
    assert.ok(!JSON.stringify(got.body).includes('pinHash') && !JSON.stringify(got.body).includes('4711'));
    // saving again with pin: true keeps the PIN
    await api('layout', { method: 'PUT', body: JSON.stringify(got.body.layout) });
    assert.match(adapter.store.layout.pages[0].tiles[0].pinHash, /^s1\$/);
    // time switch on a PIN tile: only saved with the right PIN; it then fires without one - until the PIN changes
    const timer = { entries: [{ days: [1, 2, 3, 4, 5, 6, 7], at: 'time', time: '07:00', action: 'on' }] };
    const noPin = await api('timers/a/door', { method: 'PUT', body: JSON.stringify(timer) });
    assert.equal(noPin.status, 403);
    assert.equal(noPin.body.pin, 'need');
    assert.equal((await api('timers/a/door', { method: 'PUT', body: JSON.stringify({ ...timer, pin: '9999' }) })).body.pin, 'wrong');
    assert.equal((await api('timers/a/door', { method: 'PUT', body: JSON.stringify({ ...timer, pin: '4711' }) })).status, 200);
    const stored = adapter.timers.list()['a/door'];
    assert.match(stored.pinSig, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(stored).includes('4711'), 'the PIN itself is not stored');
    const door = adapter.store.layout.pages[0].tiles[0];
    let w0 = adapter.writes.length;
    await adapter.fireTimer(door, 'on', undefined, stored.entries[0], 'a/door');
    assert.equal(adapter.writes.length, w0 + 1, 'saved with the PIN: fires');
    const changed = (await api('layout')).body.layout;
    changed.pages[0].tiles[0].pin = '5555';
    await api('layout', { method: 'PUT', body: JSON.stringify(changed) });
    w0 = adapter.writes.length;
    await adapter.fireTimer(adapter.store.layout.pages[0].tiles[0], 'on', undefined, stored.entries[0], 'a/door');
    assert.equal(adapter.writes.length, w0, 'after a PIN change the old time switch does not fire');
    changed.pages[0].tiles[0].pin = '4711';
    await api('layout', { method: 'PUT', body: JSON.stringify(changed) });

    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    assert.deepEqual(c.msgs.find(m => m.type === 'init').pinIds, ['knx.0.EG.Licht.Wohnzimmer']);
    const n = adapter.writes.length;
    const pin = () => c.msgs.filter(m => m.type === 'pin');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: true }));
    await until(() => pin().length === 1);
    assert.equal(pin()[0].result, 'need');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: true, pin: '1234' }));
    await until(() => pin().length === 2);
    assert.equal(pin()[1].result, 'wrong');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Essen_Dimmer', val: 30 }));
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: true, pin: '4711' }));
    await until(() => adapter.writes.length === n + 2);
    assert.deepEqual(adapter.writes.slice(n).map(w => w[0]).sort(), ['knx.0.EG.Licht.Essen_Dimmer', 'knx.0.EG.Licht.Wohnzimmer']);
    // 5 wrong PINs lock the address, then even the right one is refused for a while
    for (let i = 0; i < 5; i++) {
        c.ws.send(JSON.stringify({ type: 'pulse', id: 'knx.0.EG.Licht.Wohnzimmer', pin: '0000' }));
    }
    await until(() => pin().length === 7);
    assert.equal(pin()[6].result, 'locked');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: false, pin: '4711' }));
    await until(() => pin().length === 8);
    assert.equal(pin()[7].result, 'locked');
    assert.equal(adapter.writes.length, n + 2);
});

test('adapter: alarm tile filled from a NOX area; window tile messages (too long open, warning while raining)', async t => {
    const { adapter, api, pushed } = await startAdapter(t, {}, a => {
        for (const id of ['test.0.k1', 'test.0.k2', 'test.0.regen']) {
            a.add(id, { name: id, type: 'boolean', role: 'sensor.window' }, false);
        }
    });
    adapter.push.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }, 'iPhone');
    const layout = { pages: [{ id: 'a', name: 'A', tiles: [
        { id: 'al', type: 'alarm', area: 'nox_alarmzentrale.0.areas.1' },
        { id: 'w', type: 'windows', label: 'Fenster', notify: true, warnMin: 1, warnWhen: 'test.0.regen', warnText: 'Regen!',
            windows: [{ label: 'links', group: 'Küche', state: 'test.0.k1' }, { label: 'Bad', state: 'test.0.k2' }] },
    ] }] };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    const al = saved.pages[0].tiles[0];
    assert.deepEqual([al.status, al.command, al.alarm, al.error, al.valueOff, al.valueArm],
        ['nox_alarmzentrale.0.areas.1.state', 'nox_alarmzentrale.0.areas.1.setState', 'nox_alarmzentrale.0.areas.1.alarm', 'nox_alarmzentrale.0.areas.1.error', '1', '5']);
    // raining, then a window opens -> one message
    adapter.change('test.0.regen', true);
    adapter.change('test.0.k1', true);
    await until(() => pushed.length === 1);
    assert.equal(pushed[0].title, 'Fenster: Regen!');
    assert.equal(pushed[0].body, 'Offen: Küche (links offen)');
    adapter.change('test.0.k2', true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(pushed.length, 1, 'only once while it stays true');
    // open longer than warnMin: the state's last change lies back
    adapter.foreign['test.0.k2'].lc = Date.now() - 2 * 60000;
    adapter.change('test.0.k2', true);
    adapter.liveStates.get('test.0.k2').lc = Date.now() - 2 * 60000;
    adapter.checkWindows();
    await until(() => pushed.length === 2);
    assert.equal(pushed[1].title, 'Fenster: zu lange offen');
    assert.equal(pushed[1].body, 'Bad offen seit mehr als 1 Min.');
    adapter.checkWindows();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pushed.length, 2, 'once per opening');
});

test('adapter: alarm tile detectors are taken from the NOX / SPC adapter when saving', async t => {
    const { api } = await startAdapter(t, {}, a => {
        const add = (id, name, area) => {
            a.objects[id] = { type: 'channel', common: { name } };
            a.add(`${id}.area`, { name: 'Bereich', type: 'number', role: 'value' }, area);
            a.add(`${id}.open`, { name: 'offen', type: 'boolean', role: 'sensor' }, false);
        };
        add('nox_alarmzentrale.0.inputs.10021', 'MK Wohnzimmer 1', 1);
        add('nox_alarmzentrale.0.inputs.10020', 'MK Haustüre', 1);
        add('nox_alarmzentrale.0.inputs.10059', 'MK Tor', 2);
        add('spc-edp.0.zones.3', 'Büro', 1);
    });
    const layout = { pages: [{ id: 'a', name: 'A', tiles: [
        { id: 'al', type: 'alarm', area: 'nox_alarmzentrale.0.areas.1', control: true, showDetectors: true, areas: [{ label: 'Büro', area: 'spc-edp.0.areas.1' }] },
        { id: 'al2', type: 'alarm', area: 'nox_alarmzentrale.0.areas.2' },
    ] }] };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body;
    const [al, al2] = saved.pages[0].tiles;
    assert.deepEqual(al.detectors.map(d => [d.label, d.deact]), [
        ['MK Haustüre', 'nox_alarmzentrale.0.inputs.10020.deactivated'],
        ['MK Wohnzimmer 1', 'nox_alarmzentrale.0.inputs.10021.deactivated'],
    ]);
    assert.deepEqual(al.areas[0].detectors, [{ label: 'Büro', open: 'spc-edp.0.zones.3.open', deact: '' }], 'SPC: display only');
    assert.equal(al2.detectors, undefined, 'only with "Melder anzeigen"');
});

test('adapter: dehumidifier automatic - on at the mean humidity of the rooms, off at the lower value, manual in between', async t => {
    const { adapter, api } = await startAdapter(t, {}, a => {
        a.add('tuya.0.ent.power', { name: 'Entfeuchter', type: 'boolean', role: 'switch', write: true }, false);
        a.add('hum.0.keller', { name: 'Feuchte Keller', type: 'number', role: 'value.humidity', unit: '%' }, 60);
        a.add('hum.0.waschraum', { name: 'Feuchte Waschraum', type: 'number', role: 'value.humidity', unit: '%' }, 62);
    });
    const tile = { id: 'ent', type: 'climate', label: 'Entfeuchter', state: 'tuya.0.ent.power', auto: true, autoOn: 65, autoOff: 55,
        sensors: [{ label: 'Keller', humidity: 'hum.0.keller' }, { label: 'Waschraum', humidity: 'hum.0.waschraum' }] };
    await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'k', name: 'Keller', tiles: [tile] }] }) });
    await new Promise(r => setTimeout(r, 200));
    adapter.writes.length = 0;
    const power = () => adapter.writes.filter(w => w[0] === 'tuya.0.ent.power').map(w => w[1]);
    adapter.change('hum.0.waschraum', 72); // mean 66
    await until(() => power().length === 1);
    assert.deepEqual(power(), [true]);
    await new Promise(r => setTimeout(r, 100)); // the device confirms (fake ack after 50 ms)
    // still above 55: switched off by hand stays off
    adapter.change('hum.0.waschraum', 64); // mean 62
    adapter.change('tuya.0.ent.power', false);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(power(), [true]);
    // up again over 65 -> on, down to 55 -> off
    adapter.change('hum.0.keller', 70); // mean 67
    await until(() => power().length === 2);
    await new Promise(r => setTimeout(r, 100));
    adapter.change('hum.0.keller', 50);
    adapter.change('hum.0.waschraum', 58); // mean 54
    await until(() => power().length === 3);
    assert.deepEqual(power(), [true, true, false]);
});

test('adapter: "Haus verlassen" / "Ankommen" run in the adapter - one PIN, delay, arriving cancels, trigger from ioBroker, alarm check', async t => {
    const A = 'nox_alarmzentrale.0.areas.1';
    const { adapter, api, port } = await startAdapter(t, {}, a => {
        a.add(`${A}.state`, { name: 'Zustand', type: 'number', role: 'value', states: { 1: 'Unscharf', 5: 'Scharf' } }, 1);
        a.add(`${A}.setState`, { name: 'setzen', type: 'number', role: 'level', write: true }, 1);
    });
    adapter.sceneMinute = 300; // "minutes" of 300 ms
    adapter.sceneCheckMs = 200;
    adapter.ackDelay = null; // the alarm system does not confirm -> "nicht scharf"
    const warns = [];
    adapter.log = { ...adapter.log, warn: m => warns.push(m), info() {} };
    const layout = { pages: [{ id: 'u', name: 'Übersicht', tiles: [
        { id: 'l1', type: 'switch', label: 'Küche', state: 'knx.0.EG.Licht.Kueche' },
        { id: 'r1', type: 'blind', label: 'Rollo', state: 'knx.0.EG.Rollladen.Wohnzimmer' },
        { id: 'al', type: 'alarm', label: 'Alarm', area: A, control: true, pin: '2580' },
        { id: 'go', type: 'leave', label: 'Weg', lightsOff: true, blindsDown: true, alarmArm: 'al', delayMin: 1, notify: true, external: true },
        { id: 'home', type: 'arrive', label: 'Da', alarmOff: 'al', lights: ['l1'], external: true },
    ] }] };
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    await until(() => adapter.objects['smartview.0.scenes.u_go'] && adapter.objects['smartview.0.scenes.u_home']);
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    adapter.writes.length = 0;
    // the alarm needs its PIN, asked once for the whole button
    c.ws.send(JSON.stringify({ type: 'scene', page: 'u', tile: 'go' }));
    await until(() => c.msgs.some(m => m.type === 'pin' && m.scene === 'u/go' && m.result === 'need'));
    assert.equal(adapter.writes.length, 0);
    c.ws.send(JSON.stringify({ type: 'scene', page: 'u', tile: 'go', pin: '2580' }));
    await until(() => c.msgs.some(m => m.type === 'scene' && m.key === 'u/go'));
    assert.equal(c.msgs.find(m => m.type === 'scene').delayed, 1);
    assert.deepEqual(adapter.writes.map(w => w[0]), ['knx.0.EG.Licht.Kueche'], 'light at once, blinds + alarm later');
    await until(() => adapter.writes.length === 3);
    assert.deepEqual(adapter.writes.slice(1).map(w => [w[0], w[1]]).sort(), [['knx.0.EG.Rollladen.Wohnzimmer', 0], [`${A}.setState`, 5]]);
    // armed? the alarm system did not confirm -> warning
    await until(() => warns.some(w => /Weg: Alarmanlage NICHT scharf - Alarm/.test(w)));
    // leave again, then arrive before the delay is over: blinds/alarm never come
    adapter.writes.length = 0;
    adapter.change(`${A}.state`, 1);
    adapter.foreign['smartview.0.scenes.u_go'] = { val: true, ack: false, from: 'system.adapter.javascript.0' };
    adapter.emit('stateChange', 'smartview.0.scenes.u_go', adapter.foreign['smartview.0.scenes.u_go']);
    await until(() => adapter.foreign['smartview.0.scenes.u_go'].ack === true);
    adapter.emit('stateChange', 'smartview.0.scenes.u_home', { val: true, ack: false });
    await new Promise(r => setTimeout(r, 500));
    assert.ok(!adapter.writes.some(w => w[0] === 'knx.0.EG.Rollladen.Wohnzimmer'), 'arriving cancelled the delayed blinds');
    assert.ok(adapter.writes.some(w => w[0] === 'knx.0.EG.Licht.Kueche' && w[1] === true), 'arrive switches the chosen light on');
});

test('adapter: fire alarm tile (FC20) - filled from the instance, detectors with mode, commands only with "Schalten erlauben"', async t => {
    const F = 'fc20-cerberus-bacnet.0';
    const { adapter, api, port } = await startAdapter(t, {}, a => {
        a.objects[`system.adapter.${F}`] = { type: 'instance', common: { name: 'fc20-cerberus-bacnet' } };
        for (const [k, v] of [['summary.alarm', false], ['summary.alarmList', ''], ['summary.preAlarm', false], ['summary.fault', true], ['summary.faultList', 'Stich 21'],
            ['summary.disabled', false], ['summary.disabledList', ''], ['summary.lastMessage', 'Störung Stich 21'], ['info.connection', true]]) {
            a.add(`${F}.${k}`, { name: k, type: typeof v === 'boolean' ? 'boolean' : 'string', role: 'indicator' }, v);
        }
        a.add(`${F}.panel.reset`, { name: 'Rücksetzen', type: 'boolean', role: 'button', write: true });
        a.add(`${F}.panel.silence`, { name: 'Akustik ab', type: 'boolean', role: 'button', write: true });
        for (const [id, name] of [['m_02', 'Küche'], ['m_01', 'Büro']]) {
            const b = `${F}.objects.melder.${id}`;
            a.objects[b] = { type: 'channel', common: { name } };
            a.add(`${b}.state`, { name: 'Zustand', type: 'string', role: 'text' }, 'Ruhe');
            a.add(`${b}.alarm`, { name: 'Alarm', type: 'boolean', role: 'indicator.alarm.fire' }, false);
            a.add(`${b}.fault`, { name: 'Störung', type: 'boolean', role: 'indicator' }, false);
            a.add(`${b}.disabled`, { name: 'Abgeschaltet', type: 'boolean', role: 'indicator' }, false);
            a.add(`${b}.mode`, { name: 'Betriebsart', type: 'number', role: 'level.mode', write: true, states: { 11: 'Eingeschaltet', 12: 'Abgeschaltet' } }, 11);
        }
    });
    assert.deepEqual((await api('energy')).body.fc20, [F]);
    const tile = { id: 'bma', type: 'fire', label: 'BMA', panel: F, showDetectors: true };
    let saved = (await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'b', name: 'Brand', tiles: [tile] }] }) })).body.pages[0].tiles[0];
    assert.equal(saved.faultText, `${F}.summary.faultList`);
    assert.deepEqual(saved.detectors.map(d => d.label), ['Büro', 'Küche'], 'sorted by name');
    assert.equal(saved.detectors[0].mode, `${F}.objects.melder.m_01.mode`);
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    // display only: nothing writable
    assert.deepEqual(c.msgs.find(m => m.type === 'init').writable, []);
    c.ws.send(JSON.stringify({ type: 'set', id: `${F}.panel.reset`, val: true }));
    await until(() => c.msgs.some(m => m.type === 'error' && /Nicht freigegeben/.test(m.text)));
    // with "Schalten erlauben": reset, silence and the detector modes
    saved = (await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'b', name: 'Brand', tiles: [{ ...tile, control: true }] }] }) })).body.pages[0].tiles[0];
    const c2 = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c2.ws.close());
    await c2.open;
    await until(() => c2.msgs.some(m => m.type === 'init'));
    assert.deepEqual(c2.msgs.find(m => m.type === 'init').writable.sort(), [`${F}.objects.melder.m_01.mode`, `${F}.objects.melder.m_02.mode`, `${F}.panel.reset`, `${F}.panel.silence`]);
    c2.ws.send(JSON.stringify({ type: 'set', id: `${F}.objects.melder.m_02.mode`, val: 12 }));
    await until(() => adapter.writes.some(w => w[0] === `${F}.objects.melder.m_02.mode` && w[1] === 12));
});

test('adapter: "Haus verlassen" - only chosen lights / blinds, extra data points of ioBroker (light, blind, other)', async t => {
    const { adapter, api, port } = await startAdapter(t, {}, a => {
        a.add('knx.0.Garten.Licht', { name: 'Gartenlicht', type: 'boolean', role: 'switch', write: true }, true);
        a.add('knx.0.Garage.Rollo', { name: 'Garagenrollo', type: 'boolean', role: 'switch', write: true }, false);
        a.add('0_userdata.0.Anwesend', { name: 'Anwesend', type: 'boolean', role: 'state', write: true }, true);
        a.add('knx.0.OG.Rollo', { name: 'Rollo OG', type: 'number', role: 'level.blind', write: true }, 100);
    });
    const layout = { pages: [{ id: 'u', name: 'Übersicht', tiles: [
        { id: 'l1', type: 'switch', label: 'Küche', state: 'knx.0.EG.Licht.Kueche' },
        { id: 'd1', type: 'dimmer', label: 'Essen', state: 'knx.0.EG.Licht.Essen_Dimmer' },
        { id: 'r1', type: 'blind', label: 'Wohnzimmer', state: 'knx.0.EG.Rollladen.Wohnzimmer' },
        { id: 'r2', type: 'blind', label: 'OG', state: 'knx.0.OG.Rollo' },
        { id: 'go', type: 'leave', label: 'Weg', lightsOff: true, lightTiles: ['l1'], blindsDown: true, blindTiles: ['r2'], extra: [
            { label: 'Garten', state: 'knx.0.Garten.Licht', group: 'light' },
            { label: 'Garage', state: 'knx.0.Garage.Rollo', group: 'blind' },
            { label: 'Anwesenheit', state: '0_userdata.0.Anwesend', value: 'false', group: 'other' },
        ] },
    ] }] };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body.pages[0].tiles[4];
    assert.deepEqual(saved.extra.map(e => e.group), ['light', 'blind', 'other']);
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    // the extra data points are not writable from the page itself
    assert.ok(!c.msgs.find(m => m.type === 'init').writable.includes('0_userdata.0.Anwesend'));
    adapter.writes.length = 0;
    c.ws.send(JSON.stringify({ type: 'scene', page: 'u', tile: 'go' }));
    await until(() => c.msgs.some(m => m.type === 'scene'));
    await until(() => adapter.writes.length >= 5);
    assert.deepEqual(adapter.writes.map(w => [w[0], w[1]]).sort(), [
        ['0_userdata.0.Anwesend', false],
        ['knx.0.EG.Licht.Kueche', false],
        ['knx.0.Garage.Rollo', true],
        ['knx.0.Garten.Licht', false],
        ['knx.0.OG.Rollo', 0],
    ], 'dimmer and the other blind are not chosen');
});

test('adapter: gate closes automatically after the time open - only with the safety tick, waits for the light barrier', async t => {
    const { adapter, api } = await startAdapter(t, {}, a => {
        a.add('knx.0.Garage.Zu', { name: 'Garage Zu', type: 'boolean', role: 'button', write: true }, false);
        a.add('knx.0.Garage.Auf', { name: 'Garage Auf', type: 'boolean', role: 'button', write: true }, false);
        a.add('knx.0.Garage.EndlageZu', { name: 'Endlage zu', type: 'boolean', role: 'sensor' }, true);
        a.add('knx.0.Garage.Lichtschranke', { name: 'Lichtschranke', type: 'boolean', role: 'sensor' }, false);
    });
    adapter.gateMinute = 100;
    adapter.gateCheckMs = 100;
    const gate = { id: 'g', type: 'gate', label: 'Garage', open: 'knx.0.Garage.Auf', close: 'knx.0.Garage.Zu', posClosed: 'knx.0.Garage.EndlageZu', autoClose: 2 };
    const save = tile => api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'a', name: 'Außen', tiles: [tile] }] }) });
    const closes = () => adapter.writes.filter(w => w[0] === 'knx.0.Garage.Zu' && w[1] === true).length;
    // without "Lichtschranke vorhanden" nothing happens
    await save(gate);
    adapter.change('knx.0.Garage.EndlageZu', false);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(closes(), 0);
    // with the tick: after 2 "minutes" open, but the light barrier is interrupted -> waits
    adapter.change('knx.0.Garage.EndlageZu', true);
    await save({ ...gate, autoSafe: true, barrier: 'knx.0.Garage.Lichtschranke' });
    await new Promise(r => setTimeout(r, 100));
    adapter.change('knx.0.Garage.Lichtschranke', true);
    adapter.change('knx.0.Garage.EndlageZu', false);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(closes(), 0, 'light barrier interrupted');
    adapter.change('knx.0.Garage.Lichtschranke', false);
    await until(() => closes() === 1);
    // closed: nothing more
    adapter.change('knx.0.Garage.EndlageZu', true);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(closes(), 1);
});

test('adapter: a link on another page writes the original\'s data points and needs its PIN', async t => {
    const { api, port } = await startAdapter(t);
    const layout = { pages: [
        { id: 'u', name: 'Übersicht', tiles: [{ id: 'd', type: 'switch', label: 'Tür', state: 'knx.0.EG.Licht.Kueche', pin: '4711' }] },
        { id: 'p', name: 'Plan', tiles: [{ id: 'r', type: 'ref', ref: 'u/d' }] },
    ] };
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    const init = c.msgs.find(m => m.type === 'init');
    assert.ok(init.writable.includes('knx.0.EG.Licht.Kueche'));
    assert.ok(init.pinIds.includes('knx.0.EG.Licht.Kueche'), 'the PIN of the original applies');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Kueche', val: false }));
    await until(() => c.msgs.some(m => m.type === 'pin' && m.result === 'need'));
});

test('adapter: do not disturb - switch from the menu / ioBroker, time window, no doorbell messages when chosen', async t => {
    const { adapter, api, port } = await startAdapter(t);
    const now = new Date();
    const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    assert.equal(c.msgs.find(m => m.type === 'init').dnd.on, false);
    // from the menu
    c.ws.send(JSON.stringify({ type: 'dnd', on: true }));
    await until(() => c.msgs.some(m => m.type === 'dnd' && m.dnd.on && m.dnd.manual));
    assert.equal(adapter.foreign['smartview.0.ring.dnd'].val, true);
    assert.equal(adapter.foreign['smartview.0.ring.dndActive'].val, true);
    // from ioBroker (e.g. a logik program)
    adapter.emit('stateChange', 'smartview.0.ring.dnd', { val: false, ack: false });
    await until(() => c.msgs.filter(m => m.type === 'dnd').pop().dnd.on === false);
    // time window around now (also over midnight works the same way)
    const from = new Date(now.getTime() - 3600000);
    const to = new Date(now.getTime() + 3600000);
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 's', name: 'S', tiles: [] }], ring: { state: '0_userdata.0.Klingel', dndFrom: hm(from), dndTo: hm(to), dndQuiet: true } }) })).body;
    assert.deepEqual([saved.ring.dndFrom, saved.ring.dndQuiet], [hm(from), true]);
    await until(() => c.msgs.filter(m => m.type === 'dnd').pop().dnd.window === true);
    assert.equal(adapter.dndInfo().on, true);
    assert.equal(adapter.dndInfo().manual, false);
});

test('adapter: /api/ring for the monitor wake-up helper (ringing, do not disturb, access key)', async t => {
    const { adapter, api, base } = await startAdapter(t, { accessKey: 'geheim' });
    const key = { headers: { Cookie: '' } };
    assert.equal((await fetch(base + 'api/ring')).status, 403);
    await fetch(base + 'api/layout?key=geheim', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages: [{ id: 's', name: 'S', tiles: [] }], ring: { state: '0_userdata.0.Klingel' } }) });
    const ring = async () => (await (await fetch(base + 'api/ring?key=geheim', key)).json());
    assert.deepEqual(await ring(), { ringing: false, dnd: false });
    adapter.emit('stateChange', '0_userdata.0.Klingel', { val: true, ack: true, ts: Date.now(), lc: Date.now() });
    await until(async () => (await ring()).ringing === true);
    adapter.emit('stateChange', 'smartview.0.ring.dnd', { val: true, ack: false });
    await until(async () => (await ring()).dnd === true);
    adapter.emit('stateChange', '0_userdata.0.Klingel', { val: false, ack: true, ts: Date.now(), lc: Date.now() });
    await until(async () => (await ring()).ringing === false);
    void api;
});

test('adapter: household appliances - Shelly power and Home Connect status, Fertig message, tap = seen, kept over restarts', async t => {
    const { adapter, api, port, pushed } = await startAdapter(t, {}, a => {
        a.add('shelly.0.Trockner.Power', { name: 'Trockner Leistung', type: 'number', role: 'value.power', unit: 'W' }, 1.2);
        a.add('homeconnect.0.SIEMENS-SN1.status.BSH_Common_Status_OperationState', { name: 'Betriebszustand', type: 'string', role: 'value' }, 'BSH.Common.EnumType.OperationState.Ready');
    });
    adapter.appSec = 10; // one "second" = 10 ms: start after 600 ms above the threshold
    await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/app', keys: { p256dh: 'p', auth: 'a' } }, name: 'iPhone' }) });
    const tile = {
        id: 'hg', type: 'appliances', label: 'Geräte', notify: true, devices: [
            { label: 'Trockner', icon: 'dryer', kind: 'power', state: 'shelly.0.Trockner.Power', onW: 20, offMin: 0.2 },
            { label: 'Geschirrspüler', icon: 'dishwasher', kind: 'state', state: 'homeconnect.0.SIEMENS-SN1.status.BSH_Common_Status_OperationState' },
        ],
    };
    await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'k', name: 'Küche', tiles: [tile] }] }) });
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    const status = () => adapter.appStatus();
    await until(() => status()['k/hg/0'] && status()['k/hg/0'].status === 'off');
    // dryer: a short anti-crease turn does not count, a real run does
    adapter.change('shelly.0.Trockner.Power', 300);
    await new Promise(r => setTimeout(r, 100));
    adapter.change('shelly.0.Trockner.Power', 2);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(status()['k/hg/0'].status, 'off');
    adapter.change('shelly.0.Trockner.Power', 2100);
    await new Promise(r => setTimeout(r, 650));
    adapter.change('shelly.0.Trockner.Power', 2050);
    await until(() => status()['k/hg/0'].status === 'run');
    await until(() => c.msgs.some(m => m.type === 'apps' && m.apps['k/hg/0'].status === 'run'));
    // below the threshold for offMin -> Fertig + message
    adapter.change('shelly.0.Trockner.Power', 1.5);
    await new Promise(r => setTimeout(r, 150));
    adapter.change('shelly.0.Trockner.Power', 1.4);
    await until(() => status()['k/hg/0'].status === 'done');
    await until(() => pushed.some(p => p.title === 'Trockner ist fertig'));
    // tap = seen
    c.ws.send(JSON.stringify({ type: 'appAck', key: 'k/hg/0' }));
    await until(() => status()['k/hg/0'].status === 'off');
    // dishwasher: Run -> Finished = Fertig + message; door opened (Ready) = Aus; cancelled (Run -> Ready) = no message
    const op = 'homeconnect.0.SIEMENS-SN1.status.BSH_Common_Status_OperationState';
    adapter.change(op, 'BSH.Common.EnumType.OperationState.Run');
    await until(() => status()['k/hg/1'].status === 'run');
    adapter.change(op, 'BSH.Common.EnumType.OperationState.Finished');
    await until(() => pushed.some(p => p.title === 'Geschirrspüler ist fertig'));
    assert.equal(status()['k/hg/1'].status, 'done');
    adapter.change(op, 'BSH.Common.EnumType.OperationState.Ready');
    await until(() => status()['k/hg/1'].status === 'off');
    adapter.change(op, 'BSH.Common.EnumType.OperationState.Run');
    await until(() => status()['k/hg/1'].status === 'run');
    adapter.change(op, 'BSH.Common.EnumType.OperationState.Ready');
    await until(() => status()['k/hg/1'].status === 'off');
    assert.equal(pushed.filter(p => p.title === 'Geschirrspüler ist fertig').length, 1);
    // the two messages do not replace each other on the phone
    const tags = pushed.filter(p => / ist fertig$/.test(p.title)).map(p => p.tag);
    assert.notEqual(tags[0], tags[1]);
});

test('adapter: "Haus verlassen" with an own alarm delay and a message when the alarm system is armed', async t => {
    const A = 'nox_alarmzentrale.0.areas.1';
    const { adapter, api, port, pushed } = await startAdapter(t, {}, a => {
        a.add(`${A}.state`, { name: 'Zustand', type: 'number', role: 'value', states: { 1: 'Unscharf', 5: 'Scharf' } }, 1);
        a.add(`${A}.setState`, { name: 'setzen', type: 'number', role: 'level', write: true }, 1);
    });
    adapter.sceneMinute = 300;
    adapter.sceneCheckMs = 200;
    await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/al', keys: { p256dh: 'p', auth: 'a' } }, name: 'iPhone' }) });
    const layout = { pages: [{ id: 'u', name: 'Übersicht', tiles: [
        { id: 'r1', type: 'blind', label: 'Rollo', state: 'knx.0.EG.Rollladen.Wohnzimmer' },
        { id: 'al', type: 'alarm', label: 'Alarm', area: A, control: true },
        { id: 'go', type: 'leave', label: 'Weg', blindsDown: true, alarmArm: 'al', delayMin: 0, alarmDelayMin: 2, alarmNotify: true },
    ] }] };
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    adapter.writes.length = 0;
    const t0 = Date.now();
    c.ws.send(JSON.stringify({ type: 'scene', page: 'u', tile: 'go' }));
    await until(() => c.msgs.some(m => m.type === 'scene' && m.key === 'u/go'));
    assert.deepEqual(adapter.writes.map(w => w[0]), ['knx.0.EG.Rollladen.Wohnzimmer'], 'blinds at once, alarm later');
    await until(() => adapter.writes.some(w => w[0] === `${A}.setState`));
    assert.ok(Date.now() - t0 >= 550, 'alarm after its own 2 "minutes"');
    adapter.change(`${A}.state`, 5); // the panel confirms
    await until(() => pushed.some(p => p.title === 'Weg: Alarmanlage scharf ✓'));
});

test('adapter: messages for burglar alarm (per area, armed / disarmed) and fire alarm / pre-alarm / fault', async t => {
    const N = 'nox_alarmzentrale.0.areas.';
    const F = 'fc20-cerberus-bacnet.0.summary.';
    const { adapter, api, pushed } = await startAdapter(t, {}, a => {
        for (const i of [1, 2]) {
            a.add(`${N}${i}.state`, { name: 'Zustand', type: 'number', role: 'value' }, 1);
            a.add(`${N}${i}.alarm`, { name: 'Alarm', type: 'boolean', role: 'indicator.alarm' }, false);
            a.add(`${N}${i}.alarmInputs`, { name: 'Melder', type: 'string', role: 'text' }, '');
        }
        for (const k of ['alarm', 'preAlarm', 'fault']) a.add(F + k, { name: k, type: 'boolean', role: 'indicator' }, false);
        for (const k of ['alarmText', 'faultText']) a.add(F + k, { name: k, type: 'string', role: 'text' }, '');
    });
    adapter.alarmTextWait = 50;
    await api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/alarm', keys: { p256dh: 'p', auth: 'a' } }, name: 'iPhone' }) });
    const alarm = {
        id: 'al', type: 'alarm', label: 'Alarm', areaLabel: 'Haus', status: `${N}1.state`, alarm: `${N}1.alarm`, alarmText: `${N}1.alarmInputs`, valueOff: 1, valueArm: 5,
        notify: true, notifyMode: true,
        areas: [{ label: 'Garage', status: `${N}2.state`, alarm: `${N}2.alarm`, alarmText: `${N}2.alarmInputs`, valueOff: 1, valueArm: 5 }],
    };
    const fire = { id: 'bma', type: 'fire', label: 'BMA', alarm: F + 'alarm', alarmText: F + 'alarmText', preAlarm: F + 'preAlarm', fault: F + 'fault', faultText: F + 'faultText', notify: true };
    await api('layout', { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'u', name: 'Übersicht', tiles: [alarm, fire] }] }) });
    await new Promise(r => setTimeout(r, 200));
    const titles = () => pushed.map(p => p.title);
    adapter.change(`${N}2.state`, 5);
    await until(() => titles().includes('Garage: scharf'));
    adapter.change(`${N}2.alarm`, true);
    adapter.change(`${N}2.alarmInputs`, 'BWM Garage');
    await until(() => pushed.some(p => p.title === '🚨 ALARM Garage' && p.body === 'Ausgelöst: BWM Garage'));
    adapter.change(F + 'preAlarm', true);
    await until(() => titles().includes('⚠️ Voralarm BMA'));
    adapter.change(F + 'alarm', true);
    adapter.change(F + 'alarmText', 'Melder Küche');
    await until(() => pushed.some(p => p.title === '🔥 BRANDALARM BMA' && p.body === 'Melder Küche'));
    adapter.change(F + 'fault', true);
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!titles().some(x => /Störung/.test(x)), 'fault only with notifyFault');
    assert.ok(!titles().includes('🚨 ALARM Haus'), 'nothing for the area that did not trigger');
});

test('adapter: the ways of a tile\'s messages can be chosen (here "Haus verlassen" only via Telegram)', async t => {
    const { adapter, api, port, pushed } = await startAdapter(t);
    adapter.objects['system.adapter.telegram.0'] = { type: 'instance', common: { name: 'telegram' } };
    adapter.push.subscribe({ endpoint: 'https://push.example/ch', keys: { p256dh: 'x', auth: 'y' } }, 'iPhone');
    const layout = {
        pages: [{ id: 'u', name: 'Übersicht', tiles: [
            { id: 'l1', type: 'switch', label: 'Küche', state: 'knx.0.EG.Licht.Kueche' },
            { id: 'go', type: 'leave', label: 'Weg', lightsOff: true, notify: true, channels: { app: false, telegram: true, whatsapp: false } },
        ] }],
        telegram: { instance: 'telegram.0', users: 'Andi' },
    };
    const saved = await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    assert.deepEqual(saved.body.pages[0].tiles[1].channels, { app: false, telegram: true, whatsapp: false });
    adapter.sent = [];
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    t.after(() => c.ws.close());
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    c.ws.send(JSON.stringify({ type: 'scene', page: 'u', tile: 'go' }));
    await until(() => adapter.sent.some(s => /Weg/.test(s.message.text)));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(pushed.filter(p => p.title === 'Weg').length, 0, 'no app push');
});

test('adapter: time switch of a gate - checks like the buttons, closing only with light barrier tick', async t => {
    const { adapter, api } = await startAdapter(t, {}, a => {
        for (const id of ['test.0.auf', 'test.0.zu', 'test.0.imp', 'test.0.offen', 'test.0.geschlossen', 'test.0.ls']) {
            a.add(id, { name: id, type: 'boolean', role: 'switch', write: true }, false);
        }
    });
    const layout = { pages: [{ id: 'a', name: 'A', tiles: [
        { id: 'g', type: 'gate', label: 'Tor', open: 'test.0.auf', close: 'test.0.zu', posOpen: 'test.0.offen', posClosed: 'test.0.geschlossen', barrier: 'test.0.ls', autoSafe: true },
        { id: 'n', type: 'gate', label: 'Ohne LS', open: 'test.0.auf', close: 'test.0.zu', posOpen: 'test.0.offen', posClosed: 'test.0.geschlossen' },
        { id: 'i', type: 'gate', label: 'Impuls', gateMode: 'single', single: 'impulse', state: 'test.0.imp' },
        { id: 'lk', type: 'gate', label: 'Motorschloss', gateKind: 'lock', open: 'test.0.auf', close: 'test.0.zu' },
    ] }] };
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    const [g, n, i, lk] = adapter.store.layout.pages[0].tiles;
    assert.equal(lk.gateKind, 'lock');
    const entry = { at: 'time', time: '22:00' };
    const writes = () => adapter.writes.map(w => w[0] + '=' + w[1]);
    adapter.change('test.0.geschlossen', true);
    await until(() => adapter.gateStatus(g) === 'closed');
    let w0 = adapter.writes.length;
    await adapter.fireTimer(g, 'close', undefined, entry, 'a/g');
    assert.equal(adapter.writes.length, w0, 'already closed: nothing');
    await adapter.fireTimer(g, 'open', undefined, entry, 'a/g');
    assert.deepEqual(writes().slice(w0), ['test.0.auf=true']);
    adapter.change('test.0.geschlossen', false);
    adapter.change('test.0.offen', true);
    await until(() => adapter.gateStatus(g) === 'open');
    w0 = adapter.writes.length;
    await adapter.fireTimer(n, 'close', undefined, entry, 'a/n');
    assert.equal(adapter.writes.length, w0, 'no light barrier tick: never closed by time');
    adapter.change('test.0.ls', true);
    await until(() => adapter.gateBlocked(g));
    await adapter.fireTimer(g, 'close', undefined, entry, 'a/g');
    assert.equal(adapter.writes.length, w0, 'light barrier interrupted: not closed');
    adapter.change('test.0.ls', false);
    await until(() => !adapter.gateBlocked(g));
    await adapter.fireTimer(g, 'close', undefined, entry, 'a/g');
    assert.deepEqual(writes().slice(w0), ['test.0.zu=true']);
    w0 = adapter.writes.length;
    await adapter.fireTimer(i, 'open', undefined, entry, 'a/i');
    assert.equal(adapter.writes.length, w0, 'impulse with unknown position: nothing');
    await adapter.fireTimer(lk, 'close', undefined, entry, 'a/lk');
    assert.deepEqual(writes().slice(w0), ['test.0.zu=true'], 'motor lock: locked by time without the light barrier tick');
});

test('adapter: SmartView Lite order - own field per page, app order and PIN untouched', async t => {
    const { adapter, api } = await startAdapter(t);
    const layout = { pages: [{ id: 'a', name: 'A', tiles: [
        { id: 'x', type: 'switch', label: 'X', state: 'knx.0.EG.Licht.Wohnzimmer', pin: '4711' },
        { id: 'y', type: 'dimmer', label: 'Y', state: 'knx.0.EG.Licht.Essen_Dimmer' },
        { id: 'z', type: 'heading', label: 'Z' },
    ] }] };
    await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    const hash = adapter.store.layout.pages[0].tiles[0].pinHash;
    const res = await api('liteorder', { method: 'POST', body: JSON.stringify({ page: 'a', order: ['z', 'y', 'x', 'nope'] }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.order, ['z', 'y', 'x']);
    const page = adapter.store.layout.pages[0];
    assert.deepEqual(page.tiles.map(x => x.id), ['x', 'y', 'z'], 'the app keeps its order');
    assert.equal(page.tiles[0].pinHash, hash, 'PIN kept');
    assert.equal((await api('liteorder', { method: 'POST', body: JSON.stringify({ page: 'nix', order: [] }) })).status, 400);
    // a normal save from the app editor keeps the Lite order
    const got = (await api('layout')).body.layout;
    await api('layout', { method: 'PUT', body: JSON.stringify(got) });
    assert.deepEqual(adapter.store.layout.pages[0].liteOrder, ['z', 'y', 'x']);
});

test('adapter: single fire detector / sounder tiles (FC20) - list, filled on saving, symbol kind, switching only with control', async t => {
    const P = 'fc20-cerberus-bacnet.0.objects.';
    const { adapter, api } = await startAdapter(t, {}, a => {
        a.objects['system.adapter.fc20-cerberus-bacnet.0'] = { type: 'instance', common: { name: 'fc20-cerberus-bacnet' } };
        const dev = (path, name, objectName, lifeSafety) => {
            a.objects[P + path] = { type: 'channel', common: { name }, native: { objectName } };
            for (const k of ['state', 'alarm', 'fault', 'disabled']) {
                a.add(`${P}${path}.${k}`, { name: k, type: k === 'state' ? 'string' : 'boolean', role: 'indicator' }, k === 'state' ? 'Ruhe' : false);
            }
            if (lifeSafety) {
                a.add(`${P}${path}.preAlarm`, { name: 'preAlarm', type: 'boolean', role: 'indicator' }, false);
                a.add(`${P}${path}.mode`, { name: 'mode', type: 'number', role: 'level.mode', write: true, states: { 11: 'Eingeschaltet', 12: 'Abgeschaltet' } }, 11);
            }
        };
        dev('melder.eg_wohnzimmer', 'EG Wohnzimmer', 'LP_SENSOR_AUTOMATIC_1/1_1/100', true);
        dev('melder.hm_eingang', 'HM Eingang', 'LP_MANUAL_1/2_1/101', true);
        dev('melder.kg_heizraum', 'KG Heizraum', 'LP_SENSOR_HEAT_1/3_1/102', true);
        dev('sounder.sounder_eg', 'Sounder EG', 'LP_SOUNDER_1/4_1/103', false);
    });
    const devs = (await api('energy')).body.fireDevs;
    assert.deepEqual(devs.map(d => `${d.label}:${d.kind}`), ['EG Wohnzimmer:smoke', 'HM Eingang:manual', 'KG Heizraum:heat', 'Sounder EG:sounder']);
    const layout = { pages: [{ id: 'p', name: 'Plan', type: 'plan', tiles: [
        { id: 'd1', type: 'firedet', fireSrc: P + 'melder.eg_wohnzimmer', x: 10, y: 10 },
        { id: 'd2', type: 'firedet', fireSrc: P + 'sounder.sounder_eg', x: 20, y: 10, control: true },
        { id: 'd3', type: 'firedet', fireSrc: P + 'melder.kg_heizraum', x: 30, y: 10, control: true, fdKind: 'smoke' },
    ] }] };
    const saved = (await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).body.pages[0].tiles;
    assert.equal(saved[0].label, 'EG Wohnzimmer');
    assert.equal(saved[0].fdAuto, 'smoke');
    assert.equal(saved[0].mode, P + 'melder.eg_wohnzimmer.mode');
    assert.equal(saved[1].fdAuto, 'sounder');
    assert.ok(!saved[1].mode, 'a sounder without mode gets no mode data point');
    assert.equal(saved[2].fdKind, 'smoke');
    const { stateIds } = require('../lib/layout');
    const ids = stateIds(adapter.store.layout);
    const w = new Set(ids.write);
    assert.ok(!w.has(P + 'melder.eg_wohnzimmer.mode'), 'no control tick: display only');
    assert.ok(w.has(P + 'melder.kg_heizraum.mode'), 'with control: the mode may be written');
    assert.ok(new Set(ids.read).has(P + 'melder.eg_wohnzimmer.alarm'));
});

test('adapter: access from outside through a reverse proxy (login required, PIN tiles locked)', async t => {
    const { adapter, port, base, api } = await startAdapter(t, { proxyIps: '10.77.0.1, 127.0.0.1', externalLock: 'pin', externalUrl: 'https://smartview.example.com' });
    // without users nothing from outside
    const page = await fetch(base);
    assert.equal(page.status, 403);
    assert.match(await page.text(), /Benutzer/);
    assert.equal((await api('ring')).status, 403);
    await assert.rejects(wsClient(`ws://127.0.0.1:${port}/ws`).open);

    adapter.server.users.save([{ name: 'Andi', password: 'geheim1', admin: true }], []);
    assert.equal((await api('layout')).status, 401);
    assert.equal((await api('ring')).status, 403, 'doorbell check only at home');
    assert.equal((await api('layout')).body.twofa, true, 'login form asks for the authenticator code');
    // wrong passwords are counted per browser address (X-Forwarded-For), not for the proxy as a whole
    const login = (password, ip, code) => fetch(base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ name: 'Andi', password, code }) });
    // without an authenticator set up: no way in from outside
    const noTotp = await login('geheim1', '198.51.100.7', '123456');
    assert.equal(noTotp.status, 403);
    assert.match((await noTotp.json()).error, /Heimnetz einrichten/);
    const totp = require('../lib/totp');
    const secret = totp.newSecret();
    adapter.server.users.setTotp(adapter.server.users.data.users[0].id, secret);
    for (let i = 0; i < 6; i++) {
        await login('nein', '203.0.113.5', totp.code(secret, Math.floor(Date.now() / 30000)));
    }
    assert.equal((await login('geheim1', '203.0.113.5', totp.code(secret, Math.floor(Date.now() / 30000)))).status, 403);
    assert.equal((await login('geheim1', '198.51.100.7', '000000')).status, 403, 'wrong code');
    assert.equal((await login('geheim1', '198.51.100.7')).status, 403, 'password alone is not enough');
    const now = totp.code(secret, Math.floor(Date.now() / 30000));
    const ok = await login('geheim1', '198.51.100.7', now);
    assert.equal(ok.status, 200);
    assert.equal((await login('geheim1', '198.51.100.8', now)).status, 403, 'a code works only once');
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const admin = (p, opts = {}) => api(p, { ...opts, headers: { 'Content-Type': 'application/json', Cookie: cookie } });
    const layout = {
        pages: [{ id: 'start', name: 'Start', tiles: [
            { id: 'l1', type: 'switch', label: 'Licht', state: 'knx.0.EG.Licht.Wohnzimmer' },
            { id: 'door', type: 'switch', label: 'Türöffner', state: 'knx.0.EG.Licht.Essen_Dimmer', pin: '4711' },
        ] }],
    };
    assert.equal((await admin('layout', { method: 'PUT', body: JSON.stringify(layout) })).status, 200);

    const c = wsClient(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    assert.deepEqual(c.msgs.find(m => m.type === 'init').writable, ['knx.0.EG.Licht.Wohnzimmer']);
    const writes = adapter.writes.length;
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Essen_Dimmer', val: true, pin: '4711' }));
    await until(() => c.msgs.some(m => m.type === 'error'));
    assert.equal(adapter.writes.length, writes, 'PIN tile locked from outside even with the right PIN');
    c.ws.send(JSON.stringify({ type: 'set', id: 'knx.0.EG.Licht.Wohnzimmer', val: true }));
    await until(() => adapter.writes.length > writes);
    c.ws.close();

    const timer = await admin('timers/start/door', { method: 'PUT', body: JSON.stringify({ entries: [], pin: '4711' }) });
    assert.equal(timer.status, 403);
    assert.match(timer.body.error, /außen/);
    assert.equal(adapter.appLink('start'), 'https://smartview.example.com/#start');
});

test('users: authenticator set up at home, sessions from home do not count outside', async t => {
    const { adapter, base, api } = await startAdapter(t, { proxyIps: '10.77.0.1' });
    const first = await fetch(base + 'api/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ name: 'Andi', password: 'geheim1', admin: true }]) });
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const me = (p, opts = {}) => api(p, { ...opts, headers: { 'Content-Type': 'application/json', Cookie: cookie } });
    assert.equal((await me('layout')).body.me.totp, false);
    const start = await me('2fa/start', { method: 'POST', body: '{}' });
    assert.match(start.body.uri, /^otpauth:\/\/totp\/Haus|^otpauth:\/\/totp\/SmartView/);
    assert.match(start.body.qr, /<svg/);
    const secret = start.body.secret.replace(/ /g, '');
    const totp = require('../lib/totp');
    assert.equal((await me('2fa/confirm', { method: 'POST', body: JSON.stringify({ code: '000000' }) })).status, 403);
    assert.equal((await me('2fa/confirm', { method: 'POST', body: JSON.stringify({ code: totp.code(secret, Math.floor(Date.now() / 30000)) }) })).status, 200);
    assert.equal((await me('layout')).body.me.totp, true);
    const store = adapter.server.users;
    const token = decodeURIComponent(cookie.split('=')[1]);
    assert.ok(store.session(token), 'home session works at home');
    assert.equal(store.session(token, true), null, 'but not from outside (no code was given)');
    assert.ok(!JSON.stringify((await me('users')).body).includes(secret), 'secret never listed');
    // admin resets it (lost phone)
    const list = (await me('users')).body.users.map(u => ({ ...u, totpReset: true }));
    assert.equal((await me('users', { method: 'PUT', body: JSON.stringify(list) })).status, 200);
    assert.equal(store.data.users[0].totp, undefined);
});

test('adapter: waste calendar tile (fetch iCal, reminder once the evening before, errors)', async t => {
    const W = require('../www/wastelogic');
    const today = W.dayKey(new Date());
    const ymd = k => k.replace(/-/g, '');
    const cal = (events) => 'BEGIN:VCALENDAR\r\n' + events.map(([d, s]) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${ymd(d)}\r\nSUMMARY:${s}\r\nEND:VEVENT\r\n`).join('') + 'END:VCALENDAR\r\n';
    const ics = http.createServer((req, res) => {
        if (req.url === '/a.ics') {
            res.end(cal([[W.addDays(today, 1), 'Restmüll'], [W.addDays(today, 1), 'Bio'], [W.addDays(today, 5), 'Altpapier']]));
        } else if (req.url === '/b.ics') {
            res.end(cal([[W.addDays(today, 1), 'Gelber Sack'], [W.addDays(today, -3), 'Restmüll']]));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(r => ics.listen(0, '127.0.0.1', r));
    t.after(() => ics.close());
    const base = `http://127.0.0.1:${ics.address().port}`;
    const { adapter, api, port } = await startAdapter(t);
    const layout = {
        pages: [{ id: 'start', name: 'Start', tiles: [{ id: 'm', type: 'waste', label: 'Müll', notify: true, notifyTime: '19:00', sources: [
            { label: 'Klagenfurt', url: `${base}/a.ics` },
            { label: 'Ferlach', url: `webcal://127.0.0.1:${ics.address().port}/b.ics` }, // webcal -> https: fails here
        ] }] }],
    };
    const saved = await api('layout', { method: 'PUT', body: JSON.stringify(layout) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.pages[0].tiles[0].sources[1].url.startsWith('https://'), true, 'webcal:// becomes https://');
    await until(() => adapter.wasteInfo()['start/m'] && adapter.wasteInfo()['start/m'].updated);
    let info = adapter.wasteInfo()['start/m'];
    assert.deepEqual(info.entries.map(e => [e.title, e.source]), [['Bio', 'Klagenfurt'], ['Restmüll', 'Klagenfurt'], ['Altpapier', 'Klagenfurt']]);
    assert.match(info.error, /Ferlach/);

    // the second calendar over http works -> both houses
    layout.pages[0].tiles[0].sources[1].url = `${base}/b.ics`;
    assert.equal((await api('layout', { method: 'PUT', body: JSON.stringify(layout) })).status, 200);
    await until(() => adapter.wasteInfo()['start/m'].entries.length === 4);
    info = adapter.wasteInfo()['start/m'];
    assert.equal(info.error, '');
    assert.ok(!info.entries.some(e => e.date < today), 'past dates dropped');

    // the page gets the dates with the init
    const c = wsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open;
    await until(() => c.msgs.some(m => m.type === 'init'));
    assert.equal(c.msgs.find(m => m.type === 'init').waste['start/m'].entries.length, 4);
    c.ws.close();

    // reminder: not before 19:00, once at 19:05, not again
    const sent = [];
    adapter.notify = (...a) => sent.push(a);
    const at = (h, m) => {
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d;
    };
    adapter.checkWaste(at(18, 50));
    assert.equal(sent.length, 0);
    adapter.checkWaste(at(19, 5));
    adapter.checkWaste(at(19, 20));
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], '🗑 Müll');
    assert.equal(sent[0][1], 'Morgen: Bio, Restmüll (Klagenfurt) · Gelber Sack (Ferlach)');
    assert.equal(sent[0][3], 'waste-start/m');
});
