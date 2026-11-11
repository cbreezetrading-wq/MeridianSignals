/**
 * /backtest/search — the pre-registered strategy search, read straight from the
 * verifier's own machine-readable output.
 *
 * The only source is `verify/strategy-search/results.json`, the file the search
 * harness wrote. This module does no arithmetic on outcomes: every trade count, R,
 * pip total, win rate, profit factor, per-fold R and p-value is read from that file
 * and handed to the page. The figures the page needs that the file does not store as
 * a field — the gross edge per trade and the spread cost per trade (the difference
 * between the mid-priced re-run and the real-bid/ask run), the share of the cost the
 * gross edge covers, the multiple of it a candidate would need to break even, the
 * number of positive folds per candidate, and the total R across the nine — are
 * arithmetic on stored fields, computed here in one place, and labelled on the page
 * as computed.
 *
 * The only things on the page that do not come from this file are the protocol's
 * fixed period boundaries and the declared candidate rules. Those are statements of
 * what was pre-registered, quoted from `strategy-search-PROTOCOL.md`; no measured
 * figure is taken from that document. Every number is from results.json.
 *
 * Where the bytes come from is decided by resolveData() in bundledData.ts, in one
 * documented order: env override → the shared path on the owner's machine → the
 * snapshot bundled into this build → nothing.
 *
 * If none of them can be read the payload is `null` and the page says so. A missing
 * file never becomes a remembered or plausible-looking number.
 */

import { resolveData, type Provenance, type SkippedCandidate } from "./bundledData";

/** The env override honoured for this file (see bundledData.ts). */
export const STRATEGY_SEARCH_RESULTS_ENV = "STRATEGY_SEARCH_RESULTS_PATH";

/**
 * One measured block. Identical shape for the development period, the pooled
 * walk-forward out-of-sample period and the sealed held-out period.
 */
export type SearchBlock = {
  n: number;
  R: number;
  pips: number;
  /** Win rate, per cent. */
  win: number;
  pf: number;
  /** Expectancy in R per trade. */
  avgR: number;
  avgPips: number;
  /** Mean spread paid per trade, in pips. */
  avgSpread: number;
  avgWinPips: number;
  avgAbsExc: number;
};

/** A measured block with the one-sided p-value on per-trade R. */
export type SearchPairBlock = SearchBlock & { p: number };

export type SearchCandidate = {
  id: string;
  name: string;
  dev: SearchBlock;
  oos: SearchBlock;
  held: SearchBlock;
  /** Net R of each of the four anchored walk-forward folds. */
  foldR: number[];
  foldN: number[];
  /** One-sided t-test p-value on per-trade R, pooled OOS (H0: mean ≤ 0). */
  oosP: number;
  oosT: number;
  pairStats: Record<string, SearchPairBlock>;
  pairHeld: Record<string, SearchPairBlock>;
  nTradesTotal: number;
};

/** The mid-priced re-run of one candidate: the same rules with the spread removed. */
export type SearchMidOnly = {
  n: number;
  R: number;
  /** Gross expectancy in R per trade, at the mid. */
  exp: number;
  RWithCost: number;
  expWithCost: number;
  spreadCostR: number;
  spreadCostPipsPerTrade: number;
};

export type SearchSelfTests = {
  oracle: SearchBlock & { note: string };
  midOnly: Record<string, SearchMidOnly>;
};

export type SearchFdr = {
  q: number;
  thresh: number;
  k: number;
  m: number;
  bonferroni: number;
};

export type SearchPayload = {
  generatedAt: string;
  candidates: SearchCandidate[];
  spreadByPair: Record<string, { avgSpreadPips: number }>;
  dataRange: Record<string, { bars: number; first: string; last: string }>;
  selfTests: SearchSelfTests;
  fdr: SearchFdr;
  pairFdr: SearchFdr;
};

/**
 * Arithmetic on stored fields, kept in one place so the page cannot invent a figure.
 */
