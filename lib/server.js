'use strict';

/*
 * Web server for SmartView, the same app on HTTP (touch PC, VIS iframe) and HTTPS (iPhone home
 * screen app with push - needs the own CA installed once):
 *   /                      the app (www/), /manifest.json, /sw.js
 *   /zertifikat            certificate install page, /smartview-ca.crt, /smartview.mobileconfig
 *   /api/layout            GET / PUT (editor)
 *   /api/objects, /api/values  object browser for the editor
 *   /api/cameras           livecam cameras
 *   /api/upload?name=      upload of a floor plan image -> {file}
 *   /api/push/*            key, subscribe, unsubscribe, status, test
 *   /files/<name>          uploaded images
 *   /cam/<camera>.jpg|.mjpeg  livecam images through this server (no mixed content on HTTPS)
 *   /ws                    live values and commands
 * Optional access key: ?key=... once, then a cookie.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { WebSocketServer } = require('ws');
const { stateIds, ICONS, TYPES } = require('./layout');
const { caDer, mobileconfig } = require('./certs');
const { certPage } = require('./pages');
const { TONE_LABELS, toneEngine } = require('./tones');

const WWW = path.join(__dirname, '..', 'www');
const TYPES_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

class SmartServer {
    /**
     * @param {object} o
     * @param {import('./layout').LayoutStore} o.store
     * @param {import('./push').Push} o.push
     * @param {object} o.adapter {stateInfo(id), setValue(id, val), objectList(fresh), stateValues(ids),
     *   cameras(), cameraUrl(id, kind), layoutChanged(), pushTest()}
     */
    constructor({ store, push, adapter, intercom = null, accessKey = '', allowEdit = true, certs = null, log }) {
        this.intercom = intercom;
        this.store = store;
        this.push = push;
        this.adapter = adapter;
        this.accessKey = accessKey;
        this.allowEdit = allowEdit;
        this.certs = certs;
        this.log = log;
        this.servers = [];
        this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
        this.wss.on('connection', ws => this._client(ws));
    }

    _makeServer(secure) {
        const handler = (req, res) => {
            this._handle(req, res, secure).catch(err => {
                if (!res.headersSent) {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                res.end(err.message);
            });
        };
        const server = secure ? https.createServer({ cert: this.certs.server.cert, key: this.certs.server.key }, handler) : http.createServer(handler);
        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/intercom/ws' && this.intercom && this._allowed(req, url)) {
                this.intercom.handleUpgrade(req, socket, head);
                return;
            }
            if (url.pathname !== '/ws' || !this._allowed(req, url)) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
        });
        server.on('clientError', (err, socket) => socket.destroy());
        this.servers.push(server);
        return server;
    }

    listen(port, secure, host = '0.0.0.0') {
        const server = this._makeServer(secure);
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                resolve(server.address());
            });
        });
    }

    close() {
        if (this.intercom) {
            this.intercom.close();
        }
        for (const ws of this.wss.clients) {
            ws.terminate();
        }
        return Promise.all(
            this.servers.map(s => {
                s.closeAllConnections();
                return new Promise(resolve => s.close(() => resolve()));
            }),
        );
    }

    // ---------------- access ----------------

    _cookieKey(req) {
        const m = /(?:^|;\s*)sv_key=([^;]+)/.exec(req.headers.cookie || '');
        return m ? decodeURIComponent(m[1]) : '';
    }

    _allowed(req, url) {
        if (!this.accessKey) {
            return true;
        }
        return url.searchParams.get('key') === this.accessKey || this._cookieKey(req) === this.accessKey;
    }

    // ---------------- http ----------------

    _json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data === undefined ? '' : JSON.stringify(data));
    }

    async _body(req, limit = 2e6, raw = false) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
            size += c.length;
            if (size > limit) {
                throw new Error('Zu groß');
            }
            chunks.push(c);
        }
        const buf = Buffer.concat(chunks);
        if (raw) {
            return buf;
        }
        const text = buf.toString('utf8');
        return text ? JSON.parse(text) : {};
    }

    async _handle(req, res, secure) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        const keyOk = this._allowed(req, url);
        if (keyOk && this.accessKey && url.searchParams.get('key') === this.accessKey && this._cookieKey(req) !== this.accessKey) {
            res.setHeader('Set-Cookie', `sv_key=${encodeURIComponent(this.accessKey)}; Path=/; Max-Age=315360000; SameSite=Lax${secure ? '; Secure' : ''}; HttpOnly`);
        }

        // ---- public: certificate, manifest, service worker, app files ----
        if (p === '/zertifikat') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(certPage({ urls: this.adapter.urls(), hasCert: Boolean(this.certs), secure }));
            return;
        }
        if (p === '/smartview-ca.crt' && this.certs) {
            res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="smartview-ca.crt"' });
            res.end(caDer(this.certs.ca));
            return;
        }
        if (p === '/smartview.mobileconfig' && this.certs) {
            res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="smartview.mobileconfig"' });
            res.end(mobileconfig(this.certs.ca, this.store.layout.title || 'SmartView'));
            return;
        }
        if (p === '/tones-engine.js') {
            // ring tones of livecam (lib/tones.js runs in the browser)
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(`'use strict';\nconst TONE_LABELS = ${JSON.stringify(TONE_LABELS)};\nconst toneEngine = ${toneEngine.toString()};\n`);
            return;
        }
        if (p === '/manifest.json') {
            const title = this.store.layout.title || 'SmartView';
            const key = keyOk && this.accessKey ? `?key=${encodeURIComponent(this.accessKey)}` : '';
            return this._json(res, 200, {
                name: title,
                short_name: title,
                start_url: `./${key}`,
                scope: './',
                display: 'standalone',
                background_color: '#0f1216',
                theme_color: '#0f1216',
                icons: [
                    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                ],
            });
        }

        // ---- protected ----
        if (p.startsWith('/api/') || p.startsWith('/files/') || p.startsWith('/cam/')) {
            if (!keyOk) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Zugriff verweigert: Schlüssel fehlt (?key=...)');
                return;
            }
            return this._api(req, res, url, p);
        }

        const file = p === '/' ? 'index.html' : p.slice(1);
        // app files and www/vendor/ (pdf.js for the PDF import of floor plans)
        if (/^(vendor\/)?[\w.-]+$/.test(file) && TYPES_MIME[path.extname(file)]) {
            const full = path.join(WWW, file);
            if (fs.existsSync(full)) {
                const headers = { 'Content-Type': TYPES_MIME[path.extname(file)], 'Cache-Control': 'no-cache' };
                if (file === 'sw.js') {
                    headers['Service-Worker-Allowed'] = '/';
                }
                res.writeHead(200, headers);
                fs.createReadStream(full).pipe(res);
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Nicht gefunden');
    }

    async _api(req, res, url, p) {
        if (p === '/api/layout' && req.method === 'GET') {
            return this._json(res, 200, { layout: this.store.layout, allowEdit: this.allowEdit, icons: ICONS, types: Object.keys(TYPES) });
        }
        if (p === '/api/layout' && req.method === 'PUT') {
            if (!this.allowEdit) {
                return this._json(res, 403, { error: 'Bearbeiten ist in den Instanz-Einstellungen gesperrt' });
            }
            const saved = this.store.save(await this._body(req));
            await this.adapter.layoutChanged();
            this._broadcast({ type: 'layout' });
            return this._json(res, 200, saved);
        }
        if (p === '/api/objects') {
            const { list, folders } = await this.adapter.objectList(url.searchParams.get('fresh') === '1');
            const body = Buffer.from(JSON.stringify({ states: list, folders }));
            const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
            if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
                res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
                res.end(zlib.gzipSync(body));
            } else {
                res.writeHead(200, headers);
                res.end(body);
            }
            return;
        }
        if (p === '/api/values' && req.method === 'POST') {
            const ids = await this._body(req);
            return this._json(res, 200, await this.adapter.stateValues(Array.isArray(ids) ? ids.map(String) : []));
        }
        if (p === '/api/cameras') {
            return this._json(res, 200, await this.adapter.cameras());
        }
        if (p === '/api/upload' && req.method === 'POST') {
            if (!this.allowEdit) {
                return this._json(res, 403, { error: 'Bearbeiten ist gesperrt' });
            }
            const data = await this._body(req, 20e6, true);
            return this._json(res, 200, { file: this.store.saveFile(url.searchParams.get('name') || 'bild.png', data) });
        }
        if (p === '/api/timers' && req.method === 'GET') {
            return this._json(res, 200, this.adapter.timers());
        }
        const tm = /^\/api\/timers\/([\w-]+)\/([\w-]+)$/.exec(p);
        if (tm && req.method === 'PUT') {
            // time switches are part of operating, not of editing the layout: allowed without edit mode
            const saved = this.adapter.setTimer(`${tm[1]}/${tm[2]}`, await this._body(req));
            this._broadcast({ type: 'timers' });
            return this._json(res, 200, saved);
        }
        if (p === '/api/push/key') {
            return this._json(res, 200, { publicKey: this.push.publicKey });
        }
        if (p === '/api/push/subscribe' && req.method === 'POST') {
            const body = await this._body(req);
            this.push.subscribe(body.subscription, body.name);
            this.adapter.pushDevices(this.push.count);
            return this._json(res, 200, { ok: true });
        }
        if (p === '/api/push/unsubscribe' && req.method === 'POST') {
            const body = await this._body(req);
            this.push.unsubscribe(String(body.endpoint || ''));
            this.adapter.pushDevices(this.push.count);
            return this._json(res, 200, { ok: true });
        }
        if (p === '/api/push/status' && req.method === 'POST') {
            const body = await this._body(req);
            return this._json(res, 200, { registered: this.push.has(String(body.endpoint || '')), devices: this.push.count });
        }
        if (p === '/api/push/test' && req.method === 'POST') {
            const result = await this.push.send({ title: this.store.layout.title || 'SmartView', body: 'Test-Mitteilung – Mitteilungen funktionieren.', url: './', tag: 'test' });
            return this._json(res, 200, result);
        }
        let m = /^\/files\/([\w.-]+)$/.exec(p);
        if (m) {
            const full = this.store.filePath(m[1]);
            if (full && fs.existsSync(full)) {
                res.writeHead(200, {
                    'Content-Type': TYPES_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
                    'Cache-Control': 'max-age=86400',
                    // uploaded SVGs must not run scripts
                    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
                    'X-Content-Type-Options': 'nosniff',
                });
                fs.createReadStream(full).pipe(res);
                return;
            }
        }
        m = /^\/api\/intercom\/history(?:\/(\d+)\.jpg)?$/.exec(p);
        if (m && this.intercom) {
            return this.intercom.history(res, m[1]);
        }
        m = /^\/cam\/(.+)\.(jpg|mjpeg)$/.exec(p);
        if (m) {
            return this._camera(req, res, decodeURIComponent(m[1]), m[2]);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Nicht gefunden');
    }

    /** Pass a livecam image/stream through. */
    async _camera(req, res, id, kind) {
        const target = await this.adapter.cameraUrl(id, kind);
        if (!target) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Kamera nicht gefunden');
            return;
        }
        const u = new URL(target);
        if (kind === 'jpg') {
            u.searchParams.set('fresh', '1');
        }
        const lib = u.protocol === 'https:' ? https : http;
        const up = lib.get(u, { rejectUnauthorized: false, timeout: 15000 }, upRes => {
            const headers = { 'Content-Type': upRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'no-store' };
            res.writeHead(upRes.statusCode || 502, headers);
            upRes.pipe(res);
        });
        up.on('timeout', () => up.destroy(new Error('timeout')));
        up.on('error', err => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            res.end(`Kamera nicht erreichbar: ${err.message}`);
        });
        res.on('close', () => up.destroy());
    }

    // ---------------- live values ----------------

    _client(ws) {
        const { read, write } = stateIds(this.store.layout);
        const states = {};
        for (const id of read) {
            states[id] = this.adapter.stateInfo(id);
        }
        this._send(ws, { type: 'init', states, writable: write });
        ws.on('message', data => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (msg.type === 'set' && typeof msg.id === 'string') {
                // only data points that the layout lets the page write
                if (!stateIds(this.store.layout).write.includes(msg.id)) {
                    this._send(ws, { type: 'error', text: `Nicht freigegeben: ${msg.id}` });
                    return;
                }
                Promise.resolve(this.adapter.setValue(msg.id, msg.val)).catch(err => this._send(ws, { type: 'error', text: err.message }));
            }
        });
        // keep connections through NAT/VPN alive and detect dead ones
        ws.alive = true;
        ws.on('pong', () => {
            ws.alive = true;
        });
    }

    /** A data point of the layout changed. */
    stateChanged(id, info) {
        this._broadcast({ type: 'state', id, state: info });
    }

    ping() {
        if (this.intercom) {
            this.intercom.ping();
        }
        for (const ws of this.wss.clients) {
            if (!ws.alive) {
                ws.terminate();
                continue;
            }
            ws.alive = false;
            ws.ping();
        }
    }

    _send(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    _broadcast(msg) {
        const text = JSON.stringify(msg);
        for (const ws of this.wss.clients) {
            if (ws.readyState === 1) {
                ws.send(text);
            }
        }
    }
}

module.exports = { SmartServer };
