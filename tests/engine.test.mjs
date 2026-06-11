// Unit tests for the Minervini analysis engine — written BEFORE the engine (TDD).
// Run: node --test tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, high52w, low52w, weightedReturn, rsRating,
  trendTemplate, detectBase, entrySignal, exitSignal,
  fundamentalsScore, parseYahooChart, parseYahooFundamentals, analyzeTicker
} from '../js/engine.js';
import { readFileSync } from 'node:fs';

// ---------- helpers: synthetic candle generation ----------
const DAY = 86400_000;
function makeCandles(closes, { volumes = null, spread = 0.01 } = {}) {
  const start = Date.UTC(2024, 0, 1);
  return closes.map((c, i) => ({
    date: new Date(start + i * DAY),
    open: c * (1 - spread / 2),
    high: c * (1 + spread),
    low: c * (1 - spread),
    close: c,
    volume: volumes ? volumes[i] : 1_000_000,
  }));
}
// linear ramp of n closes from a to b
function ramp(a, b, n) {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}
// flat series
function flat(v, n) { return Array.from({ length: n }, () => v); }

// A strong Stage-2 uptrend: 300 days rising 50 -> 100, smooth.
const uptrendCloses = ramp(50, 100, 300);
// A clear downtrend: 300 days falling 100 -> 50.
const downtrendCloses = ramp(100, 50, 300);
// Flat benchmark for RS comparisons.
const flatBench = makeCandles(flat(100, 300));

// ---------- math primitives ----------
describe('sma', () => {
  test('computes simple moving average with null padding', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    assert.equal(out.length, 5);
    assert.equal(out[0], null);
    assert.equal(out[1], null);
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });
  test('period longer than data -> all null', () => {
    assert.deepEqual(sma([1, 2], 5), [null, null]);
  });
});

describe('52-week high/low', () => {
  test('uses only the last 252 trading days', () => {
    // old spike at index 0 (high 500) must be ignored once >252 days pass
    const closes = [500, ...flat(100, 300)];
    const candles = makeCandles(closes);
    assert.ok(high52w(candles) < 500);
    assert.ok(Math.abs(high52w(candles) - 101) < 1.5); // ~100*(1+spread)
    assert.ok(Math.abs(low52w(candles) - 99) < 1.5);
  });
  test('works with short history (IPO case)', () => {
    const candles = makeCandles(ramp(10, 20, 60));
    assert.ok(high52w(candles) >= 20);
    assert.ok(low52w(candles) <= 10.1);
  });
});

describe('relative strength', () => {
  test('weightedReturn of flat series is 0', () => {
    assert.ok(Math.abs(weightedReturn(flat(100, 300))) < 1e-9);
  });
  test('stock equal to benchmark -> RS ~50', () => {
    const r = rsRating(flat(100, 300), flat(100, 300));
    assert.ok(r >= 45 && r <= 55, `got ${r}`);
  });
  test('strong outperformer -> RS >= 70; strong underperformer -> RS < 50, bounded 1..99', () => {
    const hi = rsRating(ramp(50, 100, 300), flat(100, 300));
    const lo = rsRating(ramp(100, 50, 300), flat(100, 300));
    assert.ok(hi >= 70, `outperformer got ${hi}`);
    assert.ok(lo < 50, `underperformer got ${lo}`);
    assert.ok(hi <= 99 && lo >= 1);
  });
});

// ---------- Trend Template: each criterion individually ----------
describe('trendTemplate', () => {
  test('strong uptrend passes all 8 criteria', () => {
    const tt = trendTemplate(makeCandles(uptrendCloses), flatBench);
    assert.equal(tt.criteria.length, 8);
    for (const c of tt.criteria) assert.equal(c.pass, true, `criterion ${c.id} failed: ${c.detail}`);
    assert.equal(tt.passed, true);
  });
  test('downtrend fails template, including price-below-MAs criteria', () => {
    const tt = trendTemplate(makeCandles(downtrendCloses), flatBench);
    assert.equal(tt.passed, false);
    const byId = Object.fromEntries(tt.criteria.map(c => [c.id, c]));
    assert.equal(byId.price_above_150_200.pass, false);
    assert.equal(byId.ma200_trending_up.pass, false);
  });
  test('criterion 6: fails when price < 30% above 52w low', () => {
    // rises then gives almost all back: still above MAs? construct: long flat at 100, then dip to 95
    const closes = [...flat(100, 280), ...ramp(100, 95, 20)];
    const tt = trendTemplate(makeCandles(closes), flatBench);
    const c6 = tt.criteria.find(c => c.id === 'above_52w_low_30pct');
    assert.equal(c6.pass, false);
  });
  test('criterion 7: fails when price more than 25% below 52w high', () => {
    const closes = [...ramp(50, 200, 200), ...ramp(200, 120, 100)]; // 40% off high
    const tt = trendTemplate(makeCandles(closes), flatBench);
    const c7 = tt.criteria.find(c => c.id === 'near_52w_high');
    assert.equal(c7.pass, false);
  });
  test('criterion 8: RS >= 70 required', () => {
    // stock flat, bench rising strongly -> low RS -> criterion fails
    const bench = makeCandles(ramp(50, 100, 300));
    const tt = trendTemplate(makeCandles(flat(100, 300)), bench);
    const c8 = tt.criteria.find(c => c.id === 'rs_rating');
    assert.equal(c8.pass, false);
  });
  test('insufficient history (<210 days) -> passed=false with insufficient_data flag', () => {
    const tt = trendTemplate(makeCandles(ramp(10, 20, 60)), flatBench);
    assert.equal(tt.passed, false);
    assert.equal(tt.insufficientData, true);
  });
});

