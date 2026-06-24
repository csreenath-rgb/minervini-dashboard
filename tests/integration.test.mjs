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

// ===== Sched Phase 2: per-list email slot filtering (appended, TDD) =====
describe('check_alerts slot filtering by schedule', async () => {
  const mod = await import('../scripts/check_alerts.mjs');
  const coreP = await import('../js/app-core.js');
  const fxFetch = async (url) => {
    let body;
    if (url.includes('%5EGSPC')) body = fixture('chart_GSPC.json');
    else if (url.includes('fundamentals-timeseries')) body = fixture('fundamentals_AAPL.json');
    else if (url.includes('/SPY?')) body = fixture('chart_SPY.json');
    else body = fixture('chart_AAPL.json');
    return { ok: true, status: 200, json: async () => body };
  };
  const collection = {
    version: 3, activeName: 'A', lists: [
      { name: 'A', schedule: { mode: 'times', times: ['16:45'] }, items: [{ symbol: 'SPY', entryPrice: 1 }] },
      { name: 'B', items: [{ symbol: 'AAPL' }] }, // default -> 13:45 & 19:45
    ],
  };
  test('cronToSlot maps a cron expression to HH:MM (or null)', () => {
    assert.equal(mod.cronToSlot('45 13 * * 1-5'), '13:45');
    assert.equal(mod.cronToSlot('45 16 * * 1-5'), '16:45');
    assert.equal(mod.cronToSlot(''), null);
    assert.equal(mod.cronToSlot(undefined), null);
  });
  test('only lists due at the slot are checked', async () => {
    const r13 = await mod.checkWatchlist(collection, { fetchImpl: fxFetch, slot: '13:45' });
    assert.deepEqual(r13.results.map((x) => x.symbol).sort(), ['AAPL']); // B only
    const r16 = await mod.checkWatchlist(collection, { fetchImpl: fxFetch, slot: '16:45' });
    assert.deepEqual(r16.results.map((x) => x.symbol).sort(), ['SPY']);  // A only
  });
  test('no slot (manual run) checks every list', async () => {
    const r = await mod.checkWatchlist(collection, { fetchImpl: fxFetch });
    assert.deepEqual(r.results.map((x) => x.symbol).sort(), ['AAPL', 'SPY']);
  });
  test('exportPublicWatchlist carries each list schedule (and no emails)', () => {
    let c = coreP.setListSchedule(collection, 'A', { mode: 'times', times: ['16:45'] });
    const pub = coreP.exportPublicWatchlist(c);
    assert.deepEqual(pub.lists.find((l) => l.name === 'A').schedule, { mode: 'times', times: ['16:45'] });
    assert.ok(pub.lists.every((l) => !('subscribers' in l)));
  });
});

