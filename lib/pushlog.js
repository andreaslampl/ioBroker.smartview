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
        this.imgDir = path.join(dir, 'pushlog');
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
        const before = this.entries;
        const cutoff = now - Math.max(1, Number(keepDays) || 7) * DAY;
        this.entries = this.entries.filter(e => e.ts >= cutoff).slice(0, MAX);
        if (this.entries.length === before.length) {
            return false;
        }
        // photos of removed entries
        const kept = new Set(this.entries.map(e => e.id));
        for (const e of before) {
            if (e.image && !kept.has(e.id)) {
                fs.rm(this.imagePath(e.id), { force: true }, () => {});
            }
        }
        return true;
    }

    imagePath(id) {
        return /^[a-z0-9]+$/.test(String(id)) ? path.join(this.imgDir, `${id}.jpg`) : null;
    }

    /** @returns {{id, ts, title, body, page, ways, image?}} the new entry; `image` = JPEG buffer (photo of a detection) */
    add({ title, body, page = '', ways = {}, image = null }, keepDays, now = Date.now()) {
        const entry = {
            id: `${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
            ts: now,
            title: String(title || '').slice(0, 120),
            body: String(body || '').slice(0, 1000),
            page: String(page || '').slice(0, 40),
            ways: { app: Boolean(ways.app), telegram: Boolean(ways.telegram), whatsapp: Boolean(ways.whatsapp) },
        };
        if (image && image.length) {
            try {
                fs.mkdirSync(this.imgDir, { recursive: true });
                fs.writeFileSync(this.imagePath(entry.id), image);
                entry.image = true;
            } catch (err) {
                this.log.warn(`pushlog photo: ${err.message}`);
            }
        }
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
