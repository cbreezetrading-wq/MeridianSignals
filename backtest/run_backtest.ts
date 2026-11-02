/**
 * Meridian Signals — honest backtest of the H1 ruleset on the owner's OANDA history.
 *
 * The rules and indicator maths are NOT re-implemented here. The event stream comes
 * from `runRulesetEvents` in the live site's ruleset.ts, and the indicators from the
 * live indicators.ts, so the backtest and the dashboard cannot drift apart.
 *
 * Fills (headline, the only one claimed as achievable):
 *   entry : the OPEN of the bar AFTER the trigger bar, at the ASK for a long and the
 *           BID for a short.
 *   exits : at the opposite side (BID to close a long, ASK to close a short).
 *   The trigger bar's close is only known once that bar has finished, so it is never
 *   used as a headline fill.
 *
 * The other two variants exist to decompose the cost, and each states its convention:
 *
 *   zeroCost_mid_nextBarOpen — identical timing to the headline, MID prices on both
 *     sides: the mid OPEN of the bar after the trigger for the entry, the mid OPEN of
 *     the bar after a rule-exit bar for a rule exit, and the same stop/target LEVEL
 *     (a level is basis-independent). Spread removed, everything else held.
 *     CORRECTED 2026-11-02: this variant used to take the mid CLOSE of those bars
 *     instead of the mid OPEN, which re-timed every trade by one hour and inflated the
 *     result by 503.9 pips (+4,289.1 vs the true +3,785.1). See
 *     /home/team/shared/verify/audit-findings.md §5.1 and backtest-report.md §10.
 *
 *   optimisticUpperBound_triggerClose — a look-ahead on BOTH legs: the entry is the
 *     mid close of the trigger bar, and a rule exit is the mid close of the cross bar.
 *     Each leg is priced at the close of the bar that produced its signal, a level only
 *     knowable once that bar has ended. Not achievable. Reported only as a ceiling.
 *
 * Intra-bar ambiguity is resolved pessimistically: if a bar's range touches both the
 * stop and the target, the STOP is taken. If a bar opens beyond the stop, the fill is
 * that bar's OPEN — worse than the stop.
 *
 * Excluded and not modelled in any number here: swap/financing, slippage beyond the
 * quoted spread, commission, taxes, and all position sizing.
 */
import { atr, ema } from "../site/src/lib/market/indicators.ts";
import { RULESET_VERSION, runRulesetEvents } from "../site/src/lib/market/ruleset.ts";
import type { Bar } from "../site/src/lib/market/types.ts";

const DATA = "/home/team/shared/backtest/data";
const OUT = "/home/team/shared/backtest";

type PairCfg = { instrument: string; label: string; decimals: number; pip: number };

const PAIRS: PairCfg[] = [
  { instrument: "EUR_USD", label: "EUR/USD", decimals: 5, pip: 0.0001 },
  { instrument: "GBP_USD", label: "GBP/USD", decimals: 5, pip: 0.0001 },
  { instrument: "USD_JPY", label: "USD/JPY", decimals: 3, pip: 0.01 },
  { instrument: "AUD_USD", label: "AUD/USD", decimals: 5, pip: 0.0001 },
];

const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 24 * HOUR_MS;

/** The index runRulesetEvents() starts scanning at (it needs EMA(200) plus a previous bar). */
const FIRST_EVALUATED_INDEX = 200;

/**
 * A year counts as genuinely hourly when at least this share of its consecutive-bar
 * gaps are 1 hour or less. 90%, not 100%: even a real hourly series has weekend and
 * holiday gaps. The years that fail it do not fail narrowly — 2003 and 2004 are 0%.
 */
const HOURLY_YEAR_SHARE = 0.9;

/** One cached row: [t, mid o/h/l/c, ask o/h/l/c, bid o/h/l/c] */
type Row = number[];

