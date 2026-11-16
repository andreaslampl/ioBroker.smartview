'use strict';

/*
 * List of the messages SmartView sent (app push, Telegram, WhatsApp): shown in the app under "Meldungen",
 * a tap on a push opens it. Kept for `keepDays` (layout.pushKeep), at most MAX entries, pushlog.json in the
 * instance data directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX = 300;
const DAY = 86400000;

class PushLog {
    constructor(dir, { log } = {}) {
        this.file = path.join(dir, 'pushlog.json');
        this.log = log || console;
        this.entries = [];
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(data)) {
                this.entries = data.filter(e => e && typeof e.id === 'string' && Number(e.ts) > 0);
            }
        } catch {
            // first start
        }
    }

    _save() {
        try {
            fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries));
            fs.renameSync(`${this.file}.tmp`, this.file);
        } catch (err) {
            this.log.warn(`pushlog.json: ${err.message}`);
        }
    }

    /** drop what is older than `keepDays`; true if something was removed */
    prune(keepDays, now = Date.now()) {
        const before = this.entries.length;
        const cutoff = now - Math.max(1, Number(keepDays) || 7) * DAY;
        this.entries = this.entries.filter(e => e.ts >= cutoff).slice(0, MAX);
        return this.entries.length !== before;
    }

    /** @returns {{id, ts, title, body, page, ways}} the new entry */
    add({ title, body, page = '', ways = {} }, keepDays, now = Date.now()) {
        const entry = {
            id: `${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
            ts: now,
            title: String(title || '').slice(0, 120),
            body: String(body || '').slice(0, 1000),
            page: String(page || '').slice(0, 40),
            ways: { app: Boolean(ways.app), telegram: Boolean(ways.telegram), whatsapp: Boolean(ways.whatsapp) },
        };
        this.entries.unshift(entry);
        this.prune(keepDays, now);
        this._save();
        return entry;
    }

    /** entries (newest first), pruned */
    list(keepDays, now = Date.now()) {
        if (this.prune(keepDays, now)) {
            this._save();
        }
        return this.entries;
    }

    clear() {
        this.entries = [];
        this._save();
    }
}

module.exports = { PushLog };
