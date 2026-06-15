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

export const FUNDAMENTALS_PROVIDERS = ['yahoo', 'finnhub', 'fmp', 'alphavantage'];

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
  attempts: (symbol, key) => [[
    `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
    `https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
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
    `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
  ]],
  toQuarters: ([earnings]) => {
    if (!Array.isArray(earnings)) return [];
    return earnings
      .map((e) => ({ date: e && e.period, eps: num(e && e.actual), revenue: null, netIncome: null }))
      .filter((q) => q.date && q.eps != null)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
};

export const ADAPTERS = { fmp, alphavantage, finnhub };

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