export type SearchCostRow = {
  id: string;
  /** Gross edge per trade in R, priced at the mid (spread removed). */
  grossExpR: number;
  /** Net edge per trade in R, at the real bid/ask. */
  netExpR: number;
  /** grossExpR − netExpR: what the spread cost per trade, in R. */
  costExpR: number;
  /** The mid-priced re-run's trade count, which need not equal the cost run's. */
  midN: number;
  costN: number;
  /** grossExpR as a percentage of costExpR; null when the gross edge is itself ≤ 0. */
  shareOfCostPct: number | null;
  /** How many times its own gross edge a candidate would need to break even. */
  breakEvenMultiple: number | null;
};

export type SearchDerived = {
  /** Bars summed over the four pairs, from dataRange. */
  totalBars: number;
  pairs: number;
  candidateCount: number;
  /** Net R over all nine candidates, pooled OOS, and in the held-out period. */
  oosTotalR: number;
  heldTotalR: number;
  /** Candidates negative in each period. */
  oosNegative: number;
  heldNegative: number;
  /** The least-bad candidate on pooled OOS, and the worst. */
  bestOos: { id: string; avgR: number } | null;
  worstOos: { id: string; avgR: number } | null;
  /** The largest gross edge in the family, and what it still fails to cover. */
  bestGross: SearchCostRow | null;
  /** The smallest one-sided p of the nine — the nearest anything came. */
  minP: { id: string; p: number } | null;
  /** Per candidate, how many of the four folds were positive (0–4). */
  foldsPositive: Record<string, number>;
  /** Candidates positive in all four folds (the protocol's first test). */
  positiveInAllFolds: string[];
  /** Per-candidate cost arithmetic. */
  cost: Record<string, SearchCostRow>;
  /** Per-pair mean spread over the whole history, from spreadByPair. */
  spreadByPairPips: Record<string, number>;
  /** Candidate spread paid per trade, min and max, pooled OOS. */
  spreadPaidRangeOos: { min: number; max: number } | null;
  /** The same, in the held-out period. */
  spreadPaidRangeHeld: { min: number; max: number } | null;
  /**
   * The single nominally significant pair-level cell (smallest p < 0.05 across the
   * 36), with what the same cell did in the held-out period.
   */
  nominallySignificantPair: {
    id: string;
    pair: string;
    R: number;
    p: number;
    trades: number;
    avgR: number;
    heldR: number;
    heldP: number;
    heldTrades: number;
    heldAvgR: number;
  } | null;
  /** Number of pair-level cells whose p < 0.05, out of m. */
  significantPairCells: number;
};

export type SearchLoad =
  | { ok: true; payload: SearchPayload; derived: SearchDerived; provenance: Provenance }
  | { ok: false; error: string; skipped: SkippedCandidate[] };

function sum(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0);
}

