'use strict';

/*
 * Own certificate authority for HTTPS in the home network. The CA certificate is installed once on
 * the phone (iOS profile / Windows certificate store); the server certificate is issued for all
 * addresses of the ioBroker host and renewed automatically.
 * iOS accepts TLS server certificates with at most 825 days validity, SHA-256, a SAN and
 * extendedKeyUsage serverAuth.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const forge = require('node-forge');

const SERVER_DAYS = 800;
const RENEW_DAYS = 30;

function serial() {
    // positive, 16 bytes
    return '01' + crypto.randomBytes(15).toString('hex');
}

function createCa(name) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
    const attrs = [
        { name: 'commonName', value: name },
        { name: 'organizationName', value: 'SmartView ioBroker' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

/**
 * @param {{cert: string, key: string}} ca
 * @param {string[]} names host names and IP addresses
 */
function createServerCert(ca, names) {
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const caKey = forge.pki.privateKeyFromPem(ca.key);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + SERVER_DAYS * 86400000);
    cert.setSubject([{ name: 'commonName', value: names[0] || 'smartview' }]);
    cert.setIssuer(caCert.subject.attributes);
    const altNames = names.map(n => (/^[\d.]+$/.test(n) || n.includes(':') ? { type: 7, ip: n } : { type: 2, value: n }));
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
        { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey), names };
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
}

/**
 * CA and server certificate from `dir`, created or renewed when needed.
 * @returns {{ca: {cert, key}, server: {cert, key, names}, created: boolean, renewed: boolean}}
 */
function ensureCertificates(dir, names, caName = 'SmartView CA') {
    const file = path.join(dir, 'certs.json');
    const stored = readJson(file) || {};
    let created = false;
    let renewed = false;
    if (!stored.ca) {
        stored.ca = createCa(caName);
        created = true;
    }
    const wanted = [...new Set(names.filter(Boolean))];
    let server = stored.server;
    if (server) {
        const c = forge.pki.certificateFromPem(server.cert);
        const ageOk = c.validity.notAfter.getTime() - Date.now() > RENEW_DAYS * 86400000;
        const namesOk = wanted.every(n => (server.names || []).includes(n));
        let issuerOk = true;
        try {
            issuerOk = forge.pki.certificateFromPem(stored.ca.cert).verify(c);
        } catch {
            issuerOk = false;
        }
        if (!ageOk || !namesOk || !issuerOk) {
            server = null;
        }
    }
    if (!server) {
        // keep names that were valid before (e.g. an address that is down right now)
        const all = [...new Set([...wanted, ...((stored.server && stored.server.names) || [])])];
        server = createServerCert(stored.ca, all);
        renewed = !created;
        stored.server = server;
    }
    if (created || stored.server === server) {
        writeJson(file, stored);
    }
    return { ca: stored.ca, server, created, renewed };
}

/** CA certificate in DER form (for .crt downloads). */
function caDer(ca) {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(ca.cert))).getBytes();
    return Buffer.from(der, 'binary');
}

/** Apple configuration profile that installs the CA certificate. */
function mobileconfig(ca, title) {
    const uuid = () => crypto.randomUUID().toUpperCase();
    const fp = crypto.createHash('sha256').update(caDer(ca)).digest('hex').slice(0, 16).toUpperCase();
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>smartview-ca.cer</string>
      <key>PayloadContent</key><data>${caDer(ca).toString('base64')}</data>
      <key>PayloadDescription</key><string>Zertifikat für die SmartView-Seite im Heimnetz</string>
      <key>PayloadDisplayName</key><string>${esc(title)} Zertifikat</string>
      <key>PayloadIdentifier</key><string>smartview.ca.${fp}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid()}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>${esc(title)}</string>
  <key>PayloadDescription</key><string>Installiert das Zertifikat, damit SmartView sicher (HTTPS) läuft und Mitteilungen senden kann.</string>
  <key>PayloadIdentifier</key><string>smartview.profile.${fp}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

module.exports = { ensureCertificates, caDer, mobileconfig, createCa, createServerCert };