type Series = {
  cfg: PairCfg;
  bars: Bar[]; // MID series — what the ruleset and every indicator see
  ask: number[][]; // [o,h,l,c] per bar
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
  grossPips: number | null;
  pips: number | null;
  r: number | null;
  spreadAtFillPips: number;
  /**
   * The spread THIS trade crossed, in pips: the mid-priced gross at the same two
   * instants the bid/ask fills used, minus what the bid/ask fills produced. A stop or
   * target is a level, so it is basis-independent and contributes nothing on that leg —
   * which is why this sums to roughly half of the headline-minus-zero-cost gap and is a
   * decomposition of it, not a substitute for it. Renamed from `spreadCostPips`
   * (2026-11-02), whose mid leg was priced at bar CLOSES and so mixed two instants.
   */
  spreadCrossingCostPips: number | null;
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
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr14 = atr(bars, 14);
  const { events } = runRulesetEvents(bars);

  // close-event index -> reason, so an open position knows when the rules say "out".
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
      fillPrice = referenceEntry; // mid close of the trigger bar — a look-ahead
      scanFrom = i + 1; // the trigger bar was already over when we filled
    } else {
      fillIdx = i + 1;
      if (fillIdx >= bars.length) break; // no bar left to fill on
      // Same instant in every variant: the OPEN of the bar after the trigger.
      // (Until 2026-11-02 the mid variants took this bar's CLOSE instead, which
      // re-timed the trade by an hour; see the file header.)
      fillPrice = mid ? bars[fillIdx]!.o : side === "long" ? ask[fillIdx]![0]! : bid[fillIdx]![0]!;
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
          exitPrice = closes[j]!; // the cross bar's own close — a look-ahead
        } else {
          if (j + 1 >= bars.length) {
            exitIdx = null;
            exitPrice = null;
            exitReason = "still-open-at-data-end";
            break;
          }
          exitIdx = j + 1;
          // Same instant in every variant: the OPEN of the bar after the cross.
          exitPrice = mid ? bars[j + 1]!.o : side === "long" ? bid[j + 1]![0]! : ask[j + 1]![0]!;
        }
        break;
      }
    }

    const openTrade = exitIdx === null || exitPrice === null;
    const grossPips = openTrade
      ? null
      : (side === "long" ? (exitPrice! - fillPrice) : (fillPrice - exitPrice!)) / cfg.pip;
    // The spread crossed on this trade's own fills, in pips: the same two instants
    // priced at MID, minus what the bid/ask fills produced. A stop/target level is the
    // same price on either basis, so it contributes nothing on the exit leg.
    let spreadCrossingCostPips: number | null = null;
    if (!openTrade) {
      const midEntry = bars[fillIdx]!.o;
      const midExit =
        exitReason === "stop" || exitReason === "target" ? exitPrice! : bars[exitIdx!]!.o;
      const midGross = (side === "long" ? midExit - midEntry : midEntry - midExit) / cfg.pip;
      spreadCrossingCostPips = midGross - grossPips!;
    }

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
      holdingHours: exitIdx === null ? null : (tMs[exitIdx]! - tMs[fillIdx]!) / HOUR_MS,
      grossPips,
      pips: grossPips,
      r: grossPips === null ? null : grossPips / riskPips,
      spreadAtFillPips,
      spreadCrossingCostPips,
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

  const hold = closed.map((t) => t.holdingHours!).sort((a, b) => a - b);
  const median = hold.length === 0 ? null : hold[Math.floor(hold.length / 2)]!;
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
    medianHoldingHours: median === null ? null : round(median, 1),
    meanHoldingHours: hold.length === 0 ? null : round(hold.reduce((a, b) => a + b, 0) / hold.length, 1),
    exitReasons: byReason,
    tradesStillOpenAtDataEnd: trades.filter((t) => t.pips === null).length,
    statisticallyMeaningful: n >= 30,
  };
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

/**
 * How much of this file is actually hourly. The broker's H1 history is a DAILY series
 * until January 2005 — for 2003, none of the ~324 gaps between consecutive bars is an
 * hour or less — so the first ~2.6 years of this file cannot support an hourly backtest.
 * Measured here rather than asserted, and stored in the results.
 */
