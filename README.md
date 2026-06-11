# Minervini SEPA Dashboard

A free, serverless stock/ETF analysis dashboard implementing the methodology from Mark Minervini's
*Trade Like a Stock Market Wizard* (SEPA®). Type a ticker and get: the 8-point Trend Template
checklist, an entry verdict with pivot buy point and buy zone, a stop-loss level, an exit verdict,
a fundamentals check, and a chart with all key levels. Save tickers to a watchlist for automatic
entry/exit alerts — in-browser while the page is open, and by email on a schedule via GitHub Actions.

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

## Architecture

Everything runs client-side on GitHub Pages — no server, no API keys, no accounts.

| File | Role |
|---|---|
| `index.html` | dashboard UI |
| `js/engine.js` | analysis engine (pure functions, identical in browser and Node) |
| `js/data.js` | Yahoo Finance fetcher; direct first, then CORS proxies in order |
| `js/app-core.js` | watchlist/alert logic (pure, unit-tested) |
| `js/app.js` | DOM wiring, localStorage watchlist, 5-minute alert loop, notifications |
| `scripts/check_alerts.mjs` | scheduled watchlist check (reuses the same engine) |
| `scripts/send_email.py` | emails triggered alerts (Gmail SMTP, stdlib only) |
| `.github/workflows/alerts.yml` | cron: twice each trading day + manual trigger |
| `.github/workflows/ci.yml` | runs the full test suite on every push |
| `watchlist.json` | watchlist used by the email job |

## Setup

1. **GitHub Pages:** repository Settings → Pages → Source: *Deploy from a branch* →
   Branch: `main`, folder `/ (root)`. The dashboard appears at
   `https://<username>.github.io/<repo>/`.
2. **Email alerts (optional):**
   - Create a Gmail *app password*: Google Account → Security → 2-Step Verification → App passwords.
   - Repository Settings → Secrets and variables → Actions → add secrets
     `GMAIL_ADDRESS` (your Gmail), `GMAIL_APP_PASSWORD` (the app password), and optionally
     `MAIL_TO` (recipient, defaults to `GMAIL_ADDRESS`).
   - Edit `watchlist.json` with the tickers to monitor. The dashboard's
     **"Copy watchlist JSON"** button produces exactly this content from your in-browser watchlist.
   - Test it: Actions tab → *Watchlist alerts* → *Run workflow*. With no triggers it logs
     "no alerts triggered"; with triggers it emails you.

## Watchlist sync (the one manual step)

The in-browser watchlist lives in your browser's localStorage. The email job reads `watchlist.json`
from the repo. A public static page cannot write to GitHub without exposing a token, so syncing is
manual by design: click **Copy watchlist JSON** in the dashboard, then paste into `watchlist.json`
on github.com. Takes ~20 seconds, only needed when your watchlist changes.

## Testing

Built test-first (TDD). 60+ tests: engine unit tests (every Trend Template criterion exercised
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
and shows its work so you can judge the base yourself; GitHub cron timing is best-effort and shifts
one hour with US daylight saving.

## Disclaimer

Educational decision-support tool implementing one published methodology. **Not financial advice.**
Markets involve risk of loss; verify everything and make your own decisions.
