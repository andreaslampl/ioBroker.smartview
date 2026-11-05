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
