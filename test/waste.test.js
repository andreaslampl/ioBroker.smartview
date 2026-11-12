'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../www/wastelogic');

test('waste: iCal parsing (folded lines, escapes, date/time, repeat, exceptions) and grouping', () => {
    const ics = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261113', 'SUMMARY:Restmüll', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Vienna:20261113T060000', 'SUMMARY:Bio\\, Kompost', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261116', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'EXDATE;VALUE=DATE:20261130', 'SUMMARY:Gelber S', ' ack', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261113', 'SUMMARY:Restmüll', 'END:VEVENT', // duplicate
        'END:VCALENDAR',
    ].join('\r\n');
    const e = W.parse(ics, '2027-12-31');
    assert.deepEqual(e, [
        { date: '2026-11-13', title: 'Bio, Kompost' },
        { date: '2026-11-13', title: 'Restmüll' },
        { date: '2026-11-16', title: 'Gelber Sack' },
        { date: '2026-12-14', title: 'Gelber Sack' },
    ]);
    const days = W.days(e, '2026-11-12', 14, 'kompost');
    assert.deepEqual(days.map(d => [d.date, d.items.map(i => i.kind.key)]), [['2026-11-13', ['rest']], ['2026-11-16', ['gelb']]]);
    assert.equal(W.dayText('2026-11-13', '2026-11-12'), 'Morgen');
    assert.equal(W.dayText('2026-11-12', '2026-11-12'), 'Heute');
    assert.equal(W.dayText('2026-11-16', '2026-11-12'), 'Mo 16.11.');
    assert.equal(W.kindOf('Altpapier').key, 'papier');
    assert.equal(W.kindOf('Leichtverpackung').key, 'gelb');
    assert.equal(W.kindOf('Biotonne').key, 'bio');
    assert.equal(W.kindOf('Sperrmüllsammlung').key, 'sperr');
});
