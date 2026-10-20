'use strict';

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
