# Independent audit — Meridian ruleset v1, hourly backtest

**Auditor:** verifier (independent replay, written from the written specification)
**Date:** 2026-11-02
**Subject:** `/home/team/shared/backtest/results.json`, `backtest-report.md`, and the figures quoted
from them in the business plan and on the public site.
**Artifacts:** `verify/ruleset-spec.md`, `verify/audit/replay.py`, `verify/audit/compare.py`,
`verify/audit/reconcile.py`, `verify/audit/variant-matrix.py`,
`verify/audit/ours-independent.json` (written before the team's results were opened),
`verify/audit/comparison-headline.json`, `verify/audit/reconciliation.json`.

---

## Verdict

**The headline result is reproducible — exactly.** My independently written replay produces the
same 3,789 trades, trade for trade, with identical entry price, exit price, exit reason, pips, R
and holding time on every single one, and identical aggregates on every published figure. The
number the owner cares about — **−4,241.0 pips, 32.3% win rate, PF 0.94, −197.6R, max drawdown
5,988 pips / 208.8R, longest losing streak 24, 3,789 trades over 2003-01-15 → 2026-10-12** — is
real, and I recomputed all of it from the raw bid/ask bars without using the team's code.

**The zero-cost ("no spread") variant is NOT reproducible.** My faithful reading of "mid on both
sides" gives **+3,785.1 pips / PF 1.05 / 1.00 pips per trade**, not the published **+4,289.1 /
PF 1.07 / 1.13**. The exit *decisions* agree exactly; only the prices differ, and I could not find
any price convention that reproduces their figure (11 candidates tested, `variant-matrix.py`).
This is the one number in the record I am unable to confirm, and it is a 503.9-pip / 11.7%
difference in the team's favour.

**The qualitative conclusion is unchanged and slightly strengthened.** The published claim is that
the gross edge (1.13 pips/trade) is about half the spread cost (2.25 pips/trade). On my
recomputation the gross edge is 1.00 pips/trade against the same 2.25 cost — a factor of 2.25, not
2. So: at these costs, on these four pairs at H1, this ruleset loses money. That conclusion does
not depend on the disputed variant, and the disputed variant is the one that flatters it.

The sentence on the published pages — "our own measurement, not independently verified" — can now
be strengthened **for the headline only**: it has been independently reproduced trade for trade.
It should not be strengthened for the zero-cost or optimistic variants.

---

## 1. What the audit did, in the required order

| Step | What happened |
|---|---|
| 1. Spec first | `verify/ruleset-spec.md` written from `ruleset.md` + `backtest-report.md` §2–4.1 **before** any code. The team's replay code (`run_backtest.ts`, `ruleset.ts`, `indicators.ts`) was **never opened** — the written documents were sufficient, so the "read code only to transcribe" fallback was not needed. Recorded in the spec. |
| 2. Own replay | `verify/audit/replay.py` — ~330 lines of Python, written from the spec, no numpy, no import of or reference to the team's code. |
| 3. Own numbers first | `verify/audit/ours-independent.json` written and saved **before** `results.json` was opened. |
| 4. Then compare | `compare.py` (trade by trade), `reconcile.py` (aggregates, per pair, holdout, year by year, data facts), `variant-matrix.py` (the two disputed variants). |
| 5. State what was not verified | §7 below. |

**Independence caveat, stated rather than assumed.** I had already read the headline figures in
the business plan before starting, and I read `backtest-report.md` §2–4.1 to transcribe the
protocol. So this is an independent *replay*, not a blind one: it checks arithmetic, data handling
and the rule as documented, and cannot detect a systematic choice that both implementations made
because they read the same prose. Every number below was nonetheless computed by my own code from
the raw `.jsonl` bars.

## 2. The data, checked before it was used

Four files, `[t, mid o/h/l/c, ask o/h/l/c, bid o/h/l/c]`, `t` = bar open, Unix UTC:

| Pair | Bars | First bar | Last bar |
|---|---|---|---|
| EUR/USD | 138,999 | 2002-05-06T20:00Z | 2026-10-12T16:00Z |
| GBP/USD | 138,789 | 2002-05-06T20:00Z | 2026-10-12T16:00Z |
| USD/JPY | 138,900 | 2002-05-06T20:00Z | 2026-10-12T16:00Z |
| AUD/USD | 138,816 | 2002-05-06T20:00Z | 2026-10-12T16:00Z |

No duplicate timestamps, no out-of-order rows, no malformed rows, `mid == (ask+bid)/2` on the rows
checked. Bar counts match the report's table exactly.

### Finding D1 — the first ~2.5 years of the "hourly" file are not hourly bars

This is the one substantive data fact the report does not state. Measured from the gap between
consecutive bars:

| Year | EUR/USD gaps ≤ 1 h | USD/JPY gaps ≤ 1 h |
|---|---|---|
| 2002 | 2 of 207 | 1 of 205 |
| 2003 | **0 of 324** | **0 of 319** |
| 2004 | **0 of 315** | 1 of 312 |
| 2005 | 6,434 of 6,512 | 6,422 of 6,493 |

The broker's H1 history only becomes genuinely hourly in **January 2005**. Everything from
2002-05-06 to 2004-12 is a **daily** bar series stored in the H1 file. Consequences:

- The 22 trades the report attributes to 2003 (9, +525.0 pips) and 2004 (13, −478.3) are
  **daily-bar trades** inside an "hourly" backtest, and the report's year-by-year table shows
  exactly that anomaly (9 and 13 trades against ~170 in every later year) without explaining it.
- The EMA(200)/ATR(14) warm-up feeding the first genuine hourly trades in 2005 is computed over
  that mixed-resolution prelude, so the first months of 2005 are trading on indicators partly
  seeded from daily bars.
- Neither implementation is wrong here — both walk the same series — but "~24.4 years of hourly
  history" overstates what the file contains. It is ~21.8 years of hourly history plus ~2.6 years
  of daily history. The effect on the headline is small (22 trades out of 3,789) but it should be
  labelled.

### Finding D2 — the stated measurement period starts later than the scan actually does

The report says the measured period is `2003-01-15T20:00Z → 2026-10-12T16:00Z`. The first bar the
rule is evaluated on (index 200, where all of EMA(20)/50/200 and ATR(14) are defined and a
previous bar exists) is actually **2002-12-23T20:00Z** (EUR), 2002-12-27 (GBP), 2002-12-25 (JPY),
2002-12-30 (AUD). No trade fires before 2003-02-19, so nothing is misstated in the results — the
period label is just ~3 weeks later than the true start of evaluation. Cosmetic, but it is a
stated figure that does not match the data.

## 3. Trade-by-trade comparison — headline variant

`python3 verify/audit/compare.py` matches every trade on trigger-bar time and compares
`side`, `fillBarUtc`, `fillPrice`, `exitBarUtc`, `exitPrice`, `exitReason`, `pips`, `r`,
`riskPips`, `holdingHours`.

| Pair | In their list | In my replay | Matched | Field mismatches | Unmatched |
|---|---|---|---|---|---|
| EUR/USD | 961 | 961 | **961** | **0** | 0 |
| GBP/USD | 943 | 943 | **943** | **0** | 0 |
| USD/JPY | 940 | 939 | **939** | **0** | 1 (see below) |
| AUD/USD | 946 | 946 | **946** | **0** | 0 |
| **Total** | 3,790 | 3,789 | **3,789** | **0** | 1 |

The one unmatched entry in their list is USD/JPY, trigger 2026-10-09T09:00Z, `exitReason:
"still-open-at-data-end"`, `pips: null`. Both implementations exclude it from the results
identically; their trade list keeps it with null fields, mine drops it. Their own aggregate reports
`tradesStillOpenAtDataEnd: 1`. **No disagreement.**

So: 3,789 trades, and on all ten compared fields, on every trade, the two implementations agree to
floating-point equality (1e-9 on prices, 1e-6 on pips and R).

## 4. Aggregate comparison — every published headline figure

| Metric (combined, full period) | Mine | Theirs | Verdict |
|---|---|---|---|
| Trades | 3,789 | 3,789 | **exact** |
| Wins / Losses | 1,225 / 2,564 | 1,225 / 2,564 | **exact** |
| Win rate | 32.33% | 32.3% | exact to published precision |
| Total pips | **−4,241.0** | **−4,241.0** | **exact** |
| Total R | −197.58 | −197.58 | **exact** |
| Avg R / trade | −0.0521 | −0.052 | exact to published precision |
| Profit factor | 0.94 | 0.94 | **exact** |
| Max drawdown (pips / R) | 5,988.5 / 208.76 | 5,988.5 / 208.76 | **exact** |
| Longest losing streak | 24 | 24 | **exact** |
| Avg win / avg loss | +56.92 / −28.85 | +56.9 / −28.8 | exact to published precision |
| Exit mix (stop / target / cross) | 2,330 / 1,219 / 240 | 2,330 / 1,219 / 240 | **exact** |
| Per pair, total pips | −739.2 / −3,728.8 / +51.1 / +175.9 | same | **exact** |
| Per pair, trades | 961 / 943 / 939 / 946 | same | **exact** |
| Per pair, max DD pips | 1,362.2 / 4,140.2 / 2,066.1 / 1,688.3 | same | **exact** |

**Held out, last 12 months (entry ≥ 2025-10-12T00:00Z):**

| Metric | Mine | Theirs | Verdict |
|---|---|---|---|
| Trades | 173 | 173 | **exact** |
| Total pips | −819.0 | −819.0 | **exact** |
| Win rate | 28.32% | 28.3% | exact to published precision |
| Total R | −30.5 | −30.54 | exact to published precision |
| Profit factor | 0.70 | 0.70 | **exact** |
| Max DD | 819.0 pips | 819.0 pips | **exact** |
| Longest losing streak | 15 | 15 | **exact** |

**Year by year (headline, combined):** 24 of 24 years match exactly — trade counts and total pips
— **when trades are attributed by exit time**, which is what their table does. My first attempt
attributed by entry time and 15 of 24 years then differed by one trade at each boundary; that was
my convention being wrong, not theirs, and it is recorded here because it is the kind of difference
that looks like a finding and is not.

Every "mismatch" flagged by `reconcile.py` for the headline (16 of 162 rows) is a rounding
artefact of the published precision (e.g. mine 32.33% vs published 32.3%, −197.58 vs −197.6).

## 5. Where the audit disagrees — the two non-headline variants

### 5.1 Zero-cost: **not reproduced**

| Metric | Mine (faithful "mid on both sides") | Theirs | Difference |
|---|---|---|---|
| Trades | 3,789 | 3,789 | — |
| **Total pips** | **+3,785.1** | **+4,289.1** | **−503.9 (11.7%)** |
| Wins | 1,274 | 1,416 | −142 |
| Win rate | 33.62% | 37.4% | −3.8 pp |
| Profit factor | 1.05 | 1.07 | −0.02 |
| Total R | +121.20 | +125.47 | −4.3 |
| Expectancy | +0.999 pips/trade | +1.13 | −0.13 |
| Max drawdown | 1,955.3 pips / 57.1R | 1,463.2 / 49.03 | +492 pips worse |
| Longest losing streak | 17 | 16 | +1 |
| Exit mix | 2,258 stop / 1,267 target / 264 cross | identical | — |

**The exit decisions are identical.** The combined exit mix matches exactly, and my per-pair
decomposition sums to it (566+571+552+569 stops, 324+303+316+324 targets, 71+69+71+53 crosses).
So the two implementations agree on *which trades closed, when, and why*; they disagree only on
the prices used.

**What the difference looks like.** Their win count exceeds their own target count by 149
(1,416 − 1,267); mine exceeds it by 7 (1,274 − 1,267). Since a stop exit can never be a win and a
target exit nearly always is, ~142 of the 264 cross-against exits are winners in their zero-cost
run and only ~7 are in mine. A long that exits on a downward EMA(20)/EMA(50) cross exits below its
entry almost by construction, so 142 winners among 264 such exits requires entry and exit prices
that are not a plain mid-open-to-mid-open pair.

**I could not find the convention that produces it.** `variant-matrix.py` enumerates 11 plausible
price conventions that keep the exit decisions fixed:

| Convention | Total pips | Wins |
|---|---|---|
| mid-open entry, level fill, next-open exit (**mine**) | +3,785.1 | 1,274 |
| mid-open entry, level fill, no gap-to-open | +4,519.2 | 1,281 |
| mid-open entry, stop/target re-anchored to entry | +3,487.1 | 1,279 |
| mid-open entry, stop/target filled at bar close | +4,832.3 | 1,331 |
| mid-open entry, rule exit at exit-bar close | +3,779.7 | 1,274 |
| mid-open entry, rule exit at exit-bar open | +5,952.3 | 1,283 |
| ask/bid entry, mid exit | −178.9 | 1,273 |
| trigger-close entry, level fill, next-open exit | +3,421.5 | 1,274 |
| **Stored zero-cost figure** | **+4,289.1** | **1,416** |

None reproduces it. Two related internal inconsistencies in the record:

- Their §3 table gives a "round-trip spread cost per trade" of 1.212 / 3.99 / 2.799 / 1.936 pips
  (2.48 pips/trade). The realised difference between their own two variants is 1.82 / 4.18 / 1.81
  / 1.21 pips per trade (2.25 pips/trade). The two "spread cost" figures in the same record do not
  agree with each other, and the per-pair values are not a permutation of one another.
- The trade list carries a per-trade `spreadCostPips` field which sums to 9,387 pips, again not
  the 8,530-pip headline-vs-zero difference the report quotes.

**Which number should be published?** I cannot say which implementation is right, so I say what I
measured: **+3,785 pips, PF 1.05, ~1.00 pips/trade** under the reading the report describes
("MID on both sides"). The published +4,289 / 1.13 pips/trade should be treated as **unverified**
until the zero-cost code path is re-derived. Note the direction: the discrepancy makes the team's
story *stronger*, not weaker — a bigger gross edge — so it is not a case of the audit catching an
error that flatters the conclusion. It is a case of an unverifiable number that happens to help.

**Does it change the conclusion?** No. Either way the gross edge is smaller than the spread cost by
a factor of ~2 (published: 1.13 vs 2.25; mine: 1.00 vs 2.25), and either way the zero-cost variant
is a losing strategy once costs are real. The plan's sentence "roughly twice the edge" survives my
recomputation with a slightly wider margin.

### 5.2 Optimistic: reproduced, once the convention is identified — and it is more optimistic than described

Their optimistic figure (+3,416.2 / 115.74R / 1,275 wins) is reproduced **exactly** by "enter at the
trigger bar's mid close, and fill rule exits at the **exit bar's mid close**" (+3,416.1 / 115.73 /
1,275). My replay fills rule exits at the next bar's open and gets +3,421.5.

