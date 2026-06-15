/**
 * Data layer: Yahoo Finance fetching with CORS-proxy fallbacks.
 * In Node (GitHub Actions) the direct request succeeds; in a browser on a
 * static page the direct request is blocked by CORS, so proxies are tried in order.
 */

import { ADAPTERS, quartersToYahooJson } from './providers.js';

const YAHOO = 'https://query1.finance.yahoo.com';
export const BENCHMARK = '^GSPC';

/** Ordered CORS proxy wrappers. Each takes a target URL and returns a proxied URL. */
export const PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

/**
 * @param {string} symbol
 * @param {string} range e.g. '2y'
 * @returns {string}
 */
export function chartUrl(symbol, range = '2y') {
  return `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
}

/**
 * @param {string} symbol
 * @returns {string}
 */
export function fundamentalsUrl(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const threeYearsAgo = now - 3 * 365 * 86400;
  const types = 'quarterlyDilutedEPS,quarterlyTotalRevenue,quarterlyNetIncome';
  return `${YAHOO}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${types}&period1=${threeYearsAgo}&period2=${now}`;
}

/**
 * Fetch JSON from a URL: direct first, then each CORS proxy in order.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch}} opts
 * @returns {Promise<unknown>}
 */
export async function fetchJsonWithFallback(url, { fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const routes = [url, ...PROXIES.map((p) => p(url))];
  const errors = [];
  for (const route of routes) {
    try {
      const res = await f(route);
      if (!res.ok) { errors.push(`${route} -> HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (err) {
      errors.push(`${route} -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All data sources failed for ${url}:\n${errors.join('\n')}`);
}

/** Direct fetch with NO CORS proxy — used for keyed provider requests so a key is never leaked to a proxy. */
export async function fetchJsonDirect(url, { fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const res = await f(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Provider+key from environment (used by the Node email job). */
export function envFundamentalsConfig() {
  if (typeof process !== 'undefined' && process.env) {
    const provider = process.env.FUNDAMENTALS_PROVIDER;
    const key = process.env.FUNDAMENTALS_API_KEY;
    if (provider && key) return { provider, key };
  }
  return null;
}

/**
 * Fetch fundamentals straight from the configured provider — NO Yahoo fallback.
 * Tries each attempt (URL set) in order until one yields quarters; throws on total failure.
 * Used by the dashboard's "Test key" diagnostic so provider problems are visible.
 * @returns {Promise<{quarters: Array, fundJson: object}>}
 */
export async function fetchProviderFundamentals(symbol, cfg, { fetchImpl } = {}) {
  const provider = String((cfg && cfg.provider) || '').toLowerCase();
  const adapter = ADAPTERS[provider];
  if (!adapter || !cfg.key) throw new Error('No data provider/key configured');
  let lastErr = null;
  for (const urls of adapter.attempts(symbol, cfg.key)) {
    try {
      const responses = await Promise.all(urls.map((u) => fetchJsonDirect(u, { fetchImpl })));
      const quarters = adapter.toQuarters(responses);
      if (quarters && quarters.length) return { quarters, fundJson: quartersToYahooJson(quarters) };
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return { quarters: [], fundJson: quartersToYahooJson([]) };
}

/**
 * Fetch fundamentals via the configured data provider, falling back to Yahoo.
 * Returns Yahoo-shaped JSON so the engine parser is unchanged.
 * @param {string} symbol
 * @param {{fetchImpl?: typeof fetch, fundamentals?: {provider:string, key?:string}}} opts
 */
export async function fetchFundamentals(symbol, { fetchImpl, fundamentals } = {}) {
  const cfg = fundamentals || envFundamentalsConfig() || { provider: 'yahoo' };
  if (ADAPTERS[String(cfg.provider || '').toLowerCase()] && cfg.key) {
    try {
      const { quarters, fundJson } = await fetchProviderFundamentals(symbol, cfg, { fetchImpl });
      if (quarters.length >= 5) return fundJson; // usable provider data
    } catch { /* fall through to Yahoo */ }
  }
  return fetchJsonWithFallback(fundamentalsUrl(symbol), { fetchImpl }); // default / fallback
}

/**
 * Fetch everything needed to analyze one ticker:
 * its chart, the S&P 500 benchmark chart, and (best-effort) fundamentals.
 * @param {string} symbol
 * @param {{fetchImpl?: typeof fetch, range?: string}} opts
 */
export async function fetchTickerBundle(symbol, { fetchImpl, range = '2y', fundamentals } = {}) {
  const [chartJson, benchJson] = await Promise.all([
    fetchJsonWithFallback(chartUrl(symbol, range), { fetchImpl }),
    fetchJsonWithFallback(chartUrl(BENCHMARK, range), { fetchImpl }),
  ]);
  let fundJson = null;
  try {
    fundJson = await fetchFundamentals(symbol, { fetchImpl, fundamentals });
  } catch {
    fundJson = null; // fundamentals are best-effort; technicals must still work
  }
  return { chartJson, benchJson, fundJson };
}