// ===== Fund Phase 1: provider adapters -> normalized quarters (appended, TDD) =====
describe('fundamentals provider adapters', async () => {
  const { fmp, alphavantage, finnhub, quartersToYahooJson, FUNDAMENTALS_PROVIDERS } = await import('../js/providers.js');
  const { parseYahooFundamentals } = await import('../js/engine.js');

  test('provider list includes yahoo + the three data APIs', () => {
    assert.deepEqual(FUNDAMENTALS_PROVIDERS, ['yahoo', 'finnhub', 'fmp', 'alphavantage', 'indianapi']);
  });

  test('FMP income-statement rows -> quarters (eps/revenue/netIncome), sorted', () => {
    const rows = [
      { date: '2026-03-31', epsdiluted: 2.01, revenue: 1.1e11, netIncome: 2.9e10 },
      { date: '2025-12-31', epsdiluted: 2.84, revenue: 1.4e11, netIncome: 4.2e10 },
    ];
    const q = fmp.toQuarters([rows]);
    assert.deepEqual(q.map((x) => x.date), ['2025-12-31', '2026-03-31']); // ascending
    assert.equal(q[1].eps, 2.01);
    assert.equal(q[0].revenue, 1.4e11);
  });

  test('Alpha Vantage EARNINGS + INCOME_STATEMENT merge by fiscalDateEnding', () => {
    const earnings = { quarterlyEarnings: [{ fiscalDateEnding: '2026-03-31', reportedEPS: '2.01' }] };
    const income = { quarterlyReports: [{ fiscalDateEnding: '2026-03-31', totalRevenue: '111000000000', netIncome: '29000000000' }] };
    const q = alphavantage.toQuarters([earnings, income]);
    assert.equal(q.length, 1);
    assert.equal(q[0].eps, 2.01);
    assert.equal(q[0].revenue, 111000000000);
    assert.equal(q[0].netIncome, 29000000000);
  });

  test('Finnhub /stock/earnings -> EPS quarters (revenue/netIncome null on free tier)', () => {
    const earnings = [
      { period: '2026-03-31', actual: 2.01 },
      { period: '2025-12-31', actual: 2.84 },
    ];
    const q = finnhub.toQuarters([earnings]);
    assert.deepEqual(q.map((x) => x.date), ['2025-12-31', '2026-03-31']);
    assert.equal(q[1].eps, 2.01);
    assert.equal(q[0].revenue, null);
  });

  test('round-trip: quartersToYahooJson is read back identically by the engine parser', () => {
    const q = [
      { date: '2025-12-31', eps: 2.84, revenue: 1.4e11, netIncome: 4.2e10 },
      { date: '2026-03-31', eps: 2.01, revenue: 1.1e11, netIncome: 2.9e10 },
    ];
    assert.deepEqual(parseYahooFundamentals(quartersToYahooJson(q)), q);
  });

  test('EPS-only quarters (Finnhub) round-trip with null revenue/netIncome dropped cleanly', () => {
    const q = [{ date: '2026-03-31', eps: 2.01, revenue: null, netIncome: null }];
    const parsed = parseYahooFundamentals(quartersToYahooJson(q));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].eps, 2.01);
    assert.equal(parsed[0].revenue, undefined); // null fields omitted, engine treats as absent
  });
});

// ===== Fund Phase 2: data-layer routing + fallback (appended, TDD) =====
describe('fetchFundamentals routing', async () => {
  const data = await import('../js/data.js');
  const { parseYahooFundamentals } = await import('../js/engine.js');
  const fmpRows = [
    { date: '2025-03-31', epsdiluted: 1.65, revenue: 9.5e10, netIncome: 2.4e10 },
    { date: '2025-06-30', epsdiluted: 1.57, revenue: 9.4e10, netIncome: 2.3e10 },
    { date: '2025-09-30', epsdiluted: 1.85, revenue: 1.0e11, netIncome: 2.7e10 },
    { date: '2025-12-31', epsdiluted: 2.84, revenue: 1.4e11, netIncome: 4.2e10 },
    { date: '2026-03-31', epsdiluted: 2.01, revenue: 1.1e11, netIncome: 2.9e10 },
  ];
  test('provider path returns engine-readable fundamentals and never proxies the keyed URL', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => fmpRows }; };
    const fj = await data.fetchFundamentals('AAPL', { fetchImpl, fundamentals: { provider: 'fmp', key: 'SECRET' } });
    assert.equal(parseYahooFundamentals(fj).length, 5);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('financialmodelingprep.com') && calls[0].includes('apikey=SECRET'));
    assert.ok(!calls[0].includes('corsproxy') && !calls[0].includes('allorigins') && !calls[0].includes('codetabs'));
  });
  test('provider failure falls back to Yahoo', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('financialmodelingprep')) throw new Error('CORS blocked');
      return { ok: true, status: 200, json: async () => fixture('fundamentals_AAPL.json') };
    };
    const fj = await data.fetchFundamentals('AAPL', { fetchImpl, fundamentals: { provider: 'fmp', key: 'K' } });
    assert.ok(parseYahooFundamentals(fj).length >= 5);
  });
  test('no provider configured uses Yahoo', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => fixture('fundamentals_AAPL.json') }; };
    await data.fetchFundamentals('AAPL', { fetchImpl });
    assert.ok(calls[0].includes('fundamentals-timeseries'));
  });
  test('provider with too few quarters falls back to Yahoo', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('financialmodelingprep')) return { ok: true, status: 200, json: async () => [fmpRows[0]] }; // only 1 quarter
      return { ok: true, status: 200, json: async () => fixture('fundamentals_AAPL.json') };
    };
    const fj = await data.fetchFundamentals('AAPL', { fetchImpl, fundamentals: { provider: 'fmp', key: 'K' } });
    assert.ok(parseYahooFundamentals(fj).length >= 5); // came from Yahoo fixture
  });
});

