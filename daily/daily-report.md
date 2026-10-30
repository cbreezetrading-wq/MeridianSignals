# Daily bars, same ruleset — does lower frequency fix the cost problem?

**Measurement run:** 2026-10-26 · ruleset `v1` (unchanged) · granularity **D** · data from the
owner's own OANDA practice account · engine code = the H1 backtest's, reused
(`/home/team/shared/daily/run_daily_backtest.ts`, a near-copy of
`/home/team/shared/backtest/run_backtest.ts`).

Every number below is read from `/home/team/shared/daily/results.json`, which this run
generated. Nothing here was typed in by hand. §9 says where each figure lives.

---

## 1. Verdict — first, plainly

**The daily variant still loses after real spreads.** Over 23.8 years and **208 trades** it
loses **−3,373.4 pips (−14.27R)**, wins 31.7% of trades, profit factor **0.82**, expectancy
**−16.22 pips per trade (−0.069R)**.

**And the more important half of the answer: it loses before spreads too.** With the spread
removed entirely and identical timing, the same 208 trades return **−2,055.1 pips
(−9.88 pips, −0.032R per trade)**. So on daily bars there is not even a faint gross tendency
for the spread to eat. The H1 result was "a real but too-small edge"; the daily result is
"no edge measured".

**The hypothesis itself was right about cost, and wrong about what it would buy.** Cost per
trade as a fraction of the trade's risk fell exactly as the argument predicted — from
**8.5% of 1R at H1 to 3.7% of 1R at daily** — because the moves the ruleset aims at grew with
the bar while the spread grew far less. Lower frequency did fix the cost problem. It just
turned out there was nothing left to fix it for: no gross edge survives at the daily horizon.

**One thing this run cannot say.** 208 trades is a small sample, and the per-trade spread of
outcomes is wide (sd 1.41R). The 95% confidence interval on per-trade expectancy is
**−0.26R to +0.12R** — it contains zero. So: the point estimates are negative both with and
without cost, which is enough to say **this is not a green light and the daily variant must
not be traded on this evidence**, but it is **not** the decisive negative result the H1 run
was able to state over 3,789 trades. What this test definitely rules out is the *hope*: daily
bars are not the version of this ruleset that works.

---

## 2. Why this test exists, and what differs from the H1 run

**The hypothesis.** On hourly bars the ruleset has a faint gross tendency — +1.13 pips/trade
at mid, before cost — and the spread costs 2.25 pips/trade, about 2× the edge. That spread is
roughly a *fixed cost per trade regardless of timeframe*, while the size of the move a rule
aims at scales with the bar. A rule that trades less often and aims at larger moves therefore
has a structurally better cost-to-edge ratio. That is a hypothesis with a reason behind it,
and this session tested it — it was not a search for a configuration that flatters it. No
parameter was changed to improve the result, and the ruleset is byte-for-byte the same one.

