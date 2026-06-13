// UI tests — written BEFORE js/app-core.js, js/app.js and index.html (TDD).
// Part 1: pure UI-logic unit tests (watchlist store, alert derivation/dedupe).
// Part 2: headless DOM end-to-end with jsdom (analyze flow, watchlist flow, alert banner).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addToWatchlist, removeFromWatchlist, deriveAlerts, alertKey,
  filterNewAlerts, verdictBadge,
} from '../js/app-core.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// ---------- watchlist store ----------
describe('watchlist store', () => {
  test('add normalizes symbol, dedupes, keeps entryPrice', () => {
    let wl = addToWatchlist([], { symbol: ' aapl ', entryPrice: 150 });
    wl = addToWatchlist(wl, { symbol: 'AAPL' }); // dup -> updates, no second row
    wl = addToWatchlist(wl, { symbol: 'spy' });
    assert.equal(wl.length, 2);
    assert.equal(wl[0].symbol, 'AAPL');
    assert.equal(wl[0].entryPrice, 150);
    assert.equal(wl[1].symbol, 'SPY');
  });
  test('add with new entryPrice updates existing row', () => {
    let wl = addToWatchlist([], { symbol: 'AAPL', entryPrice: 100 });
    wl = addToWatchlist(wl, { symbol: 'AAPL', entryPrice: 120 });
    assert.equal(wl.length, 1);
    assert.equal(wl[0].entryPrice, 120);
  });
  test('remove by symbol; original array not mutated', () => {
    const wl = addToWatchlist(addToWatchlist([], { symbol: 'AAPL' }), { symbol: 'SPY' });
    const out = removeFromWatchlist(wl, 'aapl');
    assert.equal(out.length, 1);
    assert.equal(out[0].symbol, 'SPY');
    assert.equal(wl.length, 2);
  });
  test('rejects empty/garbage symbols', () => {
    assert.equal(addToWatchlist([], { symbol: '  ' }).length, 0);
    assert.equal(addToWatchlist([], { symbol: null }).length, 0);
  });
});

// ---------- alert derivation (must mirror the server-side rules) ----------
describe('deriveAlerts', () => {
  const mkReport = (entryVerdict, exitVerdict) => ({
    symbol: 'TEST', price: 100,
    entry: { verdict: entryVerdict, reasons: ['r'], buyZone: [99, 104], pivot: 99, stop: 92 },
    exit: { verdict: exitVerdict, reasons: ['r'], stop: 92 },
  });
  test('ENTER -> ENTRY alert; EXIT -> EXIT alert; SELL_PARTIAL -> TAKE_PROFIT', () => {
    assert.equal(deriveAlerts(mkReport('ENTER', 'HOLD'))[0].type, 'ENTRY');
    assert.equal(deriveAlerts(mkReport('WAIT', 'EXIT'))[0].type, 'EXIT');
    assert.equal(deriveAlerts(mkReport('WAIT', 'SELL_PARTIAL'))[0].type, 'TAKE_PROFIT');
  });
  test('no trigger -> no alerts', () => {
    assert.equal(deriveAlerts(mkReport('WAIT', 'HOLD')).length, 0);
    assert.equal(deriveAlerts(mkReport('NO_ENTRY', 'RAISE_STOP')).length, 0);
  });
  test('same alert not re-fired the same day (dedupe), refires next day', () => {
    const alerts = deriveAlerts(mkReport('ENTER', 'HOLD'));
    const seen = new Set();
    const day1 = filterNewAlerts(alerts, seen, '2026-06-11');
    assert.equal(day1.length, 1);
    seen.add(alertKey(alerts[0], '2026-06-11'));
    assert.equal(filterNewAlerts(alerts, seen, '2026-06-11').length, 0);
    assert.equal(filterNewAlerts(alerts, seen, '2026-06-12').length, 1);
  });
});

// ---------- verdict presentation ----------
describe('verdictBadge', () => {
  test('maps verdicts to label and css class', () => {
    assert.deepEqual(verdictBadge('ENTER'), { label: 'ENTER NOW', cls: 'good' });
    assert.equal(verdictBadge('EXIT').cls, 'bad');
    assert.equal(verdictBadge('WAIT').cls, 'warn');
    assert.ok(verdictBadge('UNKNOWN_X').label); // never throws
  });
});

