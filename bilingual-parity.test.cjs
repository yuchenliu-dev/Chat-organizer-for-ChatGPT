'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const english = fs.readFileSync(path.join(root, 'chatgpt-sidebar-organizer.user.js'), 'utf8');
const chinese = fs.readFileSync(path.join(root, 'chatgpt-sidebar-organizer.zh-CN.user.js'), 'utf8');

function metadata(source, key) {
  return source.match(new RegExp(`^// @${key}\\s+(.+)$`, 'm'))?.[1]?.trim();
}

function functionNames(source) {
  return [...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]).sort();
}

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function cssBlock(source) {
  return source.match(/style\.textContent = `([\s\S]*?)`;\n\s*document\.head\.appendChild\(style\);/)?.[1];
}

new vm.Script(english, { filename: 'chatgpt-sidebar-organizer.user.js' });
new vm.Script(chinese, { filename: 'chatgpt-sidebar-organizer.zh-CN.user.js' });

assert.equal(metadata(english, 'version'), metadata(chinese, 'version'), 'Versions must match');
assert.equal(metadata(english, 'namespace'), metadata(chinese, 'namespace'), 'Namespaces must match');
assert.notEqual(metadata(english, 'name'), metadata(chinese, 'name'), 'Localized names should differ');
assert.match(metadata(chinese, 'name'), /简体中文/);

const englishStorage = english.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
const chineseStorage = chinese.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
assert.equal(englishStorage, chineseStorage, 'Both languages must share stored Organizer data');

assert.deepEqual(functionNames(english), functionNames(chinese), 'Function sets must match');
assert.equal(english.split('\n').length, chinese.split('\n').length, 'Localized files should retain the same line structure');
assert.equal(cssBlock(english), cssBlock(chinese), 'Layout and styling must remain identical');

const topologyPatterns = {
  rootListeners: /root\.addEventListener\(/g,
  windowListeners: /window\.addEventListener\(/g,
  documentListeners: /document\.addEventListener\(/g,
  observers: /new MutationObserver\(/g,
  intervals: /setInterval\(/g,
};
for (const [name, pattern] of Object.entries(topologyPatterns)) {
  assert.equal(count(english, pattern), count(chinese, pattern), `${name} must match`);
}

const safeguards = [
  'if (document.getElementById(APP_ID)) return;',
  'if (fullScanRunning) return;',
  'persist: false',
  'fullScanRunning = false;',
  'MAX_IMPORT_BYTES',
  'MAX_SECTIONS',
  'MAX_CHATS',
  "filter(chat => !chat.inProject && !getSection(chat.sectionId))",
];
for (const marker of safeguards) {
  assert.ok(english.includes(marker), `English script is missing safeguard: ${marker}`);
  assert.ok(chinese.includes(marker), `Chinese script is missing safeguard: ${marker}`);
}

console.log('PASS English and Simplified Chinese userscripts are structurally equivalent.');
console.log(`PASS Shared version ${metadata(english, 'version')} and storage key ${englishStorage}.`);
console.log('PASS Listener topology, CSS, function structure, and performance safeguards match.');
