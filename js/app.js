/**
 * Dashboard application: wires the analysis engine and data layer to the DOM.
 * initApp() is dependency-injected (document, storage, fetch, notify) so the
 * full flow is testable headlessly; in a real browser it auto-initializes.
 */
import { analyzeTicker } from './engine.js';
import { fetchTickerBundle, fetchProviderFundamentals } from './data.js';
import { BROWSER_OK } from './providers.js';
import {
  addToWatchlist, removeFromWatchlist, deriveAlerts, alertKey,
  filterNewAlerts, verdictBadge,
  getListSchedule, setListSchedule, nextDashboardCheckMs,
  migrateCollection, getActiveItems, setActiveItems, getActiveList, listNames,
  createWatchlist, setActiveWatchlist, renameWatchlist, deleteWatchlist,
  addSubscriber, removeSubscriber, updateSubscriber, isValidEmail,
  exportPublicWatchlist, exportMailingLists,
} from './app-core.js';

const WATCHLIST_KEY = 'minervini_watchlist';        // legacy single-list key (read once for migration)
const COLLECTION_KEY = 'minervini_watchlists';      // v3 named-collection key
const FUND_KEY = 'minervini_fundamentals';          // { provider, key } for fundamentals
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * @param {{document: Document, storage: Storage, fetchImpl?: typeof fetch,
 *          notify?: (title: string, body: string) => void, autoRefreshMs?: number}} deps
 */
