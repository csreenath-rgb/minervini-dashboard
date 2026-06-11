/**
 * Pure UI logic: watchlist store operations, alert derivation and deduping,
 * verdict presentation. No DOM, no I/O — fully unit-testable.
 */

/**
 * @param {Array<{symbol: string, entryPrice?: number}>} list
 * @param {{symbol: string, entryPrice?: number}} item
 * @returns {Array<{symbol: string, entryPrice?: number}>} new array (no mutation)
 */
export function addToWatchlist(list, item) {
  const symbol = String(item?.symbol || '').toUpperCase().trim();
  if (!symbol) return [...list];
  const entryPrice = item.entryPrice != null && isFinite(item.entryPrice) && item.entryPrice > 0
    ? Number(item.entryPrice) : undefined;
  const existing = list.findIndex((x) => x.symbol === symbol);
  if (existing >= 0) {
    return list.map((x, i) => (i === existing
      ? { symbol, entryPrice: entryPrice ?? x.entryPrice }
      : x));
  }
  const row = entryPrice != null ? { symbol, entryPrice } : { symbol };
  return [...list, row];
}

/**
 * @param {Array<{symbol: string}>} list
 * @param {string} symbol
 */
export function removeFromWatchlist(list, symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  return list.filter((x) => x.symbol !== s);
}

/**
 * Derive triggered alerts from an engine report. Mirrors scripts/check_alerts.mjs rules.
 * @param {{symbol: string, price: number, entry: any, exit: any}} report
 */
export function deriveAlerts(report) {
  const alerts = [];
  if (report.entry?.verdict === 'ENTER') {
    alerts.push({
      symbol: report.symbol, type: 'ENTRY', price: report.price,
      message: `Entry triggered: ${report.entry.reasons?.[0] ?? ''} Buy zone ${report.entry.buyZone?.[0]?.toFixed(2)}–${report.entry.buyZone?.[1]?.toFixed(2)}, stop ${report.entry.stop?.toFixed(2)}.`,
    });
  }
  if (report.exit?.verdict === 'EXIT') {
    alerts.push({
      symbol: report.symbol, type: 'EXIT', price: report.price,
      message: `Exit triggered: ${(report.exit.reasons || []).join(' ')}`,
    });
  } else if (report.exit?.verdict === 'SELL_PARTIAL') {
    alerts.push({
      symbol: report.symbol, type: 'TAKE_PROFIT', price: report.price,
      message: `Take-profit signal: ${(report.exit.reasons || []).join(' ')}`,
    });
  }
  return alerts;
}

/**
 * Stable key so the same alert fires at most once per day.
 * @param {{symbol: string, type: string}} alert
 * @param {string} day YYYY-MM-DD
 */
export function alertKey(alert, day) {
  return `${alert.symbol}|${alert.type}|${day}`;
}

/**
 * @param {Array} alerts
 * @param {Set<string>} seenKeys
 * @param {string} day YYYY-MM-DD
 */
export function filterNewAlerts(alerts, seenKeys, day) {
  return alerts.filter((a) => !seenKeys.has(alertKey(a, day)));
}

const BADGES = {
  ENTER: { label: 'ENTER NOW', cls: 'good' },
  WAIT: { label: 'WAIT — SET ALERT AT PIVOT', cls: 'warn' },
  EXTENDED: { label: 'EXTENDED — DO NOT CHASE', cls: 'warn' },
  NO_ENTRY: { label: 'DO NOT ENTER', cls: 'bad' },
  HOLD: { label: 'HOLD', cls: 'good' },
  RAISE_STOP: { label: 'RAISE STOP', cls: 'warn' },
  SELL_PARTIAL: { label: 'SELL PARTIAL / TAKE PROFITS', cls: 'warn' },
  EXIT: { label: 'EXIT NOW', cls: 'bad' },
  N_A: { label: 'N/A', cls: 'neutral' },
};

/**
 * @param {string} verdict
 * @returns {{label: string, cls: string}}
 */
export function verdictBadge(verdict) {
  return BADGES[verdict] || { label: String(verdict || 'UNKNOWN'), cls: 'neutral' };
}
