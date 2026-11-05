/**
 * Signal instruction: shape, completeness validation, and position sizing.
 *
 * An instruction is a COMPLETE, self-describing trade proposal. Anything the engine
 * would otherwise have to guess at is a required field, and a missing field is a
 * refusal with a named reason — never a default.
 */

import { num, type ResolvedSettings } from "./config.ts";

export type Direction = "long" | "short";

/**
 * Where the instruction came from. Every order in the record and on the console carries one
 * of these, so no reader has to infer what an order was for.
 *
 *  - INVENTED_RULESET_TEST — the invented ruleset that both backtests found not tradeable.
 *    It may only originate Practice orders for connection testing, and every order it
 *    originates is labelled with this origin.
 *  - CONNECTION_TEST — a deliberate, one-off order whose only purpose is to prove the order
 *    path end to end (submit, protection attached, broker read-back). It is NOT a rule
 *    firing and NOT a strategy signal, and it is a DIFFERENT label from
 *    INVENTED_RULESET_TEST on purpose: a connection test must never be readable as the
 *    ruleset trading, and the ruleset's orders must never be readable as a connection test.
 *  - OWNER_METHOD — the owner's own ruleset. The owner has supplied none, so nothing carries
 *    this origin today.
 */
export type InstructionOrigin = "INVENTED_RULESET_TEST" | "CONNECTION_TEST" | "OWNER_METHOD";

export const ORIGINS: readonly InstructionOrigin[] = ["INVENTED_RULESET_TEST", "CONNECTION_TEST", "OWNER_METHOD"];

/**
 * How the unit count is derived. This is an explicit mode, never inferred.
 *
 *  - RISK — units from the stop distance, NAV and riskPerTradePct. This is the ONLY mode a
 *    real trade may use, and it is the default.
 *  - BROKER_MINIMUM — units fixed at the instrument's own `minimumTradeSize`, with the risk
 *    and notional derived FROM those units rather than the units derived from the risk.
 *    Permitted only for origin CONNECTION_TEST: a connection test is trying to prove the
 *    path works, not to carry the risk of a sized position. Every other check — spread,
 *    entry deviation, exposure, max positions, daily loss, duplicate, chain, interlock and
 *    the pre-submit risk re-check — runs unchanged.
 */
export type SizingMode = "RISK" | "BROKER_MINIMUM";

export const SIZING_MODES: readonly SizingMode[] = ["RISK", "BROKER_MINIMUM"];

export type SignalInstruction = {
  /** Unique per signal. The idempotency key is derived from it. */
  signalId: string;
  strategyId: string;
  strategyVersion: string;
  instrument: string;
  direction: Direction;
  /** When the rule fired (ISO). */
  generatedAt: string;
  /** The bar the rule fired on. */
  sourceBar: { time: string; close: number; granularity: string };
  /** When this instruction stops being valid (ISO). */
  expiryAt: string;
  orderType: "MARKET";
  /** Entry conditions: what must hold at submission time. */
  entryConditions: string;
  stopPrice: number;
  takeProfitPrice: number;
  exitRules: string;
  /** The rule for an already-open position in this instrument. */
  existingPositionRule: string;
  /** The rule when the opposite signal arrives. */
  oppositeSignalRule: string;
  /** The rule for a repeat entry on the same instrument. */
  repeatEntryRule: string;
  /**
   * Where the instruction came from. INVENTED_RULESET_TEST means the invented
   * ruleset that both backtests found not tradeable — it may only produce Practice
   * orders for connection testing, and every order it originates is labelled.
   * CONNECTION_TEST means a deliberate one-off order that exists only to prove the
   * order path; it is a distinct label so the two can never be read as each other.
   */
  origin: InstructionOrigin;
  /**
   * How the size is derived. Optional and defaulting to RISK, so every instruction written
   * before this field existed keeps exactly the sizing it had. BROKER_MINIMUM is refused
   * unless the origin is CONNECTION_TEST (see validateInstruction).
   */
  sizingMode?: SizingMode;
};

