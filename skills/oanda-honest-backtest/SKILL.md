---
name: oanda-honest-backtest
description: "How to run an honest rules-based backtest on the owner's OANDA history (H1 or daily) and publish its result, in this team's house style: real bid/ask spreads, next-bar-open fills, three variants, held-out period, negative results reported as negative."
---

# Honest backtest on the owner's OANDA data (Meridian Signals)

Two working harnesses already exist — **reuse them, do not rewrite**:

| Granularity | Directory | Fetch | Replay |
|---|---|---|---|
| H1 (2002-05-06 → ~now, ~139k bars) | `/home/team/shared/backtest/` | `fetch_history.ts` | `run_backtest.ts` |
| Daily (2002-05-06 → ~now, ~7.2k bars) | `/home/team/shared/daily/` | `fetch_daily.ts` | `run_daily_backtest.ts` |

Both import the **live** engine read-only (`../site/src/lib/market/ruleset.ts` →
`runRulesetEvents`, `indicators.ts` → `atr`) so a backtest cannot drift from the dashboard.
To add another granularity, copy the nearest pair and change only: `granularity=`, `OUT_DIR`,
`MAX_PAGES`, the bar-grid gap rule, and the holding-time units — then list every difference in
the report's "what differs" table.

## Non-negotiables (the team's honesty commitments)
- Only `GET /v3/instruments/{instrument}/candles?price=MBA` — never orders/trades/positions.
  Token from `process.env.OANDA`, sent as a header, never printed or written to disk.
- **`price=MBA`** (mid + bid + ask). The per-bar historical spread is the whole point; bid/ask
  fills without real spreads are a fiction.
- Refuse `complete:false` bars and count them. Never interpolate a gap.
- Headline fill = **next bar's open**, ask for a long / bid for a short. The trigger bar's
  close is never a headline fill (it is the labelled *optimistic upper bound* variant).
- Exit the stop before the target when a bar touches both. A bar opening past the stop fills
  at that open.
- Three variants every time: `headline_nextBarOpen_bidAsk`, `zeroCost_mid_nextBarOpen`,
  `optimisticUpperBound_triggerClose`; each with `fullPeriod` and `last12MonthsHeldOut`, plus
  `perPair`, so a later session can render it with the existing `/backtest` renderer.
- No parameter sweeps, no per-pair tuning, no timeframe search to find a flattering result.

## Gotchas learned the hard way
- **Daily bars are stamped at the 21:00/22:00 UTC rollover**, so a Sunday-stamped bar is
  Monday's session. Shift **+3h** onto a UTC midnight before any weekday-gap check, or you
  will report ~1,000 phantom "missing weekdays". The daily cache spans 2002-05-06 → now
  (7,116–7,177 complete bars per pair; ~28–29 genuinely missing weekdays).
- Because the daily bar opens at the rollover, a headline daily fill lands on the
  **widest-spread minute of the day** (EUR/USD ≈5.8 pips at fills vs 4.1 median). Say so
  plainly, and lead the cross-timeframe comparison with **R**, not pips: cost as a fraction of
  1R is 8.5% at H1 and 3.7% at daily, while a pip figure is not comparable across timeframes.
- Compute the cost/edge decomposition **by subtraction** between the zero-cost and headline
  variants, then cross-check it against the mean spread measured on the fill bars (they agree
  to ~0.02 pips).
- Report holding time in the unit that decides swap: H1 median 8 **hours**; daily median 8
  **days** (94% of trades held ≥2 days) — swap is excluded but is no longer negligible.
- Sample size: daily yields only ~208 trades in 24 years (2–2.6 per pair per year). Store
  `tradesHeadline` and compute the CI on per-trade R before claiming anything; "insufficient
  sample" is a legitimate finding and must be said instead of claiming an edge.
- Run `bun run ... > log.txt 2>&1` and read the log — the terminal view can show stale
  scrollback on this box.
- Write results to `/home/team/shared/<topic>/`, **never `/tmp`** (wiped on machine replace).