function hourlyCoverage(s: Series) {
  const perYear: Record<string, { gaps: number; gapsWithinHour: number; bars: number }> = {};
  for (let i = 0; i < s.tMs.length; i++) {
    const y = String(new Date(s.tMs[i]!).getUTCFullYear());
    const row = (perYear[y] ??= { gaps: 0, gapsWithinHour: 0, bars: 0 });
    row.bars += 1;
    if (i > 0) {
      row.gaps += 1;
      if (s.tMs[i]! - s.tMs[i - 1]! <= HOUR_MS) row.gapsWithinHour += 1;
    }
  }
  const years = Object.keys(perYear).sort();
  // The FIRST year at or after which the file is hourly: the earliest year whose own
  // share of <= 1-hour gaps clears the threshold. Later years are not required to clear
  // it again (a quiet year can be mostly weekend gaps), so this is the start of hourly
  // coverage, not a promise that every later year looks identical.
  const hourlyFromYear = years.find((y) => {
    const row = perYear[y]!;
    return row.gaps > 0 && row.gapsWithinHour / row.gaps >= HOURLY_YEAR_SHARE;
  }) ?? null;
  let hourlyFromUtc: string | null = null;
  let barsBefore = 0;
  if (hourlyFromYear !== null) {
    for (let i = 0; i < s.tMs.length; i++) {
      const y = String(new Date(s.tMs[i]!).getUTCFullYear());
      if (y < hourlyFromYear) barsBefore += 1;
      else if (hourlyFromUtc === null) hourlyFromUtc = iso(s.tMs[i]!);
    }
  }
  return {
    label: s.cfg.label,
    bars: s.bars.length,
    perYear,
    hourlyFromUtc,
    barsBeforeHourlyFrom: barsBefore,
    dailyResolutionPrelude: hourlyFromUtc !== null && barsBefore > 0,
  };
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
    let gaps = 0;
    let missing = 0;
    for (let i = 1; i < s.tMs.length; i++) {
      const step = s.tMs[i]! - s.tMs[i - 1]!;
      if (step !== HOUR_MS) {
        gaps += 1;
        missing += Math.round(step / HOUR_MS) - 1;
      }
    }
    dataWindow[s.cfg.instrument] = {
      label: s.cfg.label,
      firstBarUtc: iso(s.tMs[0]!),
      lastBarUtc: iso(s.tMs[s.tMs.length - 1]!),
      bars: s.bars.length,
      incompleteCandlesRefused: meta.incompleteCandlesRefused,
      pagesRequested: meta.pagesRequested,
      missingHourSlotsInsideSpan: missing,
      gapsInHourlyGrid: gaps,
      brokerOldestServedUtc: meta.earliestServedByBrokerUtc,
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

  // Spread actually paid, per pair, from the bars the trades filled on.
  const spreads: Record<string, unknown> = {};
  for (const s of series) {
    const all = s.ask.map((a, i) => (a[0]! - s.bid[i]![0]!) / s.cfg.pip);
    all.sort((a, b) => a - b);
    const onFills = perVariant.headline![s.cfg.instrument]!
      .map((t) => t.spreadAtFillPips)
      .sort((a, b) => a - b);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const headlineTrades = perVariant.headline![s.cfg.instrument]!.filter((t) => t.pips !== null);
    const zeroTrades = perVariant.zeroCost![s.cfg.instrument]!.filter((t) => t.pips !== null);
    const crossing = headlineTrades
      .map((t) => t.spreadCrossingCostPips)
      .filter((x): x is number => x !== null);
    spreads[s.cfg.label] = {
      allBarsMeanSpreadPips: round(mean(all), 3),
      allBarsMedianSpreadPips: round(all[Math.floor(all.length / 2)]!, 3),
      meanSpreadAtEntryFillPips: onFills.length === 0 ? null : round(mean(onFills), 3),
      medianSpreadAtEntryFillPips: onFills.length === 0 ? null : round(onFills[Math.floor(onFills.length / 2)]!, 3),
      /**
       * THE per-trade spread cost for this pair: the achievable variant's total pips
       * minus the zero-cost variant's total pips over the same trades, divided by the
       * trade count. Both inputs are stored under results.*.fullPeriod.perPair, so the
       * figure is a subtraction of two published totals and nothing else.
       */
      meanRoundTripSpreadCostPips:
        headlineTrades.length === 0
          ? null
          : round(
              (zeroTrades.reduce((a, t) => a + t.pips!, 0) - headlineTrades.reduce((a, t) => a + t.pips!, 0)) /
                headlineTrades.length,
              3,
            ),
      /** The crossing cost on the fills alone — a decomposition of the line above. */
      meanSpreadCrossingCostPips: crossing.length === 0 ? null : round(mean(crossing), 3),
    };
  }

  const holding: Record<string, unknown> = {};
  {
    const h = perVariant.headline!.EUR_USD!
      .concat(perVariant.headline!.GBP_USD!, perVariant.headline!.USD_JPY!, perVariant.headline!.AUD_USD!)
      .map((t) => t.holdingHours)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    const buckets = [0, 6, 12, 24, 48, 96, 168, 336, 1e9];
    const labels = ["<6h", "6-12h", "12-24h", "1-2d", "2-4d", "4-7d", "1-2w", "2w+"];
    const hist: Record<string, number> = {};
    for (let i = 0; i < labels.length; i++) {
      hist[labels[i]!] = h.filter((x) => x >= buckets[i]! && x < buckets[i + 1]!).length;
    }
    holding.combinedHeadline = {
      trades: h.length,
      minHours: h.length === 0 ? null : round(h[0]!, 1),
      medianHours: h.length === 0 ? null : round(h[Math.floor(h.length / 2)]!, 1),
      meanHours: h.length === 0 ? null : round(h.reduce((a, b) => a + b, 0) / h.length, 1),
      p90Hours: h.length === 0 ? null : round(h[Math.floor(h.length * 0.9)]!, 1),
      maxHours: h.length === 0 ? null : round(h[h.length - 1]!, 1),
      histogram: hist,
      note: "Holding time is what decides how much of a trade's cost is swap/financing. Swap is NOT modelled anywhere in this run — these figures exist only to size that omission.",
    };
  }

  /* ---- the spread cost, as ONE recomputable figure ------------------------ */
  const headlineAll = pooled(series.map((s) => perVariant.headline![s.cfg.instrument]!)).filter((t) => t.pips !== null);
  const zeroAll = pooled(series.map((s) => perVariant.zeroCost![s.cfg.instrument]!)).filter((t) => t.pips !== null);
  const headlineTotalPips = round(headlineAll.reduce((a, t) => a + t.pips!, 0), 1);
  const zeroTotalPips = round(zeroAll.reduce((a, t) => a + t.pips!, 0), 1);
  const variantDiffPips = round(zeroTotalPips - headlineTotalPips, 1);
  const crossingAll = headlineAll
    .map((t) => t.spreadCrossingCostPips)
    .filter((x): x is number => x !== null);
  const crossingTotalPips = round(crossingAll.reduce((a, b) => a + b, 0), 1);

  const spreadCost = {
    headlineTotalPips,
    zeroCostTotalPips: zeroTotalPips,
    trades: headlineAll.length,
    /**
     * THE figure: what the spread costs per trade in this model.
     * = achievable total − zero-cost total, over the same trades at the same timings.
     * Recomputable as a single subtraction of two stored totals.
     */
    perTradePips: round(variantDiffPips / headlineAll.length, 3),
    totalPips: variantDiffPips,
    definition:
      "the zero-cost variant's total pips minus the achievable variant's total pips, over the same trades with identical entry and exit timing, divided by the trade count — i.e. the same subtraction the reader can do on the two stored totals",
    crossingCost: {
      totalPips: crossingTotalPips,
      perTradePips: round(crossingTotalPips / headlineAll.length, 3),
      note:
        "the part of the figure above paid at the moment of the fills: the same fills priced at mid minus the bid/ask fills. A stop or target is a level and costs the same on either basis, so this is roughly half the total; the rest is the change in WHEN a bid-tested stop or target is first touched once the spread is removed from the price series.",
    },
    supersedes: [
      {
        figure: "8,530 pips / 2.25 pips per trade",
        what: "headline minus the zero-cost variant",
        why: "right definition, wrong input: the zero-cost variant was priced at bar CLOSES instead of the fills' bar OPENs, so it was 503.9 pips too high. Corrected to 8,026.1 / 2.118.",
      },
      {
        figure: "9,387 pips / 2.48 pips per trade",
        what: "the sum of the per-trade spreadCostPips field",
        why: "that field priced its 'mid' leg at the CLOSE of the fill and exit bars — different instants from the fills — and double-counted the timing shift. Replaced by spreadCrossingCostPips, which sums to 4,237.8 and is a decomposition of the 8,026.1, not the figure itself.",
      },
      {
        figure: "2.48 pips per trade in report §3",
        what: "the unweighted mean of the four per-pair means of that same broken field",
        why: "wrong field, and an unweighted average of per-pair averages is not the combined figure (943 trades on GBP/USD counted the same as 961 on EUR/USD). Replaced by the pooled 2.118, with the per-pair values 1.74 / 3.31 / 1.60 / 1.84.",
      },
    ],
  };

  /* ---- data resolution --------------------------------------------------- */
  const coverage = series.map(hourlyCoverage);
  const hourlyFromMs = Math.max(...coverage.map((c) => (c.hourlyFromUtc === null ? 0 : Date.parse(c.hourlyFromUtc))));
  const tradesBeforeHourly = headlineAll.filter((t) => Date.parse(t.fillBarUtc) < hourlyFromMs);
  const dataResolution = {
    hourlyFromUtc: hourlyFromMs === 0 ? null : iso(hourlyFromMs),
    measuredFrom: "the gap between consecutive bars in each pair's cached H1 file",
    rule: `a calendar year counts as hourly when at least ${String(HOURLY_YEAR_SHARE * 100)}% of its consecutive-bar gaps are 1 hour or less; hourlyFromUtc is the first bar of the first year after which every year meets that`,
    preludeNote:
      "The broker's H1 history is a DAILY series until January 2005. Trades filled before hourlyFromUtc were taken on daily bars inside an hourly backtest, and the EMA(200)/ATR(14) warm-up feeding the first genuine hourly trades is computed over that mixed-resolution prelude.",
    tradesFilledBeforeHourlyFrom: tradesBeforeHourly.length,
    tradesFilledBeforeHourlyFromPips: round(tradesBeforeHourly.reduce((a, t) => a + t.pips!, 0), 1),
    byYearOfFills: Object.fromEntries(
      [...new Set(tradesBeforeHourly.map((t) => t.fillBarUtc.slice(0, 4)))].sort().map((y) => [
        y,
        {
          trades: tradesBeforeHourly.filter((t) => t.fillBarUtc.slice(0, 4) === y).length,
          totalPips: round(tradesBeforeHourly.filter((t) => t.fillBarUtc.slice(0, 4) === y).reduce((a, t) => a + t.pips!, 0), 1),
        },
      ]),
    ),
    perPair: coverage,
  };

  // ---- reconciliation against the live engine ------------------------------
  let liveSignals: unknown = null;
  try {
    const res = await fetch("http://localhost:3000/api/signals");
    liveSignals = await res.json();
  } catch (e) {
    liveSignals = { error: String(e).slice(0, 200) };
  }
  const recon: Record<string, unknown> = {};
  const livePayload = liveSignals as
    | { pairs?: { pair?: string; label?: string; signal?: string; entry?: number; latestBarUtc?: string; ruleFired?: { barUtc?: string } }[] }
    | null;
  for (const s of series) {
    // Compare the live engine against the RULE EVENT STREAM, not against the trade
    // list: a trigger that fired on the very last cached bar has no next bar to fill
    // on, so it is a live signal with no completed trade yet — it must still be
    // checked here, or the comparison would report a false disagreement.
    const { events } = runRulesetEvents(s.bars);
    const opens = events.filter((e) => e.name.startsWith("opened"));
    const lastIdx = opens[opens.length - 1]?.index ?? null;
    const last = opens[opens.length - 1] ?? null;
    const live = livePayload?.pairs?.find?.((p) => p.label === s.cfg.label);
    const barUtc = lastIdx === null ? null : iso(s.tMs[lastIdx]!);
    const close = lastIdx === null ? null : s.bars[lastIdx]!.c;
    const side = last === null ? null : last.name === "opened-long" ? "long" : "short";
    // The comparison is only meaningful while the two windows coincide. The dashboard
    // reads live bars; this run reads a cache that ends at a fixed date. Once the live
    // window has moved past the cache, a mismatch says nothing about the rules and
    // everything about the two windows, so it is recorded rather than called a failure.
    const liveLatestMs = live?.latestBarUtc ? Date.parse(live.latestBarUtc) : null;
    const comparable = liveLatestMs !== null && Math.abs(liveLatestMs - lastBarMs) <= 48 * HOUR_MS;
    recon[s.cfg.label] = {
      backtestLastTriggerBarUtc: barUtc,
      backtestSide: side,
      backtestTriggerClose: close,
      liveSignal: live?.signal ?? null,
      liveEntry: live?.entry ?? null,
      liveTriggerBarUtc: live?.ruleFired?.barUtc ?? null,
      liveLatestBarUtc: live?.latestBarUtc ?? null,
      backtestCacheEndsUtc: iso(lastBarMs),
      windowsCoincide: comparable,
      triggerIsOnFinalCachedBar: lastIdx !== null && lastIdx === s.bars.length - 1,
      triggerIsOnFinalCachedBarNote:
        lastIdx !== null && lastIdx === s.bars.length - 1
          ? "fired on the newest bar in the cache, so there is no next bar to fill on: a live signal, no completed trade yet"
          : null,
      agrees: Boolean(
        live &&
          last &&
          live.signal?.toLowerCase() === side &&
          live.ruleFired?.barUtc === barUtc &&
          (live.entry === null || Math.abs((live.entry ?? 0) - (close ?? 0)) < 10 ** -(s.cfg.decimals - 1) / 100),
      ),
    };
  }

  const results = {
    generatedAt: new Date().toISOString(),
    rulesetVersion: RULESET_VERSION,
    engineCode: [
      "/home/team/shared/site/src/lib/market/ruleset.ts (runRulesetEvents)",
      "/home/team/shared/site/src/lib/market/indicators.ts (ema, atr)",
    ],
    /**
     * Which figures in this file have been reproduced by a second, independently
     * written implementation. Written here, next to the numbers, so a page cannot
     * claim more than the record supports.
     */
    verification: {
      auditedAt: "2026-11-02",
      auditor: "independent replay written from the written specification, not from this code",
      artifact: "/home/team/shared/verify/audit-findings.md",
      headline: {
        independentlyReproduced: true,
        note:
          "3,789 of 3,789 trades matched on trigger bar, side, entry price, exit price, exit reason, pips, R, risk and holding time; every published headline aggregate, per pair, per year and the held-out 12 months reproduce. The one trade not matched is the still-open USD/JPY one, excluded from both.",
      },
      zeroCost: {
        independentlyReproduced: false,
        note:
          "NOT reproduced. The audit's faithful reading of the same convention gave +3,785.1 pips; the figure stored by the previous run was +4,289.1 because the mid leg was priced at bar CLOSES instead of the fills' bar OPENs. That defect is fixed here and this file now stores +3,785.x, which agrees with the audit to rounding. It has NOT been re-audited since the fix.",
      },
      optimistic: {
        independentlyReproduced: false,
        note:
          "Reproduced exactly by the audit once its convention was identified, which is a look-ahead on BOTH legs (entry at the trigger bar's close, rule exit at the cross bar's close). Not re-checked since this run.",
      },
    },
    dataWindow,
    dataResolution,
    measurementPeriod: {
      headlineStartUtc: iso(Math.min(...series.map((s) => s.tMs[FIRST_EVALUATED_INDEX] ?? s.tMs[0]!))),
      headlineEndUtc: iso(lastBarMs),
      heldOutLast12MonthsFromUtc: iso(heldOutCutMs),
      firstEvaluatedIndex: FIRST_EVALUATED_INDEX,
      firstTradeUtc: headlineAll.length === 0 ? null : pooled([headlineAll])[0]!.triggerBarUtc,
      note: `The ruleset cannot produce a first event before bar index ${String(FIRST_EVALUATED_INDEX)} (EMA(200) plus a previous bar), so the measurement period starts at the first bar it is evaluated on, not at the first bar in the cache.`,
    },
    assumptions: {
      fillHeadline: "entry at the NEXT bar's open, ASK for a long / BID for a short; exits at the opposite side. No look-ahead.",
      fillZeroCost:
        "identical timing to the headline at MID prices on both sides: entry at the mid OPEN of the bar after the trigger, a rule exit at the mid OPEN of the bar after the cross, and the same stop/target level (a level is basis-independent). No look-ahead. This is the same-bar-instant mid counterpart of the headline, and nothing else differs.",
      fillOptimistic:
        "BOTH legs are look-aheads: the entry is the trigger bar's mid CLOSE, and a rule exit is the cross bar's own mid CLOSE. Each leg is priced at the close of the bar that produced its signal — a price only knowable once that bar has ended. Labelled OPTIMISTIC UPPER BOUND, not achievable.",
      intraBarAmbiguity: "if a bar touches both stop and target, the STOP is counted first.",
      gaps: "a bar opening beyond the stop fills at that bar's open (worse than the stop); a bar opening beyond the target fills at that bar's open (better than the target).",
      ruleExit: "an exit the rules trigger at a bar's close is filled at the NEXT bar's open, same no-look-ahead rule as entries.",
      stopsAndTargets: "stop = 1.5 x ATR(14) and target = 3.0 x ATR(14), both measured from the trigger bar's mid close, identical to the live engine. Stop/target are treated as exit triggers alongside the rule's own exit (cross against, or trend-filter flip).",
      onePositionPerPair: true,
      pyramiding: false,
      optimisation: "NONE. No parameter search, no sweep, no timeframe search. One ruleset, as documented.",
      r: "1R = the trade's initial stop distance (1.5 x ATR(14) at the trigger bar, in pips).",
    },
    exclusions: [
      "swap / financing / carry charges — NOT modelled",
      "slippage beyond the quoted bid/ask spread — NOT modelled",
      "commission, fees and taxes — NOT modelled",
      "position sizing and account equity — NOT modelled; every result is in pips and R",
      "weekend/holiday gaps are left as gaps; no bar is interpolated or filled in",
    ],
    reconciliationWithLive: recon,
    reconciliationWithLiveNote:
      "This comparison is made at run time, between the engine replayed over the frozen cache and whatever the dashboard was serving when this run happened. It only means something while the two windows coincide; `windowsCoincide` records that, and a disagreement when they do not coincide is a fact about the two windows, not about the rules.",
    spreadCost,
    spreadsPaid: spreads,
    holdingTimes: holding,
    results: {
      headline_nextBarOpen_bidAsk: { fullPeriod: summaryFor("headline", inFull), last12MonthsHeldOut: summaryFor("headline", inHoldout) },
      zeroCost_mid_nextBarOpen: {
        convention: "mid OPEN on both sides, same bar instants as the headline; spread removed, timing held",
        fullPeriod: summaryFor("zeroCost", inFull),
        last12MonthsHeldOut: summaryFor("zeroCost", inHoldout),
      },
      optimisticUpperBound_triggerClose: {
        label:
          "OPTIMISTIC UPPER BOUND — BOTH the entry and the rule exit fill at the close of the bar that produced the signal, prices only knowable once those bars had ended. NOT achievable in practice.",
        convention: "entry at the trigger bar's mid CLOSE, rule exit at the cross bar's mid CLOSE",
        fullPeriod: summaryFor("triggerClose", inFull),
        last12MonthsHeldOut: summaryFor("triggerClose", inHoldout),
      },
    },
    yearByYear: {
      headline: {
        perPair: Object.fromEntries(series.map((s) => [s.cfg.label, yearByYear(perVariant.headline![s.cfg.instrument]!)])),
        combined: yearByYear(pooled(series.map((s) => perVariant.headline![s.cfg.instrument]!))),
      },
    },
    tradesHeadline: perVariant.headline,
    liveSignalsRaw: liveSignals,
  };

  await Bun.write(`${OUT}/results.json`, JSON.stringify(results, null, 2) + "\n");

  // A short console summary so the run is readable without opening the JSON.
  const lines: string[] = [];
  lines.push(`generated ${results.generatedAt}  ruleset ${RULESET_VERSION}`);
  for (const [k, m] of Object.entries(dataWindow)) {
    const mm = m as Record<string, unknown>;
    lines.push(`${k}: ${mm.bars} bars  ${mm.firstBarUtc} .. ${mm.lastBarUtc}  incomplete refused ${mm.incompleteCandlesRefused}`);
  }
  lines.push(`hourly from ${String(dataResolution.hourlyFromUtc)}; trades filled on daily bars before that: ${String(dataResolution.tradesFilledBeforeHourlyFrom)} (${String(dataResolution.tradesFilledBeforeHourlyFromPips)} pips)`);
  for (const v of ["headline_nextBarOpen_bidAsk", "zeroCost_mid_nextBarOpen", "optimisticUpperBound_triggerClose"] as const) {
    lines.push(`--- ${v} ---`);
    const r = (results.results as Record<string, { fullPeriod: { perPair: Record<string, { trades: number; expectancyPipsPerTrade: number | null; totalPips: number; totalR: number; winRatePct: number | null }>; combined: Record<string, unknown> } }>)[v]!;
    for (const [p, st] of Object.entries(r.fullPeriod.perPair)) {
      lines.push(`  ${p}: n=${st.trades} win%=${st.winRatePct} exp=${st.expectancyPipsPerTrade} pips=${st.totalPips} R=${st.totalR}`);
    }
    const c = r.fullPeriod.combined as Record<string, unknown>;
    lines.push(`  COMBINED: n=${c.trades} win%=${c.winRatePct} exp=${c.expectancyPipsPerTrade} pips=${c.totalPips} R=${c.totalR} PF=${c.profitFactor} maxDDpips=${c.maxDrawdownPips} maxDDR=${c.maxDrawdownR}`);
  }
  lines.push("--- spread cost ---");
  lines.push(`  headline ${String(spreadCost.headlineTotalPips)}  zeroCost ${String(spreadCost.zeroCostTotalPips)}  difference ${String(spreadCost.totalPips)} pips over ${String(spreadCost.trades)} trades = ${String(spreadCost.perTradePips)} pips/trade`);
  lines.push(`  of which crossing cost on the fills: ${String(spreadCost.crossingCost.totalPips)} pips = ${String(spreadCost.crossingCost.perTradePips)} pips/trade`);
  for (const [p, v] of Object.entries(spreads)) {
    const vv = v as Record<string, unknown>;
    lines.push(`  ${p}: mean round-trip spread cost ${String(vv.meanRoundTripSpreadCostPips)} pips/trade (crossing ${String(vv.meanSpreadCrossingCostPips)})`);
  }
  lines.push("--- reconciliation ---");
  for (const [p, r] of Object.entries(recon)) lines.push(`  ${p}: ${JSON.stringify(r)}`);
  await Bun.write(`${OUT}/run-summary.txt`, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

await main();