// ---------- headless DOM end-to-end (jsdom) ----------
describe('dashboard e2e (jsdom)', async () => {
  const { JSDOM } = await import('jsdom');

  async function boot() {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
    const fetchImpl = async (url) => {
      let body;
      if (url.includes('%5EGSPC')) body = fixture('chart_GSPC.json');
      else if (url.includes('fundamentals-timeseries')) body = fixture('fundamentals_AAPL.json');
      else if (url.includes('/SPY')) body = fixture('chart_SPY.json');
      else if (url.includes('INVALID')) body = fixture('chart_INVALID.json');
      else body = fixture('chart_AAPL.json');
      return { ok: true, status: 200, json: async () => body };
    };
    const { initApp } = await import('../js/app.js');
    const notifications = [];
    const app = initApp({
      document: dom.window.document,
      storage: dom.window.localStorage,
      fetchImpl,
      notify: (title, body) => notifications.push({ title, body }),
      autoRefreshMs: 0, // disable timers in tests
    });
    return { dom, app, notifications };
  }

  test('index.html declares required elements', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const id of ['ticker-input', 'analyze-btn', 'verdict-entry', 'verdict-exit',
      'trend-template', 'watchlist', 'add-watch-btn', 'alerts', 'fundamentals', 'price-chart']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.match(html, /not financial advice/i);
  });

  test('analyze flow renders verdicts, 8 checklist rows, levels and fundamentals', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    doc.getElementById('ticker-input').value = 'AAPL';
    await app.analyze();
    assert.ok(doc.getElementById('verdict-entry').textContent.length > 2);
    assert.ok(doc.getElementById('verdict-exit').textContent.length > 2);
    assert.equal(doc.querySelectorAll('#trend-template .tt-row').length, 8);
    assert.ok(doc.getElementById('fundamentals').textContent.trim().length > 0);
  });

  test('invalid ticker shows an error message, no crash', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    doc.getElementById('ticker-input').value = 'INVALIDXYZ123';
    await app.analyze();
    assert.match(doc.getElementById('alerts').textContent + doc.body.textContent, /not found|no data|error/i);
  });

  test('watchlist: add persists to localStorage and renders; remove clears', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    doc.getElementById('ticker-input').value = 'AAPL';
    await app.analyze();
    await app.addCurrentToWatchlist();
    const stored = JSON.parse(dom.window.localStorage.getItem('minervini_watchlists'));
    const active = stored.lists.find((l) => l.name === stored.activeName);
    assert.equal(active.items.length, 1);
    assert.equal(active.items[0].symbol, 'AAPL');
    assert.match(doc.getElementById('watchlist').textContent, /AAPL/);
    app.removeWatch('AAPL');
    const after = JSON.parse(dom.window.localStorage.getItem('minervini_watchlists'));
    assert.equal(after.lists.find((l) => l.name === after.activeName).items.length, 0);
  });

  test('watchlist refresh surfaces triggered alerts in the alerts panel and notifies', async () => {
    const { dom, app, notifications } = await boot();
    // SPY with entryPrice 1 guarantees a TAKE_PROFIT/EXIT trigger on fixture data
    app.setWatchlist([{ symbol: 'SPY', entryPrice: 1 }]);
    await app.refreshWatchlist();
    const text = dom.window.document.getElementById('alerts').textContent;
    assert.match(text, /SPY/);
    assert.ok(notifications.length >= 1, 'desktop notification should fire');
  });

  test('export: watchlist JSON for the repo matches the saved list', async () => {
    const { app } = await boot();
    app.setWatchlist([{ symbol: 'AAPL', entryPrice: 100 }]);
    const json = app.exportWatchlistJson();
    const pub = JSON.parse(json);
    const active = pub.lists.find((l) => l.name === pub.activeName);
    assert.deepEqual(active.items, [{ symbol: 'AAPL', entryPrice: 100 }]);
    assert.ok(pub.lists.every((l) => !('subscribers' in l)));
  });
});