Both are look-ahead variants and both are labelled "not achievable", so this changes no conclusion.
But it means the variant labelled "trigger-close fills" is actually **two** look-aheads: the entry
price and the exit price are both taken from bars whose close is not knowable when the decision is
made. The report describes only the entry side. The size of the effect is small (5.4 pips,
0.16%), but the description of the variant understates what it assumes.

## 6. What this audit does and does not establish

**Establishes.**
- The ruleset as documented produces exactly the event stream and exactly the 3,789 trades the
  team reports, from the raw bid/ask bars, with real historical spreads, next-bar-open fills, and
  stop/target as exit triggers with a pessimistic intra-bar tie-break.
- Every published headline aggregate — total, per pair, per year, held-out 12 months, exit mix,
  drawdown, streak — is arithmetically correct and reproducible from stored data.
- The negative result is not an artefact of the team's implementation.

**Does not establish.**
- That the zero-cost variant is +4,289 pips. It is not reproducible by me; see §5.1.
- Anything about the **daily** backtest. Out of scope for this session (see §8).
- Anything about whether the rule would work at other costs, other pairs, other timeframes, or
  with swap included. None of that was tested, here or there.
- Anything about the live engine's current signals. I did not re-derive them (the report's
  reconciliation with live is a separate check; my replay's last signals were not compared to the
  dashboard).

