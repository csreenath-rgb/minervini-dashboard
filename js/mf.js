/**
 * Indian mutual fund helpers (pure). Data comes from mfapi.in (no key): daily NAV
 * history only — there is no OHLC/volume, so this powers an INFORMATIONAL view
 * (NAV trend, moving averages, trailing returns), never SEPA entry/exit signals.
 */
const round2 = (x) => Math.round(x * 100) / 100;

function toIso(ddmmyyyy) {
  const m = String(ddmmyyyy).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** mfapi.in /mf/{code} JSON -> { meta, navs:[{date:'YYYY-MM-DD', nav:number}] ascending }. */
export function parseMfNavHistory(json) {
  const meta = (json && json.meta) || {};
  const rows = Array.isArray(json && json.data) ? json.data : [];
  const navs = rows
    .map((r) => ({ date: toIso(r && r.date), nav: Number(r && r.nav) }))
    .filter((x) => x.date && Number.isFinite(x.nav))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { meta, navs };
}

function navAtOrBefore(navs, isoDate) {
  for (let i = navs.length - 1; i >= 0; i--) if (navs[i].date <= isoDate) return navs[i];
  return null;
}
function monthsAgoIso(now, months) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Trailing returns (%) vs the nearest-prior NAV at each horizon; null when unavailable. */
export function mfReturns(navs, now = new Date()) {
  const out = { '1m': null, '3m': null, '6m': null, '1y': null, '3y': null, '5y': null };
  if (!navs || !navs.length) return out;
  const latest = navs[navs.length - 1];
  const H = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60 };
  for (const [k, months] of Object.entries(H)) {
    const past = navAtOrBefore(navs, monthsAgoIso(now, months));
    out[k] = (past && past.nav) ? round2(((latest.nav - past.nav) / past.nav) * 100) : null;
  }
  return out;
}

function ma(navs, period) {
  if (!navs || navs.length < period) return null;
  const slice = navs.slice(-period);
  return round2(slice.reduce((a, b) => a + b.nav, 0) / period);
}

/** Latest NAV + 50/200-day MA position. */
export function mfSummary(navs) {
  if (!navs || !navs.length) {
    return { latestNav: null, latestDate: null, ma50: null, ma200: null, navAbove50: null, navAbove200: null };
  }
  const latest = navs[navs.length - 1];
  const ma50 = ma(navs, 50);
  const ma200 = ma(navs, 200);
  return {
    latestNav: latest.nav, latestDate: latest.date, ma50, ma200,
    navAbove50: ma50 == null ? null : latest.nav >= ma50,
    navAbove200: ma200 == null ? null : latest.nav >= ma200,
  };
}
