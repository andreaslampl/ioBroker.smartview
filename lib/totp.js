'use strict';

/*
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30 s) - what Microsoft / Google Authenticator,
 * Authy etc. show after scanning the otpauth:// QR code. Used as the second factor for access from outside.
 */

const crypto = require('node:crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of buf) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += ALPHA[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += ALPHA[(value << (5 - bits)) & 31];
    }
    return out;
}

function unbase32(text) {
    const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | ALPHA.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** New secret (160 bit), base32. */
function newSecret() {
    return base32(crypto.randomBytes(20));
}

/** 6-digit code of a time step. */
function code(secret, counter) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1e6).padStart(6, '0');
}

/**
 * Check a code (one step tolerance for clock drift). `last` = counter used last time: a code is accepted only once.
 * @returns {number} the matching counter, or -1
 */
function verify(secret, input, last = -1, now = Date.now()) {
    const c = String(input || '').replace(/\s/g, '');
    if (!secret || !/^\d{6}$/.test(c)) {
        return -1;
    }
    const t = Math.floor(now / 1000 / STEP);
    for (const k of [t, t - 1, t + 1]) {
        if (k > last && crypto.timingSafeEqual(Buffer.from(code(secret, k)), Buffer.from(c))) {
            return k;
        }
    }
    return -1;
}

/** otpauth:// address for the QR code. */
function uri(issuer, account, secret) {
    const i = encodeURIComponent(issuer);
    return `otpauth://totp/${i}:${encodeURIComponent(account)}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=6&period=${STEP}`;
}

module.exports = { newSecret, code, verify, uri, base32, unbase32, STEP };
