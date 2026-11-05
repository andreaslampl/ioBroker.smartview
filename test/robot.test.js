'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../www/robotlogic');
const { cleanLayout, stateIds } = require('../lib/layout');

test('robot: templates fill the data points of dreame / husqvarna devices, own fields stay', () => {
    const l = cleanLayout({ pages: [{ id: 'g', name: 'Garten', tiles: [
        { id: 'm', type: 'robot', robotSrc: 'husqvarna-automower.0.abc-1.capabilities.position' },
        { id: 'v', type: 'robot', robotSrc: 'dreame.0.123.status.state', start: 'javascript.0.meinStart', mapMode: 'none', mapUrl: 'web:/dreame/?did=123' },
        { id: 'x', type: 'robot', status: 'roborock.0.s.state', mapUrl: 'javascript:alert(1)' },
    ] }] });
    const [m, v, x] = l.pages[0].tiles;
    assert.equal(m.status, 'husqvarna-automower.0.abc-1.mower.activity');
    assert.equal(m.areaStart, 'husqvarna-automower.0.abc-1.ACTIONS.startInWorkArea.STARTINWORKAREA');
    assert.equal(m.robotKind, 'mower');
    assert.equal(m.mapMode, 'gps');
    assert.equal(v.start, 'javascript.0.meinStart', 'own data point kept');
    assert.equal(v.home, 'dreame.0.123.remote.return-to-dock');
    assert.equal(v.mapMode, 'none', 'own choice kept');
    assert.equal(v.mapUrl, 'web:/dreame/?did=123');
    assert.equal(x.mapUrl, '', 'only http(s) / web: addresses');
    const old = cleanLayout({ pages: [{ id: 'g', name: 'G', tiles: [{ id: 'v', type: 'robot', robotSrc: 'dreame.0.123', mapMode: 'none' }] }] }).pages[0].tiles[0];
    assert.equal(old.mapMode, 'url', '"keine" saved by 0.52.0 without an address becomes the Dreame map');
    assert.equal(x.robotKind, undefined, 'not set = vacuum');
    const { write } = stateIds(l);
    assert.ok(write.includes('husqvarna-automower.0.abc-1.ACTIONS.PAUSE'));
    assert.ok(!write.includes('husqvarna-automower.0.abc-1.positions.latitude'));
    assert.equal(m.confirm, 'husqvarna-automower.0.abc-1.ACTIONS.CONFIRMERROR');
    const z = cleanLayout({ pages: [{ id: 'g', name: 'G', tiles: [{ id: 'm', type: 'robot', robotSrc: 'husqvarna-automower.0.abc-1', zones: [{ label: 'Beet', state: 'husqvarna-automower.0.abc-1.stayOutZones.z1.enable' }, { label: 'leer' }] }] }] });
    assert.equal(z.pages[0].tiles[0].zones.length, 1);
    assert.ok(stateIds(z).write.includes('husqvarna-automower.0.abc-1.stayOutZones.z1.enable'), 'zone switch writable');
});

test('robot: status texts, working, errors', () => {
    const t = { texts: R.MOWER_TEXTS, runAt: 'MOWING;LEAVING' };
    assert.equal(R.statusText(t, { val: 'PARKED_IN_CS' }), 'Geparkt');
    assert.equal(R.statusText({}, { val: 2, states: { 2: 'Standby' } }), 'Standby');
    assert.equal(R.working(t, { val: 'MOWING' }), true);
    assert.equal(R.working({ runAt: '1;5' }, { val: 15 }), false, 'numbers exact');
    assert.equal(R.working({ runAt: '1;5' }, { val: 5 }), true);
    assert.equal(R.hasError({ val: 0 }), false);
    assert.equal(R.hasError({ val: 'NO_ERROR' }), false);
    assert.equal(R.hasError({ val: 9 }), true);
});

test('robot: GPS on a calibrated picture, track', () => {
    // north up: latitude falls downwards, longitude grows to the right
    const cal = R.parseCal('10,90=46.5000,14.3000;90,10=46.5010,14.3020');
    const p = R.toXY(cal, 46.5005, 14.301);
    assert.ok(Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y - 50) < 1e-6, JSON.stringify(p));
    assert.equal(R.parseCal('10,10=46.5,14.3;20,20=46.5,14.4'), null, 'same latitude cannot be calibrated');
    assert.deepEqual(R.parseTrack('[{"latitude":46.5,"longitude":14.3},{"latitude":"x"}]'), [{ lat: 46.5, lon: 14.3 }]);
    assert.deepEqual(R.parseTrack('kaputt'), []);
});
