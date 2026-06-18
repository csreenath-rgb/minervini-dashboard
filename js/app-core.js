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

/**
 * Milliseconds from `now` until the next scheduled check slot.
 * Slots are [hourUTC, minuteUTC] pairs; only weekdays (Mon-Fri) count, so the
 * in-browser auto-check fires at the SAME times as the server email job.
 * @param {Date} now
 * @param {Array<[number, number]>} slots
 * @returns {number}
 */
export function msUntilNextSlot(now, slots) {
  const mins = slots.map(([h, m]) => h * 60 + m).sort((a, b) => a - b);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip Saturday/Sunday
    for (const total of mins) {
      const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        Math.floor(total / 60), total % 60, 0, 0);
      if (slot > now.getTime()) return slot - now.getTime();
    }
  }
  return 24 * 60 * 60 * 1000; // safety fallback
}

// ---------- named watchlist collections (v3) ----------
// A collection holds many named lists plus which one is active:
//   { version:3, activeName, lists:[ { name, items:[{symbol,entryPrice?}], subscribers:[email] } ] }

export function emptyCollection() {
  return { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [], subscribers: [] }] };
}

/**
 * Build a v3 collection from whatever is in storage.
 * @param {any} parsedNew  parsed value of the v3 collection key (or null)
 * @param {any} parsedLegacy parsed value of the old single-list array key (or null)
 */
export function migrateCollection(parsedNew, parsedLegacy) {
  if (parsedNew && Array.isArray(parsedNew.lists) && parsedNew.lists.length) {
    const lists = parsedNew.lists.map((l) => {
      const out = {
        name: String(l && l.name != null ? l.name : 'Default'),
        items: Array.isArray(l && l.items) ? l.items : [],
        subscribers: Array.isArray(l && l.subscribers) ? l.subscribers : [],
      };
      if (l && l.schedule) out.schedule = l.schedule; // preserve per-list schedule
      return out;
    });
    const activeName = lists.some((l) => l.name === parsedNew.activeName)
      ? parsedNew.activeName : lists[0].name;
    return { version: 3, activeName, lists };
  }
  if (Array.isArray(parsedLegacy) && parsedLegacy.length) {
    return { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: parsedLegacy, subscribers: [] }] };
  }
  return emptyCollection();
}

export function listNames(col) {
  return col.lists.map((l) => l.name);
}

export function getActiveList(col) {
  return col.lists.find((l) => l.name === col.activeName) || col.lists[0];
}

export function getActiveItems(col) {
  return getActiveList(col).items;
}

export function setActiveItems(col, items) {
  const active = getActiveList(col).name;
  return { ...col, lists: col.lists.map((l) => (l.name === active ? { ...l, items } : l)) };
}

/**
 * A list name is valid when it is non-blank and not a case-insensitive duplicate
 * of another list (excludeName lets a list keep its own name during rename).
 */
export function isValidListName(col, name, excludeName = null) {
  const n = String(name || '').trim();
  if (!n) return false;
  return !col.lists.some((l) => l.name.toLowerCase() === n.toLowerCase() && l.name !== excludeName);
}

export function createWatchlist(col, name) {
  const n = String(name || '').trim();
  if (!isValidListName(col, n)) return col;
  return { ...col, activeName: n, lists: [...col.lists, { name: n, items: [], subscribers: [] }] };
}

export function setActiveWatchlist(col, name) {
  return col.lists.some((l) => l.name === name) ? { ...col, activeName: name } : col;
}

export function renameWatchlist(col, oldName, newName) {
  const n = String(newName || '').trim();
  if (!col.lists.some((l) => l.name === oldName)) return col;
  if (!isValidListName(col, n, oldName)) return col;
  return {
    ...col,
    activeName: col.activeName === oldName ? n : col.activeName,
    lists: col.lists.map((l) => (l.name === oldName ? { ...l, name: n } : l)),
  };
}

export function deleteWatchlist(col, name) {
  if (col.lists.length <= 1) return col; // never delete the last list
  if (!col.lists.some((l) => l.name === name)) return col;
  const lists = col.lists.filter((l) => l.name !== name);
  const activeName = col.activeName === name ? lists[0].name : col.activeName;
  return { ...col, activeName, lists };
}

// ---------- subscribers (mailing lists per watchlist) ----------
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function mapList(col, listName, fn) {
  if (!col.lists.some((l) => l.name === listName)) return col;
  return { ...col, lists: col.lists.map((l) => (l.name === listName ? fn(l) : l)) };
}

export function addSubscriber(col, listName, email) {
  const e = String(email || '').trim();
  if (!isValidEmail(e)) return col;
  return mapList(col, listName, (l) => {
    if (l.subscribers.some((s) => s.toLowerCase() === e.toLowerCase())) return l; // dedupe
    return { ...l, subscribers: [...l.subscribers, e] };
  });
}

export function removeSubscriber(col, listName, email) {
  const e = String(email || '').trim().toLowerCase();
  return mapList(col, listName, (l) => ({
    ...l, subscribers: l.subscribers.filter((s) => s.toLowerCase() !== e),
  }));
}