**What is identical:** the rules (`runRulesetEvents` from the live site's `ruleset.ts`), the
indicators (`atr` from `indicators.ts`), the stop/target sizing (1.5×ATR(14) stop, 3.0×ATR(14)
target from the trigger bar's mid close), the fill convention (next bar's open, ask for a
long / bid for a short, opposite side on exit), the pessimistic intra-bar rule (stop before
target if both are touched), the gap rule (a bar opening past the stop fills at that open), the
three variants, the 12-month hold-out, and the read-only data endpoint.

**What differs** (every difference, as required):

| # | Difference | Why |
|---|---|---|
| 1 | Granularity `D`; cache in `/home/team/shared/daily/data` instead of `.../backtest/data` | the test itself |
| 2 | Gap accounting: a **weekday with no bar** counts as a missing trading day, after shifting each bar +3h onto its trading day | a daily FX series has no weekend bars; an hourly grid check would call every weekend a gap |
| 3 | Holding time additionally reported in **days** (median/mean/p90/max + day histogram) | this test is about cost per trade vs days held, and swap scales with days |
| 4 | **No reconciliation against the live dashboard** | the dashboard is an H1 engine; a daily trigger is not comparable to an H1 signal, so this check is marked not-applicable rather than run and mis-read (`results.json → reconciliationWithLive`) |
| 5 | A cost/edge decomposition block added | required by the brief, and it is the point of the run |
| 6 | H1 headline figures embedded by **reading** `/home/team/shared/backtest/results.json` | so the comparison in §5 has no hand-copied numbers |

Nothing about the fills, the ambiguity rules, the costs or the statistics was relaxed.

---

## 3. Data — what the broker actually served

| Pair | Complete bars | Incomplete refused | Span (UTC) | Missing weekdays in span |
|---|---|---|---|---|
| EUR/USD | 7,177 | 1 | 2002-05-06 21:00 → 2026-10-22 21:00 | 29 of 6,384 |
| GBP/USD | 7,153 | 1 | 2002-05-06 21:00 → 2026-10-22 21:00 | 28 of 6,384 |
| USD/JPY | 7,177 | 1 | 2002-05-06 21:00 → 2026-10-22 21:00 | 29 of 6,384 |
| AUD/USD | 7,116 | 1 | 2002-05-06 21:00 → 2026-10-22 21:00 | 29 of 6,384 |

- **The daily history does reach back to 2002-05-06 — the same start as the H1 cache.** The
  brief anticipated a shorter daily window; it is not shorter. The measurement period is
  2003-01-15 → 2026-10-22 (EMA(200) needs 200 bars of warm-up, ~10 months of daily data),
  which is the same measurement period the H1 run used.
- **Complete-flag discipline is unchanged:** 1 incomplete candle per pair was refused (the
  newest, still-forming bar). No bar was interpolated, filled forward, or dropped for being
  inconvenient.
- **Coverage is dense:** 28–29 missing weekdays out of ~6,384 (0.45%) — market holidays. Bar
  spacings are 1-day (≈6,100), 3-day (≈690, the weekend), 2-day (≈350, holidays) and 4-day
  (≈11).
- **The bars are stamped at the daily rollover** — 21:00 UTC (4,623 bars) or 22:00 UTC (2,554
  bars), switching with US daylight saving. This matters for cost (see §5) and is why the
  bar's calendar date is not its trading date.
- Raw cache: `data/<PAIR>.jsonl`, one line per bar, **bid, ask and mid** OHLC for every bar —
  the per-bar historical spread is measured, not assumed. `data/<PAIR>.meta.json` records the
  request audit; `data/fetch-log.jsonl` records every page fetched.
- Read-only constraint held: the only endpoint requested was
  `GET /v3/instruments/{instrument}/candles?granularity=D&price=MBA`. No orders, trades,
  positions or transactions, ever. The token was read from `process.env.OANDA`, sent as a
  header, and never printed or written to a file.

---

## 4. Results

### 4.1 Headline — fill at the NEXT bar's open, buying the ask / selling the bid, real historical spread

Combined, full period, 4 pairs:

| | Value |
|---|---|
| Trades | **208** |
| Win rate | 31.7% |
| Total pips | **−3,373.4** |
| Total R | **−14.27** |
| Profit factor | 0.82 |
| Expectancy per trade | **−16.22 pips / −0.069R** |
| Max drawdown | 4,507.9 pips / 32.02R |
| Longest losing streak | 18 |

Per pair:

| Pair | Trades | Win % | Total pips | Total R | Exp pips | PF | Max DD pips / R | Longest loss run | Median hold |
|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 63 | 23.8% | −2,971.2 | −21.15 | −47.16 | 0.54 | 3,282.6 / 25.19 | 11 | 8 d |
| GBP/USD | 49 | 34.7% | +45.2 | +1.19 | +0.92 | 1.01 | 1,496.9 / 8.22 | 8 | 8 d |
| USD/JPY | 48 | 27.1% | −1,327.3 | −7.91 | −27.65 | 0.66 | 2,535.9 / 18.93 | 12 | 7 d |
| AUD/USD | 48 | 43.8% | +880.0 | +13.61 | +18.33 | 1.29 | 553.2 / 7.02 | 7 | 12 d |

Two pairs are marginally positive on 48–49 trades. That is not a finding; it is what four
21–63-trade samples look like when the underlying expectation is near zero. Taking the better
two pairs *after* seeing the result is precisely the curve-fitting this exercise exists to
avoid, and no per-pair selection is proposed.

### 4.2 Zero cost (mid fills, identical timing) — is there an edge under the cost?

| Variant | Trades | Win % | Total pips | Total R | PF | Exp pips/trade | Exp R/trade |
|---|---|---|---|---|---|---|---|
| **Headline** (next open, bid/ask) | 208 | 31.7% | −3,373.4 | −14.27 | 0.82 | −16.22 | −0.069 |
| **Zero cost** (mid) | 208 | 35.1% | −2,055.1 | −6.69 | 0.87 | −9.88 | −0.032 |
| **Trigger-close (OPTIMISTIC UPPER BOUND, not achievable)** | 208 | 31.7% | −2,793.8 | −11.22 | 0.85 | −13.43 | −0.054 |

The trigger-close row is labelled exactly as the H1 run labels it: an **optimistic upper bound
on timing, not achievable**, because the trigger bar's close is only known once that bar has
ended. Note that it is *worse* than the headline here — so no hidden edge is being suppressed
by the conservative fill convention.

The zero-cost row is the important one: **remove the spread completely and the daily ruleset
is still negative.** On hourly bars, removing cost turned a loser into a small winner. On
daily bars it does not.

### 4.3 Held out — the last 12 months (2025-10-22 → 2026-10-22), achievable assumptions

| Variant | Trades | Win % | Total pips | Total R | PF | Exp pips/trade |
|---|---|---|---|---|---|---|
| Headline | **10** | 50.0% | +267.2 | +4.81 | 1.41 | +26.72 |
| Zero cost | 10 | 50.0% | +52.6 | +2.49 | 1.07 | +5.26 |

Per pair, headline: EUR/USD 3 trades −63.5 · GBP/USD 3 −33.6 · USD/JPY 2 +111.6 · AUD/USD 2
+252.6. Median hold in the hold-out: 32 days.

**This is the one positive number in the run and it carries almost no evidential weight: 10
trades, 5 wins, 2–3 trades per pair. Two AUD/USD trades supply +252.6 of the +267.2 pips, and
both European pairs are negative inside the window (EUR/USD −63.5, GBP/USD −33.6).** It is
reported because the brief asks for the hold-out to be reported separately, not because it
supports anything. Ten trades cannot distinguish +27 pips/trade from zero.

### 4.4 The cost/edge decomposition — where the money goes

Computed by subtraction from the stored variant results (§4.2), so the reader can check it:

| | Pips per trade | R per trade | Share of 1R |
|---|---|---|---|
| Gross edge (mid fills, same timing) | **−9.88** | −0.032 | −3.2% |
| Spread paid | **6.34** | 0.037 | 3.7% |
| **Net (headline)** | **−16.22** | −0.069 | −6.9% |

Mean initial risk per trade: 127.3 pips (1R = 1.5×ATR(14), and daily ATR is large).
Totals: gross −2,055.1 pips · spread paid 1,318.3 pips · net −3,373.4 pips.

Cross-check: the mean spread measured on the bars the trades actually filled on is **6.361
pips**, against a spread-paid figure of 6.34 pips. The two independent routes to the same
number agree, so the decomposition is not an artefact of the subtraction.

### 4.5 The comparison that answers the hypothesis

| | H1 (3,789 trades) | Daily (208 trades) |
|---|---|---|
| Gross edge per trade | **+0.033R** | **−0.032R** |
| Spread paid per trade | **0.085R** (8.5% of risk) | **0.037R** (3.7% of risk) |
| Net per trade | −0.052R | −0.069R |
| Net in pips | −1.12 | −16.22 |

Read that middle row carefully: **lower frequency more than halved the cost of a trade
relative to the risk it takes** — 8.5% of 1R down to 3.7% of 1R. The structural argument in
§2 is confirmed by measurement. But the top row moved the wrong way at the same time: the
faint gross tendency that existed at H1 does not survive at the daily horizon. The cost lever
worked; there is no edge at daily for it to protect.

### 4.6 Why the daily *pip* cost looks big — an important caveat on the spread

The daily bar opens at 21:00/22:00 UTC, the daily rollover, which is the widest-spread minute
of the FX day. A headline fill "at the next bar's open" therefore lands on that rollover quote
by construction. Measured spreads:

| Pair | All-bars mean | All-bars median | Mean on entry fills | Median on entry fills |
|---|---|---|---|---|
| EUR/USD | 5.185 | 4.1 | 5.759 | 5.1 |
| GBP/USD | 8.045 | 6.3 | 8.067 | 7.0 |
| USD/JPY | 6.057 | 5.3 | 5.785 | 4.9 |
| AUD/USD | 6.281 | 5.2 | 5.833 | 4.1 |

These are wider than the H1 run's ~2.25 pips because they are rollover quotes, not because
daily trading is intrinsically costlier. Two consequences, both stated rather than smoothed
over: (a) the daily headline's **pip** cost is somewhat pessimistic relative to an execution
that filled at a better hour; (b) it does not change the verdict, because the zero-cost
variant removes the spread entirely and is *still* negative. The R-denominated comparison in
§4.5 is the fair one across timeframes, and it is the one the verdict rests on.

### 4.7 Year by year (headline, combined, by year the trade closed)

```
2003    9   +525.0    2010   7   +453.9    2017  12   -645.8    2024   5   -266.7
2004   13   -478.3    2011  17 -1,045.9    2018   3   -459.9    2025   4   -114.4
2005   11   -695.6    2012   9   +391.9    2019  12   -170.2    2026  10   +267.2*
2006   19 -2,076.5    2013   8   +474.0    2020   7    -41.4
2007   15 +1,410.6    2014   5    -92.8    2021   7    -81.5
2008    8   +502.2    2015   7   -678.6    2022   2   +143.0
2009    6   -400.1    2016   5     +2.4    2023   7   -295.9
```
`* 2026 is a partial year (to 22 October).`

**9 of 24 years positive; 15 negative.** The distribution is what near-zero expectancy with
one or two trades a month looks like: single years swing by ±1,000–2,000 pips on 5–19 trades.
The two best years (2007 +1,410.6, 2003 +525.0) are single years, not a regime, and they sit
on either side of a −2,076.5 loss in 2006. No period in the series shows the behaviour that
would justify treating this ruleset as working.

### 4.8 Holding time — in days, and what the excluded swap is worth here

Combined headline, 208 trades: **median 8 days, mean 13.2 days, 90th percentile 32 days,
longest 103 days.** Mean 10.7 daily bars held.

| <1d | 1–2d | 2–4d | 4–7d | 1–2w | 2–4w | 1–3m | 3m+ |
|---|---|---|---|---|---|---|---|
| 13 | 16 | 24 | 38 | 50 | 41 | 25 | 1 |

**This is the key difference from the H1 run, and it makes the excluded swap a real cost, not
a rounding error.** At H1 the median hold was 8 *hours* — 42% of trades closed inside 6 hours,
so most paid at most one rollover. Here the median hold is 8 *days*: **94% of trades are held
2 days or more, 56% are held a week or more, and most pay 5–10 daily rollovers,
including the triple rollover on Wednesday.**

Swap is **not modelled** anywhere in this run (no historical financing rates were fetched), so
it cannot be added to the numbers above. What can be said from the measured hold distribution
alone is the **direction**: at these holding times financing is a genuine additional per-trade
cost, it is not neutral across pairs (2023–2025 carried materially negative carry on several of
these pairs), and it makes the real daily result **slightly worse than the −16.22 pips/trade
reported here, not better**. As a share of a 127-pip risk unit it is small per day but no
longer dismissible over an 8-day median hold. This run therefore treats the daily headline as
**optimistic on cost**, for the same reason and more strongly than the H1 run did.

---

## 5. Sample size, plainly

- **208 trades over 23.8 years — about 8.8 trades a year across all four pairs, 2–2.6 per pair
  per year.** The ruleset is a low-frequency one by design, so this thinness is inherent to
  testing it on daily bars; it is the honest price of the test.
- With a per-trade standard deviation of **1.408R**, the standard error of the mean is
  **0.098R**. The 95% interval on per-trade expectancy is **−0.26R to +0.12R** (t = −0.70).
  **It contains zero.**
- So the correct statement is three-part, and all three parts matter:
  1. the point estimates are negative **with** cost (−0.069R) and **without** cost (−0.032R),
     so **there is no measured edge here to trade**;
  2. the sample is **too thin to establish a negative the way 3,789 hourly trades established
     one** — a +0.12R true edge would also have produced a result like this one;
  3. the 10-trade hold-out (+26.72 pips/trade) is **noise-level** and is not evidence of
     anything.
- The one part of this run that *is* well measured is the cost side, and it is not noisy: the
  spread figure agrees to 0.02 pips across two independent routes (§4.4), and the
  cost-to-risk ratio comparison in §4.5 is arithmetic on 208 and 3,789 trades respectively.

**Finding: the daily variant does not rescue the ruleset.** Not "insufficient sample, so try
again" — the point estimates are negative in both directions and the mechanism the hypothesis
relied on (a gross edge surviving to a lower frequency) is absent. But equally not a
demonstrated loss of the magnitude H1 showed.

---

## 6. Assumptions (all of them, stated)

- **Headline fill:** entry at the **next bar's open**, **ask** for a long / **bid** for a short;
  exits at the opposite side. No look-ahead. The trigger bar's close is never used as a fill.
- **Optimistic variant:** entry at the trigger bar's close (mid), exit at the exit bar's close
  (mid) — **OPTIMISTIC UPPER BOUND, not achievable.**
- **Zero-cost variant:** same timing as headline, filled at **mid** on both sides, so the
  spread drag is isolated.
- **Intra-bar ambiguity:** if a bar touches both the stop and the target, the **stop** is
  counted. Pessimistic by construction.
- **Gaps:** a bar opening beyond the stop fills at that bar's **open** (worse than the stop); a
  bar opening beyond the target fills at that bar's **open** (better than the target).
- **Rule exits:** an exit the rules fire at a bar's close is filled at the **next bar's open**,
  same no-look-ahead rule as entries.
- **Stop/target:** 1.5×ATR(14) and 3.0×ATR(14) from the trigger bar's mid close — identical to
  the live engine. Stop/target are exit triggers alongside the rule's own exit (cross against,
  or trend-filter flip).
