# Meridian Signals

A personal FX trading system for one person, run against their own OANDA account.
It watches prices on four major pairs, applies one fully specified ruleset to closed
bars, decides whether a trade qualifies, and — once enabled in Practice — turns a
qualifying instruction into a correctly sized order at the broker with its protective
stop and take-profit attached in the same request, then tracks it to a
broker-confirmed outcome.

This is not a product. There are no subscribers, no customer accounts, no billing, and
no signals are distributed to anyone. Nothing here is financial advice, and nothing
here is sold.

---

## The honest headline: the invented ruleset does not work

The strategy in this repository — the one we invented — was measured twice against
~24 years of the owner's own OANDA history, using real historical bid/ask, filling at
the next bar's open. **Both measurements are negative. Neither has been deleted or
reframed to make the execution work look better.**

### Hourly (the live ruleset) — 2003-01-15 → 2026-10-12, 3,789 trades

| | |
|---|---|
| Net | **−4,241 pips** |
| Win rate | 32.3% |
| Profit factor | 0.94 |
| Longest losing streak | 24 trades |
| Max drawdown | ~5,988 pips / 209R |

With the spread removed but timing identical, the same signals make **+4,289 pips**
(profit factor 1.07) — a gross tendency of about **1.13 pips/trade against a spread
cost of about 2.25 pips/trade**. The cost is roughly twice the edge. The deliberately
flattering variant (filling at the trigger bar's close, which is not achievable) still
makes only +3,416 pips. Held-out last 12 months are worse than the long run on every
variant, including at zero cost.

Per pair, in R: EUR/USD −739.2 pips (961 trades, PF 0.96), GBP/USD −3,728.8 (943,
0.84), USD/JPY +51.1 (939, 1.00), AUD/USD +175.9 (946, 1.01). All four negative in R.

### Daily — tested 2026-10-26, 2003-01-15 → 2026-10-22, 208 trades

| | |
|---|---|
| Net | **−3,373.4 pips / −14.27R** |
| Win rate | 31.7% |
| Profit factor | 0.82 |

Cost as a share of risk fell from 8.5% of 1R to 3.7%, but gross edge fell too, from
+0.033R to −0.032R. **Removing the spread entirely still leaves it losing** (−2,055.1
pips, PF 0.87). Median hold is 8 days, so excluded swap is material and the daily
headline is the optimistic one on cost. 208 trades is not decisive: the 95% interval
on per-trade R (−0.26 to +0.12) includes zero. The held-out 12 months show +267.2 pips
/ +4.81R on 10 trades — **that is noise, not a result**: two AUD/USD trades supply
252.6 of it, and it is published here only so it cannot be quoted out of context.

Excluded and labelled in both runs: swap/financing, slippage beyond the spread,
commission, taxes, position sizing.

### Standing of these numbers

They have been checked for internal consistency — every figure rendered on the site
matches the stored results, and the live engine reproduces all four current signals.
They have **not** been independently verified. That requires the underlying data and
calculations to be replayed by a second, independently written implementation, and
that audit is a planned item, not something already done. Until it happens these are
**our own measurement, reported honestly** — not an external verification.

**Conclusion: the invented ruleset is not tradeable at either granularity and is
disabled for live execution.** It may generate Practice orders to test the execution
path, and every order it originates is labelled as coming from it
(`origin=INVENTED_RULESET_TEST`).

---

## There is no database in this application

Stated plainly because it is easy to assume otherwise: **Meridian Signals has no
database and no schema migrations.** There is no migrations directory, and one has not
been created to match a template.

State lives in exactly two places:

1. **Append-only JSONL files** — `signal-log/signals.jsonl` (the signal record, hash-chained)
   and `execution/orders.jsonl` (the execution record, hash-chained). Both are runtime
   state and are deliberately not in this repository.
2. **The broker** — OANDA holds the authoritative order, trade and position state. Meridian
   never treats its own view as the truth; it re-reads the broker and shows the
   broker-confirmed state.

`site/src/db.ts` is unused scaffolding left over from the site template. Nothing imports
it, no query runs through it, and no `DATABASE_URL` is set or needed. It is kept only so
the tree matches what is deployed; it is not part of this system.

---

## Execution is Practice-only, and live is structurally unreachable

This is the part that touches money, so the limits are in the code rather than beside it.

- **Practice and live are visibly distinguished, always.** The live host is
  **structurally unreachable from the Practice code path** — an assertion in the order
  path, not a setting. `execution/lib/interlock.ts` freezes the host to
  `api-fxpractice.oanda.com` and the order path asserts it on every request. There is no
  configuration key anywhere that can change it. Live activation is a deliberate code
  change plus an owner action, never a default and never a fallback after an error.
- **Protection rides in the same request as the entry**, so a stop cannot be lost between
  submission and fill. If a filled position lacks its required protection, a predefined
  recovery policy runs and the problem is reported prominently.
- **Duplicates are impossible by construction.** Each signal carries a stable idempotency
  key; resubmitting it cannot create a second order. After a timeout or a lost connection
  the system re-reads broker state before retrying.
- **Unverifiable state stops new entries.** If prices, account state or protective-order
  status cannot be confirmed, new entries pause and the problem becomes visible rather
  than being guessed at.
- **Stop controls are three separate actions**: pause new entries, cancel pending entry
  orders, close Meridian-managed positions. Pausing never removes existing protective stops.
- **No live order with missing settings.** Before live activation the owner must configure
  maximum risk per trade, maximum combined exposure and position count, daily loss
  threshold and its calculation, allowed instruments and trading times, maximum spread and
  permitted entry-price deviation, signal expiry and retry rules, and the manual-trade
  policy. Missing settings mean the system refuses and names what is missing.
- **Credentials live in the environment, never in the repo.** The OANDA token is read from
  `process.env.OANDA` at call time, goes into the `Authorization` header only, and is never
  logged, never returned in a payload and never written to a file.
- **An order request is not a trade.** Meridian shows the broker-confirmed state. A
  successful Practice connection proves execution works; **it proves nothing about
  profitability.**

Execution modes are explicit and never inferred: `signals-only` (the default),
`approve-before-execution` (the exact proposed order is shown, current price and account
state are rechecked, then submitted on the owner's approval), and `automatic`. Automatic
is never the default and is never reached by fallback.

---

## Layout

```
site/                     TanStack Start (React + Vite + Tailwind) dashboard
  src/lib/market/         the ruleset, indicators, OANDA read-only client, service layer,
                          stored backtest results (backtestResults.ts, dailyBacktestResults.ts)
  src/routes/             dashboard pages and JSON API routes
  src/db.ts               unused template scaffolding — see "no database" above
execution/                OANDA Practice execution path
  lib/interlock.ts        the frozen Practice host + the assertion that enforces it
  lib/engine.ts           order construction, sizing, submission, reconciliation
  lib/record.ts           append-only hash-chained execution record
  scripts/                verification scripts (one order, duplicate, restart,
                          connection drop, pause keeps stops, controls)
  config.json             signals-only by default; TEST values are labelled TEST
backtest/                 hourly replay: fetch_history.ts, run_backtest.ts, results.json, report
daily/                    daily replay: fetch_daily.ts, run_daily_backtest.ts, results.json, report
signal-log/verify-chain.ts  hash-chain verifier for the signal record
skills/                   reusable team procedure for running an honest backtest
```

### How the pieces find their data

The site reads its data from paths that are **overridable by environment variable**, so
it does not assume this machine's layout:

| Variable | Default | What it points at |
|---|---|---|
| `OANDA` | — | the OANDA v20 API token (required for live pricing) |
| `OANDA_BASE_URL` | `https://api-fxpractice.oanda.com` | practice host; `fxtrade` is live and is never set by this repo |
| `SIGNAL_LOG_PATH` | `/home/team/shared/signal-log/signals.jsonl` | the signal record |
| `BACKTEST_RESULTS_PATH` | `/home/team/shared/backtest/results.json` | hourly results |
| `DAILY_BACKTEST_RESULTS_PATH` | `/home/team/shared/daily/results.json` | daily results |

The stored `results.json` files are in this repo, so a clone renders the backtest pages
without re-running anything. The signal log and the execution record are runtime state and
are **not** in the repo — a clone shows those sources as unavailable rather than showing
stale numbers, which is the intended behaviour.

**Known portability limitation, stated rather than hidden:** this code was written to run
on one machine and many modules still carry absolute `/home/team/shared/...` paths as
their default — the execution record, the execution config, the backtest scripts and
`execution/scripts/08-status.ts` (which writes `site/src/lib/executionStatus.json`) all do.
The site's own data paths are overridable by the environment variables above; the
execution and replay scripts would need their constants edited to run from a different
root. `bun install && bun run build` in `site/` does not depend on any of them, so the
dashboard builds and renders anywhere; running the execution scripts from a different
root does. `08-status.ts` writing outside the repo is also why `executionStatus.json` is
gitignored: the file is regenerated on the machine that runs it, never committed.

---

## Run and publish

Requires [Bun](https://bun.sh) and Node-compatible tooling.

```bash
cd site
bun install --frozen-lockfile     # install from bun.lock
bun run build                     # production build (vite build)
bun run start                     # serve the build on port 3000
```

Development server with hot reload:

```bash
cd site
bun run dev
```

Set the token in the environment before starting if you want live pricing:

```bash
export OANDA='<your OANDA v20 practice token>'
```

Publishing to the team's host:

```bash
cd site
bash ./publish.sh                 # or: bun run publish
```

`go-live.sh` and `build-vercel.sh` are the Vercel Build Output API path; `serve.ts` is the
self-hosted server. `SITE.md` documents the framework conventions.

### Execution scripts (Practice only)

```bash
cd execution
bun scripts/08-status.ts          # broker read → status.json
bun scripts/02-one-order.ts       # one sized order with protection attached
```

`config.test.json` is used only by the verification scripts. It enables the invented
ruleset **solely** so it can originate a Practice order to exercise the connection. Every
order it originates is labelled as such.

---

## What is deliberately not in this repository, and why

| Excluded | Why |
|---|---|
| `node_modules/`, `dist/`, `.run/`, `*.log` | dependency caches and build output — re-creatable from `bun.lock` and `package.json` |
| any `.env*`, key, token or credential file | secrets are supplied as environment variables at runtime and must never be committed |
| `backtest/data/`, `daily/data/` | ~57 MB + ~3 MB of raw historical bars from the owner's own OANDA account. Personal-use terms; not ours to redistribute. Re-fetchable with the `fetch_*.ts` scripts |
| `verify/` | evidence logs containing the account id and the broker's own order and trade ids |
| `signal-log/signals.jsonl`, `execution/orders.jsonl` | runtime state — the owner's own trading history, append-only, regenerated as the system runs |
| `execution/status.json`, `pause.json`, `day-state.json` | runtime state, written by the running system |
| **`site/src/lib/executionStatus.json`** | **generated runtime state copied into the source tree by `execution/scripts/08-status.ts`. It carries account-level detail: balance, NAV, open orders, open positions and broker ids. The dashboard never imports it, so the app builds and renders without it** |

The repository contains no account id, no token, no broker order or trade id, and no
balance or NAV figure. Every number in it is either source code, a stored backtest result,
or documentation of a measurement.

---

## Honesty commitments

- Nothing states a performance figure that cannot be reproduced from stored data. Where a
  figure is negative, it is published as negative.
- Backtests are dated, with their assumptions and excluded costs named, and a held-out
  period reported separately. No parameter sweeps to find a flattering combination.
- A held-out period that looks good on a handful of trades is labelled noise, next to the
  number.
- Our own results are reported as our own measurement until an independent audit says
  otherwise.
- A failing source shows as unavailable — never stale numbers passed off as current.
- An order request is not a trade. A successful Practice connection is never presented as
  evidence of profitability.
