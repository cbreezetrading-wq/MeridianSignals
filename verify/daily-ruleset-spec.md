# DAILY RULESET SPECIFICATION — `verify/daily-ruleset-spec.md`

**Status:** spec only. No replay code, no comparison, no OANDA calls, nothing written to `/home/team/shared/execution/`.

**Saved by the lead** from the verifier's delegation report (session `9cff9701-c711-4fd1-b86f-14f4b589ed2e`) — that session was read-only with no shell and no write tools, so the spec was delivered in-report. Content is verbatim. The next write-capable delegation should commit this file into the repository under `verify/`.

## 0. Provenance and independence caveat

**Written from these written documents only:** `/home/team/shared/ruleset.md`; `/home/team/shared/daily/daily-report.md`; `/home/team/shared/daily/run-summary.txt`; `/home/team/shared/daily/dump.txt` (lines 1–60 only); `/home/team/shared/daily/q.txt`, `t.txt`; `/home/team/shared/daily/data/*.meta.json`, `fetch-summary.json`; `/home/team/shared/backtest/backtest-report.md` (for the parts the daily report says are identical); `daily-published-notes.md`; the team skill `oanda-honest-backtest`. Plus raw data-file inspection (allowed).

**I did NOT open:** `daily/run_daily_backtest.ts`, `daily/fetch_daily.ts`, `backtest/run_backtest.ts`, `site/src/lib/market/ruleset.ts`, `site/src/lib/market/indicators.ts`, or any generator/indicator/backtest source. The written documents were sufficient to specify the rule, so no "read code to transcribe" fallback was needed.

**Independence caveat, stated rather than assumed.** Before writing this I had already seen: the daily headline figures (they are in the business plan I am given), the daily year-by-year table and per-pair numbers (in `daily-report.md`), and — while checking document consistency — some stored figures in `daily/dump.txt` / `q.txt` / `t.txt`. I had also completed the hourly audit. So a replay written from this spec is an **independent replay, not a blind one**:

- It can check arithmetic, data handling and the rule *as documented*.
- It cannot detect a systematic choice the team and I make the same way because we both read the same prose.
- Because I have seen the daily year table and per-pair results, the replay's convention choices must be **frozen in writing before it is run** (the §12 open questions are where they will be frozen). Otherwise choosing a convention becomes a search for a match, which would destroy the value of the exercise.
- **Hard rule for the next delegation:** save `ours-independent.json` before opening `daily/results.json`, exactly as in the hourly audit.

## 1. Instruments

- **P1.** Exactly four pairs: **EUR/USD, GBP/USD, USD/JPY, AUD/USD**. No others. *(ruleset.md §Data; daily-report §3)*
- **P2.** Pip size **0.01** if the quote currency is JPY, otherwise **0.0001**. *(ruleset.md §Pip sizes)*
- **P3.** OANDA instrument names `EUR_USD`, `GBP_USD`, `USD_JPY`, `AUD_USD`. *(data file names)*

## 2. Bars and data

- **P4.** Granularity **`D`**; request `GET /v3/instruments/{instrument}/candles?granularity=D&price=MBA`. *(daily-report §3, §2 row 1; confirmed in every `data/<PAIR>.meta.json`: `requestedGranularity: "D"`, `requestedPrice: "MBA"`)*
- **P5.** Only bars flagged `complete: true` are used. Exactly **1** incomplete bar per pair was refused (the forming bar). No bar interpolated, back-filled or dropped. *(daily-report §3; `incompleteCandlesRefused: 1` in all four meta files)*
- **P6.** Each cache line is `[t, mid o/h/l/c, ask o/h/l/c, bid o/h/l/c]`, `t` = bar **open**, Unix seconds UTC. *(meta `lineFormat`; verified by reading line 1 of `data/EUR_USD.jsonl`)*
- **P7.** **Every indicator and every level is computed from the MID series only.** Bid/ask enter only at fill time. *(ruleset.md §Data; daily-report §2)*
- **P8.** Bar stamps sit at the **daily rollover**: 21:00 UTC or 22:00 UTC, switching with US daylight saving (report: 4,623 bars at 21:00, 2,554 at 22:00 for EUR/USD = 7,177). The bar's calendar date is **not** its trading date. *(daily-report §3)*
- **P9.** Coverage as claimed: EUR/USD 7,177 bars · GBP/USD 7,153 · USD/JPY 7,177 · AUD/USD 7,116, each 2002-05-06T21:00Z → 2026-10-22T21:00Z; 28–31 missing weekdays of 6,384. *(daily-report §3, `run-summary.txt`, `dump.txt`; see §13.4 for a contradiction)*
- **P10.** Weekend/holiday gaps are left as gaps. *(daily-report §7)*