export type ValidationIssue = { field: string; reason: string };

export type ValidationResult = { ok: boolean; issues: ValidationIssue[] };

const NON_EMPTY_STRINGS: Array<keyof SignalInstruction> = [
  "signalId",
  "strategyId",
  "strategyVersion",
  "instrument",
  "direction",
  "generatedAt",
  "expiryAt",
  "orderType",
  "entryConditions",
  "exitRules",
  "existingPositionRule",
  "oppositeSignalRule",
  "repeatEntryRule",
  "origin",
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Date.parse(v));
}

/**
 * Validate an instruction. Every problem is reported with the field name and a
 * plain reason, so a refusal in the record names what was missing.
 */
export function validateInstruction(instruction: Partial<SignalInstruction>, now = new Date()): ValidationResult {
  const issues: ValidationIssue[] = [];
  const i = instruction as Record<string, unknown>;

  for (const field of NON_EMPTY_STRINGS) {
    const v = i[field];
    if (typeof v !== "string" || v.trim() === "") {
      issues.push({ field, reason: `${field} is required and was not supplied` });
    }
  }

  if (typeof i.direction === "string" && !["long", "short"].includes(i.direction)) {
    issues.push({ field: "direction", reason: `direction must be "long" or "short", got ${JSON.stringify(i.direction)}` });
  }
  if (typeof i.orderType === "string" && i.orderType !== "MARKET") {
    issues.push({ field: "orderType", reason: `only MARKET entries are implemented in this build; got ${JSON.stringify(i.orderType)}` });
  }
  if (typeof i.origin === "string" && !(ORIGINS as readonly string[]).includes(i.origin)) {
    issues.push({ field: "origin", reason: `origin must be one of ${ORIGINS.join(", ")}, got ${JSON.stringify(i.origin)}` });
  }
  // Sizing mode: absent means RISK. A present value must be a known mode, and BROKER_MINIMUM
  // is only ever permitted for a connection test — it sizes every order at the broker's
  // minimum regardless of the risk budget, which must never happen to a real trade by
  // accident (or by a field someone set and forgot).
  if (i.sizingMode !== undefined && i.sizingMode !== null) {
    if (typeof i.sizingMode !== "string" || !(SIZING_MODES as readonly string[]).includes(i.sizingMode)) {
      issues.push({ field: "sizingMode", reason: `sizingMode must be one of ${SIZING_MODES.join(", ")} or absent (absent means RISK), got ${JSON.stringify(i.sizingMode)}` });
    } else if (i.sizingMode === "BROKER_MINIMUM" && i.origin !== "CONNECTION_TEST") {
      issues.push({
        field: "sizingMode",
        reason: `sizingMode BROKER_MINIMUM fixes the size at the broker's minimumTradeSize instead of the risk budget, so it is permitted only for origin CONNECTION_TEST; got origin ${JSON.stringify(i.origin)}`,
      });
    }
  }

  if (!isIso(i.generatedAt)) issues.push({ field: "generatedAt", reason: "generatedAt must be an ISO timestamp" });
  if (!isIso(i.expiryAt)) issues.push({ field: "expiryAt", reason: "expiryAt must be an ISO timestamp" });

  const bar = i.sourceBar as Record<string, unknown> | undefined;
  if (!bar || typeof bar !== "object") {
    issues.push({ field: "sourceBar", reason: "sourceBar is required (time, close, granularity of the bar the rule fired on)" });
  } else {
    if (!isIso(bar.time)) issues.push({ field: "sourceBar.time", reason: "sourceBar.time must be an ISO timestamp" });
    if (!isFiniteNumber(bar.close)) issues.push({ field: "sourceBar.close", reason: "sourceBar.close must be a finite number" });
    if (typeof bar.granularity !== "string" || bar.granularity.trim() === "") {
      issues.push({ field: "sourceBar.granularity", reason: "sourceBar.granularity is required" });
    }
  }

  if (!isFiniteNumber(i.stopPrice) || (i.stopPrice as number) <= 0) {
    issues.push({ field: "stopPrice", reason: "stopPrice must be a positive number — an order is never sent without a stop" });
  }
  if (!isFiniteNumber(i.takeProfitPrice) || (i.takeProfitPrice as number) <= 0) {
    issues.push({ field: "takeProfitPrice", reason: "takeProfitPrice must be a positive number" });
  }

  // Directional sanity: stop on the losing side, target on the winning side.
  if (isFiniteNumber(i.stopPrice) && isFiniteNumber(bar?.close) && i.direction === "long" && i.stopPrice >= (bar.close as number)) {
    issues.push({ field: "stopPrice", reason: `a long's stop (${String(i.stopPrice)}) must sit below the source bar close (${String(bar?.close)})` });
  }
  if (isFiniteNumber(i.stopPrice) && isFiniteNumber(bar?.close) && i.direction === "short" && i.stopPrice <= (bar.close as number)) {
    issues.push({ field: "stopPrice", reason: `a short's stop (${String(i.stopPrice)}) must sit above the source bar close (${String(bar?.close)})` });
  }
  if (isFiniteNumber(i.takeProfitPrice) && isFiniteNumber(bar?.close) && i.direction === "long" && i.takeProfitPrice <= (bar.close as number)) {
    issues.push({ field: "takeProfitPrice", reason: `a long's target (${String(i.takeProfitPrice)}) must sit above the source bar close (${String(bar?.close)})` });
  }
  if (isFiniteNumber(i.takeProfitPrice) && isFiniteNumber(bar?.close) && i.direction === "short" && i.takeProfitPrice >= (bar.close as number)) {
    issues.push({ field: "takeProfitPrice", reason: `a short's target (${String(i.takeProfitPrice)}) must sit below the source bar close (${String(bar?.close)})` });
  }

  if (isIso(i.generatedAt) && Date.parse(i.generatedAt) > now.getTime()) issues.push({ field: "generatedAt", reason: "Future signals cannot execute" });
  // Expiry.
  if (isIso(i.expiryAt)) {
    const exp = Date.parse(i.expiryAt);
    if (exp <= now.getTime()) {
      issues.push({ field: "expiryAt", reason: `instruction expired at ${i.expiryAt} (now ${now.toISOString()})` });
    }
    if (isIso(i.generatedAt) && Date.parse(i.generatedAt) > exp) {
      issues.push({ field: "expiryAt", reason: "expiryAt is before generatedAt" });
    }
  }

  return { ok: issues.length === 0, issues };
}

