# Ruleset v1 + backtest protocol — plain-language specification

**Purpose.** This file is the specification the independent replay in `verify/audit/` is written
from. It was written **before** any replay code was written, and **before** the team's stored
results (`backtest/results.json`) were opened.

**Provenance of this specification, and how independent the audit is.** The rule was taken from
two written documents, not from the team's replay code:

- `/home/team/shared/ruleset.md` — the ruleset specification itself (indicator definitions, entry
  trigger, filter, stop, target, exit rule, one-event-per-bar).
- `/home/team/shared/backtest/backtest-report.md` §2–§4.1 — the backtest *protocol*: which bars,
  fills at the next bar's open on bid/ask, stop/target as exit triggers, intra-bar tie-break,
  per-pair scope, R definition.

**What I read of the team's code: nothing.** I did not open `backtest/run_backtest.ts`,
`backtest/diagnose_and_report.ts`, `site/src/lib/market/ruleset.ts` or
`site/src/lib/market/indicators.ts` at any point before my own numbers were computed and saved
to `verify/audit/ours-independent.json`. The two documents above were sufficient to specify the
rule without reading code, so the "read code only to transcribe" fallback was not needed.

**Independence caveat, stated rather than assumed.** I had already read the *headline figures*
before starting: they are in the business plan I was given, and §4 of the report was in front of
me while I transcribed the protocol. So this is an independent **replay**, not a blind one. What
that means for strength of evidence:

- Every number in `ours-independent.json` was computed by code I wrote from this document, from
  the raw `.jsonl` bars, with no call into, import of, or copy from the team's replay.
- The comparison is therefore a genuine check of *arithmetic and data handling*, not of
  *hypothesis blindness*. It cannot detect a systematic choice the team and I made the same way
  because we both read the same written protocol — that residual is listed as a judgement call
  in §6 of `audit-findings.md`.
- Where the written protocol was ambiguous, I made a choice, recorded it here (§5), and later
  measured the sensitivity rather than assuming it did not matter.

---

## 1. Instruments

1.1 Exactly four pairs: **EUR/USD, GBP/USD, USD/JPY, AUD/USD**. No others, no crosses, no indices.

1.2 Each pair is replayed **independently**: a position in one pair does not block, size, or
otherwise affect a position in another. There is no portfolio-level filter, no correlation
filter, no maximum-concurrent-positions rule.

1.3 Pip size: **0.01** if the quote currency is JPY, otherwise **0.0001**. All pip figures in the
report use this. (No conversion to a common currency, no lot sizes, no equity: everything is in
pips and in R.)

## 2. Bars

2.1 Granularity **H1**, requested with `price=MBA` from the owner's own OANDA account, so each
bar carries a mid series, an ask series and a bid series: `[t, mid o/h/l/c, ask o/h/l/c,
bid o/h/l/c]`, `t` = bar **open** time, UTC, Unix seconds.

2.2 Only bars the broker flagged `complete: true` are used. The cache on disk already excludes
the forming bar; nothing is interpolated, back-filled or synthesised. Weekend/holiday gaps stay
gaps.

2.3 **Every indicator and every level is computed from the MID series** (`mid o/h/l/c` only).
Bid/ask enter only at fill time (§4). They are never mixed into a bar or an indicator.

2.4 Data spans 2002-05-06T20:00Z → 2026-10-12T16:00Z on all four pairs (~139k bars each).

## 3. Indicators (definitions fixed)

3.1 **EMA(n)** — standard exponential moving average, `k = 2/(n+1)`, **seeded with the simple
average of the first n mid closes**, then applied forward. Undefined before bar index `n-1`.
Three are used: EMA(20), EMA(50), EMA(200).

3.2 **ATR(14)** — Wilder's. True range of bar `i`:
`TR[i] = max(high[i]-low[i], |high[i]-close[i-1]|, |low[i]-close[i-1]|)`, with
`TR[0] = high[0]-low[0]`. Seeded with the simple mean of `TR[0..13]` (= ATR at index 13), then
`ATR[i] = (ATR[i-1]*13 + TR[i]) / 14`. Undefined before index 13.

3.3 No smoothing, no rounding, no rescaling. Indicators are computed over the whole series, not
over a 500-bar window, so warm-up is converged.

## 4. The rule

**4.1 Trend filter.** `EMA(50) > EMA(200)` → trend **up**. `EMA(50) < EMA(200)` → trend **down**.
Equal → no trend. Read on the bar being evaluated.

**4.2 Trigger.** A cross of EMA(20) against EMA(50):
- **upward cross** at bar `i` ⟺ `EMA20[i-1] <= EMA50[i-1]` **and** `EMA20[i] > EMA50[i]`;
- **downward cross** at bar `i` ⟺ `EMA20[i-1] >= EMA50[i-1]` **and** `EMA20[i] < EMA50[i]`.

**4.3 Entry signal.** Long signal at bar `i` ⟺ upward cross at `i` **and** trend up at `i`.
Short signal ⟺ downward cross at `i` **and** trend down at `i`. A cross against the trend is
ignored entirely (no entry, no state change).

**4.4 Entry level (the anchor).** `E = mid close of the trigger bar i`. This is a *level*, not a
fill — see §5.1.

**4.5 Stop.** Long: `E - 1.5 * ATR14[i]`. Short: `E + 1.5 * ATR14[i]`. ATR is the value on the
**trigger bar**.