// ===== Phase 1: clear & reset alerts (appended, TDD) =====
describe('clear & reset alerts', async () => {
  const { JSDOM } = await import('jsdom');
  const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  async function boot() {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
    const fetchImpl = async (url) => {
      let body;
      if (url.includes('%5EGSPC')) body = fx('chart_GSPC.json');
      else if (url.includes('fundamentals-timeseries')) body = fx('fundamentals_AAPL.json');
      else if (url.includes('/SPY')) body = fx('chart_SPY.json');
      else body = fx('chart_AAPL.json');
      return { ok: true, status: 200, json: async () => body };
    };
    const { initApp } = await import('../js/app.js');
    const app = initApp({ document: dom.window.document, storage: dom.window.localStorage,
      fetchImpl, notify: () => {}, autoRefreshMs: 0 });
    return { dom, app };
  }
  test('index.html declares clear-alerts-btn', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="clear-alerts-btn"'), 'missing #clear-alerts-btn');
  });
  test('clearAlerts empties the panel and resets dedupe so triggers can re-fire', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    app.setWatchlist([{ symbol: 'SPY', entryPrice: 1 }]); // guarantees a trigger on fixture
    await app.refreshWatchlist();
    assert.match(doc.getElementById('alerts').textContent, /SPY/);
    app.clearAlerts();
    assert.equal(doc.getElementById('alerts').textContent.trim(), '');
    await app.refreshWatchlist(); // dedupe was reset -> same alert appears again
    assert.match(doc.getElementById('alerts').textContent, /SPY/);
  });
});

// ===== Twice-daily check scheduling helper (appended, TDD) =====
describe('msUntilNextSlot (twice-daily, UTC, weekdays only)', async () => {
  const { msUntilNextSlot } = await import('../js/app-core.js');
  const SLOTS = [[13, 45], [19, 45]];
  const at = (now, ms) => new Date(new Date(now).getTime() + ms).toISOString();
  test('before first slot -> waits until first slot same day', () => {
    const now = new Date('2026-06-15T10:00:00Z'); // Monday
    assert.equal(at(now, msUntilNextSlot(now, SLOTS)), '2026-06-15T13:45:00.000Z');
  });
  test('between slots -> waits until second slot same day', () => {
    const now = new Date('2026-06-15T14:00:00Z');
    assert.equal(at(now, msUntilNextSlot(now, SLOTS)), '2026-06-15T19:45:00.000Z');
  });
  test('after both slots on Friday -> skips weekend to Monday first slot', () => {
    const now = new Date('2026-06-12T20:00:00Z'); // Friday, after 19:45
    assert.equal(at(now, msUntilNextSlot(now, SLOTS)), '2026-06-15T13:45:00.000Z');
  });
  test('on a Saturday -> next is Monday first slot', () => {
    const now = new Date('2026-06-13T10:00:00Z'); // Saturday
    assert.equal(at(now, msUntilNextSlot(now, SLOTS)), '2026-06-15T13:45:00.000Z');
  });
});

