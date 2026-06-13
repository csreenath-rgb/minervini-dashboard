// Integration tests — written BEFORE js/data.js and scripts/check_alerts.mjs (TDD).
// Covers: URL building, proxy fallback ordering, fetch pipeline on fixtures,
// live smoke test, and the watchlist alert script end-to-end on fixtures.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chartUrl, fundamentalsUrl, PROXIES, fetchJsonWithFallback, fetchTickerBundle,
} from '../js/data.js';
import { checkWatchlist, buildEmail } from '../scripts/check_alerts.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// ---------- URL building ----------
describe('URL building', () => {
  test('chartUrl builds a Yahoo v8 chart URL with range and interval', () => {
    const u = chartUrl('AAPL');
    assert.match(u, /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL/);
    assert.match(u, /range=2y/);
    assert.match(u, /interval=1d/);
  });
  test('chartUrl URL-encodes special symbols like ^GSPC', () => {
    const u = chartUrl('^GSPC');
    assert.ok(u.includes('%5EGSPC'), u);
    assert.ok(!u.includes('/^'));
  });
  test('fundamentalsUrl requests quarterly EPS, revenue, net income', () => {
    const u = fundamentalsUrl('AAPL');
    assert.match(u, /fundamentals-timeseries/);
    assert.match(u, /quarterlyDilutedEPS/);
    assert.match(u, /quarterlyTotalRevenue/);
    assert.match(u, /quarterlyNetIncome/);
  });
  test('at least 3 distinct CORS proxies are configured', () => {
    assert.ok(PROXIES.length >= 3);
    const urls = PROXIES.map((p) => p('https://x.test/a'));
    assert.equal(new Set(urls).size, urls.length);
    for (const u of urls) assert.ok(u.includes(encodeURIComponent('https://x.test/a')) || u.includes('https://x.test/a'));
  });
});

// ---------- proxy fallback ----------
describe('fetchJsonWithFallback', () => {
  const GOOD = { chart: { result: [{ ok: true }] } };
  function fakeFetch(behaviorByCall) {
    let call = 0;
    const calls = [];
    const fn = async (url) => {
      const b = behaviorByCall[Math.min(call, behaviorByCall.length - 1)];
      call++; calls.push(url);
      if (b === 'network-error') throw new Error('network down');
      if (b === 'http-500') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => GOOD };
    };
    fn.calls = calls;
    return fn;
  }
  test('tries direct first, succeeds without touching proxies', async () => {
    const f = fakeFetch(['ok']);
    const out = await fetchJsonWithFallback('https://target.test/data', { fetchImpl: f });
    assert.deepEqual(out, GOOD);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0], 'https://target.test/data');
  });
  test('falls back to proxy 1 when direct fails, then proxy 2 when proxy 1 fails', async () => {
    const f = fakeFetch(['network-error', 'http-500', 'ok']);
    const out = await fetchJsonWithFallback('https://target.test/data', { fetchImpl: f });
    assert.deepEqual(out, GOOD);
    assert.equal(f.calls.length, 3);
    // call 2 and 3 must be proxied versions of the target, in PROXIES order
    assert.equal(f.calls[1], PROXIES[0]('https://target.test/data'));
    assert.equal(f.calls[2], PROXIES[1]('https://target.test/data'));
  });
  test('throws a clear error when every route fails', async () => {
    const f = fakeFetch(['network-error']);
    await assert.rejects(
      () => fetchJsonWithFallback('https://target.test/data', { fetchImpl: f }),
      /all data sources failed/i
    );
  });
});

// ---------- bundle fetch on fixtures ----------
describe('fetchTickerBundle', () => {
  test('fetches chart, benchmark and fundamentals in one bundle (fixture-backed fetch)', async () => {
    const f = async (url) => {
      let body;
      if (url.includes('%5EGSPC')) body = fixture('chart_GSPC.json');
      else if (url.includes('fundamentals-timeseries')) body = fixture('fundamentals_AAPL.json');
      else body = fixture('chart_AAPL.json');
      return { ok: true, status: 200, json: async () => body };
    };
    const b = await fetchTickerBundle('AAPL', { fetchImpl: f });
    assert.equal(b.chartJson.chart.result[0].meta.symbol, 'AAPL');
    assert.equal(b.benchJson.chart.result[0].meta.symbol, '^GSPC');
    assert.ok(b.fundJson.timeseries);
  });
  test('fundamentals failure does not sink the bundle (best-effort)', async () => {
    const f = async (url) => {
      if (url.includes('fundamentals-timeseries')) throw new Error('boom');
      return {
        ok: true, status: 200,
        json: async () => (url.includes('%5EGSPC') ? fixture('chart_GSPC.json') : fixture('chart_AAPL.json')),
      };
    };
    const b = await fetchTickerBundle('AAPL', { fetchImpl: f });
    assert.ok(b.chartJson);
    assert.equal(b.fundJson, null);
  });
});

