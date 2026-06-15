# Minervini SEPA Dashboard

A free, serverless stock/ETF analysis dashboard implementing the methodology from Mark Minervini's
*Trade Like a Stock Market Wizard* (SEPA®). Type a ticker and get: the 8-point Trend Template
checklist, an entry verdict with pivot buy point and buy zone, a stop-loss level, an exit verdict,
a fundamentals check, and a chart with all key levels. Organize tickers into multiple named watchlists, each with its own email subscriber list, for
automatic entry/exit alerts — in-browser while the page is open, and by email on a schedule via
GitHub Actions. A one-click button clears and resets on-screen alerts.

**Live dashboard:** enable GitHub Pages on this repository (see Setup) and open the published URL.

---

## What it implements

**Trend Template (gatekeeper — all 8 must pass):** price above 150- and 200-day moving averages;
150-day above 200-day; 200-day rising for at least a month; 50-day above 150- and 200-day; price
above 50-day; price at least 30% above its 52-week low; price within 25% of its 52-week high;
Relative Strength rating ≥ 70 (approximated as weighted 12-month performance vs the S&P 500 —
a true RS rating requires ranking against every US stock, which needs proprietary data).

**Entry:** detects the most recent consolidation base and its volatility contractions (VCP),
sets the pivot buy point at the base's left-side high, and issues
ENTER (breakout within the 5% buy zone) / WAIT (base formed, below pivot) /
EXTENDED (more than 5% past pivot — do not chase) / DO NOT ENTER (Trend Template failed or no base).

