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
      : (side === "long" ? (exitPrice! - fillPrice) : (fillPrice - exitPrice!)) / cfg.pip;
    // Cost actually paid relative to a mid-to-mid round trip, in pips.
    let spreadCostPips: number | null = null;
    if (!openTrade) {
      const midEntry = mid ? fillPrice : closes[fillIdx]!;
      const midExit = mid ? exitPrice! : closes[exitIdx!]!;
      const midGross = (side === "long" ? midExit - midEntry : midEntry - midExit) / cfg.pip;
      spreadCostPips = midGross - grossPips!;
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
    spreads[s.cfg.label] = {
      allBarsMeanSpreadPips: round(mean(all), 3),
      allBarsMedianSpreadPips: round(all[Math.floor(all.length / 2)]!, 3),
      meanSpreadAtEntryFillPips: onFills.length === 0 ? null : round(mean(onFills), 3),
      medianSpreadAtEntryFillPips: onFills.length === 0 ? null : round(onFills[Math.floor(onFills.length / 2)]!, 3),
      meanRoundTripSpreadCostPips: (() => {
        const c = perVariant.headline![s.cfg.instrument]!.map((t) => t.spreadCostPips).filter((x): x is number => x !== null);
        return c.length === 0 ? null : round(mean(c), 3);
      })(),
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

  // ---- reconciliation against the live engine ------------------------------
  let liveSignals: unknown = null;
  try {
    const res = await fetch("http://localhost:3000/api/signals");
    liveSignals = await res.json();
  } catch (e) {
    liveSignals = { error: String(e).slice(0, 200) };
  }
  const recon: Record<string, unknown> = {};
  for (const s of series) {
    // Compare the live engine against the RULE EVENT STREAM, not against the trade
    // list: a trigger that fired on the very last cached bar has no next bar to fill
    // on, so it is a live signal with no completed trade yet — it must still be
    // checked here, or the comparison would report a false disagreement.
    const { events } = runRulesetEvents(s.bars);
    const opens = events.filter((e) => e.name.startsWith("opened"));
    const lastIdx = opens[opens.length - 1]?.index ?? null;
    const last = opens[opens.length - 1] ?? null;
    const live = (liveSignals as { pairs?: { pair?: string; label?: string; signal?: string; entry?: number; ruleFired?: { barUtc?: string } }[] } | null)?.pairs?.find?.(
      (p) => p.label === s.cfg.label,
    );
    const barUtc = lastIdx === null ? null : iso(s.tMs[lastIdx]!);
    const close = lastIdx === null ? null : s.bars[lastIdx]!.c;
    const side = last === null ? null : last.name === "opened-long" ? "long" : "short";
    recon[s.cfg.label] = {
      backtestLastTriggerBarUtc: barUtc,
      backtestSide: side,
      backtestTriggerClose: close,
      liveSignal: live?.signal ?? null,
      liveEntry: live?.entry ?? null,
      liveTriggerBarUtc: live?.ruleFired?.barUtc ?? null,
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
    dataWindow,
    measurementPeriod: {
      headlineStartUtc: new Date(Math.min(...series.map((s) => s.tMs[220] ?? s.tMs[0]!))).toISOString(),
      headlineEndUtc: iso(lastBarMs),
      heldOutLast12MonthsFromUtc: iso(heldOutCutMs),
      note: "The ruleset cannot produce a first event before bar index 200 (EMA(200)); the measurement period is therefore the full cached span minus that warm-up.",
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
    spreadsPaid: spreads,
    holdingTimes: holding,
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
  for (const v of ["headline_nextBarOpen_bidAsk", "zeroCost_mid_nextBarOpen", "optimisticUpperBound_triggerClose"] as const) {
    lines.push(`--- ${v} ---`);
    const r = (results.results as Record<string, { fullPeriod: { perPair: Record<string, { trades: number; expectancyPipsPerTrade: number | null; totalPips: number; totalR: number; winRatePct: number | null }>; combined: Record<string, unknown> } }>)[v]!;
    for (const [p, st] of Object.entries(r.fullPeriod.perPair)) {
      lines.push(`  ${p}: n=${st.trades} win%=${st.winRatePct} exp=${st.expectancyPipsPerTrade} pips=${st.totalPips} R=${st.totalR}`);
    }
    const c = r.fullPeriod.combined as Record<string, unknown>;
    lines.push(`  COMBINED: n=${c.trades} win%=${c.winRatePct} exp=${c.expectancyPipsPerTrade} pips=${c.totalPips} R=${c.totalR} PF=${c.profitFactor} maxDDpips=${c.maxDrawdownPips} maxDDR=${c.maxDrawdownR}`);
  }
  lines.push("--- reconciliation ---");
  for (const [p, r] of Object.entries(recon)) lines.push(`  ${p}: ${JSON.stringify(r)}`);
  await Bun.write(`${OUT}/run-summary.txt`, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

await main();
