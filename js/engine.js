/**
 * Minervini SEPA analysis engine.
 * Pure functions, no I/O, no DOM — runs in browser and Node identically.
 * Implements: 8-point Trend Template, RS rating (approximation vs benchmark),
 * base/VCP detection, pivot buy point, entry verdicts, stop-loss & exit rules,
 * and a fundamentals checklist (EPS / revenue growth, margin trend).
 */

// ---------------- math primitives ----------------

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

const last = (arr) => arr[arr.length - 1];
const closesOf = (candles) => candles.map((c) => c.close);

export function high52w(candles) {
  return Math.max(...candles.slice(-252).map((c) => c.high));
}

export function low52w(candles) {
  return Math.min(...candles.slice(-252).map((c) => c.low));
}

/**
 * IBD-style weighted 12-month return: (2*3mo + 6mo + 9mo + 12mo) / 5.
 * Periods are trading days; clamped for short histories.
 */
export function weightedReturn(closes) {
  const n = closes.length;
  if (n < 2) return 0;
  const ret = (days) => {
    const idx = Math.max(0, n - 1 - days);
    return closes[n - 1] / closes[idx] - 1;
  };
  return (2 * ret(63) + ret(126) + ret(189) + ret(252)) / 5;
}

/**
 * RS rating approximation (1–99). True RS ranks vs every US stock (proprietary);
 * we map weighted outperformance vs the benchmark through tanh to a percentile-like scale.
 * Equal performance -> 50. Strong outperformance -> 80+.
 */
export function rsRating(closes, benchCloses) {
  const diff = weightedReturn(closes) - weightedReturn(benchCloses);
  const score = Math.round(50 + 50 * Math.tanh(diff * 2.0));
  return Math.min(99, Math.max(1, score));
}

// ---------------- Trend Template ----------------

const TT_IDS = [
  'price_above_150_200', 'ma150_above_200', 'ma200_trending_up',
  'ma50_above_150_200', 'price_above_50', 'above_52w_low_30pct',
  'near_52w_high', 'rs_rating',
];

const TT_LABELS = {
  price_above_150_200: 'Price above 150-day and 200-day moving averages',
  ma150_above_200: '150-day moving average above 200-day',
  ma200_trending_up: '200-day moving average trending up for at least 1 month',
  ma50_above_150_200: '50-day moving average above 150-day and 200-day',
  price_above_50: 'Price above 50-day moving average',
  above_52w_low_30pct: 'Price at least 30% above 52-week low',
  near_52w_high: 'Price within 25% of 52-week high',
  rs_rating: 'Relative Strength rating 70 or higher (approximated vs S&P 500)',
};

export function trendTemplate(candles, benchmarkCandles) {
  const closes = closesOf(candles);
  const n = closes.length;
  if (n < 210) {
    return {
      passed: false,
      insufficientData: true,
      criteria: TT_IDS.map((id) => ({
        id, label: TT_LABELS[id], pass: false,
        detail: `Insufficient history (${n} days; ~210+ needed)`,
      })),
    };
  }
  const price = closes[n - 1];
  const s50 = sma(closes, 50), s150 = sma(closes, 150), s200 = sma(closes, 200);
  const m50 = last(s50), m150 = last(s150), m200 = last(s200);
  // ~1 month (21 trading days) ago; if history is barely over 200 days,
  // use the longest lookback available so the check still works.
  const lookback = Math.min(21, n - 200);
  const m200Prev = lookback > 0 ? s200[n - 1 - lookback] : null;
  const hi = high52w(candles), lo = low52w(candles);
  const rs = rsRating(closes, closesOf(benchmarkCandles));
  const fmt = (x) => (x == null ? 'n/a' : Number(x).toFixed(2));

  const checks = {
    price_above_150_200: [price > m150 && price > m200,
      `Price ${fmt(price)} vs 150d ${fmt(m150)} / 200d ${fmt(m200)}`],
    ma150_above_200: [m150 > m200, `150d ${fmt(m150)} vs 200d ${fmt(m200)}`],
    ma200_trending_up: [m200Prev != null && m200 > m200Prev,
      `200d now ${fmt(m200)} vs 1 month ago ${fmt(m200Prev)}`],
    ma50_above_150_200: [m50 > m150 && m50 > m200,
      `50d ${fmt(m50)} vs 150d ${fmt(m150)} / 200d ${fmt(m200)}`],
    price_above_50: [price > m50, `Price ${fmt(price)} vs 50d ${fmt(m50)}`],
    above_52w_low_30pct: [price >= lo * 1.30,
      `Price ${fmt(price)} is ${fmt((price / lo - 1) * 100)}% above 52w low ${fmt(lo)} (need ≥30%)`],
    near_52w_high: [price >= hi * 0.75,
      `Price ${fmt(price)} is ${fmt((1 - price / hi) * 100)}% below 52w high ${fmt(hi)} (need ≤25%)`],
    rs_rating: [rs >= 70, `RS ${rs} (need ≥70)`],
  };

  const criteria = TT_IDS.map((id) => ({
    id, label: TT_LABELS[id], pass: !!checks[id][0], detail: checks[id][1],
  }));
  return {
    passed: criteria.every((c) => c.pass),
    insufficientData: false,
    criteria,
    values: { price, m50, m150, m200, hi52w: hi, lo52w: lo, rs },
  };
}