## 3. Indicators (definitions fixed)

- **P11.** **EMA(n)**: standard, `k = 2/(n+1)`, **seeded with the simple average of the first n mid closes**, then applied forward; undefined before index `n−1`. Three are used: **EMA(20), EMA(50), EMA(200)**. *(ruleset.md §Indicators)*
- **P12.** **ATR(14)**: Wilder's. `TR[i] = max(high[i]−low[i], |high[i]−close[i−1]|, |low[i]−close[i−1]|)`, `TR[0] = high[0]−low[0]`; seeded with the simple mean of `TR[0..13]`, then `ATR[i] = (ATR[i−1]*13 + TR[i])/14`; undefined before index 13. *(ruleset.md §Indicators)*
- **P13.** Indicators are computed over the whole series, not a rolling window. *(daily-report §2: engine reused, whole-series)*

## 4. The entry mechanism — and the brief's premise

**The brief says the daily entry mechanism is a *different* mechanism from the hourly one. The written record does not support that, and I am recording the contradiction rather than inventing a difference.**

`daily-report.md` §2 has a six-row table titled "What differs (every difference, as required)": (1) granularity `D` and cache directory; (2) gap accounting (weekday-with-no-bar = missing trading day, bars shifted +3 h onto their trading day); (3) holding time additionally reported in days; (4) no reconciliation against the live dashboard; (5) a cost/edge decomposition block; (6) H1 headline figures read from the H1 `results.json`. **None of the six is an entry mechanism.** The same section states explicitly:

> "**What is identical:** the rules (`runRulesetEvents` from the live site's `ruleset.ts`), the indicators (`atr` from `indicators.ts`), the stop/target sizing (1.5×ATR(14) stop, 3.0×ATR(14) target from the trigger bar's mid close), the fill convention (next bar's open, ask for a long / bid for a short, opposite side on exit), the pessimistic intra-bar rule …, the gap rule …, the three variants, the 12-month hold-out, and the read-only data endpoint."

**So, as documented, the daily entry *rule* is identical to the hourly one.** The only entry-side difference the documents do disclose is **what a bar is**: a daily bar stamped at the 21:00/22:00 UTC rollover, so "the next bar's open" is the next day's rollover quote — which the report itself identifies (§4.6) as *the widest-spread minute of the FX day*. That is the entry-mechanism difference I can substantiate: same trigger, different bar, different fill point in the session.

**I also have to correct my own earlier statement.** In `verify/audit-findings.md` §8 I wrote that "the daily run uses a different entry mechanism in the team's code which I have not read". That was an inference from the file being a "near-copy", **not** from any document, and the documents contradict it. **I withdraw it as unsupported.** If a genuine mechanism difference exists in the code, the written documents do not disclose it — which is itself a finding: either the report's "identical" claim is wrong, or my earlier claim was. Only reading the code (forbidden in this step) or asking the author settles it, and it must be settled **after** a spec-based replay exists, not before, so the replay is not contaminated.

### 4.1 The rule as documented

