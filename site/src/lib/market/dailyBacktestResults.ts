/**
 * /backtest/daily — the same ruleset measured on daily bars, read straight from
 * the daily run's own machine-readable output.
 *
 * The only source is the file the daily backtest wrote. This module does no
 * arithmetic on outcomes: it reads the file and hands it to the page. The
 * handful of figures the page must have but the file does not store as a field
 * — the 95% interval on per-trade R, the share of trades held a week or longer,
 * and the hourly side of the cost comparison — are computed here from stored
 * per-trade rows or from the hourly results file, and are labelled on the page
 * as computed. Nothing on the page is typed in by hand.
 *
 * Where the bytes come from is decided by resolveData() in bundledData.ts, in one
 * documented order: env override → the shared path on the owner's machine → the
 * snapshot bundled into this build → nothing.
 *
 * If none of them can be read the payload is `null` and the page says so. A
 * missing file never becomes a remembered or plausible-looking number.
 */

import { loadBacktestResults } from "./backtestResults";
import { resolveData, type Provenance, type SkippedCandidate } from "./bundledData";

/** The env override honoured for this file (see bundledData.ts). */
export const DAILY_BACKTEST_RESULTS_ENV = "DAILY_BACKTEST_RESULTS_PATH";

export type DailyStats = {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPips: number;
  avgLossPips: number | null;
  expectancyPipsPerTrade: number;
  totalPips: number;
  avgRPerTrade: number;
  totalR: number;
  maxDrawdownPips: number;
  maxDrawdownR: number;
  profitFactor: number | null;
  longestLosingStreak: number;
  medianHoldingDays: number;
  meanHoldingDays: number;
  p90HoldingDays: number;
  maxHoldingDays: number;
  medianHoldingHours: number;
  meanRiskPips: number;
  meanHoldingBars: number;
  exitReasons: Record<string, number>;
  tradesStillOpenAtDataEnd: number;
  statisticallyMeaningful: boolean;
};

export type DailyVariant = {
  label?: string;
  fullPeriod: { perPair: Record<string, DailyStats>; combined: DailyStats };
  last12MonthsHeldOut: { perPair: Record<string, DailyStats>; combined: DailyStats };
};

export type DailyYearRow = {
  year: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPips: number;
  totalR: number;
};

export type DailyDataWindow = {
  label: string;
  firstBarUtc: string;
  lastBarUtc: string;
  bars: number;
  incompleteCandlesRefused: number;
  pagesRequested: number;
  brokerOldestServedUtc: string;
  weekdaysInsideSpan: number;
  missingWeekdaysInsideSpan: number;
  barSpacingHistogram: Record<string, number>;
  barOpenHourUtcHistogram: Record<string, number>;
  gapRule: string;
  spreadTimingNote: string;
};

export type DailySpreadRow = {
  allBarsMeanSpreadPips: number;
  allBarsMedianSpreadPips: number;
  meanSpreadAtEntryFillPips: number;
  medianSpreadAtEntryFillPips: number;
};

export type DailyHolding = {
  trades: number;
  minDays: number;
  medianDays: number;
  meanDays: number;
  p90Days: number;
  maxDays: number;
  histogram: Record<string, number>;
  note: string;
};

export type DailyDecomposition = {
  perTradePips: { grossEdge: number; spreadPaid: number; net: number };
  totals: { grossPips: number; spreadPaidPips: number; netPips: number };
  meanSpreadAtEntryFillPips: number;
  inR: {
    meanRiskPips: number;
    grossEdgeR: number;
    spreadPaidR: number;
    netR: number;
    spreadPaidAsPctOfRisk: number;
    note: string;
  };
  costAsMultipleOfGrossEdge: number | null;
  howComputed: string;
  crossCheck: { meanSpreadAtEntryFillPips: number; note: string };
};

export type DailyLastTrigger = {
  triggerBarUtc: string;
  side: string;
  triggerClose: number;
  triggerIsOnFinalCachedBar: boolean;
};

export type DailyPayload = {
  generatedAt: string;
  rulesetVersion: string;
  granularity: string;
  engineCode: string[];
  differencesFromH1Run: string[];
  dataWindow: Record<string, DailyDataWindow>;
  measurementPeriod: {
    headlineStartUtc: string;
    headlineEndUtc: string;
    heldOutLast12MonthsFromUtc: string;
    note: string;
  };
  assumptions: Record<string, string | boolean>;
  exclusions: string[];
  reconciliationWithLive: {
    applicable: boolean;
    why: string;
    lastDailyTriggerPerPair: Record<string, DailyLastTrigger>;
  };
  spreadsPaid: Record<string, DailySpreadRow>;
  holdingTimes: { combinedHeadline: DailyHolding };
  costEdgeDecomposition: DailyDecomposition;
  results: {
    headline_nextBarOpen_bidAsk: DailyVariant;
    zeroCost_mid_nextBarOpen: DailyVariant;
    optimisticUpperBound_triggerClose: DailyVariant;
  };
  yearByYear: {
    headline: {
      perPair: Record<string, DailyYearRow[]>;
      combined: DailyYearRow[];
      positiveYears: number;
      measuredYears: number;
      note: string;
    };
  };
  comparisonH1: {
    source: string;
    granularityH1: {
      headline: { trades: number; avgRPerTrade?: number; [k: string]: number | undefined };
      zeroCost: { trades: number; avgRPerTrade?: number; [k: string]: number | undefined };
      [k: string]: unknown;
    };
  };
};

