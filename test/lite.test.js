'use strict';

// SmartView Lite must keep running on iOS 9 Safari: plain ES5 only (checked roughly without a parser dependency)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('www/lite.js uses no syntax / API that iOS 9 Safari lacks', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'lite.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const bad = [
        [/=>/, 'arrow function'],
        [/\b(let|const|class)\s/, 'let / const / class'],
        [/`/, 'template string'],
        [/\.\.\./, 'spread'],
        [/\b(async|await)\b/, 'async / await'],
        [/\bfetch\(/, 'fetch'],
        [/\.(includes|closest|startsWith|endsWith|padStart|find|findIndex)\(/, 'newer method'],
        [/\?\.|\?\?/, 'optional chaining / nullish'],
    ];
    for (const [re, what] of bad) {
        assert.ok(!re.test(src), `lite.js: ${what} (${(src.match(re) || [])[0]})`);
    }
});
