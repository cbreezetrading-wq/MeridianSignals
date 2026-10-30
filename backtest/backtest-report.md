# Meridian Signals — honest backtest of the H1 ruleset on the owner's OANDA history

**Run:** 2026-10-12T17:15Z · **Ruleset version:** v1 (unchanged, no parameters tuned)
**Owner's instruction:** "Keep it hourly for now — go ahead and run the honest backtest on my OANDA history instead." Hourly H1 only. No timeframe sweep.

This is a measurement, not a claim. **The headline result is negative.** The zero-cost
variant is mildly positive and the spread takes all of it and more. Nothing here is an
edge claim, and the sample size question is answered explicitly in §7.

---

## 1. Data — what OANDA actually served

Four majors, `granularity=H1`, `price=MBA`, paged backwards with `to=` + `count=5000`
(112 requests in total). Only candles OANDA flagged `complete: true` were kept.

| Pair | First bar (UTC) | Last bar (UTC) | Complete bars | `complete:false` refused |
|---|---|---|---|---|
| EUR/USD | 2002-05-06T20:00Z | 2026-10-12T16:00Z | 138,999 | 1 |
| GBP/USD | 2002-05-06T20:00Z | 2026-10-12T16:00Z | 138,789 | 1 |
| USD/JPY | 2002-05-06T20:00Z | 2026-10-12T16:00Z | 138,900 | 1 |
| AUD/USD | 2002-05-06T20:00Z | 2026-10-12T16:00Z | 138,816 | 1 |

**Earliest timestamp OANDA will serve: 2002-05-06T20:00Z** on all four pairs — that is
the broker's floor, hit by the paging stopping on a short final page (the last page
returned fewer than 5,000 candles), not by our request window. ~24.4 years of hourly
history, which is far more than we assumed we would get.

The one `complete:false` bar per pair is the forming bar at fetch time (17:00Z was still
open when we fetched at ~17:14Z). It is excluded, never filled in — same rule the live
dashboard enforces. Weekend/holiday gaps are left as gaps; no bar is interpolated.

Raw cache (re-runnable without re-fetching): `/home/team/shared/backtest/data/<PAIR>.jsonl`,
one array per line `[t, mid o/h/l/c, ask o/h/l/c, bid o/h/l/c]`, plus `<PAIR>.meta.json`
and `fetch-log.jsonl` (per-page audit). 57 MB total.

**Measurement period for the ruleset: 2003-01-15T20:00Z → 2026-10-12T16:00Z.** The first
~200 bars are warm-up: EMA(200) is undefined before bar index 199, so the engine cannot
produce an event earlier. That is not a choice we made, it is the ruleset's own requirement.

## 2. The engine — same code as live, not a re-implementation

The rules and the indicator maths are imported, not copied:

- `/home/team/shared/site/src/lib/market/ruleset.ts` → `runRulesetEvents` (EMA(50)/EMA(200)
  trend filter; EMA(20)/EMA(50) cross entry in the trend's direction; exit on a cross
  against the position or a trend-filter flip)
