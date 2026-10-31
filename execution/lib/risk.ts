/**
 * Risk measurement: what a position actually risks, measured from the broker's own fill
 * and the stop the broker actually has attached.
 *
 * WHY THIS FILE EXISTS
 * The engine used to size from the mid price. A MARKET order does not fill at the mid —
 * it fills at the ask (long) or the bid (short) — so the realised stop distance was wider
 * than the one that had been budgeted, and every recorded Practice fill risked more than
 * the configured maximum: trades 5, 15, 25, 33 and 43, by 2.8% to 7.7%. The sizing fix is
 * in instruction.ts (farSideEntryPrice / sizePosition); this file is the measurement half:
 * it computes the realised risk and compares it with the budget and the cap.
 *
 * WHERE REFUSAL IS STILL POSSIBLE, AND WHERE IT IS NOT — the two cases, stated plainly:
 *
 *  1. BEFORE the write, refusal IS possible, and it is used. `riskRecheckBeforeSubmit`
 *     re-reads the quote immediately before the POST and refuses (REFUSED_RISK_RECHECK)
 *     if filling at the price now available would risk more than the cap. Nothing is
 *     sent, so no money is at risk, and the record names the price, the units and the
 *     excess. This also covers the case where the price has drifted between sizing and
 *     submission, which no amount of sizing care can prevent.
 *
 *  2. AFTER the write, refusal is NOT possible, and pretending otherwise would be a lie.
 *     The entry is a MARKET order with timeInForce FOK, submitted with its stop and
 *     target attached in the same request: the broker fills it inside that request. There
 *     is no window between submission and fill in which Meridian could cancel, and the
 *     owner-approved unit count cannot be re-sized after approval without submitting
 *     something other than what was approved. A fill worse than the far-side price the
 *     size was derived from is therefore only detectable after the fact. So it is
 *     measured here from the broker's own numbers, written into the append-only record
 *     next to the budgeted figure (kind REALISED_RISK), and surfaced as an alert in the
 *     status snapshot — not as a log line.
 *
 * Realised risk = |broker fill price − attached stop price| × units × quote→account rate.
 * It is the loss if the stop is hit, which is what "maximum risk per trade" means. Swap,
 * commission and slippage beyond the fill are excluded, exactly as they were in the budget.
 */

import { appendRecord, replay } from "./record.ts";
import { pipSize, type Direction } from "./instruction.ts";

/** Any excess above the cap is a breach. A tolerance here would be permission to breach. */
export const RISK_EPSILON = 1e-9;

export type RiskMeasurement = {
  ok: true;
  sizingBasis: "FAR_SIDE";
  instrument: string;
  direction: Direction;
  units: number;
  fillPrice: number;
  fillPriceSource: string;
  stopPrice: number;
  stopPriceSource: "BROKER_ATTACHED_STOP" | "PROPOSED_STOP";
  stopDistanceQuote: number;
  stopDistancePips: number;
  quoteToAccountRate: number;
  conversionSource: string;
  /** The loss if the attached stop is hit, at the broker's actual fill. */
  realisedRiskAccountCurrency: number;
  realisedRiskPctOfNav: number | null;
  /** What the size was derived to risk. Null when it cannot be recovered from the record. */
  budgetedRiskAccountCurrency: number | null;
  budgetedRiskPctOfNav: number | null;
  overBudgetAccountCurrency: number | null;
  overBudgetPct: number | null;
  /** The configured maximum for one trade at the time of the fill. */
  capAccountCurrency: number | null;
  capPctOfNav: number | null;
  /** True when the realised risk exceeds the configured maximum. */
  breachOfCap: boolean;
  breachAmountAccountCurrency: number | null;
  breachPctOfCap: number | null;
  computedAt: string;
};

export type RiskMeasurementFailure = { ok: false; reason: string; detail: string };

/**
 * Realised risk from the broker's fill price and the stop the broker actually has on the
 * trade. Pure: no I/O, so it can be unit-tested against recorded fills.
 */
