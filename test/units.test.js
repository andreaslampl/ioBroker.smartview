'use strict';

// the time switch test uses local times in Austria (sunset, weekdays)
process.env.TZ = 'Europe/Vienna';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const forge = require('node-forge');
const { cleanLayout, stateIds, cameraIds } = require('../lib/layout');
const { Push, triggers, fill } = require('../lib/push');
const { ensureCertificates, mobileconfig } = require('../lib/certs');

test('layout: cleaning keeps known fields, plan markers get x/y, ids are unique', () => {
    const l = cleanLayout({
        title: 'Haus',
        pages: [
            { id: 'eg', name: 'EG', type: 'plan', image: 'plan.png', tiles: [{ id: 'a', type: 'switch', state: 'knx.0.a', x: 120, y: -5, evil: '<script>' }, { id: 'a', type: 'value', state: 'knx.0.b' }] },
            { name: 'Kacheln', image: '../etc/passwd', tiles: [{ type: 'nonsense', state: 'x.0.y', size: 'huge' }] },
        ],
    });
    assert.equal(l.title, 'Haus');
    assert.equal(l.pages[0].tiles[0].x, 100);
    assert.equal(l.pages[0].tiles[0].y, 0);
    assert.equal(l.pages[0].tiles[0].evil, undefined);
    assert.notEqual(l.pages[0].tiles[0].id, l.pages[0].tiles[1].id);
    assert.equal(l.pages[1].type, 'tiles');
    assert.equal(l.pages[1].image, '');
    assert.equal(l.pages[1].tiles[0].type, 'switch');
    assert.equal(l.pages[1].tiles[0].size, '1');
    assert.equal(l.pages[1].tiles[0].x, undefined);
});

test('layout: only control data points are writable', () => {
    const l = cleanLayout({
        pages: [
            {
                tiles: [
                    { type: 'switch', state: 'sw', status: 'sw.status' },
                    { type: 'value', state: 'temp' },
                    { type: 'blind', state: 'pos', stop: 'stop' },
                    { type: 'camera', camera: 'livecam.0.cameras.a' },
                ],
            },
        ],
        ring: { state: 'ring', camera: 'livecam.0.cameras.b', door: 'door' },
    });
    const { read, write } = stateIds(l);
    assert.deepEqual(write.sort(), ['door', 'pos', 'stop', 'sw']);
    assert.ok(read.includes('temp') && read.includes('sw.status') && read.includes('ring'));
    assert.deepEqual(cameraIds(l), ['livecam.0.cameras.a', 'livecam.0.cameras.b']);
});

test('layout: optional parts - list pages, menu and multi-value tiles, date, hidden page bar, split screen', () => {
    const plain = cleanLayout({ pages: [{ id: 'a', tiles: [{}] }] });
    assert.equal(plain.showDate, false);
    assert.equal(plain.hideNav, false);
    assert.deepEqual(plain.side, { enabled: false, top: [], bottom: [] });
    assert.equal(plain.pages[0].tiles[0].id, 't1');

    const l = cleanLayout({
        showDate: true,
        hideNav: 1,
        side: { enabled: true, top: ['cams', 'gone'], bottom: ['wetter'] },
        pages: [
            { id: 'menu', tiles: [{ type: 'page', target: 'eg' }, { type: 'page', target: '../x' }] },
            { id: 'eg', type: 'list', tiles: [{ type: 'switch', state: 'knx.0.l' }] },
            { id: 'cams', tiles: [] },
            {
                id: 'wetter',
                tiles: [{ type: 'multi', rows: [{ label: 'Ost', state: 'w.0.ost', decimals: '1', evil: 1 }, { label: 'West', state: 'w.0.west' }] }],
            },
        ],
    });
    assert.equal(l.showDate, true);
    assert.equal(l.hideNav, true);
    assert.deepEqual(l.side, { enabled: true, top: ['cams'], bottom: ['wetter'] });
    assert.equal(l.pages[0].tiles[0].target, 'eg');
    assert.equal(l.pages[0].tiles[1].target, '');
    assert.equal(l.pages[1].type, 'list');
    assert.deepEqual(l.pages[3].tiles[0].rows, [{ label: 'Ost', state: 'w.0.ost', unit: '', decimals: 1 }, { label: 'West', state: 'w.0.west', unit: '' }]);
    const { read, write } = stateIds(l);
    assert.ok(read.includes('w.0.ost') && read.includes('w.0.west'));
    assert.ok(!write.includes('w.0.ost'), 'values of a multi tile are read only');
});