- `/home/team/shared/site/src/lib/market/indicators.ts` → `ema`, `atr` (Wilder's)

`runRulesetEvents` is a new **export** added to the live file: the existing `runRuleset`
was refactored into a thin view over it, with behaviour unchanged (it still returns the
last event and the current state; the dashboard's call site is untouched). This was done
so an offline replay consumes the *exact* event stream the dashboard walks — a backtest
that re-implements the rules by hand is a backtest that can silently disagree with live.

Stop = 1.5 × ATR(14) and target = 3.0 × ATR(14), both from the trigger bar's mid close —
identical formulas to the live engine. Both are also treated as **exit triggers** (the
live state machine only exits on a cross against / trend flip, and shows stop and target
as levels).

**No optimisation of any kind.** No parameter search, no sweep, no alternative
timeframe. One ruleset, exactly as documented in `ruleset.md`. There is no robustness
table in this report because none was run — there is nothing exploratory to separate
from the headline.

## 3. Execution and costs

Headline fills (the only ones claimed achievable):

- **Entry:** the OPEN of the bar **after** the trigger bar — ASK for a long, BID for a short.
  The trigger bar's close is only knowable once that bar has finished, so it is never used.
- **Exit at the opposite side** (BID to close a long, ASK to close a short).
- **An exit the rules trigger at a bar's close fills at the NEXT bar's open** — same
  no-look-ahead rule as entries.
- **Intra-bar ambiguity, pessimistic:** if a bar's range touches both stop and target,
  the **STOP** is counted. If a bar opens beyond the stop, the fill is that bar's **open**
  (worse than the stop); a bar opening beyond the target fills at the open (better).
- One position per pair at a time. No pyramiding.

**Average spread actually paid** (from the bid/ask in the candle data; practice-account
quotes, a funded account's are typically tighter):

| Pair | Spread, all bars (mean / median) | Spread at entry fills (mean / median) | Round-trip spread cost per trade |
|---|---|---|---|
| EUR/USD | 1.90 / 1.40 pips | 1.73 / 1.40 pips | 1.21 pips |
| GBP/USD | 3.03 / 2.10 pips | 2.67 / 2.10 pips | 3.99 pips |
| USD/JPY | 2.09 / 1.60 pips | 2.01 / 1.60 pips | 2.80 pips |
| AUD/USD | 2.18 / 1.60 pips | 1.98 / 1.60 pips | 1.94 pips |

**EXCLUDED — not modelled in any number below:** swap/financing charges, slippage beyond
the quoted spread, commission, taxes, and all position sizing (everything is in pips and R).
Weekend gaps are left as gaps. These exclusions make the headline figure *optimistic*, not
conservative.

## 4. The numbers

n = 3,789 completed trades, 2003-01-15 → 2026-10-12 (~23.7 years), four pairs pooled.

### 4.1 Headline — next-bar-open fills at bid/ask

| | EUR/USD | GBP/USD | USD/JPY | AUD/USD | **Combined** |
|---|---|---|---|---|---|
| Trades | 961 | 943 | 939 | 946 | **3,789** |
| Wins / Losses | 312 / 649 | 287 / 656 | 312 / 627 | 314 / 632 | **1,225 / 2,564** |
| Win rate | 32.5% | 30.4% | 33.2% | 33.2% | **32.3%** |
| Avg win | +57.1 pips | +67.9 | +54.7 | +48.9 | **+56.9** |
| Avg loss | −28.6 pips | −35.4 | −27.1 | −24.0 | **−28.8** |
| Expectancy/trade | −0.77 pips | −3.95 | +0.05 | +0.19 | **−1.12 pips** |
| Total pips | −739.2 | −3,728.8 | +51.1 | +175.9 | **−4,241.0** |
| Avg R / Total R | −0.038 / −36.6 | −0.110 / −103.8 | −0.029 / −27.2 | −0.032 / −29.9 | **−0.052 / −197.6** |
| Max drawdown | 1,362 pips / 50.9R | 4,140 pips / 112.2R | 2,066 pips / 76.0R | 1,688 pips / 78.3R | **5,988 pips / 208.8R** |
| Profit factor | 0.96 | 0.84 | 1.00 | 1.01 | **0.94** |
| Longest losing streak | 19 | 14 | 16 | 14 | **24** |

Exit mix (combined): **stop 2,330 · target 1,219 · cross-against 240 · trend-flip 0.**
Note that the stop is hit roughly twice as often as the target even though the target is
twice as far away — the rule exits a fair number of trades by the cross before either is
reached, and the 32% win rate is *below* the 33.3% break-even a 1:2 risk-reward needs
once costs are counted.

### 4.2 Zero-cost — same timing, MID on both sides (isolates the spread)

| | EUR/USD | GBP/USD | USD/JPY | AUD/USD | **Combined** |
|---|---|---|---|---|---|
| Win rate | 37.3% | 36.6% | 37.7% | 37.9% | **37.4%** |
| Expectancy/trade | +1.05 pips | +0.23 | +1.87 | +1.39 | **+1.13 pips** |
| Total pips | +1,005.9 | +212.2 | +1,751.3 | +1,319.6 | **+4,289.1** |
| Total R | +38.8 | +13.6 | +45.4 | +27.8 | **+125.5** |
| Profit factor | 1.06 | 1.01 | 1.12 | 1.10 | **1.07** |
| Max drawdown | 1,133 pips / 44.4R | 1,427 / 28.4R | 1,364 / 39.5R | 1,025 / 44.9R | **1,463 pips / 49.0R** |

### 4.3 Optimistic upper bound — trigger-close fills, mid

**Labelled OPTIMISTIC. Not achievable in practice** — it fills at the trigger bar's close,
a price only knowable after that bar has ended. It exists purely so the size of that
assumption is visible.

| | EUR/USD | GBP/USD | USD/JPY | AUD/USD | **Combined** |
|---|---|---|---|---|---|
| Win rate | 33.7% | 32.6% | 34.1% | 34.2% | **33.7%** |
| Expectancy/trade | +1.00 pips | −0.91 | +1.60 | +1.91 | **+0.90 pips** |
| Total pips | +961.6 | −860.5 | +1,504.2 | +1,810.8 | **+3,416.2** |
| Total R | +37.7 | −6.0 | +37.8 | +46.3 | **+115.7** |
| Profit factor | 1.05 | 0.96 | 1.09 | 1.13 | **1.05** |

### 4.4 The cost decomposition — where the money goes

| Variant | Total pips | Total R | PF |
|---|---|---|---|
| Headline (next-bar open, bid/ask) | **−4,241.0** | **−197.6** | 0.94 |
| Zero-cost (next-bar open, mid) | +4,289.1 | +125.5 | 1.07 |
| Optimistic (trigger close, mid) | +3,416.2 | +115.7 | 1.05 |

- **Spread drag: 8,530 pips** over 3,789 trades — about **2.25 pips per trade**. That is
  larger than the zero-cost edge of 1.13 pips per trade by a factor of two. The ruleset's
  gross signal is real; the cost of taking it is bigger.
- **Delay effect (zero-cost minus optimistic): 873 pips** — the one-bar wait to fill costs
  something too, but an order of magnitude less than the spread. Notably the *optimistic*
  variant is worse than the zero-cost one, i.e. the trigger-bar close is not a better fill
  than the next bar's open here; the "look-ahead" assumption buys no advantage.

### 4.5 Held out — the most recent 12 months (2025-10-12 → 2026-10-12)

Reported separately, and this window was never used to choose anything.

| Variant | Trades | Win rate | Expectancy | Total pips | Total R | PF | Max DD |
|---|---|---|---|---|---|---|---|
| Headline | 173 | 28.3% | −4.73 pips | −819.0 | −30.54 | **0.70** | 819 pips / 30.5R |
| Zero-cost | 173 | 34.7% | −1.30 pips | −225.2 | −1.83 | 0.90 | 381 pips / 12.1R |
| Optimistic | 173 | 30.6% | −2.17 pips | −374.7 | −9.02 | 0.85 | 516 pips / 17.6R |

**The recent year is worse than the long run on every variant, including zero-cost.** The
zero-cost variant's long-run profit is concentrated in the distant past, not the present.
Per-pair headline holdout: EUR/USD 35 trades −52.6 pips · GBP/USD 44 −279.4 · USD/JPY 49
−359.1 · AUD/USD 45 −127.9.

### 4.6 Year by year (headline, combined) — one lucky stretch is visible, and it is not recent

```
2003   9  +525.0     2010 185  +468.9     2017 162  +767.4     2024 181   +86.5
2004  13  -478.3     2011 197   +14.6     2018 166  -447.5     2025 165  -629.7
2005 159  -589.9     2012 178  +117.9     2019 171  -675.7     2026 140  -657.1*
2006 169  -574.3     2013 171  -403.0     2020 151  -489.7
2007 171  -477.4     2014 160  -293.6     2021 176  -104.6
2008 191  -749.8     2015 176  -591.8     2022 180 +1255.6
2009 181  -648.8     2016 162  -352.1     2023 175  +686.3
```
`* 2026 is a partial year (to 12 October).` 8 of 24 years positive; 16 negative. The two
best years (2022 +1,255.6, 2017 +767.4) are single years, not a regime, and they are
outweighed by the run of losses around them. The last three full-or-partial years
(2024 +86.5, 2025 −629.7, 2026 −657.1) do not support the idea that the edge has improved.

### 4.7 Holding times — how much the excluded swap might matter

Combined headline, 3,789 trades: **median 8 hours, mean 16.5 hours, 90th percentile 52
hours, longest 264 hours (11 days).**

| <6h | 6–12h | 12–24h | 1–2d | 2–4d | 4–7d | 1–2w | 2w+ |
|---|---|---|---|---|---|---|---|
| 1,583 | 712 | 831 | 261 | 334 | 61 | 7 | 0 |

Forty-two percent of trades are closed inside 6 hours and 87% inside 2 days. So most
trades pay at most one or two daily rollovers — swap is unlikely to change the sign of
the headline result, but on the ~10% of trades held more than 2 days it is a real
additional cost that this run does not include. The 2023–2025 period had materially
negative carry on several of these pairs, so the exclusion is not neutral for those years.

## 5. Reconciliation with the live engine

The backtest must reproduce the four live signals. It does — **all four agree**, and this
was checked in two ways.

| Pair | Backtest trigger bar | Side | Trigger close | Live trigger bar | Live entry | Agree |
|---|---|---|---|---|---|---|
| EUR/USD | 2026-10-09T14:00Z | short | 1.1196 | 2026-10-09T14:00Z | 1.1196 | ✅ |
| GBP/USD | 2026-10-12T16:00Z | short | 1.32076 | 2026-10-12T16:00Z | 1.32076 | ✅ |
| USD/JPY | 2026-10-09T09:00Z | long | 158.332 | 2026-10-09T09:00Z | 158.332 | ✅ |
| AUD/USD | 2026-10-12T16:00Z | short | 0.69581 | 2026-10-12T16:00Z | 0.69581 | ✅ |

Window sensitivity was tested explicitly, because the dashboard computes the ruleset over
the newest 500 bars while this replay covers ~139,000: running the *same* live code over
just the last 500 bars reproduces the identical trigger bar, direction, close and state on
all four pairs (`diagnose_and_report.ts`). So EMA(200) warm-up differences between a
500-bar window and a 24-year window do not change any of the four current signals here.
It is still a difference in principle: an EMA seeded from a short window is not fully
converged, and a trend filter sitting within a fraction of a pip of its crossover could
flip an "in-trend" entry to an "against-trend, ignored" non-entry. That risk is real but
it did not bite on these four.

**One honest caveat.** GBP/USD and AUD/USD trigger on the newest bar in the cache
(2026-10-12T16:00Z), so there is no next bar to fill on: they are live signals with no
completed trade in the trade list. They are correctly reproduced as *signals*, and they
carry no measured result. An earlier version of `results.json`'s reconciliation block
compared the trade list rather than the event stream and so reported these two as
disagreeing; the file has been corrected to compare the event stream and to flag this case.

## 6. What this does and does not say

- **It does not say the ruleset works.** Headline expectancy is −1.12 pips per trade over
  3,789 trades and the recent 12 months are worse (−4.73 pips/trade, PF 0.70).
- **It does not say the signal is worthless either.** With no spread at all the same
  trades are +1.13 pips/trade and PF 1.07 — so there is a faint gross tendency, and it is
  smaller than the cost of acting on it. The honest summary is: **at these costs, on these
  four pairs at H1, this ruleset loses money, and the loss is a cost problem as much as a
  signal problem.** A lower-spread execution venue, or a ruleset that trades less often,
  is the only lever this measurement points at — and re-tuning the ruleset to find one is
  exactly the curve-fitting this exercise exists to avoid.
- The spread figures are the owner's **practice** account's, which the plan notes are
  typically wider than a funded account's. That is the single largest uncertainty in the
  headline number.
- No performance figure here includes swap, slippage beyond the spread, commission or taxes.

## 7. Sample size, plainly

Over the full period each pair has 939–961 trades — plenty, and the full-period combined
figure is not a small-sample artefact. **That does not make it evidence of an edge; it is
evidence of a negative result.** The held-out 12 months have 35–49 trades per pair and 173
combined, which is above the ~30 threshold but only just, and the per-pair holdout numbers
should be read as directionally weak. The two pairs whose live signals could not be filled
(GBP/USD, AUD/USD) contribute no result for their current position.

## 8. Code path, files, and how to re-run

| File | What it is |
|---|---|
| `run_backtest.ts` | the replay, fills, and statistics → `results.json`, `run-summary.txt` |
| `fetch_history.ts` | OANDA H1 paging + cache → `data/<PAIR>.jsonl`, `data/fetch-log.jsonl` |
| `diagnose_and_report.ts` | window-sensitivity check + a readable dump of the results |
| `results.json` | machine-readable results: all three variants, both windows, year-by-year, spreads, holding times, reconciliation |
| `run-summary.txt` | console summary of the same run |

Re-run: `cd /home/team/shared/backtest && bun run fetch_history.ts && bun run run_backtest.ts`.
The fetch is a no-op if the cache is present; re-running the backtest over the cached data
is deterministic and takes under a minute.

**Read-only constraint held throughout:** the only endpoint requested was
`GET /v3/instruments/{instrument}/candles`. No orders, trades, positions or transactions,
ever. The token was read from `process.env.OANDA` and sent as a header; it is not printed,
logged, or written to any file in this directory.

## 9. What I could not do

- Swap/financing is not modelled (no historical financing rates were fetched). Holding-time
  distribution in §4.7 is provided to size that gap; it cannot close it.
- Slippage beyond the quoted spread is not modelled, and neither is any funded-account
  spread. The headline result is therefore optimistic on cost.
- No `/backtest` page was built — deliberately out of scope for this session.
- The trigger-close variant is an upper bound for the *timing* assumption only; it is not
  a best case across all assumptions.