- **P14. Trend filter.** `EMA(50) > EMA(200)` → trend **up**; `EMA(50) < EMA(200)` → trend **down**; equal → no trend. Read on the bar being evaluated. *(ruleset.md §1)*
- **P15. Trigger.** A cross of EMA(20) against EMA(50): **upward** at bar `i` ⟺ `EMA20[i−1] ≤ EMA50[i−1]` **and** `EMA20[i] > EMA50[i]`; **downward** is the reverse. *(ruleset.md §2)*
- **P16. Entry signal.** Long ⟺ upward cross **and** trend up at `i`; short ⟺ downward cross **and** trend down at `i`. A cross against the trend is ignored entirely — no entry, no state change. *(ruleset.md §3)*
- **P17. Entry only from flat.** A cross can open a position; it cannot add to one. A cross in the same direction as an open position does nothing. *(ruleset.md §3)*
- **P18. Entry anchor (a level, not a fill).** `E = mid close of the trigger bar i`. *(ruleset.md §4; daily-report §6)*
- **P19. Stop.** Long `E − 1.5 × ATR14[i]`; short `E + 1.5 × ATR14[i]`; ATR on the **trigger bar**. *(ruleset.md §5; daily-report §6)*
- **P20. Target.** Long `E + 3.0 × ATR14[i]`; short `E − 3.0 × ATR14[i]`. Risk:reward 1:2 by construction. *(ruleset.md §6; daily-report §6)*
- **P21. One event per bar; exits before entries.** A cross that closes a position does not also open the opposite one; the next entry needs its own cross. *(ruleset.md §8)*
- **P22. Scan start.** Scanning starts at bar **index 200** — the first bar on which EMA(20), EMA(50), EMA(200) and ATR(14) are all defined and a previous bar exists. Nothing before index 200 is reconstructed. *(ruleset.md last line; daily-report §6 last bullet)*

## 5. What counts as a signal

A **signal** is a bar `i` at which P15 and P16 hold and the pair has no open position (P17). It produces exactly one trade candidate: direction, entry anchor `E` (P18), stop (P19), target (P20), and the trigger bar's UTC time. A cross against the trend, or a cross while a position is open, is **not** a signal. Stop and target are **exit triggers** in addition to the rule's own exit — they are not signals. *(ruleset.md; daily-report §6)*

## 6. Execution model (fills, exits, tie-breaks)

- **P23. Entry fill.** The **open of the next bar (`i+1`)**, at the side actually paid: **ASK** for a long, **BID** for a short. Never the trigger bar's close, never the mid. *(daily-report §6, §4.1)*
- **P24. Rule-exit fill.** An exit the rules fire at a bar's close is filled at the **next bar's open**, at the opposite side (**BID** to close a long, **ASK** to close a short). *(daily-report §6)*
- **P25. Stop/target are exit triggers** tested **intra-bar on every bar the position is open**, with the fill at the level itself (the stop or target price). *(daily-report §6)*
- **P26. Intra-bar tie-break.** If one bar touches **both** stop and target, the **stop** is counted. *(daily-report §6)*
- **P27. Gap rule.** A bar opening beyond the stop fills at that bar's **open** (worse than the stop); a bar opening beyond the target fills at that bar's **open** (better than the target). *(daily-report §6)*
- **P28. Exit reasons recorded:** stop, target, cross-against, trend-flip. *(daily-report §6; exit-mix reporting; `dump.txt` `exitReasons` keys)*
- **P29. Per-pair scope.** **One position per pair, no pyramiding.** Each pair is replayed independently; there is no portfolio-level filter, no correlation filter, no maximum-concurrent-positions rule. *(daily-report §6; per-pair results reported separately. "No portfolio filter" is documented by implication, not in one sentence — see §12 Q11.)*
- **P30. Real historical spread.** `ask − bid` of the same bar, from the owner's own OANDA practice-account history — a measured per-bar spread, not an assumption. Spread enters only at fill time. *(daily-report §6, §3)*

## 7. R, and units

- **P31. 1R = the trade's initial stop distance** = `1.5 × ATR14 at the trigger bar`, in pips. `R = pips / stop_distance_pips` — i.e. **against the intended risk, not the realised one** (the fill is at the next bar's open, the stop is anchored at the trigger bar's mid close, so realised risk ≠ 1R). *(daily-report §6 "1R = …", §4.4)*
- **P32.** Everything is in **pips and R**: no position sizing, no equity, no lot sizes, no currency conversion. *(daily-report §7)*

## 8. Variants and windows

