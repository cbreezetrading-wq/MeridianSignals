/**
 * Meridian Signals — honest backtest of the SAME ruleset on DAILY bars.
 *
 * Everything about the rules, the indicators and the fill conventions is inherited from
 * /home/team/shared/backtest/run_backtest.ts (the H1 run). This file is a deliberate
 * near-copy so the two runs are genuinely comparable. Every difference is listed here
 * AND in daily-report.md §2 "what differs from the H1 run":
 *
 *   1. DATA DIR     : /home/team/shared/daily/data (granularity D) instead of .../backtest/data (H1).
 *   2. BAR GRID     : the H1 run measured missing bars against a 1-hour grid. A daily
 *                     FX grid is Mon–Fri only (no Saturday/Sunday bar) plus market
 *                     holidays, so an hourly-grid check would report every weekend as a
 *                     gap and mean nothing. Here "gaps" = weekdays (Mon–Fri) inside the
 *                     cached span that have no bar. Reported, not interpolated.
 *   3. HOLDING TIME : reported in DAYS (median/mean/p90/max and a day-bucketed
 *                     histogram) as well as hours, because the daily test's whole point
 *                     is cost-per-trade vs move-size, and swap scales with days held.
 *   4. RECONCILIATION: the H1 run reconciled its triggers against the LIVE dashboard,
 *                     which is an H1 engine. A daily trigger is not comparable to an H1
 *                     signal, so that check is reported as not-applicable rather than
 *                     run and mis-read. The daily run prints its own last trigger per
 *                     pair instead.
 *   5. COST/EDGE    : a decomposition block (gross edge, spread paid, net) is written to
 *                     results.json, computed by subtraction from the stored variant
 *                     results, so the reader can check cost-vs-edge himself.
 *   6. COMPARISON   : the H1 run's headline figures are read from
 *                     /home/team/shared/backtest/results.json and embedded for a
 *                     like-for-like comparison. No H1 number is typed by hand.
 *
 * Fills (headline, the only one claimed as achievable):
 *   entry : the OPEN of the bar AFTER the trigger bar, at the ASK for a long and the
 *           BID for a short.
 *   exits : at the opposite side (BID to close a long, ASK to close a short).
 *   The trigger bar's close is only known once that bar has finished, so it is never
 *   used as a headline fill. The trigger-close variant is reported separately and
 *   labelled as an optimistic upper bound.
 *
 * Intra-bar ambiguity is resolved pessimistically: if a bar's range touches both the
 * stop and the target, the STOP is taken. If a bar opens beyond the stop, the fill is
 * that bar's OPEN — worse than the stop.
 *
 * Excluded and not modelled in any number here: swap/financing, slippage beyond the
 * quoted spread, commission, taxes, and all position sizing.
 */
import { atr } from "../site/src/lib/market/indicators.ts";
import { RULESET_VERSION, runRulesetEvents } from "../site/src/lib/market/ruleset.ts";
import type { Bar } from "../site/src/lib/market/types.ts";

const DATA = "/home/team/shared/daily/data";
const OUT = "/home/team/shared/daily";
const H1_RESULTS = "/home/team/shared/backtest/results.json";

type PairCfg = { instrument: string; label: string; decimals: number; pip: number };

