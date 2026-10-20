'use strict';

/*
 * Door intercom of the livecam adapter inside SmartView. livecam does the SIP call and the WebRTC
 * audio; SmartView only relays:
 *   browser --/intercom/ws--> SmartView --ws--> livecam /ws   (one upstream connection per browser,
 *                                                             so livecam knows who answered)
 *   /api/intercom/history[/<id>.jpg]  -> livecam /history     (call list with photos)
 * The audio itself flows directly between browser and livecam (WebRTC), not through SmartView.
 * Works the same on HTTPS (the iPhone app) because the browser only talks to SmartView.
 */

const http = require('node:http');
const https = require('node:https');
const WebSocket = require('ws');

class IntercomProxy {
    /**
     * @param {object} o
     * @param {() => Promise<{base: string, key: string} | null>} o.target livecam address, null = no intercom
     */
    constructor({ target, log }) {
        this.target = target;
        this.log = log;
        this.wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
        this.wss.on('connection', ws => this._client(ws));
    }

    handleUpgrade(req, socket, head) {
        this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
    }

    async _client(ws) {
        const t = await this.target().catch(() => null);
        if (!t) {
            ws.send(JSON.stringify({ type: 'error', message: 'Keine Sprechstelle: livecam-Adapter nicht gefunden – läuft die livecam-Instanz? Details im ioBroker-Log (smartview.0)' }));
            ws.close();
            return;
        }
        const url = `${t.base.replace(/^http/, 'ws')}/ws${t.key ? `?key=${encodeURIComponent(t.key)}` : ''}`;
        const up = new WebSocket(url, { handshakeTimeout: 8000, rejectUnauthorized: false });
        const queue = [];
        up.on('open', () => {
            for (const m of queue.splice(0)) {
                up.send(m);
            }
        });
        up.on('message', data => {
            if (ws.readyState === 1) {
                ws.send(data.toString());
            }
        });
        up.on('close', () => ws.close());
        up.on('error', err => {
            this.log.debug(`Intercom: livecam not reachable: ${err.message}`);
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'error', message: `Sprechstelle nicht erreichbar: ${err.message}` }));
            }
            ws.close();
        });
        ws.on('message', data => {
            const text = data.toString();
            if (up.readyState === 1) {
                up.send(text);
            } else if (up.readyState === 0 && queue.length < 20) {
                queue.push(text);
            }
        });
        ws.on('close', () => up.close());
        // keep the browser connection alive through NAT/VPN (livecam pings its side itself)
        ws.alive = true;
        ws.on('pong', () => {
            ws.alive = true;
        });
    }

    ping() {
        for (const ws of this.wss.clients) {
            if (!ws.alive) {
                ws.terminate();
                continue;
            }
            ws.alive = false;
            ws.ping();
        }
    }

    close() {
        for (const ws of this.wss.clients) {
            ws.terminate();
        }
    }

    /** GET /history or /history/<id>.jpg of livecam and pass it through. */
    async history(res, id) {
        const t = await this.target().catch(() => null);
        if (!t) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Keine Sprechstelle');
            return;
        }
        const u = new URL(`${t.base}/history${id ? `/${id}.jpg` : ''}`);
        if (t.key) {
            u.searchParams.set('key', t.key);
        }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(u, { rejectUnauthorized: false, timeout: 10000 }, up => {
            res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'application/octet-stream', 'Cache-Control': id ? 'max-age=86400' : 'no-store' });
            up.pipe(res);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', err => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            res.end(`Sprechstelle nicht erreichbar: ${err.message}`);
        });
    }
}

/** livecam address from a camera URL state like http://host:8095/cam/haustuer.jpg?key=x */
function baseFromUrl(value) {
    try {
        const u = new URL(String(value));
        return { base: `${u.protocol}//${u.host}`, key: u.searchParams.get('key') || '' };
    } catch {
        return null;
    }
}

module.exports = { IntercomProxy, baseFromUrl };