- **P33. Three variants, same signals, same timing:** (a) **Headline** — next-bar-open fills, ask to buy / bid to sell, opposite side on exit; (b) **Zero-cost** — identical timing, **mid on both sides**; (c) **Optimistic upper bound, NOT achievable** — entry at the **trigger bar's mid close**, exit at the **exit bar's mid close**. *(daily-report §6. Note: unlike the hourly report, the daily report specifies **both** sides of the optimistic variant.)*
- **P34. Held-out window:** the **last 12 months, 2025-10-22 → 2026-10-22**, reported separately for every variant. *(daily-report §4.3)*
- **P35. Year-by-year** is attributed **by the year the trade closed**. *(daily-report §4.7 heading)*
- **P36. Holding time** reported in **days** (median/mean/p90/max + histogram `<1d, 1–2d, 2–4d, 4–7d, 1–2w, 2–4w, 1–3m, 3m+`) and additionally in daily bars and hours. *(daily-report §4.8)*
- **P37. Gap accounting (reporting only):** shift each bar **+3 h** onto its trading day before any weekday-gap check; a weekday with no bar is a missing trading day. This must **not** touch prices, indicators or fills. *(daily-report §2 row 2)*
- **P38. Excluded, and not modelled in any figure:** swap/financing/carry, slippage beyond the quoted bid/ask spread, commission, fees and taxes, position sizing/equity. *(daily-report §7)*
- **P39. No optimisation of any kind:** no parameter search, no sweep, no per-pair tuning, no timeframe search. *(daily-report §6)*

## 9. Statistics the replay must produce

Trades; wins/losses; win rate; avg win/loss in pips; expectancy per trade in pips and R; total pips and R; profit factor; max drawdown in pips and R; longest losing streak; exit-reason mix; median/mean/p90/max holding time in days; per pair and combined; the same for all three variants; the held-out 12 months separately; year by year; and the cost/edge decomposition (gross edge, spread paid, net) computed **by subtraction** between the zero-cost and headline variants, cross-checked against the mean spread measured on the entry-fill bars. *(daily-report §4, §4.4, §9)*

## 10. Sanity anchors to compare **only after** our own numbers are saved

Bar counts 7,177 / 7,153 / 7,177 / 7,116; 208 headline trades; per-pair 63 / 49 / 48 / 48; mean initial risk 127.3 pips; mean spread on entry-fill bars 6.361 pips. *(daily-report §3, §4.1, §4.4.)* These are the **comparison targets for the next delegation**, not inputs to this spec.

## 11. What I know from the hourly audit that will matter here

1. **The hourly file is daily until January 2005** (hourly Finding D1): 2003 had 0 of 324 gaps ≤ 1 h. So the hourly run's 2003–2004 "hourly" trades were daily-bar trades.
2. **The hourly file's early bars are also flat** — verified `backtest/data/EUR_USD.jsonl` line 1 and line 300 (2003-04-08): open = high = low = close, 86,400 s apart. So the pre-2005 section of *both* files is the same degenerate series.
3. **The stated measurement period in the hourly report was ~3 weeks later than the true index-200 bar** (Finding D2). The daily report makes the same claim and the same defect is expected — see §13.3.
4. **The hourly zero-cost variant was not reproducible** and the hourly optimistic variant used an exit-side look-ahead the report did not describe. The daily report describes its optimistic variant's exit explicitly, so that particular defect should not recur; the zero-cost ambiguity may.

## 12. What the written documents do **NOT** specify — the replay's work list

Each of these must be **decided, written down and frozen before the replay runs**, then reported as a choice:

