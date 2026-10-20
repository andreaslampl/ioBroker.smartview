'use strict';

const os = require('node:os');
const utils = require('@iobroker/adapter-core');
const { LayoutStore, stateIds } = require('./lib/layout');
const { Push, triggers, fill } = require('./lib/push');
const { ensureCertificates } = require('./lib/certs');
const { SmartServer } = require('./lib/server');

const CAMERA_ID = /^livecam\.\d+\.cameras\.[^.]+$/;

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
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const dir = this.dataDir || utils.getAbsoluteInstanceDataDir(this);
        this.store = new LayoutStore(dir);
        this.push = new Push(dir, { log: this.log, sender: this.pushSender });
        await this.setState('push.devices', this.push.count, true);

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
        }

        this.server = new SmartServer({
            store: this.store,
            push: this.push,
            certs,
            accessKey: String(this.config.accessKey || '').trim(),
            allowEdit: this.config.allowEdit !== false,
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

    /** Subscribe the data points of the layout and of the push rules. */
    async resubscribe() {
        const layout = this.store.layout;
        const { read } = stateIds(layout);
        const ids = new Set([...read, ...layout.push.filter(r => r.enabled && r.state).map(r => r.state)]);
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
                this.push.send({ title, body, url: page, tag: rule.id }).catch(err => this.log.warn(`Push: ${err.message}`));
            }
        }
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