/**
 * Figures the page needs that the daily file stores only as raw rows or in the
 * hourly file. Every one of them is arithmetic on stored numbers, kept in one
 * place so the page cannot invent one.
 */
export type DailyDerived = {
  /** From the stored per-trade R of the headline variant (`tradesHeadline[*].r`). */
  perTradeR: {
    n: number;
    mean: number;
    sd: number;
    se: number;
    ciLow: number;
    ciHigh: number;
    t: number;
  } | null;
  /** Held a week or longer, counted from the stored per-trade holding days. */
  heldAtLeastAWeek: { count: number; pct: number } | null;
  /**
   * The hourly side of the cost comparison, read from the hourly results file:
   * gross edge per trade in R (the zero-cost variant) and the spread paid per
   * trade in R (zero-cost minus achievable). `null` if that file is unreadable —
   * in which case the page shows no hourly-side figure rather than a guess.
   */
  hourly: {
    grossEdgeR: number;
    spreadPaidR: number;
    zeroCostTotalPips: number;
    trades: number;
  } | null;
};

export type DailyLoad =
  | { ok: true; payload: DailyPayload; derived: DailyDerived; provenance: Provenance }
  | { ok: false; error: string; skipped: SkippedCandidate[] };

/** Two-sided 95% normal quantile. n is large enough (208) that this is exact. */
const Z95 = 1.96;

type TradeRow = { r?: number; holdingDays?: number };

function derive(trades: Record<string, TradeRow[]> | undefined): {
  perTradeR: DailyDerived["perTradeR"];
  heldAtLeastAWeek: DailyDerived["heldAtLeastAWeek"];
} {
  const rows = trades ? Object.values(trades).flat() : [];
  const rs = rows.map((r) => r.r).filter((v): v is number => typeof v === "number");
  const days = rows.map((r) => r.holdingDays).filter((v): v is number => typeof v === "number");

  let perTradeR: DailyDerived["perTradeR"] = null;
  if (rs.length >= 2) {
    const n = rs.length;
    const mean = rs.reduce((s, v) => s + v, 0) / n;
    const variance = rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const se = sd / Math.sqrt(n);
    perTradeR = {
      n,
      mean,
      sd,
      se,
      ciLow: mean - Z95 * se,
      ciHigh: mean + Z95 * se,
      t: se === 0 ? 0 : mean / se,
    };
  }

  const heldAtLeastAWeek =
    days.length > 0
      ? {
          count: days.filter((d) => d >= 7).length,
          pct: (100 * days.filter((d) => d >= 7).length) / days.length,
        }
      : null;

  return { perTradeR, heldAtLeastAWeek };
}

export async function loadDailyBacktestResults(): Promise<DailyLoad> {
  const resolved = await resolveData("daily-backtest");
  if (!resolved.ok) {
    return {
      ok: false,
      skipped: resolved.skipped,
      error: `The daily backtest results file could not be read (${resolved.error}). Nothing on this page is available — no figure is shown from memory or from an earlier run.`,
    };
  }
  const raw = resolved.text;
  const skipped = resolved.provenance.skipped;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      skipped,
      error:
        "The daily backtest results file is present but could not be parsed. Nothing on this page is available rather than showing a partial reading.",
    };
  }

  // Derived figures come from the bulk per-trade rows, which are then stripped so
  // the whole array never travels to the browser.
  const derived = derive(parsed.tradesHeadline as Record<string, TradeRow[]> | undefined);
  const { tradesHeadline: _trades, ...rest } = parsed;
  void _trades;

  let hourly: DailyDerived["hourly"] = null;
  const hourlyLoad = await loadBacktestResults();
  if (hourlyLoad.ok) {
    const h = hourlyLoad.payload.results.headline_nextBarOpen_bidAsk.fullPeriod.combined;
    const z = hourlyLoad.payload.results.zeroCost_mid_nextBarOpen.fullPeriod.combined;
    if (typeof h.avgRPerTrade === "number" && typeof z.avgRPerTrade === "number") {
      hourly = {
        grossEdgeR: z.avgRPerTrade,
        spreadPaidR: z.avgRPerTrade - h.avgRPerTrade,
        zeroCostTotalPips: z.totalPips,
        trades: h.trades,
      };
    }
  }

  return {
    ok: true,
    payload: rest as unknown as DailyPayload,
    provenance: resolved.provenance,
    derived: {
      perTradeR: derived.perTradeR,
      heldAtLeastAWeek: derived.heldAtLeastAWeek,
      hourly,
    },
  };
}
