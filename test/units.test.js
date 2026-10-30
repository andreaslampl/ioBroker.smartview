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
    assert.deepEqual(w[1], { label: 'Bad', state: 'knx.0.Fenster.Bad', tilt: '', invert: true, invert2: false, logic: 'tilt', map: 'ztoo' });
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

test('homekit: tiles <-> homekit-easy devices', () => {
    const { toDevice, toTile, devicesFor } = require('../lib/homekit');
    const page = { id: 'eg', name: 'EG' };
    assert.deepEqual(toDevice({ id: 'h', type: 'thermostat', label: 'Bad', state: 'a', status: 'b', heating: 'c', min: 16, homekit: 'thermostat' }, page), {
        id: 'sv-eg-h', type: 'thermostat', name: 'Bad', state: 'a', heating: 'c', min: 16, actual: 'b',
    });
    // without a data point / camera nothing is created
    assert.equal(toDevice({ id: 's', type: 'switch', homekit: 'light' }, page), null);
    assert.equal(toDevice({ id: 'c', type: 'camera', camera: 'http://x', homekit: 'camera' }, page), null);
    assert.equal(toDevice({ id: 'c', type: 'camera', camera: 'livecam.0.cameras.tuer', homekit: 'camera' }, page).camera, 'livecam.0.cameras.tuer');
    // long ids stay valid for homekit-easy
    assert.match(toDevice({ id: 'x'.repeat(40), type: 'switch', state: 's', homekit: 'switch' }, page).id, /^sv-[0-9a-f]{16}$/);
    // inverted contact: texts swapped; doorbell becomes a plain camera tile
    assert.deepEqual([toTile({ id: 'm', type: 'blind', name: 'Markise', move: 'knx.0.AufAb', moveInvert: true })].map(t => [t.state, t.closed100]), [['knx.0.AufAb', true]]);
    assert.equal(devicesFor({ pages: [{ id: 'a', tiles: [{ id: 'b', type: 'blind', state: 's', homekit: 'blind', closed100: true }] }] })[0].moveInvert, true);
    assert.equal(toTile({ id: 'k', type: 'contact', name: 'Tür', state: 's', invert: true }).texts, 'true=zu;false=offen');
    const bell = toTile({ id: 'd', type: 'doorbell', name: 'Klingel', camera: 'livecam.0.cameras.tuer', ring: 'r' });
    assert.deepEqual([bell.type, bell.homekit, bell.hkId], ['camera', undefined, undefined]);
    // two tiles linked to the same device: only one device
    assert.equal(devicesFor({ pages: [{ id: 'a', tiles: [{ id: 'b', type: 'blind', state: 's', homekit: 'blind', closed100: true, posInvert: true }] }] })[0].closed100, undefined, 'percent swapped back');
    assert.equal(cleanLayoutForTest().pages[0].tiles[0].posInvert, true);
    assert.equal(devicesFor({ pages: [{ id: 'a', tiles: [{ id: '1', type: 'switch', state: 's', homekit: 'light', hkId: 'own' }, { id: '2', type: 'switch', state: 's', homekit: 'light', hkId: 'own' }] }] }).length, 1);
});

function cleanLayoutForTest() {
    return require('../lib/layout').cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [{ id: 'b', type: 'blind', state: 's', posInvert: 1 }] }] });
}

test('layout: free grid pages keep tile cells', () => {
    const { cleanLayout } = require('../lib/layout');
    const l = cleanLayout({ pages: [
        { id: 'a', name: 'A', free: true, cols: 40, tiles: [{ id: 't', type: 'switch', gx: 3, gy: 2 }, { id: 'u', type: 'switch', gx: 'x' }] },
        { id: 'b', name: 'B', type: 'list', free: true, tiles: [] },
    ] });
    assert.deepEqual([l.pages[0].free, l.pages[0].cols], [true, 12]);
    assert.deepEqual([l.pages[0].tiles[0].gx, l.pages[0].tiles[0].gy], [3, 2]);
    assert.equal(l.pages[0].tiles[1].gx, undefined);
    assert.equal(l.pages[1].free, undefined, 'only tile pages');
});

