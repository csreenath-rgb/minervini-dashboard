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
    const stored = JSON.parse(dom.window.localStorage.getItem('minervini_watchlist'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].symbol, 'AAPL');
    assert.match(doc.getElementById('watchlist').textContent, /AAPL/);
    app.removeWatch('AAPL');
    assert.equal(JSON.parse(dom.window.localStorage.getItem('minervini_watchlist')).length, 0);
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
    assert.deepEqual(JSON.parse(json), [{ symbol: 'AAPL', entryPrice: 100 }]);
  });
});
