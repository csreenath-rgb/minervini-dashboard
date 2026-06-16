/**
 * Pure helpers for the per-ticker browser cache (no I/O).
 * The cache stores each symbol's last-fetched Yahoo chart so subsequent fetches
 * can reuse it the same day, or fetch only the new bars and merge across days.
 */

/** Local calendar day as YYYY-MM-DD. */
export function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole calendar days between a YYYY-MM-DD string and now (Infinity if missing). */
export function ageDays(dateStr, now = new Date()) {
  if (!dateStr) return Infinity;
  const then = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${todayStr(now)}T00:00:00`);
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

/** Newest bar timestamp (seconds) in a Yahoo chart JSON, or null. */
export function lastTimestamp(chartJson) {
  const ts = chartJson && chartJson.chart && chartJson.chart.result && chartJson.chart.result[0]
    && chartJson.chart.result[0].timestamp;
  return Array.isArray(ts) && ts.length ? ts[ts.length - 1] : null;
}

/**
 * Merge two Yahoo chart payloads into one, deduped by timestamp. Bars present in
 * BOTH are taken from `newJson` (so the latest/partial bar is updated). Preserves
 * the fields the engine reads: meta + indicators.quote[0].{open,high,low,close,volume}.
 */
export function mergeChartJson(oldJson, newJson) {
  const oldR = oldJson && oldJson.chart && oldJson.chart.result && oldJson.chart.result[0];
  const newR = newJson && newJson.chart && newJson.chart.result && newJson.chart.result[0];
  if (!oldR) return newJson;
  if (!newR) return oldJson;
  const byTs = new Map();
  const ingest = (r) => {
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    for (let i = 0; i < ts.length; i++) {
      byTs.set(ts[i], {
        open: q.open ? q.open[i] : null, high: q.high ? q.high[i] : null,
        low: q.low ? q.low[i] : null, close: q.close ? q.close[i] : null,
        volume: q.volume ? q.volume[i] : null,
      });
    }
  };
  ingest(oldR);
  ingest(newR); // new wins on overlapping timestamps
  const timestamp = [...byTs.keys()].sort((a, b) => a - b);
  const quote = { open: [], high: [], low: [], close: [], volume: [] };
  for (const t of timestamp) {
    const c = byTs.get(t);
    quote.open.push(c.open); quote.high.push(c.high); quote.low.push(c.low);
    quote.close.push(c.close); quote.volume.push(c.volume);
  }
  return { chart: { result: [{ meta: newR.meta || oldR.meta, timestamp, indicators: { quote: [quote] } }], error: null } };
}
