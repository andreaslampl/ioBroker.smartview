'use strict';

/*
 * Tailscale Funnel: makes SmartView reachable as https://<machine>.<tailnet>.ts.net from the internet without a port
 * on the router. Tailscale ends TLS and forwards to SmartView's internal HTTP port on 127.0.0.1 (everything there
 * counts as "from outside"). Controlled with the tailscale command line:
 *   tailscale status --json                      BackendState, Self.DNSName
 *   tailscale funnel status --json               already forwarding to us?
 *   tailscale funnel --bg --https=<p> <target>   switch on (p = 443, 8443 or 10000)
 *   tailscale funnel --https=<p> off             switch off
 * Never "tailscale funnel reset" - that would remove settings of other programs (e.g. the VMS).
 * The first time Tailscale prints a link (login.tailscale.com/f/…) to allow HTTPS / Funnel in the tailnet and waits;
 * we stop after `waitMs` and show the link.
 */

const { execFile, spawn } = require('node:child_process');

const PORTS = [443, 8443, 10000];

class Funnel {
    /**
     * @param {object} o
     * @param {string} [o.bin] tailscale command
     * @param {number} o.https public port (443 / 8443 / 10000)
     * @param {number} o.local internal HTTP port on 127.0.0.1
     */
    constructor({ bin = 'tailscale', https = 443, local, log, waitMs = 20000 }) {
        this.bin = bin;
        this.https = PORTS.includes(Number(https)) ? Number(https) : 443;
        this.local = local;
        this.log = log;
        this.waitMs = waitMs;
        this.status = { state: 'starting', text: 'wird eingeschaltet …' };
    }

    get target() {
        return `http://127.0.0.1:${this.local}`;
    }

    _run(args, timeout = 15000) {
        return new Promise(resolve => {
            execFile(this.bin, args, { timeout }, (err, stdout, stderr) => resolve({ err, out: String(stdout || ''), errText: String(stderr || '') }));
        });
    }

    _set(state, text, extra = {}) {
        this.status = { state, text, ...extra };
    }

    /** address for outside, '' while not known */
    get url() {
        return this.status.url || '';
    }

    /** check / switch on; returns the status */
    async start() {
        const st = await this._run(['status', '--json']);
        if (st.err && st.err.code === 'ENOENT') {
            this._set('error', 'Tailscale ist auf dem ioBroker-Rechner nicht installiert (tailscale.com/download/linux)');
            return this.status;
        }
        let info = null;
        try {
            info = JSON.parse(st.out);
        } catch {
            // nothing
        }
        if (!info || info.BackendState !== 'Running') {
            this._set('error', `Tailscale ist nicht angemeldet (${(info && info.BackendState) || 'unbekannt'}) – am ioBroker-Rechner „sudo tailscale up“ ausführen`);
            return this.status;
        }
        const host = String((info.Self && info.Self.DNSName) || '').replace(/\.$/, '');
        const url = host ? `https://${host}${this.https === 443 ? '' : `:${this.https}`}/` : '';
        if (await this._active()) {
            this._set('on', 'verbunden (Tailscale Funnel)', { url });
            return this.status;
        }
        const r = await this._enable();
        if (r.link) {
            this._set('approve', 'Tailscale wartet auf die Freischaltung von HTTPS / Funnel – Link öffnen, freischalten, dann „Erneut versuchen“', { link: r.link, url });
        } else if (await this._active()) {
            this.log.info(`SmartView: Fernzugang über Tailscale Funnel eingeschaltet: ${url}`);
            this._set('on', 'verbunden (Tailscale Funnel)', { url });
        } else if (/access denied|operator|permission/i.test(r.text)) {
            this._set('error', 'Keine Berechtigung – am ioBroker-Rechner einmal „sudo tailscale set --operator=iobroker“ ausführen');
        } else {
            this._set('error', `Funnel ließ sich nicht einschalten: ${r.text.trim().split('\n').pop() || 'unbekannter Fehler'}`);
        }
        return this.status;
    }

    async _active() {
        const r = await this._run(['funnel', 'status', '--json']);
        if (r.err) {
            return false;
        }
        let j = null;
        try {
            j = JSON.parse(r.out);
        } catch {
            return false;
        }
        // Web: {"<host>:<port>": {Handlers: {"/": {Proxy: "http://127.0.0.1:8111"}}}}, AllowFunnel: {"<host>:<port>": true}
        const web = (j && j.Web) || {};
        const allow = (j && j.AllowFunnel) || {};
        return Object.entries(web).some(([hp, v]) => hp.endsWith(`:${this.https}`) && allow[hp] && JSON.stringify(v).includes(`127.0.0.1:${this.local}`));
    }

    /** "tailscale funnel --bg" may wait for an approval in the browser: stop after waitMs, report the link */
    _enable() {
        return new Promise(resolve => {
            let text = '';
            let done = false;
            const p = spawn(this.bin, ['funnel', '--bg', `--https=${this.https}`, this.target], { stdio: ['ignore', 'pipe', 'pipe'] });
            const finish = () => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                const m = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
                if (p.exitCode === null) {
                    p.kill();
                }
                resolve({ link: m ? m[0] : '', text });
            };
            const timer = setTimeout(finish, this.waitMs);
            const add = c => {
                text += c;
                if (/https:\/\/login\.tailscale\.com\/\S+\s/.test(text)) {
                    finish();
                }
            };
            p.stdout.on('data', add);
            p.stderr.on('data', add);
            p.on('error', err => {
                text += err.message;
                finish();
            });
            p.on('exit', finish);
        });
    }

    async stop() {
        if (await this._active()) {
            await this._run(['funnel', `--https=${this.https}`, 'off']);
            this.log.info('SmartView: Tailscale Funnel ausgeschaltet');
        }
        this._set('off', 'aus');
    }
}

module.exports = { Funnel, PORTS };