// ---------- base / VCP detection ----------
describe('detectBase', () => {
  // uptrend 50->100, then a 3-month base with decreasing contractions:
  // pullback1 ~12%, pullback2 ~6%, pullback3 ~3%, pivot near 100
  const baseCloses = [
    ...ramp(50, 100, 150),
    ...ramp(100, 88, 15), ...ramp(88, 99, 15),   // -12%
    ...ramp(99, 93, 10), ...ramp(93, 98.5, 10),  // -6%
    ...ramp(98.5, 95.5, 8), ...ramp(95.5, 98, 8) // -3%
  ];
  test('finds a base with decreasing contractions and a pivot near the base high', () => {
    const base = detectBase(makeCandles(baseCloses));
    assert.ok(base.found, 'base should be found');
    assert.ok(base.contractions.length >= 2, `contractions: ${JSON.stringify(base.contractions)}`);
    // contractions measured in % depth, should be non-increasing-ish (allow small tolerance)
    for (let i = 1; i < base.contractions.length; i++) {
      assert.ok(base.contractions[i].depthPct <= base.contractions[i - 1].depthPct + 1.0,
        `contraction depths should shrink: ${JSON.stringify(base.contractions)}`);
    }
    assert.ok(base.pivot > 98 && base.pivot <= 102, `pivot ${base.pivot}`);
  });
  test('no base in a relentless uptrend with no consolidation', () => {
    const base = detectBase(makeCandles(ramp(50, 100, 300)));
    assert.equal(base.found, false);
  });
  test('short history does not crash', () => {
    const base = detectBase(makeCandles(ramp(10, 12, 30)));
    assert.equal(base.found, false);
  });
});

// ---------- entry signal ----------
describe('entrySignal', () => {
  function mk(closeSeq, volumes) { return makeCandles(closeSeq, { volumes }); }
  const basePart = [
    ...ramp(50, 100, 150),
    ...ramp(100, 88, 15), ...ramp(88, 99, 15),
    ...ramp(99, 93, 10), ...ramp(93, 98.5, 10),
    ...ramp(98.5, 95.5, 8), ...ramp(95.5, 98, 8)
  ];
  test('breakout above pivot on high volume within 5% -> ENTER', () => {
    const closes = [...basePart, 101.5]; // breaks above pivot ~100ish (within 5%)
    const vols = flat(1_000_000, closes.length); vols[vols.length - 1] = 2_500_000;
    const sig = entrySignal({ candles: mk(closes, vols), benchmarkCandles: flatBench });
    assert.equal(sig.verdict, 'ENTER');
    assert.ok(sig.pivot > 90);
    assert.ok(sig.buyZone[1] > sig.buyZone[0]);
    assert.ok(sig.stop < 101.5 * 0.95 + 10); // stop exists below entry
  });
  test('price below pivot -> WAIT with pivot as alert level', () => {
    const sig = entrySignal({ candles: mk(basePart), benchmarkCandles: flatBench });
    assert.equal(sig.verdict, 'WAIT');
    assert.ok(sig.pivot > 0);
  });
  test('extended >5% above pivot -> EXTENDED (do not chase)', () => {
    const closes = [...basePart, ...ramp(98, 112, 6)];
    const sig = entrySignal({ candles: mk(closes), benchmarkCandles: flatBench });
    assert.equal(sig.verdict, 'EXTENDED');
  });
  test('fails trend template -> NO_ENTRY regardless of pattern', () => {
    const sig = entrySignal({ candles: makeCandles(downtrendCloses), benchmarkCandles: flatBench });
    assert.equal(sig.verdict, 'NO_ENTRY');
    assert.ok(sig.reasons.length > 0);
  });
});