test('layout: pages scaled to the screen', () => {
    const { cleanLayout } = require('../lib/layout');
    const l = cleanLayout({ pages: [
        { id: 'a', name: 'A', fit: 'width', designW: 99999, tiles: [] },
        { id: 'b', name: 'B', fit: 'screen', tiles: [] },
        { id: 'c', name: 'C', fit: 'zoom', designW: 800, tiles: [] },
        { id: 'd', name: 'D', type: 'list', fit: 'width', tiles: [] },
        { id: 'e', name: 'E', type: 'plan', fit: 'screen', designW: 1400, tiles: [] },
    ] });
    assert.deepEqual(l.pages.map(p => [p.fit, p.designW]), [['width', 4000], ['screen', 1280], [undefined, undefined], ['width', 1280], ['screen', 1400]]);
});

test('layout: own tile sizes, plan tile, hidden pages', () => {
    const { cleanLayout, stateIds } = require('../lib/layout');
    const l = cleanLayout({ pages: [
        { id: 'a', name: 'A', tiles: [{ id: 't', type: 'switch', state: 's', sw: 3, sh: 20 }, { id: 'p', type: 'planview', target: 'eg' }, { id: 'u', type: 'switch', sw: 0 }] },
        { id: 'eg', name: 'EG', type: 'plan', hidden: true, tiles: [{ id: 'm', type: 'switch', state: 'knx.0.m', x: 10, y: 10, sw: 2 }] },
    ] });
    assert.deepEqual([l.pages[0].tiles[0].sw, l.pages[0].tiles[0].sh], [3, 8]);
    assert.equal(l.pages[0].tiles[1].target, 'eg');
    assert.equal(l.pages[0].tiles[2].sw, undefined);
    assert.equal(l.pages[1].hidden, true);
    assert.equal(l.pages[1].tiles[0].sw, undefined, 'markers have no size');
    // the symbols of a plan shown in a tile are read and may be written like on the plan page
    assert.ok(stateIds(l).write.includes('knx.0.m'));
});

test('wallbox tile: instances fill the data points, mode and current are writable', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 'wb', type: 'wallbox', charger: 'versicharge.0', instance: 'energie.0', status: 'my.own.status' }] }] });
    const t = l.pages[0].tiles[0];
    assert.equal(t.state, 'versicharge.0.power.total');
    assert.equal(t.status, 'my.own.status', 'own data point stays');
    assert.equal(t.energy, 'versicharge.0.energy.session');
    assert.equal(t.mode, 'energie.0.wallbox.mode');
    assert.equal(t.ctrl, 'energie.0.wallbox.status');
    const { write } = stateIds(l);
    assert.ok(write.includes('energie.0.wallbox.mode'));
    assert.ok(write.includes('versicharge.0.control.current'));
    assert.ok(!write.includes('versicharge.0.power.total'));
    // another instance replaces the old instance's data points
    const t2 = cleanLayout({ pages: [{ id: 'p', tiles: [{ ...t, charger: 'versicharge.1' }] }] }).pages[0].tiles[0];
    assert.equal(t2.state, 'versicharge.1.power.total');
    assert.equal(cleanLayout({ pages: [{ id: 'p', tiles: [{ type: 'wallbox', charger: 'evil.0' }] }] }).pages[0].tiles[0].charger, '');
});

test('floor plan layer of a tile: only known layers are kept', () => {
    const l = cleanLayout({ pages: [{ id: 'eg', type: 'plan', tiles: [
        { id: 'a', type: 'switch', layer: 'brand', x: 1, y: 1 },
        { id: 'b', type: 'switch', layer: 'quatsch', x: 1, y: 1 },
        { id: 'c', type: 'camera', x: 1, y: 1 },
    ] }] });
    assert.deepEqual(l.pages[0].tiles.map(t => t.layer), ['brand', undefined, undefined]);
});

test('window overview: evaluation per window (tilt contact, two contacts, own table)', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 'w', type: 'windows', windows: [
        { state: 'a', tilt: 'b' },
        { state: 'a', tilt: 'b', logic: 'both', invert2: true },
        { state: 'a', tilt: 'b', logic: 'table', map: 'zoto' },
        { state: 'a', logic: 'table', map: 'bad!' },
    ] }] }] });
    const w = l.pages[0].tiles[0].windows;
    assert.deepEqual(w.map(x => x.logic), ['tilt', 'both', 'table', 'table']);
    assert.deepEqual(w.map(x => x.map), ['ztoo', 'ztoo', 'zoto', 'ztoo']);
    assert.deepEqual(w.map(x => x.invert2), [false, true, false, false]);
});

