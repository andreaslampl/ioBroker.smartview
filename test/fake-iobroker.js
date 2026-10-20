'use strict';

/* Minimal ioBroker for tests: objects and foreign states in memory, adapter-core stub. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config || {};
        this.objects = {};
        this.foreign = {};
        this.writes = [];
        this.subs = new Set();
        this.log = options.log || { debug() {}, info() {}, warn() {}, error() {} };
        this.dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
        // devices confirm commands (ack) after this many ms; null = never
        this.ackDelay = 50;
        FakeAdapter.last = this;
    }
    async setState(id, val, ack) {
        this.foreign[`${this.namespace}.${id}`] = { val, ack, ts: Date.now() };
    }
    async getStateAsync(id) {
        return this.foreign[`${this.namespace}.${id}`] || null;
    }
    subscribeStates(pattern) {
        this.subs.add(`${this.namespace}.${pattern}`);
    }
    async getForeignObjectAsync(id) {
        return this.objects[id] ? { _id: id, ...this.objects[id] } : null;
    }
    async getForeignObjectsAsync(pattern, type) {
        const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
        const out = {};
        for (const [id, o] of Object.entries(this.objects)) {
            if (re.test(id) && (o.type || 'state') === type) {
                out[id] = { _id: id, type: 'state', ...o };
            }
        }
        return out;
    }
    async getForeignStateAsync(id) {
        return this.foreign[id] || null;
    }
    async subscribeForeignStatesAsync(id) {
        this.subs.add(id);
    }
    async unsubscribeForeignStatesAsync(id) {
        this.subs.delete(id);
    }
    async setForeignStateAsync(id, val, ack) {
        this.writes.push([id, val, ack]);
        this.change(id, val, ack);
        if (!ack && this.ackDelay !== null) {
            setTimeout(() => this.change(id, val, true), this.ackDelay);
        }
    }
    /** a device or another adapter changes a data point */
    change(id, val, ack = true) {
        this.foreign[id] = { val, ack, ts: Date.now(), lc: Date.now() };
        if (this.subs.has(id)) {
            setImmediate(() => this.emit('stateChange', id, this.foreign[id]));
        }
    }
    /** add a state object (and optionally a value) */
    add(id, common, val) {
        this.objects[id] = { type: 'state', common };
        if (val !== undefined) {
            this.foreign[id] = { val, ack: true, ts: Date.now() - 60000, lc: Date.now() - 60000 };
        }
    }
}

let installed = false;
function install() {
    if (installed) {
        return;
    }
    installed = true;
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')) };
        }
        return orig.call(this, request, ...rest);
    };
}

/** A small house: KNX lights/dimmer/blind, Shelly, contacts, temperatures, livecam. */
function demoHouse(a, camBase) {
    a.add('knx.0.EG.Licht.Wohnzimmer', { name: 'Licht Wohnzimmer', type: 'boolean', role: 'switch', write: true }, false);
    a.add('knx.0.EG.Licht.Kueche', { name: 'Licht Küche', type: 'boolean', role: 'switch', write: true }, true);
    a.add('knx.0.EG.Licht.Essen_Dimmer', { name: 'Dimmer Essen', type: 'number', role: 'level.dimmer', unit: '%', min: 0, max: 100, write: true }, 60);
    a.add('knx.0.EG.Rollladen.Wohnzimmer', { name: 'Rollladen Wohnzimmer', type: 'number', role: 'level.blind', unit: '%', write: true }, 30);
    a.add('knx.0.EG.Rollladen.Wohnzimmer_Stop', { name: 'Rollladen Stopp', type: 'boolean', role: 'button', write: true }, false);
    a.add('shelly.0.SHSW-1#A1#1.Relay0.Switch', { name: 'Gartenlicht', type: 'boolean', role: 'switch', write: true }, false);
    a.add('knx.0.EG.Fenster.Kueche', { name: 'Fenster Küche', type: 'boolean', role: 'sensor.window', write: false }, true);
    a.add('knx.0.EG.Temperatur.Wohnzimmer', { name: 'Temperatur Wohnzimmer', type: 'number', role: 'value.temperature', unit: '°C', write: false }, 21.4);
    a.add('knx.0.EG.Heizung.Wohnzimmer_Soll', { name: 'Sollwert Wohnzimmer', type: 'number', role: 'level.temperature', unit: '°C', min: 15, max: 28, write: true }, 21.5);
    a.add('spc-edp.0.areas.1.state', { name: 'Bereich Garage', type: 'number', role: 'value', states: { 0: 'Unscharf', 1: 'Intern scharf', 3: 'Scharf' }, write: false }, 0);
    a.add('0_userdata.0.Szene.Fernsehen', { name: 'Szene Fernsehen', type: 'boolean', role: 'button', write: true }, false);
    a.add('dimplex-nwpm.0.values.Vorlauf', { name: 'Vorlauftemperatur', type: 'number', role: 'value.temperature', unit: '°C', write: false }, 34.25);
    a.add('0_userdata.0.Wetter.Helligkeit', { name: 'Helligkeit', type: 'number', role: 'value.brightness', unit: 'Lux', write: false }, 72376.3);
    a.add('0_userdata.0.Wetter.HelligkeitOst', { name: 'Helligkeit Ost', type: 'number', role: 'value.brightness', unit: 'Lux', write: false }, 14397.4);
    a.add('0_userdata.0.Wetter.HelligkeitWest', { name: 'Helligkeit West', type: 'number', role: 'value.brightness', unit: 'Lux', write: false }, 34385.9);
    a.add('0_userdata.0.Wetter.Wind', { name: 'Wind', type: 'number', role: 'value.speed.wind', unit: 'm/s', write: false }, 0.8);
    a.add('0_userdata.0.Wetter.Aussentemperatur', { name: 'Außentemperatur', type: 'number', role: 'value.temperature', unit: '°C', write: false }, 22.6);
    a.add('0_userdata.0.Wetter.Feuchte', { name: 'Außenfeuchte', type: 'number', role: 'value.humidity', unit: '%', write: false }, 61.28);
    a.add('livecam.0.intercom.ringing', { name: 'Läutet', type: 'boolean', role: 'indicator', write: false }, false);
    a.add('livecam.0.intercom.openDoor', { name: 'Tür öffnen', type: 'boolean', role: 'button', write: true }, false);
    for (const [id, name] of [['haustuer', 'Haustür'], ['einfahrt', 'Einfahrt']]) {
        a.objects[`livecam.0.cameras.${id}`] = { type: 'channel', common: { name } };
        a.add(`livecam.0.cameras.${id}.snapshotUrl`, { name: 'Snapshot', type: 'string', role: 'url' }, `${camBase}/cam/${id}.jpg`);
        a.add(`livecam.0.cameras.${id}.mjpegUrl`, { name: 'MJPEG', type: 'string', role: 'url' }, `${camBase}/cam/${id}.mjpeg`);
    }
}

module.exports = { FakeAdapter, install, demoHouse };