## 7. What I could not verify, and the judgement calls I had to make

**Inputs I did not have / did not use**
- Swap/financing, commission, slippage beyond the quoted spread: not modelled by me either, so my
  numbers share the same optimism the report declares. I did not verify that these exclusions are
  immaterial — nobody has measured them.
- Funded-account spreads: the data is practice-account bid/ask. I cannot check what the owner's
  live account would actually pay.
- I did not verify the fetch: the `.jsonl` files were taken as given. If the broker's paging
  duplicated or dropped bars, both implementations would inherit it. The files are internally
  consistent (monotonic, no duplicates, counts match the fetch metadata), which is as far as I went.

**Judgement calls (recorded in `ruleset-spec.md` §5.5, resolved the same way by both of us unless
stated)**
1. The entry bar itself is scanned for a stop/target breach. Alternative: start at the next bar.
2. After a stop-out the pair stays flat until a *new entry signal*; the rule's own long/short
   state is not re-entered. The trade set is driven by the entry-event stream.
3. Combined drawdown and losing streaks are computed on trades ordered by **exit** time.
4. The held-out window is applied to the entry fill time.
5. R = pips ÷ (1.5 × ATR14 at the trigger), i.e. against the *intended* risk, not the realised one.

**Not verified by anyone (unchanged by this audit)**
- The rule itself is not derived from any market rationale; it is an invented indicator
  combination. Reproducing its result says nothing about whether it should work.

