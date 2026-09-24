'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'chatgpt-sidebar-organizer.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadCore(storedValue = null) {
  const startMarker = '(() => {';
  const startupMarker = '\n  installStyles();';
  const start = source.indexOf(startMarker);
  const end = source.lastIndexOf(startupMarker);
  assert.ok(start >= 0 && end > start, 'Unable to locate userscript wrapper');

  const storage = {
    value: storedValue,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
  };
  const context = {
    console: { ...console, warn: () => {} },
    URL,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    localStorage: storage,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    navigator: { language: 'en-US' },
    document: {
      getElementById: () => null,
      documentElement: { lang: 'en' },
      cookie: '',
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  context.globalThis = context;
  vm.createContext(context);

  const inner = source.slice(start + startMarker.length, end);
  const exports = `
    globalThis.__CSO_TEST_API__ = {
      defaultState, loadState, normalizeState, saveState, esc,
      chatKey, isProjectUrl, isNonConversationTitle, isPlaceholderTitle,
      cleanNativeAnchorTitle, nextManualOrder, createSection, visibleChats,
      getState: () => state,
      setState: value => { state = value; },
    };
  `;
  vm.runInContext(`(() => {${inner}${exports}})();`, context, { filename: sourcePath });
  return { api: context.__CSO_TEST_API__, context, storage };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('invalid stored JSON falls back to a clean state', () => {
  const { api } = loadCore('{not-json');
  const state = api.getState();
  assert.equal(state.version, 3);
  assert.deepEqual(Object.keys(state.chats), []);
  assert.deepEqual(Array.from(state.sections), []);
});

test('conversation IDs are validated and canonicalized', () => {
  const { api } = loadCore();
  assert.equal(api.chatKey('https://chatgpt.com/c/1234567890abcdef'), 'chat:1234567890abcdef');
  assert.equal(api.chatKey('https://chatgpt.com/c/short'), null);
  assert.equal(api.chatKey('javascript:alert(1)'), null);
  assert.equal(api.chatKey('https://chatgpt.com/c/1234567890abcdef?x=1#y'), 'chat:1234567890abcdef');
});

test('Project URLs are detected without losing the stored section', () => {
  const { api } = loadCore();
  const state = api.normalizeState({
    version: 3,
    sections: [{ id: 'research', name: 'Research', color: '#10a37f' }],
    chats: {
      old: {
        url: 'https://chatgpt.com/g/g-p-project123/c/1234567890abcdef',
        title: 'Project conversation',
        sectionId: 'research',
      },
    },
    ui: {},
  });
  const chat = state.chats['chat:1234567890abcdef'];
  assert.equal(chat.inProject, true);
  assert.equal(chat.type, 'project');
  assert.equal(chat.sectionId, 'research');
});

test('malformed sections and chats are sanitized', () => {
  const { api } = loadCore();
  const state = api.normalizeState({
    version: 3,
    sections: [
      { id: 'one', name: '  Valid  ', color: '#ABCDEF' },
      { id: 'one', name: 'Duplicate', color: '#000000' },
      { id: 'bad', name: '', color: 'red' },
      null,
    ],
    chats: {
      arbitraryKey: {
        url: 'https://chatgpt.com/c/aaaaaaaaaaaaaaaa',
        title: '',
        sectionId: 'missing',
        status: 'unknown',
        createdAt: -1,
        lastSeen: 'yesterday',
      },
      nav: {
        url: 'https://chatgpt.com/c/bbbbbbbbbbbbbbbb',
        title: 'Open desktop app',
      },
      broken: { url: 'https://chatgpt.com/c/short', title: 'Broken' },
    },
    ui: { query: 42, section: 'missing', status: 'broken', type: 'broken', sort: 'broken' },
  });
  assert.equal(state.sections.length, 1);
  assert.equal(state.sections[0].name, 'Valid');
  assert.equal(Object.keys(state.chats).length, 1);
  const chat = state.chats['chat:aaaaaaaaaaaaaaaa'];
  assert.equal(chat.title, 'Fetching title…');
  assert.equal(chat.sectionId, '');
  assert.equal(chat.status, 'none');
  assert.equal(state.ui.query, '');
  assert.equal(state.ui.section, 'all');
});

test('legacy hidden status migrates to Backlog', () => {
  const { api } = loadCore();
  const state = api.normalizeState({
    version: 2,
    sections: [],
    chats: { x: { url: 'https://chatgpt.com/c/cccccccccccccccc', title: 'Legacy', status: 'hidden' } },
    ui: {},
  });
  assert.equal(state.chats['chat:cccccccccccccccc'].status, 'backlog');
});

test('native sidebar suffixes do not become part of the title', () => {
  const { api } = loadCore();
  assert.equal(api.cleanNativeAnchorTitle('Actual title, Work'), 'Actual title');
  assert.equal(api.cleanNativeAnchorTitle('Actual title Options'), 'Actual title');
  assert.equal(api.isPlaceholderTitle('Untitled chat'), true);
});

test('HTML-sensitive user data is escaped', () => {
  const { api } = loadCore();
  assert.equal(api.esc('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
});

test('duplicate section creation is rejected', () => {
  const { api } = loadCore();
  const state = api.defaultState();
  state.sections.push({ id: 'one', name: 'Research', color: '#10a37f', order: 0, collapsed: false });
  api.setState(state);
  const result = api.createSection(' research ', '#ffffff');
  assert.equal(result.section.id, 'one');
  assert.match(result.error, /already exists/i);
  assert.equal(api.getState().sections.length, 1);
});

test('manual ordering handles very large arrays without spread-argument overflow', () => {
  const { api } = loadCore();
  const state = api.defaultState();
  for (let i = 0; i < 50_000; i += 1) {
    const key = `chat:${String(i).padStart(16, '0')}`;
    state.chats[key] = { key, sectionId: '', manualOrder: i * 10 };
  }
  api.setState(state);
  assert.equal(api.nextManualOrder('', false), 500_000);
  assert.equal(api.nextManualOrder('', true), -10);
});

test('Project conversations are excluded from visible results', () => {
  const { api } = loadCore();
  const state = api.defaultState();
  state.chats = {
    'chat:1111111111111111': { key: 'chat:1111111111111111', title: 'Visible', sectionId: '', status: 'none', type: 'chat', inProject: false, lastSeen: 1, manualOrder: 0 },
    'chat:2222222222222222': { key: 'chat:2222222222222222', title: 'Project', sectionId: '', status: 'none', type: 'project', inProject: true, lastSeen: 2, manualOrder: 10 },
  };
  api.setState(state);
  assert.deepEqual(Array.from(api.visibleChats(), chat => chat.title), ['Visible']);
});

test('storage quota failure is contained instead of crashing actions', () => {
  const { api, storage } = loadCore();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(api.saveState(), false);
});

test('listener topology has no polling loop or duplicate startup installation', () => {
  assert.equal((source.match(/setInterval\s*\(/g) || []).length, 0);
  assert.equal((source.match(/new MutationObserver\s*\(/g) || []).length, 1);
  assert.equal((source.match(/document\.addEventListener\('click'/g) || []).length, 1);
  assert.match(source, /if \(document\.getElementById\(APP_ID\)\) return;/);
  assert.match(source, /const cleanLayer = layer\.cloneNode\(false\);/);
  assert.match(source, /layer\.replaceWith\(cleanLayer\);/);
});

test('full reindex batches persistence and always releases its running state', () => {
  assert.match(source, /harvestNativeChats\(\{ includeCurrent: false, persist: false \}\)/);
  assert.match(source, /function scanNativeChats\(\) \{\s*if \(fullScanRunning\) return;/);
  assert.match(source, /finally\s*\{[\s\S]*fullScanRunning = false;/);
});

test('batch editor only selects unsectioned, non-Project conversations', () => {
  assert.match(source, /filter\(chat => !chat\.inProject && !getSection\(chat\.sectionId\)\)/);
});

function syntheticState(count) {
  const chats = {};
  for (let i = 0; i < count; i += 1) {
    const id = String(i).padStart(16, '0');
    chats[`chat:${id}`] = {
      key: `chat:${id}`,
      title: `Synthetic conversation ${i}`,
      url: `https://chatgpt.com/c/${id}`,
      sectionId: i % 3 === 0 ? 'research' : '',
      status: i % 4 === 0 ? 'active' : 'none',
      type: 'chat',
      inProject: false,
      createdAt: 1_700_000_000_000 + i,
      lastSeen: 1_700_000_000_000 + i,
      manualOrder: i * 10,
    };
  }
  return {
    version: 3,
    sections: [{ id: 'research', name: 'Research', color: '#10a37f', order: 0, collapsed: false }],
    chats,
    ui: {},
  };
}

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const { api } = loadCore();
const benchmark = [100, 1_000, 5_000].map(count => {
  const raw = syntheticState(count);
  const serializedBytes = Buffer.byteLength(JSON.stringify(raw));
  const start = performance.now();
  api.normalizeState(raw);
  const normalizeMs = performance.now() - start;
  return { conversations: count, serializedBytes, normalizeMs: Number(normalizeMs.toFixed(2)) };
});

console.log(`\n${passed}/${tests.length} robustness checks passed.`);
console.log(`BENCHMARK ${JSON.stringify(benchmark)}`);