// ---------- exit signal / stops ----------
describe('exitSignal', () => {
  test('initial stop is never more than 8% below entry', () => {
    const candles = makeCandles(ramp(50, 100, 300));
    const out = exitSignal({ candles, entryPrice: 100 });
    assert.ok(out.stop >= 92, `stop ${out.stop}`);
    assert.ok(out.stop < 100);
  });
  test('stop hit -> EXIT', () => {
    const closes = [...ramp(50, 100, 250), ...ramp(100, 90, 10)]; // 10% drawdown from entry 100
    const out = exitSignal({ candles: makeCandles(closes), entryPrice: 100 });
    assert.equal(out.verdict, 'EXIT');
  });
  test('gain >= 20% -> SELL_PARTIAL / RAISE_STOP suggestion', () => {
    const closes = ramp(50, 130, 300); // entry at 100 -> +30%
    const out = exitSignal({ candles: makeCandles(closes), entryPrice: 100 });
    assert.ok(['SELL_PARTIAL', 'RAISE_STOP'].includes(out.verdict), out.verdict);
    assert.ok(out.stop >= 100, 'stop should be raised to at least breakeven');
  });
  test('healthy uptrend, modest gain -> HOLD', () => {
    const closes = ramp(50, 100, 300); // entry near current
    const out = exitSignal({ candles: makeCandles(closes), entryPrice: 97 });
    assert.equal(out.verdict, 'HOLD');
  });
  test('close below 150-day MA -> EXIT even without stop hit', () => {
    // long uptrend then sharp break below the 150d MA but only ~6% below a recent entry
    const closes = [...ramp(50, 100, 280), ...ramp(100, 70, 20)];
    const out = exitSignal({ candles: makeCandles(closes), entryPrice: 73 });
    assert.equal(out.verdict, 'EXIT');
  });
  test('no entry price -> generic trailing analysis still returned', () => {
    const out = exitSignal({ candles: makeCandles(ramp(50, 100, 300)) });
    assert.ok(out.verdict);
    assert.ok(out.stop > 0);
  });
});

// ---------- fundamentals ----------
describe('fundamentalsScore', () => {
  const q = (date, eps, revenue, netIncome) => ({ date, eps, revenue, netIncome });
  test('accelerating EPS and revenue growth scores pass', () => {
    const quarters = [
      q('2025-03-31', 1.00, 100e9, 10e9), q('2025-06-30', 1.10, 105e9, 11e9),
      q('2025-09-30', 1.35, 115e9, 13e9), q('2025-12-31', 1.80, 130e9, 17e9),
      // yoy comparisons need prior year:
    ];
    const prior = [
      q('2024-03-31', 0.80, 90e9, 8e9), q('2024-06-30', 0.85, 92e9, 8.5e9),
      q('2024-09-30', 0.90, 95e9, 9e9), q('2024-12-31', 1.00, 100e9, 10e9),
    ];
    const f = fundamentalsScore([...prior, ...quarters]);
    assert.equal(f.available, true);
    assert.ok(f.epsGrowthYoY.length >= 3);
    assert.ok(f.epsGrowthYoY.at(-1) > 25, JSON.stringify(f.epsGrowthYoY));
    assert.equal(f.pass, true);
  });
  test('declining EPS fails', () => {
    const quarters = [];
    for (let y = 2024; y <= 2025; y++) for (let m of ['03-31', '06-30', '09-30', '12-31'])
      quarters.push(q(`${y}-${m}`, 2 - quarters.length * 0.2, 100e9, 10e9));
    const f = fundamentalsScore(quarters);
    assert.equal(f.pass, false);
  });
  test('GOOG regression: strong growth with only one YoY point (5 quarters) -> pass, acceleration not assessable', () => {
    // Yahoo often returns only ~5 quarters; one YoY comparison is computable.
    const quarters = [
      q('2025-03-31', 2.81, 90e9, 23e9), q('2025-06-30', 2.31, 92e9, 21e9),
      q('2025-09-30', 2.87, 95e9, 25e9), q('2025-12-31', 2.82, 100e9, 26e9),
      q('2026-03-31', 5.11, 110e9, 35e9), // +81.85% YoY vs 2025-03-31
    ];
    const f = fundamentalsScore(quarters);
    assert.equal(f.available, true);
    assert.equal(f.epsGrowthYoY.length, 1);
    assert.equal(f.pass, true, `81.85% growth must pass: ${JSON.stringify(f.reasons)}`);
    assert.match(f.reasons.join(' '), /acceleration not assessable|insufficient history/i);
  });
  test('very strong but decelerating growth (100% -> 80%) -> still passes, with deceleration noted', () => {
    const prior = [
      q('2023-03-31', 1.00, 90e9, 9e9), q('2023-06-30', 1.00, 90e9, 9e9),
      q('2023-09-30', 1.00, 90e9, 9e9), q('2023-12-31', 1.00, 90e9, 9e9),
      q('2024-03-31', 1.00, 90e9, 9e9), q('2024-06-30', 2.00, 95e9, 11e9), // +100%
    ];
    const cur = [q('2024-09-30', 1.80, 96e9, 11e9)]; // +80% vs 1.00
    const f = fundamentalsScore([...prior, ...cur]);
    assert.equal(f.pass, true, JSON.stringify(f.reasons));
    assert.match(f.reasons.join(' '), /not accelerating|decelerat/i);
  });
  test('weak and decelerating growth (30% -> 15%) -> fails', () => {
    const quarters = [
      q('2023-03-31', 1.00, 90e9, 9e9), q('2023-06-30', 1.00, 90e9, 9e9),
      q('2023-09-30', 1.00, 90e9, 9e9), q('2023-12-31', 1.00, 90e9, 9e9),
      q('2024-03-31', 1.30, 95e9, 10e9), // +30%
      q('2024-06-30', 1.15, 96e9, 10e9), // +15% — weak and decelerating
    ];
    const f = fundamentalsScore(quarters);
    assert.equal(f.pass, false, JSON.stringify(f.epsGrowthYoY));
  });
  test('empty/missing data -> available=false, never throws', () => {
    assert.equal(fundamentalsScore([]).available, false);
    assert.equal(fundamentalsScore(null).available, false);
  });
});

