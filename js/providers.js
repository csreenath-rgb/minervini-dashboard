/**
 * Fundamentals data-provider adapters (pure — no I/O).
 * Each adapter turns a provider's documented response into the engine's
 * normalized quarters array: [{ date:'YYYY-MM-DD', eps, revenue, netIncome }].
 * data.js does the fetching; these only build URLs and parse responses.
 *
 * Field mappings follow each provider's documented schema. Fundamentals are
 * best-effort: a missing field becomes null and the engine copes (it needs EPS;
 * revenue/net-income only feed the supporting margin/revenue notes).
 */

export const FUNDAMENTALS_PROVIDERS = ['yahoo', 'finnhub', 'fmp', 'alphavantage', 'indianapi'];

// Which providers work from a browser (CORS-allowed AND free tier permits client-side use).
// FMP's free plan rejects browser requests (HTTP 402), so it is server/email-job only.
export const BROWSER_OK = { yahoo: true, finnhub: true, alphavantage: true, fmp: false, indianapi: true };

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

// ---- Financial Modeling Prep: one call, quarterly income statement ----
export const fmp = {
  needsKey: true,
  // Newer free keys use the /stable/ API; legacy /api/v3/ is now limited to eligible
  // accounts, so try stable first and fall back to v3.
  attempts: (symbol, key) => [
    [`https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(symbol)}&period=quarter&limit=12&apikey=${encodeURIComponent(key)}`],
    [`https://financialmodelingprep.com/api/v3/income-statement/${encodeURIComponent(symbol)}?period=quarter&limit=12&apikey=${encodeURIComponent(key)}`],
  ],
  toQuarters: ([rows]) => {
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        date: r && r.date,
        eps: num(r && (r.epsDiluted ?? r.epsdiluted ?? r.eps)),
        revenue: num(r && r.revenue),
        netIncome: num(r && r.netIncome),
      }))
      .filter((q) => q.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
};

// ---- Alpha Vantage: EARNINGS (EPS) + INCOME_STATEMENT (revenue, net income) ----
export const alphavantage = {
  needsKey: true,
  // Free tier is 25 requests/day, so use a SINGLE EARNINGS call (quarterly EPS) — enough for the
  // Minervini EPS-growth check. (Revenue/margins would need a 2nd INCOME_STATEMENT call; skipped to
  // conserve quota. Use FMP server-side for full statements.)
  attempts: (symbol, key) => [[
    `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
  ]],
  toQuarters: ([earnings, income]) => {
    const byDate = new Map();
    for (const q of (earnings && earnings.quarterlyEarnings) || []) {
      if (!q || !q.fiscalDateEnding) continue;
      byDate.set(q.fiscalDateEnding, { date: q.fiscalDateEnding, eps: num(q.reportedEPS) });
    }
    for (const q of (income && income.quarterlyReports) || []) {
      if (!q || !q.fiscalDateEnding) continue;
      const row = byDate.get(q.fiscalDateEnding) || { date: q.fiscalDateEnding };
      row.revenue = num(q.totalRevenue);
      row.netIncome = num(q.netIncome);
      byDate.set(q.fiscalDateEnding, row);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
};

// ---- Finnhub: free tier exposes quarterly EPS actuals via /stock/earnings ----
// (revenue/net-income quarterly need a higher tier, so they stay null here.)
export const finnhub = {
  needsKey: true,
  attempts: (symbol, key) => [[
    `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&limit=16&token=${encodeURIComponent(key)}`,
  ]],
  toQuarters: ([earnings]) => {
    if (!Array.isArray(earnings)) return [];
    return earnings
      .map((e) => ({ date: e && e.period, eps: num(e && e.actual), revenue: null, netIncome: null }))
      .filter((q) => q.date && q.eps != null)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
};

// ---- indianapi.in (India): /historical_stats quarter_results -> quarterly EPS/Sales/Net Profit ----
const IN_MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function parseInQuarterLabel(label) { // "Jun 2024" -> "2024-06-01"
  const m = String(label).trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m || !IN_MONTHS[m[1]]) return null;
  return `${m[2]}-${IN_MONTHS[m[1]]}-01`;
}
export const indianapi = {
  needsKey: true,
  attempts: (symbol, key) => {
    const base = String(symbol || '').toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
    return [[{
      url: `https://stock.indianapi.in/historical_stats?stock_name=${encodeURIComponent(base)}&stats=quarter_results`,
      headers: { 'X-Api-Key': key },
    }]];
  },
  toQuarters: ([data]) => {
    if (!data || typeof data !== 'object') return [];
    const epsKey = Object.keys(data).find((k) => /eps/i.test(k));
    const epsMap = epsKey ? data[epsKey] : null;
    if (!epsMap || typeof epsMap !== 'object') return [];
    const sales = data.Sales || {};
    const profit = data['Net Profit'] || {};
    const out = [];
    for (const [label, eps] of Object.entries(epsMap)) {
      const date = parseInQuarterLabel(label);
      if (!date) continue;
      out.push({ date, eps: num(eps), revenue: num(sales[label]), netIncome: num(profit[label]) });
    }
    return out.filter((q) => q.eps != null).sort((a, b) => a.date.localeCompare(b.date));
  },
};

export const ADAPTERS = { fmp, alphavantage, finnhub, indianapi };

/**
 * Wrap normalized quarters back into the Yahoo timeseries JSON shape that
 * engine.parseYahooFundamentals already consumes — so engine.js is untouched.
 */
export function quartersToYahooJson(quarters) {
  const series = (type, field) => ({
    meta: { type: [type] },
    [type]: (quarters || []).filter((q) => q[field] != null).map((q) => ({ asOfDate: q.date, reportedValue: { raw: q[field] } })),
  });
  return {
    timeseries: {
      result: [
        series('quarterlyDilutedEPS', 'eps'),
        series('quarterlyTotalRevenue', 'revenue'),
        series('quarterlyNetIncome', 'netIncome'),
      ],
    },
  };
}