/* ------------------------------------------------------------------- sizing */

export type InstrumentMeta = {
  name: string;
  displayPrecision: number;
  tradeUnitsPrecision: number;
  minimumTradeSize: string;
  maximumOrderUnits: string;
  marginRate: string;
};

export type Quote = { instrument: string; bid: number; ask: number; mid: number; tradeable: boolean; time: string; spreadPips: number };

export type SizingResult =
  | {
      ok: true;
      units: number;
      signedUnits: number;
      /** |far-side entry − stop| in the quote currency. The WORST-CASE stop distance. */
      riskPerUnitQuote: number;
      /** The price the position will actually fill at: ask for a long, bid for a short. */
      entryPriceFar: number;
      /** The mid at the same instant. Recorded for reference; never used to size. */
      midPrice: number;
      sizingBasis: "FAR_SIDE";
      quoteToAccountRate: number;
      conversion: string;
      /** units × far-side stop distance × conversion. The risk actually being budgeted. */
      riskAccountCurrency: number;
      riskPctOfNav: number;
      notionalAccountCurrency: number;
      /**
       * What the OLD mid-based sizing would have produced for the same quote: the unit
       * count and the risk it would have budgeted. Kept in the record so the size that
       * would have breached the cap and the size that does not can be compared directly.
       */
      midBasis: { units: number; riskAccountCurrency: number; riskPerUnitQuote: number };
      /** Which mode produced `units`. Stated in the proposal and the record, never inferred. */
      sizingMode: SizingMode;
      rounding: string;
    }
  | { ok: false; reason: string; detail: string };

