'use strict';

/*
 * Users of SmartView (optional). Without users everything stays open as before. With users every
 * device logs in once (session cookie, kept until "Abmelden", a password change or deleting the user).
 *
 * users.json = {
 *   users: [{ id, name, salt, hash, admin, pages: 'all' | [pageId], control, intercom }],
 *   sessions: { <token>: { user, created, seen, agent } },
 * }
 * admin   = all pages, all rights, edit mode and user management
 * pages   = pages the user sees ('all' or a list)
 * control = may switch (otherwise only watching), incl. time switches
 * intercom = doorbell, camera on ring, intercom and call list
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SESSIONS = 200;

function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function cleanName(v) {
    return String(v === undefined || v === null ? '' : v).trim().slice(0, 40);
}

class UserStore {
    constructor(dir) {
        this.file = path.join(dir, 'users.json');
        this.data = { users: [], sessions: {} };
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.data.users = Array.isArray(d.users) ? d.users : [];
            this.data.sessions = d.sessions && typeof d.sessions === 'object' ? d.sessions : {};
        } catch {
            // no users yet
        }
        this.failures = new Map(); // ip -> {count, until}
        this._seenDirty = false;
    }

    get enabled() {
        return this.data.users.length > 0;
    }

    _write() {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1), { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
    }

    /** Users without secrets, for the management dialog. */
    list() {
        return this.data.users.map(u => ({
            id: u.id,
            name: u.name,
            admin: Boolean(u.admin),
            pages: u.pages === 'all' ? 'all' : [...(u.pages || [])],
            control: Boolean(u.control),
            intercom: Boolean(u.intercom),
            sessions: Object.values(this.data.sessions).filter(s => s.user === u.id).length,
        }));
    }

    byId(id) {
        return this.data.users.find(u => u.id === id) || null;
    }

    /**
     * Save the list from the dialog. `password` (new) sets the password; empty keeps the old one.
     * New users need a password; at least one admin must stay. Returns the cleaned list.
     */
    save(list, pageIds) {
        if (!Array.isArray(list)) {
            throw new Error('Ungültige Benutzerliste');
        }
        const known = new Set(pageIds);
        const names = new Set();
        const out = [];
        for (const raw of list.slice(0, 50)) {
            const name = cleanName(raw && raw.name);
            if (!name) {
                throw new Error('Jeder Benutzer braucht einen Namen');
            }
            if (names.has(name.toLowerCase())) {
                throw new Error(`Name doppelt: ${name}`);
            }
            names.add(name.toLowerCase());
            const old = raw.id ? this.byId(String(raw.id)) : null;
            const password = raw.password === undefined || raw.password === null ? '' : String(raw.password);
            if (!old && !password) {
                throw new Error(`${name}: Passwort oder PIN fehlt`);
            }
            if (password && password.length < 4) {
                throw new Error(`${name}: Passwort/PIN mindestens 4 Zeichen`);
            }
            const u = {
                id: old ? old.id : crypto.randomBytes(6).toString('hex'),
                name,
                salt: old ? old.salt : '',
                hash: old ? old.hash : '',
                admin: Boolean(raw.admin),
                pages: raw.pages === 'all' || raw.admin ? 'all' : (Array.isArray(raw.pages) ? raw.pages : []).map(String).filter(id => known.has(id)),
                control: Boolean(raw.control) || Boolean(raw.admin),
                intercom: Boolean(raw.intercom) || Boolean(raw.admin),
            };
            if (password) {
                u.salt = crypto.randomBytes(16).toString('hex');
                u.hash = hashPassword(password, u.salt);
                if (old) {
                    this._dropSessions(old.id);
                }
            }
            out.push(u);
        }
        if (out.length && !out.some(u => u.admin)) {
            throw new Error('Mindestens ein Benutzer muss Administrator sein');
        }
        const ids = new Set(out.map(u => u.id));
        for (const u of this.data.users) {
            if (!ids.has(u.id)) {
                this._dropSessions(u.id);
            }
        }
        this.data.users = out;
        this._write();
        return this.list();
    }

    _dropSessions(userId) {
        for (const [token, s] of Object.entries(this.data.sessions)) {
            if (s.user === userId) {
                delete this.data.sessions[token];
            }
        }
    }

    /** Seconds to wait before the next login attempt from this address (0 = go). */
    waitFor(ip) {
        const f = this.failures.get(ip);
        return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
    }

    /** Check name + password; returns a new session token or throws. */
    login(name, password, ip, agent) {
        const wait = this.waitFor(ip);
        if (wait) {
            throw new Error(`Zu viele Versuche – bitte ${wait} s warten`);
        }
        const u = this.data.users.find(x => x.name.toLowerCase() === cleanName(name).toLowerCase());
        const ok = u && crypto.timingSafeEqual(Buffer.from(hashPassword(password || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) {
            const f = this.failures.get(ip) || { count: 0, until: 0 };
            f.count++;
            // after 5 wrong attempts: 30 s, then doubling up to 15 min
            f.until = f.count >= 5 ? Date.now() + Math.min(30000 * 2 ** (f.count - 5), 900000) : 0;
            this.failures.set(ip, f);
            throw new Error('Name oder Passwort falsch');
        }
        this.failures.delete(ip);
        return this.createSession(u.id, agent);
    }

    createSession(userId, agent) {
        const token = crypto.randomBytes(32).toString('base64url');
        this.data.sessions[token] = { user: userId, created: Date.now(), seen: Date.now(), agent: String(agent || '').slice(0, 120) };
        const all = Object.entries(this.data.sessions).sort((a, b) => b[1].seen - a[1].seen);
        for (const [t] of all.slice(MAX_SESSIONS)) {
            delete this.data.sessions[t];
        }
        this._write();
        return token;
    }

    /** User of a session token, or null. */
    session(token) {
        const s = token && Object.prototype.hasOwnProperty.call(this.data.sessions, token) ? this.data.sessions[token] : null;
        const u = s && this.byId(s.user);
        if (!u) {
            return null;
        }
        if (Date.now() - s.seen > 3600000) {
            // remember roughly when a device was last used, without writing on every request
            s.seen = Date.now();
            this._write();
        }
        return u;
    }

    logout(token) {
        if (token && this.data.sessions[token]) {
            delete this.data.sessions[token];
            this._write();
        }
    }
}

/**
 * Rights of a request. users off -> everything (edit as set in the instance).
 * @returns {{user: object|null, admin: boolean, pages: Set<string>|null, control: boolean, intercom: boolean}}
 */
function rights(user, usersEnabled) {
    if (!usersEnabled) {
        return { user: null, admin: true, pages: null, control: true, intercom: true };
    }
    if (!user) {
        return null;
    }
    return {
        user,
        admin: Boolean(user.admin),
        pages: user.admin || user.pages === 'all' ? null : new Set(user.pages || []),
        control: Boolean(user.admin || user.control),
        intercom: Boolean(user.admin || user.intercom),
    };
}

/** The layout as a user may see it: own pages only, no doorbell without the right, no push rules. */
function layoutFor(layout, r) {
    if (r.admin) {
        return layout;
    }
    const pages = r.pages ? layout.pages.filter(p => r.pages.has(p.id)) : layout.pages;
    const visible = new Set(pages.map(p => p.id));
    return {
        ...layout,
        pages: pages.map(p => ({ ...p, tiles: p.tiles.filter(t => t.type !== 'page' || !t.target || visible.has(t.target)) })),
        side: { ...layout.side, top: layout.side.top.filter(id => visible.has(id)), bottom: layout.side.bottom.filter(id => visible.has(id)) },
        ring: r.intercom ? layout.ring : { state: '', camera: '', door: '', intercom: '' },
        push: [],
        telegram: { instance: '', users: '', ring: false },
    };
}

module.exports = { UserStore, rights, layoutFor, hashPassword };