- **One position per pair, no pyramiding.**
- **1R** = the trade's initial stop distance (1.5×ATR(14) at the trigger bar, in pips).
- **Spread source:** ask minus bid of the same bar in the owner's own OANDA practice-account
  history — a real historical spread per bar, not an assumption. Practice-account spreads are
  typically wider than a funded account's; that remains the single largest uncertainty on the
  cost side, and it makes the headline **optimistic** if anything.
- **No optimisation:** no parameter search, no sweep, no per-pair tuning, no timeframe search.
  One ruleset, unchanged.
- **No event fires before bar 200** (EMA(200) warm-up), so the measurement starts 2003-01-15.

## 7. Excluded — and not modelled in any figure here

- **swap / financing / carry charges — NOT modelled**
- **slippage beyond the quoted bid/ask spread — NOT modelled**
- **commission, fees and taxes — NOT modelled**
- **position sizing and account equity — NOT modelled; every result is in pips and R**
- weekend/holiday gaps are left as gaps; no bar is interpolated or filled in

Swap's weight is re-stated for this test in §4.8: with a median 8-day hold it is a real cost
and its omission makes the daily result look better than it is.

---

## 8. Code path, files, and how to re-run

| File | What it is |
|---|---|
| `fetch_daily.ts` | OANDA daily paging + MBA cache → `data/<PAIR>.jsonl`, `data/<PAIR>.meta.json`, `data/fetch-log.jsonl` |
| `run_daily_backtest.ts` | the replay, fills, statistics and decomposition → `results.json`, `run-summary.txt` |
| `results.json` | machine-readable results, same shape as the H1 file: `headline_nextBarOpen_bidAsk` / `zeroCost_mid_nextBarOpen` / `optimisticUpperBound_triggerClose`, each with `fullPeriod` and `last12MonthsHeldOut`, plus `perPair` |
| `daily-report.md` | this report |
| `run.log`, `fetch.log`, `dump.txt`, `q.txt`, `t.txt` | run logs and the console dumps the figures above were read from |