test('layout: room controller - setpoint and operating mode writable, feedback read only, limits', () => {
    const l = cleanLayout({
        pages: [{ id: 'p', tiles: [{ id: 'h', type: 'thermostat', state: 'knx.0.soll', setStatus: 'knx.0.soll_st', status: 'knx.0.ist',
            humidity: 'knx.0.rf', mode: 'knx.0.mode', modeStatus: 'knx.0.mode_st', heating: 'knx.0.valve', window: 'knx.0.win',
            min: '16', max: 26, modes: '1=Komfort;3=Nacht', step: 0.5, bogus: 'x' }] }],
    });
    const t = l.pages[0].tiles[0];
    assert.equal(t.min, 16);
    assert.equal(t.max, 26);
    assert.equal(t.modes, '1=Komfort;3=Nacht');
    assert.equal(t.bogus, undefined);
    const { read, write } = stateIds(l);
    assert.deepEqual(write.sort(), ['knx.0.mode', 'knx.0.soll']);
    assert.equal(read.length, 8);
});

test('layout: HTML display tile is read only', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 'h', type: 'html', label: 'Fensterstatus', state: 'javascript.0.FensterUeberwachung.OverviewTable' }] }] });
    assert.equal(l.pages[0].tiles[0].type, 'html');
    const { read, write } = stateIds(l);
    assert.deepEqual(read, ['javascript.0.FensterUeberwachung.OverviewTable']);
    assert.deepEqual(write, []);
});

test('layout: window overview - contacts and tilt contacts are read, nothing is writable', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 'w', type: 'windows', label: 'Fenster', windows: [
        { label: 'Küche', state: 'knx.0.Fenster.Kueche', tilt: 'knx.0.Fenster.Kueche_Kipp' },
        { label: 'Bad', state: 'knx.0.Fenster.Bad', invert: 1, bogus: 'x' },
    ] }] }] });
    const w = l.pages[0].tiles[0].windows;
    assert.deepEqual(w[1], { label: 'Bad', state: 'knx.0.Fenster.Bad', tilt: '', invert: true });
    const { read, write } = stateIds(l);
    assert.deepEqual(read.sort(), ['knx.0.Fenster.Bad', 'knx.0.Fenster.Kueche', 'knx.0.Fenster.Kueche_Kipp']);
    assert.deepEqual(write, []);
});

test('push rules: fire when the condition becomes true, not again while it stays true', () => {
    assert.equal(triggers({ cond: 'true' }, true, false), true);
    assert.equal(triggers({ cond: 'true' }, true, true), false);
    assert.equal(triggers({ cond: 'true' }, 'true', 'false'), true);
    assert.equal(triggers({ cond: 'false' }, false, true), true);
    assert.equal(triggers({ cond: 'gt', value: '30' }, 31, 29), true);
    assert.equal(triggers({ cond: 'gt', value: '30' }, 32, 31), false);
    assert.equal(triggers({ cond: 'lt', value: '5' }, 4, null), true);
    assert.equal(triggers({ cond: 'eq', value: 'scharf' }, 'scharf', 'unscharf'), true);
    assert.equal(triggers({ cond: 'eq', value: '3' }, 3, 0), true);
    assert.equal(triggers({ cond: 'ne', value: '0' }, 1, 0), true);
    assert.equal(triggers({ cond: 'change' }, 2, 1), true);
    assert.equal(triggers({ cond: 'change' }, 2, 2), false);
    assert.equal(fill('Licht {value}', true), 'Licht ein');
    assert.equal(fill('Fenster {value}', false, 'sensor.window'), 'Fenster zu');
    assert.equal(fill('Temperatur {value} °C', 4.5), 'Temperatur 4.5 °C');
});

test('push: keys are kept, subscriptions stored, gone devices removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-push-'));
    const sent = [];
    const sender = async (sub, payload, opts) => {
        sent.push({ sub, payload: JSON.parse(payload), opts });
        if (sub.endpoint.includes('gone')) {
            throw Object.assign(new Error('Gone'), { statusCode: 410 });
        }
    };
    const log = { warn() {}, info() {} };
    const p = new Push(dir, { sender, log });
    const key = p.publicKey;
    assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
    assert.throws(() => p.subscribe({ endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } }));
    p.subscribe({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } }, 'iPhone');
    p.subscribe({ endpoint: 'https://fcm.googleapis.com/gone', keys: { p256dh: 'p', auth: 'a' } }, 'Alt');
    const r = await p.send({ title: 'Alarm', body: 'Garage offen' });
    assert.deepEqual(r, { sent: 1, failed: 1 });
    assert.equal(sent[0].payload.title, 'Alarm');
    assert.equal(sent[0].opts.vapidDetails.publicKey, key);
    assert.equal(p.count, 1);
    const again = new Push(dir, { sender, log });
    assert.equal(again.publicKey, key);
    assert.equal(again.count, 1);
});

