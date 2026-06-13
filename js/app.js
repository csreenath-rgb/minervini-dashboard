/**
 * Dashboard application: wires the analysis engine and data layer to the DOM.
 * initApp() is dependency-injected (document, storage, fetch, notify) so the
 * full flow is testable headlessly; in a real browser it auto-initializes.
 */
import { analyzeTicker } from './engine.js';
import { fetchTickerBundle } from './data.js';
import {
  addToWatchlist, removeFromWatchlist, deriveAlerts, alertKey,
  filterNewAlerts, verdictBadge, msUntilNextSlot,
  migrateCollection, getActiveItems, setActiveItems, getActiveList, listNames,
  createWatchlist, setActiveWatchlist, renameWatchlist, deleteWatchlist,
  addSubscriber, removeSubscriber, updateSubscriber, isValidEmail,
  exportPublicWatchlist, exportMailingLists,
} from './app-core.js';

const WATCHLIST_KEY = 'minervini_watchlist';        // legacy single-list key (read once for migration)
const COLLECTION_KEY = 'minervini_watchlists';      // v3 named-collection key
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * @param {{document: Document, storage: Storage, fetchImpl?: typeof fetch,
 *          notify?: (title: string, body: string) => void, autoRefreshMs?: number}} deps
 */
export function initApp({ document: doc, storage, fetchImpl, notify, autoRefreshMs = 0, checkSlotsUtc = null }) {
  const $ = (id) => doc.getElementById(id);
  const state = {
    lastReport: null,
    seenAlertKeys: new Set(),
    chart: null,
  };

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
  }
  function renderAll(col) {
    renderListSelector(col);
    renderSubscribers(col);
    renderWatchlist(getActiveItems(col));
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
        <strong>[${esc(a.type)}] ${esc(a.symbol)}</strong> @ ${a.price.toFixed(2)} — ${esc(a.message)}
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
        <strong>${esc(item.symbol)}</strong>
        ${item.entryPrice != null ? `<span class="muted">entry ${Number(item.entryPrice).toFixed(2)}</span>` : ''}
        ${stHtml}
        <button class="remove-watch" data-symbol="${esc(item.symbol)}">✕</button>
      </div>`;
    }).join('');
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
      const bundle = await fetchTickerBundle(symbol, { fetchImpl });
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

  async function refreshWatchlist() {
    const list = getWatchlist();
    const statuses = {};
    const today = new Date().toISOString().slice(0, 10);
    for (const item of list) {
      try {
        const bundle = await fetchTickerBundle(item.symbol, { fetchImpl });
        const report = analyzeTicker({
          chartJson: bundle.chartJson, benchJson: bundle.benchJson, fundJson: bundle.fundJson,
          entryPrice: item.entryPrice ?? null,
        });
        statuses[item.symbol] = {
          price: report.price, entryVerdict: report.entry.verdict, exitVerdict: report.exit.verdict,
        };
        const fresh = filterNewAlerts(deriveAlerts(report), state.seenAlertKeys, today);
        for (const a of fresh) state.seenAlertKeys.add(alertKey(a, today));
        showAlerts(fresh, { notifyUser: true });
      } catch (err) {
        statuses[item.symbol] = null;
        showError(`${item.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    renderWatchlist(list, statuses);
    const stamp = $('last-refresh');
    if (stamp) stamp.textContent = `Watchlist last checked: ${new Date().toLocaleTimeString()}`;
    return statuses;
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
  const input = $('ticker-input');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

  renderAll(getCollection());
  const runAutoCheck = () => { if (getWatchlist().length > 0) refreshWatchlist(); };
  if (Array.isArray(checkSlotsUtc) && checkSlotsUtc.length) {
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const setT = (win && win.setTimeout) ? win.setTimeout.bind(win) : setTimeout;
    const schedule = () => setT(() => { runAutoCheck(); schedule(); }, msUntilNextSlot(new Date(), checkSlotsUtc));
    runAutoCheck(); // check once when the page opens
    schedule();     // then at each daily slot, same times as the email job
  } else if (autoRefreshMs > 0) {
    setInterval(() => { refreshWatchlist(); }, autoRefreshMs);
    runAutoCheck();
  }

  const api = {
    analyze, addCurrentToWatchlist, removeWatch, setWatchlist,
    exportWatchlistJson, refreshWatchlist, getWatchlist, clearAlerts,
    getCollection, newWatchlist, selectWatchlist, renameActiveWatchlist, deleteActiveWatchlist,
    addSubscriberToActive, removeSubscriberFromActive, updateSubscriberOnActive, exportMailingListsJson,
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
  window.app = initApp({ document, storage: window.localStorage, notify, checkSlotsUtc: [[13, 45], [19, 45]] });
}
