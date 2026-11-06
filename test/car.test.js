'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../www/carlogic');

test('car: data points found by name (VW EU Data Act, Tesla)', () => {
    const vw = 'vw-connect.0.WVWZZZE1ZPP000001.statuseudata.';
    const m = C.match([
        `${vw}battery_level_HV.value`,
        `${vw}battery_state_report.charge_power`,
        `${vw}charging_state_report.current_charge_state`,
        `${vw}mileage.value`,
        `${vw}locked`,
        `${vw}_dataset_created_on`,
        `${vw}trunk.locked`,
    ].sort((a, b) => a.length - b.length));
    assert.equal(m.soc, `${vw}battery_level_HV.value`);
    assert.equal(m.charging, `${vw}charging_state_report.current_charge_state`);
    assert.equal(m.locked, `${vw}locked`);
    assert.equal(m.mileage, `${vw}mileage.value`);
    const t = 'tesla-motors.0.5YJ3.';
    const mt = C.match([`${t}charge_state.battery_level`, `${t}charge_state.battery_range`, `${t}charge_state.charging_state`, `${t}drive_state.latitude`, `${t}drive_state.longitude`, `${t}vehicle_state.odometer`]);
    assert.equal(mt.soc, `${t}charge_state.battery_level`);
    assert.equal(mt.range, `${t}charge_state.battery_range`);
    assert.equal(mt.lat, `${t}drive_state.latitude`);
    assert.equal(C.prefixOf(`${vw}mileage.value`), 'vw-connect.0.WVWZZZE1ZPP000001');
    assert.equal(C.prefixOf('knx.0.x'), '');
});

test('car: charging texts', () => {
    assert.equal(C.chargeText({ val: 'CHARGE_STATE_CHARGING' }), 'Lädt');
    assert.equal(C.chargeText({ val: 'CHARGE_STATE_NOT_READY_FOR_CHARGING' }), 'Nicht bereit');
    assert.equal(C.chargeText({ val: 'CHARGE_STATE_READY_FOR_CHARGING' }), 'Bereit');
    assert.equal(C.chargeText({ val: 'Complete' }), 'Voll');
    assert.equal(C.plugged({ val: 'PLUG_CONNECTION_STATE_CONNECTED' }), true);
    assert.equal(C.plugged({ val: 'PLUG_CONNECTION_STATE_DISCONNECTED' }), false);
});