export function updateSubscriber(col, listName, oldEmail, newEmail) {
  const n = String(newEmail || '').trim();
  if (!isValidEmail(n)) return col;
  const oldLc = String(oldEmail || '').trim().toLowerCase();
  return mapList(col, listName, (l) => {
    if (!l.subscribers.some((s) => s.toLowerCase() === oldLc)) return l;
    if (l.subscribers.some((s) => s.toLowerCase() === n.toLowerCase() && s.toLowerCase() !== oldLc)) return l; // dup
    return { ...l, subscribers: l.subscribers.map((s) => (s.toLowerCase() === oldLc ? n : s)) };
  });
}

/** Public, committable form: list names + symbols only, NO email addresses. */
export function exportPublicWatchlist(col) {
  return {
    version: 3, activeName: col.activeName,
    lists: col.lists.map((l) => ({ name: l.name, items: l.items, schedule: getListSchedule(l) })),
  };
}

/** Private form for the Actions secret: { listName: [emails] }, empty lists omitted. */
export function exportMailingLists(col) {
  const out = {};
  for (const l of col.lists) if (l.subscribers.length) out[l.name] = [...l.subscribers];
  return out;
}

// ---------- per-list check schedule ----------
// Email runs on a fixed menu of preset daily slots (UTC) because GitHub Actions
// cron is coarse/best-effort. The dashboard honors schedules faithfully in-browser.
export const PRESET_SLOTS = ['13:45', '16:45', '19:45'];      // UTC; ~9:45/12:45/15:45 ET (EDT)
export const DEFAULT_EMAIL_SLOTS = ['13:45', '19:45'];        // current twice-daily default

export function parseSlot(s) {
  const [h, m] = String(s).split(':').map(Number);
  return [h, m];
}

/** Coerce any stored schedule into a valid one; fall back to { mode:'default' }. */
export function normalizeSchedule(s) {
  if (!s || typeof s !== 'object') return { mode: 'default' };
  if (s.mode === 'interval') {
    const n = Number(s.intervalMinutes);
    return (Number.isFinite(n) && n >= 5) ? { mode: 'interval', intervalMinutes: Math.round(n) } : { mode: 'default' };
  }
  if (s.mode === 'times') {
    const times = Array.isArray(s.times) ? [...new Set(s.times.filter((t) => PRESET_SLOTS.includes(t)))].sort() : [];
    return times.length ? { mode: 'times', times } : { mode: 'default' };
  }
  return { mode: 'default' };
}

export function getListSchedule(list) {
  return normalizeSchedule(list && list.schedule);
}

/** Set a list's schedule (validated). Invalid schedules are a no-op. */
export function setListSchedule(col, listName, schedule) {
  if (!schedule || typeof schedule !== 'object') return col;
  let norm;
  if (schedule.mode === 'default') norm = { mode: 'default' };
  else if (schedule.mode === 'interval') {
    const n = Number(schedule.intervalMinutes);
    if (!Number.isFinite(n) || n < 5) return col;
    norm = { mode: 'interval', intervalMinutes: Math.round(n) };
  } else if (schedule.mode === 'times') {
    const times = Array.isArray(schedule.times) ? [...new Set(schedule.times.filter((t) => PRESET_SLOTS.includes(t)))].sort() : [];
    if (!times.length) return col;
    norm = { mode: 'times', times };
  } else return col;
  return mapList(col, listName, (l) => ({ ...l, schedule: norm }));
}

/** Preset slots at which this list should be emailed. */
export function slotsForEmail(schedule) {
  const s = normalizeSchedule(schedule);
  return s.mode === 'times' ? [...s.times] : [...DEFAULT_EMAIL_SLOTS]; // default + interval -> two default slots
}

export function isListDueAtSlot(schedule, slot) {
  return slotsForEmail(schedule).includes(slot);
}

/** Milliseconds until this list's next in-browser check. */
export function nextDashboardCheckMs(schedule, now) {
  const s = normalizeSchedule(schedule);
  if (s.mode === 'interval') return s.intervalMinutes * 60000;
  const slots = (s.mode === 'times' ? s.times : DEFAULT_EMAIL_SLOTS).map(parseSlot);
  return msUntilNextSlot(now, slots);
}

// ---------- markets (US / India) ----------
export const MARKETS = {
  US: { id: 'US', label: 'US', benchmark: '^GSPC', benchmarkName: 'S&P 500', currency: '$', suffix: '' },
  IN: { id: 'IN', label: 'India', benchmark: '^NSEI', benchmarkName: 'NIFTY 50', currency: '₹', suffix: '.NS' },
};
export const DEFAULT_MARKET = 'US';

export function normalizeMarket(m) {
  return MARKETS[m] ? m : DEFAULT_MARKET;
}

/**
 * Normalize a user-typed ticker for a market. India: bare NSE symbols get a
 * `.NS` suffix; indices (^...) and already-suffixed (.NS/.BO) are left as-is.
 */
export function normalizeTicker(market, raw) {
  let s = String(raw || '').toUpperCase().trim();
  if (!s) return '';
  if (normalizeMarket(market) === 'IN' && !s.startsWith('^') && !s.includes('.')) s += '.NS';
  return s;
}