// ===== Fund Phase 4: email-job env-config path (appended, TDD) =====
describe('fetchFundamentals env config (email job)', async () => {
  const data = await import('../js/data.js');
  const { parseYahooFundamentals } = await import('../js/engine.js');
  const rows = [
    { date: '2025-03-31', epsdiluted: 1.65, revenue: 9.5e10, netIncome: 2.4e10 },
    { date: '2025-06-30', epsdiluted: 1.57, revenue: 9.4e10, netIncome: 2.3e10 },
    { date: '2025-09-30', epsdiluted: 1.85, revenue: 1.0e11, netIncome: 2.7e10 },
    { date: '2025-12-31', epsdiluted: 2.84, revenue: 1.4e11, netIncome: 4.2e10 },
    { date: '2026-03-31', epsdiluted: 2.01, revenue: 1.1e11, netIncome: 2.9e10 },
  ];
  test('uses FUNDAMENTALS_PROVIDER/KEY env when no explicit config is passed', async () => {
    process.env.FUNDAMENTALS_PROVIDER = 'fmp';
    process.env.FUNDAMENTALS_API_KEY = 'ENVKEY';
    try {
      const calls = [];
      const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => rows }; };
      const fj = await data.fetchFundamentals('AAPL', { fetchImpl });
      assert.equal(parseYahooFundamentals(fj).length, 5);
      assert.ok(calls[0].includes('financialmodelingprep.com') && calls[0].includes('apikey=ENVKEY'));
    } finally {
      delete process.env.FUNDAMENTALS_PROVIDER;
      delete process.env.FUNDAMENTALS_API_KEY;
    }
  });
});

// ===== Fund: FMP stable endpoint + no-fallback probe (appended, TDD) =====
describe('FMP stable endpoint and provider probe', async () => {
  const { fmp } = await import('../js/providers.js');
  const data = await import('../js/data.js');
  test('FMP tries the /stable/ endpoint first, /api/v3 as fallback', () => {
    const att = fmp.attempts('AGL', 'K');
    assert.equal(att.length, 2);
    assert.ok(att[0][0].includes('/stable/income-statement') && !att[0][0].includes('/api/v3'));
    assert.ok(att[1][0].includes('/api/v3/income-statement'));
  });
  test('FMP toQuarters handles stable epsDiluted (camelCase)', () => {
    const q = fmp.toQuarters([[{ date: '2026-03-31', epsDiluted: 2.01, revenue: 1.1e11, netIncome: 2.9e10 }]]);
    assert.equal(q[0].eps, 2.01);
  });
  test('fetchProviderFundamentals throws on total failure (no Yahoo fallback)', async () => {
    const fetchImpl = async () => { throw new Error('CORS blocked'); };
    await assert.rejects(() => data.fetchProviderFundamentals('AGL', { provider: 'fmp', key: 'K' }, { fetchImpl }), /CORS blocked/);
  });
  test('fetchProviderFundamentals returns quarters from the stable endpoint', async () => {
    const rows = [
      { date: '2025-03-31', epsDiluted: 1.65 }, { date: '2025-06-30', epsDiluted: 1.57 },
      { date: '2025-09-30', epsDiluted: 1.85 }, { date: '2025-12-31', epsDiluted: 2.84 },
      { date: '2026-03-31', epsDiluted: 2.01 },
    ];
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => rows }; };
    const { quarters } = await data.fetchProviderFundamentals('AGL', { provider: 'fmp', key: 'K' }, { fetchImpl });
    assert.equal(quarters.length, 5);
    assert.ok(calls[0].includes('/stable/income-statement'));
  });
});

