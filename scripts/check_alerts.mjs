/**
 * Watchlist alert checker — run by GitHub Actions on a schedule.
 * Reads watchlist.json, analyzes each ticker with the SAME engine the
 * dashboard uses (single source of truth), and writes alerts.json.
 * Emailing is done by a separate workflow step (Python smtplib) so no
 * npm dependencies are needed.
 *
 * Usage: node scripts/check_alerts.mjs [watchlistPath] [outputPath]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeTicker } from '../js/engine.js';
import { fetchTickerBundle } from '../js/data.js';

/**
 * Analyze every watchlist entry and derive triggered alerts.
 * @param {Array<{symbol: string, entryPrice?: number}>} watchlist
 * @param {{fetchImpl?: typeof fetch}} opts
 */
export async function checkWatchlist(watchlist, { fetchImpl } = {}) {
  const results = [];
  const alerts = [];

  for (const item of watchlist) {
    const symbol = String(item.symbol || '').toUpperCase().trim();
    if (!symbol) continue;
    try {
      const bundle = await fetchTickerBundle(symbol, { fetchImpl });
      const r = analyzeTicker({
        chartJson: bundle.chartJson,
        benchJson: bundle.benchJson,
        fundJson: bundle.fundJson,
        entryPrice: item.entryPrice ?? null,
      });
      results.push({
        symbol,
        price: r.price,
        entryVerdict: r.entry.verdict,
        exitVerdict: r.exit.verdict,
        pivot: r.entry.pivot,
        stop: r.exit.stop,
        trendTemplatePassed: r.trendTemplate.passed,
      });
      if (r.entry.verdict === 'ENTER') {
        alerts.push({
          symbol, type: 'ENTRY', price: r.price,
          message: `Entry triggered: ${r.entry.reasons[0]} Buy zone ${r.entry.buyZone[0].toFixed(2)}–${r.entry.buyZone[1].toFixed(2)}, stop ${r.entry.stop.toFixed(2)}.`,
        });
      }
      if (r.exit.verdict === 'EXIT') {
        alerts.push({
          symbol, type: 'EXIT', price: r.price,
          message: `Exit triggered: ${r.exit.reasons.join(' ')}`,
        });
      } else if (r.exit.verdict === 'SELL_PARTIAL') {
        alerts.push({
          symbol, type: 'TAKE_PROFIT', price: r.price,
          message: `Take-profit signal: ${r.exit.reasons.join(' ')}`,
        });
      }
    } catch (err) {
      results.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, alerts, checkedAt: new Date().toISOString() };
}

/**
 * Build the alert email, or null when there is nothing to send.
 * @param {Array<{symbol: string, type: string, message: string, price: number}>} alerts
 */
export function buildEmail(alerts) {
  if (!alerts || alerts.length === 0) return null;
  const subject = `Minervini dashboard: ${alerts.length} alert${alerts.length > 1 ? 's' : ''} triggered`;
  const lines = alerts.map((a) => `[${a.type}] ${a.symbol} @ ${a.price.toFixed(2)}\n  ${a.message}`);
  const body = [
    'The scheduled watchlist check triggered the following alerts:',
    '',
    ...lines,
    '',
    'Open your dashboard for full analysis.',
    '',
    'This is an automated tool implementing one published methodology — not financial advice.',
  ].join('\n');
  return { subject, body };
}

// ---- CLI entry point (skipped when imported by tests) ----
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  const watchlistPath = process.argv[2] || 'watchlist.json';
  const outputPath = process.argv[3] || 'alerts.json';
  const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  const out = await checkWatchlist(watchlist);
  const email = buildEmail(out.alerts);
  writeFileSync(outputPath, JSON.stringify({ ...out, email }, null, 2));
  process.stdout.write(`Checked ${out.results.length} symbols, ${out.alerts.length} alerts.\n`);
}
