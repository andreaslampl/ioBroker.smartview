'use strict';

/*
 * Client for the relay server of the "Andreas L.-Arts VMS" (tools/remote/alvms-relay.py on an own internet server,
 * e.g. an IONOS VPS): SmartView keeps `pool` TCP connections to the server open; the server hands a visitor of
 * https://<domain> over to one of them. TLS stays end to end (certificate at SmartView, internal HTTPS port on
 * 127.0.0.1) - the server only sees the encrypted bytes and the name (SNI).
 *
 * Per connection:
 *   -> "ALVMS1 <domain> <unix time> <random hex16> <hmac>\n"   hmac = HMAC-SHA256(key, "<domain>|<time>|<random>") hex
 *   <- "OK\n" (ready) | "ERR <text>\n"
 *   <- "P" while idle -> answer "p" at once
 *   <- "G<visitor ip>\n" + raw TLS of the visitor -> connect to the local TLS port and pipe both ways
 * After "G" nothing but payload; a replacement connection is opened at once.
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class RelayClient extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.server host of the relay server
     * @param {number} o.port its port (443)
     * @param {string} o.domain e.g. andreas-smartview.duckdns.org
     * @param {string} o.key
     * @param {number} o.local internal TLS port on 127.0.0.1
     */
    constructor({ server, port = 443, domain, key, local, log, pool = 8, idleMs = 90000 }) {
        super();
        Object.assign(this, { server, port, domain: String(domain).toLowerCase(), key, local, log, pool, idleMs });
        this.idle = new Set(); // ready connections
        this.pending = 0; // connecting / logging in
        this.visitors = new Map(); // local source port -> visitor ip
        this.backoff = 2000;
        this.served = 0;
        this.status = { state: 'starting', text: 'verbindet …' };
    }

    start() {
        this.running = true;
        this._fill();
    }

    stop() {
        this.running = false;
        clearTimeout(this.retry);
        for (const s of this.idle) {
            s.destroy();
        }
        this.idle.clear();
    }

    /** visitor address of a request on the internal TLS port (by its source port) */
    visitor(localPort) {
        return this.visitors.get(localPort) || '';
    }

    _set(state, text) {
        if (this.status.state !== state || this.status.text !== text) {
            this.status = { state, text };
            this.emit('status', this.status);
        }
    }

    _fill() {
        if (!this.running) {
            return;
        }
        while (this.idle.size + this.pending < this.pool) {
            this._open();
        }
    }

    _fail(why) {
        this._set('error', `nicht verbunden: ${why}`);
        if (this.running && !this.retry) {
            const wait = this.backoff;
            this.backoff = Math.min(this.backoff * 2, 30000);
            this.retry = setTimeout(() => {
                this.retry = null;
                this._fill();
            }, wait);
        }
    }

    _open() {
        this.pending++;
        const sock = net.connect(this.port, this.server);
        let stage = 'login'; // login -> idle -> piped
        let buf = Buffer.alloc(0);
        let timer = null;
        const alive = () => {
            clearTimeout(timer);
            timer = setTimeout(() => sock.destroy(new Error(`keine Antwort vom Server (${Math.round(this.idleMs / 1000)} s)`)), stage === 'login' ? 15000 : this.idleMs);
        };
        const leave = () => {
            if (stage === 'login') {
                this.pending--;
            } else if (stage === 'idle') {
                this.idle.delete(sock);
            }
        };
        sock.setNoDelay(true);
        sock.on('connect', () => {
            const ts = Math.floor(Date.now() / 1000);
            const nonce = crypto.randomBytes(8).toString('hex');
            const mac = crypto.createHmac('sha256', this.key).update(`${this.domain}|${ts}|${nonce}`).digest('hex');
            sock.write(`ALVMS1 ${this.domain} ${ts} ${nonce} ${mac}\n`);
            alive();
        });
        sock.on('data', chunk => {
            if (stage === 'piped') {
                return;
            }
            alive();
            buf = Buffer.concat([buf, chunk]);
            if (stage === 'login') {
                const nl = buf.indexOf(10);
                if (nl < 0) {
                    return;
                }
                const line = buf.subarray(0, nl).toString('utf8').trim();
                buf = buf.subarray(nl + 1);
                if (line !== 'OK') {
                    sock.destroy();
                    leave();
                    stage = 'dead';
                    return this._fail(line.replace(/^ERR\s*/, '') || 'Server lehnt ab');
                }
                this.pending--;
                stage = 'idle';
                this.idle.add(sock);
                this.backoff = 2000;
                this._set('on', `verbunden mit ${this.server}`);
            }
            while (stage === 'idle' && buf.length) {
                if (buf[0] === 0x50 /* P */) {
                    buf = buf.subarray(1);
                    sock.write('p');
                    continue;
                }
                if (buf[0] === 0x47 /* G */) {
                    const nl = buf.indexOf(10);
                    if (nl < 0) {
                        return; // wait for the rest of the line
                    }
                    const ip = buf.subarray(1, nl).toString('utf8').trim().slice(0, 64);
                    const rest = buf.subarray(nl + 1);
                    buf = Buffer.alloc(0);
                    clearTimeout(timer);
                    this.idle.delete(sock);
                    stage = 'piped';
                    this._visitor(sock, ip, rest);
                    this._fill(); // replacement at once, the browser opens more connections right away
                    return;
                }
                sock.destroy(new Error('unerwartete Daten vom Server'));
                return;
            }
        });
        sock.on('error', err => {
            sock.lastError = err;
        });
        sock.on('close', () => {
            clearTimeout(timer);
            const was = stage;
            leave();
            stage = 'dead';
            if (was === 'login' || was === 'idle') {
                const e = sock.lastError;
                const why = !e ? 'Verbindung vom Server getrennt' : e.code === 'ECONNREFUSED' ? `${this.server}:${this.port} lehnt ab (läuft dort der Relay-Dienst?)` : e.code === 'ENOTFOUND' ? `Server ${this.server} unbekannt` : e.message;
                if (was === 'login' || this.idle.size === 0) {
                    this._fail(why);
                } else {
                    this._fill();
                }
            }
        });
    }

    _visitor(sock, ip, first) {
        this.served++;
        // bytes of the visitor that arrive before the local connection is up
        const early = first.length ? [first] : [];
        const keep = c => early.push(c);
        sock.on('data', keep);
        const local = net.connect(this.local, '127.0.0.1');
        local.on('connect', () => {
            this.visitors.set(local.localPort, ip);
            sock.off('data', keep);
            for (const c of early) {
                local.write(c);
            }
            sock.pipe(local);
            local.pipe(sock);
        });
        const end = () => {
            this.visitors.delete(local.localPort);
            sock.destroy();
            local.destroy();
        };
        local.on('error', end);
        local.on('close', end);
        sock.on('close', end);
        sock.on('error', end);
    }
}

/** new key for the relay server: 24 random bytes, base64url */
function newKey() {
    return crypto.randomBytes(24).toString('base64url');
}

module.exports = { RelayClient, newKey };