// ===== Fund: surface provider quota/error responses + AV single call (appended, TDD) =====
describe('provider error surfacing + AV quota conservation', async () => {
  const data = await import('../js/data.js');
  const { alphavantage } = await import('../js/providers.js');
  test('fetchJsonDirect throws on an Alpha Vantage "Information" (quota) response', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ Information: 'Our standard API rate limit is 25 requests per day.' }) });
    await assert.rejects(() => data.fetchJsonDirect('https://x.test', { fetchImpl }), /25 requests per day/);
  });
  test('fetchJsonDirect throws on a "Note" (rate) and an FMP "Error Message"', async () => {
    const note = async () => ({ ok: true, status: 200, json: async () => ({ Note: 'Thank you for using Alpha Vantage! call frequency' }) });
    await assert.rejects(() => data.fetchJsonDirect('https://x.test', { fetchImpl: note }), /call frequency/);
    const fmpErr = async () => ({ ok: true, status: 200, json: async () => ({ 'Error Message': 'Invalid API KEY.' }) });
    await assert.rejects(() => data.fetchJsonDirect('https://x.test', { fetchImpl: fmpErr }), /Invalid API KEY/);
  });
  test('fetchJsonDirect does NOT throw on valid data (array or known data keys)', async () => {
    const arr = async () => ({ ok: true, status: 200, json: async () => ([{ date: '2026-03-31' }]) });
    assert.ok(Array.isArray(await data.fetchJsonDirect('https://x.test', { fetchImpl: arr })));
    const ok = async () => ({ ok: true, status: 200, json: async () => ({ quarterlyEarnings: [] }) });
    assert.ok(await data.fetchJsonDirect('https://x.test', { fetchImpl: ok }));
  });
  test('Alpha Vantage uses a single EARNINGS call to conserve the 25/day quota', () => {
    const att = alphavantage.attempts('AVGO', 'K');
    assert.equal(att.length, 1);
    assert.equal(att[0].length, 1);
    assert.ok(att[0][0].includes('function=EARNINGS'));
    assert.ok(!att[0].some((u) => u.includes('INCOME_STATEMENT')));
  });
  test('a provider quota error surfaces through fetchProviderFundamentals (no silent empty)', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ Information: '25 requests per day' }) });
    await assert.rejects(() => data.fetchProviderFundamentals('AVGO', { provider: 'alphavantage', key: 'K' }, { fetchImpl }), /25 requests per day/);
  });
})

// ===== Cache Phase 1: pure cache helpers (appended, TDD) =====
describe('cache helpers', async () => {
  const c = await import('../js/cache.js');
  const chart = (tsVals) => ({ chart: { result: [{
    meta: { symbol: 'X', regularMarketPrice: 9 },
    timestamp: tsVals.map((x) => x[0]),
    indicators: { quote: [{
      open: tsVals.map((x) => x[1]), high: tsVals.map((x) => x[1]), low: tsVals.map((x) => x[1]),
      close: tsVals.map((x) => x[1]), volume: tsVals.map(() => 100),
    }] },
  }], error: null } });

  test('todayStr is YYYY-MM-DD for a given date', () => {
    assert.equal(c.todayStr(new Date('2026-06-15T18:00:00')), '2026-06-15');
  });
  test('ageDays counts calendar days since a date string', () => {
    const now = new Date('2026-06-15T10:00:00');
    assert.equal(c.ageDays('2026-06-15', now), 0);
    assert.equal(c.ageDays('2026-06-12', now), 3);
    assert.equal(c.ageDays(null, now), Infinity);
  });
  test('lastTimestamp returns the newest bar time or null', () => {
    assert.equal(c.lastTimestamp(chart([[100, 1], [200, 2]])), 200);
    assert.equal(c.lastTimestamp({ chart: { result: [{}] } }), null);
  });
  test('mergeChartJson appends new bars and overrides the overlapping latest bar', () => {
    const oldJ = chart([[100, 1], [200, 2]]);
    const newJ = chart([[200, 2.5], [300, 3]]); // 200 updated, 300 new
    const merged = c.mergeChartJson(oldJ, newJ);
    const r = merged.chart.result[0];
    assert.deepEqual(r.timestamp, [100, 200, 300]);
    assert.deepEqual(r.indicators.quote[0].close, [1, 2.5, 3]); // 200 overridden, 300 appended
  });
  test('mergeChartJson returns the old series when the new payload has no result', () => {
    const oldJ = chart([[100, 1]]);
    assert.deepEqual(c.mergeChartJson(oldJ, { chart: { result: null, error: { description: 'x' } } }), oldJ);
  });
});

