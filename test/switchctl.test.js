'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SwitchCtl } = require('../lib/switchctl');
const { cleanLayout } = require('../lib/layout');

const wait = ms => new Promise(r => setTimeout(r, ms));

function rig(tile) {
    const writes = [];
    const changes = [];
    const ctl = new SwitchCtl({ write: async (id, v) => writes.push([id, v]), log: { info() {}, warn() {} }, changed: s => changes.push(s) });
    ctl.update([{ key: 'p/t', tile }]);
    return { ctl, writes, changes };
}

test('switch tile: more data points get the same command', async () => {
    const { ctl, writes } = rig({ type: 'switch', state: 'a', also: ['b', 'c'] });
    assert.ok(ctl.handles('a'));
    await ctl.command('a', true);
    assert.deepEqual(writes, [['a', true], ['b', true], ['c', true]]);
});

test('on / off delay: waits, a new command cancels, the page sees what is waiting', async () => {
    const { ctl, writes } = rig({ type: 'switch', state: 'a', onDelay: 0.05, offDelay: 0.05 });
    await ctl.command('a', true);
    assert.deepEqual(writes, []);
    assert.equal(ctl.status()['p/t'].on, true);
    await ctl.command('a', false); // cancels the waiting "on"
    await wait(90);
    assert.deepEqual(writes, [['a', false]]);
    assert.deepEqual(ctl.status(), {});
    ctl.stop();
});

test('dimmer: switch + level of one tap wait together; auto off afterwards', async () => {
    const { ctl, writes } = rig({ type: 'dimmer', state: 'lvl', switchState: 'sw', onDelay: 0.03, autoOff: 0.001 }); // 60 ms
    await ctl.command('sw', true);
    await ctl.command('lvl', 70);
    await wait(60);
    assert.deepEqual(writes, [['sw', true], ['lvl', 70]]);
    assert.equal(ctl.status()['p/t'].on, false, 'auto off is waiting');
    await wait(80);
    assert.deepEqual(writes.at(-1), ['sw', false]);
    ctl.stop();
});

test('layout keeps the extras of switch / dimmer / blind tiles', () => {
    const l = cleanLayout({ pages: [{ id: 'p', name: 'P', tiles: [{ id: 't', type: 'switch', state: 'a', also: ['b', 'b', ' ', 'c'], onDelay: '5', offDelay: -1, autoOff: 3 }, { id: 'r', type: 'blind', state: 'x', also: ['y'], onDelay: 5 }] }] });
    const [s, b] = l.pages[0].tiles;
    assert.deepEqual(s.also, ['b', 'c']);
    assert.equal(s.onDelay, 5);
    assert.equal(s.offDelay, undefined);
    assert.equal(s.autoOff, 3);
    assert.deepEqual(b.also, ['y']);
    assert.equal(b.onDelay, undefined, 'blinds have no delays');
});

function rigV(tile, values) {
    const writes = [];
    const ctl = new SwitchCtl({ write: async (id, v) => writes.push([id, v]), value: id => values[id], log: { info() {}, warn() {}, debug() {} } });
    ctl.update([{ key: 'p/t', tile }]);
    return { ctl, writes };
}

test('send mode "only true": on and off both write true, skipped when the status already shows it', async () => {
    const values = {};
    const { ctl, writes } = rigV({ type: 'switch', state: 'a', status: 's', sendMode: 'true', also: ['b'] }, values);
    await ctl.command('a', true);
    await ctl.command('a', false);
    assert.deepEqual(writes, [['a', true], ['b', true], ['a', true], ['b', true]]);
    values.s = true; // light is on
    await ctl.command('a', true); // time switch "Ein": nothing
    assert.equal(writes.length, 4);
    await ctl.command('a', false);
    assert.deepEqual(writes.slice(4), [['a', true], ['b', true]]);
    const f = rigV({ type: 'switch', state: 'a', sendMode: 'false' }, {});
    await f.ctl.command('a', true);
    assert.deepEqual(f.writes, [['a', false]]);
});

test('send mode push: a command presses for pushTime; held on the page = until released (at least pushTime)', async () => {
    const { ctl, writes } = rigV({ type: 'switch', state: 'a', sendMode: 'push', pushTime: 0.1 }, {});
    await ctl.command('a', false); // from a timer / scene: one press
    assert.deepEqual(writes, [['a', true], ['a', false]]);
    writes.length = 0;
    await ctl.command('a', true, { hold: true });
    assert.deepEqual(writes, [['a', true]]);
    await wait(150);
    assert.deepEqual(writes, [['a', true]]); // still held
    await ctl.command('a', false, { hold: true });
    await wait(5);
    assert.deepEqual(writes, [['a', true], ['a', false]]);
    writes.length = 0;
    await ctl.command('a', true, { hold: true });
    await ctl.command('a', false, { hold: true }); // quick tap: released after pushTime
    await wait(40);
    assert.deepEqual(writes, [['a', true]]);
    await wait(90);
    assert.deepEqual(writes, [['a', true], ['a', false]]);
    const inv = rigV({ type: 'switch', state: 'a', sendMode: 'push', invert: true, pushTime: 0.1 }, {});
    await inv.ctl.command('a', true);
    assert.deepEqual(inv.writes, [['a', false], ['a', true]]);
    ctl.stop();
});

test('layout keeps sendMode / pushTime of a switch', () => {
    const l = cleanLayout({ pages: [{ id: 'p', tiles: [{ id: 't', type: 'switch', state: 'a', sendMode: 'push', pushTime: 0.3 }, { id: 'u', type: 'switch', state: 'b', sendMode: 'x' }] }] });
    assert.equal(l.pages[0].tiles[0].sendMode, 'push');
    assert.equal(l.pages[0].tiles[0].pushTime, 0.3);
    assert.equal(l.pages[0].tiles[1].sendMode, '');
});
