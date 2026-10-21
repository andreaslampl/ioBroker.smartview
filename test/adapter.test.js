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
    assert.equal(saved.body.push[2].via, 'telegram');
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
