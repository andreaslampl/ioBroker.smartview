'use strict';

/*
 * Car tile (any brand): which data point of a car adapter means what (searched by name under the chosen car, because the
 * names differ by adapter and - with VW's EU Data Act data - even by car), charging state texts. Page + adapter.
 */
(function (root) {
    // adapters whose objects are searched for cars (folder = <adapter>.<instance>.<car>)
    const ADAPTERS = ['vw-connect', 'tesla-motors', 'bmw', 'bmw-cardata', 'mercedesme', 'renault', 'bluelink', 'kia', 'skodaconnect', 'smart-eq', 'polestar', 'volvo', 'toyota'];

    // field -> patterns on the data point id below the car (first match wins, in this order)
    const FIELDS = {
        soc: [/battery_level_HV(\.battery_level_HV)?\.value$/i, /battery_state_report\.soc$/i, /currentSOC_pct$/i, /stateOfCharge$/i, /\.battery_level$/i, /\.soc$/i, /chargingLevel(Percent|Hv)?$/i],
        range: [/cruising_range_combined$/i, /cruising_ranges?\W?\d*\.range$/i, /cruisingRangeElectric_km$/i, /remainingRange(_km)?$/i, /battery_range$/i, /electricRange$/i, /\.range$/i],
        charging: [/charging_state_report\.current_charge_state$/i, /chargingState$/i, /charging_state$/i, /chargingStatus$/i],
        power: [/battery_state_report\.charge_power$/i, /chargePower_kW$/i, /charger_power$/i, /chargingPower$/i],
        plugged: [/plug_connection_state$/i, /plugConnectionState$/i, /charging_plug1_connectionstate$/i, /charge_port_door_open$/i, /plugged$/i],
        locked: [/statuseudata\.locked$/i, /doorLockStatus$/i, /vehicle_state\.locked$/i, /\.locked$/i, /\.lock_state$/i],
        mileage: [/mileage\.value$/i, /total_mileage\w*$/i, /odometer(_km)?$/i, /\.mileage$/i],
        target: [/settings\.target_soc$/i, /targetSOC_pct$/i, /charge_limit_soc$/i, /chargingTargetSoc$/i],
        lat: [/\.latitude$/i, /\.lat$/i],
        lon: [/\.longitude$/i, /\.lon$/i, /\.lng$/i],
        updated: [/_dataset_created_on$/i, /carCapturedTimestamp$/i, /timestamp$/i],
    };

    /** car folder of any data point: 'vw-connect.0.WVWZZZ…' */
    function prefixOf(id) {
        const m = /^([\w-]+\.\d+\.[^.]+)/.exec(String(id || ''));
        return m && ADAPTERS.includes(m[1].split('.')[0]) ? m[1] : '';
    }

    /** data point ids below the car -> {field: id} for the fields the patterns find */
    function match(ids) {
        const out = {};
        for (const [field, patterns] of Object.entries(FIELDS)) {
            for (const re of patterns) {
                const hit = ids.find(id => re.test(id));
                if (hit) {
                    out[field] = hit;
                    break;
                }
            }
        }
        return out;
    }

    /** charging state as German text (VW CHARGE_STATE_*, Tesla Charging/Complete …), else the data point's own text */
    function chargeText(info) {
        if (!info || info.missing || info.val === null || info.val === undefined || info.val === '') {
            return '';
        }
        const raw = String(info.val);
        const text = info.states && info.states[raw] !== undefined ? String(info.states[raw]) : raw;
        const t = text.toLowerCase();
        if (/not.?ready|notready/.test(t)) return 'Nicht bereit';
        if (/conservation|keep/.test(t)) return 'Erhaltungsladung';
        if (/discharg/.test(t)) return 'Entlädt';
        // "ready for charging" is no charging yet
        if (/ready|bereit|stopped|idle/.test(t)) return 'Bereit';
        if (/charging|lädt|^charge$/.test(t)) return 'Lädt';
        if (/complete|finished|full|done|voll/.test(t)) return 'Voll';
        if (/error|fault|fehler/.test(t)) return 'Ladefehler';
        if (/disconnect|unplug|off/.test(t)) return 'Nicht angesteckt';
        return text;
    }

    function charging(info) {
        return chargeText(info) === 'Lädt';
    }

    /** plugged in? true / false / null (unknown) */
    function plugged(info) {
        if (!info || info.missing || info.val === null || info.val === undefined || info.val === '') {
            return null;
        }
        const v = info.val;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v > 0;
        const raw = String(v);
        const t = (info.states && info.states[raw] !== undefined ? String(info.states[raw]) : raw).toLowerCase();
        if (/disconnect|unplug|not.?connect|false/.test(t)) return false;
        if (/connect|plugged|locked|true/.test(t)) return true;
        return null;
    }

    const api = { ADAPTERS, FIELDS, prefixOf, match, chargeText, charging, plugged };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.CarLogic = api;
    }
})(this);
