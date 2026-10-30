import { atr, ema, fmt, lastDefined } from "./indicators";
import type {
  Bar,
  PairSignalOk,
  PairSpec,
  RuleEvent,
  RuleEventName,
  SignalState,
  TrendFilter,
} from "./types";

/**
 * The one ruleset, implemented exactly as written in /home/team/shared/ruleset.md.
 * Pure: takes closed bars, returns the current state. No I/O, nothing invented.
 *
 * Rule labels live here once, in RULE_TEXT, so the page and the JSON endpoint
 * cannot drift from the logic.
 */

export const RULESET_VERSION = "v1";

export const RULE_TEXT: Record<RuleEventName, string> = {
  "opened-long":
    "EMA(20) crossed above EMA(50) while EMA(50) was above EMA(200) — long opened on the trigger bar's close",
  "opened-short":
    "EMA(20) crossed below EMA(50) while EMA(50) was below EMA(200) — short opened on the trigger bar's close",
  "cross-against-trend-ignored":
    "EMA(20)/EMA(50) crossed against the trend filter — no entry taken, state unchanged",
  "closed-long-on-cross":
    "EMA(20) crossed below EMA(50) — long closed, now flat",
  "closed-short-on-cross":
    "EMA(20) crossed above EMA(50) — short closed, now flat",
  "closed-long-on-trend-flick":
    "Trend filter turned down (EMA(50) crossed below EMA(200)) — long closed, now flat",
  "closed-short-on-trend-flick":
    "Trend filter turned up (EMA(50) crossed above EMA(200)) — short closed, now flat",
  "no-event":
    "No rule event since the calculation window began — nothing to open",
};

export const RULESET_SUMMARY = {
  version: RULESET_VERSION,
  file: "/home/team/shared/ruleset.md",
  summary:
    "Trend filter EMA(50)/EMA(200); entry on an EMA(20)/EMA(50) cross in the direction of the trend; stop and target sized from ATR(14); exit to flat on a cross against the position or a trend-filter flip.",
  trendFilter:
    "EMA(50) above EMA(200) = uptrend; EMA(50) below EMA(200) = downtrend; exactly equal = no trend.",
  entryTrigger:
    "EMA(20) crossing EMA(50) in the direction of the trend filter. A cross against the trend filter is ignored.",
  entryLevel:
    "The close of the bar the trigger fired on. A reference level on that bar's close — not a filled order and not a bid/ask quote.",
  stop: "1.5 x ATR(14) from the entry, on the losing side (below entry for a long, above for a short).",
  target: "3.0 x ATR(14) from the entry, on the winning side. 1:2 risk:reward by construction.",
  exit: "Flat on an EMA(20)/EMA(50) cross against the position, or on the trend filter flipping against it.",
  candles: "Closed hourly bars only. Unfinished bars and bars with missing prices are discarded, never filled in.",
} as const;

/**
 * One engine event, carrying the index of the bar it fired on.
 * Exported so an offline replay (the backtest) can consume the exact same event
 * stream the dashboard's rules walk produces — one implementation, no drift.
 */
export type Event = { name: RuleEventName; index: number };

type EngineResult = {
  state: SignalState;
  /** The bar index the current state was set on (-1 when no event ever fired). */
  stateIndex: number;
  lastEvent: Event;
  trend: TrendFilter;
  crossingAtLastBar: "up" | "down" | null;
};

/** Upward cross of `fast` over `slow` at index i (defined only when both are defined at i-1 and i). */
function crossedUp(fast: (number | null)[], slow: (number | null)[], i: number): boolean {
  const f0 = fast[i - 1];
  const s0 = slow[i - 1];
  const f1 = fast[i];
  const s1 = slow[i];
  if (f0 == null || s0 == null || f1 == null || s1 == null) return false;
  return f0 <= s0 && f1 > s1;
}

/** Downward cross of `fast` under `slow` at index i. */
function crossedDown(fast: (number | null)[], slow: (number | null)[], i: number): boolean {
  const f0 = fast[i - 1];
  const s0 = slow[i - 1];
  const f1 = fast[i];
  const s1 = slow[i];
  if (f0 == null || s0 == null || f1 == null || s1 == null) return false;
  return f0 >= s0 && f1 < s1;
}