test('certificates: CA + server certificate for the addresses, iOS limits, renewal keeps the CA', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cert-'));
    const a = ensureCertificates(dir, ['127.0.0.1', 'iobroker', 'localhost']);
    assert.equal(a.created, true);
    const cert = forge.pki.certificateFromPem(a.server.cert);
    const days = (cert.validity.notAfter - cert.validity.notBefore) / 86400000;
    assert.ok(days <= 825, `validity ${days} days`);
    const san = cert.getExtension('subjectAltName').altNames;
    assert.ok(san.some(n => n.ip === '127.0.0.1'));
    assert.ok(san.some(n => n.value === 'iobroker'));
    assert.ok(cert.getExtension('extKeyUsage').serverAuth);
    assert.ok(forge.pki.certificateFromPem(a.ca.cert).verify(cert));
    assert.match(mobileconfig(a.ca, 'SmartView'), /com\.apple\.security\.root/);

    // same names: nothing new; a new address: new server certificate, same CA
    const b = ensureCertificates(dir, ['127.0.0.1', 'iobroker']);
    assert.equal(b.server.cert, a.server.cert);
    const c = ensureCertificates(dir, ['127.0.0.1', '192.168.1.20']);
    assert.equal(c.ca.cert, a.ca.cert);
    assert.notEqual(c.server.cert, a.server.cert);
    assert.ok(c.server.names.includes('iobroker'), 'old names are kept');

    // a TLS client that trusts only our CA accepts the server
    const server = https.createServer({ cert: c.server.cert, key: c.server.key }, (req, res) => res.end('ok'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, path: '/', ca: c.ca.cert }, res => {
            let d = '';
            res.on('data', x => (d += x));
            res.on('end', () => resolve(d));
        }).on('error', reject);
    });
    server.close();
    assert.equal(body, 'ok');
});

test('timers: fire once at the time on the chosen weekdays, sun times with offset, no catching up after start', () => {
    const { Timers, weekday } = require('../lib/timers');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-timer-'));
    let now = new Date(2026, 9, 19, 6, 0, 0).getTime(); // Monday 19.10.2026 06:00 local time
    assert.equal(weekday(now), 1);
    const fired = [];
    const tile = { id: 'l1', type: 'switch', state: 'knx.0.l' };
    const timers = new Timers({
        dir,
        now: () => now,
        log: { warn() {}, info() {} },
        location: { latitude: 46.6, longitude: 14.3 },
        tile: key => (key === 'start/l1' ? tile : null),
        fire: (t, action, value, key, e) => fired.push([action, e.id, new Date(now).toTimeString().slice(0, 5)]),
    });
    assert.throws(() => timers.set('start/gone', { entries: [{}] }));
    timers.set('start/l1', {
        entries: [
            { id: 'morning', days: [1, 2, 3, 4, 5], at: 'time', time: '6:30', action: 'on' },
            { id: 'evening', days: [1, 2, 3, 4, 5, 6, 7], at: 'sunset', offset: -30, action: 'off' },
            { id: 'weekend', days: [6, 7], at: 'time', time: '08:00', action: 'on' },
            { id: 'off', enabled: false, days: [1], at: 'time', time: '06:45', action: 'off' },
        ],
    });
    const list = timers.list()['start/l1'];
    assert.equal(list.entries[0].time, '06:30');
    assert.equal(new Date(list.entries[0].next).getHours(), 6);
    const sunset = timers.sunToday().set;
    assert.ok(new Date(sunset).getHours() >= 17 && new Date(sunset).getHours() <= 18, 'sunset in October around 18:00');
    // run the clock through Monday in 15 s steps
    const end = new Date(2026, 9, 19, 23, 0, 0).getTime();
    for (; now < end; now += 15000) {
        timers.tick();
    }
    assert.deepEqual(fired.map(f => f[1]), ['morning', 'evening']);
    assert.equal(fired[0][2], '06:30');
    const evening = Math.round((sunset - 30 * 60000) / 60000) * 60000;
    assert.ok(Math.abs(new Date(2026, 9, 19, ...fired[1][2].split(':').map(Number)).getTime() - evening) < 60000);
    // Saturday: weekend entry, not the weekday one
    fired.length = 0;
    now = new Date(2026, 9, 24, 7, 0, 0).getTime();
    for (const stop = new Date(2026, 9, 24, 9, 0, 0).getTime(); now < stop; now += 15000) {
        timers.tick();
    }
    assert.deepEqual(fired.map(f => f[1]), ['weekend']);
    // a new instance (adapter restart) at 08:02 does not catch up the 08:00 entry
    fired.length = 0;
    now = new Date(2026, 9, 25, 8, 2, 0).getTime();
    const again = new Timers({ dir, now: () => now, log: { warn() {}, info() {} }, tile: () => tile, fire: (t, a, v, k, e) => fired.push(e.id) });
    again.tick();
    assert.deepEqual(fired, []);
    // without a location sun entries never fire but the rest works
    assert.equal(again.list()['start/l1'].entries[1].next, null);
});