test('heating tile with more circuits: fields kept, setpoint and mode of every circuit writable', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{
        id: 'h', type: 'thermostat', state: 'och.0.fbh_soll', mode: 'och.0.fbh_mode', circLabel: 'Fußboden',
        circuits: [{ label: 'Heizkörper', state: 'och.0.hk_soll', status: 'och.0.hk_ist', mode: 'och.0.hk_mode', bogus: 'x' }],
    }] }] });
    const t = l.pages[0].tiles[0];
    assert.equal(t.circLabel, 'Fußboden');
    assert.deepEqual(t.circuits, [{ label: 'Heizkörper', state: 'och.0.hk_soll', status: 'och.0.hk_ist', mode: 'och.0.hk_mode' }]);
    const { read, write } = stateIds(l);
    assert.ok(write.includes('och.0.hk_soll') && write.includes('och.0.hk_mode') && write.includes('och.0.fbh_soll'));
    assert.ok(read.includes('och.0.hk_ist') && !write.includes('och.0.hk_ist'));
});

test('heating circuits keep their own mode texts', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 'h', type: 'thermostat', state: 'a', modes: '4=Normal', circuits: [{ label: 'HK', state: 'b', mode: 'c', modes: '2=Normal' }] }] }] });
    const t = l.pages[0].tiles[0];
    assert.equal(t.modes, '4=Normal');
    assert.equal(t.circuits[0].modes, '2=Normal');
});

test('layout: window tile with areas, only open ones, warning', () => {
    const { cleanLayout, stateIds } = require('../lib/layout');
    const l = cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [{ id: 'w', type: 'windows', onlyOpen: 1, warnMin: '15', warnWhen: 'knx.0.Regen', warnText: 'Regen!',
        windows: [{ label: 'links', group: ' Küche ', state: 'k.1' }, { label: 'rechts', group: 'Küche', state: 'k.2' }] }] }] });
    const t = l.pages[0].tiles[0];
    assert.deepEqual([t.onlyOpen, t.warnMin, t.warnWhen, t.warnText, t.windows[0].group], [true, 15, 'knx.0.Regen', 'Regen!', 'Küche']);
    const ids = stateIds(l);
    assert.ok(ids.read.includes('knx.0.Regen') && !ids.write.includes('knx.0.Regen'));
});

test('layout: alarm tile with several areas, filled from NOX areas, all commands PIN protected', () => {
    const { cleanLayout, stateIds, tileWriteIds } = require('../lib/layout');
    const tile = { id: 'x', type: 'alarm', area: 'nox_alarmzentrale.0.areas.1', areaLabel: 'Wohnhaus',
        areas: [{ label: 'Garage', area: 'nox_alarmzentrale.0.areas.2', detectors: [{ label: 'MK Tor', open: 'n.0.inputs.10059.open', deact: 'n.0.inputs.10059.deactivated' }] }, { label: 'leer' }] };
    // without "Schalten erlauben" the tile is display only
    const view = cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [tile] }] });
    assert.deepEqual(tileWriteIds(view.pages[0].tiles[0]), []);
    assert.deepEqual(stateIds(view).write, []);
    assert.ok(stateIds(view).read.includes('n.0.inputs.10059.deactivated'));
    const l = cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [{ ...tile, control: true }] }] });
    const t = l.pages[0].tiles[0];
    assert.equal(t.ready, 'nox_alarmzentrale.0.areas.1.ready');
    assert.equal(t.areas.length, 1, 'areas without data points are dropped');
    assert.deepEqual([t.areas[0].openText, t.areas[0].alarmText, t.areas[0].valueArm], ['nox_alarmzentrale.0.areas.2.openInputs', 'nox_alarmzentrale.0.areas.2.alarmInputs', '5']);
    assert.deepEqual(tileWriteIds(t), ['nox_alarmzentrale.0.areas.1.setState', 'nox_alarmzentrale.0.areas.2.setState', 'n.0.inputs.10059.deactivated']);
    const ids = stateIds(l);
    assert.ok(ids.read.includes('nox_alarmzentrale.0.areas.2.ready') && ids.write.includes('nox_alarmzentrale.0.areas.2.setState'));
});