export function computeRealisedRisk(args: {
  instrument: string;
  direction: Direction;
  /** Units as filled, unsigned. */
  units: number;
  fillPrice: number;
  fillPriceSource?: string;
  stopPrice: number;
  stopPriceSource?: "BROKER_ATTACHED_STOP" | "PROPOSED_STOP";
  quoteToAccountRate: number;
  conversionSource?: string;
  nav?: number | null;
  budgetedRiskAccountCurrency?: number | null;
  capAccountCurrency?: number | null;
  capPctOfNav?: number | null;
  now?: Date;
}): RiskMeasurement | RiskMeasurementFailure {
  const {
    instrument,
    direction,
    units,
    fillPrice,
    fillPriceSource = "broker orderFillTransaction price",
    stopPrice,
    stopPriceSource = "BROKER_ATTACHED_STOP",
    quoteToAccountRate,
    conversionSource = "quote currency equals the account currency",
    nav = null,
    budgetedRiskAccountCurrency = null,
    capAccountCurrency = null,
    capPctOfNav = null,
    now = new Date(),
  } = args;

  if (!Number.isFinite(units) || units <= 0) return { ok: false, reason: "NO_UNITS", detail: `units ${units} is not a positive finite number` };
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { ok: false, reason: "NO_FILL_PRICE", detail: `fill price ${fillPrice} is not a positive finite number` };
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: "NO_ATTACHED_STOP", detail: `stop price ${stopPrice} is not a positive finite number, so realised risk cannot be measured` };
  if (!Number.isFinite(quoteToAccountRate) || quoteToAccountRate <= 0) {
    return { ok: false, reason: "NO_CONVERSION_RATE", detail: `quote→account rate ${quoteToAccountRate} is not positive, so realised risk cannot be measured in the account currency` };
  }

  const stopDistanceQuote = Math.abs(fillPrice - stopPrice);
  const realisedRiskAccountCurrency = units * stopDistanceQuote * quoteToAccountRate;

  const overBudget =
    budgetedRiskAccountCurrency !== null && Number.isFinite(budgetedRiskAccountCurrency)
      ? realisedRiskAccountCurrency - budgetedRiskAccountCurrency
      : null;
  const breach = capAccountCurrency !== null && Number.isFinite(capAccountCurrency) ? realisedRiskAccountCurrency > capAccountCurrency + RISK_EPSILON : false;

  return {
    ok: true,
    sizingBasis: "FAR_SIDE",
    instrument,
    direction,
    units,
    fillPrice,
    fillPriceSource,
    stopPrice,
    stopPriceSource,
    stopDistanceQuote,
    stopDistancePips: stopDistanceQuote / pipSize(instrument),
    quoteToAccountRate,
    conversionSource,
    realisedRiskAccountCurrency,
    realisedRiskPctOfNav: nav && nav > 0 ? (realisedRiskAccountCurrency / nav) * 100 : null,
    budgetedRiskAccountCurrency,
    budgetedRiskPctOfNav:
      nav && nav > 0 && budgetedRiskAccountCurrency !== null ? (budgetedRiskAccountCurrency / nav) * 100 : null,
    overBudgetAccountCurrency: overBudget,
    overBudgetPct:
      overBudget !== null && budgetedRiskAccountCurrency ? (overBudget / budgetedRiskAccountCurrency) * 100 : null,
    capAccountCurrency,
    capPctOfNav,
    breachOfCap: breach,
    breachAmountAccountCurrency: breach && capAccountCurrency !== null ? realisedRiskAccountCurrency - capAccountCurrency : breach ? null : 0,
    breachPctOfCap: breach && capAccountCurrency ? ((realisedRiskAccountCurrency - capAccountCurrency) / capAccountCurrency) * 100 : breach ? null : 0,
    computedAt: now.toISOString(),
  };
}

/**
 * What the position would risk if it filled at this price — used by the pre-submit
 * re-check, where the units are already fixed and only the price can still change.
 */
export function riskAtPrice(args: {
  units: number;
  entryPrice: number;
  stopPrice: number;
  quoteToAccountRate: number;
}): number {
  return Math.abs(args.units) * Math.abs(args.entryPrice - args.stopPrice) * args.quoteToAccountRate;
}

/* --------------------------------------------------------------- record + alerts */

export type RealisedRiskRecord = {
  measurement: RiskMeasurement;
  orderKey: string | null;
  signalId: string | null;
  tradeId: string | null;
  origin: string | null;
  source: string;
};

/**
 * Append the realised-risk measurement to the append-only record, next to the budget it
 * is compared with. Never rewrites anything: a correction is a new record.
 *
 * A breach is also printed as a banner and, because the record is the source of truth,
 * it appears in the status snapshot as an alert (see ops.ts buildStatus). It is not
 * left to a log line.
 */