**4.6 Target.** Long: `E + 3.0 * ATR14[i]`. Short: `E - 3.0 * ATR14[i]`. Risk:reward 1:2 by
construction. Note the asymmetry to watch: the stop/target are anchored at the trigger bar's
**mid close** `E`, while the actual fill happens at the **next bar's open** (§5.1) — so the
realised risk is not exactly 1.5 ATR unless the open equals the close.

**4.7 Exit on a rule event.** While long, the position closes when either (a) a downward cross
occurs, or (b) the trend filter turns down (EMA50 crossing below EMA200). While short, the
mirror. Rule exits are evaluated only on complete bars and are filled at the next bar's open
(§5.2).

**4.8 One event per bar.** Exits are applied before entries on the same bar, so a cross that
closes a position does not also open the opposite one. A cross can open a position; it can never
add to one.

**4.9 Scanning starts at bar index 200** — the first bar on which EMA(200), EMA(50), EMA(20) and
ATR(14) are all defined and a previous bar exists. Nothing before index 200 is reconstructed.
The measured period is therefore whatever index 200 onward covers; the report states
2003-01-15T20:00Z → 2026-10-12T16:00Z, and I check that independently (§5.6).

## 5. Execution model, costs, and where the protocol was ambiguous

### 5.1 Entry fill
The signal is only knowable once the trigger bar closes, so the fill is the **open of the next
bar (`i+1`)**, at the side the trade actually pays: **ASK for a long, BID for a short**. Never
the trigger bar's close, never the mid.

### 5.2 Rule-exit fill
Filled at the **open of the bar after the bar on which the exit rule fires**, at the opposite
side: **BID to close a long, ASK to close a short**.

### 5.3 Stop and target are also exit triggers
Both are tested **intra-bar** on every bar the position is open, against the side actually
traded: for a long, stop is breached when the bar's **bid low** ≤ stop, target reached when the
bar's **bid high** ≥ target; for a short, stop when the **ask high** ≥ stop, target when the
**ask low** ≤ target. Fill at the level itself (the stop or the target price).

### 5.4 Intra-bar tie-break, and gaps
- If one bar touches **both** stop and target, the **stop** is taken (pessimistic).
- If the bar's **open** is already beyond the stop, the fill is that bar's **open** (worse than
  the stop). If the open is already beyond the target, the fill is the open (better).
- **Chronology:** an intra-bar stop/target breach on bar `j` takes precedence over a rule exit
  that would fire at bar `j`'s close — the breach happened first in time.

### 5.5 Ambiguities in the written protocol (recorded, not resolved by guessing quietly)
- **(a) Is the entry bar itself scanned for stop/target?** The protocol says "every bar the
  position is open". I take the entry bar **as included** (the fill is at its open, so the same
  bar's range can breach). This matters only when the next open gaps beyond the stop/target.
- **(b) What happens after a stop/target exit, before the next signal?** The trade is closed; no
  new trade can open until a **new entry signal** fires. The rule's own "long/short" state is not
  re-entered or forced flat — the entry-signal stream is the only source of trades, and it is
  computed independently of whether a trade was stopped out. Consequence: a pair can sit flat
  for a long time while the rule's state machine still says "long".
- **(c) Ordering of the combined drawdown.** Combined (four-pair) drawdown and losing streaks are
  computed on trades ordered by **exit time** (a realised-equity curve). Per-pair drawdowns are
  per-pair curves in the same order.
- **(d) Held-out window.** "2025-10-12 → 2026-10-12" is applied by **entry fill time**
  `>= 2025-10-12T00:00Z` and `<= 2026-10-12T23:59:59Z`.
- **(e) R.** `R = pips / stop_distance_in_pips`, where `stop_distance` is `1.5 * ATR14[trigger]`
  in pips. So `R` measures pips against the *intended* risk, not the realised one.

### 5.6 Costs and what is excluded
The three variants, all on the same signals and the same timing:
- **Headline:** next-bar-open fills, ask to buy / bid to sell, bid to exit long / ask to exit
  short. Real historical bid/ask from the same bars.
- **Zero-cost:** identical timing, **mid on both sides** — isolates the spread.
- **Optimistic (upper bound, not achievable):** entry at the trigger bar's **mid close** instead
  of the next open. Labelled optimistic; it uses a price only knowable after the bar ended.

**Excluded from every number:** swap/financing, slippage beyond the quoted spread, commission,
taxes, position sizing, equity, leverage, margin. Weekend gaps left as gaps.

### 5.7 What is measured
Total pips, trades, wins/losses, win rate, average win, average loss, expectancy per trade,
profit factor, longest losing streak, max drawdown in pips and in R, exit-reason mix, per pair
and combined; the same for zero-cost and optimistic; the held-out final 12 months separately;
year-by-year; and holding-time distribution.

### 5.8 Sanity anchors I will check before trusting my own run
- Bar counts per pair must match the report's table (138,999 / 138,789 / 138,900 / 138,816).
- First measured bar must be the bar at index 200 of the raw series, and I will report its UTC
  time rather than assume 2003-01-15.
- The early bars in the hourly file are **not hourly** — the first lines of `EUR_USD.jsonl` are
  86,400 s apart, i.e. daily bars, until the broker's true H1 history begins. This is a property
  of the data that materially affects where index 200 falls, and I will measure it.