const PAIRS: PairCfg[] = [
  { instrument: "EUR_USD", label: "EUR/USD", decimals: 5, pip: 0.0001 },
  { instrument: "GBP_USD", label: "GBP/USD", decimals: 5, pip: 0.0001 },
  { instrument: "USD_JPY", label: "USD/JPY", decimals: 3, pip: 0.01 },
  { instrument: "AUD_USD", label: "AUD/USD", decimals: 5, pip: 0.0001 },
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

type Row = number[];

type Series = {
  cfg: PairCfg;
  bars: Bar[]; // MID series — what the ruleset and every indicator see
  ask: number[][];
  bid: number[][];
  tMs: number[];
};

async function loadSeries(cfg: PairCfg): Promise<Series> {
  const text = await Bun.file(`${DATA}/${cfg.instrument}.jsonl`).text();
  const rows: Row[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Row);
  rows.sort((a, b) => a[0]! - b[0]!);
  const bars: Bar[] = [];
  const ask: number[][] = [];
  const bid: number[][] = [];
  const tMs: number[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const t = r[0]!;
    if (seen.has(t)) continue; // de-duplicate page overlap
    seen.add(t);
    bars.push({ t, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
    ask.push([r[5]!, r[6]!, r[7]!, r[8]!]);
    bid.push([r[9]!, r[10]!, r[11]!, r[12]!]);
    tMs.push(t * 1000);
  }
  return { cfg, bars, ask, bid, tMs };
}

type Variant = "headline" | "zeroCost" | "triggerClose";

type Trade = {
  pair: string;
  side: "long" | "short";
  triggerBarUtc: string;
  triggerRule: string;
  liveReferenceEntry: number;
  stop: number;
  target: number;
  atrAtTrigger: number;
  riskPips: number;
  fillBarUtc: string;
  fillPrice: number;
  exitBarUtc: string | null;
  exitPrice: number | null;
  exitReason: "stop" | "target" | "cross-against" | "trend-flick" | "still-open-at-data-end";
  holdingHours: number | null;
  holdingDays: number | null;
  holdingBars: number | null;
  grossPips: number | null;
  pips: number | null;
  r: number | null;
  spreadAtFillPips: number;
  spreadCostPips: number | null;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Replay one pair. `variant` decides only how orders are filled — the rule events are
 * identical across variants, from the same live code.
 */
function replay(s: Series, variant: Variant): Trade[] {
  const { cfg, bars, ask, bid, tMs } = s;
  if (bars.length < 220) return [];
  const closes = bars.map((b) => b.c);
  const atr14 = atr(bars, 14);
  const { events } = runRulesetEvents(bars);

  const closesByIndex = new Map<number, "cross-against" | "trend-flick">();
  for (const e of events) {
    if (e.name === "closed-long-on-cross" || e.name === "closed-short-on-cross") {
      closesByIndex.set(e.index, "cross-against");
    } else if (e.name === "closed-long-on-trend-flick" || e.name === "closed-short-on-trend-flick") {
      closesByIndex.set(e.index, "trend-flick");
    }
  }

  const mid = variant !== "headline";
  const fillAtClose = variant === "triggerClose";
  const trades: Trade[] = [];

  for (let k = 0; k < events.length; k++) {
    const ev = events[k]!;
    if (ev.name !== "opened-long" && ev.name !== "opened-short") continue;
    const i = ev.index;
    const side: "long" | "short" = ev.name === "opened-long" ? "long" : "short";
    const referenceEntry = closes[i]!;
    const atrAtTrigger = atr14[i];
    if (atrAtTrigger === null || !Number.isFinite(atrAtTrigger) || atrAtTrigger <= 0) continue;
    const stop = side === "long" ? referenceEntry - 1.5 * atrAtTrigger : referenceEntry + 1.5 * atrAtTrigger;
    const target = side === "long" ? referenceEntry + 3.0 * atrAtTrigger : referenceEntry - 3.0 * atrAtTrigger;
    const riskPips = (1.5 * atrAtTrigger) / cfg.pip;

    // ---- entry fill -------------------------------------------------------
    let fillIdx: number;
    let fillPrice: number;
    let scanFrom: number;
    if (fillAtClose) {
      fillIdx = i;
      fillPrice = referenceEntry; // mid close of the trigger bar
      scanFrom = i + 1; // the trigger bar was already over when we filled
    } else {
      fillIdx = i + 1;
      if (fillIdx >= bars.length) break; // no bar left to fill on
      fillPrice = mid ? closes[fillIdx]! : side === "long" ? ask[fillIdx]![0]! : bid[fillIdx]![0]!;
      scanFrom = fillIdx; // we are in the market from this bar's open
    }
    const spreadAtFillPips = (ask[fillIdx]![0]! - bid[fillIdx]![0]!) / cfg.pip;

    // ---- exit -------------------------------------------------------------
    let exitIdx: number | null = null;
    let exitPrice: number | null = null;
    let exitReason: Trade["exitReason"] = "still-open-at-data-end";

    for (let j = scanFrom; j < bars.length; j++) {
      const hi = mid ? bars[j]!.h : side === "long" ? bid[j]![1]! : ask[j]![1]!;
      const lo = mid ? bars[j]!.l : side === "long" ? bid[j]![2]! : ask[j]![2]!;
      const open = mid ? bars[j]!.o : side === "long" ? bid[j]![0]! : ask[j]![0]!;

      // Pessimistic: the stop is tested before the target.
      if (side === "long" ? lo <= stop : hi >= stop) {
        exitIdx = j;
        exitPrice = side === "long" ? Math.min(stop, open) : Math.max(stop, open); // gap past the stop fills at the open
        exitReason = "stop";
        break;
      }
      if (side === "long" ? hi >= target : lo <= target) {
        exitIdx = j;
        exitPrice = side === "long" ? Math.max(target, open) : Math.min(target, open); // gap past the target fills at the open
        exitReason = "target";
        break;
      }
      const why = closesByIndex.get(j);
      if (why !== undefined) {
        exitReason = why;
        if (fillAtClose) {
          exitIdx = j;
          exitPrice = closes[j]!;
        } else {
          if (j + 1 >= bars.length) {
            exitIdx = null;
            exitPrice = null;
            exitReason = "still-open-at-data-end";
            break;
          }
          exitIdx = j + 1;
          exitPrice = mid ? closes[j + 1]! : side === "long" ? bid[j + 1]![0]! : ask[j + 1]![0]!;
        }
        break;
      }
    }

    const openTrade = exitIdx === null || exitPrice === null;
    const grossPips = openTrade
      ? null
      : (side === "long" ? exitPrice! - fillPrice : fillPrice - exitPrice!) / cfg.pip;
    let spreadCostPips: number | null = null;
    if (!openTrade) {
      const midEntry = mid ? fillPrice : closes[fillIdx]!;
      const midExit = mid ? exitPrice! : closes[exitIdx!]!;
      const midGross = (side === "long" ? midExit - midEntry : midEntry - midExit) / cfg.pip;
      spreadCostPips = midGross - grossPips!;
    }
    const holdMs = exitIdx === null ? null : tMs[exitIdx]! - tMs[fillIdx]!;

    trades.push({
      pair: cfg.label,
      side,
      triggerBarUtc: iso(tMs[i]!),
      triggerRule: ev.name,
      liveReferenceEntry: referenceEntry,
      stop,
      target,
      atrAtTrigger,
      riskPips,
      fillBarUtc: iso(tMs[fillIdx]!),
      fillPrice,
      exitBarUtc: exitIdx === null ? null : iso(tMs[exitIdx]!),
      exitPrice,
      exitReason,
      holdingHours: holdMs === null ? null : holdMs / HOUR_MS,
      holdingDays: holdMs === null ? null : holdMs / DAY_MS,
      holdingBars: exitIdx === null ? null : exitIdx - fillIdx,
      grossPips,
      pips: grossPips,
      r: grossPips === null ? null : grossPips / riskPips,
      spreadAtFillPips,
      spreadCostPips,
    });
  }
  return trades;
}

/* ------------------------------------------------------------------ statistics */

function stats(trades: Trade[]) {
  const closed = trades.filter((t) => t.pips !== null);
  const n = closed.length;
  const wins = closed.filter((t) => t.pips! > 0);
  const losses = closed.filter((t) => t.pips! <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pips!, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pips!, 0));
  const totalPips = closed.reduce((a, t) => a + t.pips!, 0);
  const totalR = closed.reduce((a, t) => a + t.r!, 0);

  let cum = 0;
  let peak = 0;
  let maxDdPips = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let streak = 0;
  let longestLoss = 0;
  for (const t of closed) {
    cum += t.pips!;
    peak = Math.max(peak, cum);
    maxDdPips = Math.max(maxDdPips, peak - cum);
    cumR += t.r!;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
    if (t.pips! <= 0) {
      streak += 1;
      longestLoss = Math.max(longestLoss, streak);
    } else streak = 0;
  }

  const daySort = closed.map((t) => t.holdingDays!).sort((a, b) => a - b);
  const pct = (p: number) => (daySort.length === 0 ? null : round(daySort[Math.min(daySort.length - 1, Math.floor(daySort.length * p))]!, 1));
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const byReason: Record<string, number> = {};
  for (const t of closed) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n === 0 ? null : round((wins.length / n) * 100, 1),
    avgWinPips: wins.length === 0 ? null : round(grossWin / wins.length, 1),
    avgLossPips: losses.length === 0 ? null : round(-grossLoss / losses.length, 1),
    expectancyPipsPerTrade: n === 0 ? null : round(totalPips / n, 2),
    totalPips: round(totalPips, 1),
    avgRPerTrade: n === 0 ? null : round(totalR / n, 3),
    totalR: round(totalR, 2),
    maxDrawdownPips: round(maxDdPips, 1),
    maxDrawdownR: round(maxDdR, 2),
    profitFactor: grossLoss === 0 ? null : round(grossWin / grossLoss, 2),
    longestLosingStreak: longestLoss,
    medianHoldingDays: median(daySort),
    meanHoldingDays: mean(daySort) === null ? null : round(mean(daySort)!, 1),
    p90HoldingDays: pct(0.9),
    maxHoldingDays: daySort.length === 0 ? null : round(daySort[daySort.length - 1]!, 1),
    medianHoldingHours: median(daySort) === null ? null : round(median(daySort)! * 24, 1),
    meanRiskPips: n === 0 ? null : round(closed.reduce((a, t) => a + t.riskPips, 0) / n, 1),
    meanHoldingBars: mean(closed.map((t) => t.holdingBars!).filter((x) => x !== null)) === null
      ? null
      : round(mean(closed.map((t) => t.holdingBars!).filter((x) => x !== null))!, 1),
    exitReasons: byReason,
    tradesStillOpenAtDataEnd: trades.filter((t) => t.pips === null).length,
    statisticallyMeaningful: n >= 30,
  };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  return round(sorted[Math.floor(sorted.length / 2)]!, 1);
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function pooled(all: Trade[][]): Trade[] {
  return all.flat().sort((a, b) => Date.parse(a.fillBarUtc) - Date.parse(b.fillBarUtc));
}

function yearByYear(trades: Trade[]) {
  const closed = trades.filter((t) => t.pips !== null);
  const years = [...new Set(closed.map((t) => t.exitBarUtc!.slice(0, 4)))].sort();
  return years.map((y) => {
    const ys = closed.filter((t) => t.exitBarUtc!.slice(0, 4) === y);
    const wins = ys.filter((t) => t.pips! > 0).length;
    return {
      year: y,
      trades: ys.length,
      wins,
      losses: ys.length - wins,
      winRatePct: ys.length === 0 ? null : round((wins / ys.length) * 100, 1),
      totalPips: round(ys.reduce((a, t) => a + t.pips!, 0), 1),
      totalR: round(ys.reduce((a, t) => a + t.r!, 0), 2),
    };
  });
}

/* ------------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const series = await Promise.all(PAIRS.map(loadSeries));
  const variants: Variant[] = ["headline", "zeroCost", "triggerClose"];
  const perVariant: Record<string, Record<string, Trade[]>> = {};
  for (const v of variants) {
    perVariant[v] = {};
    for (const s of series) perVariant[v]![s.cfg.instrument] = replay(s, v);
  }

  const lastBarMs = Math.max(...series.map((s) => s.tMs[s.tMs.length - 1]!));
  const heldOutCutMs = lastBarMs - YEAR_MS;

  const dataWindow: Record<string, unknown> = {};
  for (const s of series) {
    const meta = JSON.parse(await Bun.file(`${DATA}/${s.cfg.instrument}.meta.json`).text()) as Record<string, unknown>;
    // A daily FX bar is stamped at the DAILY ROLLOVER (21:00 or 22:00 UTC depending on US
    // DST — see barOpenHourUtcHistogram), so a bar's calendar date is not its trading
    // date: a Sunday-stamped bar is Monday's session. Each bar is therefore mapped to the
    // trading day it belongs to by shifting +3h onto a UTC midnight, and a weekday with no
    // shifted bar inside the span is a genuinely missing trading day.
    const have = new Set(s.tMs.map((t) => Math.floor((t + 3 * HOUR_MS) / DAY_MS)));
    let missingWeekdays = 0;
    let weekdays = 0;
    const days = [...have].sort((a, b) => a - b);
    for (let d = days[0]!; d <= days[days.length - 1]!; d++) {
      const dow = new Date(d * DAY_MS).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      weekdays += 1;
      if (!have.has(d)) missingWeekdays += 1;
    }
    const openHours: Record<string, number> = {};
    for (const t of s.tMs) {
      const h = `${String(new Date(t).getUTCHours())}:00Z`;
      openHours[h] = (openHours[h] ?? 0) + 1;
    }
    // Bars whose spacing is not a single weekday step (weekend/holiday skip is normal).
    const spacings: Record<string, number> = {};
    for (let i = 1; i < s.tMs.length; i++) {
      const days = Math.round((s.tMs[i]! - s.tMs[i - 1]!) / DAY_MS);
      const k = `${String(days)}d-step`;
      spacings[k] = (spacings[k] ?? 0) + 1;
    }
    dataWindow[s.cfg.instrument] = {
      label: s.cfg.label,
      firstBarUtc: iso(s.tMs[0]!),
      lastBarUtc: iso(s.tMs[s.tMs.length - 1]!),
      bars: s.bars.length,
      incompleteCandlesRefused: meta.incompleteCandlesRefused,
      pagesRequested: meta.pagesRequested,
      brokerOldestServedUtc: meta.earliestServedByBrokerUtc,
      weekdaysInsideSpan: weekdays,
      missingWeekdaysInsideSpan: missingWeekdays,
      barSpacingHistogram: spacings,
      barOpenHourUtcHistogram: openHours,
      gapRule:
        "each bar is shifted +3h onto its trading day before the weekday check (daily bars are stamped at the 21:00/22:00 UTC rollover, so a Sunday-stamped bar is Monday's session); a weekday with no bar is a missing trading day",
      spreadTimingNote:
        "the bar opens at the daily rollover, which is also the moment of the day when spreads are widest — so a fill at the next bar's open pays a wider-than-average spread for the pair",
    };
  }

  const summaryFor = (v: Variant, subset: (t: Trade) => boolean) => {
    const per: Record<string, unknown> = {};
    const allTrades: Trade[] = [];
    for (const s of series) {
      const ts = perVariant[v]![s.cfg.instrument]!.filter(subset);
      per[s.cfg.label] = stats(ts);
      allTrades.push(...ts);
    }
    return { perPair: per, combined: stats(allTrades.sort((a, b) => Date.parse(a.fillBarUtc) - Date.parse(b.fillBarUtc))) };
  };

  const inHoldout = (t: Trade) => Date.parse(t.fillBarUtc) >= heldOutCutMs;
  const inFull = () => true;

  const spreads: Record<string, unknown> = {};
  for (const s of series) {
    const all = s.ask.map((a, i) => (a[0]! - s.bid[i]![0]!) / s.cfg.pip);
    all.sort((a, b) => a - b);
    const onFills = perVariant.headline![s.cfg.instrument]!.map((t) => t.spreadAtFillPips).sort((a, b) => a - b);
    const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
    spreads[s.cfg.label] = {
      allBarsMeanSpreadPips: round(mean(all)!, 3),
      allBarsMedianSpreadPips: round(all[Math.floor(all.length / 2)]!, 3),
      meanSpreadAtEntryFillPips: onFills.length === 0 ? null : round(mean(onFills)!, 3),
      medianSpreadAtEntryFillPips: onFills.length === 0 ? null : round(onFills[Math.floor(onFills.length / 2)]!, 3),
    };
  }

  // Holding distribution in DAYS — the daily run's answer to "is swap negligible?".
  const holding: Record<string, unknown> = {};
  const allHeadlineClosed = pooled(series.map((s) => perVariant.headline![s.cfg.instrument]!)).filter((t) => t.pips !== null);
  {
    const h = allHeadlineClosed.map((t) => t.holdingDays!).sort((a, b) => a - b);
    const buckets = [0, 1, 2, 4, 7, 14, 28, 90, 1e9];
    const labels = ["<1d", "1-2d", "2-4d", "4-7d", "1-2w", "2-4w", "1-3m", "3m+"];
    const hist: Record<string, number> = {};
    for (let i = 0; i < labels.length; i++) {
      hist[labels[i]!] = h.filter((x) => x >= buckets[i]! && x < buckets[i + 1]!).length;
    }
    const mean = h.reduce((a, b) => a + b, 0) / Math.max(1, h.length);
    holding.combinedHeadline = {
      trades: h.length,
      minDays: round(h[0] ?? 0, 2),
      medianDays: median(h),
      meanDays: round(mean, 2),
      p90Days: round(h[Math.floor(h.length * 0.9)] ?? 0, 1),
      maxDays: round(h[h.length - 1] ?? 0, 1),
      histogram: hist,
      note:
        "Holding time is what decides how much of a trade's cost is swap/financing. Swap is NOT modelled anywhere in this run — these figures exist only to size that omission, and they say it is large: at a daily median hold a trade pays multiple rollovers.",
    };
  }

  // Cost/edge decomposition, by subtraction from the stored variant results.
  const headFull = summaryFor("headline", inFull).combined as { trades: number; expectancyPipsPerTrade: number | null; totalPips: number; winRatePct: number | null; profitFactor: number | null };
  const zeroFull = summaryFor("zeroCost", inFull).combined as { trades: number; expectancyPipsPerTrade: number | null; totalPips: number; winRatePct: number | null; profitFactor: number | null };
  const optFull = summaryFor("triggerClose", inFull).combined as { trades: number; expectancyPipsPerTrade: number | null; totalPips: number };
  const meanSpreadAtFill = (() => {
    const xs = Object.values(spreads).map((v) => (v as { meanSpreadAtEntryFillPips: number | null }).meanSpreadAtEntryFillPips).filter((x): x is number => x !== null);
    return round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), 3);
  })();
  const costEdge = {
    perTradePips: {
      grossEdge: zeroFull.expectancyPipsPerTrade,
      spreadPaid: zeroFull.expectancyPipsPerTrade === null || headFull.expectancyPipsPerTrade === null ? null : round(zeroFull.expectancyPipsPerTrade - headFull.expectancyPipsPerTrade, 2),
      net: headFull.expectancyPipsPerTrade,
    },
    totals: {
      grossPips: zeroFull.totalPips,
      spreadPaidPips: round(zeroFull.totalPips - headFull.totalPips, 1),
      netPips: headFull.totalPips,
    },
    meanSpreadAtEntryFillPips: meanSpreadAtFill,
    // The same decomposition in R, which is the only fair way to compare cost across
    // timeframes: a pip is not a unit of risk, but 1R always is.
    inR: (() => {
      const meanRisk = (summaryFor("headline", inFull).combined as { meanRiskPips: number | null }).meanRiskPips;
      const h = summaryFor("headline", inFull).combined as { avgRPerTrade: number | null };
      const z = summaryFor("zeroCost", inFull).combined as { avgRPerTrade: number | null };
      if (meanRisk === null || h.avgRPerTrade === null || z.avgRPerTrade === null) return null;
      return {
        meanRiskPips: meanRisk,
        grossEdgeR: z.avgRPerTrade,
        spreadPaidR: round(z.avgRPerTrade - h.avgRPerTrade, 4),
        netR: h.avgRPerTrade,
        spreadPaidAsPctOfRisk: round(((z.avgRPerTrade - h.avgRPerTrade) / meanRisk) * 100, 2),
        note: "spread paid as a fraction of the trade's initial risk (1R = 1.5 x ATR(14)). This is the number that decides whether lower frequency improved the cost-to-edge ratio.",
      };
    })(),
    costAsMultipleOfGrossEdge:
      zeroFull.expectancyPipsPerTrade !== null && zeroFull.expectancyPipsPerTrade > 0 && headFull.expectancyPipsPerTrade !== null
        ? round((zeroFull.expectancyPipsPerTrade - headFull.expectancyPipsPerTrade) / zeroFull.expectancyPipsPerTrade, 2)
        : null,
    howComputed:
      "spreadPaid = zero-cost expectancy (mid fills, same timing) minus headline expectancy (next-bar open at ask/bid). Both from the stored results; nothing typed by hand. The zero-cost replay fills at mid and can exit on a mid high/low rather than a bid/ask one, so a handful of trades may exit on a different bar; the subtraction is therefore a whole-book cost measure, not a per-trade ledger.",
    crossCheck: {
      meanSpreadAtEntryFillPips: meanSpreadAtFill,
      note: "one full spread per round trip (enter at ask / exit at bid, or the reverse) should equal the spread-paid figure above if the two runs took the same trades",
    },
  };

  // H1 comparison, read from the H1 results file (no hand-copied numbers).
  let h1Comparison: unknown = null;
  try {
    const h1 = JSON.parse(await Bun.file(H1_RESULTS).text()) as {
      results?: Record<string, { fullPeriod?: { combined?: Record<string, unknown> }; last12MonthsHeldOut?: { combined?: Record<string, unknown> } }>;
      holdingTimes?: { combinedHeadline?: Record<string, unknown> };
      dataWindow?: Record<string, { firstBarUtc?: string; lastBarUtc?: string; bars?: number }>;
    };
    const pick = (v: string, w: "fullPeriod" | "last12MonthsHeldOut") => {
      const c = h1.results?.[v]?.[w]?.combined as Record<string, unknown> | undefined;
      if (!c) return null;
      return {
        trades: c.trades,
        winRatePct: c.winRatePct,
        expectancyPipsPerTrade: c.expectancyPipsPerTrade,
        totalPips: c.totalPips,
        totalR: c.totalR,
        profitFactor: c.profitFactor,
        maxDrawdownPips: c.maxDrawdownPips,
        maxDrawdownR: c.maxDrawdownR,
        longestLosingStreak: c.longestLosingStreak,
      };
    };
    h1Comparison = {
      source: H1_RESULTS,
      granularityH1: {
        headline: pick("headline_nextBarOpen_bidAsk", "fullPeriod"),
        zeroCost: pick("zeroCost_mid_nextBarOpen", "fullPeriod"),
        last12MonthsHeadline: pick("headline_nextBarOpen_bidAsk", "last12MonthsHeldOut"),
        last12MonthsZeroCost: pick("zeroCost_mid_nextBarOpen", "last12MonthsHeldOut"),
        medianHoldingHours: h1.holdingTimes?.combinedHeadline?.medianHours ?? null,
      },
    };
  } catch (e) {
    h1Comparison = { error: String(e).slice(0, 300) };
  }

  const years = yearByYear(allHeadlineClosed);
  const positiveYears = years.filter((y) => y.totalPips > 0).length;

  const results = {
    generatedAt: new Date().toISOString(),
    rulesetVersion: RULESET_VERSION,
    granularity: "D",
    engineCode: [
      "/home/team/shared/site/src/lib/market/ruleset.ts (runRulesetEvents)",
      "/home/team/shared/site/src/lib/market/indicators.ts (atr)",
      "replay/fill/statistics copied from /home/team/shared/backtest/run_backtest.ts — differences listed in differencesFromH1Run",
    ],
    differencesFromH1Run: [
      "data granularity D (daily) and data dir /home/team/shared/daily/data instead of H1 /home/team/shared/backtest/data",
      "gap accounting: weekdays with no bar inside the span (daily FX has no weekend bars), not an hourly grid",
      "holding time reported in days (plus hours and bar count); day-bucketed histogram",
      "no reconciliation against the live dashboard, which is an H1 engine — a daily trigger is not comparable to an H1 signal",
      "cost/edge decomposition block added",
      "H1 headline figures embedded for comparison by reading /home/team/shared/backtest/results.json",
    ],
    dataWindow,
    measurementPeriod: {
      headlineStartUtc: new Date(Math.min(...series.map((s) => s.tMs[220] ?? s.tMs[0]!))).toISOString(),
      headlineEndUtc: iso(lastBarMs),
      heldOutLast12MonthsFromUtc: iso(heldOutCutMs),
      note: "The ruleset cannot produce a first event before bar index 200 (EMA(200)); the measurement period is therefore the full cached span minus that warm-up (~10 months of daily bars).",
    },
    assumptions: {
      fillHeadline: "entry at the NEXT bar's open, ASK for a long / BID for a short; exits at the opposite side. No look-ahead.",
      fillOptimistic: "entry at the trigger bar's CLOSE (mid), exits at the exit bar's close (mid) — labelled OPTIMISTIC UPPER BOUND, not achievable.",
      fillZeroCost: "same timing as headline (next-bar open) but at MID on both sides, so the spread drag is visible.",
      intraBarAmbiguity: "if a bar touches both stop and target, the STOP is counted first.",
      gaps: "a bar opening beyond the stop fills at that bar's open (worse than the stop); a bar opening beyond the target fills at that bar's open (better than the target).",
      ruleExit: "an exit the rules trigger at a bar's close is filled at the NEXT bar's open, same no-look-ahead rule as entries.",
      stopsAndTargets: "stop = 1.5 x ATR(14) and target = 3.0 x ATR(14), both measured from the trigger bar's mid close, identical to the live engine. Stop/target are treated as exit triggers alongside the rule's own exit (cross against, or trend-filter flip).",
      onePositionPerPair: true,
      pyramiding: false,
      optimisation: "NONE. No parameter search, no sweep, no per-pair tuning. One ruleset, unchanged from the H1 run.",
      r: "1R = the trade's initial stop distance (1.5 x ATR(14) at the trigger bar, in pips).",
      spreadSource: "the ASK minus BID of the same bar in the owner's own OANDA practice-account history — a real historical spread per bar, not an assumption.",
    },
    exclusions: [
      "swap / financing / carry charges — NOT modelled",
      "slippage beyond the quoted bid/ask spread — NOT modelled",
      "commission, fees and taxes — NOT modelled",
      "position sizing and account equity — NOT modelled; every result is in pips and R",
      "weekend/holiday gaps are left as gaps; no bar is interpolated or filled in",
    ],
    reconciliationWithLive: {
      applicable: false,
      why: "the live dashboard runs the ruleset on H1 bars; a daily trigger bar cannot be compared to an H1 signal, so this check is not meaningful and is not claimed as passed.",
      lastDailyTriggerPerPair: Object.fromEntries(
        series.map((s) => {
          const { events } = runRulesetEvents(s.bars);
          const opens = events.filter((e) => e.name.startsWith("opened"));
          const last = opens[opens.length - 1] ?? null;
          return [
            s.cfg.label,
            {
              triggerBarUtc: last === null ? null : iso(s.tMs[last.index]!),
              side: last === null ? null : last.name === "opened-long" ? "long" : "short",
              triggerClose: last === null ? null : s.bars[last.index]!.c,
              triggerIsOnFinalCachedBar: last !== null && last.index === s.bars.length - 1,
            },
          ];
        }),
      ),
    },
    spreadsPaid: spreads,
    holdingTimes: holding,
    costEdgeDecomposition: costEdge,
    results: {
      headline_nextBarOpen_bidAsk: { fullPeriod: summaryFor("headline", inFull), last12MonthsHeldOut: summaryFor("headline", inHoldout) },
      zeroCost_mid_nextBarOpen: { fullPeriod: summaryFor("zeroCost", inFull), last12MonthsHeldOut: summaryFor("zeroCost", inHoldout) },
      optimisticUpperBound_triggerClose: {
        label: "OPTIMISTIC UPPER BOUND — fills at the trigger bar's close, which is only knowable after that bar has ended. NOT achievable in practice.",
        fullPeriod: summaryFor("triggerClose", inFull),
        last12MonthsHeldOut: summaryFor("triggerClose", inHoldout),
      },
    },
    yearByYear: {
      headline: {
        perPair: Object.fromEntries(series.map((s) => [s.cfg.label, yearByYear(perVariant.headline![s.cfg.instrument]!)])),
        combined: years,
        positiveYears,
        measuredYears: years.length,
        note: "a year counts as positive if the combined headline pips for trades CLOSED in that year are above zero",
      },
    },
    comparisonH1: h1Comparison,
    tradesHeadline: perVariant.headline,
  };

  await Bun.write(`${OUT}/results.json`, JSON.stringify(results, null, 2) + "\n");

  const lines: string[] = [];
  lines.push(`generated ${results.generatedAt}  ruleset ${RULESET_VERSION}  granularity D`);
  for (const [k, m] of Object.entries(dataWindow)) {
    const mm = m as Record<string, unknown>;
    lines.push(`${k}: ${mm.bars} bars  ${mm.firstBarUtc} .. ${mm.lastBarUtc}  incomplete refused ${mm.incompleteCandlesRefused}  missingWeekdays ${mm.missingWeekdaysInsideSpan}/${mm.weekdaysInsideSpan}`);
  }
  for (const v of ["headline_nextBarOpen_bidAsk", "zeroCost_mid_nextBarOpen", "optimisticUpperBound_triggerClose"] as const) {
    lines.push(`--- ${v} ---`);
    const r = (results.results as Record<string, { fullPeriod: { perPair: Record<string, { trades: number; expectancyPipsPerTrade: number | null; totalPips: number; totalR: number; winRatePct: number | null }>; combined: Record<string, unknown> } }>)[v]!;
    for (const [p, st] of Object.entries(r.fullPeriod.perPair)) {
      lines.push(`  ${p}: n=${st.trades} win%=${st.winRatePct} exp=${st.expectancyPipsPerTrade} pips=${st.totalPips} R=${st.totalR}`);
    }
    const c = r.fullPeriod.combined as Record<string, unknown>;
    lines.push(`  COMBINED: n=${c.trades} win%=${c.winRatePct} exp=${c.expectancyPipsPerTrade} pips=${c.totalPips} R=${c.totalR} PF=${c.profitFactor} maxDDpips=${c.maxDrawdownPips} maxDDR=${c.maxDrawdownR} streak=${c.longestLosingStreak} medHoldDays=${c.medianHoldingDays} meanHoldDays=${c.meanHoldingDays}`);
  }
  lines.push(`--- cost/edge ---`);
  lines.push(JSON.stringify(costEdge.perTradePips));
  lines.push(`--- years: ${positiveYears}/${years.length} positive ---`);
  lines.push(`--- holding (days) ---`);
  lines.push(JSON.stringify(holding.combinedHeadline));
  await Bun.write(`${OUT}/run-summary.txt`, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

await main();
