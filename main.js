'use strict';

const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const utils = require('@iobroker/adapter-core');
const { LayoutStore, stateIds } = require('./lib/layout');
const { Push, matches, triggers, fill } = require('./lib/push');
const { ensureCertificates } = require('./lib/certs');
const { SmartServer } = require('./lib/server');
const { IntercomProxy, baseFromUrl } = require('./lib/intercom');
const { UserStore } = require('./lib/users');
const { Timers } = require('./lib/timers');
const WinLogic = require('./www/winlogic');
const { CHOICES, LABELS, defaultType, cleanChoice, toDevice, devicesFor, toTile } = require('./lib/homekit');

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
        this.on('message', this.onMessage.bind(this));
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
                setValue: (id, val, opt) => this.setValue(id, val, opt),
                locks: () => this.lockInfo(),
                objectList: fresh => this.objectList(fresh),
                stateValues: ids => this.stateValues(ids),
                cameras: () => this.cameras(),
                cameraUrl: (id, kind) => this.cameraUrl(id, kind),
                webBase: () => this.webBase(),
                layoutChanged: async () => {
                    await this.resubscribe();
                    await this.syncHomekit();
                },
                homekit: () => this.homekitInfo(),
                energyInstances: () => this.instancesOf('energie'),
                chargerInstances: () => this.instancesOf('versicharge'),
                energyDay: (instance, date) => this.energyDay(instance, date),
                homekitDevices: () => this.homekitDevices(),
                pushDevices: n => this.setState('push.devices', n, true),
                timers: () => ({ timers: this.timers.list(), sun: this.timers.sunToday(), location: Boolean(this.timers.location) }),
                setTimer: (key, timer) => this.timers.set(key, timer),
                tileByKey: key => this.tileByKey(key),
                fillDetectors: layout => this.fillDetectors(layout),
                telegramInstances: () => this.telegramInstances(),
                whatsappInstances: () => this.instancesOf('whatsapp-cmb'),
                whatsappTest: () => this.whatsapp({ title: this.store.layout.title || 'SmartView', body: 'Test-Mitteilung – WhatsApp funktioniert.' }),
                telegramTest: () => this.telegram({ title: this.store.layout.title || 'SmartView', body: 'Test-Mitteilung – Telegram funktioniert.' }),
            },
        });
        await this.resubscribe();
        // homekit-easy: devices of tiles with "auch in HomeKit", again whenever homekit-easy (re)starts
        await this.subscribeForeignStatesAsync('system.adapter.homekit-easy.*.alive');
        this.hkTimer = setTimeout(() => this.syncHomekit(), 3000);

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
        this.pingTimer = setInterval(() => {
            this.server.ping();
            // window tiles with messages: "longer open than" is a matter of time, not of a state change
            this.checkWindows();
        }, 30000);
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
        const ids = new Set([...read, ...layout.push.filter(r => r.enabled && r.state).flatMap(r => [r.state, r.and && r.and.state].filter(Boolean))]);
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
        this.resetRules();
        // what is already open (too long) when starting is not reported again
        this.winMem = new Map();
        this.checkWindows(true);
        this.checkProtection();
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
    async setValue(id, val, { force = false } = {}) {
        // blinds locked by wind/rain: no commands from the page or the time switch
        const lock = force ? null : this.lockFor(id);
        if (lock) {
            throw new Error(`Gesperrt (${lock.reason}${lock.until ? `, noch ${Math.ceil((lock.until - Date.now()) / 60000)} min` : ''})`);
        }
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
        if (/^system\.adapter\.homekit-easy\.\d+\.alive$/.test(id)) {
            this.hkCache = null;
            if (state && state.val === true) {
                clearTimeout(this.hkTimer);
                this.hkTimer = setTimeout(() => this.syncHomekit(), 5000);
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
        this.checkRules(id, val, prev);
        if (this.winIds && this.winIds.has(id)) {
            this.checkWindows();
        }
        if (this.protectIds && this.protectIds.has(id)) {
            this.checkProtection();
        }
        if (id === this.ringStateId() && val && !prev) {
            if (this.store.layout.telegram.ring) {
                this.telegramRing().catch(err => this.log.warn(`Telegram: ${err.message}`));
            }
            if (this.store.layout.whatsapp.ring) {
                const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
                this.whatsapp({ title: '🔔 Es läutet', body: time }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
            }
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
        const link = this.appLink(page);
        const msg = { text: `<b>${esc(title)}</b>\n${esc(body)}\n<a href="${esc(link)}">In SmartView öffnen</a>`, parse_mode: 'HTML', disable_web_page_preview: true };
        if (tg.users) {
            msg.user = tg.users;
        }
        return this.tgSend(tg.instance, msg);
    }

    /** Link to SmartView for messages: https when it has a public certificate, else http. */
    appLink(page = '') {
        const trusted = this.server && this.server.certs && this.server.certs.trusted && this.urlList.https;
        const base = (trusted ? this.urlList.https : this.urlList.http).replace(/:443\/$/, '/');
        const key = String(this.config.accessKey || '').trim();
        return `${base}${key ? `?key=${encodeURIComponent(key)}` : ''}${page ? `#${encodeURIComponent(page)}` : ''}`;
    }

    /** Text through the whatsapp-cmb adapter (CallMeBot: text only, no pictures). */
    async whatsapp({ title, body, page = '' }) {
        const wa = this.store.layout.whatsapp;
        if (!wa.instance) {
            return false;
        }
        const msg = { text: `*${title}*\n${body}\n${this.appLink(page)}` };
        if (wa.phone) {
            msg.phone = wa.phone;
        }
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(null), 20000);
            this.sendTo(wa.instance, 'send', msg, res => {
                clearTimeout(timer);
                if (res && res.error) {
                    this.log.warn(`WhatsApp: not sent (${typeof res.error === 'string' ? res.error.slice(0, 200) : JSON.stringify(res.error)})`);
                    return resolve(false);
                }
                resolve(true);
            });
        });
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
    // ---------------- blinds/awnings: wind and rain protection ----------------

    /** Blind tiles with a wind or rain alarm: {key, page, tile}. */
    protectedBlinds() {
        const out = [];
        for (const p of this.store.layout.pages) {
            for (const t of p.tiles) {
                if (t.type === 'blind' && (t.windAlarm || t.rainAlarm)) {
                    out.push({ key: `${p.id}/${t.id}`, tile: t });
                }
            }
        }
        return out;
    }

    alarmOf(t) {
        const v = id => (this.liveStates.get(id) || {}).val;
        const num = x => (typeof x === 'boolean' ? Number(x) : Number(x));
        const isOn = x => x === true || x === 1 || x === 'true' || x === '1' || x === 'on';
        if (t.windAlarm) {
            const w = v(t.windAlarm);
            if (t.windMin ? num(w) >= t.windMin : isOn(w)) {
                return 'Windalarm';
            }
        }
        if (t.rainAlarm && isOn(v(t.rainAlarm))) {
            return 'Regenalarm';
        }
        return '';
    }

    /**
     * Alarm on: drive to the safe position once and lock; alarm off: stay locked for lockTime.
     * Called after every change of an alarm data point and after loading the layout.
     */
    checkProtection() {
        this.lockState = this.lockState || new Map();
        const list = this.protectedBlinds();
        this.protectIds = new Set(list.flatMap(b => [b.tile.windAlarm, b.tile.rainAlarm].filter(Boolean)));
        const keys = new Set(list.map(b => b.key));
        let changed = false;
        for (const key of [...this.lockState.keys()]) {
            if (!keys.has(key)) {
                clearTimeout(this.lockState.get(key).timer);
                this.lockState.delete(key);
                changed = true;
            }
        }
        for (const { key, tile } of list) {
            const reason = this.alarmOf(tile);
            const cur = this.lockState.get(key);
            if (reason && (!cur || cur.until || cur.reason !== reason)) {
                if (cur) {
                    clearTimeout(cur.timer);
                }
                const first = !cur || cur.until; // newly locked (not just another alarm on top)
                this.lockState.set(key, { reason, until: null, tile });
                changed = true;
                if (first && tile.protect !== 'none') {
                    this.log.info(`${tile.label || key}: ${reason} - ${tile.protect === 'down' ? 'down' : 'up'}, locked`);
                    this.driveSafe(tile).catch(err => this.log.warn(`${tile.label || key}: ${err.message}`));
                }
            } else if (!reason && cur && !cur.until) {
                const ms = (Number(tile.lockTime) || 0) * (tile.lockUnit === 's' ? 1000 : 60000);
                if (ms > 0) {
                    cur.until = Date.now() + ms;
                    cur.timer = setTimeout(() => {
                        this.lockState.delete(key);
                        this.log.info(`${tile.label || key}: unlocked`);
                        this.server && this.server.locksChanged(this.lockInfo());
                    }, ms);
                } else {
                    this.lockState.delete(key);
                }
                changed = true;
            }
        }
        if (changed && this.server) {
            this.server.locksChanged(this.lockInfo());
        }
    }

    async driveSafe(tile) {
        const open = tile.protect === 'down' ? 0 : 100;
        if ((await this.metaOf(tile.state)).type === 'boolean') {
            await this.setValue(tile.state, tile.closed100 ? open > 0 : open === 0, { force: true });
        } else {
            await this.setValue(tile.state, Boolean(tile.closed100) !== Boolean(tile.posInvert) ? 100 - open : open, { force: true });
        }
    }

    lockInfo() {
        const out = {};
        for (const [key, l] of this.lockState || []) {
            out[key] = { reason: l.reason, left: l.until ? Math.max(0, l.until - Date.now()) : null };
        }
        return out;
    }

    /** Lock of a blind whose data points include `id`. */
    lockFor(id) {
        for (const l of (this.lockState || new Map()).values()) {
            if (l.tile.state === id || l.tile.stop === id) {
                return l;
            }
        }
        return null;
    }

    // ---------------- push rules: condition, "länger als", "und zusätzlich" ----------------

    /** A watched data point changed: rules on it (or with it as second condition) are checked. */
    checkRules(id, val, prev) {
        for (const rule of this.store.layout.push) {
            if (!rule.enabled || !rule.state) {
                continue;
            }
            if (rule.cond === 'change') {
                if (rule.state === id && triggers(rule, val, prev) && this.andOk(rule)) {
                    this.fireRule(rule);
                }
            } else if (rule.state === id || (rule.and && rule.and.state === id)) {
                this.evalRule(rule);
            }
        }
    }

    andOk(rule) {
        return !rule.and || matches(rule.and, this.pushPrev.get(rule.and.state));
    }

    ruleActive(rule) {
        return matches(rule, this.pushPrev.get(rule.state)) && this.andOk(rule);
    }

    /** Fires when the rule becomes true - after `delay` minutes only if it stayed true all the time. */
    evalRule(rule) {
        this.ruleStates = this.ruleStates || new Map();
        const st = this.ruleStates.get(rule.id) || { active: false, timer: null };
        this.ruleStates.set(rule.id, st);
        const now = this.ruleActive(rule);
        if (now && !st.active) {
            if (rule.delay > 0) {
                clearTimeout(st.timer);
                st.timer = setTimeout(() => {
                    st.timer = null;
                    if (this.ruleActive(rule)) {
                        this.fireRule(rule);
                    }
                }, rule.delay * 60000);
            } else {
                this.fireRule(rule);
            }
        } else if (!now && st.timer) {
            clearTimeout(st.timer);
            st.timer = null;
        }
        st.active = now;
    }

    /** After loading the layout: rules start from the current values (nothing is sent for them). */
    resetRules() {
        for (const st of (this.ruleStates || new Map()).values()) {
            clearTimeout(st.timer);
        }
        this.ruleStates = new Map(this.store.layout.push.map(r => [r.id, { active: r.enabled && r.cond !== 'change' && Boolean(r.state) && this.ruleActive(r), timer: null }]));
    }

    fireRule(rule) {
        const val = this.pushPrev.get(rule.state);
        const page = rule.page ? `./#${encodeURIComponent(rule.page)}` : './';
        const role = (this.meta.get(rule.state) || {}).role;
        const title = fill(rule.title, val, role) || this.store.layout.title || 'SmartView';
        const body = fill(rule.text, val, role) || `${rule.state}: ${fill('{value}', val, role)}`;
        this.log.info(`Push: ${title} - ${body}`);
        if (rule.channels.app) {
            this.push.send({ title, body, url: page, tag: rule.id }).catch(err => this.log.warn(`Push: ${err.message}`));
        }
        if (rule.channels.telegram) {
            this.telegram({ title, body, page: rule.page }).catch(err => this.log.warn(`Telegram: ${err.message}`));
        }
        if (rule.channels.whatsapp) {
            this.whatsapp({ title, body, page: rule.page }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
        }
    }

    /**
     * Window tiles with "Mitteilung senden": a message (app push, Telegram, WhatsApp - as configured) when a window or
     * area is open longer than `warnMin`, and when "Warnen, wenn" becomes true while something is open.
     */
    checkWindows(initial = false) {
        this.winMem = this.winMem || new Map();
        this.winIds = new Set();
        const st = id => this.stateInfo(id);
        for (const page of this.store.layout.pages) {
            for (const t of page.tiles) {
                if (t.type !== 'windows' || !t.notify) {
                    continue;
                }
                for (const w of t.windows || []) {
                    [w.state, w.tilt].filter(Boolean).forEach(id => this.winIds.add(id));
                }
                if (t.warnWhen) {
                    this.winIds.add(t.warnWhen);
                }
                const key = `${page.id}/${t.id}`;
                const mem = this.winMem.get(key) || { long: new Set(), warn: false };
                this.winMem.set(key, mem);
                const list = WinLogic.states(t, st);
                const entries = WinLogic.entries(list);
                const what = e => (e.group ? `${e.label} (${e.detail})` : `${e.label} ${WinLogic.TEXT[e.status]}`);
                const title = t.label || 'Fenster';
                if (t.warnMin > 0) {
                    for (const e of entries) {
                        if (!WinLogic.active(e)) {
                            mem.long.delete(e.label);
                        } else if (e.ts && Date.now() - e.ts >= t.warnMin * 60000 && !mem.long.has(e.label)) {
                            mem.long.add(e.label);
                            if (!initial) {
                                this.notify(`${title}: zu lange offen`, `${what(e)} seit mehr als ${t.warnMin} Min.`, page.id);
                            }
                        }
                    }
                }
                const warn = WinLogic.warn(t, st, list);
                if (warn && !mem.warn && !initial) {
                    this.notify(`${title}: ${t.warnText || 'Achtung'}`, `Offen: ${entries.filter(WinLogic.active).map(what).join(', ')}`, page.id);
                }
                mem.warn = warn;
            }
        }
    }

    /**
     * Alarm tiles with "Melder anzeigen": the detectors of each area from the adapter of that area - NOX (inputs.N.area
     * from its export list, switch off/on via inputs.N.deactivated) or SPC (zones.N.area, no switching). Done on
     * saving the layout, so the data points are known (and writable) like any other.
     */
    async fillDetectors(layout) {
        for (const p of (layout && Array.isArray(layout.pages) ? layout.pages : [])) {
            for (const t of (p && Array.isArray(p.tiles) ? p.tiles : [])) {
                if (!t || t.type !== 'alarm') {
                    continue;
                }
                for (const a of [t, ...(Array.isArray(t.areas) ? t.areas : [])]) {
                    a.detectors = t.showDetectors ? await this.detectorsOf(String(a.area || '')) : [];
                }
            }
        }
    }

    async detectorsOf(area) {
        const m = /^([a-z][\w-]*\.\d+)\.areas\.(\d+)$/.exec(area);
        if (!m) {
            return [];
        }
        const [, inst, nr] = m;
        const spc = inst.startsWith('spc-edp.');
        const folder = spc ? 'zones' : 'inputs';
        const states = await this.getForeignStatesAsync(`${inst}.${folder}.*.area`).catch(() => ({}));
        const out = [];
        for (const [id, st] of Object.entries(states || {})) {
            if (!st || Number(st.val) !== Number(nr)) {
                continue;
            }
            const base = id.replace(/\.area$/, '');
            const obj = await this.getForeignObjectAsync(base).catch(() => null);
            const name = obj && obj.common && obj.common.name;
            out.push({
                label: (typeof name === 'object' ? name.de || name.en : name) || base.split('.').pop(),
                open: `${base}.open`,
                deact: spc ? '' : `${base}.deactivated`,
                nr: Number(base.split('.').pop()) || 0,
            });
        }
        out.sort((x, y) => x.nr - y.nr);
        return out.map(({ nr: _nr, ...d }) => d);
    }

    /** message on all configured ways (app push, Telegram, WhatsApp) */
    notify(title, body, page = '') {
        this.log.info(`Mitteilung: ${title} - ${body}`);
        this.push.send({ title, body, url: page ? `./#${encodeURIComponent(page)}` : './', tag: `win-${page}` }).catch(err => this.log.warn(`Push: ${err.message}`));
        this.telegram({ title, body, page }).catch(err => this.log.warn(`Telegram: ${err.message}`));
        this.whatsapp({ title, body, page }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
    }

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
        await this.whatsapp({ title: msg.title, body: msg.body, page }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
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
        if (tile.pinHash) {
            this.log.warn(`Timer "${tile.label || tile.id}" nicht ausgeführt: die Kachel ist mit PIN geschützt`);
            return;
        }
        const when = entry.at === 'time' ? entry.time : `${entry.at === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}${entry.offset ? ` ${entry.offset > 0 ? '+' : ''}${entry.offset} min` : ''}`;
        this.log.info(`Timer "${tile.label || tile.id}" (${when}): ${action}${value !== undefined ? ` ${value} %` : ''}`);
        if (tile.type === 'switch' || tile.type === 'climate') {
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
            if ((await this.metaOf(tile.state)).type === 'boolean') {
                // up/down object (KNX: false = up, true = down); "Auf/Ab umdrehen" swaps it
                await this.setValue(tile.state, tile.closed100 ? open > 0 : open === 0);
            } else {
                await this.setValue(tile.state, Boolean(tile.closed100) !== Boolean(tile.posInvert) ? 100 - open : open);
            }
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

    telegramInstances() {
        return this.instancesOf('telegram');
    }

    async instancesOf(adapter) {
        const objs = await this.getForeignObjectsAsync(`system.adapter.${adapter}.*`, 'instance').catch(() => ({}));
        return Object.keys(objs || {})
            .map(id => id.replace('system.adapter.', ''))
            .filter(id => new RegExp(`^${adapter}\\.\\d+$`).test(id))
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

    /** Address of the local ioBroker web adapter (VIS pictures), first running instance; cached 60 s. */
    async webBase() {
        if (this.webCache && Date.now() - this.webCache.at < 60000) {
            return this.webCache.base;
        }
        const objs = await this.getForeignObjectsAsync('system.adapter.web.*', 'instance').catch(() => ({}));
        const inst = Object.values(objs || {})
            .filter(o => o && o.common && o.native && /^system\.adapter\.web\.\d+$/.test(o._id))
            .sort((a, b) => Number(Boolean(b.common.enabled)) - Number(Boolean(a.common.enabled)) || a._id.localeCompare(b._id))[0];
        let base = '';
        if (inst) {
            const bind = String(inst.native.bind || '0.0.0.0');
            const host = bind === '0.0.0.0' || bind === '::' || !bind ? '127.0.0.1' : bind;
            base = `${inst.native.secure ? 'https' : 'http'}://${host}:${Number(inst.native.port) || 8082}`;
        }
        this.webCache = { at: Date.now(), base };
        return base;
    }

    async cameraUrl(id, kind) {
        if (!CAMERA_ID.test(id)) {
            return null;
        }
        const st = await this.getForeignStateAsync(`${id}.${kind === 'mjpeg' ? 'mjpegUrl' : 'snapshotUrl'}`).catch(() => null);
        return st && typeof st.val === 'string' && /^https?:\/\//.test(st.val) ? st.val : null;
    }

    /** day chart of the energie adapter (sendTo 'day'); {error} when it does not answer */
    energyDay(instance, date) {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve({ error: `${instance} antwortet nicht` }), 10000);
            this.sendTo(instance, 'day', { date }, res => {
                clearTimeout(timer);
                resolve(res && typeof res === 'object' ? res : { error: 'keine Antwort' });
            });
        });
    }

    // ---------------- homekit-easy (lib/homekit.js) ----------------

    /** First homekit-easy instance and whether it runs; cached 60 s. */
    async homekitInstance() {
        if (!this.hkCache || Date.now() - this.hkCache.at > 60000) {
            const [instance] = await this.instancesOf('homekit-easy');
            const alive = instance ? await this.getForeignStateAsync(`system.adapter.${instance}.alive`).catch(() => null) : null;
            this.hkCache = { at: Date.now(), instance: instance || '', running: Boolean(alive && alive.val) };
        }
        return this.hkCache;
    }

    /** sendTo homekit-easy; resolves with its answer or {error}. */
    async hkAsk(command, message) {
        const { instance, running } = await this.homekitInstance();
        if (!instance) {
            return { error: 'homekit-easy ist nicht installiert' };
        }
        if (!running) {
            return { error: `${instance} läuft nicht` };
        }
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve({ error: `${instance} antwortet nicht` }), 10000);
            this.sendTo(instance, command, message, res => {
                clearTimeout(timer);
                resolve(res && typeof res === 'object' ? res : { error: 'keine Antwort' });
            });
        });
    }

    /**
     * Tiles with "auch in HomeKit" -> devices in homekit-easy. Also sent with an empty list once the
     * last tick is gone, so homekit-easy removes what SmartView created.
     */
    async syncHomekit() {
        const devices = devicesFor(this.store.layout);
        if (!devices.length && !this.hkHad) {
            return null;
        }
        const res = await this.hkAsk('sync', { devices });
        this.hkLast = { at: Date.now(), devices: devices.length, ...res };
        if (res.error) {
            this.log.warn(`HomeKit: ${devices.length} device(s) not handed over - ${res.error}`);
        } else {
            this.hkHad = devices.length > 0;
            if (res.created || res.updated || res.removed) {
                this.log.info(`HomeKit: ${res.created} device(s) created, ${res.updated} updated, ${res.removed} removed in homekit-easy`);
            }
        }
        return this.hkLast;
    }

    /**
     * Messages from homekit-easy ("Aus SmartView übernehmen" in its setup page):
     *   tiles -> tiles that can be in Apple Home
     *   link {tiles: [{page, tile, homekit}]} -> tick "auch in Apple Home" on them, save, sync
     */
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        const reply = res => obj.callback && this.sendTo(obj.from, obj.command, res, obj.callback);
        const from = String(obj.from || '').replace(/^system\.adapter\./, '');
        if (!/^homekit-easy\.\d+$/.test(from)) {
            return reply({ error: `${obj.command} from ${from} not allowed` });
        }
        if (!this.store) {
            return reply({ error: 'SmartView startet noch' });
        }
        try {
            if (obj.command === 'tiles') {
                return reply({ tiles: this.homekitTiles() });
            }
            if (obj.command === 'link') {
                return reply(await this.linkTiles(obj.message && obj.message.tiles));
            }
            reply({ error: `unknown command ${obj.command}` });
        } catch (err) {
            this.log.warn(`Message ${obj.command} from ${from}: ${err.message}`);
            reply({ error: err.message });
        }
    }

    /** Tiles that could be in Apple Home, with the choices and whether they already are. */
    homekitTiles() {
        const out = [];
        for (const page of this.store.layout.pages) {
            for (const t of page.tiles) {
                const def = t.homekit || defaultType(t);
                if (!CHOICES[t.type] || !toDevice({ ...t, homekit: def }, page)) {
                    continue;
                }
                out.push({
                    page: page.id,
                    pageName: page.name,
                    tile: t.id,
                    label: t.label || LABELS[def],
                    homekit: t.homekit || '',
                    default: def,
                    choices: CHOICES[t.type].map(k => [k, LABELS[k]]),
                });
            }
        }
        return out;
    }

    async linkTiles(list) {
        const layout = JSON.parse(JSON.stringify(this.store.layout));
        let linked = 0;
        for (const x of Array.isArray(list) ? list : []) {
            const page = layout.pages.find(p => p.id === (x && x.page));
            const t = page && page.tiles.find(y => y.id === x.tile);
            if (t && CHOICES[t.type] && !t.homekit) {
                t.homekit = cleanChoice(t.type, x.homekit) || defaultType(t);
                linked++;
            }
        }
        if (!linked) {
            return { ok: true, linked: 0 };
        }
        this.store.save(layout);
        this.log.info(`homekit-easy: "auch in Apple Home" ticked on ${linked} tile(s)`);
        if (this.server) {
            this.server._broadcast({ type: 'layout' });
        }
        await this.resubscribe();
        const res = (await this.syncHomekit()) || {};
        return { ok: !res.error, linked, created: res.created || 0, error: res.error };
    }

    async homekitInfo() {
        const { instance, running } = await this.homekitInstance();
        return { instance, running, choices: CHOICES, labels: LABELS, last: this.hkLast || null };
    }

    /** Devices of homekit-easy that can become tiles (not the ones SmartView created itself). */
    async homekitDevices() {
        const res = await this.hkAsk('devices', {});
        if (res.error) {
            return res;
        }
        const types = res.types || {};
        return {
            devices: (res.devices || [])
                .filter(d => d && d.source !== this.namespace)
                .map(d => ({ id: d.id, name: d.name, type: d.type, typeLabel: types[d.type] || d.type, tile: toTile(d) })),
        };
    }

    async onUnload(callback) {
        try {
            clearInterval(this.pingTimer);
            clearTimeout(this.hkTimer);
            for (const st of [...(this.ruleStates || new Map()).values(), ...(this.lockState || new Map()).values()]) {
                clearTimeout(st.timer);
            }
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