test('layout: alarm tile filled from an SPC area', () => {
    const { cleanLayout } = require('../lib/layout');
    const t = cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [{ id: 'x', type: 'alarm', area: 'spc-edp.0.areas.2' }] }] }).pages[0].tiles[0];
    assert.deepEqual([t.status, t.command, t.alarm, t.error, t.ready, t.openText, t.alarmText, t.valueOff, t.valueArm, t.valueHome],
        ['spc-edp.0.areas.2.mode', 'spc-edp.0.areas.2.setMode', 'spc-edp.0.areas.2.triggered', undefined, 'spc-edp.0.areas.2.ready', 'spc-edp.0.areas.2.openInputs', 'spc-edp.0.areas.2.alarmInputs', '0', '3', '1']);
});

test('layout: radio tile filled from the station data point, rooms switched like circuits', () => {
    const { cleanLayout, stateIds, tileWriteIds } = require('../lib/layout');
    const l = cleanLayout({ pages: [{ id: 'a', name: 'A', tiles: [{ id: 'r', type: 'radio', station: 'sonos-radio.0.rooms.kueche.station', roomLabel: 'Küche',
        rooms: [{ label: 'Terrasse', station: 'sonos-radio.0.rooms.terrasse.station' }, { label: 'leer' }] }] }] });
    const t = l.pages[0].tiles[0];
    assert.deepEqual([t.playing, t.volume, t.title, t.group, t.online], ['playing', 'volume', 'title', 'group', 'online'].map(k => 'sonos-radio.0.rooms.kueche.' + k));
    assert.equal(t.roomLabel, 'Küche');
    assert.equal(t.rooms.length, 1, 'rooms without a station are dropped');
    assert.equal(t.rooms[0].volume, 'sonos-radio.0.rooms.terrasse.volume');
    assert.deepEqual(tileWriteIds(t).sort(), ['kueche', 'terrasse'].flatMap(r => ['station', 'playing', 'volume'].map(k => `sonos-radio.0.rooms.${r}.${k}`)).sort());
    const ids = stateIds(l);
    assert.ok(ids.read.includes('sonos-radio.0.rooms.terrasse.title'));
    assert.ok(!ids.write.includes('sonos-radio.0.rooms.terrasse.title'), 'title stays read only');
});

test('layout: window contact (read only, hidden when closed) and dehumidifier / air conditioner', () => {
    const { cleanLayout, stateIds, tileWriteIds } = require('../lib/layout');
    const l = cleanLayout({ pages: [{ id: 'p', name: 'P', type: 'plan', tiles: [
        { id: 'c', type: 'contact', state: 'knx.0.mk1', tilt: 'knx.0.mk2', logic: 'both', map: 'bad!', hideClosed: 1, invert2: 1 },
        { id: 'k', type: 'climate', climKind: 'ac', state: 'x.0.on', target: 'x.0.set', temp: 'x.0.t', mode: 'x.0.mode', fan: 'x.0.fan', alarm: 'x.0.err', modes: '0=Auto;1=Kühlen', climKind2: 'no' },
    ] }] });
    const [c, k] = l.pages[0].tiles;
    assert.deepEqual([c.logic, c.map, c.hideClosed, c.invert2], ['both', 'ztoo', true, true]);
    assert.deepEqual(tileWriteIds(c), [], 'a contact is never written');
    assert.equal(k.climKind, 'ac');
    assert.deepEqual(tileWriteIds(k).sort(), ['x.0.fan', 'x.0.mode', 'x.0.on', 'x.0.set']);
    const ids = stateIds(l);
    assert.ok(ids.read.includes('knx.0.mk2') && ids.read.includes('x.0.err'));
    assert.ok(!ids.write.includes('knx.0.mk1') && !ids.write.includes('x.0.t'));
});

test('layout: values in the header are read only and need a data point', () => {
    const { cleanLayout, stateIds } = require('../lib/layout');
    const l = cleanLayout({ pages: [], header: [{ label: 'Nord', state: 'w.0.t', decimals: '1' }, { label: 'leer' }] });
    assert.deepEqual(l.header, [{ label: 'Nord', state: 'w.0.t', unit: '', decimals: 1 }]);
    assert.ok(stateIds(l).read.includes('w.0.t') && !stateIds(l).write.includes('w.0.t'));
});