// ===== Cache Phase 2: data.js per-ticker cache (appended, TDD) =====
describe('fetchTickerBundle per-ticker cache', async () => {
  const data = await import('../js/data.js');
  const { todayStr } = await import('../js/cache.js');
  const { parseYahooFundamentals } = await import('../js/engine.js');
  const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), _m: m }; };
  const chart = (rows, sym = 'AAPL') => ({ chart: { result: [{
    meta: { symbol: sym, regularMarketPrice: rows.at(-1)[1] },
    timestamp: rows.map((r) => r[0]),
    indicators: { quote: [{ open: rows.map((r) => r[1]), high: rows.map((r) => r[1]), low: rows.map((r) => r[1]), close: rows.map((r) => r[1]), volume: rows.map(() => 100) }] },
  }], error: null } });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  test('same-day: second fetch reuses cache with zero network calls', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('%5EGSPC')) return ok(fixture('chart_GSPC.json'));
      if (url.includes('fundamentals-timeseries')) return ok(fixture('fundamentals_AAPL.json'));
      return ok(fixture('chart_AAPL.json'));
    };
    const cache = memStore();
    await data.fetchTickerBundle('AAPL', { fetchImpl, cache });
    assert.ok(calls.length > 0, 'first fetch hits the network');
    calls.length = 0;
    const b2 = await data.fetchTickerBundle('AAPL', { fetchImpl, cache });
    assert.equal(calls.length, 0, 'same-day reuse must not fetch');
    assert.ok(b2.chartJson && b2.fromCache);
  });

  test('cross-day: fetches only from the last cached bar and merges', async () => {
    const cache = memStore();
    cache.setItem('mnv_bundle_AAPL', JSON.stringify({
      chartDate: '2000-01-01', chart: chart([[100, 1], [200, 2]]), bench: chart([[100, 1], [200, 2]], '^GSPC'),
      fund: fixture('fundamentals_AAPL.json'), fundProvider: 'yahoo', fundDate: todayStr(),
    }));
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('fundamentals-timeseries')) return ok(fixture('fundamentals_AAPL.json'));
      return ok(chart([[200, 2.5], [300, 3]], url.includes('%5EGSPC') ? '^GSPC' : 'AAPL')); // new bar 300
    };
    const b = await data.fetchTickerBundle('AAPL', { fetchImpl, cache });
    assert.ok(calls.some((u) => u.includes('period1=200')), 'should fetch incrementally from last bar');
    assert.deepEqual(b.chartJson.chart.result[0].timestamp, [100, 200, 300], 'merged series');
  });

  test('fundamentals reused within TTL and same provider -> no provider call', async () => {
    const cache = memStore();
    cache.setItem('mnv_bundle_AAPL', JSON.stringify({
      chartDate: todayStr(), chart: chart([[100, 1]]), bench: chart([[100, 1]], '^GSPC'),
      fund: fixture('fundamentals_AAPL.json'), fundProvider: 'fmp', fundDate: todayStr(),
    }));
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return ok([]); };
    await data.fetchTickerBundle('AAPL', { fetchImpl, cache, fundamentals: { provider: 'fmp', key: 'K' } });
    assert.equal(calls.length, 0, 'same-day chart + in-TTL fundamentals => no fetch');
  });

  test('switching provider forces a fundamentals refetch', async () => {
    const cache = memStore();
    cache.setItem('mnv_bundle_AAPL', JSON.stringify({
      chartDate: todayStr(), chart: chart([[100, 1]]), bench: chart([[100, 1]], '^GSPC'),
      fund: fixture('fundamentals_AAPL.json'), fundProvider: 'fmp', fundDate: todayStr(),
    }));
    const calls = [];
    const av = { quarterlyEarnings: [
      { fiscalDateEnding: '2025-03-31', reportedEPS: '1.65' }, { fiscalDateEnding: '2025-06-30', reportedEPS: '1.57' },
      { fiscalDateEnding: '2025-09-30', reportedEPS: '1.85' }, { fiscalDateEnding: '2025-12-31', reportedEPS: '2.84' },
      { fiscalDateEnding: '2026-03-31', reportedEPS: '2.01' },
    ] };
    const fetchImpl = async (url) => { calls.push(url); return ok(url.includes('function=EARNINGS') ? av : []); };
    await data.fetchTickerBundle('AAPL', { fetchImpl, cache, fundamentals: { provider: 'alphavantage', key: 'K' } });
    assert.ok(calls.some((u) => u.includes('alphavantage.co')), 'provider change should refetch fundamentals');
  });

  test('keep-last-good: a failed/insufficient refetch does not overwrite good cached fundamentals', async () => {
    const cache = memStore();
    cache.setItem('mnv_bundle_AAPL', JSON.stringify({
      chartDate: todayStr(), chart: chart([[100, 1]]), bench: chart([[100, 1]], '^GSPC'),
      fund: fixture('fundamentals_AAPL.json'), fundProvider: 'alphavantage', fundDate: '2000-01-01', // stale -> refetch
    }));
    const fetchImpl = async (url) => {
      if (url.includes('function=EARNINGS')) return ok({ Information: '25 requests per day' }); // quota
      if (url.includes('fundamentals-timeseries')) return ok({ timeseries: { result: [] } });   // Yahoo empty
      return ok({});
    };
    const b = await data.fetchTickerBundle('AAPL', { fetchImpl, cache, fundamentals: { provider: 'alphavantage', key: 'K' } });
    assert.ok(parseYahooFundamentals(b.fundJson).length >= 5, 'should keep the last-good fundamentals');
  });
});