// ---------------- base / VCP detection ----------------

/** Zigzag swing detection on closes. Returns [{type:'H'|'L', idx, price}]. */
function zigzag(closes, thresholdPct = 2.5) {
  const t = thresholdPct / 100;
  const swings = [];
  if (closes.length < 3) return swings;
  let dir = null;
  let extIdx = 0, ext = closes[0];
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i];
    if (dir === null) {
      if (c >= ext * (1 + t)) { swings.push({ type: 'L', idx: extIdx, price: ext }); dir = 'up'; ext = c; extIdx = i; }
      else if (c <= ext * (1 - t)) { swings.push({ type: 'H', idx: extIdx, price: ext }); dir = 'down'; ext = c; extIdx = i; }
      else if (c > ext) { ext = c; extIdx = i; }
    } else if (dir === 'up') {
      if (c > ext) { ext = c; extIdx = i; }
      else if (c <= ext * (1 - t)) { swings.push({ type: 'H', idx: extIdx, price: ext }); dir = 'down'; ext = c; extIdx = i; }
    } else {
      if (c < ext) { ext = c; extIdx = i; }
      else if (c >= ext * (1 + t)) { swings.push({ type: 'L', idx: extIdx, price: ext }); dir = 'up'; ext = c; extIdx = i; }
    }
  }
  return swings;
}

/**
 * Detect the most recent consolidation base and its VCP characteristics.
 * Pivot = high of the base's left-side peak (classic breakout buy point).
 */
export function detectBase(candles, { windowDays = 150, swingThresholdPct = 2.5 } = {}) {
  const none = { found: false, contractions: [], pivot: null };
  if (candles.length < 60) return none;

  const start = Math.max(0, candles.length - windowDays);
  const win = candles.slice(start);
  const closes = closesOf(win);
  const swings = zigzag(closes, swingThresholdPct);

  // Swing highs that are followed by at least one swing low (i.e., a completed pullback).
  const highsWithPullback = [];
  for (let i = 0; i < swings.length; i++) {
    if (swings[i].type === 'H' && swings.slice(i + 1).some((s) => s.type === 'L')) {
      highsWithPullback.push(i);
    }
  }
  if (highsWithPullback.length === 0) return none;

  // Base starts at the highest such swing high.
  const h0Pos = highsWithPullback.reduce((best, i) =>
    swings[i].price > swings[best].price ? i : best, highsWithPullback[0]);
  const h0 = swings[h0Pos];

  // Contractions: each H->L pullback from the base start onward.
  const contractions = [];
  let lastLow = null;
  for (let i = h0Pos; i < swings.length - 1; i++) {
    if (swings[i].type === 'H' && swings[i + 1].type === 'L') {
      const depthPct = ((swings[i].price - swings[i + 1].price) / swings[i].price) * 100;
      contractions.push({
        fromIdx: start + swings[i].idx, toIdx: start + swings[i + 1].idx,
        high: swings[i].price, low: swings[i + 1].price,
        depthPct: Math.round(depthPct * 100) / 100,
      });
      lastLow = swings[i + 1];
    }
  }
  if (contractions.length === 0 || lastLow === null) return none;

  // Validity checks.
  const maxDepth = Math.max(...contractions.map((c) => c.depthPct));
  if (maxDepth > 35) return none; // too deep — broken stock, not a base
  const baseLength = lastLow.idx - h0.idx;
  if (baseLength < 10) return none; // too short to be a base

  // Require a prior uptrend into the base (~10%+ over the prior ~60 bars).
  const before = Math.max(0, h0.idx - 60);
  if (closes[h0.idx] < closes[before] * 1.10) return none;

  // Volume dry-up: average volume in the last contraction vs the base overall.
  const lastLeg = win.slice(lastLow.idx - 5 >= 0 ? lastLow.idx - 5 : 0, lastLow.idx + 1);
  const baseCandles = win.slice(h0.idx, lastLow.idx + 1);
  const avgVol = (xs) => xs.reduce((a, c) => a + c.volume, 0) / Math.max(1, xs.length);
  const volumeDryUp = avgVol(lastLeg) < avgVol(baseCandles);

  const pivot = win[h0.idx].high; // left-side high of the base

  return {
    found: true,
    pivot: Math.round(pivot * 100) / 100,
    contractions,
    baseStartIdx: start + h0.idx,
    lastLowIdx: start + lastLow.idx,
    lastLow: lastLow.price,
    baseLengthDays: baseLength,
    volumeDryUp,
  };
}

