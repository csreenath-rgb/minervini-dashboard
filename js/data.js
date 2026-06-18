/**
 * Data layer: Yahoo Finance fetching with CORS-proxy fallbacks.
 * In Node (GitHub Actions) the direct request succeeds; in a browser on a
 * static page the direct request is blocked by CORS, so proxies are tried in order.
 */

import { ADAPTERS, quartersToYahooJson } from './providers.js';
import { parseYahooFundamentals } from './engine.js';
import { todayStr, ageDays, lastTimestamp, mergeChartJson } from './cache.js';
import { MARKETS } from './app-core.js';

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

/** Chart URL for an explicit time window (used for incremental top-ups). */
export function chartRangeUrl(symbol, period1, period2) {
  return `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
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
export async function fetchJsonDirect(urlOrReq, { fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
  const opts = (urlOrReq && typeof urlOrReq === 'object' && urlOrReq.headers) ? { headers: urlOrReq.headers } : undefined;
  const res = await f(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  // Providers signal quota/auth problems with a 200 + an error object (Alpha Vantage
  // "Information"/"Note", FMP "Error Message"). Surface it instead of silently returning no data.
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const msg = json['Error Message'] || json.Information || json.Note || json.error;
    if (msg && !json.quarterlyEarnings && !json.quarterlyReports && !json.timeseries) {
      throw new Error(String(msg).slice(0, 240));
    }
  }
  return json;
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
  const errs = [];
  for (const urls of adapter.attempts(symbol, cfg.key)) {
    try {
      const responses = await Promise.all(urls.map((u) => fetchJsonDirect(u, { fetchImpl })));
      const quarters = adapter.toQuarters(responses);
      if (quarters && quarters.length) return { quarters, fundJson: quartersToYahooJson(quarters) };
      errs.push(`${(typeof urls[0] === 'string' ? urls[0] : urls[0].url)} -> returned no usable quarters`);
    } catch (e) { errs.push(e instanceof Error ? e.message : String(e)); }
  }
  if (errs.length) throw new Error(errs.join(' | '));
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
const FUND_TTL_DAYS = 3; // fundamentals are quarterly; reuse for a few days to conserve provider quota
const hasEnoughFundamentals = (fj) => {
  try { return parseYahooFundamentals(fj).filter((q) => q.eps != null).length >= 5; } catch { return false; }
};

/**
 * Fetch chart, benchmark and fundamentals for one ticker, with an optional
 * per-ticker browser cache. Same day -> reuse (no network). Across days -> fetch
 * only the new bars and merge. Fundamentals are reused within FUND_TTL_DAYS for the
 * same provider, and good cached fundamentals are never overwritten by a failed fetch.
 * @param {{fetchImpl?: typeof fetch, range?: string, fundamentals?: {provider:string,key?:string}, cache?: {getItem:Function,setItem:Function}}} opts
 */
export async function fetchTickerBundle(symbol, { fetchImpl, range = '2y', fundamentals, cache, market = 'US' } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const benchmark = (MARKETS[market] && MARKETS[market].benchmark) || BENCHMARK;
  const provider = String((fundamentals && fundamentals.provider) || (envFundamentalsConfig() && envFundamentalsConfig().provider) || 'yahoo').toLowerCase();
  const cacheKey = `mnv_bundle_${sym}`;
  let cached = null;
  if (cache) { try { cached = JSON.parse(cache.getItem(cacheKey)); } catch { cached = null; } }
  const today = todayStr();

  // ----- chart + benchmark (provider-independent) -----
  let chartJson; let benchJson; let chartReused = false;
  if (cached && cached.chartDate === today && cached.chart && cached.bench) {
    chartJson = cached.chart; benchJson = cached.bench; chartReused = true;
  } else if (cached && cached.chart && cached.bench) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const p1s = lastTimestamp(cached.chart) || (now - 2 * 365 * 86400);
      const p1b = lastTimestamp(cached.bench) || p1s;
      const [freshSym, freshBench] = await Promise.all([
        fetchJsonWithFallback(chartRangeUrl(sym, p1s, now), { fetchImpl }),
        fetchJsonWithFallback(chartRangeUrl(benchmark, p1b, now), { fetchImpl }),
      ]);
      chartJson = mergeChartJson(cached.chart, freshSym);
      benchJson = mergeChartJson(cached.bench, freshBench);
    } catch {
      [chartJson, benchJson] = await Promise.all([
        fetchJsonWithFallback(chartUrl(sym, range), { fetchImpl }),
        fetchJsonWithFallback(chartUrl(benchmark, range), { fetchImpl }),
      ]);
    }
  } else {
    [chartJson, benchJson] = await Promise.all([
      fetchJsonWithFallback(chartUrl(sym, range), { fetchImpl }),
      fetchJsonWithFallback(chartUrl(benchmark, range), { fetchImpl }),
    ]);
  }

  // ----- fundamentals (provider-dependent; reuse within TTL, keep last good) -----
  let fundJson; let fundProvider = provider; let fundDate = today;
  if (cached && cached.fund && cached.fundProvider === provider && ageDays(cached.fundDate) <= FUND_TTL_DAYS) {
    fundJson = cached.fund; fundDate = cached.fundDate; // reuse cached, same provider, fresh enough
  } else {
    let fetched = null;
    try { fetched = await fetchFundamentals(sym, { fetchImpl, fundamentals }); } catch { fetched = null; }
    if (hasEnoughFundamentals(fetched)) { fundJson = fetched; fundDate = today; }
    else if (cached && cached.fund) { fundJson = cached.fund; fundProvider = cached.fundProvider; fundDate = cached.fundDate; } // keep last good
    else { fundJson = fetched; fundDate = today; }
  }

  // ----- persist -----
  if (cache) {
    try { cache.setItem(cacheKey, JSON.stringify({ chartDate: today, chart: chartJson, bench: benchJson, fund: fundJson, fundProvider, fundDate })); }
    catch { /* storage full/unavailable: skip caching */ }
  }

  return { chartJson, benchJson, fundJson, fromCache: chartReused };
}