// ===== Mkt Phase 2: indianapi.in adapter + market-aware benchmark/header (appended, TDD) =====
describe('indianapi.in fundamentals adapter', async () => {
  const { indianapi, BROWSER_OK, FUNDAMENTALS_PROVIDERS } = await import('../js/providers.js');
  test('is registered as a browser-capable provider', () => {
    assert.ok(FUNDAMENTALS_PROVIDERS.includes('indianapi'));
    assert.equal(BROWSER_OK.indianapi, true);
  });
  test('builds a header-authed historical_stats request with the bare symbol', () => {
    const att = indianapi.attempts('RELIANCE.NS', 'KEY');
    assert.equal(att.length, 1);
    assert.equal(att[0].length, 1);
    assert.ok(att[0][0].url.includes('historical_stats') && att[0][0].url.includes('stock_name=RELIANCE') && att[0][0].url.includes('quarter_results'));
    assert.ok(!att[0][0].url.includes('.NS'));
    assert.deepEqual(att[0][0].headers, { 'X-Api-Key': 'KEY' });
  });
  test('parses quarter_results maps into sorted quarters (eps/revenue/netIncome)', () => {
    const data = {
      Sales: { 'Mar 2025': 100, 'Jun 2025': 110, 'Sep 2025': 120, 'Dec 2025': 130, 'Mar 2026': 140 },
      'Net Profit': { 'Mar 2025': 9, 'Jun 2025': 10, 'Sep 2025': 11, 'Dec 2025': 12, 'Mar 2026': 13 },
      'EPS in Rs': { 'Mar 2025': 1.0, 'Jun 2025': 1.1, 'Sep 2025': 1.2, 'Dec 2025': 1.3, 'Mar 2026': 1.4 },
    };
    const q = indianapi.toQuarters([data]);
    assert.equal(q.length, 5);
    assert.equal(q[0].date, '2025-03-01');
    assert.equal(q[4].eps, 1.4);
    assert.equal(q[4].revenue, 140);
    assert.equal(q[4].netIncome, 13);
  });
  test('round-trips through the engine parser', async () => {
    const { quartersToYahooJson } = await import('../js/providers.js');
    const { parseYahooFundamentals } = await import('../js/engine.js');
    const data = { 'EPS in Rs': { 'Mar 2025': 1, 'Jun 2025': 2, 'Sep 2025': 3, 'Dec 2025': 4, 'Mar 2026': 5 } };
    const q = indianapi.toQuarters([data]);
    assert.equal(parseYahooFundamentals(quartersToYahooJson(q)).length, 5);
  });
});

describe('market-aware benchmark + header fetch', async () => {
  const data = await import('../js/data.js');
  test('fetchJsonDirect forwards custom headers', async () => {
    let seen = null;
    const fetchImpl = async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
    await data.fetchJsonDirect({ url: 'https://x.test', headers: { 'X-Api-Key': 'K' } }, { fetchImpl });
    assert.deepEqual(seen && seen.headers, { 'X-Api-Key': 'K' });
  });
  test('fetchTickerBundle uses the NIFTY benchmark when market=IN', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(typeof url === 'string' ? url : url.url); return { ok: true, status: 200, json: async () => fixture('chart_AAPL.json') }; };
    await data.fetchTickerBundle('RELIANCE.NS', { fetchImpl, market: 'IN' });
    assert.ok(calls.some((u) => u.includes('%5ENSEI')), 'NIFTY 50 ^NSEI benchmark expected');
  });
});