// ---------------- entry signal ----------------

export function entrySignal({ candles, benchmarkCandles }) {
  const tt = trendTemplate(candles, benchmarkCandles);
  const price = last(candles).close;
  const reasons = [];

  if (!tt.passed) {
    const failed = tt.criteria.filter((c) => !c.pass).map((c) => c.label);
    reasons.push(tt.insufficientData
      ? 'Insufficient price history for Stage-2 analysis'
      : `Fails Trend Template: ${failed.join('; ')}`);
    return { verdict: 'NO_ENTRY', price, pivot: null, buyZone: null, stop: null, reasons, trendTemplate: tt, base: { found: false } };
  }

  const base = detectBase(candles);
  if (!base.found) {
    reasons.push('Trend Template passes, but no valid base/VCP consolidation detected — no defined buy point. Watch for a base to form.');
    return { verdict: 'NO_ENTRY', price, pivot: null, buyZone: null, stop: null, reasons, trendTemplate: tt, base };
  }

  const pivot = base.pivot;
  const buyZone = [pivot, Math.round(pivot * 1.05 * 100) / 100];
  // Stop: structural (below last contraction low) but never more than 8% below current price.
  const structuralStop = base.lastLow * 0.99;
  const floorStop = price * 0.92;
  const stop = Math.round(Math.max(structuralStop, floorStop) * 100) / 100;

  const vols = candles.map((c) => c.volume);
  const avgVol50 = last(sma(vols, Math.min(50, vols.length)));
  const volumeConfirmed = avgVol50 ? last(candles).volume >= 1.2 * avgVol50 : false;

  let verdict;
  if (price > buyZone[1]) {
    verdict = 'EXTENDED';
    reasons.push(`Price ${price.toFixed(2)} is more than 5% above pivot ${pivot.toFixed(2)} — extended, do not chase. Wait for a new base.`);
  } else if (price > pivot) {
    verdict = 'ENTER';
    reasons.push(`Breakout above pivot ${pivot.toFixed(2)} within the 5% buy zone${volumeConfirmed ? ' on above-average volume' : ' — caution: volume below breakout standard (want ≥120% of 50-day average)'}.`);
  } else {
    verdict = 'WAIT';
    reasons.push(`Base formed; price ${price.toFixed(2)} below pivot ${pivot.toFixed(2)}. Set an alert at the pivot.`);
  }

  return { verdict, price, pivot, buyZone, stop, volumeConfirmed, reasons, trendTemplate: tt, base };
}

// ---------------- exit signal ----------------

