'use strict';

/*
 * SmartView <-> homekit-easy: tiles with "auch in HomeKit" become devices in homekit-easy
 * (sendTo 'sync'), and homekit-easy devices can be taken over as tiles.
 *
 * tile.homekit = homekit-easy device type ('' = not in HomeKit)
 * tile.hkId    = id of an existing homekit-easy device the tile was taken over from (optional);
 *                without it the device id is derived from page and tile id.
 */

const crypto = require('node:crypto');

/** HomeKit device types per tile type (first = default) and their labels in the editor. */
const CHOICES = {
    switch: ['light', 'outlet', 'switch', 'fan'],
    dimmer: ['dimmer'],
    blind: ['blind'],
    thermostat: ['thermostat'],
    value: ['temperature', 'humidity', 'lux', 'co2', 'contact', 'motion', 'occupancy', 'smoke', 'leak'],
    camera: ['camera'],
};

const LABELS = {
    light: 'Licht',
    outlet: 'Steckdose',
    switch: 'Schalter',
    fan: 'Ventilator',
    dimmer: 'Dimmer',
    blind: 'Rollladen / Jalousie',
    thermostat: 'Thermostat',
    temperature: 'Temperatursensor',
    humidity: 'Luftfeuchtesensor',
    lux: 'Helligkeitssensor (Lux)',
    co2: 'CO₂-Sensor',
    contact: 'Kontakt (Fenster/Tür)',
    motion: 'Bewegungsmelder',
    occupancy: 'Präsenzmelder',
    smoke: 'Rauchmelder',
    leak: 'Wassermelder',
    camera: 'Kamera',
};

const CAMERA_ID = /^livecam\.\d+\.cameras\.[^.]+$/;

/** Sensible HomeKit type for a tile (from its icon or unit). */
function defaultType(t) {
    if (t.type === 'switch') {
        return { bulb: 'light', lamp: 'light', socket: 'outlet', fan: 'fan' }[t.icon] || 'switch';
    }
    if (t.type === 'value') {
        const unit = String(t.unit || '').toLowerCase();
        if (unit === '%' || t.icon === 'drop') {
            return 'humidity';
        }
        if (unit === 'lx' || unit === 'lux') {
            return 'lux';
        }
        if (unit === 'ppm') {
            return 'co2';
        }
        return { window: 'contact', door: 'contact', motion: 'motion', fire: 'smoke', water: 'leak' }[t.icon] || 'temperature';
    }
    return (CHOICES[t.type] || [''])[0];
}

/** Valid tile.homekit value for the tile's type ('' = off). */
function cleanChoice(type, value) {
    const list = CHOICES[type] || [];
    if (!value) {
        return '';
    }
    return list.includes(value) ? value : list[0] || '';
}

function deviceId(page, tile) {
    const id = `sv-${page.id}-${tile.id}`;
    return id.length <= 40 ? id : `sv-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 16)}`;
}

/** homekit-easy device for a tile (null when the tile cannot be one). */
function toDevice(tile, page) {
    const type = cleanChoice(tile.type, tile.homekit);
    if (!type) {
        return null;
    }
    const d = { id: tile.hkId || deviceId(page, tile), type, name: tile.label || LABELS[type] };
    const copy = (...keys) => keys.forEach(k => tile[k] !== undefined && tile[k] !== '' && (d[k] = tile[k]));
    if (tile.type === 'switch') {
        copy('state', 'status', 'invert');
    } else if (tile.type === 'dimmer') {
        copy('state', 'switchState', 'status');
    } else if (tile.type === 'blind') {
        copy('state', 'stop', 'status', 'closed100');
    } else if (tile.type === 'thermostat') {
        copy('state', 'heating', 'min', 'max', 'step');
        // HomeKit needs the actual temperature; without one the setpoint feedback is the next best thing
        d.actual = tile.status || tile.setStatus || tile.state;
    } else if (tile.type === 'value') {
        copy('state');
    } else if (tile.type === 'camera') {
        if (!CAMERA_ID.test(String(tile.camera || ''))) {
            return null;
        }
        d.camera = tile.camera;
    }
    return d.state || d.camera ? d : null;
}

