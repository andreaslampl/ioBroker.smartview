'use strict';

// Remote access without VPN: own relay server (the VMS' alvms-relay.py, run for real) and Tailscale Funnel (fake CLI)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const tls = require('node:tls');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { install, demoHouse } = require('./fake-iobroker');
const totp = require('../lib/totp');

install();

async function until(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 30));
    }
}

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

async function startAdapter(t, config) {
    const port = await freePort();
    const httpsPort = await freePort();
    const logs = [];
    const log = level => m => logs.push(`${level}: ${m}`);
    const adapter = require('../main.js')({ config: { port, httpsPort, publicHost: '127.0.0.1', ...config }, log: { debug() {}, info: log('info'), warn: log('warn'), error: log('error') } });
    adapter.logs = logs;
    demoHouse(adapter, 'http://127.0.0.1:1');
    adapter.emit('ready');
    await until(() => adapter.foreign['smartview.0.info.connection'] && adapter.foreign['smartview.0.info.connection'].val === true, 30000);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    const base = `http://127.0.0.1:${port}/`;
    const api = async (p, opts = {}) => {
        const res = await fetch(base + 'api/' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
        const text = await res.text();
        return { status: res.status, body: text && (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text };
    };
    return { adapter, base, api };
}

/** raw HTTPS request through the relay port with a name (SNI) */
function viaRelay(port, name, reqPath, { method = 'GET', body = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port, servername: name, rejectUnauthorized: false }, () => {
            const h = Object.entries({ Host: name, Connection: 'close', 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
            s.write(`${method} ${reqPath} HTTP/1.1\r\n${h}\r\n\r\n${body}`);
        });
        let data = '';
        s.on('data', c => (data += c));
        s.on('end', () => {
            const head = data.slice(0, data.indexOf('\r\n\r\n'));
            let text = data.slice(data.indexOf('\r\n\r\n') + 4);
            if (/transfer-encoding: chunked/i.test(head)) {
                let out = '';
                while (text) {
                    const nl = text.indexOf('\r\n');
                    const n = parseInt(text.slice(0, nl), 16);
                    if (!n) {
                        break;
                    }
                    out += text.slice(nl + 2, nl + 2 + n);
                    text = text.slice(nl + 2 + n + 2);
                }
                text = out;
            }
            resolve({ status: Number(data.split(' ')[1]), head, text });
        });
        s.on('error', reject);
        s.setTimeout(10000, () => s.destroy(new Error('timeout')));
    });
}

test('users: recovery codes (once each, only hashes stored)', () => {
    const { UserStore, isRecovery } = require('../lib/users');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svr-'));
    const u = new UserStore(dir);
    u.save([{ name: 'Andi', password: 'geheim1', admin: true }], []);
    const id = u.data.users[0].id;
    assert.throws(() => u.newRecovery(id), /Zwei-Faktor/);
    const secret = totp.newSecret();
    u.setTotp(id, secret);
    const codes = u.newRecovery(id);
    assert.equal(codes.length, 10);
    assert.ok(codes.every(c => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c) && !/[01oil]/.test(c)));
    assert.ok(!fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes(codes[0]));
    assert.ok(isRecovery(codes[0]) && isRecovery(codes[0].replace('-', '').toUpperCase()) && !isRecovery('123456'));
    assert.ok(u.login('Andi', 'geheim1', '1.2.3.4', '', { mfa: true, code: codes[0].toUpperCase() }));
    assert.throws(() => u.login('Andi', 'geheim1', '1.2.3.5', '', { mfa: true, code: codes[0] }), /Code falsch/, 'used once');
    assert.equal(u.list()[0].recoveryLeft, 9);
    // saving the users keeps them, removing two-factor drops them
    u.save([{ id, name: 'Andi', admin: true }], []);
    assert.equal(u.list()[0].recoveryLeft, 9);
    u.setTotp(id, '');
    assert.equal(u.byId(id).recovery, undefined);
});