// ===== Mkt Phase 4: email checker market-aware (appended, TDD) =====
describe('check_alerts market-aware (India)', async () => {
  const mod = await import('../scripts/check_alerts.mjs');
  test('checkWatchlist with market=IN uses the NIFTY benchmark', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(typeof url === 'string' ? url : url.url); return { ok: true, status: 200, json: async () => fixture('chart_AAPL.json') }; };
    const collection = { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'RELIANCE.NS' }] }] };
    await mod.checkWatchlist(collection, { fetchImpl, market: 'IN' });
    assert.ok(calls.some((u) => u.includes('%5ENSEI')), 'expected NIFTY 50 benchmark');
    assert.ok(calls.some((u) => u.includes('RELIANCE.NS')), 'expected the .NS symbol');
  });
  test('default market remains US (^GSPC)', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(typeof url === 'string' ? url : url.url); return { ok: true, status: 200, json: async () => fixture('chart_AAPL.json') }; };
    await mod.checkWatchlist([{ symbol: 'AAPL' }], { fetchImpl });
    assert.ok(calls.some((u) => u.includes('%5EGSPC')));
  });
});

// ===== MF Phase 1: mutual fund core (appended, TDD) =====
describe('mutual fund core (mfapi.in)', async () => {
  const mf = await import('../js/mf.js');
  test('parseMfNavHistory normalizes dates/numbers and sorts ascending', () => {
    const json = { meta: { scheme_name: 'X Fund', fund_house: 'Y AMC', scheme_category: 'Index' },
      data: [{ date: '11-06-2026', nav: '110.0' }, { date: '10-06-2026', nav: '108.5' }] };
    const r = mf.parseMfNavHistory(json);
    assert.equal(r.meta.scheme_name, 'X Fund');
    assert.deepEqual(r.navs[0], { date: '2026-06-10', nav: 108.5 });
    assert.deepEqual(r.navs[1], { date: '2026-06-11', nav: 110 });
  });
  test('mfReturns computes trailing returns from the nearest-prior NAV', () => {
    const navs = [
      { date: '2025-06-11', nav: 100 },
      { date: '2026-03-11', nav: 120 },
      { date: '2026-05-11', nav: 130 },
      { date: '2026-06-11', nav: 132 },
    ];
    const r = mf.mfReturns(navs, new Date('2026-06-11T00:00:00'));
    assert.equal(r['1m'], 1.54);  // (132-130)/130
    assert.equal(r['3m'], 10);    // vs 120
    assert.equal(r['1y'], 32);    // vs 100
    assert.equal(r['3y'], null);  // no NAV that old
    assert.equal(r['5y'], null);
  });
  test('mfSummary reports MA position for a rising series', () => {
    const navs = Array.from({ length: 60 }, (_, i) => ({ date: `2026-${String(i + 1).padStart(4, '0')}`, nav: 100 + i }));
    const s = mf.mfSummary(navs);
    assert.equal(s.latestNav, 159);
    assert.ok(s.ma50 != null && s.ma200 == null); // 60 points: 50-MA available, 200 not
    assert.equal(s.navAbove50, true);
  });
});