function derive(payload: SearchPayload): SearchDerived {
  const candidates = payload.candidates;
  const mid = payload.selfTests?.midOnly ?? {};

  const cost: Record<string, SearchCostRow> = {};
  for (const c of candidates) {
    const m = mid[c.id];
    // Gross edge and net edge are both stored; the spread's cost per trade is the
    // difference between them. Nothing is estimated.
    const grossExpR = m ? m.exp : Number.NaN;
    const netExpR = c.oos.avgR;
    const costExpR = grossExpR - netExpR;
    cost[c.id] = {
      id: c.id,
      grossExpR,
      netExpR,
      costExpR,
      midN: m ? m.n : 0,
      costN: c.oos.n,
      shareOfCostPct: grossExpR > 0 && costExpR > 0 ? (100 * grossExpR) / costExpR : null,
      breakEvenMultiple: grossExpR > 0 && costExpR > 0 ? costExpR / grossExpR : null,
    };
  }

  const foldsPositive: Record<string, number> = {};
  const positiveInAllFolds: string[] = [];
  for (const c of candidates) {
    const count = c.foldR.filter((r) => r > 0).length;
    foldsPositive[c.id] = count;
    if (c.foldR.length === 4 && count === 4) positiveInAllFolds.push(c.id);
  }

  const byOos = [...candidates].sort((a, b) => b.oos.avgR - a.oos.avgR);
  const byP = [...candidates].sort((a, b) => a.oosP - b.oosP);
  const grossRows = Object.values(cost).filter((r) => Number.isFinite(r.grossExpR));
  const bestGross = grossRows.length > 0 ? grossRows.reduce((a, b) => (b.grossExpR > a.grossExpR ? b : a)) : null;

  const spreadByPairPips: Record<string, number> = {};
  for (const [pair, v] of Object.entries(payload.spreadByPair ?? {})) {
    if (typeof v?.avgSpreadPips === "number") spreadByPairPips[pair] = v.avgSpreadPips;
  }

  const oosSpreads = candidates.map((c) => c.oos.avgSpread).filter((v) => typeof v === "number");
  const heldSpreads = candidates.map((c) => c.held.avgSpread).filter((v) => typeof v === "number");

  let nominallySignificantPair: SearchDerived["nominallySignificantPair"] = null;
  let significantPairCells = 0;
  for (const c of candidates) {
    for (const [pair, row] of Object.entries(c.pairStats ?? {})) {
      if (typeof row?.p !== "number") continue;
      if (row.p < 0.05) significantPairCells += 1;
      if (row.p < 0.05 && (nominallySignificantPair === null || row.p < nominallySignificantPair.p)) {
        const held = c.pairHeld?.[pair];
        nominallySignificantPair = {
          id: c.id,
          pair,
          R: row.R,
          p: row.p,
          trades: row.n,
          avgR: row.avgR,
          heldR: held?.R ?? Number.NaN,
          heldP: held?.p ?? Number.NaN,
          heldTrades: held?.n ?? 0,
          heldAvgR: held?.avgR ?? Number.NaN,
        };
      }
    }
  }

  return {
    totalBars: sum(Object.values(payload.dataRange ?? {}).map((r) => r.bars)),
    pairs: Object.keys(payload.dataRange ?? {}).length,
    candidateCount: candidates.length,
    oosTotalR: sum(candidates.map((c) => c.oos.R)),
    heldTotalR: sum(candidates.map((c) => c.held.R)),
    oosNegative: candidates.filter((c) => c.oos.R < 0).length,
    heldNegative: candidates.filter((c) => c.held.R < 0).length,
    bestOos: byOos[0] ? { id: byOos[0].id, avgR: byOos[0].oos.avgR } : null,
    worstOos: byOos.at(-1) ? { id: byOos.at(-1)!.id, avgR: byOos.at(-1)!.oos.avgR } : null,
    bestGross,
    minP: byP[0] ? { id: byP[0].id, p: byP[0].oosP } : null,
    foldsPositive,
    positiveInAllFolds,
    cost,
    spreadByPairPips,
    spreadPaidRangeOos:
      oosSpreads.length > 0 ? { min: Math.min(...oosSpreads), max: Math.max(...oosSpreads) } : null,
    spreadPaidRangeHeld:
      heldSpreads.length > 0 ? { min: Math.min(...heldSpreads), max: Math.max(...heldSpreads) } : null,
    nominallySignificantPair,
    significantPairCells,
  };
}

export async function loadStrategySearchResults(): Promise<SearchLoad> {
  const resolved = await resolveData("strategy-search");
  if (!resolved.ok) {
    return {
      ok: false,
      skipped: resolved.skipped,
      error: `The strategy search results file could not be read (${resolved.error}). Nothing on this page is available — no figure is shown from memory or from an earlier run.`,
    };
  }

  let parsed: SearchPayload;
  try {
    parsed = JSON.parse(resolved.text) as SearchPayload;
  } catch {
    return {
      ok: false,
      skipped: resolved.provenance.skipped,
      error:
        "The strategy search results file is present but could not be parsed. Nothing on this page is available rather than showing a partial reading.",
    };
  }

  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    return {
      ok: false,
      skipped: resolved.provenance.skipped,
      error:
        "The strategy search results file carries no candidate rows. Nothing on this page is available rather than an empty table that looks like a result.",
    };
  }

  return { ok: true, payload: parsed, derived: derive(parsed), provenance: resolved.provenance };
}
