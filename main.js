'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const utils = require('@iobroker/adapter-core');
const { LayoutStore, stateIds, tileWriteIds } = require('./lib/layout');
const { pinHashesFor, pinSig } = require('./lib/pin');
const { Push, matches, triggers, fill } = require('./lib/push');
const { ensureCertificates } = require('./lib/certs');
const { SmartServer } = require('./lib/server');
const { IntercomProxy, baseFromUrl } = require('./lib/intercom');
const { UserStore } = require('./lib/users');
const { Timers } = require('./lib/timers');
const WinLogic = require('./www/winlogic');
const SceneLogic = require('./www/scenelogic');
const RefLogic = require('./www/reflogic');
const AppLogic = require('./www/applogic');
const { ColorLights } = require('./lib/colorlight');
const { SwitchCtl } = require('./lib/switchctl');
const RobotLogic = require('./www/robotlogic');
const CarLogic = require('./www/carlogic');
const { sunTimes } = require('./lib/sun');
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
        // household appliances: Aus / Läuft / Fertig survives restarts (laundry still in the drum)
        this.appFile = path.join(dir, 'appliances.json');
        this.appMem = new Map();
        try {
            for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.appFile, 'utf8')))) {
                this.appMem.set(k, v);
            }
        } catch {
            // first start
        }
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
            fire: (tile, action, value, key, entry) => this.fireTimer(tile, action, value, entry, key),
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
                    await this.webBase().catch(() => '');
        await this.resubscribe();
                    await this.syncHomekit();
                },
                homekit: () => this.homekitInfo(),
                energyInstances: () => this.instancesOf('energie'),
                chargerInstances: () => this.instancesOf('versicharge'),
                fc20Instances: () => this.instancesOf('fc20-cerberus-bacnet'),
                robotDevices: () => this.robotDevices(),
                carDevices: () => this.carDevices(),
                energyDay: (instance, date) => this.energyDay(instance, date),
                homekitDevices: () => this.homekitDevices(),
                pushDevices: n => this.setState('push.devices', n, true),
                timers: () => ({ timers: this.timers.list(), sun: this.timers.sunToday(), location: Boolean(this.timers.location) }),
                setTimer: (key, timer, sig) => this.timers.set(key, timer, sig),
                tileByKey: key => this.tileByKey(key),
                scenePlan: tile => this.scenePlan(tile),
                dnd: () => this.dndInfo(),
                appliances: () => this.appStatus(),
                appAck: key => this.appAck(key),
                colors: () => this.colorLights().status(),
                pending: () => this.switchCtl().status(),
                webInfo: () => this.webInfo(),
                colorCommand: (key, action, arg, source) => this.colorLights().command(key, action, arg, source),
                ringing: () => {
                    const st = this.liveStates.get(this.ringStateId());
                    return Boolean(st && SceneLogic.truthy(st.val));
                },
                setDnd: on => this.setDnd(on),
                runScene: (tile, page, opts) => this.runScene(tile, page, opts),
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
        this.subscribeStates('scenes.*');
        this.subscribeStates('ring.dnd');
        const dnd = await this.getStateAsync('ring.dnd').catch(() => null);
        this.dndSwitch = Boolean(dnd && dnd.val);
        this.checkDnd();
        this.dndTimer = setInterval(() => this.checkDnd(), 30000);
        this.pingTimer = setInterval(() => {
            this.server.ping();
            // window tiles with messages: "longer open than" is a matter of time, not of a state change
            this.checkWindows();
            // appliances: "below the threshold for x minutes" / "Fertig" timeout are matters of time too
            this.checkAppliances();
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
        const { read } = stateIds(RefLogic.resolveAll(layout));
        const ids = new Set([...read, ...layout.push.filter(r => r.enabled && r.state).flatMap(r => [r.state, r.and && r.and.state].filter(Boolean))]);
        // the doorbell state: for Telegram / WhatsApp and /api/ring (monitor wake-up script)
        if (this.ringStateId()) {
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
        this.checkClimate();
        this.checkGates();
        this.checkAppliances(true);
        this.checkAlarmPush(true);
        this.colorLights().update(this.colorTiles());
        this.switchCtl().update(this.ctlTiles());
        await this.sceneStates().catch(err => this.log.warn(`Szenen-Datenpunkte: ${err.message}`));
        this.checkDnd(); // the time window may have changed
    }

    // ---------------- do not disturb (no ring tone) ----------------

    /** on by the switch ring.dnd, or within the time window of the settings (also over midnight, 22:00-07:00) */
    dndInfo(now = new Date()) {
        const r = this.store.layout.ring;
        let window = false;
        if (r.dndFrom && r.dndTo && r.dndFrom !== r.dndTo) {
            const min = s => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
            const t = now.getHours() * 60 + now.getMinutes();
            const from = min(r.dndFrom);
            const to = min(r.dndTo);
            window = from < to ? t >= from && t < to : t >= from || t < to;
        }
        return { on: Boolean(this.dndSwitch) || window, manual: Boolean(this.dndSwitch), window, from: r.dndFrom, to: r.dndTo };
    }

    checkDnd() {
        const d = this.dndInfo();
        if (d.on !== this.dndLast) {
            if (this.dndLast !== undefined) {
                this.log.info(`Nicht stören ${d.on ? 'an' : 'aus'}${d.window && !d.manual ? ` (Zeitfenster ${d.from}-${d.to})` : ''}`);
            }
            this.dndLast = d.on;
            this.setState('ring.dndActive', d.on, true).catch(() => {});
        }
        if (this.server) {
            this.server.dndChanged(d);
        }
    }

    async setDnd(on) {
        this.dndSwitch = Boolean(on);
        await this.setState('ring.dnd', this.dndSwitch, true);
        this.checkDnd();
    }

    // ---------------- gates: close automatically after some minutes open ----------------

    /** open | closed | moving | unknown from the end positions (same as the page's gateStatus) */
    gateStatus(t) {
        const v = id => (this.liveStates.get(id) || {}).val;
        const known = id => id && v(id) !== null && v(id) !== undefined;
        const on = id => SceneLogic.truthy(v(id));
        if (!known(t.posOpen) && !known(t.posClosed)) {
            return 'unknown';
        }
        if (known(t.posOpen) && on(t.posOpen)) {
            return 'open';
        }
        if (known(t.posClosed) && on(t.posClosed)) {
            return 'closed';
        }
        if (t.posOpen && t.posClosed) {
            return 'moving';
        }
        return t.posOpen ? 'closed' : 'open';
    }

    /** the close command like the page's "Zu" button (level false, impulse, or the close data point) */
    /** open command like the "Auf" button (level: true, impulse: true then false after 1 s) */
    async gateOpen(t) {
        const single = t.gateMode === 'single';
        const id = single ? t.state : t.open;
        if (!id) {
            throw new Error('kein Datenpunkt für „Auf“');
        }
        await this.setValue(id, true);
        if (single ? t.single === 'impulse' : t.impulse) {
            setTimeout(() => this.setValue(id, false, { force: true }).catch(() => {}), 1000);
        }
    }

    /**
     * Time switch of a gate tile, with the checks of the buttons: nothing when it already is open / closed; an impulse
     * (one data point, direction unknown) only with a known end position; closing only with the tick "Lichtschranke"
     * (`autoSafe`, like "automatisch schließen") and not while the light barrier is interrupted.
     */
    async gateTimer(t, action) {
        const name = t.label || t.id;
        const stt = this.gateStatus(t);
        const close = action === 'close';
        if (close && !t.autoSafe) {
            this.log.warn(`Timer "${name}": Zu nicht ausgeführt – automatisch schließen nur mit dem Haken „Antrieb hat Lichtschranke / Schließkantensicherung“`);
            return;
        }
        if ((close && stt === 'closed') || (!close && stt === 'open')) {
            this.log.info(`Timer "${name}": schon ${close ? 'zu' : 'offen'}, nichts gesendet`);
            return;
        }
        if (t.gateMode === 'single' && t.single === 'impulse' && (stt === 'unknown' || stt === 'moving')) {
            this.log.warn(`Timer "${name}": Stellung unbekannt – ein Impuls könnte in die falsche Richtung fahren, nichts gesendet`);
            return;
        }
        if (close && this.gateBlocked(t)) {
            this.log.warn(`Timer "${name}": Lichtschranke unterbrochen, nicht geschlossen`);
            return;
        }
        await (close ? this.gateClose(t) : this.gateOpen(t));
    }

    async gateClose(t) {
        const single = t.gateMode === 'single';
        const id = single ? t.state : t.close;
        if (!id) {
            throw new Error('kein Datenpunkt für „Zu“');
        }
        if (single && t.single === 'level') {
            return this.setValue(id, false);
        }
        await this.setValue(id, true);
        if (single ? t.single === 'impulse' : t.impulse) {
            setTimeout(() => this.setValue(id, false, { force: true }).catch(() => {}), 1000);
        }
    }

    /**
     * Gate tiles with "automatisch schließen nach": a timer starts when the gate is open and is cleared when it is not;
     * when it runs out the gate gets one close command, 2 min later a warning if it is still not closed.
     */
    checkGates() {
        this.gateTimers = this.gateTimers || new Map();
        const list = [];
        for (const p of this.store.layout.pages) {
            for (const t of p.tiles) {
                // only with the tick "Antrieb hat Lichtschranke / Schließkantensicherung"
                if (t.type === 'gate' && t.autoClose > 0 && t.autoSafe && (t.posOpen || t.posClosed)) {
                    list.push({ key: `${p.id}/${t.id}`, page: p, tile: t });
                }
            }
        }
        this.gateIds = new Set(list.flatMap(g => [g.tile.posOpen, g.tile.posClosed, g.tile.barrier].filter(Boolean)));
        const keys = new Set(list.map(g => g.key));
        for (const [key, g] of this.gateTimers) {
            if (!keys.has(key)) {
                clearTimeout(g.timer);
                this.gateTimers.delete(key);
            }
        }
        const minute = this.gateMinute || 60000; // tests shorten the minute
        for (const { key, page, tile } of list) {
            const open = this.gateStatus(tile) === 'open';
            const cur = this.gateTimers.get(key);
            if (!open) {
                if (cur) {
                    clearTimeout(cur.timer);
                    this.gateTimers.delete(key);
                }
                continue;
            }
            if (cur) {
                // time is up but the light barrier was interrupted: close as soon as it is free
                if (cur.due && !this.gateBlocked(tile)) {
                    cur.due = false;
                    cur.close();
                }
                continue;
            }
            const name = tile.label || 'Tor';
            const entry = {};
            entry.close = async () => {
                if (this.gateStatus(tile) !== 'open') {
                    return;
                }
                if (this.gateBlocked(tile)) {
                    if (!entry.due) {
                        this.log.info(`${name}: Lichtschranke unterbrochen - schließt, sobald sie frei ist`);
                    }
                    entry.due = true;
                    return;
                }
                this.log.info(`${name}: seit ${tile.autoClose} min offen - wird geschlossen`);
                try {
                    await this.gateClose(tile);
                    if (tile.autoNotify) {
                        this.notify(name, `War ${tile.autoClose} min offen – wird automatisch geschlossen`, page.id, '', tile.channels);
                    }
                } catch (err) {
                    this.log.warn(`${name}: ${err.message}`);
                }
                const check = setTimeout(() => {
                    if (this.gateStatus(tile) !== 'closed') {
                        this.log.warn(`${name}: automatisch schließen - ist nach 2 min nicht zu`);
                        if (tile.autoNotify) {
                            this.notify(`${name}: schließt nicht`, 'Nach dem automatischen Schließen ist es nicht zu – bitte nachsehen.', page.id, '', tile.channels);
                        }
                    }
                }, this.gateCheckMs || 120000);
                entry.timer = check;
            };
            entry.timer = setTimeout(entry.close, tile.autoClose * minute);
            this.gateTimers.set(key, entry);
        }
    }

    /** light barrier interrupted (true = interrupted, unless "umgekehrt"); unknown = not blocked */
    gateBlocked(t) {
        if (!t.barrier) {
            return false;
        }
        const v = (this.liveStates.get(t.barrier) || {}).val;
        if (v === null || v === undefined) {
            return false;
        }
        return Boolean(t.barrierInvert) !== SceneLogic.truthy(v);
    }

    // ---------------- "Haus verlassen" / "Ankommen" (www/scenelogic.js) ----------------

    /** dark now (before sunrise / after sunset); undefined without a location in the system settings */
    isDark(now = Date.now()) {
        const loc = this.timers && this.timers.location;
        if (!loc) {
            return undefined;
        }
        const { rise, set } = sunTimes(now, loc.latitude, loc.longitude);
        return now < rise || now >= set;
    }

    scenePlan(tile, { external = false } = {}) {
        const tiles = this.store.layout.pages.flatMap(p => p.tiles);
        const locked = x => {
            const l = this.lockFor(x.state);
            return l ? l.reason : '';
        };
        return SceneLogic.plan(tile, tiles, id => this.stateInfo(id), { locked, dark: this.isDark(), external });
    }

    /**
     * Runs a leave / arrive tile: commands now, blinds + alarm after `delayMin` (leave), message, check that the alarm
     * armed. `allowed` limits the data points (the user's write rights), `source` is logged.
     */
    async runScene(tile, pageId, { source = '', allowed = null, external = false } = {}) {
        const key = `${pageId}/${tile.id}`;
        const name = tile.label || (tile.type === 'leave' ? 'Haus verlassen' : 'Ankommen');
        this.scenePending = this.scenePending || new Map();
        // a new run of the same button, or coming home, ends what is still waiting
        for (const [k, timer] of this.scenePending) {
            if (k === key || k === `${key}#alarm` || tile.type === 'arrive') {
                clearTimeout(timer);
                this.scenePending.delete(k);
                this.log.info(`${name}: verzögerte Befehle von ${k} abgebrochen`);
            }
        }
        const plan = this.scenePlan(tile, { external });
        const ok = id => !allowed || allowed.has(id);
        const exec = map => Promise.all([...map].filter(([id]) => ok(id)).map(([id, v]) => this.setValue(id, v).catch(err => this.log.warn(`${name}: ${id}: ${err.message}`))));
        const text = plan.groups.map(([g, n]) => `${g} (${n})`).join(', ') || 'nichts zu tun';
        this.log.info(`${name}${source ? ` (${source})` : ''}: ${text}${plan.warn.length ? ` - ${plan.warn.join('; ')}` : ''}`);
        await exec(plan.now);
        const minute = this.sceneMinute || 60000; // tests shorten the minute
        const delay = plan.later.size ? tile.delayMin * minute : 0;
        if (plan.later.size) {
            this.scenePending.set(key, setTimeout(() => {
                this.scenePending.delete(key);
                this.log.info(`${name}: nach ${tile.delayMin} min - ${plan.later.size} Befehl(e)`);
                exec(plan.later).catch(() => {});
            }, delay));
        }
        // own delay of the alarm system (pending under its own key, "Ankommen" cancels it like the rest)
        const alarmDelay = plan.alarmLater.size ? Number(tile.alarmDelayMin) * minute : 0;
        if (plan.alarmLater.size) {
            this.scenePending.set(`${key}#alarm`, setTimeout(() => {
                this.scenePending.delete(`${key}#alarm`);
                this.log.info(`${name}: nach ${tile.alarmDelayMin} min - Alarmanlage scharf`);
                exec(plan.alarmLater).catch(() => {});
            }, alarmDelay));
        }
        if (tile.notify) {
            this.notify(name, text + (plan.warn.length ? `\n${plan.warn.join('\n')}` : ''), pageId, '', tile.channels);
        }
        // did the alarm system arm? (90 s after the command, the NOX / SPC need a moment)
        if (tile.type === 'leave' && plan.alarm.length) {
            const when = plan.alarmLater.size ? alarmDelay : plan.later.size && !(tile.alarmDelayMin > 0 || tile.alarmDelayMin === 0) ? delay : 0;
            const timer = setTimeout(() => {
                this.scenePending.delete(`${key}#check`);
                const notArmed = plan.alarm.filter(a => {
                    const v = (this.liveStates.get(a.status) || {}).val;
                    return a.status && String(v) !== String(a.value);
                });
                if (notArmed.length) {
                    const what = notArmed.map(a => a.label).join(', ');
                    this.log.warn(`${name}: Alarmanlage NICHT scharf - ${what}`);
                    if (tile.notify || tile.alarmNotify) {
                        this.notify(`${name}: Alarmanlage NICHT scharf`, what, pageId, `alarm-${key}`, tile.channels);
                    }
                } else {
                    const what = plan.alarm.map(a => a.label).join(', ');
                    this.log.info(`${name}: Alarmanlage scharf - ${what}`);
                    if (tile.alarmNotify) {
                        this.notify(`${name}: Alarmanlage scharf ✓`, what, pageId, `alarm-${key}`, tile.channels);
                    }
                }
            }, when + (this.sceneCheckMs || 90000));
            timer.unref?.();
            this.scenePending.set(`${key}#check`, timer);
        }
        return { text, warn: plan.warn, delayed: plan.later.size ? tile.delayMin : 0, alarmDelayed: plan.alarmLater.size ? tile.alarmDelayMin : 0 };
    }

    /** smartview.N.scenes.<page>_<tile> (button) for leave / arrive tiles with "von außen auslösbar" */
    async sceneStates() {
        const want = new Map();
        for (const p of this.store.layout.pages) {
            for (const t of p.tiles) {
                if ((t.type === 'leave' || t.type === 'arrive') && t.external) {
                    want.set(`${this.namespace}.scenes.${p.id}_${t.id}`, { page: p, tile: t });
                }
            }
        }
        const have = await this.getForeignObjectsAsync(`${this.namespace}.scenes.*`, 'state').catch(() => ({}));
        for (const id of Object.keys(have || {})) {
            if (!want.has(id)) {
                await this.delForeignObjectAsync(id).catch(() => {});
            }
        }
        for (const [id, { page, tile }] of want) {
            const name = tile.label || (tile.type === 'leave' ? 'Haus verlassen' : 'Ankommen');
            await this.extendForeignObjectAsync(id, {
                type: 'state',
                common: { name: `${name} (${page.name})`, type: 'boolean', role: 'button', read: true, write: true, def: false },
                native: {},
            });
        }
        this.sceneIds = want;
    }

    /** dehumidifier automatic: mean humidity of the tile's rooms (else its own humidity) */
    climateTiles() {
        const out = [];
        for (const p of this.store.layout.pages) {
            for (const t of p.tiles) {
                if (t.type === 'climate' && t.auto && t.state && Number.isFinite(t.autoOn) && Number.isFinite(t.autoOff) && t.autoOff < t.autoOn) {
                    const ids = (t.sensors || []).map(r => r.humidity).filter(Boolean);
                    out.push({ key: `${p.id}/${t.id}`, tile: t, ids: ids.length ? ids : [t.humidity].filter(Boolean) });
                }
            }
        }
        return out;
    }

    /**
     * On when the mean humidity reaches `autoOn`, off when it falls to `autoOff`. Only when the band is crossed (and once
     * after the start), so switching by hand in between stays as it is.
     */
    checkClimate() {
        this.climZone = this.climZone || new Map();
        const list = this.climateTiles();
        this.climIds = new Set(list.flatMap(c => c.ids));
        for (const { key, tile, ids } of list) {
            const vals = ids
                .map(id => {
                    const raw = (this.liveStates.get(id) || {}).val;
                    return raw === null || raw === undefined || raw === '' ? NaN : Number(String(raw).replace(',', '.'));
                })
                .filter(Number.isFinite);
            if (!vals.length) {
                continue;
            }
            const mean = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
            const zone = mean >= tile.autoOn ? 'high' : mean <= tile.autoOff ? 'low' : 'mid';
            if (zone === this.climZone.get(key)) {
                continue;
            }
            this.climZone.set(key, zone);
            if (zone === 'mid') {
                continue;
            }
            const fb = (this.liveStates.get(tile.status || tile.state) || {}).val;
            const on = fb === null || fb === undefined ? null : Boolean(tile.invert) !== (fb === true || fb === 1 || fb === 'true' || fb === 'on');
            const want = zone === 'high';
            if (on === want) {
                continue;
            }
            this.log.info(`${tile.label || key}: Luftfeuchte ${String(mean).replace('.', ',')} % (${want ? `ab ${tile.autoOn}` : `bis ${tile.autoOff}`} %) - ${want ? 'ein' : 'aus'}`);
            this.setValue(tile.state, tile.invert ? !want : want).catch(err => this.log.warn(`${tile.label || key}: ${err.message}`));
        }
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

    switchCtl() {
        if (!this.swCtl) {
            this.swCtl = new SwitchCtl({
                write: (id, val) => this.setValue(id, val, { force: true, raw: true }),
                value: id => {
                    const st = this.liveStates.get(id);
                    return st ? st.val : undefined;
                },
                log: this.log,
                changed: status => this.server && this.server.pendingChanged && this.server.pendingChanged(status),
            });
        }
        return this.swCtl;
    }

    /** switch / dimmer / blind tiles of the saved layout (extras: also, delays, auto off) */
    ctlTiles() {
        const list = [];
        for (const page of this.store.layout.pages) {
            for (const tile of page.tiles) {
                if (['switch', 'dimmer', 'blind'].includes(tile.type)) {
                    list.push({ key: `${page.id}/${tile.id}`, tile });
                }
                // switch entries (central functions) with only true / only false / push button
                (tile.type === 'switch' ? tile.entries || [] : []).forEach((e, i) => {
                    if (e.sendMode) {
                        const sub = { type: 'switch', label: e.label, state: e.state, status: e.status, sendMode: e.sendMode, invert: tile.invert, pushTime: tile.pushTime };
                        list.push({ key: `${page.id}/${tile.id}#${i + 1}`, tile: sub });
                    }
                });
            }
        }
        return list;
    }

    /** Command from the page: write with the type of the data point, as a command (ack = false). */
    async setValue(id, val, { force = false, raw = false, hold = false } = {}) {
        // blinds locked by wind/rain: no commands from the page or the time switch
        const lock = force ? null : this.lockFor(id);
        if (lock) {
            throw new Error(`Gesperrt (${lock.reason}${lock.until ? `, noch ${Math.ceil((lock.until - Date.now()) / 60000)} min` : ''})`);
        }
        // tiles with more data points / delays / auto off: carried out by SwitchCtl (which writes back with raw)
        if (!raw && this.swCtl && this.swCtl.handles(id)) {
            return this.swCtl.command(id, val, { hold });
        }
        const { type } = await this.metaOf(id);
        let v = val;
        if (type === 'boolean') {
            // a level (dimmer) to an on/off data point: on above 0
            v = typeof val === 'number' ? val > 0 : val === true || val === 'true' || val === '1' || val === 'on';
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
        if (id === `${this.namespace}.ring.dnd`) {
            if (state && !state.ack) {
                this.setDnd(SceneLogic.truthy(state.val)).catch(() => {});
            }
            return;
        }
        if (this.sceneIds && this.sceneIds.has(id)) {
            if (state && !state.ack && SceneLogic.truthy(state.val)) {
                const { page, tile } = this.sceneIds.get(id);
                this.runScene(tile, page.id, { source: `ioBroker ${state.from || ''}`.trim(), external: true }).catch(err => this.log.warn(`${tile.label || id}: ${err.message}`));
                this.setForeignStateAsync(id, false, true).catch(() => {});
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
        // a data point that did not exist yet (e.g. roomba creates its objects only after connecting): read its object now
        if (state && this.meta.has(id) && !this.meta.get(id).type) {
            this.meta.delete(id);
            await this.metaOf(id).catch(() => {});
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
        if (this.climIds && this.climIds.has(id)) {
            this.checkClimate();
        }
        if (this.gateIds && this.gateIds.has(id)) {
            this.checkGates();
        }
        if (this.appIds && this.appIds.has(id)) {
            this.checkAppliances();
        }
        if (this.alarmPushIds && this.alarmPushIds.has(id)) {
            this.checkAlarmPush();
        }
        if (this.colors) {
            // own writes (feedback, color changer) are no button presses
            this.colors.onState(id, state, Boolean(state && state.from === `system.adapter.${this.namespace}`));
        }
        if (id === this.ringStateId() && val && !prev) {
            if (this.store.layout.ring.dndQuiet && this.dndInfo().on) {
                this.log.info('Es läutet - Nicht stören: keine Mitteilung');
                return;
            }
            if (this.store.layout.telegram.ring) {
                this.telegramRing().catch(err => this.log.warn(`Telegram: ${err.message}`));
            }
            if (this.store.layout.whatsapp.ring) {
                const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
                this.whatsapp({ title: '🔔 Es läutet', body: time }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
            }
        }
    }

    // ---------------- color lights (KNX push button, color changer) ----------------

    colorLights() {
        if (!this.colors) {
            this.colors = new ColorLights(
                {
                    get: id => (this.liveStates.get(id) || {}).val,
                    max: id => (this.meta.get(id) || {}).max,
                    set: (id, val) => this.setValue(id, val, { force: true }),
                    log: this.log,
                    changed: status => this.server && this.server.colorsChanged && this.server.colorsChanged(status),
                },
                this.colorOpts || {},
            );
        }
        return this.colors;
    }

    /** color tiles of the saved layout (links are no tiles of their own: they act through the original) */
    colorTiles() {
        const list = [];
        for (const page of this.store.layout.pages) {
            for (const tile of page.tiles) {
                if (tile.type === 'color') {
                    list.push({ key: `${page.id}/${tile.id}`, tile });
                }
            }
        }
        return list;
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
                const entries = WinLogic.entries(list, WinLogic.words(t));
                const what = e => (e.group ? `${e.label} (${e.detail})` : `${e.label} ${WinLogic.words(t)[e.status]}`);
                const title = t.label || 'Fenster';
                if (t.warnMin > 0) {
                    for (const e of entries) {
                        if (!WinLogic.active(e)) {
                            mem.long.delete(e.label);
                        } else if (e.ts && Date.now() - e.ts >= t.warnMin * 60000 && !mem.long.has(e.label)) {
                            mem.long.add(e.label);
                            if (!initial) {
                                this.notify(`${title}: zu lange ${WinLogic.words(t).open}`, `${what(e)} seit mehr als ${t.warnMin} Min.`, page.id, '', t.channels);
                            }
                        }
                    }
                }
                const warn = WinLogic.warn(t, st, list);
                if (warn && !mem.warn && !initial) {
                    this.notify(`${title}: ${t.warnText || 'Achtung'}`, `Offen: ${entries.filter(WinLogic.active).map(what).join(', ')}`, page.id, '', t.channels);
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
    /** cars of the known car adapters for the tile dialog: [{id (car folder), label}] - folders with a charge level */
    async carDevices() {
        const out = [];
        for (const adapter of CarLogic.ADAPTERS) {
            const objs = await this.getForeignObjectsAsync(`${adapter}.*`, 'state').catch(() => ({}));
            const byCar = new Map();
            for (const id of Object.keys(objs || {})) {
                const p = CarLogic.prefixOf(id);
                if (p) {
                    if (!byCar.has(p)) {
                        byCar.set(p, []);
                    }
                    byCar.get(p).push(id);
                }
            }
            for (const [p, ids] of byCar) {
                if (!CarLogic.match(ids).soc) {
                    continue;
                }
                const dev = await this.getForeignObjectAsync(p).catch(() => null);
                const name = dev && dev.common && dev.common.name;
                const text = typeof name === 'object' && name ? name.de || name.en || '' : name || '';
                out.push({ id: p, label: `${text && text !== p.split('.')[2] ? `${text} ` : ''}(${p})` });
            }
        }
        return out;
    }

    /** car tile: empty fields from the data points found below the chosen car */
    async fillCar(t) {
        const p = CarLogic.prefixOf(t.carSrc);
        if (!p) {
            return;
        }
        const objs = await this.getForeignObjectsAsync(`${p}.*`, 'state').catch(() => ({}));
        const found = CarLogic.match(Object.keys(objs || {}).sort((a, b) => a.length - b.length));
        for (const [k, id] of Object.entries(found)) {
            // empty, or a data point of another car of the same adapter (own picks for this car stay)
            if (!t[k] || (String(t[k]).startsWith(`${p.split('.')[0]}.`) && !String(t[k]).startsWith(`${p}.`))) {
                t[k] = id;
            }
        }
        this.log.info(`Auto ${t.label || p}: gefunden ${Object.keys(found).join(', ') || 'nichts'}`);
    }

    /** robots of the dreame / husqvarna-automower / roomba adapters for the tile dialog: [{id (device prefix), label, kind}] */
    async robotDevices() {
        const out = [];
        const hq = await this.getForeignStatesAsync('husqvarna-automower.*.system.name').catch(() => ({}));
        for (const [id, st] of Object.entries(hq || {})) {
            const prefix = id.replace(/\.system\.name$/, '');
            out.push({ id: prefix, label: `${(st && st.val) || 'Automower'} (${prefix.split('.').slice(0, 2).join('.')})`, kind: 'mower' });
        }
        // iRobot (roomba adapter): one robot per instance. Listed by the instance: the adapter creates its data points
        // (commands.*) only after it has connected to the robot once
        const rb = await this.getForeignObjectsAsync('system.adapter.roomba.*', 'instance').catch(() => ({}));
        for (const id of Object.keys(rb || {})) {
            const prefix = id.replace(/^system\.adapter\./, '');
            const st = await this.getForeignStateAsync(`${prefix}.device.name`).catch(() => null);
            const conn = await this.getForeignStateAsync(`${prefix}.states._connected`).catch(() => null);
            out.push({ id: prefix, label: `${(st && st.val) || 'iRobot'} (${prefix})${conn && conn.val === true ? '' : ' – noch nicht verbunden'}`, kind: 'vacuum' });
        }
        for (const [suffix, kind] of [['remote.start-clean', 'vacuum'], ['remote.start-mow', 'mower']]) {
            const objs = await this.getForeignObjectsAsync(`dreame.*.${suffix}`, 'state').catch(() => ({}));
            for (const id of Object.keys(objs || {})) {
                const prefix = id.slice(0, -suffix.length - 1);
                const dev = await this.getForeignObjectAsync(prefix).catch(() => null);
                const name = dev && dev.common && dev.common.name;
                const text = typeof name === 'object' && name ? name.de || name.en || '' : name || '';
                out.push({ id: prefix, label: `${text || 'Dreame'} (${prefix})`, kind });
            }
        }
        return out;
    }

    /** robot (husqvarna-automower): work areas with their names for "Bereich mähen" buttons */
    async fillRobotAreas(t) {
        const tpl = RobotLogic.template(t.robotSrc, t.robotKind);
        if (!tpl || tpl.adapter !== 'husqvarna') {
            return;
        }
        // stay-out zones (extended adapter): switch per zone
        const zoneStates = await this.getForeignStatesAsync(`${tpl.prefix}.stayOutZones.*.name`).catch(() => ({}));
        t.zones = Object.entries(zoneStates || {})
            .map(([id, st]) => ({ state: id.replace(/\.name$/, '.enable'), label: st && st.val ? String(st.val) : id.split('.').slice(-2, -1)[0] }))
            .sort((a, b) => a.label.localeCompare(b.label, 'de'));
        const states = await this.getForeignStatesAsync(`${tpl.prefix}.workAreas.*.name`).catch(() => ({}));
        t.areas = Object.entries(states || {})
            .map(([id, st]) => ({ id: id.split('.').slice(-2, -1)[0], label: st && st.val ? String(st.val) : '' }))
            .filter(a => a.id !== '')
            .map(a => ({ ...a, label: a.label || `Bereich ${a.id}` }))
            .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    }

    async fillDetectors(layout) {
        for (const p of (layout && Array.isArray(layout.pages) ? layout.pages : [])) {
            for (const t of (p && Array.isArray(p.tiles) ? p.tiles : [])) {
                if (t && t.type === 'fire') {
                    t.detectors = t.showDetectors ? await this.fireDetectorsOf(String(t.panel || '')) : [];
                    continue;
                }
                if (t && t.type === 'car') {
                    await this.fillCar(t);
                    continue;
                }
                if (t && t.type === 'robot') {
                    await this.fillRobotAreas(t);
                    continue;
                }
                if (!t || t.type !== 'alarm') {
                    continue;
                }
                for (const a of [t, ...(Array.isArray(t.areas) ? t.areas : [])]) {
                    a.detectors = t.showDetectors ? await this.detectorsOf(String(a.area || '')) : [];
                    if (t.showDetectors && !a.detectors.length) {
                        const what = a === t ? t.areaLabel || t.label || 'Alarmanlage' : a.label || 'Bereich';
                        this.log.warn(
                            a.area
                                ? `${what}: keine Melder für ${a.area} gefunden - braucht im NOX-Adapter die Exportliste (inputs.N.area) bzw. im SPC-Adapter die Zonen`
                                : `${what}: keine Melder - im Feld "Bereich aus NOX- oder SPC-Adapter" fehlt der Bereich (z. B. nox_alarmzentrale.0.areas.1)`,
                        );
                    }
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

    /** detectors of an FC20 panel (fc20-cerberus-bacnet.N.objects.melder.<id>.*), sorted by name */
    async fireDetectorsOf(panel) {
        if (!/^fc20-cerberus-bacnet\.\d+$/.test(panel)) {
            return [];
        }
        const states = await this.getForeignStatesAsync(`${panel}.objects.melder.*.state`).catch(() => ({}));
        const out = [];
        for (const id of Object.keys(states || {})) {
            const base = id.replace(/\.state$/, '');
            const obj = await this.getForeignObjectAsync(base).catch(() => null);
            const name = obj && obj.common && obj.common.name;
            const modeObj = await this.getForeignObjectAsync(`${base}.mode`).catch(() => null);
            out.push({
                label: (typeof name === 'object' ? name.de || name.en : name) || base.split('.').pop(),
                state: `${base}.state`,
                alarm: `${base}.alarm`,
                fault: `${base}.fault`,
                off: `${base}.disabled`,
                ...(modeObj ? { mode: `${base}.mode` } : {}),
            });
        }
        out.sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true }));
        return out;
    }

    /**
     * Household appliance tiles: state machine per device off -> run -> done (-> off). Power (Shelly): running at >= onW
     * for 1 min, finished when below onW for offMin minutes. Status (Home Connect): running while the value matches runAt,
     * finished when it then matches doneAt (else it was cancelled -> off), off again when it matches neither (door opened).
     * "Fertig" also ends by a tap on the tile, a new run or after doneHours. Messages only for real transitions.
     */
    checkAppliances(initial = false) {
        if (!this.appMem) {
            return;
        }
        const sec = this.appSec || 1000; // tests shorten the second
        const now = Date.now();
        const st = id => this.stateInfo(id);
        const seen = new Set();
        let changed = false;
        this.appIds = new Set();
        for (const page of this.store.layout.pages) {
            for (const t of page.tiles) {
                if (t.type !== 'appliances') {
                    continue;
                }
                (t.devices || []).forEach((d, i) => {
                    [d.state, d.remain].filter(Boolean).forEach(id => this.appIds.add(id));
                    const key = `${page.id}/${t.id}/${i}`;
                    seen.add(key);
                    const r = AppLogic.reading(d, st);
                    const kind = AppLogic.kindOf(d, st); // also 'state' for a text data point picked as "Leistung"
                    let m = this.appMem.get(key);
                    if (!m || m.state !== d.state) {
                        // new device (or other data point): take what it does now, no message
                        m = { state: d.state, status: r.run ? 'run' : 'off', since: now, runSince: r.run ? now : 0 };
                        this.log.info(`Haushaltsgerät ${d.label || key}: ${d.state} = ${JSON.stringify((st(d.state) || {}).val)} -> ${m.status} (Erkennung: ${kind === 'state' ? 'Status' : 'Leistung'})`);
                        this.appMem.set(key, m);
                        changed = true;
                        return;
                    }
                    const set = (status, extra = {}) => {
                        this.log.info(`Haushaltsgerät ${d.label || key}: ${m.status} -> ${status} (${d.state} = ${JSON.stringify((st(d.state) || {}).val)})`);
                        Object.assign(m, { status, since: now, high: 0, low: 0 }, extra);
                        changed = true;
                    };
                    if (r.run === null) {
                        return; // no value (adapter not running): keep what we know
                    }
                    const name = d.label || 'Gerät';
                    if (r.run) {
                        m.low = 0;
                        if (m.status !== 'run') {
                            // power: a minute above the threshold (a dryer's anti-crease turns do not start a run)
                            m.high = m.high || now;
                            if (kind === 'state' || now - m.high >= 60 * sec) {
                                set('run', { runSince: kind === 'state' ? now : m.high });
                            }
                        }
                    } else {
                        m.high = 0;
                        if (m.status === 'run') {
                            const done = kind === 'state' ? r.done : (m.low = m.low || now) && now - m.low >= (d.offMin === undefined ? 3 : d.offMin) * 60 * sec;
                            const stopped = kind === 'state' ? true : done;
                            if (stopped) {
                                const ranMs = (kind === 'state' ? now : m.low) - (m.runSince || now);
                                if (done) {
                                    set('done');
                                    if (t.notify && !initial) {
                                        this.notify(`${name} ist fertig`, ranMs > 60000 ? `Lief ${this.duration(ranMs)}` : 'Fertig', page.id, `app-${key}`, t.channels);
                                    }
                                } else {
                                    set('off'); // status kind: cancelled (no "Finished")
                                }
                            }
                        } else if (m.status === 'done') {
                            const hours = Number(t.doneHours) || 0;
                            if ((kind === 'state' && !r.done) || (hours > 0 && now - m.since >= hours * 3600 * sec)) {
                                set('off');
                            }
                        }
                    }
                });
            }
        }
        for (const k of [...this.appMem.keys()]) {
            if (!seen.has(k)) {
                this.appMem.delete(k);
                changed = true;
            }
        }
        if (changed) {
            this.saveApps();
        }
    }

    /**
     * Messages of alarm tiles (intrusion: alarm per area, optionally armed / disarmed) and fire tiles (fire alarm,
     * pre-alarm, optionally fault) - on the change only, nothing for what is already so at start.
     */
    checkAlarmPush(initial = false) {
        this.alarmPushMem = initial || !this.alarmPushMem ? new Map() : this.alarmPushMem;
        this.alarmPushIds = new Set();
        const on = id => Boolean(id && SceneLogic.truthy((this.liveStates.get(id) || {}).val));
        const val = id => (id ? (this.liveStates.get(id) || {}).val : undefined);
        const same = (v, w) => v !== undefined && v !== null && w !== undefined && w !== '' && String(v) === String(w);
        const edge = (key, now, send) => {
            const before = this.alarmPushMem.get(key);
            this.alarmPushMem.set(key, now);
            if (!initial && before !== undefined && before !== now) {
                send(before);
            }
        };
        for (const page of this.store.layout.pages) {
            for (const t of page.tiles) {
                if (t.type === 'alarm' && (t.notify || t.notifyMode)) {
                    [t, ...(t.areas || [])].forEach((a, i) => {
                        const name = i === 0 ? t.areaLabel || t.label || 'Alarmanlage' : a.label || `Bereich ${i + 1}`;
                        const key = `${page.id}/${t.id}/${i}`;
                        [a.alarm, a.status, a.alarmText].filter(Boolean).forEach(id => this.alarmPushIds.add(id));
                        if (t.notify && a.alarm) {
                            edge(`${key}/alarm`, on(a.alarm), () => {
                                if (on(a.alarm)) {
                                    // the detector names usually come a moment after the alarm bit
                                    setTimeout(() => {
                                        const who = a.alarmText ? String(val(a.alarmText) || '') : '';
                                        this.notify(`🚨 ALARM ${name}`, who ? `Ausgelöst: ${who}` : 'Die Alarmanlage hat ausgelöst!', page.id, `alarm-${key}`, t.channels);
                                    }, this.alarmTextWait ?? 1500);
                                } else {
                                    this.notify(`${name}: Alarm beendet`, 'Der Alarm ist zurückgesetzt.', page.id, `alarm-${key}`, t.channels);
                                }
                            });
                        }
                        if (t.notifyMode && a.status) {
                            const v = val(a.status);
                            const mode = same(v, a.valueArm) ? 'scharf' : same(v, a.valueHome) ? 'intern scharf' : same(v, a.valueOff) ? 'unscharf' : '';
                            if (mode) {
                                edge(`${key}/mode`, mode, () => this.notify(`${name}: ${mode}`, `Alarmanlage ${name} ist jetzt ${mode}.`, page.id, `alarmmode-${key}`, t.channels));
                            }
                        }
                    });
                }
                if (t.type === 'fire' && (t.notify || t.notifyFault)) {
                    const name = t.label || 'Brandmeldeanlage';
                    const key = `${page.id}/${t.id}`;
                    [t.alarm, t.alarmText, t.preAlarm, t.fault, t.faultText].filter(Boolean).forEach(id => this.alarmPushIds.add(id));
                    const text = id => (id ? String(val(id) || '') : '');
                    if (t.notify && t.alarm) {
                        edge(`${key}/alarm`, on(t.alarm), () => on(t.alarm) && setTimeout(() => this.notify(`🔥 BRANDALARM ${name}`, text(t.alarmText) || 'Die Brandmeldeanlage meldet Alarm!', page.id, `fire-${key}`, t.channels), this.alarmTextWait ?? 1500));
                    }
                    if (t.notify && t.preAlarm) {
                        edge(`${key}/pre`, on(t.preAlarm), () => on(t.preAlarm) && this.notify(`⚠️ Voralarm ${name}`, text(t.alarmText) || 'Die Brandmeldeanlage meldet Voralarm.', page.id, `firepre-${key}`, t.channels));
                    }
                    if (t.notifyFault && t.fault) {
                        edge(`${key}/fault`, on(t.fault), () => on(t.fault) && this.notify(`Störung ${name}`, text(t.faultText) || 'Die Brandmeldeanlage meldet eine Störung.', page.id, `firefault-${key}`, t.channels));
                    }
                }
            }
        }
    }

    /** "1 h 35 min" / "48 min" */
    duration(ms) {
        const min = Math.round(ms / 60000);
        return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
    }

    appStatus() {
        const out = {};
        for (const [k, m] of this.appMem || []) {
            out[k] = { status: m.status, since: m.since, runSince: m.runSince || 0 };
        }
        return out;
    }

    /** tap on a finished device: back to "Aus" */
    appAck(key) {
        const m = this.appMem && this.appMem.get(key);
        if (m && m.status === 'done') {
            Object.assign(m, { status: 'off', since: Date.now() });
            this.saveApps();
        }
    }

    saveApps() {
        try {
            const tmp = `${this.appFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.appMem)));
            fs.renameSync(tmp, this.appFile);
        } catch (err) {
            this.log.warn(`appliances.json: ${err.message}`);
        }
        if (this.server) {
            this.server.appsChanged(this.appStatus());
        }
    }

    /** message on all configured ways (app push, Telegram, WhatsApp) */
    notify(title, body, page = '', tag = '', ch = null) {
        // ch: the tile's choice {app, telegram, whatsapp}; not set = every way that is set up
        const via = ch && typeof ch === 'object' ? ch : { app: true, telegram: true, whatsapp: true };
        this.log.info(`Mitteilung: ${title} - ${body}`);
        if (via.app) {
            this.push.send({ title, body, url: page ? `./#${encodeURIComponent(page)}` : './', tag: tag || `win-${page}` }).catch(err => this.log.warn(`Push: ${err.message}`));
        }
        if (via.telegram) {
            this.telegram({ title, body, page }).catch(err => this.log.warn(`Telegram: ${err.message}`));
        }
        if (via.whatsapp) {
            this.whatsapp({ title, body, page }).catch(err => this.log.warn(`WhatsApp: ${err.message}`));
        }
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
    async fireTimer(tile, action, value, entry, key) {
        // PIN protected: only time switches saved with the current PIN (server checks it on PUT /api/timers)
        const sig = pinSig(pinHashesFor(this.store.layout, tile, tileWriteIds));
        const timer = key ? this.timers.list()[key] : null;
        if (sig && (!timer || timer.pinSig !== sig)) {
            this.log.warn(`Timer "${tile.label || tile.id}" nicht ausgeführt: die PIN der Kachel wurde geändert – die Zeitschaltuhr mit der neuen PIN nochmal speichern`);
            return;
        }
        const when = entry.at === 'time' ? entry.time : `${entry.at === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}${entry.offset ? ` ${entry.offset > 0 ? '+' : ''}${entry.offset} min` : ''}`;
        // several entries (central functions, scenes): the ones ticked in this switching time (none ticked = all)
        if (['switch', 'blind', 'button'].includes(tile.type) && Array.isArray(tile.entries) && tile.entries.length) {
            const list = [];
            if (tile.state) {
                list.push({ ...tile, _e: 0 });
            }
            tile.entries.forEach((e, i) => list.push({ ...tile, label: e.label, state: e.state, status: e.status || '', stop: e.stop || '', sendMode: e.sendMode || '', value: e.value, _e: i + 1 }));
            const pick = entry.targets && entry.targets.length ? list.filter(x => entry.targets.includes(x._e)) : list;
            this.log.info(`Timer "${tile.label || tile.id}" (${when}): ${action} – ${pick.map(x => x.label || x.state).join(', ') || 'kein Eintrag'}`);
            for (const sub of pick) {
                await this.fireOne(sub, action, value).catch(err => this.log.warn(`Timer "${sub.label || sub.state}": ${err.message}`));
            }
            return;
        }
        this.log.info(`Timer "${tile.label || tile.id}" (${when}): ${action}${value !== undefined ? ` ${value} %` : ''}`);
        await this.fireOne(tile, action, value);
    }

    /** one tile (or one entry of a tile) of a time switch */
    async fireOne(tile, action, value) {
        if (tile.type === 'gate') {
            await this.gateTimer(tile, action);
        } else if (tile.type === 'button') {
            await this.setValue(tile.state, tile.value === undefined || tile.value === '' ? true : tile.value);
        } else if (tile.type === 'switch' || tile.type === 'climate') {
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
        // an enabled web instance with HTTPS (for pages shown inside SmartView's https app, e.g. the Dreame map)
        const sec = Object.values(objs || {}).find(o => o && o.common && o.common.enabled && o.native && o.native.secure && /^system\.adapter\.web\.\d+$/.test(o._id));
        this.webCache = { at: Date.now(), base, sslPort: sec ? Number(sec.native.port) || 8443 : 0 };
        return base;
    }

    /** port / https of the web adapter for pages it serves (robot maps, web:/… links); from the cache of webBase() */
    webInfo() {
        // a web instance added later (e.g. a second one with HTTPS) is noticed without restarting SmartView
        if (!this.webCache || Date.now() - this.webCache.at > 60000) {
            this.webBase().catch(() => '');
        }
        const m = /^(https?):\/\/[^:]+:(\d+)/.exec((this.webCache && this.webCache.base) || '');
        const ssl = (this.webCache && this.webCache.sslPort) || 0;
        return m ? { port: Number(m[2]), secure: m[1] === 'https', sslPort: m[1] === 'https' ? Number(m[2]) : ssl } : null;
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
            for (const timer of (this.scenePending || new Map()).values()) {
                clearTimeout(timer);
            }
            for (const g of (this.gateTimers || new Map()).values()) {
                clearTimeout(g.timer);
            }
            clearInterval(this.dndTimer);
            if (this.colors) {
                this.colors.stop();
            }
            if (this.swCtl) {
                this.swCtl.stop();
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
