'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../www/colorlogic');
const { ColorLights } = require('../lib/colorlight');
const { cleanLayout } = require('../lib/layout');

const wait = ms => new Promise(r => setTimeout(r, ms));

test('color logic: presets, formats, KNX dimming telegrams', () => {
    const def = C.parseColors('');
    assert.equal(def[0].label, 'Warmweiß');
    assert.equal(def[0].white, 1);
    assert.ok(def.at(-1).fx);
    assert.deepEqual(C.parseColors('Rot=#FF0000;kaputt;Halb=#ffffff w50')[1], { label: 'Halb', rgb: [255, 255, 255], white: 0.5, fx: false });
    assert.deepEqual(C.parseColor('#ff800040'), { rgb: [255, 128, 0], w: 64 });
    assert.deepEqual(C.parseColor('10,20,30'), { rgb: [10, 20, 30], w: undefined });
    assert.equal(C.formatColor([255, 0, 16], 255, '#00000000'), '#ff0010ff');
    assert.equal(C.formatColor([255, 0, 16], 0, '1,2,3'), '255,0,16');
    assert.equal(C.formatColor([255, 0, 16], 0, ''), '#ff0010');
    // DPT 3.007: raw 4 bit, object, JSON, signed
    assert.equal(C.dimDir(9), 'up');
    assert.equal(C.dimDir(1), 'down');
    assert.equal(C.dimDir(8), 'stop');
    assert.equal(C.dimDir(0), 'stop');
    assert.equal(C.dimDir({ decr_incr: 1, data: 3 }), 'up');
    assert.equal(C.dimDir('{"decr_incr":0,"data":0}'), 'stop');
    assert.equal(C.dimDir(-100), 'down');
    assert.equal(C.dimDir('kaputt'), null);
    assert.deepEqual(C.hueRgb(120), [0, 255, 0]);
});

test('layout: color tile keeps its data points, feedback never on the button address', () => {
    const l = cleanLayout({ pages: [{ id: 'b', name: 'Bad', tiles: [{ id: 'c', type: 'color', state: 's.sw', bright: 's.gain', rgb: 's.rgbw', knxSwitch: 'knx.sw', knxDim: 'knx.dim', knxStatus: 'knx.sw', knxBright: 'knx.br', colors: 'Rot=#ff0000', fxTime: 3 }] }] });
    const t = l.pages[0].tiles[0];
    assert.equal(t.knxStatus, undefined);
    assert.equal(t.knxBright, 'knx.br');
    assert.equal(t.fxTime, 10);
    assert.equal(t.colors, 'Rot=#ff0000');
});

function rig(tile, values = {}) {
    const vals = new Map(Object.entries(values));
    const writes = [];
    const changes = [];
    const cl = new ColorLights(
        {
            get: id => vals.get(id),
            max: id => (id === 'knx.r' ? 100 : undefined),
            set: async (id, v) => {
                writes.push([id, v]);
                vals.set(id, v);
            },
            log: { debug() {}, info() {}, warn: m => changes.push(m) },
            changed: s => changes.push(s),
        },
        { dimMs: 20, dimStep: 10, fxMs: 20 },
    );
    cl.update([{ key: 'bad/c', tile }]);
    // what ioBroker would send: a telegram / feedback (foreign) or our own echo
    const bus = (id, val, own = false) => {
        vals.set(id, val);
        cl.onState(id, { val, ack: true }, own);
    };
    return { cl, vals, writes, changes, bus };
}

const TILE = { id: 'c', label: 'Bad', type: 'color', state: 's.sw', bright: 's.gain', rgb: 's.rgbw', knxSwitch: 'knx.sw', knxDim: 'knx.dim', knxStatus: 'knx.st', knxBright: 'knx.br', colors: 'Warm=w;Rot=#ff0000;Wechsel=fx', fxTime: 10 };