export function initApp({ document: doc, storage, fetchImpl, notify, autoRefreshMs = 0, autoSchedule = false }) {
  const $ = (id) => doc.getElementById(id);
  const state = {
    lastReport: null,
    seenAlertKeys: new Set(),
    chart: null,
    lastStatuses: {}, // per-list cache of latest {symbol: {price, entryVerdict, exitVerdict}} so verdicts persist across re-renders
  };
  const winObj = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const setTimer = (winObj && winObj.setTimeout) ? winObj.setTimeout.bind(winObj) : setTimeout;
  const clearTimer = (winObj && winObj.clearTimeout) ? winObj.clearTimeout.bind(winObj) : clearTimeout;
  const timers = new Map(); // per-list dashboard check timers

  // ---------- watchlist collection persistence ----------
  function getCollection() {
    let parsedNew = null;
    try { parsedNew = JSON.parse(storage.getItem(COLLECTION_KEY)); } catch { parsedNew = null; }
    let parsedLegacy = null;
    if (!parsedNew) { try { parsedLegacy = JSON.parse(storage.getItem(WATCHLIST_KEY)); } catch { parsedLegacy = null; } }
    return migrateCollection(parsedNew, parsedLegacy);
  }
  function saveCollection(col) {
    storage.setItem(COLLECTION_KEY, JSON.stringify(col));
    renderAll(col);
    if (autoSchedule) scheduleAllLists();
  }
  function renderAll(col) {
    renderListSelector(col);
    renderSubscribers(col);
    renderSchedule(col);
    renderWatchlist(getActiveItems(col), state.lastStatuses[getActiveList(col).name] || {});
  }
  // The "active list" is what the rest of the app reads/writes, so the existing
  // analyze / add / remove flows keep working unchanged on the selected list.
  function getWatchlist() { return getActiveItems(getCollection()); }
  function saveWatchlist(list) { saveCollection(setActiveItems(getCollection(), list)); }

  // ---------- named-list actions ----------
  function newWatchlist(name) { saveCollection(createWatchlist(getCollection(), name)); }
  function selectWatchlist(name) { saveCollection(setActiveWatchlist(getCollection(), name)); }
  function renameActiveWatchlist(newName) {
    const col = getCollection();
    saveCollection(renameWatchlist(col, getActiveList(col).name, newName));
  }
  function deleteActiveWatchlist() {
    const col = getCollection();
    saveCollection(deleteWatchlist(col, getActiveList(col).name));
  }
  // ---------- subscriber actions (operate on the active list) ----------
  function addSubscriberToActive(email) {
    const col = getCollection();
    saveCollection(addSubscriber(col, getActiveList(col).name, email));
  }
  function removeSubscriberFromActive(email) {
    const col = getCollection();
    saveCollection(removeSubscriber(col, getActiveList(col).name, email));
  }
  function updateSubscriberOnActive(oldEmail, newEmail) {
    const col = getCollection();
    saveCollection(updateSubscriber(col, getActiveList(col).name, oldEmail, newEmail));
  }
  function setScheduleOnActive(schedule) {
    const col = getCollection();
    saveCollection(setListSchedule(col, getActiveList(col).name, schedule));
  }
  // ---------- fundamentals data provider ----------
  const PROVIDER_LABELS = { yahoo: 'Yahoo (free)', finnhub: 'Finnhub', fmp: 'Financial Modeling Prep', alphavantage: 'Alpha Vantage' };
  // Store shape: { active: 'yahoo'|'finnhub'|'fmp'|'alphavantage', keys: { provider: key } }.
  // ALL provider keys are retained; `active` selects which one analysis uses.
  function getFundamentalsStore() {
    try {
      const s = JSON.parse(storage.getItem(FUND_KEY));
      if (s && s.keys) return { active: s.active || 'yahoo', keys: { ...s.keys } };
      if (s && s.provider) { // migrate legacy { provider, key }
        return { active: s.provider, keys: (s.provider !== 'yahoo' && s.key) ? { [s.provider]: s.key } : {} };
      }
    } catch { /* ignore */ }
    return { active: 'yahoo', keys: {} };
  }
  function saveFundamentalsStore(store) { storage.setItem(FUND_KEY, JSON.stringify(store)); renderFundamentalsConfig(); }
  function getFundamentalsConfig() {
    const s = getFundamentalsStore();
    return s.active === 'yahoo' ? { provider: 'yahoo' } : { provider: s.active, key: s.keys[s.active] };
  }
  // What the BROWSER should use: the active provider if it works in a browser and has a
  // key; otherwise the best saved browser-compatible provider; otherwise Yahoo. (FMP is
  // browser-blocked on free, so it's skipped here and used only by the server email job.)
  const BROWSER_PROVIDER_PREFERENCE = ['alphavantage', 'finnhub'];
  function resolveBrowserConfig() {
    const s = getFundamentalsStore();
    const active = s.active || 'yahoo';
    if (active === 'yahoo') return { provider: 'yahoo' };
    if (BROWSER_OK[active] && s.keys[active]) return { provider: active, key: s.keys[active] };
    for (const p of BROWSER_PROVIDER_PREFERENCE) {
      if (BROWSER_OK[p] && s.keys[p]) return { provider: p, key: s.keys[p] };
    }
    return { provider: 'yahoo' };
  }
  function saveProviderKey(provider, key) {
    const s = getFundamentalsStore();
    if (provider === 'yahoo') { s.active = 'yahoo'; }
    else { if (key) s.keys[provider] = key; s.active = provider; }
    saveFundamentalsStore(s);
  }
  // back-compat / test helper: set active provider and optionally its key (keys retained)
  function setFundamentalsConfig(cfg) {
    const provider = (cfg && cfg.provider) || 'yahoo';
    saveProviderKey(provider, cfg && cfg.key);
  }
  async function testFundamentals() {
    // Test the provider currently SELECTED in the form (not just the saved one),
    // using the key in the field or the saved key for that provider.
    const store = getFundamentalsStore();
    const provider = ($('fund-provider') && $('fund-provider').value) || store.active || 'yahoo';
    const key = ((($('fund-key') && $('fund-key').value) || '').trim()) || store.keys[provider] || '';
    const label = PROVIDER_LABELS[provider] || provider;
    const status = $('fund-status');
    if (provider === 'yahoo' || !key) { if (status) status.textContent = 'Choose a provider and enter its key first.'; return; }
    if (status) status.textContent = `Testing ${label}…`;
    try {
      const { quarters } = await fetchProviderFundamentals('AAPL', { provider, key }, { fetchImpl });
      if (status) {
        status.textContent = quarters.length >= 5
          ? `✓ Key works — ${label} returned ${quarters.length} quarters for AAPL.`
          : `⚠ ${label} responded but returned only ${quarters.length} quarter(s) for AAPL (need 5+ for year-over-year growth) — analysis falls back to Yahoo.`;
      }
      return quarters.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let hint = ' Analysis falls back to Yahoo.';
      if (/\b40[23]\b/.test(msg)) hint = ' That status means this provider\'s free plan does not allow this data from a browser — it still works server-side in the scheduled email job (set it as the FUNDAMENTALS_PROVIDER / FUNDAMENTALS_API_KEY secrets). Analysis falls back to Yahoo.';
      else if (/Failed to fetch|NetworkError|CORS/i.test(msg)) hint = ' The provider is blocking browser (CORS) requests; use it in the email job instead. Analysis falls back to Yahoo.';
      if (status) status.textContent = `✗ ${label} request failed (${msg}).${hint}`;
      return 0;
    }
  }
  function renderFundamentalsConfig() {
    const sel = $('fund-provider'); if (!sel) return;
    const s = getFundamentalsStore();
    sel.value = s.active;
    const keyEl = $('fund-key');
    if (keyEl) { keyEl.value = s.active === 'yahoo' ? '' : (s.keys[s.active] || ''); keyEl.disabled = s.active === 'yahoo'; }
    const status = $('fund-status');
    if (status) {
      const browser = resolveBrowserConfig();
      const saved = Object.keys(s.keys).filter((k) => s.keys[k]);
      const savedNote = saved.length ? ` Saved keys: ${saved.map((k) => PROVIDER_LABELS[k] || k).join(', ')}.` : '';
      const needKeyNote = (browser.provider === 'yahoo' && s.active !== 'yahoo')
        ? ' Add an Alpha Vantage or Finnhub key for richer live fundamentals.' : '';
      const fmpNote = s.keys.fmp
        ? ' FMP is browser-restricted on its free plan, so it powers the scheduled email job (server-side), not the live page.' : '';
      status.textContent = `Live dashboard uses ${PROVIDER_LABELS[browser.provider] || browser.provider}.${needKeyNote}${fmpNote}${savedNote}`;
    }
  }

  // ---------- rendering ----------
  function renderVerdict(el, verdict, reasons, extra = '') {
    const b = verdictBadge(verdict);
    el.innerHTML = `<span class="badge ${b.cls}">${esc(b.label)}</span>` +
      `<div class="reasons">${(reasons || []).map((r) => `<p>${esc(r)}</p>`).join('')}${extra}</div>`;
  }

  function renderTrendTemplate(tt) {
    $('trend-template').innerHTML = tt.criteria.map((c) =>
      `<div class="tt-row ${c.pass ? 'pass' : 'fail'}">
        <span class="tt-icon">${c.pass ? '✔' : '✘'}</span>
        <span class="tt-label">${esc(c.label)}</span>
        <span class="tt-detail">${esc(c.detail)}</span>
      </div>`).join('') +
      `<div class="tt-summary ${tt.passed ? 'pass' : 'fail'}">Trend Template: ${tt.passed ? 'PASSED (Stage-2 uptrend)' : 'FAILED — not a Minervini buy candidate'}</div>`;
  }

  function renderFundamentals(f) {
    const el = $('fundamentals');
    if (!f.available) {
      el.innerHTML = `<p class="muted">${esc((f.reasons || ['No fundamental data']).join(' '))}</p>`;
      return;
    }
    el.innerHTML =
      `<div class="tt-row ${f.pass ? 'pass' : 'fail'}"><span class="tt-icon">${f.pass ? '✔' : '✘'}</span>
       <span class="tt-label">Minervini earnings check (EPS growth ≥20–25% and accelerating)</span></div>` +
      (f.reasons || []).map((r) => `<p>${esc(r)}</p>`).join('') +
      (f.epsGrowthYoY?.length ? `<p class="muted">Quarterly EPS growth YoY (oldest→latest): ${f.epsGrowthYoY.map((x) => `${x}%`).join(', ')}</p>` : '');
  }

  function renderLevels(r) {
    const el = $('levels');
    if (!el) return;
    const fmt = (x) => (x == null ? '—' : Number(x).toFixed(2));
    const rows = [
      ['Current price', fmt(r.price)],
      ['Pivot (buy point)', fmt(r.levels.pivot)],
      ['Buy zone', r.entry.buyZone ? `${fmt(r.entry.buyZone[0])} – ${fmt(r.entry.buyZone[1])}` : '—'],
      ['Stop-loss', fmt(r.levels.stop)],
      ['50-day MA', fmt(r.levels.sma50)],
      ['150-day MA', fmt(r.levels.sma150)],
      ['200-day MA', fmt(r.levels.sma200)],
      ['52-week high', fmt(r.levels.high52w)],
      ['52-week low', fmt(r.levels.low52w)],
    ];
    el.innerHTML = rows.map(([k, v]) => `<div class="lvl"><span>${k}</span><strong>${v}</strong></div>`).join('');
  }

  function renderChart(r) {
    const ChartLib = (typeof globalThis !== 'undefined' && globalThis.Chart) || null;
    const canvas = $('price-chart');
    if (!ChartLib || !canvas || typeof canvas.getContext !== 'function') return; // headless/test env
    const candles = r.candles.slice(-250);
    const labels = candles.map((c) => c.date.toISOString().slice(0, 10));
    const closes = candles.map((c) => c.close);
    const smaSeries = (period) => {
      const all = r.candles.map((c) => c.close);
      const out = [];
      for (let i = all.length - candles.length; i < all.length; i++) {
        const slice = all.slice(Math.max(0, i - period + 1), i + 1);
        out.push(slice.length === period ? slice.reduce((a, b) => a + b, 0) / period : null);
      }
      return out;
    };
    const hline = (v) => (v == null ? null : candles.map(() => v));
    if (state.chart) state.chart.destroy();
    state.chart = new ChartLib(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Close', data: closes, borderColor: '#4dabf7', borderWidth: 2, pointRadius: 0 },
          { label: '50d MA', data: smaSeries(50), borderColor: '#ffd43b', borderWidth: 1, pointRadius: 0 },
          { label: '150d MA', data: smaSeries(150), borderColor: '#ff922b', borderWidth: 1, pointRadius: 0 },
          { label: '200d MA', data: smaSeries(200), borderColor: '#f06595', borderWidth: 1, pointRadius: 0 },
          { label: 'Pivot', data: hline(r.levels.pivot), borderColor: '#51cf66', borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
          { label: 'Stop', data: hline(r.levels.stop), borderColor: '#fa5252', borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
        ].filter((d) => d.data != null),
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { x: { ticks: { maxTicksLimit: 10, color: '#8b949e' }, grid: { color: '#21262d' } },
                  y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } },
        plugins: { legend: { labels: { color: '#c9d1d9' } } },
      },
    });
  }

  const revealAlertsToolbar = () => { const t = $('alerts-toolbar'); if (t) t.style.display = 'flex'; };

  function clearAlerts() {
    const el = $('alerts');
    if (el) el.innerHTML = '';
    state.seenAlertKeys = new Set(); // reset dedupe so still-valid triggers can re-fire
    const t = $('alerts-toolbar'); if (t) t.style.display = 'none';
  }

  function showAlerts(alerts, { notifyUser = false } = {}) {
    const el = $('alerts');
    if (alerts.length === 0) return;
    revealAlertsToolbar();
    const html = alerts.map((a) =>
      `<div class="alert ${a.type === 'ENTRY' ? 'good' : a.type === 'EXIT' ? 'bad' : 'warn'}">
        <strong>[${esc(a.type)}] ${esc(a.symbol)}</strong>${a.watchlist ? ` <span class="muted">(${esc(a.watchlist)})</span>` : ''} @ ${a.price.toFixed(2)} — ${esc(a.message)}
      </div>`).join('');
    el.innerHTML = html + el.innerHTML;
    if (notifyUser && notify) {
      for (const a of alerts) notify(`${a.type}: ${a.symbol}`, a.message);
    }
  }

  function showError(message) {
    revealAlertsToolbar();
    $('alerts').innerHTML =
      `<div class="alert bad"><strong>Error:</strong> ${esc(message)}</div>` + $('alerts').innerHTML;
  }

  function renderListSelector(col) {
    const sel = $('watchlist-select');
    if (!sel) return;
    sel.innerHTML = listNames(col).map((n) =>
      `<option value="${esc(n)}"${n === col.activeName ? ' selected' : ''}>${esc(n)}</option>`).join('');
    sel.value = col.activeName;
  }

  function renderSubscribers(col) {
    const el = $('subscribers');
    if (!el) return;
    const subs = getActiveList(col).subscribers;
    if (!subs.length) {
      el.innerHTML = '<p class="muted">No subscribers yet. Alerts for this list go to the dashboard owner.</p>';
      return;
    }
    el.innerHTML = subs.map((e) =>
      `<div class="watch-row"><strong>${esc(e)}</strong>
        <button class="remove-sub" data-email="${esc(e)}">✕</button></div>`).join('');
    for (const btn of el.querySelectorAll('.remove-sub')) {
      btn.addEventListener('click', () => api.removeSubscriberFromActive(btn.getAttribute('data-email')));
    }
  }

  function describeSchedule(s) {
    if (s.mode === 'interval') return `Every ${s.intervalMinutes} minutes while the dashboard is open. Email alerts use the two default daily slots (13:45 & 19:45 UTC).`;
    if (s.mode === 'times') return `At ${s.times.join(', ')} UTC, on the dashboard and by email.`;
    return 'Twice each trading day (default): 13:45 & 19:45 UTC (~9:45am & 3:45pm ET).';
  }

  function renderSchedule(col) {
    const modeEl = $('schedule-mode');
    if (!modeEl) return;
    const s = getListSchedule(getActiveList(col));
    modeEl.value = s.mode;
    const iv = $('schedule-interval');
    if (iv && s.mode === 'interval') iv.value = s.intervalMinutes;
    for (const box of doc.querySelectorAll('.schedule-time')) {
      box.checked = s.mode === 'times' && s.times.includes(box.value);
    }
    const ig = $('schedule-interval-group'); if (ig) ig.style.display = s.mode === 'interval' ? 'inline' : 'none';
    const tg = $('schedule-times-group'); if (tg) tg.style.display = s.mode === 'times' ? 'inline' : 'none';
    const sum = $('schedule-summary'); if (sum) sum.textContent = describeSchedule(s);
  }

  function renderWatchlist(list, statuses = {}) {
    const el = $('watchlist');
    if (list.length === 0) {
      el.innerHTML = '<p class="muted">Watchlist is empty. Analyze a ticker, then add it.</p>';
      return;
    }
    el.innerHTML = list.map((item) => {
      const st = statuses[item.symbol];
      const stHtml = st
        ? `<span class="badge ${verdictBadge(st.entryVerdict).cls}">${esc(st.entryVerdict)}</span>
           <span class="badge ${verdictBadge(st.exitVerdict).cls}">${esc(st.exitVerdict)}</span>
           <span class="muted">@${st.price.toFixed(2)}</span>`
        : '<span class="muted">not checked yet</span>';
      return `<div class="watch-row" data-symbol="${esc(item.symbol)}">
        <button class="link-symbol" data-symbol="${esc(item.symbol)}"${item.entryPrice != null ? ` data-entry="${esc(String(item.entryPrice))}"` : ''} title="Analyze ${esc(item.symbol)}">${esc(item.symbol)}</button>
        ${item.entryPrice != null ? `<span class="muted">entry ${Number(item.entryPrice).toFixed(2)}</span>` : ''}
        ${stHtml}
        <button class="remove-watch" data-symbol="${esc(item.symbol)}">✕</button>
      </div>`;
    }).join('');
    for (const b of el.querySelectorAll('.link-symbol')) {
      b.addEventListener('click', () => {
        const ep = b.getAttribute('data-entry');
        api.analyzeSymbol(b.getAttribute('data-symbol'), ep != null ? parseFloat(ep) : undefined);
      });
    }
    for (const btn of el.querySelectorAll('.remove-watch')) {
      btn.addEventListener('click', () => api.removeWatch(btn.getAttribute('data-symbol')));
    }
  }

  // ---------- actions ----------
  async function analyze() {
    const symbol = ($('ticker-input').value || '').toUpperCase().trim();
    if (!symbol) return null;
    const btn = $('analyze-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
    try {
      const entryPriceRaw = $('entry-price-input') ? parseFloat($('entry-price-input').value) : NaN;
      const bundle = await fetchTickerBundle(symbol, { fetchImpl, fundamentals: screenFundamentalsConfig() });
      const report = analyzeTicker({
        chartJson: bundle.chartJson, benchJson: bundle.benchJson, fundJson: bundle.fundJson,
        entryPrice: isFinite(entryPriceRaw) && entryPriceRaw > 0 ? entryPriceRaw : null,
      });
      state.lastReport = report;
      const title = $('report-title');
      if (title) title.textContent = `${report.symbol} — ${report.isEtf ? 'ETF' : 'Stock'} @ ${report.price.toFixed(2)}`;
      renderVerdict($('verdict-entry'), report.entry.verdict, report.entry.reasons,
        report.entry.pivot ? `<p><strong>Pivot ${report.entry.pivot.toFixed(2)} · Buy zone ${report.entry.buyZone[0].toFixed(2)}–${report.entry.buyZone[1].toFixed(2)} · Stop ${report.entry.stop.toFixed(2)}</strong></p>` : '');
      renderVerdict($('verdict-exit'), report.exit.verdict, report.exit.reasons,
        `<p><strong>Stop-loss: ${report.exit.stop.toFixed(2)}</strong>${report.exit.gainPct != null ? ` · Gain: ${report.exit.gainPct}%` : ''}</p>`);
      renderTrendTemplate(report.trendTemplate);
      renderFundamentals(report.fundamentals);
      renderLevels(report);
      renderChart(report);
      return report;
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Analyze'; }
    }
  }

  async function analyzeSymbol(symbol, entryPrice) {
    const ti = $('ticker-input'); if (ti) ti.value = String(symbol || '').toUpperCase();
    const ep = $('entry-price-input'); if (ep) ep.value = (entryPrice != null && isFinite(entryPrice)) ? String(entryPrice) : '';
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.scrollTo === 'function') { try { win.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* jsdom */ } }
    return analyze();
  }

  async function addCurrentToWatchlist() {
    const symbol = state.lastReport?.symbol || ($('ticker-input').value || '').toUpperCase().trim();
    if (!symbol) return;
    const entryPriceRaw = $('entry-price-input') ? parseFloat($('entry-price-input').value) : NaN;
    const entryPrice = isFinite(entryPriceRaw) && entryPriceRaw > 0 ? entryPriceRaw : undefined;
    saveWatchlist(addToWatchlist(getWatchlist(), { symbol, entryPrice }));
  }

  function removeWatch(symbol) {
    saveWatchlist(removeFromWatchlist(getWatchlist(), symbol));
  }

  function setWatchlist(list) {
    saveWatchlist(list);
  }

  function exportWatchlistJson() {
    return JSON.stringify(exportPublicWatchlist(getCollection()), null, 2);
  }
  function exportMailingListsJson() {
    return JSON.stringify(exportMailingLists(getCollection()), null, 2);
  }

  // Check one list's items, surface its alerts (deduped per list+symbol+type+day).
  async function checkListItems(listName, items, { notifyUser = true, fundamentals } = {}) {
    const statuses = {};
    const cfg = fundamentals || resolveBrowserConfig();
    const today = new Date().toISOString().slice(0, 10);
    for (const item of items) {
      try {
        const bundle = await fetchTickerBundle(item.symbol, { fetchImpl, fundamentals: cfg });
        const report = analyzeTicker({
          chartJson: bundle.chartJson, benchJson: bundle.benchJson, fundJson: bundle.fundJson,
          entryPrice: item.entryPrice ?? null,
        });
        statuses[item.symbol] = {
          price: report.price, entryVerdict: report.entry.verdict, exitVerdict: report.exit.verdict,
        };
        const tagged = deriveAlerts(report).map((al) => ({ ...al, watchlist: listName }));
        const fresh = tagged.filter((al) => !state.seenAlertKeys.has(`${listName}|${alertKey(al, today)}`));
        for (const al of fresh) state.seenAlertKeys.add(`${listName}|${alertKey(al, today)}`);
        showAlerts(fresh, { notifyUser });
      } catch (err) {
        statuses[item.symbol] = null;
        showError(`${listName ? `${listName}: ` : ''}${item.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Cache latest non-null verdicts so they survive re-renders (subscriber/schedule edits, list switches).
    const prev = state.lastStatuses[listName] || {};
    const merged = { ...prev };
    for (const [sym, st] of Object.entries(statuses)) if (st) merged[sym] = st;
    state.lastStatuses[listName] = merged;
    return statuses;
  }

  function stampChecked() {
    const stamp = $('last-refresh');
    if (stamp) stamp.textContent = `Watchlist last checked: ${new Date().toLocaleTimeString()}`;
  }

  // Fundamentals config from the PROVIDER CURRENTLY SELECTED ON SCREEN (dropdown + key field),
  // falling back to the saved browser resolution. Note: this only affects the Fundamentals section;
  // entry/exit verdicts come from live price/technical data regardless of provider.
  function screenFundamentalsConfig() {
    const sel = $('fund-provider');
    if (!sel) return resolveBrowserConfig();
    const provider = sel.value || 'yahoo';
    if (provider === 'yahoo') return { provider: 'yahoo' };
    const key = ((($('fund-key') && $('fund-key').value) || '').trim()) || getFundamentalsStore().keys[provider] || '';
    if (!BROWSER_OK[provider] || !key) return resolveBrowserConfig();
    return { provider, key };
  }

  // Live refresh of the ACTIVE list (button + programmatic). Uses the on-screen provider.
  async function refreshWatchlist() {
    const btn = $('refresh-btn');
    if (btn && !btn.dataset.label) btn.dataset.label = btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
      const active = getActiveList(getCollection());
      const statuses = await checkListItems(active.name, active.items, { notifyUser: true, fundamentals: screenFundamentalsConfig() });
      renderWatchlist(active.items, statuses);
      stampChecked();
      return statuses;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Refresh'; }
    }
  }

  // Scheduler entry point: check a specific list (may not be the active one).
  async function checkOneList(name) {
    const list = getCollection().lists.find((l) => l.name === name);
    if (!list) return {};
    const statuses = await checkListItems(name, list.items, { notifyUser: true });
    if (getActiveList(getCollection()).name === name) { renderWatchlist(list.items, statuses); stampChecked(); }
    return statuses;
  }

  // ---------- per-list scheduling (each list on its own cadence) ----------
  function scheduleList(name) {
    if (!autoSchedule) return;
    const old = timers.get(name);
    if (old) clearTimer(old);
    const list = getCollection().lists.find((l) => l.name === name);
    if (!list) { timers.delete(name); return; }
    const ms = nextDashboardCheckMs(getListSchedule(list), new Date());
    timers.set(name, setTimer(() => { checkOneList(name).finally(() => scheduleList(name)); }, ms));
  }
  function scheduleAllLists() {
    if (!autoSchedule) return;
    for (const id of timers.values()) clearTimer(id);
    timers.clear();
    for (const l of getCollection().lists) scheduleList(l.name);
  }

  // ---------- wiring ----------
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('analyze-btn', () => analyze());
  on('add-watch-btn', () => addCurrentToWatchlist());
  on('refresh-btn', () => refreshWatchlist());
  on('clear-alerts-btn', () => clearAlerts());
  on('copy-watchlist-btn', () => {
    const json = exportWatchlistJson();
    if (doc.defaultView?.navigator?.clipboard) doc.defaultView.navigator.clipboard.writeText(json);
    const out = $('watchlist-json');
    if (out) { out.value = json; out.style.display = 'block'; }
  });
  on('copy-mailing-btn', () => {
    const json = exportMailingListsJson();
    if (doc.defaultView?.navigator?.clipboard) doc.defaultView.navigator.clipboard.writeText(json);
    const out = $('mailing-json');
    if (out) { out.value = json; out.style.display = 'block'; }
  });
  const winOf = () => doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const selEl = $('watchlist-select');
  if (selEl) selEl.addEventListener('change', () => selectWatchlist(selEl.value));
  on('new-watchlist-btn', () => {
    const w = winOf(); const name = w && w.prompt ? w.prompt('Name for the new watchlist:') : null;
    if (name) newWatchlist(name);
  });
  on('rename-watchlist-btn', () => {
    const w = winOf(); const col = getCollection();
    const name = w && w.prompt ? w.prompt('Rename this watchlist:', getActiveList(col).name) : null;
    if (name) renameActiveWatchlist(name);
  });
  on('delete-watchlist-btn', () => {
    const w = winOf(); const col = getCollection();
    const ok = w && w.confirm ? w.confirm(`Delete watchlist "${getActiveList(col).name}"? Its subscribers are removed too.`) : true;
    if (ok) deleteActiveWatchlist();
  });
  on('add-subscriber-btn', () => {
    const inp = $('subscriber-input'); if (!inp) return;
    const email = (inp.value || '').trim();
    if (!isValidEmail(email)) { showError(`"${email}" is not a valid email address.`); return; }
    addSubscriberToActive(email); inp.value = '';
  });
  const schedModeEl = $('schedule-mode');
  if (schedModeEl) schedModeEl.addEventListener('change', () => {
    const ig = $('schedule-interval-group'); const tg = $('schedule-times-group');
    if (ig) ig.style.display = schedModeEl.value === 'interval' ? 'inline' : 'none';
    if (tg) tg.style.display = schedModeEl.value === 'times' ? 'inline' : 'none';
  });
  const fundSel = $('fund-provider');
  if (fundSel) fundSel.addEventListener('change', () => {
    const s = getFundamentalsStore();
    const keyEl = $('fund-key');
    if (keyEl) { keyEl.value = fundSel.value === 'yahoo' ? '' : (s.keys[fundSel.value] || ''); keyEl.disabled = fundSel.value === 'yahoo'; }
  });
  on('save-fund-btn', () => {
    const provider = ($('fund-provider') && $('fund-provider').value) || 'yahoo';
    const key = ($('fund-key') && $('fund-key').value || '').trim();
    if (provider !== 'yahoo' && !key) { showError('Enter the API key for the selected provider, or choose Yahoo.'); return; }
    saveProviderKey(provider, key);
  });
  on('test-fund-btn', () => { testFundamentals(); });
  on('save-schedule-btn', () => {
    const mode = ($('schedule-mode') && $('schedule-mode').value) || 'default';
    let schedule = { mode: 'default' };
    if (mode === 'interval') {
      const n = parseInt($('schedule-interval') && $('schedule-interval').value, 10);
      if (!Number.isFinite(n) || n < 5) { showError('Check interval must be at least 5 minutes.'); return; }
      schedule = { mode: 'interval', intervalMinutes: n };
    } else if (mode === 'times') {
      const times = [...doc.querySelectorAll('.schedule-time')].filter((b) => b.checked).map((b) => b.value);
      if (!times.length) { showError('Pick at least one time slot, or use Default.'); return; }
      schedule = { mode: 'times', times };
    }
    setScheduleOnActive(schedule);
  });
  const input = $('ticker-input');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

  renderAll(getCollection());
  renderFundamentalsConfig();
  if (autoSchedule) {
    for (const l of getCollection().lists) checkOneList(l.name); // check every list once on open
    scheduleAllLists();                                          // then each on its own cadence
  } else if (autoRefreshMs > 0) {
    setInterval(() => { refreshWatchlist(); }, autoRefreshMs);
    if (getWatchlist().length > 0) refreshWatchlist();
  }

  const api = {
    analyze, analyzeSymbol, addCurrentToWatchlist, removeWatch, setWatchlist,
    exportWatchlistJson, refreshWatchlist, getWatchlist, clearAlerts,
    getCollection, newWatchlist, selectWatchlist, renameActiveWatchlist, deleteActiveWatchlist,
    addSubscriberToActive, removeSubscriberFromActive, updateSubscriberOnActive, exportMailingListsJson,
    checkOneList, setScheduleOnActive, getFundamentalsConfig, setFundamentalsConfig, testFundamentals, resolveBrowserConfig,
  };
  return api;
}

// ---------- browser auto-init (skipped in tests/Node) ----------
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__MINERVINI_TEST__) {
  const notify = (title, body) => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body }); });
    }
  };
  window.app = initApp({ document, storage: window.localStorage, notify, autoSchedule: true });
}