**Exit:** initial stop 7.5% below entry (Minervini's 8% ceiling), EXIT on stop hit or a close below
the 150-day moving average, RAISE STOP warning below the 50-day, SELL PARTIAL / take-profit
suggestion at +20% (sell into strength), with the stop raised to breakeven or better.

**Fundamentals (stocks only, best effort):** quarterly EPS growth year-over-year (want ≥20–25% and
accelerating), revenue growth, and profit-margin trend, from Yahoo's quarterly time series.
ETFs skip this section automatically.

## Watchlists, alerts & subscribers

- **Multiple named watchlists.** Create, rename, switch between, and delete lists from the dashboard.
  Adding a ticker or checking prices acts on the currently selected list. Your existing single
  watchlist is migrated automatically into a list called "Default".
- **Per-list email subscribers.** Each watchlist carries its own list of subscriber email addresses
  (add / edit / delete in the dashboard). When that list triggers, the scheduled job emails its
  subscribers. A list with no subscribers falls back to the owner (`MAIL_TO`).
- **Clear & reset alerts.** A button wipes the on-screen alert banners and resets the de-duplication
  memory, so a still-valid trigger can surface again on the next check.
- **Per-list check schedule.** Each watchlist can use one of three modes (the dashboard honors them
  faithfully; lists you don't change keep the twice-daily default):
  - *Default* — twice each trading day (13:45 & 19:45 UTC, ~9:45am & 3:45pm ET).
  - *Every N minutes* — the open dashboard re-checks that list every N minutes (minimum 5). Because
    GitHub Actions cron is coarse, **email** for interval lists is sent at the two default daily slots.
  - *Specific times* — pick from preset daily slots (13:45 / 16:45 / 19:45 UTC); the dashboard checks at
    those times and email fires at exactly those slots.
  The open dashboard checks **all** your lists on their own schedules, not just the one on screen.
- **Privacy split.** Subscriber emails never go in the public repo. The dashboard offers two exports:
  **Copy watchlist JSON (public)** → commit into `watchlist.json` (symbols only); and
  **Copy mailing-lists JSON (private)** → paste into the private Actions secret `MAILING_LISTS`
  (it contains email addresses, so it must never be committed).

## Architecture

Everything runs client-side on GitHub Pages — no server, no API keys, no accounts.

| File | Role |
|---|---|
| `index.html` | dashboard UI |
| `js/engine.js` | analysis engine (pure functions, identical in browser and Node) |
| `js/data.js` | data fetching; Yahoo by default, routes fundamentals to a chosen provider |
| `js/providers.js` | fundamentals adapters (Finnhub / FMP / Alpha Vantage) normalized to the engine shape |
| `js/app-core.js` | watchlist collection, subscriber & alert logic, schedule helper (pure, unit-tested) |
| `js/app.js` | DOM wiring, localStorage watchlist collection, per-list check scheduler, notifications |
| `scripts/check_alerts.mjs` | scheduled watchlist check (reuses the same engine) |
| `scripts/send_email.py` | emails triggered alerts (Gmail SMTP, stdlib only) |
| `.github/workflows/alerts.yml` | cron: preset daily slots (13:45/16:45/19:45 UTC) + manual trigger |
| `.github/workflows/ci.yml` | runs the full test suite on every push |
| `watchlist.json` | named watchlist collection used by the email job (symbols only, no emails) |

## Fundamental data providers (optional)

By default fundamentals come from Yahoo (free, delayed, sometimes sparse). For more accurate
earnings/revenue history you can plug in a dedicated data API. Pick one in the dashboard's
**Fundamental data source** panel and paste a **read-only data key**:

- **Financial Modeling Prep** — SEC-EDGAR-backed; best for quarterly EPS/revenue history.
- **Finnhub** — generous free tier; quarterly EPS (revenue/margins need a higher tier).
- **Alpha Vantage** — simple, but the free quota (~25/day) is tight for a large watchlist.

If no key is set, or a provider can't be reached from the browser, the dashboard falls back to Yahoo
automatically. Price/chart data always stays on Yahoo.

**Security & scope.** A browser key is stored in your browser's localStorage and is visible to anyone
using that device — only ever use a *read-only data-provider* key, never a brokerage account key.
Retail brokerages (Interactive Brokers, Schwab, Vanguard, Merrill) are intentionally **not** supported:
Vanguard and Merrill have no retail data API, and IBKR/Schwab are OAuth trading APIs that can't be
called from a static page and don't provide the multi-quarter fundamentals this tool needs.

For the scheduled **email** job, set the key as private repository secrets instead of in the browser:
`FUNDAMENTALS_PROVIDER` (one of `finnhub` / `fmp` / `alphavantage`) and `FUNDAMENTALS_API_KEY`.

## Setup

1. **GitHub Pages:** repository Settings → Pages → Source: *Deploy from a branch* →
   Branch: `main`, folder `/ (root)`. The dashboard appears at
   `https://<username>.github.io/<repo>/`.
2. **Email alerts (optional):**
   - Create a Gmail *app password*: Google Account → Security → 2-Step Verification → App passwords.
   - Repository Settings → Secrets and variables → Actions → add secrets
     `GMAIL_ADDRESS` (your Gmail), `GMAIL_APP_PASSWORD` (the app password), and optionally
     `MAIL_TO` (owner fallback recipient, defaults to `GMAIL_ADDRESS`).
   - For per-list subscribers, also add a secret named `MAILING_LISTS` — paste the dashboard's
     **"Copy mailing-lists JSON (private)"** output (a JSON object of `{ "List name": ["email", ...] }`).
     This secret holds email addresses and must never be committed to the repo.
   - Optional, for higher-quality fundamentals in the email job: add `FUNDAMENTALS_PROVIDER`
     (`finnhub` / `fmp` / `alphavantage`) and `FUNDAMENTALS_API_KEY` secrets.
   - Edit `watchlist.json` with the tickers to monitor. The dashboard's
     **"Copy watchlist JSON (public)"** button produces exactly this content (symbols only).
   - Test it: Actions tab → *Watchlist alerts* → *Run workflow*. With no triggers it logs
     "no alerts triggered"; with triggers it emails you.

## Watchlist sync (the one manual step)

The in-browser watchlist lives in your browser's localStorage. The email job reads `watchlist.json`
from the repo. A public static page cannot write to GitHub without exposing a token, so syncing is
manual by design: click **Copy watchlist JSON (public)** in the dashboard, then paste into
`watchlist.json` on github.com. To update subscribers, click **Copy mailing-lists JSON (private)**
and paste into the `MAILING_LISTS` Actions secret. Each takes ~20 seconds, only when things change.

## Testing

Built test-first (TDD). 130+ tests: engine unit tests (every Trend Template criterion exercised
individually, VCP detection, stops, exits, fundamentals, edge cases), integration tests (proxy
fallback, fixture-backed pipeline, live smoke test), and headless DOM end-to-end tests (jsdom).
Moving-average / 52-week / RS math is cross-verified against pandas to full float precision.

```bash
npm install jsdom --no-save
node --test tests/engine.test.mjs tests/integration.test.mjs tests/ui.test.mjs
```

CI runs the same suite on every push.

## Known limitations

Free public CORS proxies can rate-limit or go down (three fallbacks are tried in order); Yahoo data
is delayed ~15 minutes; the RS rating is an approximation; automated VCP detection is conservative
and shows its work so you can judge the base yourself; GitHub cron timing is best-effort (runs may be delayed and occasionally skipped) and shifts one hour
with US daylight saving, so email alert times are approximate; the in-browser schedule is exact while
the page is open. Email runs only at the preset daily slots, not arbitrary minutes.

## Disclaimer

Educational decision-support tool implementing one published methodology. **Not financial advice.**
Markets involve risk of loss; verify everything and make your own decisions.
