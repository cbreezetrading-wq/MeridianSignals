/**
 * THE OLD, DEFECTIVE SIZING — preserved deliberately, as the regression baseline.
 *
 * This is a faithful copy of `sizePosition` as it stood before the far-side fix: it sizes
 * from the MID price. It is NOT used by the engine and must never be used by it. It exists
 * so the test in far-side-sizing.test.ts can be run against the old behaviour and be seen
 * to FAIL, which is what shows the test is sensitive to the defect rather than merely
 * asserting whatever the current code happens to do.
 *
 * Keep it unchanged. If the far-side sizing changes, this copy must NOT follow it.
 */

import type { Direction, InstrumentMeta, Quote } from "../lib/instruction.ts";

export type LegacySizing =
  | { ok: true; units: number; signedUnits: number; riskPerUnitQuote: number; quoteToAccountRate: number; riskAccountCurrency: number }
  | { ok: false; reason: string; detail: string };

export function legacyMidBasedSizing(args: {
  instrument: string;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  nav: number;
  accountCurrency: string;
  meta: InstrumentMeta;
  riskPerTradePct: number;
  quotes: Record<string, Quote>;
}): LegacySizing {
  const { instrument, direction, entryPrice, stopPrice, nav, accountCurrency, meta, riskPerTradePct, quotes } = args;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: "NO_ENTRY_PRICE", detail: "entry price is not a positive finite number" };
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: "NO_STOP_PRICE", detail: "stop price is not a positive finite number" };
  if (!Number.isFinite(nav) || nav <= 0) return { ok: false, reason: "NO_EQUITY", detail: "account NAV is not positive" };

  const [base, quote] = instrument.split("_");
  if (!base || !quote) return { ok: false, reason: "BAD_INSTRUMENT", detail: `instrument ${instrument} is not BASE_QUOTE` };

  const riskPerUnitQuote = Math.abs(entryPrice - stopPrice);
  if (!(riskPerUnitQuote > 0)) return { ok: false, reason: "ZERO_STOP_DISTANCE", detail: "stop equals entry, so risk per unit is zero" };

  let quoteToAccount = 1;
  if (quote !== accountCurrency) {
    const direct = quotes[`${accountCurrency}_${quote}`];
    const inverse = quotes[`${quote}_${accountCurrency}`];
    if (direct) quoteToAccount = 1 / direct.mid;
    else if (inverse) quoteToAccount = inverse.mid;
    else return { ok: false, reason: "NO_CONVERSION_RATE", detail: `no rate for ${quote} → ${accountCurrency}` };
  }

  const riskPerUnitAccount = riskPerUnitQuote * quoteToAccount;
  const riskAmount = (nav * riskPerTradePct) / 100;
  const rawUnits = riskAmount / riskPerUnitAccount;

  const step = Math.pow(10, -Math.max(0, meta.tradeUnitsPrecision));
  const floored = Math.floor(rawUnits / step) * step;
  const minUnits = Number(meta.minimumTradeSize);
  const maxUnits = Number(meta.maximumOrderUnits);

  if (!Number.isFinite(floored) || floored < minUnits) return { ok: false, reason: "BELOW_MINIMUM_SIZE", detail: "below the instrument minimum" };
  if (Number.isFinite(maxUnits) && floored > maxUnits) return { ok: false, reason: "ABOVE_MAXIMUM_SIZE", detail: "above the instrument maximum" };

  const units = Number(floored.toFixed(Math.max(0, meta.tradeUnitsPrecision)));
  return {
    ok: true,
    units,
    signedUnits: direction === "long" ? units : -units,
    riskPerUnitQuote,
    quoteToAccountRate: quoteToAccount,
    riskAccountCurrency: units * riskPerUnitAccount,
  };
}