test('KNX rocker: on, next color on each press, color changer, off', async () => {
    const { cl, vals, writes, bus } = rig(TILE, { 's.sw': false, 's.gain': 50, 's.rgbw': '#00000000' });
    bus('knx.sw', true);
    await wait(5);
    assert.deepEqual(writes, [['s.sw', true]], 'first press only switches on');
    bus('s.sw', true);
    assert.deepEqual(writes.at(-1), ['knx.st', true], 'status to the LED');
    writes.length = 0;
    bus('knx.sw', true);
    await wait(5);
    // light shows black + white 0: nothing matches -> first preset "Warm" (white channel in #rrggbbww)
    assert.deepEqual(writes, [['s.rgbw', '#000000ff']]);
    bus('knx.sw', true);
    await wait(5);
    assert.deepEqual(writes.at(-1), ['s.rgbw', '#ff000000']);
    bus('knx.sw', true);
    await wait(70);
    assert.equal(cl.status()['bad/c'].fx, true);
    const fxWrites = writes.filter(w => w[0] === 's.rgbw').length;
    assert.ok(fxWrites >= 4, 'color changer keeps writing');
    assert.notEqual(vals.get('s.rgbw'), '#ff000000');
    // own echo of the switch address is no button press
    const n = writes.length;
    bus('knx.sw', true, true);
    await wait(5);
    assert.ok(writes.slice(n).every(w => w[0] === 's.rgbw'), 'echo ignored');
    // off: color changer stops, comes back with "on"
    bus('knx.sw', false);
    await wait(5);
    assert.equal(vals.get('s.sw'), false);
    bus('s.sw', false);
    assert.equal(cl.status()['bad/c'].fx, false);
    const after = writes.length;
    await wait(60);
    assert.equal(writes.length, after, 'nothing written while off');
    bus('knx.sw', true);
    await wait(5);
    assert.equal(cl.status()['bad/c'].fx, true, 'color changer resumes');
    cl.stop();
});

test('KNX rocker: dimming while held, from off it starts dark', async () => {
    const { cl, vals, writes, bus } = rig(TILE, { 's.sw': true, 's.gain': 50, 's.rgbw': '#ff000000' });
    bus('knx.dim', 9); // up
    await wait(50);
    bus('knx.dim', 8); // stop
    const lvl = vals.get('s.gain');
    assert.ok(lvl > 50 && lvl <= 100, `brighter: ${lvl}`);
    await wait(60);
    assert.equal(vals.get('s.gain'), lvl, 'stopped');
    bus('knx.dim', 1); // down until 1 %
    await wait(250);
    assert.equal(vals.get('s.gain'), 1, 'never below 1 % (stays on)');
    // brightness feedback to KNX
    bus('s.gain', 1);
    assert.deepEqual(writes.at(-1), ['knx.br', 1]);
    // off + down: nothing; off + up: dark first, then on
    vals.set('s.sw', false);
    writes.length = 0;
    bus('knx.dim', 1);
    await wait(30);
    assert.deepEqual(writes, []);
    bus('knx.dim', 9);
    await wait(5);
    bus('knx.dim', 0);
    assert.deepEqual(writes.slice(0, 2), [['s.gain', 10], ['s.sw', true]]);
    cl.stop();
});

test('page commands: preset, own color on channels, color changer without white channel', async () => {
    const tile = { id: 'c', type: 'color', state: 's.sw', red: 'knx.r', green: 's.g', blue: 's.b', colors: 'Warm=w;Blau=#0000ff;Wechsel=fx' };
    const { cl, writes } = rig(tile, { 's.sw': true });
    await cl.command('bad/c', 'preset', 0);
    // no white channel: warm white mixed from RGB; KNX channel scaled to its max 100
    assert.deepEqual(writes.slice(0, 3), [['knx.r', 100], ['s.g', 150], ['s.b', 60]]);
    writes.length = 0;
    await cl.command('bad/c', 'rgb', '#00ff00');
    assert.deepEqual(writes, [['knx.r', 0], ['s.g', 255], ['s.b', 0]]);
    await cl.command('bad/c', 'fx');
    assert.equal(cl.status()['bad/c'].fx, true);
    assert.equal(cl.status()['bad/c'].idx, 2);
    await cl.command('bad/c', 'preset', 1);
    assert.equal(cl.status()['bad/c'].fx, false);
    cl.stop();
});