export function pipSize(instrument: string): number {
  return instrument.toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

/**
 * The price a MARKET order of this direction fills at.
 *
 * A long is filled at the ASK, a short at the BID — the far side of the spread. Sizing
 * from the mid understates the stop distance by half the spread, which is exactly the
 * defect measured in trades 5, 15, 25, 33 and 43: every one of them risked 2.8%–7.7%
 * more than the configured maximum, because the position opened half a spread further
 * from its stop than the size had been derived from.
 */
export function farSideEntryPrice(direction: Direction, quote: { bid: number; ask: number; mid: number }): number {
  return direction === "long" ? quote.ask : quote.bid;
}

/**
 * Units from stop distance, account currency, equity and the risk-per-trade setting.
 *
 *   entryPriceFar     = ask for a long, bid for a short      (the far side of the spread)
 *   riskAmount        = NAV * riskPerTradePct / 100          (account currency)
 *   riskPerUnitQuote  = |entryPriceFar - stopPrice|          (quote currency)
 *   riskPerUnitAcct   = riskPerUnitQuote * quoteToAccount    (account currency)
 *   units             = floor(riskAmount / riskPerUnitAcct)  rounded DOWN to the
 *                       instrument's tradeUnitsPrecision
 *
 * The size is derived from the FAR side of the spread, never from the mid. A MARKET
 * order fills at the ask (long) or the bid (short), so the half spread between the mid
 * and the far side is risk the position really carries and it has to sit inside the
 * budget. Sizing on the mid puts it outside the budget — measured, not hypothesised:
 * trades 5, 15, 25, 33 and 43 all filled on the far side and all risked 2.8%–7.7% more
 * than the configured maximum.
 *
 * Rounding DOWN is deliberate: with a fixed stop, the realised risk can then only be
 * below the budget, never above it — as long as the fill is no worse than the far side
 * used here. A fill beyond it cannot be prevented (a MARKET/FOK order is filled inside
 * the request that submits it), so it is measured after the fact from the broker's own
 * fill and surfaced; see lib/risk.ts.
 *
 * BROKER_MINIMUM is the one other mode, and it does not change any of the above: the units
 * are the instrument's `minimumTradeSize` and the risk and notional are derived FROM those
 * units, so the proposal still states what the position risks at the far side. It exists
 * for a connection test, where the point is to prove the order path works rather than to
 * carry a sized position's risk. BELOW_MINIMUM_SIZE is a RISK-mode refusal only: in
 * BROKER_MINIMUM the size IS the minimum, so there is nothing below it to refuse.
 */
export function sizePosition(args: {
  instrument: string;
  direction: Direction;
  /** The broker's quote for the instrument. Sizing uses its far side, never its mid. */
  quote: Pick<Quote, "bid" | "ask" | "mid">;
  stopPrice: number;
  nav: number;
  accountCurrency: string;
  meta: InstrumentMeta;
  riskPerTradePct: number;
  /** mid prices keyed by instrument, for currency conversion only. */
  quotes: Record<string, Quote>;
  /** Defaults to RISK. BROKER_MINIMUM fixes the units at the instrument's minimum size. */
  sizingMode?: SizingMode;
}): SizingResult {
  const { instrument, direction, quote, stopPrice, nav, accountCurrency, meta, riskPerTradePct, quotes } = args;
  const sizingMode: SizingMode = args.sizingMode ?? "RISK";

  if (!Number.isFinite(quote?.bid) || quote.bid <= 0 || !Number.isFinite(quote?.ask) || quote.ask <= 0) {
    return {
      ok: false,
      reason: "NO_ENTRY_PRICE",
      detail: "the quote's bid and ask are not both positive finite numbers, so the far side of the spread — the price the order would fill at — is unknown",
    };
  }
  if (!(quote.ask >= quote.bid)) {
    return { ok: false, reason: "BAD_QUOTE", detail: `the ask ${quote.ask} is below the bid ${quote.bid}, so the far side of the spread cannot be determined` };
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: "NO_STOP_PRICE", detail: "stop price is not a positive finite number" };
  if (!Number.isFinite(nav) || nav <= 0) return { ok: false, reason: "NO_EQUITY", detail: "account NAV is not positive" };

  const [base, quoteCcy] = instrument.split("_");
  if (!base || !quoteCcy) return { ok: false, reason: "BAD_INSTRUMENT", detail: `instrument ${instrument} is not BASE_QUOTE` };

  const entryPriceFar = farSideEntryPrice(direction, quote);
  const midPrice = quote.mid;
  const riskPerUnitQuote = Math.abs(entryPriceFar - stopPrice);
  if (!(riskPerUnitQuote > 0)) {
    return {
      ok: false,
      reason: "ZERO_STOP_DISTANCE",
      detail: `the ${direction}'s far-side entry price ${entryPriceFar} equals its stop ${stopPrice}, so risk per unit is zero`,
    };
  }
  if (direction === "long" ? stopPrice >= entryPriceFar : stopPrice <= entryPriceFar) {
    return {
      ok: false,
      reason: "STOP_ON_WRONG_SIDE",
      detail: `a ${direction}'s stop ${stopPrice} is not on the losing side of the price it would fill at (${entryPriceFar}, the ${direction === "long" ? "ask" : "bid"})`,
    };
  }

  // Quote currency → account currency.
  let quoteToAccount = 1;
  let conversion = `quote currency ${quoteCcy} is the account currency ${accountCurrency}; no conversion needed`;
  if (quoteCcy !== accountCurrency) {
    const direct = quotes[`${accountCurrency}_${quoteCcy}`];
    const inverse = quotes[`${quoteCcy}_${accountCurrency}`];
    if (direct) {
      quoteToAccount = 1 / direct.mid;
      conversion = `1 ${quoteCcy} = ${(1 / direct.mid).toFixed(8)} ${accountCurrency}, from ${accountCurrency}_${quoteCcy} mid ${direct.mid}`;
    } else if (inverse) {
      quoteToAccount = inverse.mid;
      conversion = `1 ${quoteCcy} = ${inverse.mid.toFixed(8)} ${accountCurrency}, from ${quoteCcy}_${accountCurrency} mid ${inverse.mid}`;
    } else {
      return {
        ok: false,
        reason: "NO_CONVERSION_RATE",
        detail: `account is in ${accountCurrency} and the instrument's quote currency is ${quoteCcy}; no ${accountCurrency}_${quoteCcy} or ${quoteCcy}_${accountCurrency} price is available to convert risk, so units cannot be computed honestly`,
      };
    }
  }

  const riskPerUnitAccount = riskPerUnitQuote * quoteToAccount;
  const riskAmount = (nav * riskPerTradePct) / 100;
  const rawUnits = riskAmount / riskPerUnitAccount;

  const step = Math.pow(10, -Math.max(0, meta.tradeUnitsPrecision));
  const floored = Math.floor(rawUnits / step) * step;
  const minUnits = Number(meta.minimumTradeSize);
  const maxUnits = Number(meta.maximumOrderUnits);

  let units: number;
  let rounding: string;

  if (sizingMode === "BROKER_MINIMUM") {
    // The size IS the instrument's minimum. Risk-based sizing is still computed and reported
    // beside it, so the record shows what the risk budget would have bought and what the
    // minimum size actually risks — but it does not decide the units.
    if (!Number.isFinite(minUnits) || minUnits <= 0) {
      return {
        ok: false,
        reason: "NO_MINIMUM_SIZE",
        detail: `sizingMode BROKER_MINIMUM needs the instrument's minimumTradeSize, and the broker's metadata gives ${JSON.stringify(meta.minimumTradeSize)} for ${instrument}, which is not a positive number`,
      };
    }
    units = minUnits;
    if (Number.isFinite(maxUnits) && units > maxUnits) {
      return { ok: false, reason: "ABOVE_MAXIMUM_SIZE", detail: `the instrument minimum ${minUnits} units exceeds the instrument maximum ${String(meta.maximumOrderUnits)}` };
    }
    rounding = `units fixed at the broker's minimumTradeSize ${minUnits} (sizingMode BROKER_MINIMUM); risk-based sizing would have produced ${rawUnits.toFixed(4)} units at ${riskPerTradePct}% of NAV and is reported beside this, not used`;
  } else {
    if (!Number.isFinite(floored) || floored < minUnits) {
      return {
        ok: false,
        reason: "BELOW_MINIMUM_SIZE",
        detail: `risk ${riskAmount.toFixed(2)} ${accountCurrency} over a ${riskPerUnitAccount.toFixed(8)} ${accountCurrency}/unit stop (far-side entry ${entryPriceFar} to stop ${stopPrice}) gives ${rawUnits.toFixed(4)} units, below the instrument minimum of ${String(meta.minimumTradeSize)}; the minimum size would risk more than the cap, so nothing is submitted`,
      };
    }
    if (Number.isFinite(maxUnits) && floored > maxUnits) {
      return { ok: false, reason: "ABOVE_MAXIMUM_SIZE", detail: `computed ${floored} units exceeds the instrument maximum ${String(meta.maximumOrderUnits)}` };
    }
    units = Number(floored.toFixed(Math.max(0, meta.tradeUnitsPrecision)));
    rounding = `raw ${rawUnits.toFixed(4)} units floored to ${units} at tradeUnitsPrecision ${meta.tradeUnitsPrecision} (rounding down, so realised risk stays under the budget while the fill is no worse than the far-side price ${entryPriceFar})`;
  }

  const riskAccountCurrency = units * riskPerUnitAccount;
  const notionalAccountCurrency = units * entryPriceFar * quoteToAccount;

  // What the previous, mid-based sizing would have produced for this same quote. Reported,
  // never used: it lets the record show the size that would have breached the cap beside
  // the size that does not.
  const midDistance = Math.abs(midPrice - stopPrice);
  const midRawUnits = midDistance > 0 ? riskAmount / (midDistance * quoteToAccount) : 0;
  const midUnits = Number((Math.floor(midRawUnits / step) * step).toFixed(Math.max(0, meta.tradeUnitsPrecision)));

  return {
    ok: true,
    units,
    signedUnits: direction === "long" ? units : -units,
    riskPerUnitQuote,
    entryPriceFar,
    midPrice,
    sizingBasis: "FAR_SIDE",
    quoteToAccountRate: quoteToAccount,
    conversion,
    riskAccountCurrency,
    riskPctOfNav: (riskAccountCurrency / nav) * 100,
    notionalAccountCurrency,
    midBasis: {
      units: midUnits,
      riskPerUnitQuote: midDistance,
      riskAccountCurrency: midUnits * midDistance * quoteToAccount,
    },
    sizingMode,
    rounding,
  };
}

/** Price rounded to the instrument's display precision, as OANDA wants a string. */
export function formatPrice(price: number, displayPrecision: number): string {
  return price.toFixed(displayPrecision);
}

export function spreadPips(instrument: string, bid: number, ask: number): number {
  return (ask - bid) / pipSize(instrument);
}

export function settingsNumber(settings: ResolvedSettings, key: string): number {
  const s = settings.values[key];
  if (!s) throw new Error(`setting ${key} is not resolved`);
  return num(s);
}