## 8. The daily backtest

**Not audited.** The hourly ruleset was the priority and it is finished. The daily files are
present (`/home/team/shared/daily/data`, 7,177 bars per pair, 2002-05-06 → 2026-10-22) and the same
replay would run on them with a `--data` argument, but the daily run uses a different entry
mechanism in the team's code (`daily/run_daily_backtest.ts`) which I have not read, so I cannot
claim my replay would be an independent check of it without first transcribing that rule into the
spec. That is a clean second delegation, not something half-done here.

## 9. Exact commands run

```bash
# 1. spec written by hand -> /home/team/shared/verify/ruleset-spec.md  (no code executed)
# 2. own replay, written from the spec, run before results.json was opened:
python3 /home/team/shared/verify/audit/replay.py
#    -> wrote verify/audit/ours-independent.json
#    -> headline n=3789 total=-4241.0 win=32.33% PF=0.94 R=-197.6 maxDD=5988p/208.8R LLS=24
# 3. trade-by-trade comparison against backtest/results.json:
python3 /home/team/shared/verify/audit/compare.py
#    -> 3,789/3,789 matched, 0 field mismatches, wrote comparison-headline.json
# 4. aggregate / per-pair / holdout / year-by-year / data facts:
python3 /home/team/shared/verify/audit/reconcile.py
#    -> 162 aggregate rows, 92 flagged; 16 headline rows all rounding, 46 zero, 30 optimistic
#       wrote reconciliation.json
# 5. variant interpretation matrix:
python3 /home/team/shared/verify/audit/variant-matrix.py
```

No OANDA endpoint was contacted, no order was placed, previewed, cancelled or modified, the
execution test suite was not run, and nothing was written to
`/home/team/shared/execution/orders.jsonl`. The site was not published.

## 10. Recommended actions for the lead

1. **Headline:** keep it, and strengthen the published provenance sentence from "not independently
   verified" to "independently reproduced trade for trade by a separate implementation
   (2026-11-02)" — for the headline figures only.
2. **Zero-cost:** either re-derive the zero-cost code path and publish the corrected figure, or
   mark +4,289.1 / PF 1.07 / 1.13 pips-per-trade as unverified alongside the alternative +3,785 /
   1.00. Do not leave a number in the record that a second implementation cannot reproduce and
   that the report presents as the evidence for a gross edge.
3. **Data labelling:** state that the hourly file is daily until January 2005, and that 2003–2004
   is 22 daily-bar trades.
4. **Optimistic variant:** note that it takes both its entry and its exit from the close of a bar
   whose close was not knowable at decision time.
5. **Daily backtest:** still unaudited — a separate delegation.