test('remote: own relay server (alvms-relay.py), visitor address, settings only at home', async t => {
    try {
        execFileSync('python3', ['--version']);
    } catch {
        t.skip('python3 missing');
        return;
    }
    const relayPort = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const sites = path.join(tmp, 'sites.json');
    fs.writeFileSync(sites, JSON.stringify({ sites: {} }));
    const py = spawn('python3', [path.join(__dirname, '..', 'tools', 'remote', 'alvms-relay.py'), 'serve', '--port', String(relayPort), '--sites', sites], { stdio: 'ignore' });
    t.after(() => py.kill());
    await until(() => new Promise(r => net.connect(relayPort, '127.0.0.1').on('connect', function () {
        this.destroy();
        r(true);
    }).on('error', () => r(false))));

    const domain = 'mein-sv.duckdns.test';
    const { adapter, base, api } = await startAdapter(t, { remoteMode: 'relay', relayServer: '127.0.0.1', relayPort, relayDomain: domain, remoteTlsPort: await freePort() });
    // not yet allowed at the server: refused, shown with the reason
    await until(() => /nicht verbunden/.test(adapter.foreign['smartview.0.info.remote'] && adapter.foreign['smartview.0.info.remote'].val));
    const info = (await api('remote')).body;
    assert.equal(info.mode, 'relay');
    assert.equal(info.url, `https://${domain}${relayPort === 443 ? '' : `:${relayPort}`}/`);
    assert.match(info.addLine, new RegExp(`^sudo alvms-relay add ${domain.replace(/\./g, '\\.')} [A-Za-z0-9_-]{32}$`));
    assert.match(info.qr, /<svg/);
    const key = info.addLine.split(' ').pop();
    assert.ok(!JSON.stringify(adapter.config).includes(key), 'key not in the instance settings');
    // the owner runs the line on the server
    fs.writeFileSync(sites, JSON.stringify({ sites: { [domain]: key } }));
    await until(() => adapter.relay.status.state === 'on', 40000);
    assert.equal(adapter.foreign['smartview.0.info.remoteUrl'].val, info.url);

    // a visitor: without users SmartView is locked from outside
    const page = await viaRelay(relayPort, domain, '/');
    assert.equal(page.status, 403);
    assert.match(page.text, /von außen gesperrt/);
    // unknown name: the server drops it
    const other = await viaRelay(relayPort, 'fremd.duckdns.test', '/').catch(() => null);
    assert.ok(!other || !other.status, 'unknown name gets no answer');

    adapter.server.users.save([{ name: 'Andi', password: 'geheim1', admin: true }], []);
    const layout = await viaRelay(relayPort, domain, '/api/layout');
    assert.equal(layout.status, 401);
    assert.equal(JSON.parse(layout.text).twofa, true);
    // many page loads at once (pool of 8, refilled at once)
    const t0 = Date.now();
    const many = await Promise.all(Array.from({ length: 40 }, () => viaRelay(relayPort, domain, '/api/layout')));
    assert.ok(many.every(x => x.status === 401), many.map(x => x.status).join());
    assert.ok(Date.now() - t0 < 8000, `40 requests took ${Date.now() - t0} ms`);
    const bad = await viaRelay(relayPort, domain, '/api/login', { method: 'POST', body: JSON.stringify({ name: 'Andi', password: 'falsch', code: '123456' }), headers: { 'X-Forwarded-For': '6.6.6.6' } });
    assert.equal(bad.status, 403);
    assert.ok(adapter.logs.some(l => /failed login for "Andi" from 127\.0\.0\.1 \(von außen\)/.test(l)), 'visitor address from the relay, X-Forwarded-For ignored');
    // two-factor + remote settings cannot be changed from outside
    const id = adapter.server.users.data.users[0].id;
    const secret = totp.newSecret();
    adapter.server.users.setTotp(id, secret);
    const ok = await viaRelay(relayPort, domain, '/api/login', { method: 'POST', body: JSON.stringify({ name: 'Andi', password: 'geheim1', code: totp.code(secret, Math.floor(Date.now() / 30000)) }) });
    assert.equal(ok.status, 200);
    // home: the admin sees the remote page and may make a new key
    const home = await fetch(base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Andi', password: 'geheim1' }) });
    const hc = home.headers.get('set-cookie').split(';')[0];
    const r = await fetch(base + 'api/remote/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: hc }, body: JSON.stringify({ action: 'newkey' }) });
    assert.equal(r.status, 200);
    await until(() => adapter.relay.status.state === 'error', 20000);
    assert.notEqual(adapter._remoteRead().relayKey, key);
});

test('remote: relay requests count as outside; 2fa and remote API refused there', async t => {
    // same server object, request faked on the internal port (no python needed)
    const remotePort = await freePort();
    const { adapter } = await startAdapter(t, { remoteMode: 'relay', relayServer: '127.0.0.1', relayPort: 1, relayDomain: 'x.duckdns.test', remoteTlsPort: remotePort });
    adapter.server.users.save([{ name: 'Andi', password: 'geheim1', admin: true }], []);
    const id = adapter.server.users.data.users[0].id;
    const secret = totp.newSecret();
    adapter.server.users.setTotp(id, secret);
    const req = (p, body, cookie = '') =>
        new Promise((resolve, reject) => {
            const s = tls.connect({ host: '127.0.0.1', port: remotePort, rejectUnauthorized: false }, () => {
                s.write(`POST ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n${body}`);
            });
            let data = '';
            s.on('data', c => (data += c));
            s.on('end', () => resolve({ status: Number(data.split(' ')[1]), head: data.slice(0, data.indexOf('\r\n\r\n')), text: data.slice(data.indexOf('\r\n\r\n') + 4) }));
            s.on('error', reject);
        });
    const ok = await req('/api/login', JSON.stringify({ name: 'Andi', password: 'geheim1', code: totp.code(secret, Math.floor(Date.now() / 30000)) }));
    assert.equal(ok.status, 200);
    const cookie = /sv_session=[^;\r\n]+/.exec(ok.head)[0];
    const tf = await req('/api/2fa/start', '{}', cookie);
    assert.equal(tf.status, 403);
    assert.match(tf.text, /Heimnetz/);
    const rm = await req('/api/remote/action', JSON.stringify({ action: 'newkey' }), cookie);
    assert.equal(rm.status, 403);
});

test('remote: Tailscale Funnel (fake CLI): approval link, switch on, visitor from X-Forwarded-For, off again', async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
    const bin = path.join(tmp, 'tailscale');
    const local = await freePort();
    // state: approved flag + funnel on (written by "funnel --bg"), calls logged
    fs.writeFileSync(
        bin,
        `#!/bin/sh
D="${tmp}"
echo "$*" >> "$D/calls"
case "$1 $2" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"iobroker.tail1234.ts.net."}}' ;;
  "funnel status") if [ -f "$D/on" ]; then echo '{"Web":{"iobroker.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${local}"}}}},"AllowFunnel":{"iobroker.tail1234.ts.net:443":true}}'; else echo '{}'; fi ;;
  "funnel --bg") if [ -f "$D/approved" ]; then touch "$D/on"; echo "Available on the internet"; else echo "Funnel is not enabled on your tailnet."; echo "To enable, visit:"; echo ""; echo "         https://login.tailscale.com/f/funnel?node=abc123"; echo ""; sleep 30; fi ;;
  "funnel --https=443") rm -f "$D/on" ;;
esac
`,
    );
    fs.chmodSync(bin, 0o755);
    const { adapter, base, api } = await startAdapter(t, { remoteMode: 'funnel', tailscaleBin: bin, funnelWaitMs: 3000, remoteHttpPort: local });
    await until(() => adapter.foreign['smartview.0.info.remote'] && /Freischaltung/.test(adapter.foreign['smartview.0.info.remote'].val), 15000);
    let info = (await api('remote')).body;
    assert.equal(info.state, 'approve');
    assert.equal(info.link, 'https://login.tailscale.com/f/funnel?node=abc123');
    fs.writeFileSync(path.join(tmp, 'approved'), '');
    assert.equal((await api('remote/action', { method: 'POST', body: JSON.stringify({ action: 'retry' }) })).status, 200);
    info = (await api('remote')).body;
    assert.equal(info.state, 'on');
    assert.equal(info.url, 'https://iobroker.tail1234.ts.net/');
    assert.ok(fs.readFileSync(path.join(tmp, 'calls'), 'utf8').includes(`funnel --bg --https=443 http://127.0.0.1:${local}`));
    assert.ok(!fs.readFileSync(path.join(tmp, 'calls'), 'utf8').includes('reset'), 'never "funnel reset"');
    assert.equal(adapter.appLink('start'), 'https://iobroker.tail1234.ts.net/#start');

    // what Tailscale forwards: outside; the LAST X-Forwarded-For entry is the visitor
    adapter.server.users.save([{ name: 'Andi', password: 'geheim1', admin: true }], []);
    const r = await fetch(`http://127.0.0.1:${local}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.1.1.1, 203.0.113.9' }, body: JSON.stringify({ name: 'Andi', password: 'x', code: '123456' }) });
    assert.equal(r.status, 403);
    assert.ok(adapter.logs.some(l => l.includes('from 203.0.113.9 (von außen)')));
    assert.equal((await fetch(`http://127.0.0.1:${local}/api/layout`)).status, 401);
    assert.equal((await fetch(base + 'api/ring')).status, 200, 'home port stays home');

    // switched to "off": the next start turns our Funnel off again
    await new Promise(resolve => adapter.emit('unload', resolve));
    const again = require('../main.js')({ config: { port: await freePort(), httpsPort: await freePort(), publicHost: '127.0.0.1', remoteMode: '', tailscaleBin: bin }, dataDir: adapter.dataDir });
    demoHouse(again, 'http://127.0.0.1:1');
    again.emit('ready');
    await until(() => again.foreign['smartview.0.info.remote'] && again.foreign['smartview.0.info.remote'].val === 'aus', 15000);
    assert.ok(!fs.existsSync(path.join(tmp, 'on')));
    await new Promise(resolve => again.emit('unload', resolve));
});
