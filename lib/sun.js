'use strict';

/*
 * Sunrise and sunset (sunrise equation, accuracy about a minute; enough for switching lights).
 * Same file as lib/sun.js in ioBroker.logik.
 * Times are UTC milliseconds of the local calendar day of `when` at the given place.
 */

const RAD = Math.PI / 180;

function julian(ms) {
    return ms / 86400000 + 2440587.5;
}

function fromJulian(j) {
    return (j - 2440587.5) * 86400000;
}

/**
 * @param {number} when ms within the day wanted
 * @param {number} lat degrees north
 * @param {number} lon degrees east
 * @returns {{rise: number, set: number}} ms; polar day/night: whole day / empty day
 */
function sunTimes(when, lat, lon) {
    // local noon of that day as reference
    const d = new Date(when);
    d.setHours(12, 0, 0, 0);
    const n = Math.round(julian(d.getTime()) - 2451545.0 + 0.0008);
    const jStar = n - lon / 360;
    const M = (357.5291 + 0.98560028 * jStar) % 360;
    const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
    const lambda = (M + C + 180 + 102.9372) % 360;
    const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
    const sinDec = Math.sin(lambda * RAD) * Math.sin(23.44 * RAD);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosOmega = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
    const start = new Date(when).setHours(0, 0, 0, 0);
    if (cosOmega < -1) {
        return { rise: start, set: start + 86400000 }; // sun never sets
    }
    if (cosOmega > 1) {
        return { rise: start, set: start }; // sun never rises
    }
    const omega = Math.acos(cosOmega) / RAD;
    return { rise: Math.round(fromJulian(transit - omega / 360)), set: Math.round(fromJulian(transit + omega / 360)) };
}

module.exports = { sunTimes };