- **Q1. Entry after a stop/target exit.** The documents never say what happens when a stop or target closes a trade while the rule's own state is still long/short. Two readings: (a) the trade set is driven by an independent *entry-signal stream* (a new trade opens at the next qualifying cross in the trend direction, whether or not the rule's state changed); (b) the rule's state machine is the only source (a new entry needs a state flip). **This is the single largest ambiguity.** The hourly replay used (a) and reproduced the team's 3,789 hourly trades exactly, so (a) is the most probable reading — but it must be stated as a choice, and if the daily trade count diverges, (b) must be tested and both reported.
- **Q2. Is the entry bar itself scanned for a stop/target breach?** "Every bar the position is open" (P25) does not say whether the fill bar counts. The hourly replay included it; matched exactly. Freeze the same way, report it.
- **Q3. Which price series the intra-bar stop/target test uses.** The report does not say whether a long's stop is tested against the **bid** low and a short's against the **ask** high (the side actually traded), or against mid. Hourly replay used the traded side and matched. Freeze and state.
- **Q4. Chronology between an intra-bar breach and a rule exit on the same bar.** The report does not say that an intra-bar stop/target on bar `j` takes precedence over a rule exit that would fire at bar `j`'s close. The hourly spec chose "breach first"; state it.
- **Q5. Exact held-out window boundaries and which timestamp the window is applied to** — entry fill time, trigger time or exit time. "2025-10-22 → 2026-10-22" is not precise, and the data ends 2026-10-22T21:00Z. Hourly used entry-fill time inclusive; state the daily choice.
- **Q6. Whether the scan starts at index 200 (0-based) and on which bar each pair's index 200 falls.** The report asserts 2003-01-15 for all four pairs (see §13.3, which contradicts it).
- **Q7. Whether a trade still open at the data end is included, excluded, or kept with null fields.** The report is silent; `dump.txt` records `tradesStillOpenAtDataEnd: 0`, so it does not bite — but the replay must assert it rather than assume it.
- **Q8. Ordering rule for combined drawdown and losing streaks** (by exit time — a realised-equity curve — or by entry time). Unspecified. Hourly used exit time and matched the published year-by-year table; state the daily choice.
- **Q9. How a break-even trade (pips = 0) is classified** in wins/losses and win rate. Unspecified.
- **Q10. Exact definition of "days" held** — calendar days between fill and exit timestamps, or bar count, and how the +3 h shift interacts with it. Unspecified.
- **Q11. Whether the four pairs really are independent** (no portfolio filter, no max concurrent positions). Documented only by implication; the report never states it in a sentence. Assert it or find it.
- **Q12. Whether the pre-2005 flat-OHLC bars are used as-is.** The report does not mention them at all (see §13.1). No exclusion rule is stated anywhere.
- **Q13. Rounding/precision of every published figure.** Unspecified; state the precision used in comparisons.
- **Q14. Whether the daily replay's entry mechanism is in fact the documented one.** Not answerable from documents; see §4. If the replay's trade counts do not reconcile, this is the first hypothesis to test — but it is tested by *reading the code*, which is out of scope for the spec step and must be a separate, explicitly-labelled step.

## 13. Data facts established by reading alone (no code, no runs)

### 13.1 Finding: the first ~845 daily bars have **no intra-bar range at all**, and the measurement period starts inside them

Reading `data/EUR_USD.jsonl` directly:

```
line   1  [1020718800, 0.91535, 0.91535, 0.91535, 0.91535, …]   ← o = h = l = c
line 100  [1030568400, 0.98485, 0.98485, 0.98485, 0.98485, …]
line 400  [1059685200, 1.1275,  1.1275,  1.1275,  1.1275,  …]
line 800  [1099951200, 1.2899,  1.2899,  1.2899,  1.2899,  …]
line 845  [1104444000, 1.3568,  1.3568,  1.3568,  1.3568,  …]   ← 2004-12-30T22:00Z, still flat
line 846  [1104616800, 1.356,   1.357,   1.3541,  1.35525, …]   ← 2005-01-01T22:00Z, first real range
```

Same on the other three pairs (checked at line 800: GBP `1.8947×4`, JPY `103.08×4`, AUD `0.7902×4`; all real by line 846). So **every pair's first ~845 bars are close-only bars** — bid, ask and mid are each a single price per bar. Consequences the daily report does **not** mention anywhere:

- `TR[i] = |close[i] − close[i−1]|` in that region (high−low = 0), so **ATR(14) is a mean absolute daily change, not a true range** — systematically smaller than a real daily ATR.
- Stop (1.5×ATR) and target (3.0×ATR) are therefore **tighter than the rule intends**, and the intra-bar tests (P25) can only ever fire on a **close**, never mid-bar.
- The 2003 and 2004 trades (9 and 13, per the report's own year table) are simulated on that degenerate series. That is **22 of 208 trades = 10.6% of the daily sample**, against 0.6% of the hourly sample for the same defect.
- The report's coverage claims — "Raw cache: bid, ask and mid **OHLC** for every bar", "Coverage is dense" — are true about *row count* and misleading about *content* for the first 2.7 years.

This is the daily analogue of the hourly Finding D1, and it is worse: in the hourly run the pre-2005 defect touched 22 of 3,789 trades (0.6%); here it touches 22 of 208 (10.6%) and it sits inside the stated measurement period rather than before it.

### 13.2 Finding: the daily and hourly files carry the same pre-2005 price path, with a one-session label offset

Hourly line 1 `[1020715200, 0.91825…]`, line 2 `[1020801600, 0.91535…]`, line 3 `[1020888000, 0.90435…]`.
Daily line 1 `[1020718800, 0.91535…]`, line 2 `[1020805200, 0.90435…]`, line 3 `[1020891600, 0.90935…]`.

The daily series' price equals the hourly series' **next** bar, stamped **23 h earlier**. The two reports' year tables agree exactly on 2003 (`9 trades, +525.0`) and 2004 (`13, −478.3`) — i.e. the "daily" and "hourly" runs are literally the same test in that window. The replay must establish the exact timestamp alignment between the two files before using one to check the other, and the reports should say that 2003–2004 is one test, not two.

### 13.3 Finding: the stated measurement period is ~3 weeks later than the index-200 bar

`data/EUR_USD.jsonl` line 200 = `1040594400` = **2002-12-22T22:00Z**; line 201 = **2002-12-23T22:00Z**. So bar index 200 (0-based) is **2002-12-23T22:00Z** — the report's stated start, **2003-01-15**, is about three weeks late. Same defect as hourly Finding D2, and it is the figure the report uses to claim "the same measurement period the H1 run used". The replay must report the actual first evaluated bar per pair and the first actual trade.

### 13.4 Finding: the report's own missing-weekday figure contradicts the run's dump

Report §3 table: AUD/USD **"29 of 6,384"**. `run-summary.txt` line 5 and `dump.txt` line 4: **`missingWeekdays 31/6384`**. One of the two is wrong; the replay should recompute it. (EUR 29, GBP 28, JPY 29 agree.)

### 13.5 Finding: "the same measurement period the H1 run used" is not quite true

H1 data ends **2026-10-12**; the daily data ends **2026-10-22** — ten days longer. The comparison in §4.5 of the report is therefore over slightly different windows, which is fine but should be said.

## 14. What this spec does and does not establish

**Establishes:** the rule, filter, stop/target sizing, fill convention, tie-break, gap rule, per-pair scope, R definition and the three variants **as documented**, with every parameter numbered and cited; the documented differences from the hourly run; the data-quality facts in §13 that the report omits or contradicts.

**Does not establish:** that the team's daily run actually implements this (Q14 — untested and untestable from documents); any daily result figure (none recomputed here); anything about swap, funded-account spreads, slippage beyond the quote, or whether the rule has any reason to work.

---

## Appendix — verifier's report to the lead (verbatim summary)

**FULLY COMPLETE** for the spec step, with one deviation: **no file was written** because this was a read-only delegation with no shell and no write tools. The complete spec is above, saved by the lead to this path.

**What the next delegation must know before writing replay code:**

1. **The brief's premise is not supported by the written record.** The daily report lists six differences from the hourly run and states the rules, indicators, stop/target sizing and fill convention are *identical*. No documented difference in the entry *rule* was found — only in what a bar is (daily rollover, the widest-spread minute of the FX day). The verifier also **withdraws** its earlier unsupported claim in `audit-findings.md` §8 that the daily run uses "a different entry mechanism". If a real difference exists in the code, the report is wrong about its own run — now a named open question (Q14), to be settled *after* a spec-based replay, not before.
2. **The biggest hidden issue is the data, not the rule.** Every pair's first ~845 daily bars (2002-05-06 → 2004-12-30) have **open = high = low = close** — no intra-bar range at all. ATR there is a mean absolute close-to-close change, so stops are too tight and stop/target can only fire at closes. The report never mentions it, and 22 of its 208 trades (10.6%) fall in that region. The hourly file has the same degenerate pre-2005 section, and the two reports' 2003/2004 rows are identical in trade count and pips — the "daily" and "hourly" runs are the same test in that window.
3. **Two smaller document defects to fix on the site/report regardless of the replay:** AUD/USD missing weekdays is **31**, not the report's 29; and the stated measurement start **2003-01-15** is ~3 weeks later than the real index-200 bar (**2002-12-23T22:00Z** for EUR/USD).
4. **14 open questions (Q1–Q14)** are the replay's work list; Q1 (entry behaviour after a stop-out) is the one that can change the trade set, and Q2/Q3/Q4 are the conventions that changed nothing in the hourly replay and should be frozen the same way.
5. **Independence caveat stands:** the daily headline and year table were already seen (business plan, report, and part of `daily/dump.txt`). The replay is an independent *replay*, not a blind one; conventions must be frozen in writing and `ours-independent.json` saved **before** `daily/results.json` is opened.

Nothing else was done: no replay code, no comparison against stored daily results, no OANDA calls, no writes anywhere, no site publish.
