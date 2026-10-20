'use strict';

/*
 * Web Push: VAPID keys and the subscriptions of the devices (iPhone home screen app, browsers)
 * in push.json. ioBroker sends to the push service of the device's vendor (Apple, Google,
 * Mozilla) - outgoing only, so messages arrive outside the home network without VPN.
 */

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');

const SUBJECT = 'https://github.com/andreaslampl/ioBroker.smartview';

class Push {
    /**
     * @param {string} dir instance data directory
     * @param {object} [options]
     * @param {Function} [options.sender] (subscription, payload, options) => Promise, for tests
     */
    constructor(dir, { log, sender } = {}) {
        this.file = path.join(dir, 'push.json');
        this.log = log || console;
        this.sender = sender || ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            // first start
        }
        if (!data || !data.publicKey || !data.privateKey) {
            const keys = webpush.generateVAPIDKeys();
            data = { publicKey: keys.publicKey, privateKey: keys.privateKey, subscriptions: [] };
        }
        this.data = data;
        this._write();
    }

    get publicKey() {
        return this.data.publicKey;
    }

    get count() {
        return this.data.subscriptions.length;
    }

    _write() {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1), { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
    }

    /** Register a device; `sub` is the PushSubscription JSON from the browser. */
    subscribe(sub, name) {
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
            throw new Error('Ungültige Anmeldung für Mitteilungen');
        }
        const entry = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, name: String(name || '').slice(0, 60), added: new Date().toISOString() };
        this.data.subscriptions = this.data.subscriptions.filter(s => s.endpoint !== entry.endpoint);
        this.data.subscriptions.push(entry);
        this._write();
    }

    unsubscribe(endpoint) {
        const before = this.data.subscriptions.length;
        this.data.subscriptions = this.data.subscriptions.filter(s => s.endpoint !== endpoint);
        if (this.data.subscriptions.length !== before) {
            this._write();
        }
    }

    has(endpoint) {
        return this.data.subscriptions.some(s => s.endpoint === endpoint);
    }

    /**
     * Send to all devices.
     * @param {{title: string, body: string, url?: string, tag?: string}} message
     * @returns {Promise<{sent: number, failed: number}>}
     */
    async send(message) {
        const payload = JSON.stringify(message);
        const options = {
            vapidDetails: { subject: SUBJECT, publicKey: this.data.publicKey, privateKey: this.data.privateKey },
            TTL: 3600,
            urgency: 'high',
        };
        let sent = 0;
        let failed = 0;
        const gone = [];
        await Promise.all(
            this.data.subscriptions.map(async sub => {
                try {
                    await this.sender({ endpoint: sub.endpoint, keys: sub.keys }, payload, options);
                    sent++;
                } catch (err) {
                    failed++;
                    // 404/410: the device withdrew the subscription (app deleted, permission revoked)
                    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                        gone.push(sub.endpoint);
                    } else {
                        this.log.warn(`Push to ${sub.name || new URL(sub.endpoint).host} failed: ${(err && (err.body || err.message)) || err}`);
                    }
                }
            }),
        );
        if (gone.length) {
            this.data.subscriptions = this.data.subscriptions.filter(s => !gone.includes(s.endpoint));
            this._write();
            this.log.info(`Push: ${gone.length} device(s) no longer registered, removed`);
        }
        return { sent, failed };
    }
}

function toNum(v) {
    if (typeof v === 'boolean') {
        return v ? 1 : 0;
    }
    if (v === 'true') {
        return 1;
    }
    if (v === 'false') {
        return 0;
    }
    return Number(v);
}

function equals(val, value) {
    if (String(val) === value) {
        return true;
    }
    return value !== '' && !Number.isNaN(toNum(val)) && toNum(val) === Number(value);
}

function truthy(v) {
    if (typeof v === 'string') {
        return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
    }
    return Boolean(v);
}

/** Does `val` meet the rule's condition? */
function matches(rule, val) {
    switch (rule.cond) {
        case 'true':
            return truthy(val);
        case 'false':
            return val !== null && val !== undefined && !truthy(val);
        case 'eq':
            return equals(val, rule.value);
        case 'ne':
            return val !== null && val !== undefined && !equals(val, rule.value);
        case 'gt':
            return val !== null && val !== undefined && toNum(val) > Number(rule.value);
        case 'lt':
            return val !== null && val !== undefined && toNum(val) < Number(rule.value);
        default:
            return false;
    }
}

/**
 * Should a rule fire for a change from `prev` to `val`? Fires when the condition becomes true
 * (not again while it stays true); 'change' fires on every change of the value.
 */
function triggers(rule, val, prev) {
    if (rule.cond === 'change') {
        return val !== prev;
    }
    return matches(rule, val) && !matches(rule, prev);
}

/** Words for true/false by the role of the data point (like the page shows them). */
function boolWords(role) {
    role = String(role || '');
    if (/lock/.test(role)) {
        return ['offen', 'verriegelt'];
    }
    if (/window|door|contact|opening/.test(role)) {
        return ['offen', 'zu'];
    }
    if (/motion|presence/.test(role)) {
        return ['Bewegung', 'Ruhe'];
    }
    if (/alarm|fire|smoke|water|leak|warning|error|maintenance/.test(role)) {
        return ['Alarm', 'OK'];
    }
    return ['ein', 'aus'];
}

/** Message text with {value} replaced. */
function fill(text, val, role) {
    const words = boolWords(role);
    const v = typeof val === 'boolean' ? (val ? words[0] : words[1]) : val === null || val === undefined ? '' : String(val);
    return String(text || '').replace(/\{value\}/g, v);
}

module.exports = { Push, matches, triggers, fill };