export function exitSignal({ candles, entryPrice = null }) {
  const closes = closesOf(candles);
  const n = closes.length;
  const price = closes[n - 1];
  const s50 = sma(closes, Math.min(50, n));
  const s150 = n >= 150 ? sma(closes, 150) : null;
  const m50 = last(s50);
  const m150 = s150 ? last(s150) : null;
  const reasons = [];

  if (entryPrice == null) {
    // Generic trailing analysis for non-holders.
    const stop = Math.round(Math.max(m50 ?? price * 0.92, price * 0.92) * 100) / 100;
    let verdict = 'HOLD';
    if (m150 != null && price < m150) { verdict = 'EXIT'; reasons.push('Price below 150-day moving average — Stage-2 uptrend broken.'); }
    else if (m50 != null && price < m50) { verdict = 'RAISE_STOP'; reasons.push('Price below 50-day moving average — tighten stops.'); }
    else reasons.push('Uptrend intact (price above 50-day moving average).');
    return { verdict, stop: Math.min(stop, price * 0.999), price, gainPct: null, reasons };
  }

  const gainPct = ((price - entryPrice) / entryPrice) * 100;
  // Initial stop: 7.5% below entry (never worse than Minervini's 8% ceiling).
  let stop = entryPrice * 0.925;
  let verdict = 'HOLD';

  if (gainPct >= 20) {
    // Sell into strength: take partial profits, raise stop to at least breakeven / trail 10%.
    stop = Math.max(entryPrice, price * 0.90);
    verdict = 'SELL_PARTIAL';
    reasons.push(`Gain ${gainPct.toFixed(1)}% ≥ 20% — sell into strength: take partial profits and raise stop to ${stop.toFixed(2)} (breakeven or better).`);
  }

  if (m150 != null && price < m150) {
    verdict = 'EXIT';
    reasons.push(`Close ${price.toFixed(2)} below 150-day moving average ${m150.toFixed(2)} — uptrend broken, exit.`);
  } else if (price <= stop) {
    verdict = 'EXIT';
    reasons.push(`Price ${price.toFixed(2)} at/below stop ${stop.toFixed(2)} — exit per loss-cutting rule (max 7–8% loss).`);
  } else if (verdict === 'HOLD' && m50 != null && price < m50) {
    verdict = 'RAISE_STOP';
    reasons.push(`Price below 50-day moving average ${m50.toFixed(2)} — warning: tighten stop.`);
  } else if (verdict === 'HOLD') {
    reasons.push(`Position healthy: gain ${gainPct.toFixed(1)}%, price above key moving averages. Stop at ${stop.toFixed(2)}.`);
  }

  return { verdict, stop: Math.round(stop * 100) / 100, price, gainPct: Math.round(gainPct * 100) / 100, reasons };
}

// ---------------- fundamentals ----------------

/**
 * quarters: [{date:'YYYY-MM-DD', eps, revenue, netIncome}] sorted ascending.
 * Computes year-over-year growth (quarter vs same quarter prior year, index-4)
 * and Minervini-style checks: EPS growth ≥20–25% and accelerating.
 */
export function fundamentalsScore(quarters) {
  if (!quarters || !Array.isArray(quarters)) return { available: false, pass: false, reasons: ['No fundamental data'] };
  const q = quarters.filter((x) => x && x.eps != null).sort((a, b) => a.date.localeCompare(b.date));
  if (q.length < 5) return { available: false, pass: false, reasons: ['Insufficient fundamental data (need 5+ quarters)'] };

  const yoy = (arr, key) => {
    const out = [];
    for (let i = 4; i < arr.length; i++) {
      const prev = arr[i - 4][key], cur = arr[i][key];
      if (prev != null && cur != null && prev !== 0) {
        out.push(Math.round(((cur - prev) / Math.abs(prev)) * 10000) / 100);
      }
    }
    return out;
  };
  const epsGrowthYoY = yoy(q, 'eps');
  const revGrowthYoY = yoy(q, 'revenue');
  const margins = q.map((x) => (x.netIncome != null && x.revenue ? Math.round((x.netIncome / x.revenue) * 10000) / 100 : null));
  const validMargins = margins.filter((m) => m != null);
  const marginTrendUp = validMargins.length >= 2 ? validMargins.at(-1) >= validMargins[0] : null;

  const lastEps = epsGrowthYoY.at(-1), prevEps = epsGrowthYoY.at(-2);
  const epsStrong = lastEps != null && lastEps >= 20;
  // Acceleration can only be judged when a prior YoY point exists. Yahoo often
  // returns just ~5 quarters (one YoY point); unknown acceleration must not fail
  // an otherwise strong grower. Deceleration only disqualifies when growth has
  // also dropped below 25% — very strong growth (≥25%) passes with a warning.
  const accelKnown = lastEps != null && prevEps != null;
  const epsAccelerating = accelKnown && lastEps >= prevEps;
  const pass = !!(epsStrong && (!accelKnown || epsAccelerating || lastEps >= 25));

  const accelNote = !accelKnown
    ? ', acceleration not assessable (insufficient history)'
    : (epsAccelerating ? ', accelerating' : ', not accelerating (decelerating vs prior quarter — watch)');
  const reasons = [];
  reasons.push(lastEps == null ? 'EPS growth not computable'
    : `Latest quarterly EPS growth ${lastEps}% YoY (want ≥20–25%) — ${epsStrong ? 'strong' : 'weak'}${accelNote}`);
  if (revGrowthYoY.length) reasons.push(`Latest quarterly revenue growth ${revGrowthYoY.at(-1)}% YoY`);
  if (marginTrendUp != null) reasons.push(`Profit margin trend: ${marginTrendUp ? 'improving/stable' : 'deteriorating'}`);

  return { available: true, pass, epsGrowthYoY, revGrowthYoY, margins, marginTrendUp, reasons };
}