// ---------- parsers (real fixtures) ----------
describe('parsers', () => {
  test('parseYahooChart parses real AAPL fixture into clean candles', () => {
    const j = JSON.parse(readFileSync(new URL('./fixtures/chart_AAPL.json', import.meta.url)));
    const candles = parseYahooChart(j);
    assert.ok(candles.length > 400);
    for (const c of candles.slice(-10)) {
      assert.ok(c.close > 0 && c.high >= c.low && c.volume >= 0 && c.date instanceof Date);
    }
  });
  test('parseYahooChart throws a clear error on invalid ticker fixture', () => {
    const j = JSON.parse(readFileSync(new URL('./fixtures/chart_INVALID.json', import.meta.url)));
    assert.throws(() => parseYahooChart(j), /not found|No data/i);
  });
  test('parseYahooFundamentals parses real AAPL fixture into quarters', () => {
    const j = JSON.parse(readFileSync(new URL('./fixtures/fundamentals_AAPL.json', import.meta.url)));
    const quarters = parseYahooFundamentals(j);
    assert.ok(quarters.length >= 4);
    const last = quarters.at(-1);
    assert.ok(last.eps > 0 && last.revenue > 0);
  });
  test('parseYahooFundamentals on ETF (SPY) returns empty, no throw', () => {
    const j = JSON.parse(readFileSync(new URL('./fixtures/fundamentals_SPY.json', import.meta.url)));
    const quarters = parseYahooFundamentals(j);
    assert.ok(Array.isArray(quarters));
    assert.equal(quarters.filter(x => x.eps != null).length, 0);
  });
});

// ---------- full pipeline ----------
describe('analyzeTicker (full pipeline on real fixtures)', () => {
  const chart = JSON.parse(readFileSync(new URL('./fixtures/chart_AAPL.json', import.meta.url)));
  const bench = JSON.parse(readFileSync(new URL('./fixtures/chart_GSPC.json', import.meta.url)));
  const fund = JSON.parse(readFileSync(new URL('./fixtures/fundamentals_AAPL.json', import.meta.url)));
  test('returns a complete report', () => {
    const r = analyzeTicker({ chartJson: chart, benchJson: bench, fundJson: fund });
    assert.ok(r.symbol);
    assert.equal(r.trendTemplate.criteria.length, 8);
    assert.ok(['ENTER', 'WAIT', 'EXTENDED', 'NO_ENTRY'].includes(r.entry.verdict));
    assert.ok(['HOLD', 'RAISE_STOP', 'SELL_PARTIAL', 'EXIT', 'N_A'].includes(r.exit.verdict));
    assert.ok(r.price > 0);
    assert.ok(r.exit.stop > 0);
    assert.ok(r.fundamentals);
  });
  test('ETF: fundamentals marked unavailable, technicals still complete', () => {
    const spy = JSON.parse(readFileSync(new URL('./fixtures/chart_SPY.json', import.meta.url)));
    const fundSpy = JSON.parse(readFileSync(new URL('./fixtures/fundamentals_SPY.json', import.meta.url)));
    const r = analyzeTicker({ chartJson: spy, benchJson: bench, fundJson: fundSpy });
    assert.equal(r.fundamentals.available, false);
    assert.equal(r.trendTemplate.criteria.length, 8);
  });
  test('entry price supplied -> exit analysis is position-aware', () => {
    const r = analyzeTicker({ chartJson: chart, benchJson: bench, fundJson: fund, entryPrice: 1 });
    // entry at $1 means enormous gain -> must not say HOLD with default stop below $1
    assert.ok(r.exit.stop > 1);
  });
});
