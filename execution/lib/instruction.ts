/**
 * Signal instruction: shape, completeness validation, and position sizing.
 *
 * An instruction is a COMPLETE, self-describing trade proposal. Anything the engine
 * would otherwise have to guess at is a required field, and a missing field is a
 * refusal with a named reason — never a default.
 */

import type { Client } from "./client.ts";
import { num, type ResolvedSettings } from "./config.ts";

export type Direction = "long" | "short";

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
   */
  origin: "INVENTED_RULESET_TEST" | "OWNER_METHOD";
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
  if (typeof i.origin === "string" && !["INVENTED_RULESET_TEST", "OWNER_METHOD"].includes(i.origin)) {
    issues.push({ field: "origin", reason: `origin must be INVENTED_RULESET_TEST or OWNER_METHOD, got ${JSON.stringify(i.origin)}` });
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
      riskPerUnitQuote: number;
      quoteToAccountRate: number;
      conversion: string;
      riskAccountCurrency: number;
      riskPctOfNav: number;
      notionalAccountCurrency: number;
      rounding: string;
    }
  | { ok: false; reason: string; detail: string };

export function pipSize(instrument: string): number {
  return instrument.toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

/**
 * Units from stop distance, account currency, equity and the risk-per-trade setting.
 *
 *   riskAmount        = NAV * riskPerTradePct / 100            (account currency)
 *   riskPerUnitQuote  = |entryPrice - stopPrice|               (quote currency)
 *   riskPerUnitAcct   = riskPerUnitQuote * quoteToAccount      (account currency)
 *   units             = floor(riskAmount / riskPerUnitAcct)    rounded DOWN to the
 *                       instrument's tradeUnitsPrecision
 *
 * Rounding DOWN is deliberate: the realised risk can then only be below the cap,
 * never above it.
 */
export function sizePosition(args: {
  instrument: string;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  nav: number;
  accountCurrency: string;
  meta: InstrumentMeta;
  riskPerTradePct: number;
  /** mid prices keyed by instrument, for currency conversion only. */
  quotes: Record<string, Quote>;
}): SizingResult {
  const { instrument, direction, entryPrice, stopPrice, nav, accountCurrency, meta, riskPerTradePct, quotes } = args;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: "NO_ENTRY_PRICE", detail: "entry price is not a positive finite number" };
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: "NO_STOP_PRICE", detail: "stop price is not a positive finite number" };
  if (!Number.isFinite(nav) || nav <= 0) return { ok: false, reason: "NO_EQUITY", detail: "account NAV is not positive" };

  const [base, quote] = instrument.split("_");
  if (!base || !quote) return { ok: false, reason: "BAD_INSTRUMENT", detail: `instrument ${instrument} is not BASE_QUOTE` };

  const riskPerUnitQuote = Math.abs(entryPrice - stopPrice);
  if (!(riskPerUnitQuote > 0)) return { ok: false, reason: "ZERO_STOP_DISTANCE", detail: "stop equals entry, so risk per unit is zero" };

  // Quote currency → account currency.
  let quoteToAccount = 1;
  let conversion = `quote currency ${quote} is the account currency ${accountCurrency}; no conversion needed`;
  if (quote !== accountCurrency) {
    const direct = quotes[`${accountCurrency}_${quote}`];
    const inverse = quotes[`${quote}_${accountCurrency}`];
    if (direct) {
      quoteToAccount = 1 / direct.mid;
      conversion = `1 ${quote} = ${(1 / direct.mid).toFixed(8)} ${accountCurrency}, from ${accountCurrency}_${quote} mid ${direct.mid}`;
    } else if (inverse) {
      quoteToAccount = inverse.mid;
      conversion = `1 ${quote} = ${inverse.mid.toFixed(8)} ${accountCurrency}, from ${quote}_${accountCurrency} mid ${inverse.mid}`;
    } else {
      return {
        ok: false,
        reason: "NO_CONVERSION_RATE",
        detail: `account is in ${accountCurrency} and the instrument's quote currency is ${quote}; no ${accountCurrency}_${quote} or ${quote}_${accountCurrency} price is available to convert risk, so units cannot be computed honestly`,
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

  if (!Number.isFinite(floored) || floored < minUnits) {
    return {
      ok: false,
      reason: "BELOW_MINIMUM_SIZE",
      detail: `risk ${riskAmount.toFixed(2)} ${accountCurrency} over a ${riskPerUnitAccount.toFixed(8)} ${accountCurrency}/unit stop gives ${rawUnits.toFixed(4)} units, below the instrument minimum of ${String(meta.minimumTradeSize)}`,
    };
  }
  if (Number.isFinite(maxUnits) && floored > maxUnits) {
    return { ok: false, reason: "ABOVE_MAXIMUM_SIZE", detail: `computed ${floored} units exceeds the instrument maximum ${String(meta.maximumOrderUnits)}` };
  }

  const units = Number(floored.toFixed(Math.max(0, meta.tradeUnitsPrecision)));
  const riskAccountCurrency = units * riskPerUnitAccount;
  const notionalAccountCurrency = units * entryPrice * quoteToAccount;

  return {
    ok: true,
    units,
    signedUnits: direction === "long" ? units : -units,
    riskPerUnitQuote,
    quoteToAccountRate: quoteToAccount,
    conversion,
    riskAccountCurrency,
    riskPctOfNav: (riskAccountCurrency / nav) * 100,
    notionalAccountCurrency,
    rounding: `raw ${rawUnits.toFixed(4)} units floored to ${units} at tradeUnitsPrecision ${meta.tradeUnitsPrecision} (rounding down, so realised risk cannot exceed the cap)`,
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