// ===== Phase 2: named watchlists collection core (appended, TDD) =====
describe('named watchlists (collection core)', async () => {
  const core = await import('../js/app-core.js');
  const base = () => core.migrateCollection(null, [{ symbol: 'AAPL' }]);
  test('migrate from legacy array wraps into a Default list', () => {
    const c = core.migrateCollection(null, [{ symbol: 'AAPL', entryPrice: 10 }, { symbol: 'SPY' }]);
    assert.equal(c.version, 3);
    assert.equal(c.activeName, 'Default');
    assert.equal(c.lists.length, 1);
    assert.equal(c.lists[0].name, 'Default');
    assert.equal(c.lists[0].items.length, 2);
    assert.deepEqual(c.lists[0].subscribers, []);
  });
  test('migrate passes an existing collection through and fills missing defaults', () => {
    const raw = { version: 3, activeName: 'B', lists: [{ name: 'A', items: [{ symbol: 'X' }] }, { name: 'B', items: [] }] };
    const c = core.migrateCollection(raw, null);
    assert.equal(c.activeName, 'B');
    assert.deepEqual(c.lists[1].subscribers, []);
  });
  test('migrate with nothing stored yields a single empty Default list', () => {
    const c = core.migrateCollection(null, null);
    assert.equal(c.lists.length, 1);
    assert.equal(c.lists[0].items.length, 0);
  });
  test('create adds a uniquely named list and makes it active', () => {
    const c = core.createWatchlist(base(), 'Semis');
    assert.deepEqual(core.listNames(c), ['Default', 'Semis']);
    assert.equal(c.activeName, 'Semis');
  });
  test('create rejects blank or duplicate names (case-insensitive) as a no-op', () => {
    const c = base();
    assert.equal(core.createWatchlist(c, '   ').lists.length, 1);
    assert.equal(core.createWatchlist(c, 'default').lists.length, 1);
  });
  test('setActive switches only to an existing list', () => {
    let c = core.createWatchlist(base(), 'Semis');
    c = core.setActiveWatchlist(c, 'Default');
    assert.equal(c.activeName, 'Default');
    assert.equal(core.setActiveWatchlist(c, 'Nope').activeName, 'Default');
  });
  test('items operate on the active list only', () => {
    let c = core.createWatchlist(base(), 'Semis');
    c = core.setActiveItems(c, core.addToWatchlist(core.getActiveItems(c), { symbol: 'NVDA' }));
    assert.deepEqual(core.getActiveItems(c).map((i) => i.symbol), ['NVDA']);
    c = core.setActiveWatchlist(c, 'Default');
    assert.deepEqual(core.getActiveItems(c).map((i) => i.symbol), ['AAPL']);
  });
  test('rename updates the name and activeName, rejects duplicates', () => {
    let c = core.createWatchlist(base(), 'Semis');
    c = core.renameWatchlist(c, 'Semis', 'Chips');
    assert.deepEqual(core.listNames(c), ['Default', 'Chips']);
    assert.equal(c.activeName, 'Chips');
    const c2 = core.renameWatchlist(c, 'Chips', 'default'); // dup -> no-op
    assert.ok(core.listNames(c2).includes('Chips'));
  });
  test('delete removes a list, cannot delete the last, reassigns active', () => {
    let c = core.createWatchlist(base(), 'Semis'); // active = Semis
    c = core.deleteWatchlist(c, 'Semis');
    assert.deepEqual(core.listNames(c), ['Default']);
    assert.equal(c.activeName, 'Default');
    assert.equal(core.deleteWatchlist(c, 'Default').lists.length, 1); // last -> no-op
  });
});

// ===== Phase 3: subscribers + split exports (appended, TDD) =====
describe('subscribers (mailing lists per watchlist)', async () => {
  const core = await import('../js/app-core.js');
  const base = () => core.createWatchlist(core.migrateCollection(null, [{ symbol: 'AAPL' }]), 'Semis');
  test('isValidEmail accepts real addresses, rejects junk', () => {
    assert.ok(core.isValidEmail('a@b.com'));
    assert.ok(!core.isValidEmail('nope'));
    assert.ok(!core.isValidEmail('a@b'));
    assert.ok(!core.isValidEmail(''));
  });
  test('add subscriber validates and dedupes case-insensitively', () => {
    let c = base();
    c = core.addSubscriber(c, 'Semis', 'Alice@X.com');
    c = core.addSubscriber(c, 'Semis', 'alice@x.com'); // dup -> no-op
    c = core.addSubscriber(c, 'Semis', 'bad-email');    // invalid -> no-op
    assert.deepEqual(core.getActiveList(c).subscribers, ['Alice@X.com']);
  });
  test('remove subscriber is case-insensitive', () => {
    let c = core.addSubscriber(base(), 'Semis', 'a@b.com');
    c = core.removeSubscriber(c, 'Semis', 'A@B.COM');
    assert.deepEqual(core.getActiveList(c).subscribers, []);
  });
  test('update subscriber replaces email, rejects invalid/duplicate', () => {
    let c = core.addSubscriber(core.addSubscriber(base(), 'Semis', 'a@b.com'), 'Semis', 'c@d.com');
    c = core.updateSubscriber(c, 'Semis', 'a@b.com', 'x@y.com');
    assert.deepEqual(core.getActiveList(c).subscribers, ['x@y.com', 'c@d.com']);
    assert.deepEqual(core.getActiveList(core.updateSubscriber(c, 'Semis', 'x@y.com', 'c@d.com')).subscribers, ['x@y.com', 'c@d.com']);
    assert.deepEqual(core.getActiveList(core.updateSubscriber(c, 'Semis', 'x@y.com', 'bad')).subscribers, ['x@y.com', 'c@d.com']);
  });
  test('exportPublicWatchlist strips subscriber emails', () => {
    const c = core.addSubscriber(base(), 'Semis', 'a@b.com');
    const pub = core.exportPublicWatchlist(c);
    assert.ok(pub.lists.every((l) => !('subscribers' in l)));
    assert.equal(pub.lists.find((l) => l.name === 'Default').items.length, 1);
  });
  test('exportMailingLists maps list name to emails and omits empty lists', () => {
    const c = core.addSubscriber(base(), 'Semis', 'a@b.com');
    assert.deepEqual(core.exportMailingLists(c), { Semis: ['a@b.com'] });
  });
});