// ---------- live smoke test (real network, direct) ----------
describe('live smoke test', () => {
  test('fetches real MSFT data and the full pipeline produces a verdict', async () => {
    const { analyzeTicker } = await import('../js/engine.js');
    const b = await fetchTickerBundle('MSFT', {});
    const r = analyzeTicker({ chartJson: b.chartJson, benchJson: b.benchJson, fundJson: b.fundJson });
    assert.equal(r.symbol, 'MSFT');
    assert.ok(r.price > 0);
    assert.ok(['ENTER', 'WAIT', 'EXTENDED', 'NO_ENTRY'].includes(r.entry.verdict));
  });
});

// ---------- alert script ----------
describe('check_alerts (watchlist alert script)', () => {
  const fixtureFetch = async (url) => {
    let body;
    if (url.includes('%5EGSPC')) body = fixture('chart_GSPC.json');
    else if (url.includes('fundamentals-timeseries')) body = fixture('fundamentals_AAPL.json');
    else if (url.includes('/SPY?')) body = fixture('chart_SPY.json');
    else if (url.includes('INVALIDXYZ123')) body = fixture('chart_INVALID.json');
    else body = fixture('chart_AAPL.json');
    return { ok: true, status: 200, json: async () => body };
  };

  test('produces a report for each watchlist entry; alerts only on trigger verdicts', async () => {
    const watchlist = [{ symbol: 'AAPL' }, { symbol: 'SPY', entryPrice: 400 }];
    const { results, alerts } = await checkWatchlist(watchlist, { fetchImpl: fixtureFetch });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.ok(['ENTER', 'WAIT', 'EXTENDED', 'NO_ENTRY'].includes(r.entryVerdict), r.entryVerdict);
    }
    // every alert must correspond to a trigger verdict
    for (const a of alerts) {
      assert.ok(['ENTRY', 'EXIT', 'TAKE_PROFIT'].includes(a.type));
      assert.ok(a.symbol && a.message && a.price > 0);
    }
    // SPY with entry at 400: fixture price determines exit verdict; consistency check
    const spy = results.find((r) => r.symbol === 'SPY');
    const spyAlert = alerts.find((a) => a.symbol === 'SPY' && (a.type === 'EXIT' || a.type === 'TAKE_PROFIT'));
    const shouldAlert = ['EXIT', 'SELL_PARTIAL'].includes(spy.exitVerdict);
    assert.equal(!!spyAlert, shouldAlert);
  });

  test('invalid ticker is reported as an error, does not crash the run', async () => {
    const { results, alerts } = await checkWatchlist([{ symbol: 'INVALIDXYZ123' }], { fetchImpl: fixtureFetch });
    assert.equal(results.length, 1);
    assert.ok(results[0].error);
    assert.equal(alerts.length, 0);
  });

  test('buildEmail: null when no alerts, formatted subject/body when alerts exist', () => {
    assert.equal(buildEmail([]), null);
    const email = buildEmail([
      { symbol: 'AAPL', type: 'ENTRY', message: 'Breakout above pivot 200', price: 201.5 },
      { symbol: 'NVDA', type: 'EXIT', message: 'Stop hit', price: 95.2 },
    ]);
    assert.match(email.subject, /2 alert/i);
    assert.match(email.body, /AAPL/);
    assert.match(email.body, /ENTRY/);
    assert.match(email.body, /NVDA/);
    assert.match(email.body, /not financial advice/i);
  });
});