/**
 * All devices for homekit-easy. Names: the tile label; labels used more than once get the page
 * name in front ("Küche Licht"), so Siri can tell them apart.
 */
function devicesFor(layout) {
    const items = [];
    for (const page of layout.pages || []) {
        for (const tile of page.tiles || []) {
            const d = tile.homekit && toDevice(tile, page);
            if (d) {
                items.push({ d, page });
            }
        }
    }
    const count = {};
    for (const { d } of items) {
        count[d.name] = (count[d.name] || 0) + 1;
    }
    const seen = new Set();
    const out = [];
    for (const { d, page } of items) {
        if (seen.has(d.id)) {
            continue; // one homekit-easy device per tile
        }
        seen.add(d.id);
        if (count[d.name] > 1 && page.name && !d.name.toLowerCase().includes(page.name.toLowerCase())) {
            d.name = `${page.name} ${d.name}`.slice(0, 64);
        }
        out.push(d);
    }
    return out;
}

/** Tile for a homekit-easy device (null for types SmartView cannot show this way). */
function toTile(d) {
    const tile = { type: '', label: String(d.name || ''), homekit: d.type, hkId: d.id };
    const copy = (...keys) => keys.forEach(k => d[k] !== undefined && d[k] !== '' && (tile[k] = d[k]));
    const sw = { light: 'bulb', outlet: 'socket', switch: 'power', fan: 'fan' };
    const sensors = {
        temperature: { icon: 'thermometer', unit: '°C', decimals: 1 },
        humidity: { icon: 'drop', unit: '%', decimals: 0 },
        lux: { icon: 'sun', unit: 'lx', decimals: 0 },
        co2: { icon: 'gauge', unit: 'ppm', decimals: 0 },
        contact: { icon: 'window', texts: 'true=offen;false=zu', highlight: 'on' },
        motion: { icon: 'motion', texts: 'true=Bewegung;false=Ruhe' },
        occupancy: { icon: 'motion', texts: 'true=anwesend;false=leer' },
        smoke: { icon: 'fire', texts: 'true=Alarm;false=OK', highlight: 'on' },
        leak: { icon: 'water', texts: 'true=Wasser;false=OK', highlight: 'on' },
    };
    if (sw[d.type]) {
        Object.assign(tile, { type: 'switch', icon: sw[d.type] });
        copy('state', 'status', 'invert');
    } else if (d.type === 'dimmer') {
        Object.assign(tile, { type: 'dimmer', icon: 'bulb' });
        copy('state', 'switchState', 'status');
    } else if (d.type === 'blind') {
        Object.assign(tile, { type: 'blind', icon: 'blind' });
        copy('state', 'stop', 'status', 'closed100');
    } else if (d.type === 'thermostat') {
        Object.assign(tile, { type: 'thermostat', icon: 'heat', status: d.actual });
        copy('state', 'heating', 'min', 'max', 'step');
    } else if (sensors[d.type]) {
        Object.assign(tile, { type: 'value' }, sensors[d.type]);
        copy('state');
        if (d.invert && tile.texts) {
            // inverted contact: false means open
            tile.texts = tile.texts.replace(/^true=([^;]*);false=(.*)$/, 'true=$2;false=$1');
        }
    } else if (d.type === 'camera' || d.type === 'doorbell') {
        Object.assign(tile, { type: 'camera', icon: 'camera', homekit: 'camera' });
        copy('camera');
        if (d.type === 'doorbell') {
            // the doorbell itself stays in homekit-easy; the tile only shows the camera
            delete tile.homekit;
            delete tile.hkId;
        }
    } else {
        return null;
    }
    return tile;
}

module.exports = { CHOICES, LABELS, defaultType, cleanChoice, toDevice, devicesFor, toTile };
