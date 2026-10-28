'use strict';

/*
 * PIN protection of tiles (alarm system, door opener …). The PIN is only stored as a scrypt hash in the layout
 * (`pinHash`), never sent to a browser (they get `pin: true`), and checked by the server for every command to a
 * data point a protected tile writes - a PIN only in the page would be no protection.
 */

const crypto = require('node:crypto');

const HASH = /^s1\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    return `s1$${salt.toString('hex')}$${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

function verifyPin(pin, hash) {
    if (!HASH.test(String(hash)) || !/^\d{4,8}$/.test(String(pin || ''))) {
        return false;
    }
    const [, salt, want] = hash.split('$');
    const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32);
    return crypto.timingSafeEqual(got, Buffer.from(want, 'hex'));
}

/**
 * Layout from the editor -> PINs as hashes: `pin: true` keeps the stored hash of that tile, digits set a new one,
 * anything else removes it.
 */
function resolvePins(data, old) {
    const oldTile = (pageId, tileId) => {
        const pages = (old && old.pages) || [];
        const p = pages.find(x => x.id === pageId);
        return (p && p.tiles.find(t => t.id === tileId)) || pages.flatMap(x => x.tiles).find(t => t.id === tileId) || null;
    };
    const pages = data && Array.isArray(data.pages) ? data.pages : [];
    return {
        ...data,
        pages: pages.map(p => ({
            ...p,
            tiles: (p && Array.isArray(p.tiles) ? p.tiles : []).map(t => {
                const { pin, pinHash, ...rest } = t || {};
                if (pin === true) {
                    const o = oldTile(p.id, rest.id);
                    return o && o.pinHash ? { ...rest, pinHash: o.pinHash } : rest;
                }
                if (/^\d{4,8}$/.test(String(pin || ''))) {
                    return { ...rest, pinHash: hashPin(pin) };
                }
                return rest;
            }),
        })),
    };
}

/** layout for browsers: hashes replaced by `pin: true` */
function publicLayout(layout) {
    return {
        ...layout,
        pages: layout.pages.map(p => ({
            ...p,
            tiles: p.tiles.map(t => {
                if (!t.pinHash) {
                    return t;
                }
                const { pinHash, ...rest } = t;
                return { ...rest, pin: true };
            }),
        })),
    };
}

/** data point -> PIN hashes of the protected tiles that write it */
function protectedIds(layout, writeIdsOf) {
    const out = new Map();
    for (const p of layout.pages) {
        for (const t of p.tiles) {
            if (!t.pinHash) {
                continue;
            }
            for (const id of writeIdsOf(t)) {
                out.set(id, [...(out.get(id) || []), t.pinHash]);
            }
        }
    }
    return out;
}

/** wrong PINs per address: 5 tries, then locked for 5 minutes */
class PinGuard {
    constructor() {
        this.fails = new Map();
    }

    locked(addr) {
        const f = this.fails.get(addr);
        return Boolean(f && f.until > Date.now());
    }

    check(addr, pin, hashes) {
        if (this.locked(addr)) {
            return 'locked';
        }
        if (hashes.some(h => verifyPin(pin, h))) {
            this.fails.delete(addr);
            return 'ok';
        }
        const f = this.fails.get(addr) || { n: 0, until: 0 };
        f.n++;
        if (f.n >= 5) {
            f.n = 0;
            f.until = Date.now() + 5 * 60000;
        }
        this.fails.set(addr, f);
        return f.until > Date.now() ? 'locked' : 'wrong';
    }
}

module.exports = { HASH, hashPin, verifyPin, resolvePins, publicLayout, protectedIds, PinGuard };
