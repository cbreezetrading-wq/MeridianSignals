/**
 * /backtest — the measured result of the ruleset, read straight from the
 * backtest run's own machine-readable output.
 *
 * The only source is the file the backtest wrote. This module does no
 * arithmetic on outcomes: it reads, strips the two bulk keys (the 3,789-trade
 * array and the raw live payload), and hands the rest to the page. Every figure
 * the page prints therefore comes from results.json, and the page can be
 * checked against that file line by line.
 *
 * Where the bytes come from is decided by resolveData() in bundledData.ts, in one
 * documented order: env override → the shared path on the owner's machine → the
 * snapshot bundled into this build → nothing. Every figure below is read from
 * whichever of those supplied the file, unchanged.
 *
 * If none of them can be read the payload is `null` and the page says so. A
 * missing file never becomes a remembered or plausible-looking number.
 */
import { resolveData, type Provenance, type SkippedCandidate } from "./bundledData";

/** The env override honoured for this file (see bundledData.ts). */
export const BACKTEST_RESULTS_ENV = "BACKTEST_RESULTS_PATH";

export type VariantStats = {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPips: number;
  avgLossPips: number;
  expectancyPipsPerTrade: number;
  totalPips: number;
  avgRPerTrade: number;
  totalR: number;
  maxDrawdownPips: number;
  maxDrawdownR: number;
  profitFactor: number;
  longestLosingStreak: number;
  medianHoldingHours: number;
  meanHoldingHours: number;
  exitReasons: Record<string, number>;
  tradesStillOpenAtDataEnd: number;
  statisticallyMeaningful: boolean;
};

export type Variant = {
  label?: string;
  fullPeriod: { perPair: Record<string, VariantStats>; combined: VariantStats };
  last12MonthsHeldOut: { perPair: Record<string, VariantStats>; combined: VariantStats };
};

export type YearRow = {
  year: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPips: number;
  totalR: number;
};

export type SpreadRow = {
  allBarsMeanSpreadPips: number;
  allBarsMedianSpreadPips: number;
  meanSpreadAtEntryFillPips: number;
  medianSpreadAtEntryFillPips: number;
  meanRoundTripSpreadCostPips: number;
};

export type ReconciliationRow = {
  backtestLastTriggerBarUtc: string;
  backtestSide: string;
  backtestTriggerClose: number;
  liveSignal: string;
  liveEntry: number;
  liveTriggerBarUtc: string;
  triggerIsOnFinalCachedBar: boolean;
  triggerIsOnFinalCachedBarNote: string | null;
  agrees: boolean;
};

export type BacktestPayload = {
  generatedAt: string;
  rulesetVersion: string;
  engineCode: string[];
  dataWindow: Record<
    string,
    {
      label: string;
      firstBarUtc: string;
      lastBarUtc: string;
      bars: number;
      incompleteCandlesRefused: number;
      pagesRequested: number;
      gapsInHourlyGrid: number;
      brokerOldestServedUtc: string;
    }
  >;
  measurementPeriod: {
    headlineStartUtc: string;
    headlineEndUtc: string;
    heldOutLast12MonthsFromUtc: string;
    note: string;
  };
  assumptions: Record<string, string | boolean>;
  exclusions: string[];
  reconciliationWithLive: Record<string, ReconciliationRow>;
  spreadsPaid: Record<string, SpreadRow>;
  holdingTimes: Record<
    string,
    {
      trades: number;
      minHours: number;
      medianHours: number;
      meanHours: number;
      p90Hours: number;
      maxHours: number;
      histogram: Record<string, number>;
      note: string;
    }
  >;
  results: {
    headline_nextBarOpen_bidAsk: Variant;
    zeroCost_mid_nextBarOpen: Variant;
    optimisticUpperBound_triggerClose: Variant;
  };
  yearByYear: { headline: { perPair: Record<string, YearRow[]>; combined: YearRow[] } };
};

export type BacktestLoad =
  | { ok: true; payload: BacktestPayload; provenance: Provenance }
  | { ok: false; error: string; skipped: SkippedCandidate[] };

export async function loadBacktestResults(): Promise<BacktestLoad> {
  const resolved = await resolveData("backtest");
  if (!resolved.ok) {
    return {
      ok: false,
      skipped: resolved.skipped,
      error: `The backtest results file could not be read (${resolved.error}). Nothing on this page is available — no figure is shown from memory or from an earlier run.`,
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
        "The backtest results file is present but could not be parsed. Nothing on this page is available rather than showing a partial reading.",
    };
  }

  // Strip only the two bulk keys; everything else is passed through untouched.
  const { tradesHeadline: _trades, liveSignalsRaw: _live, ...rest } = parsed;
  void _trades;
  void _live;
  return { ok: true, payload: rest as unknown as BacktestPayload, provenance: resolved.provenance };
}