// ===== Phase 4: browser UI for lists & subscribers (appended, TDD) =====
describe('browser UI: lists & subscribers (jsdom)', async () => {
  const { JSDOM } = await import('jsdom');
  const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  async function boot() {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
    const fetchImpl = async (url) => {
      let body;
      if (url.includes('%5EGSPC')) body = fx('chart_GSPC.json');
      else if (url.includes('fundamentals-timeseries')) body = fx('fundamentals_AAPL.json');
      else if (url.includes('/SPY')) body = fx('chart_SPY.json');
      else body = fx('chart_AAPL.json');
      return { ok: true, status: 200, json: async () => body };
    };
    const { initApp } = await import('../js/app.js');
    const app = initApp({ document: dom.window.document, storage: dom.window.localStorage,
      fetchImpl, notify: () => {}, autoRefreshMs: 0 });
    return { dom, app };
  }
  test('index.html declares the new list & subscriber controls', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const id of ['watchlist-select', 'new-watchlist-btn', 'rename-watchlist-btn',
      'delete-watchlist-btn', 'subscribers', 'subscriber-input', 'add-subscriber-btn',
      'copy-mailing-btn', 'mailing-json']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
  });
  test('create + switch lists keeps items separate; selector reflects the active list', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    app.setWatchlist([{ symbol: 'AAPL' }]);   // into Default
    app.newWatchlist('Semis');                 // active -> Semis
    app.setWatchlist([{ symbol: 'NVDA' }]);    // into Semis
    assert.equal(doc.getElementById('watchlist-select').value, 'Semis');
    assert.match(doc.getElementById('watchlist').textContent, /NVDA/);
    app.selectWatchlist('Default');
    assert.match(doc.getElementById('watchlist').textContent, /AAPL/);
    assert.equal(doc.getElementById('watchlist').textContent.includes('NVDA'), false);
  });
  test('subscriber add/remove reflects in the DOM and persists per list', async () => {
    const { dom, app } = await boot();
    const doc = dom.window.document;
    app.newWatchlist('Semis');
    app.addSubscriberToActive('alice@example.com');
    assert.match(doc.getElementById('subscribers').textContent, /alice@example.com/);
    const stored = JSON.parse(dom.window.localStorage.getItem('minervini_watchlists'));
    assert.deepEqual(stored.lists.find((l) => l.name === 'Semis').subscribers, ['alice@example.com']);
    app.removeSubscriberFromActive('alice@example.com');
    assert.equal(doc.getElementById('subscribers').textContent.includes('alice@example.com'), false);
  });
  test('exports split correctly: private holds emails keyed by list, public omits them', async () => {
    const { app } = await boot();
    app.newWatchlist('Semis');
    app.addSubscriberToActive('a@b.com');
    assert.deepEqual(JSON.parse(app.exportMailingListsJson()), { Semis: ['a@b.com'] });
    const pub = JSON.parse(app.exportWatchlistJson());
    assert.ok(pub.lists.every((l) => !('subscribers' in l)));
  });
});
