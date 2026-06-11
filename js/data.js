/**
 * Data layer: Yahoo Finance fetching with CORS-proxy fallbacks.
 * In Node (GitHub Actions) the direct request succeeds; in a browser on a
 * static page the direct request is blocked by CORS, so proxies are tried in order.
 */

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

/**
 * Fetch everything needed to analyze one ticker:
 * its chart, the S&P 500 benchmark chart, and (best-effort) fundamentals.
 * @param {string} symbol
 * @param {{fetchImpl?: typeof fetch, range?: string}} opts
 */
export async function fetchTickerBundle(symbol, { fetchImpl, range = '2y' } = {}) {
  const [chartJson, benchJson] = await Promise.all([
    fetchJsonWithFallback(chartUrl(symbol, range), { fetchImpl }),
    fetchJsonWithFallback(chartUrl(BENCHMARK, range), { fetchImpl }),
  ]);
  let fundJson = null;
  try {
    fundJson = await fetchJsonWithFallback(fundamentalsUrl(symbol), { fetchImpl });
  } catch {
    fundJson = null; // fundamentals are best-effort; technicals must still work
  }
  return { chartJson, benchJson, fundJson };
}
