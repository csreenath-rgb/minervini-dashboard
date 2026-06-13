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
 * Flatten any supported watchlist shape into entries tagged with their list name.
 * Accepts a legacy flat array OR a v3 collection { lists:[{name, items:[...]}] }.
 */
export function normalizeWatchlist(input) {
  if (Array.isArray(input)) {
    return input.map((it) => ({ symbol: it.symbol, entryPrice: it.entryPrice, list: null }));
  }
  if (input && Array.isArray(input.lists)) {
    const out = [];
    for (const l of input.lists) {
      for (const it of (l.items || [])) out.push({ symbol: it.symbol, entryPrice: it.entryPrice, list: l.name });
    }
    return out;
  }
  return [];
}

/** Triggered alerts for one analyzed report (same rules as the dashboard). */
function triggersFor(symbol, r) {
  const out = [];
  if (r.entry.verdict === 'ENTER') {
    out.push({
      symbol, type: 'ENTRY', price: r.price,
      message: `Entry triggered: ${r.entry.reasons[0]} Buy zone ${r.entry.buyZone[0].toFixed(2)}–${r.entry.buyZone[1].toFixed(2)}, stop ${r.entry.stop.toFixed(2)}.`,
    });
  }
  if (r.exit.verdict === 'EXIT') {
    out.push({ symbol, type: 'EXIT', price: r.price, message: `Exit triggered: ${r.exit.reasons.join(' ')}` });
  } else if (r.exit.verdict === 'SELL_PARTIAL') {
    out.push({ symbol, type: 'TAKE_PROFIT', price: r.price, message: `Take-profit signal: ${r.exit.reasons.join(' ')}` });
  }
  return out;
}

/**
 * Analyze every watchlist entry and derive triggered alerts. Each symbol is
 * analyzed at most once per run (cached) even if it appears on several lists;
 * each resulting alert is tagged with the list it came from.
 * @param {Array<{symbol:string, entryPrice?:number}> | {lists:Array}} input
 * @param {{fetchImpl?: typeof fetch}} opts
 */
export async function checkWatchlist(input, { fetchImpl } = {}) {
  const entries = normalizeWatchlist(input);
  const results = [];
  const alerts = [];
  const cache = new Map();

  for (const entry of entries) {
    const symbol = String(entry.symbol || '').toUpperCase().trim();
    if (!symbol) continue;
    const key = `${symbol}|${entry.entryPrice ?? ''}`;
    try {
      let r = cache.get(key);
      if (!r) {
        const bundle = await fetchTickerBundle(symbol, { fetchImpl });
        r = analyzeTicker({
          chartJson: bundle.chartJson, benchJson: bundle.benchJson, fundJson: bundle.fundJson,
          entryPrice: entry.entryPrice ?? null,
        });
        cache.set(key, r);
      }
      results.push({
        symbol, watchlist: entry.list, price: r.price,
        entryVerdict: r.entry.verdict, exitVerdict: r.exit.verdict,
        pivot: r.entry.pivot, stop: r.exit.stop, trendTemplatePassed: r.trendTemplate.passed,
      });
      for (const a of triggersFor(symbol, r)) alerts.push({ ...a, watchlist: entry.list });
    } catch (err) {
      results.push({ symbol, watchlist: entry.list, error: err instanceof Error ? err.message : String(err) });
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

/**
 * Recipients for a watchlist: its subscribers, or the owner fallback when none.
 * @param {string|null} listName
 * @param {Record<string, string[]>} mailingLists
 * @param {string|null} fallback
 */
export function resolveRecipients(listName, mailingLists, fallback) {
  const arr = (mailingLists && listName != null) ? mailingLists[listName] : null;
  if (Array.isArray(arr) && arr.length) return [...arr];
  return fallback ? [fallback] : [];
}

/**
 * Build one email per watchlist, each addressed to that list's recipients.
 * @param {Array<{symbol,type,message,price,watchlist}>} alerts
 * @param {Record<string,string[]>} mailingLists  { listName: [emails] }
 * @param {string|null} fallback owner address used when a list has no subscribers
 */
export function buildEmailGroups(alerts, mailingLists = {}, fallback = null) {
  if (!alerts || !alerts.length) return [];
  const byList = new Map();
  for (const a of alerts) {
    const k = a.watchlist ?? null;
    if (!byList.has(k)) byList.set(k, []);
    byList.get(k).push(a);
  }
  const groups = [];
  for (const [listName, group] of byList) {
    const recipients = resolveRecipients(listName, mailingLists, fallback);
    if (!recipients.length) continue;
    const label = listName ? ` [${listName}]` : '';
    const subject = `Minervini dashboard${label}: ${group.length} alert${group.length > 1 ? 's' : ''} triggered`;
    const lines = group.map((a) => `[${a.type}] ${a.symbol} @ ${a.price.toFixed(2)}\n  ${a.message}`);
    const body = [
      `The scheduled check of watchlist "${listName ?? 'watchlist'}" triggered the following alerts:`,
      '', ...lines, '', 'Open your dashboard for full analysis.', '',
      'This is an automated tool implementing one published methodology — not financial advice.',
    ].join('\n');
    groups.push({ watchlist: listName, recipients, subject, body });
  }
  return groups;
}

// ---- CLI entry point (skipped when imported by tests) ----
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  const watchlistPath = process.argv[2] || 'watchlist.json';
  const outputPath = process.argv[3] || 'alerts.json';
  const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  let mailingLists = {};
  try { mailingLists = process.env.MAILING_LISTS ? JSON.parse(process.env.MAILING_LISTS) : {}; }
  catch { mailingLists = {}; }
  const fallback = process.env.MAIL_TO || process.env.GMAIL_ADDRESS || null;
  const out = await checkWatchlist(watchlist);
  const emails = buildEmailGroups(out.alerts, mailingLists, fallback);
  const email = buildEmail(out.alerts); // legacy combined form (kept for back-compat)
  writeFileSync(outputPath, JSON.stringify({ ...out, emails, email }, null, 2));
  process.stdout.write(`Checked ${out.results.length} symbols, ${out.alerts.length} alerts in ${emails.length} email group(s).\n`);
}