// ===== MF Phase 2: mutual fund data fetch (mfapi.in) (appended, TDD) =====
describe('mutual fund data fetch', async () => {
  const data = await import('../js/data.js');
  const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  test('fetchMfSearch normalizes results to {code,name}', async () => {
    const fetchImpl = async (url) => { assert.ok(url.includes('api.mfapi.in/mf/search')); return ok([{ schemeCode: 120716, schemeName: 'UTI Nifty 50 Index Fund' }, { schemeCode: 120717, schemeName: 'X' }]); };
    const r = await data.fetchMfSearch('nifty 50', { fetchImpl });
    assert.deepEqual(r[0], { code: 120716, name: 'UTI Nifty 50 Index Fund' });
    assert.equal(r.length, 2);
  });
  test('fetchMfHistory parses NAV history and reuses cache same-day', async () => {
    let calls = 0;
    const body = { meta: { scheme_name: 'UTI Nifty 50', fund_house: 'UTI', scheme_category: 'Index' },
      data: [{ date: '11-06-2026', nav: '110.0' }, { date: '10-06-2026', nav: '108.0' }] };
    const fetchImpl = async () => { calls += 1; return ok(body); };
    const cache = memStore();
    const r1 = await data.fetchMfHistory(120716, { fetchImpl, cache });
    assert.equal(r1.meta.scheme_name, 'UTI Nifty 50');
    assert.equal(r1.navs.length, 2);
    assert.equal(r1.navs[1].nav, 110);
    const r2 = await data.fetchMfHistory(120716, { fetchImpl, cache });
    assert.equal(calls, 1, 'same-day MF history should be served from cache');
    assert.equal(r2.navs.length, 2);
  });
});

// ===== Sym Phase 2: fetchSymbolSearch (appended, TDD) =====
describe('fetchSymbolSearch (data layer)', async () => {
  const data = await import('../js/data.js');
  const quotes = { quotes: [
    { symbol: 'AAPL', longname: 'Apple Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
    { symbol: 'RELIANCE.NS', longname: 'Reliance Industries', exchDisp: 'NSE', quoteType: 'EQUITY' },
  ] };
  test('queries Yahoo search and parses for the US market', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(typeof url === 'string' ? url : url.url); return { ok: true, status: 200, json: async () => quotes }; };
    const r = await data.fetchSymbolSearch('apple', { fetchImpl, market: 'US' });
    assert.ok(calls.some((u) => u.includes('/finance/search') && u.includes('q=apple')));
    assert.deepEqual(r.map((x) => x.symbol), ['AAPL']);
  });
  test('parses for the India market (.NS only)', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => quotes });
    const r = await data.fetchSymbolSearch('reliance', { fetchImpl, market: 'IN' });
    assert.deepEqual(r.map((x) => x.symbol), ['RELIANCE.NS']);
  });
});

// ---- email job: gist-first source resolution (auto-sync read side) ----
import { resolveMarketSources } from '../scripts/check_alerts.mjs';
import { GIST_FILE } from '../js/sync.js';

describe('check_alerts.resolveMarketSources (gist first, committed/env backup)', () => {
  const committedUS = { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'AAPL' }] }] };
  const gistUS = { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'NVDA' }] }] };

  test('uses gist watchlist + mailing when the gist provides them', () => {
    const gistFiles = {
      [GIST_FILE.watchlistUS]: gistUS,
      [GIST_FILE.mailingUS]: { Default: ['live@x.com'] },
    };
    const { watchlist, mailing } = resolveMarketSources(gistFiles, 'US', committedUS, { Default: ['old@x.com'] });
    assert.equal(watchlist.lists[0].items[0].symbol, 'NVDA');
    assert.deepEqual(mailing, { Default: ['live@x.com'] });
  });

  test('falls back to committed watchlist + env mailing when gist is empty (unreachable)', () => {
    const { watchlist, mailing } = resolveMarketSources({}, 'US', committedUS, { Default: ['env@x.com'] });
    assert.equal(watchlist.lists[0].items[0].symbol, 'AAPL');
    assert.deepEqual(mailing, { Default: ['env@x.com'] });
  });

  test('reads the correct files for the IN market', () => {
    const gistFiles = {
      [GIST_FILE.watchlistIN]: { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'TCS.NS' }] }] },
      [GIST_FILE.mailingIN]: { Default: ['in@x.com'] },
    };
    const { watchlist, mailing } = resolveMarketSources(gistFiles, 'IN', null, {});
    assert.equal(watchlist.lists[0].items[0].symbol, 'TCS.NS');
    assert.deepEqual(mailing, { Default: ['in@x.com'] });
  });

  test('gist present for US does not leak into IN resolution', () => {
    const gistFiles = { [GIST_FILE.watchlistUS]: gistUS };
    const { watchlist } = resolveMarketSources(gistFiles, 'IN', null, {});
    assert.equal(watchlist, null); // no IN gist file, no committed -> null (skipped by caller)
  });
});