export async function appendRealisedRisk(record: RealisedRiskRecord): Promise<void> {
  const m = record.measurement;
  await appendRecord({
    kind: "REALISED_RISK",
    signalId: record.signalId,
    strategyId: null,
    strategyVersion: null,
    orderKey: record.orderKey,
    state: m.breachOfCap ? "RISK_BREACH" : "WITHIN_CAP",
    payload: {
      tradeId: record.tradeId,
      origin: record.origin,
      source: record.source,
      sizingBasis: m.sizingBasis,
      instrument: m.instrument,
      direction: m.direction,
      units: m.units,
      fillPrice: m.fillPrice,
      fillPriceSource: m.fillPriceSource,
      stopPrice: m.stopPrice,
      stopPriceSource: m.stopPriceSource,
      stopDistanceQuote: m.stopDistanceQuote,
      stopDistancePips: Number(m.stopDistancePips.toFixed(1)),
      quoteToAccountRate: m.quoteToAccountRate,
      conversionSource: m.conversionSource,
      budgetedRiskAccountCurrency: m.budgetedRiskAccountCurrency === null ? null : Number(m.budgetedRiskAccountCurrency.toFixed(4)),
      realisedRiskAccountCurrency: Number(m.realisedRiskAccountCurrency.toFixed(4)),
      realisedRiskPctOfNav: m.realisedRiskPctOfNav === null ? null : Number(m.realisedRiskPctOfNav.toFixed(4)),
      overBudgetAccountCurrency: m.overBudgetAccountCurrency === null ? null : Number(m.overBudgetAccountCurrency.toFixed(4)),
      overBudgetPct: m.overBudgetPct === null ? null : Number(m.overBudgetPct.toFixed(3)),
      capAccountCurrency: m.capAccountCurrency === null ? null : Number(m.capAccountCurrency.toFixed(4)),
      capPctOfNav: m.capPctOfNav,
      breachOfCap: m.breachOfCap,
      breachAmountAccountCurrency: m.breachAmountAccountCurrency === null ? null : Number(m.breachAmountAccountCurrency.toFixed(4)),
      breachPctOfCap: m.breachPctOfCap === null ? null : Number(m.breachPctOfCap.toFixed(3)),
      note: m.breachOfCap
        ? "REALISED RISK EXCEEDS THE CONFIGURED MAXIMUM. The fill was worse than the far-side price the size was derived from. This could only be detected after the fill: a MARKET/FOK entry is filled inside the request that submits it, so there is no point after submission at which the order could be refused. The position is live with its attached stop; the excess is recorded here and shown as an alert."
        : "Realised risk at the broker's fill is within the configured maximum.",
      computedAt: m.computedAt,
    },
  });

  if (m.breachOfCap) {
    const bar = "!".repeat(78);
    console.error(
      [
        "",
        bar,
        "!!  RISK BREACH — a filled position risks MORE than the configured maximum",
        `!!  trade ${record.tradeId ?? "?"} ${m.instrument} ${m.direction} ${m.units} units`,
        `!!  broker fill ${m.fillPrice} vs attached stop ${m.stopPrice} (${m.stopDistancePips.toFixed(1)} pips)`,
        `!!  realised ${m.realisedRiskAccountCurrency.toFixed(2)} vs cap ${m.capAccountCurrency?.toFixed(2) ?? "?"} ` +
          `(+${m.breachAmountAccountCurrency?.toFixed(2) ?? "?"}, +${m.breachPctOfCap?.toFixed(2) ?? "?"}%)`,
        `!!  budgeted was ${m.budgetedRiskAccountCurrency?.toFixed(2) ?? "unknown"}`,
        "!!  recorded as a REALISED_RISK record and shown in status.json → riskBreaches",
        bar,
        "",
      ].join("\n"),
    );
  }
}

/**
 * A risk that could NOT be measured, recorded as such. The business rule is that anything
 * not yet measured is labelled unmeasured — never left out, and never quietly assumed to
 * be within the cap.
 */
export async function appendUnmeasuredRisk(args: {
  orderKey: string | null;
  signalId: string | null;
  tradeId: string | null;
  reason: string;
  detail: string;
  source: string;
}): Promise<void> {
  await appendRecord({
    kind: "REALISED_RISK",
    signalId: args.signalId,
    orderKey: args.orderKey,
    state: "UNMEASURED",
    payload: {
      measured: false,
      tradeId: args.tradeId,
      reason: args.reason,
      detail: args.detail,
      source: args.source,
      note: "realised risk for this fill is NOT measured; it is recorded as unmeasured rather than assumed to be within the cap",
      computedAt: new Date().toISOString(),
    },
  });
  console.error(`REALISED RISK UNMEASURED for trade ${args.tradeId ?? "?"} (${args.reason}): ${args.detail}`);
}

/** Every breach in the record, newest first. Read-only; used by the status snapshot. */
export async function riskBreachesFromRecord(): Promise<
  Array<{
    recordedAt: string;
    orderKey: string | null;
    tradeId: string | null;
    instrument: string | null;
    direction: string | null;
    units: number | null;
    fillPrice: number | null;
    stopPrice: number | null;
    realisedRiskAccountCurrency: number | null;
    budgetedRiskAccountCurrency: number | null;
    capAccountCurrency: number | null;
    breachAmountAccountCurrency: number | null;
    breachPctOfCap: number | null;
    source: string | null;
  }>
> {
  const { all } = await replay();
  const out = [];
  for (const r of all) {
    if (r.kind !== "REALISED_RISK") continue;
    const p = (r.payload ?? {}) as any;
    if (p.breachOfCap !== true) continue;
    out.push({
      recordedAt: r.recordedAt,
      orderKey: r.orderKey,
      tradeId: p.tradeId ?? null,
      instrument: p.instrument ?? null,
      direction: p.direction ?? null,
      units: p.units ?? null,
      fillPrice: p.fillPrice ?? null,
      stopPrice: p.stopPrice ?? null,
      realisedRiskAccountCurrency: p.realisedRiskAccountCurrency ?? null,
      budgetedRiskAccountCurrency: p.budgetedRiskAccountCurrency ?? null,
      capAccountCurrency: p.capAccountCurrency ?? null,
      breachAmountAccountCurrency: p.breachAmountAccountCurrency ?? null,
      breachPctOfCap: p.breachPctOfCap ?? null,
      source: p.source ?? null,
    });
  }
  return out.reverse();
}