// ===== Phase 5: multi-list checking + per-list recipients (appended, TDD) =====
describe('check_alerts multi-list + recipient resolution', async () => {
  const mod = await import('../scripts/check_alerts.mjs');
  const fxFetch = async (url) => {
    let body;
    if (url.includes('%5EGSPC')) body = fixture('chart_GSPC.json');
    else if (url.includes('fundamentals-timeseries')) body = fixture('fundamentals_AAPL.json');
    else if (url.includes('/SPY?')) body = fixture('chart_SPY.json');
    else if (url.includes('INVALIDXYZ123')) body = fixture('chart_INVALID.json');
    else body = fixture('chart_AAPL.json');
    return { ok: true, status: 200, json: async () => body };
  };

  test('accepts a v3 collection and tags alerts with their watchlist name', async () => {
    const collection = { version: 3, activeName: 'A', lists: [
      { name: 'A', items: [{ symbol: 'SPY', entryPrice: 1 }] }, // guaranteed trigger
      { name: 'B', items: [{ symbol: 'AAPL' }] },
    ] };
    const { results, alerts } = await mod.checkWatchlist(collection, { fetchImpl: fxFetch });
    assert.ok(results.length >= 2);
    const spy = alerts.find((a) => a.symbol === 'SPY');
    assert.ok(spy, 'SPY should trigger');
    assert.equal(spy.watchlist, 'A');
  });

  test('legacy flat array still works (watchlist tag is null)', async () => {
    const { alerts } = await mod.checkWatchlist([{ symbol: 'SPY', entryPrice: 1 }], { fetchImpl: fxFetch });
    const a = alerts.find((x) => x.symbol === 'SPY');
    assert.ok(a);
    assert.equal(a.watchlist ?? null, null);
  });

  test('a symbol on two lists yields an alert attributed to each list', async () => {
    const collection = { version: 3, activeName: 'A', lists: [
      { name: 'A', items: [{ symbol: 'SPY', entryPrice: 1 }] },
      { name: 'B', items: [{ symbol: 'SPY', entryPrice: 1 }] },
    ] };
    const { alerts } = await mod.checkWatchlist(collection, { fetchImpl: fxFetch });
    const lists = alerts.filter((a) => a.symbol === 'SPY').map((a) => a.watchlist).sort();
    assert.deepEqual(lists, ['A', 'B']);
  });

  test('resolveRecipients uses list subscribers, else falls back to owner', () => {
    assert.deepEqual(mod.resolveRecipients('A', { A: ['x@y.com'] }, 'owner@z.com'), ['x@y.com']);
    assert.deepEqual(mod.resolveRecipients('B', { A: ['x@y.com'] }, 'owner@z.com'), ['owner@z.com']);
    assert.deepEqual(mod.resolveRecipients(null, {}, 'owner@z.com'), ['owner@z.com']);
  });

  test('buildEmailGroups makes one group per watchlist with resolved recipients', () => {
    const alerts = [
      { symbol: 'AAPL', type: 'ENTRY', message: 'm', price: 1, watchlist: 'A' },
      { symbol: 'NVDA', type: 'EXIT', message: 'm', price: 2, watchlist: 'B' },
    ];
    const groups = mod.buildEmailGroups(alerts, { A: ['a@x.com'] }, 'owner@z.com');
    assert.equal(groups.length, 2);
    const ga = groups.find((g) => g.watchlist === 'A');
    assert.deepEqual(ga.recipients, ['a@x.com']);
    assert.match(ga.subject, /A/);
    assert.match(ga.body, /AAPL/);
    const gb = groups.find((g) => g.watchlist === 'B');
    assert.deepEqual(gb.recipients, ['owner@z.com']); // fallback to owner
    assert.equal(mod.buildEmailGroups([], {}, 'owner@z.com').length, 0);
  });
});

// ===== Dashboard link in alert emails (appended, TDD) =====
describe('alert emails include a dashboard link', async () => {
  const mod = await import('../scripts/check_alerts.mjs');
  const URLRE = /https?:\/\/[^\s]*github\.io\/minervini-dashboard/;
  test('legacy buildEmail body contains the dashboard URL', () => {
    const email = mod.buildEmail([{ symbol: 'AAPL', type: 'ENTRY', message: 'm', price: 1 }]);
    assert.match(email.body, URLRE);
  });
  test('buildEmailGroups body contains the dashboard URL', () => {
    const groups = mod.buildEmailGroups(
      [{ symbol: 'AAPL', type: 'ENTRY', message: 'm', price: 1, watchlist: 'A' }],
      { A: ['a@x.com'] }, 'owner@z.com');
    assert.match(groups[0].body, URLRE);
  });
  test('dashboard URL is overridable via argument', () => {
    const email = mod.buildEmail([{ symbol: 'AAPL', type: 'ENTRY', message: 'm', price: 1 }], 'https://example.test/x');
    assert.match(email.body, /https:\/\/example\.test\/x/);
  });
});
