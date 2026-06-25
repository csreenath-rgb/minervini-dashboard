# Minervini SEPA Dashboard — Onboarding & Usage Guide

**Setup and day-to-day use, step by step, for any new member.**

- **Live dashboard:** https://csreenath-rgb.github.io/minervini-dashboard/
- **Source code:** https://github.com/csreenath-rgb/minervini-dashboard

> [!CAUTION]
> **Not financial advice.** This is an educational decision-support tool that implements one published methodology (Mark Minervini's SEPA®). It is **not** investment advice and **not** a recommendation to buy or sell. Markets carry risk of loss. Verify everything and make your own decisions.

---

## Contents

1. [Who this guide is for](#1-who-this-guide-is-for)
2. [What the dashboard does](#2-what-the-dashboard-does)
3. [Quick start (Viewer) — analyze your first ticker](#3-quick-start-viewer--analyze-your-first-ticker)
4. [Reading the results](#4-reading-the-results)
5. [Watchlists & in-browser alerts (Viewer)](#5-watchlists--in-browser-alerts-viewer)
6. [Email alerts (Owner / Admin)](#6-email-alerts-owner--admin-one-time-setup)
7. [Auto-sync — stop copying and pasting (recommended)](#7-auto-sync--stop-copying-and-pasting-recommended)
8. [Better fundamentals (optional)](#8-better-fundamentals-optional)
9. [Using the India market](#9-using-the-india-market)
10. [Standing up your own copy (Owner)](#10-standing-up-your-own-copy-owner)
11. [Troubleshooting](#11-troubleshooting)
12. [Glossary](#12-glossary)
13. [Appendix — GitHub secrets at a glance](#appendix--github-secrets-at-a-glance)

---

## 1. Who this guide is for

There are two ways to use this dashboard, and you only need the parts that match your role.

- **Viewer / Analyst** — you just want to analyze stocks and run watchlists in your browser. You need nothing more than the web link. Read sections 2, 3 and 4.
- **Owner / Admin** — you also want scheduled email alerts, automatic syncing, India-market support, or you are standing up your own copy. Read everything; sections 5 onward involve a GitHub account and one-time setup.

> [!NOTE]
> **In one line:** a Viewer opens the link and starts analyzing. An Owner does a one-time GitHub setup so the tool can email alerts even when the browser is closed.

---

## 2. What the dashboard does

You type a stock or ETF symbol; the dashboard pulls its recent price history and runs it through the rules from Mark Minervini's book *Trade Like a Stock Market Wizard*. It then tells you, in plain terms:

- **Should I buy now, and at what price?** An entry verdict, the exact breakout ("pivot") price, and the buy zone.
- **Where do I get out?** A stop-loss price to cap a loss, and an exit verdict for a holder.
- **Is it even a candidate?** An 8-point "Trend Template" checklist (Minervini only buys stocks in a confirmed uptrend).
- **Supporting context:** a price chart with key lines, and a fundamentals check (earnings growth) for stocks.

**Markets:** a toggle at the top switches between **US** and **India**. The two markets are kept completely separate — different watchlists, alerts, and benchmarks.

**Data:** prices come from Yahoo Finance and are delayed roughly 15 minutes. This is a tool for swing/position trading on daily data, not intraday day-trading.

---

## 3. Quick start (Viewer) — analyze your first ticker

No account, install, or setup. Just the link.

1. **Open the dashboard:** https://csreenath-rgb.github.io/minervini-dashboard/ in any modern browser.
2. At the top, choose your market — **US** or **India** (US is selected by default).
3. In the ticker box (placeholder `Ticker or company name (e.g. AAPL, Apple)`), start typing. A dropdown suggests matching symbols — click one, or type the symbol and press **Enter**.
4. *(Optional)* If you already own the stock, type your purchase price in `Your entry price (optional)` so the exit advice is tailored to your position.
5. Click **Analyze**. Within a couple of seconds you'll see the Entry decision, Exit decision, key price levels, a chart, the Trend Template checklist, and (for stocks) fundamentals.
6. Read the verdict badges (explained next). That's it — you've analyzed a stock.

> [!TIP]
> If a symbol won't analyze, you'll see "Please enter a valid ticker symbol." Use the dropdown suggestions to get the exact ticker (for India, the tool adds the `.NS` suffix automatically).

---

## 4. Reading the results

### Entry decision

| Badge | What it means | What to do |
|---|---|---|
| **ENTER NOW** | All 8 Trend-Template checks pass and price has broken above the pivot, still inside the buy zone. | A valid buy point right now (confirm volume — see note). |
| **WAIT** | Checks pass and a base has formed, but price is still below the pivot. | Set an alert / add to a watchlist; buy only if it breaks the pivot. |
| **EXTENDED** | Valid breakout, but price is already more than 5% above the pivot. | Do not chase. Wait for a new base. |
| **DO NOT ENTER** | Fails the Trend Template, or no valid base/pivot exists. | Not a candidate under this method. |

### Exit decision

| Badge | What it means |
|---|---|
| **HOLD** | Position healthy; uptrend intact. |
| **RAISE STOP** | Warning sign (e.g. price slipped below the 50-day average) — tighten your stop. |
| **SELL PARTIAL / TAKE PROFITS** | Gain reached ~20%+; consider taking some profit and raising the stop to at least breakeven. |
| **EXIT NOW** | Stop hit, or price closed below the 150-day average — the uptrend is broken. |

### Key price levels, chart, Trend Template, fundamentals

- **Key price levels:** current price, the pivot (buy point), the buy zone (pivot up to +5%), the stop-loss, the 50/150/200-day moving averages, and the 52-week high/low.
- **Chart:** closing price with the 50/150/200-day averages, plus dashed lines for the pivot and the stop.
- **Trend Template (8 checks):** each line shows a green tick or red cross with the actual numbers. All eight must pass for a buy. The 8th, Relative Strength, is an approximation (12-month performance vs the market benchmark) and is labelled as such.
- **Fundamentals (stocks only):** quarterly earnings (EPS) growth vs a year ago — the method wants roughly 20–25%+. ETFs skip this automatically. This panel never changes the entry/exit verdicts (those are price-based); it's supporting context.

> [!WARNING]
> **Volume caveat:** a breakout on low volume is weaker. When you see ENTER, the dashboard notes whether volume confirmed the move; re-check during market hours before acting.

---

## 5. Watchlists & in-browser alerts (Viewer)

A watchlist lets the dashboard track several tickers and pop up an alert when one hits an entry or exit trigger — **while the page is open**. Everything here is saved in your browser; no account needed.

### Create and manage lists

- Use the **List:** dropdown to switch lists. **+ New list**, **Rename**, and **Delete** manage them. Whatever list is selected is the one that **+ Watchlist** and "refresh" act on.
- To add the ticker you just analyzed, click **+ Watchlist**.
- Lists are per-market: your US lists and India lists are separate.

### Check prices and see alerts

- **↻ Refresh entry/exit (live):** re-checks the selected list now and shows current verdicts.
- **Clear & reset alerts:** wipes the alert banners and resets the "already-shown" memory so a still-valid trigger can surface again on the next check.
- **Desktop notifications:** the first time an alert fires, your browser asks permission to show notifications — click Allow to get pop-ups even when the tab is in the background.

### How often it checks (per-list schedule)

Each list has a **Check schedule** with three modes:

| Mode | Behavior |
|---|---|
| Default (twice daily) | Checks at 13:45 and 19:45 UTC (about 9:45am and 3:45pm US Eastern). |
| Every N minutes | While the page is open, re-checks every N minutes (minimum 5). |
| Specific times | Pick from 13:45 / 16:45 / 19:45 UTC (~9:45am / 12:45pm / 3:45pm ET). |

*The open dashboard checks all of your lists on their own schedules, not just the one on screen.*

> [!IMPORTANT]
> In-browser alerts only run while the dashboard tab is open. To get alerted with the browser closed, set up email alerts (next section).

---

## 6. Email alerts (Owner / Admin, one-time setup)

This makes the tool email you (and any subscribers) when a watchlist triggers — on a schedule, even when no browser is open. It runs on GitHub Actions in the repository, so you need access to the GitHub repo (as owner or collaborator).

### Step 1 — Create a Gmail App Password

The job sends mail through Gmail. Use an **App Password** (not your real password):

1. In your Google Account, go to **Security** → turn on **2-Step Verification** if it isn't already.
2. Then **Security** → **App passwords** → create one (name it e.g. "Minervini"). Copy the 16-character code.

### Step 2 — Add repository secrets

In the GitHub repo: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add:

| Secret name | Value | Required? |
|---|---|---|
| `GMAIL_ADDRESS` | The Gmail address that sends the alerts. | Yes (to send email) |
| `GMAIL_APP_PASSWORD` | The 16-character app password from Step 1. | Yes (to send email) |
| `MAIL_TO` | Fallback recipient when a list has no subscribers (defaults to `GMAIL_ADDRESS`). | Optional |
| `MAILING_LISTS` | Per-list subscriber emails (see Step 4). JSON like `{ "List": ["a@x.com"] }`. | Optional |

> [!WARNING]
> **Privacy:** the `MAILING_LISTS` secret holds email addresses, so it lives in a private Actions secret — never committed to the public repo.

### Step 3 — Tell it which tickers to watch

The job reads `watchlist.json` (US) and `watchlist.in.json` (India) from the repo. The easy way to fill these is from the dashboard:

- In the dashboard, click **Copy watchlist JSON (public)** — it copies your lists (symbols only, no emails).
- Paste it into `watchlist.json` in the repo (edit the file on github.com and commit).

*Or skip all manual copying with Auto-sync — see section 7, recommended.*

### Step 4 — Add subscribers (who gets emailed)

- In the dashboard, each list has a **Subscribers for this list** box. Type an email in `name@example.com` and click **Add email**.
- Click **Copy mailing-lists JSON (private)** and paste it into the `MAILING_LISTS` secret. (Auto-sync does this for you — section 7.)
- A list with no subscribers falls back to `MAIL_TO`.

### Step 5 — Test it

1. In the repo, open the **Actions** tab → **Watchlist alerts** → **Run workflow**.
2. If nothing is triggering, it logs "no alerts triggered"; when something triggers it emails the list. After this, it runs automatically on weekdays at the preset times.

---

## 7. Auto-sync — stop copying and pasting (recommended)

By default you'd paste your watchlist and subscribers into the repo by hand. Auto-sync removes that: the dashboard publishes your watchlists and mailing lists to a private ("secret") GitHub Gist whenever you change them, and the email job reads that gist first. The committed files stay as a backup.

> [!NOTE]
> **Why a token is needed:** the dashboard runs in your browser; the email job runs on GitHub's servers and cannot see your browser. So the browser has to publish your data somewhere online — that needs one credential, stored only in your browser.

### Set it up once

1. On GitHub: **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
2. Tick **ONLY** the `gist` scope. (No expiry is fine — a gist-only token cannot touch your code or repository secrets.) Generate and copy the token.
3. In the dashboard's **Auto-sync to GitHub** panel, paste it into `GitHub token (gist scope only)` and click **Save & sync**.
4. The panel shows a **Secret gist ID**. Copy it into a repository Actions secret named `SYNC_GIST_ID` (Settings → Secrets and variables → Actions). One time only.
5. Done. From now on, every change you make in the dashboard is picked up automatically — no commits, no pasting. Use **Sync now** to push immediately.

> [!CAUTION]
> **Security:** the token is stored only in your browser and is visible to anyone using that device. Use a gist-only token; revoke it anytime in GitHub settings. Never paste a brokerage or password here.

---

## 8. Better fundamentals (optional)

By default earnings data comes from Yahoo (free, sometimes sparse). For more reliable history you can plug in a data provider in the **Fundamental data source** panel: pick one in the dropdown, paste a **read-only data key** in `API key (read-only data key)`, click **Save**, then **Test key** to confirm it returns data.

| Provider | Best for | Notes |
|---|---|---|
| Alpha Vantage | The live dashboard (works in the browser) | Free quota ~25 calls/day — best for on-demand use. |
| Financial Modeling Prep | The email job (server-side) | Free plan blocks browser use; set it as repo secrets instead. |
| Finnhub | Quarterly EPS | Generous free tier; revenue/margins need a paid tier. |
| indianapi.in | India stocks | Used for the India market (see section 9). |

For the email job, set `FUNDAMENTALS_PROVIDER` and `FUNDAMENTALS_API_KEY` as repository secrets. A common setup: Alpha Vantage in the browser, FMP for the email job. If no key is set, the tool falls back to Yahoo. Price/chart data always stays on Yahoo.

> [!CAUTION]
> **Never use a brokerage key.** Only ever paste a read-only market-data key. Brokerage/trading accounts (Interactive Brokers, Schwab, Vanguard, Merrill) are intentionally unsupported.

---

## 9. Using the India market

- Click **India** in the top toggle. Watchlists, subscribers, and schedules are separate from US.
- Type a plain NSE symbol (e.g. `RELIANCE`, `TCS`) — the tool adds `.NS` automatically. The benchmark for Relative Strength becomes the NIFTY 50.
- **India fundamentals:** select `indianapi.in (India)` in the provider panel and save its key (from indianapi.in). Technicals work regardless.
- **Mutual funds panel (India only):** search a fund to see its NAV trend, moving-average position, and trailing returns. This is **informational only** — not a buy/sell signal (mutual funds lack the intraday/volume data the method needs).

**India email alerts:** maintain `watchlist.in.json` (paste the public export while in India mode, or use Auto-sync), and add secrets `MAILING_LISTS_IN` (subscribers) and `INDIANAPI_KEY` (fundamentals). The scheduled job checks US and India together.

---

## 10. Standing up your own copy (Owner)

If you're creating a fresh instance rather than using the existing one:

1. Create/Fork the repository under your GitHub account.
2. Enable hosting: repo **Settings** → **Pages** → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)`. Your dashboard appears at `https://<your-username>.github.io/<repo>/`.
3. *(Optional)* Add the email + auto-sync secrets from sections 6–7.
4. After any code update, do a hard refresh (`Ctrl+Shift+R`) so the browser loads the newest version.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| A change or new feature isn't showing | Hard refresh with `Ctrl+Shift+R` (the browser cached an old version). |
| "Please enter a valid ticker symbol" | Use the type-ahead dropdown to pick the exact symbol; for India use the plain NSE name. |
| Analysis fails or data looks stale | Yahoo is delayed ~15 min and free data proxies occasionally hiccup; wait and retry. |
| Fundamentals show "insufficient/none" | Yahoo data is sparse; add an Alpha Vantage key, or click `Test key` to diagnose. |
| No alert emails arriving | Confirm `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` secrets are set and run the workflow manually to test. |
| Email job not using my latest list | Confirm Auto-sync is on (gist + `SYNC_GIST_ID`), or that you committed `watchlist.json`. |

---

## 12. Glossary

| Term | Plain meaning |
|---|---|
| Trend Template | Minervini's 8-point checklist that confirms a stock is in a healthy uptrend ("Stage 2"). All 8 must pass to buy. |
| Base / VCP | A sideways consolidation where each pullback gets shallower — a setup that often precedes a breakout. |
| Pivot (buy point) | The price at the top of the base; a move above it is the buy signal. |
| Buy zone | From the pivot up to ~5% above it. Buying higher is "extended" (risky). |
| Stop-loss | The price at which you sell to cap a loss (here, up to ~7.5–8% below entry). |
| Relative Strength (RS) | How the stock's 12-month performance compares with the market; the method wants the top ~30% (a rating of 70+). |
| Benchmark | The index RS is measured against — S&P 500 for US, NIFTY 50 for India. |

---

## Appendix — GitHub secrets at a glance

All optional — the dashboard works without any of them. Add them only for the features you want.

| Secret | Enables | Public or private |
|---|---|---|
| `GMAIL_ADDRESS` | Sending alert emails | Private |
| `GMAIL_APP_PASSWORD` | Sending alert emails | Private |
| `MAIL_TO` | Fallback recipient | Private |
| `MAILING_LISTS` | US per-list subscribers | Private (contains emails) |
| `MAILING_LISTS_IN` | India per-list subscribers | Private (contains emails) |
| `SYNC_GIST_ID` | Auto-sync (read the gist) | Private |
| `FUNDAMENTALS_PROVIDER` | Better fundamentals in email job | Private |
| `FUNDAMENTALS_API_KEY` | Better fundamentals in email job | Private |
| `INDIANAPI_KEY` | India fundamentals in email job | Private |

---

*Educational tool implementing one published methodology. Not financial advice.*