/**
 * Walk the closed bars once, bar by bar, applying the rules in order. The scan
 * starts at the first index where EMA(200), EMA(50), EMA(20) and ATR(14) are all
 * defined and a previous bar exists (index 200).
 */
export function runRulesetEvents(bars: Bar[]): {
  events: Event[];
  state: SignalState;
  stateIndex: number;
  trend: TrendFilter;
  crossingAtLastBar: "up" | "down" | null;
} {
  const closes = bars.map((b) => b.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const events: Event[] = [];
  let state: SignalState = "FLAT";
  let stateIndex = -1;
  let trend: TrendFilter = "none";
  let crossingAtLastBar: "up" | "down" | null = null;

  const start = Math.max(200, 1);
  for (let i = start; i < bars.length; i++) {
    const f50 = ema50[i];
    const s200 = ema200[i];
    if (f50 == null || s200 == null) continue;

    const trendNow: TrendFilter = f50 > s200 ? "up" : f50 < s200 ? "down" : "none";
    const prevTrend = trend;
    trend = trendNow;

    const up = crossedUp(ema20, ema50, i);
    const down = crossedDown(ema20, ema50, i);
    if (i === bars.length - 1) crossingAtLastBar = up ? "up" : down ? "down" : null;

    // 1) exits first: an open position is closed by a cross against it or by the
    //    trend filter flipping against it.
    if (state === "LONG") {
      if (down) {
        state = "FLAT";
        stateIndex = i;
        events.push({ name: "closed-long-on-cross", index: i });
      } else if (prevTrend === "up" && trendNow === "down") {
        state = "FLAT";
        stateIndex = i;
        events.push({ name: "closed-long-on-trend-flick", index: i });
      }
      continue;
    }
    if (state === "SHORT") {
      if (up) {
        state = "FLAT";
        stateIndex = i;
        events.push({ name: "closed-short-on-cross", index: i });
      } else if (prevTrend === "down" && trendNow === "up") {
        state = "FLAT";
        stateIndex = i;
        events.push({ name: "closed-short-on-trend-flick", index: i });
      }
      continue;
    }

    // 2) flat: an in-trend cross opens a position.
    if (up && trendNow === "up") {
      state = "LONG";
      stateIndex = i;
      events.push({ name: "opened-long", index: i });
    } else if (down && trendNow === "down") {
      state = "SHORT";
      stateIndex = i;
      events.push({ name: "opened-short", index: i });
    } else if (up || down) {
      // A cross against the trend filter, or with no trend at all. Recorded so the
      // page can say honestly what the latest rule event was.
      events.push({ name: "cross-against-trend-ignored", index: i });
    }
  }

  return { events, state, stateIndex, trend, crossingAtLastBar };
}

/**
 * The current-state view of the rules: the last event that fired, and the state it
 * left behind. A thin view onto `runRulesetEvents` — there is exactly one
 * implementation of the rules, so the dashboard and an offline replay cannot drift.
 */
export function runRuleset(bars: Bar[]): EngineResult {
  const r = runRulesetEvents(bars);
  const lastEvent: Event =
    r.events.length > 0 ? r.events[r.events.length - 1]! : { name: "no-event", index: -1 };
  return {
    state: r.state,
    stateIndex: r.stateIndex,
    lastEvent,
    trend: r.trend,
    crossingAtLastBar: r.crossingAtLastBar,
  };
}

function isoFromSeconds(t: number): string {
  return new Date(t * 1000).toISOString();
}

/**
 * Build the per-pair signal view: the engine's state, the reference levels, the
 * rule that fired, and one plain-English sentence describing what it reads now.
 */
export function buildPairSignal(
  spec: PairSpec,
  bars: Bar[],
  meta: {
    source: string;
    upstreamUrl: string;
    fetchedAt: string;
    granularityNote: string;
  },
): PairSignalOk {
  const closes = bars.map((b) => b.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atr14 = atr(bars, 14);

  const engine = runRuleset(bars);
  const last = bars[bars.length - 1]!;
  const lastIdx = bars.length - 1;
  const currentAtr = atr14[lastIdx] ?? null;
  const currentEma20 = ema20[lastIdx] ?? null;
  const currentEma50 = ema50[lastIdx] ?? null;
  const currentEma200 = ema200[lastIdx] ?? null;

  const eventIndex = engine.lastEvent.index;
  const eventBar = eventIndex >= 0 ? bars[eventIndex]! : last;
  const ruleFired: RuleEvent = {
    name: engine.lastEvent.name,
    text: RULE_TEXT[engine.lastEvent.name],
    barUtc: isoFromSeconds(eventBar.t),
    barClose: eventBar.c,
  };

  const open = engine.state !== "FLAT" && engine.stateIndex >= 0;
  const entryPrice = open ? bars[engine.stateIndex]!.c : null;
  const entryAtr = open ? (atr14[engine.stateIndex] ?? null) : null;
  const sized = open && entryPrice !== null && entryAtr !== null;
  const stop = sized
    ? engine.state === "LONG"
      ? entryPrice! - 1.5 * entryAtr!
      : entryPrice! + 1.5 * entryAtr!
    : null;
  const target = sized
    ? engine.state === "LONG"
      ? entryPrice! + 3.0 * entryAtr!
      : entryPrice! - 3.0 * entryAtr!
    : null;

  const reading = describe({
    state: engine.state,
    trend: engine.trend,
    ema20: currentEma20,
    ema50: currentEma50,
    ema200: currentEma200,
    crossingAtLastBar: engine.crossingAtLastBar,
    lastEventName: engine.lastEvent.name,
    decimals: spec.decimals,
  });

  return {
    status: "ok",
    pair: spec.id,
    label: spec.label,
    symbol: spec.symbol,
    decimals: spec.decimals,
    signal: engine.state,
    entry: entryPrice,
    stop,
    target,
    display: {
      signal: engine.state,
      entry: fmt(entryPrice, spec.decimals),
      stop: fmt(stop, spec.decimals),
      target: fmt(target, spec.decimals),
      atr: fmt(currentAtr, spec.decimals),
      lastClose: fmt(last.c, spec.decimals) ?? String(last.c),
    },
    atr14: currentAtr,
    indicators: {
      ema20: currentEma20,
      ema50: currentEma50,
      ema200: currentEma200,
      trend: engine.trend,
    },
    ruleFired,
    reading,
    latestBarUtc: isoFromSeconds(last.t),
    latestClose: last.c,
    barsUsed: bars.length,
    firstBarUtc: isoFromSeconds(bars[0]!.t),
    granularity: "hourly bar",
    granularityNote: meta.granularityNote,
    source: meta.source,
    upstreamUrl: meta.upstreamUrl,
    fetchedAt: meta.fetchedAt,
  };
}

function describe(a: {
  state: SignalState;
  trend: TrendFilter;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  crossingAtLastBar: "up" | "down" | null;
  lastEventName: RuleEventName;
  decimals: number;
}): string {
  const trendText =
    a.trend === "up"
      ? `trend filter reads up (EMA50 ${
          a.ema50 === null ? "?" : a.ema50.toFixed(a.decimals)
        } above EMA200 ${a.ema200 === null ? "?" : a.ema200.toFixed(a.decimals)})`
      : a.trend === "down"
        ? `trend filter reads down (EMA50 ${
            a.ema50 === null ? "?" : a.ema50.toFixed(a.decimals)
          } below EMA200 ${a.ema200 === null ? "?" : a.ema200.toFixed(a.decimals)})`
        : "trend filter is neutral (EMA50 equals EMA200)";
  const crossText =
    a.crossingAtLastBar === "up"
      ? " the newest closed bar carried an upward EMA20/EMA50 cross"
      : a.crossingAtLastBar === "down"
        ? " the newest closed bar carried a downward EMA20/EMA50 cross"
        : " the newest closed bar carried no EMA20/EMA50 cross";
  const stateText =
    a.state === "LONG"
      ? "State: long from the rule event below."
      : a.state === "SHORT"
        ? "State: short from the rule event below."
        : a.lastEventName === "no-event"
          ? "State: flat — no rule event has fired in the bars this version looks at."
          : "State: flat — an open position was closed by the rule event below.";
  return `${trendText};${crossText}. ${stateText}`;
}
