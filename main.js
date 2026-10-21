'use strict';

const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const utils = require('@iobroker/adapter-core');
const { LayoutStore, stateIds } = require('./lib/layout');
const { Push, triggers, fill } = require('./lib/push');
const { ensureCertificates } = require('./lib/certs');
const { SmartServer } = require('./lib/server');
const { IntercomProxy, baseFromUrl } = require('./lib/intercom');
const { UserStore } = require('./lib/users');
const { Timers } = require('./lib/timers');

const CAMERA_ID = /^livecam\.\d+\.cameras\.[^.]+$/;

/** GET an image (livecam snapshot), max 5 MB. */
function getBuffer(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        u.searchParams.set('fresh', '1');
        const req = (u.protocol === 'https:' ? https : http).get(u, { rejectUnauthorized: false, timeout: 10000 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > 5e6) {
                    req.destroy(new Error('too large'));
                } else {
                    chunks.push(c);
                }
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function localAddresses() {
    const list = [];
    for (const ifs of Object.values(os.networkInterfaces())) {
        for (const a of ifs || []) {
            if (a.family === 'IPv4' && !a.internal) {
                list.push(a.address);
            }
        }
    }
    return list;
}

class SmartView extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'smartview' });
        this.subscribed = new Set();
        this.liveStates = new Map(); // id -> {val, ack, ts, lc}
        this.meta = new Map(); // id -> {type, unit, min, max, states}
        this.pushPrev = new Map(); // id -> last value, for the push rules
        this.stateCache = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const dir = this.dataDir || utils.getAbsoluteInstanceDataDir(this);
        this.store = new LayoutStore(dir);
        this.push = new Push(dir, { log: this.log, sender: this.pushSender });
        this.users = new UserStore(dir);
        if (this.config.usersOff && this.users.enabled) {
            this.log.warn('SmartView: users are switched off in the instance settings - everybody can open and edit SmartView');
        }
        await this.setState('push.devices', this.push.count, true);

        // time switches of the tiles (location for sunrise/sunset from the ioBroker system settings)
        const sys = await this.getForeignObjectAsync('system.config').catch(() => null);
        const c = sys && sys.common;
        const location = c && c.latitude !== '' && c.latitude !== undefined && Number.isFinite(Number(c.latitude)) ? { latitude: Number(c.latitude), longitude: Number(c.longitude) } : null;
        this.timers = new Timers({
            dir,
            location,
            log: this.log,
            tile: key => this.tileByKey(key),
            fire: (tile, action, value, key, entry) => this.fireTimer(tile, action, value, entry),
        });
        this.timers.start();

        const port = Number(this.config.port) || 8098;
        const httpsPort = Number(this.config.httpsPort) || 8099;
        const useHttps = this.config.https !== false;
        const publicHost = String(this.config.publicHost || '').trim();
        const host = publicHost || localAddresses()[0] || '127.0.0.1';
        this.urlList = { http: `http://${host}:${port}/`, https: useHttps ? `https://${host}:${httpsPort}/` : '' };

        let certs = null;
        if (useHttps) {
            const names = [...localAddresses(), publicHost, os.hostname(), `${os.hostname()}.local`, 'localhost', '127.0.0.1'];
            try {
                certs = ensureCertificates(dir, names);
                if (certs.created) {
                    this.log.info('Created the SmartView certificate - install it once per device, see the page /zertifikat');
                } else if (certs.renewed) {
                    this.log.info('SmartView server certificate renewed (the installed CA stays valid)');
                }
            } catch (err) {
                this.log.error(`Cannot create the certificate, HTTPS is off: ${err.message}`);
            }
            // optional: certificate trusted by every device (Let's Encrypt via the acme adapter)
            this.certCollection = String(this.config.certCollection || '').trim();
            if (certs && this.certCollection) {
                certs.trusted = await this.loadCollection();
                if (certs.trusted) {
                    this.urlList.https = `https://${this.trustedHost(certs.trusted, publicHost)}:${httpsPort}/`;
                }
                this.subscribeForeignObjects('system.certificates');
            }
        }

        this.server = new SmartServer({
            intercom: new IntercomProxy({ target: () => this.intercomTarget(), log: this.log }),
            store: this.store,
            push: this.push,
            certs,
            accessKey: String(this.config.accessKey || '').trim(),
            allowEdit: this.config.allowEdit !== false,
            users: this.users,
            usersOff: Boolean(this.config.usersOff),
            log: this.log,
            adapter: {
                urls: () => this.urlList,
                stateInfo: id => this.stateInfo(id),
                setValue: (id, val) => this.setValue(id, val),
                objectList: fresh => this.objectList(fresh),
                stateValues: ids => this.stateValues(ids),
                cameras: () => this.cameras(),
                cameraUrl: (id, kind) => this.cameraUrl(id, kind),
                layoutChanged: () => this.resubscribe(),
                pushDevices: n => this.setState('push.devices', n, true),
                timers: () => ({ timers: this.timers.list(), sun: this.timers.sunToday(), location: Boolean(this.timers.location) }),
                setTimer: (key, timer) => this.timers.set(key, timer),
                telegramInstances: () => this.telegramInstances(),
                telegramTest: () => this.telegram({ title: this.store.layout.title || 'SmartView', body: 'Test-Mitteilung – Telegram funktioniert.' }),
            },
        });
        await this.resubscribe();

        let ok = false;
        try {
            await this.server.listen(port, false);
            ok = true;
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
        }
        if (certs) {
            try {
                await this.server.listen(httpsPort, true);
            } catch (err) {
                this.log.error(`Cannot open HTTPS port ${httpsPort}: ${err.message}`);
                this.urlList.https = '';
            }
        }
        const key = String(this.config.accessKey || '').trim();
        const q = key ? `?key=${encodeURIComponent(key)}` : '';
        await this.setState('info.url', this.urlList.http + q, true);
        await this.setState('info.httpsUrl', this.urlList.https ? this.urlList.https + q : '', true);
        await this.setState('info.certUrl', `${this.urlList.http}zertifikat`, true);
        await this.setState('info.connection', ok, true);
        this.log.info(`SmartView at ${this.urlList.http}${this.urlList.https ? ` and ${this.urlList.https}` : ''}`);
        this.subscribeStates('push.message');
        this.pingTimer = setInterval(() => this.server.ping(), 30000);
    }

    /** Certificate collection (acme adapter) from system.certificates; null if missing/expired. */
    async loadCollection() {
        const obj = await this.getForeignObjectAsync('system.certificates').catch(() => null);
        const c = obj && obj.native && obj.native.collections && obj.native.collections[this.certCollection];
        if (!c || !c.key || !c.cert) {
            this.log.warn(`Certificate collection "${this.certCollection}" not found (acme adapter set up?) - using the own SmartView certificate`);
            return null;
        }
        if (c.tsExpires && c.tsExpires < Date.now()) {
            this.log.warn(`Certificate collection "${this.certCollection}" expired - using the own SmartView certificate`);
            return null;
        }
        const chain = Array.isArray(c.chain) && c.chain.length ? c.chain.join('\n') : c.cert;
        const domains = Array.isArray(c.domains) ? c.domains.map(String) : [];
        if (c.staging) {
            this.log.warn(`Certificate collection "${this.certCollection}" is a Let's Encrypt staging (test) certificate - devices will not trust it`);
        }
        this.log.info(`HTTPS uses the certificate "${this.certCollection}" (${domains.join(', ')}), valid until ${c.tsExpires ? new Date(c.tsExpires).toLocaleDateString('de-DE') : '?'}`);
        return { cert: chain, key: c.key, domains, tsExpires: c.tsExpires || 0 };
    }

    /** Host name for the https address: the configured address if the certificate covers it. */
    trustedHost(trusted, publicHost) {
        const covers = name => trusted.domains.some(d => d === name || (d.startsWith('*.') && name.endsWith(d.slice(1)) && name.split('.').length === d.split('.').length));
        if (publicHost && covers(publicHost)) {
            return publicHost;
        }
        const name = trusted.domains.find(d => !d.startsWith('*.')) || publicHost || '127.0.0.1';
        if (publicHost) {
            this.log.warn(`The address ${publicHost} is not in the certificate (${trusted.domains.join(', ')}) - links use ${name}`);
        }
        return name;
    }

    async onObjectChange(id) {
        if (id === 'system.certificates' && this.certCollection && this.server && this.server.certs) {
            const trusted = await this.loadCollection();
            const old = this.server.certs.trusted;
            if (trusted && (!old || old.cert !== trusted.cert || old.key !== trusted.key)) {
                this.server.certs.trusted = trusted;
                this.server.updateCertificate();
                this.log.info('HTTPS certificate renewed by the acme adapter - in use without restart');
            }
        }
    }

    /** Subscribe the data points of the layout and of the push rules. */
    async resubscribe() {
        const layout = this.store.layout;
        const { read } = stateIds(layout);
        const ids = new Set([...read, ...layout.push.filter(r => r.enabled && r.state).map(r => r.state)]);
        if (layout.telegram.instance && layout.telegram.ring && this.ringStateId()) {
            ids.add(this.ringStateId());
        }
        for (const id of this.subscribed) {
            if (!ids.has(id)) {
                await this.unsubscribeForeignStatesAsync(id);
                this.subscribed.delete(id);
                this.liveStates.delete(id);
            }
        }
        for (const id of ids) {
            if (!this.subscribed.has(id)) {
                await this.subscribeForeignStatesAsync(id);
                this.subscribed.add(id);
                const st = await this.getForeignStateAsync(id).catch(() => null);
                this.liveStates.set(id, st ? { val: st.val, ack: st.ack, ts: st.ts, lc: st.lc } : null);
                this.pushPrev.set(id, st ? st.val : undefined);
            }
            await this.metaOf(id);
        }
        this.log.debug(`${ids.size} data point(s) subscribed`);
    }

    async metaOf(id) {
        if (!this.meta.has(id)) {
            const obj = await this.getForeignObjectAsync(id).catch(() => null);
            const c = (obj && obj.common) || {};
            if (!obj) {
                this.log.warn(`Data point ${id} does not exist`);
            }
            this.meta.set(id, { type: c.type || '', role: c.role || '', unit: c.unit || '', min: c.min, max: c.max, states: c.states && typeof c.states === 'object' ? c.states : undefined });
        }
        return this.meta.get(id);
    }

    stateInfo(id) {
        const st = this.liveStates.get(id);
        const m = this.meta.get(id) || {};
        const common = { unit: m.unit || '', type: m.type || '', role: m.role || '', min: m.min, max: m.max, states: m.states };
        return st ? { ...st, ...common } : { val: null, ...common, missing: !this.meta.has(id) || !m.type };
    }

    /** Command from the page: write with the type of the data point, as a command (ack = false). */
    async setValue(id, val) {
        const { type } = await this.metaOf(id);
        let v = val;
        if (type === 'boolean') {
            v = val === true || val === 1 || val === 'true' || val === '1' || val === 'on';
        } else if (type === 'number') {
            v = typeof val === 'boolean' ? (val ? 1 : 0) : Number(val);
            if (!Number.isFinite(v)) {
                throw new Error(`${id}: keine Zahl`);
            }
        } else if (type === 'string') {
            v = String(val);
        }
        this.log.debug(`set ${id} = ${v}`);
        await this.setForeignStateAsync(id, v, false);
    }

    async onStateChange(id, state) {
        if (id === `${this.namespace}.push.message`) {
            if (state && !state.ack && state.val !== null && state.val !== '') {
                await this.sendMessage(state.val);
                await this.setState('push.message', state.val, true);
            }
            return;
        }
        if (!this.subscribed.has(id)) {
            return;
        }
        this.liveStates.set(id, state ? { val: state.val, ack: state.ack, ts: state.ts, lc: state.lc } : null);
        if (this.server) {
            this.server.stateChanged(id, this.stateInfo(id));
        }
        const prev = this.pushPrev.get(id);
        const val = state ? state.val : null;
        this.pushPrev.set(id, val);
        for (const rule of this.store.layout.push) {
            if (rule.enabled && rule.state === id && triggers(rule, val, prev)) {
                const page = rule.page ? `./#${encodeURIComponent(rule.page)}` : './';
                const role = (this.meta.get(id) || {}).role;
                const title = fill(rule.title, val, role) || this.store.layout.title || 'SmartView';
                const body = fill(rule.text, val, role) || `${id}: ${fill('{value}', val, role)}`;
                this.log.info(`Push: ${title} - ${body}`);
                if (rule.via !== 'telegram') {
                    this.push.send({ title, body, url: page, tag: rule.id }).catch(err => this.log.warn(`Push: ${err.message}`));
                }
                if (rule.via !== 'app') {
                    this.telegram({ title, body, page: rule.page }).catch(err => this.log.warn(`Telegram: ${err.message}`));
                }
            }
        }
        if (id === this.ringStateId() && val && !prev && this.store.layout.telegram.ring) {
            this.telegramRing().catch(err => this.log.warn(`Telegram: ${err.message}`));
        }
    }

    /** Data point that says "it rings": from the layout, or the intercom's livecam instance. */
    ringStateId() {
        const r = this.store.layout.ring;
        return r.state || (r.intercom ? `${r.intercom}.intercom.ringing` : '');
    }

    /** Message through the telegram adapter (if chosen in the settings); link opens SmartView. */
    async telegram({ title, body, page = '' }) {
        const tg = this.store.layout.telegram;
        if (!tg.instance) {
            return false;
        }
        const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const key = String(this.config.accessKey || '').trim();
        const link = `${this.urlList.http}${key ? `?key=${encodeURIComponent(key)}` : ''}${page ? `#${encodeURIComponent(page)}` : ''}`;
        const msg = { text: `<b>${esc(title)}</b>\n${esc(body)}\n<a href="${esc(link)}">In SmartView öffnen</a>`, parse_mode: 'HTML', disable_web_page_preview: true };
        if (tg.users) {
            msg.user = tg.users;
        }
        return this.tgSend(tg.instance, msg);
    }

    /** sendTo the telegram adapter; resolves with its answer (number of users) or null after 15 s. */
    tgSend(instance, msg) {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(null), 15000);
            this.sendTo(instance, 'send', msg, res => {
                clearTimeout(timer);
                if (res === 0 || (res && res.error)) {
                    this.log.warn(`Telegram: not sent (${res && res.error ? res.error : 'no authenticated user - send /start to the bot first'})`);
                }
                resolve(res);
            });
        });
    }

    /** Doorbell: photo of the camera (or text only) through telegram. */
    async telegramRing() {
        const tg = this.store.layout.telegram;
        const ring = this.store.layout.ring;
        if (!tg.instance) {
            return;
        }
        const url = ring.camera ? await this.cameraUrl(ring.camera, 'jpg') : null;
        const photo = url ? await getBuffer(url).catch(err => this.log.warn(`Telegram: no camera picture (${err.message})`)) : null;
        const caption = `🔔 Es läutet – ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
        if (!photo) {
            await this.telegram({ title: '🔔 Es läutet', body: caption.slice(3) });
            return;
        }
        const msg = { text: photo, type: 'photo', caption };
        if (tg.users) {
            msg.user = tg.users;
        }
        this.log.info('Telegram: doorbell picture sent');
        await this.tgSend(tg.instance, msg);
    }

    /** push.message: plain text or JSON {title, text, page}. */
    async sendMessage(val) {
        let msg = { title: this.store.layout.title || 'SmartView', body: String(val), url: './' };
        try {
            const j = JSON.parse(String(val));
            if (j && typeof j === 'object') {
                msg = { title: String(j.title || msg.title), body: String(j.text || j.body || ''), url: j.page ? `./#${encodeURIComponent(j.page)}` : './' };
            }
        } catch {
            // plain text
        }
        const r = await this.push.send(msg);
        this.log.info(`Push sent to ${r.sent} device(s)${r.failed ? `, ${r.failed} failed` : ''}`);
        let page = '';
        try {
            page = String(JSON.parse(String(val)).page || '');
        } catch {
            // plain text
        }
        await this.telegram({ title: msg.title, body: msg.body, page }).catch(err => this.log.warn(`Telegram: ${err.message}`));
    }

    // ---------------- editor helpers ----------------

    async objectList(fresh) {
        if (fresh || !this.stateCache || Date.now() - this.stateCache.at > 300000) {
            const name = n => (typeof n === 'object' && n ? n.de || n.en || Object.values(n)[0] || '' : String(n || ''));
            const states = await this.getForeignObjectsAsync('*', 'state');
            const folders = {};
            for (const type of ['device', 'channel', 'folder', 'instance', 'adapter']) {
                const objs = await this.getForeignObjectsAsync('*', type).catch(() => ({}));
                for (const o of Object.values(objs || {})) {
                    if (o && o.type === type && o.common && o.common.name) {
                        folders[o._id] = name(o.common.name);
                    }
                }
            }
            this.stateCache = {
                at: Date.now(),
                folders,
                list: Object.values(states).map(o => {
                    const c = o.common || {};
                    return { id: o._id, name: name(c.name), type: c.type || '', role: c.role || '', unit: c.unit || '', write: c.write !== false };
                }),
            };
        }
        return this.stateCache;
    }

    async stateValues(ids) {
        const out = {};
        await Promise.all(
            ids.slice(0, 300).map(async id => {
                const st = await this.getForeignStateAsync(id).catch(() => null);
                out[id] = st ? st.val : null;
            }),
        );
        return out;
    }

    /** Tile for a timer key "pageId/tileId" of the saved layout. */
    tileByKey(key) {
        const [pageId, tileId] = String(key).split('/');
        const page = this.store.layout.pages.find(p => p.id === pageId);
        return (page && page.tiles.find(t => t.id === tileId)) || null;
    }

    /** A time switch is due: write like the buttons in the app do. */
    async fireTimer(tile, action, value, entry) {
        const when = entry.at === 'time' ? entry.time : `${entry.at === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}${entry.offset ? ` ${entry.offset > 0 ? '+' : ''}${entry.offset} min` : ''}`;
        this.log.info(`Timer "${tile.label || tile.id}" (${when}): ${action}${value !== undefined ? ` ${value} %` : ''}`);
        if (tile.type === 'switch') {
            const on = action === 'on';
            await this.setValue(tile.state, tile.invert ? !on : on);
        } else if (tile.type === 'dimmer') {
            const level = action === 'off' ? 0 : action === 'level' ? value : 100;
            if (tile.switchState) {
                await this.setValue(tile.switchState, level > 0);
            }
            if (tile.state && (level > 0 || !tile.switchState)) {
                await this.setValue(tile.state, level);
            }
        } else if (tile.type === 'blind') {
            const open = action === 'up' ? 100 : action === 'down' ? 0 : value;
            await this.setValue(tile.state, tile.closed100 ? 100 - open : open);
        }
    }

    /**
     * Address of the livecam instance chosen as intercom: from its camera URL states (they carry
     * host, port and access key), else from the instance settings (same host, configured port).
     */
    async intercomTarget() {
        const inst = this.store.layout.ring.intercom;
        if (!inst) {
            return null;
        }
        if (this.icTarget && this.icTarget.inst === inst && Date.now() - this.icTarget.at < 60000) {
            return this.icTarget.t;
        }
        let t = null;
        let why = '';
        // 1. all states below <inst>.cameras (one call, no pattern in the middle of the id)
        const states = await this.getForeignStatesAsync(`${inst}.cameras.*`).catch(err => {
            why = err.message;
            return {};
        });
        for (const [id, st] of Object.entries(states || {})) {
            if (/\.(snapshotUrl|mjpegUrl)$/.test(id) && st && (t = baseFromUrl(st.val))) {
                break;
            }
        }
        // 2. camera objects, then their URL states one by one
        if (!t) {
            const objs = await this.getForeignObjectsAsync(`${inst}.cameras.*`, 'state').catch(() => ({}));
            for (const id of Object.keys(objs || {}).filter(x => /\.snapshotUrl$/.test(x))) {
                const st = await this.getForeignStateAsync(id).catch(() => null);
                if (st && (t = baseFromUrl(st.val))) {
                    break;
                }
            }
        }
        // 3. instance settings: port (+ access key if readable), livecam on the same host
        if (!t) {
            const obj = await this.getForeignObjectAsync(`system.adapter.${inst}`).catch(() => null);
            if (obj && obj.native) {
                const port = Number(obj.native.port) || 8095;
                t = { base: `http://127.0.0.1:${port}`, key: String(obj.native.accessKey || '') };
                this.log.debug(`Intercom: no camera URL states of ${inst}, using port ${port} from its settings`);
            }
        }
        if (!t) {
            this.log.warn(
                `Intercom: ${inst} not found - no states ${inst}.cameras.*.snapshotUrl and no instance object${why ? ` (${why})` : ''}. Is livecam installed and running?`,
            );
        } else if (!this.icTarget || this.icTarget.inst !== inst || (this.icTarget.t && this.icTarget.t.base) !== t.base) {
            this.log.info(`Intercom: using ${inst} at ${t.base}`);
        }
        this.icTarget = { inst, t, at: Date.now() };
        return t;
    }

    async telegramInstances() {
        const objs = await this.getForeignObjectsAsync('system.adapter.telegram.*', 'instance').catch(() => ({}));
        return Object.keys(objs || {})
            .map(id => id.replace('system.adapter.', ''))
            .filter(id => /^telegram\.\d+$/.test(id))
            .sort();
    }

    /** Cameras of the livecam adapter. */
    async cameras() {
        const objs = await this.getForeignObjectsAsync('livecam.*', 'channel').catch(() => ({}));
        const name = n => (typeof n === 'object' && n ? n.de || n.en || Object.values(n)[0] || '' : String(n || ''));
        return Object.values(objs || {})
            .filter(o => o && CAMERA_ID.test(o._id))
            .map(o => ({ id: o._id, name: name(o.common && o.common.name) || o._id.split('.').pop() }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async cameraUrl(id, kind) {
        if (!CAMERA_ID.test(id)) {
            return null;
        }
        const st = await this.getForeignStateAsync(`${id}.${kind === 'mjpeg' ? 'mjpegUrl' : 'snapshotUrl'}`).catch(() => null);
        return st && typeof st.val === 'string' && /^https?:\/\//.test(st.val) ? st.val : null;
    }

    async onUnload(callback) {
        try {
            clearInterval(this.pingTimer);
            if (this.timers) {
                this.timers.stop();
            }
            if (this.server) {
                await this.server.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new SmartView(options);
} else {
    new SmartView();
}