// ---------------- parsers ----------------

export function parseYahooChart(json) {
  const result = json?.chart?.result?.[0];
  if (!result) {
    const desc = json?.chart?.error?.description || 'No data returned';
    throw new Error(`Ticker not found or no data: ${desc}`);
  }
  const ts = result.timestamp || [];
  const qu = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const close = qu.close?.[i];
    if (close == null) continue; // skip null trading entries
    candles.push({
      date: new Date(ts[i] * 1000),
      open: qu.open?.[i] ?? close,
      high: qu.high?.[i] ?? close,
      low: qu.low?.[i] ?? close,
      close,
      volume: qu.volume?.[i] ?? 0,
    });
  }
  if (candles.length === 0) throw new Error('Ticker not found or no data: empty price series');
  candles.meta = result.meta;
  return candles;
}

export function parseYahooFundamentals(json) {
  const results = json?.timeseries?.result;
  if (!Array.isArray(results)) return [];
  const byDate = new Map();
  const keyMap = {
    quarterlyDilutedEPS: 'eps',
    quarterlyTotalRevenue: 'revenue',
    quarterlyNetIncome: 'netIncome',
  };
  for (const r of results) {
    const type = r?.meta?.type?.[0];
    const field = keyMap[type];
    if (!field || !Array.isArray(r[type])) continue;
    for (const v of r[type]) {
      if (!v || !v.asOfDate || v.reportedValue?.raw == null) continue;
      if (!byDate.has(v.asOfDate)) byDate.set(v.asOfDate, { date: v.asOfDate });
      byDate.get(v.asOfDate)[field] = v.reportedValue.raw;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------- full pipeline ----------------

export function analyzeTicker({ chartJson, benchJson, fundJson = null, entryPrice = null }) {
  const candles = parseYahooChart(chartJson);
  const bench = parseYahooChart(benchJson);
  const meta = candles.meta || {};
  const symbol = meta.symbol || 'UNKNOWN';
  const isEtf = (meta.instrumentType || '').toUpperCase() === 'ETF';
  const price = last(candles).close;

  const tt = trendTemplate(candles, bench);
  const entry = entrySignal({ candles, benchmarkCandles: bench });
  const exit = exitSignal({ candles, entryPrice });

  let fundamentals;
  if (isEtf) {
    fundamentals = { available: false, pass: false, reasons: ['ETF — fundamental analysis not applicable; technicals only.'] };
  } else {
    fundamentals = fundamentalsScore(fundJson ? parseYahooFundamentals(fundJson) : null);
  }

  const closes = closesOf(candles);
  return {
    symbol,
    isEtf,
    price,
    asOf: last(candles).date.toISOString(),
    trendTemplate: tt,
    entry,
    exit,
    fundamentals,
    levels: {
      sma50: last(sma(closes, Math.min(50, closes.length))),
      sma150: closes.length >= 150 ? last(sma(closes, 150)) : null,
      sma200: closes.length >= 200 ? last(sma(closes, 200)) : null,
      high52w: high52w(candles),
      low52w: low52w(candles),
      pivot: entry.pivot,
      stop: exit.stop,
    },
    candles,
  };
}