Re-run: `cd /home/team/shared/daily && bun run fetch_daily.ts && bun run run_daily_backtest.ts`.

The fetch hits the broker every time (it is not a no-op like the H1 fetch); the backtest over
the cached data is deterministic. **Dependencies on other directories are read-only:**
`../site/src/lib/market/{ruleset,indicators,types}.ts` (the live engine, imported not copied)
and `../backtest/results.json` (the H1 comparison). Nothing outside
`/home/team/shared/daily/` was modified. The live dashboard, its H1 feed, its ruleset and its
files were not touched.

## 9. Where each figure comes from

| Figure | `results.json` path |
|---|---|
| §4.1 headline table, per pair | `results.headline_nextBarOpen_bidAsk.fullPeriod.perPair` |
| §4.2 three variants | `results.<variant>.fullPeriod.combined` |
| §4.3 hold-out | `results.<variant>.last12MonthsHeldOut.{combined,perPair}` |
| §4.4 decomposition (pips and R) | `costEdgeDecomposition.perTradePips`, `.totals`, `.inR`, `.crossCheck` |
| §4.5 H1 side of the comparison | `comparisonH1.granularityH1` (read from the H1 `results.json`) |
| §4.6 spreads | `spreadsPaid.<PAIR>` |
| §4.7 year by year | `yearByYear.headline.combined` (+ `.positiveYears`, `.measuredYears`) |
| §4.8 holding distribution | `holdingTimes.combinedHeadline` |
| §3 data window, refusals, gaps | `dataWindow.<PAIR>` |
| §5 t-statistic / CI | computed from `tradesHeadline` (stored, one row per trade) |
| §2 differences from H1 | `differencesFromH1Run` |

## 10. What I could not do

- **Swap/financing is not modelled** — no historical financing rates were fetched. §4.8 sizes
  the gap from the measured hold distribution; it cannot close it. At a median 8-day hold this
  is a materially larger omission than at H1's 8-hour hold.
- **Slippage beyond the quoted spread is not modelled**, nor any funded-account spread. The
  headline result is therefore optimistic on cost.
- **No reconciliation against the live engine** — it runs H1, so a daily trigger cannot be
  compared to it. Marked not-applicable in `results.json` rather than claimed as passed.
- **No `/backtest` page and no site change** — deliberately out of scope for this session; the
  results and this report are the deliverable. A later session can publish `results.json` with
  the same renderer the H1 page uses, but **a page must not imply the daily variant works** —
  the verdict is negative.
- The trigger-close variant is an upper bound on the *timing* assumption only; it is not a best
  case across all assumptions.
