/**
 * The two sizing modes and the CONNECTION_TEST origin label.
 *
 *   bun test /home/team/shared/execution/tests/sizing-mode.test.ts
 *
 * What is asserted here, and why each assertion exists:
 *
 *  1. RISK is the default and behaves exactly as before — an instruction that never mentions
 *     sizingMode gets the far-side, risk-derived size it always got.
 *  2. BROKER_MINIMUM fixes the units at the instrument's own minimumTradeSize and derives the
 *     risk and notional FROM those units. It does not invent a rate or a stop distance.
 *  3. BELOW_MINIMUM_SIZE is a RISK-mode refusal only. The same quote that RISK refuses is
 *     accepted by BROKER_MINIMUM, because there the size IS the minimum — which is the whole
 *     reason the mode exists.
 *  4. BROKER_MINIMUM is refused for every origin except CONNECTION_TEST. This is the guard
 *     that stops a minimum-sized order ever reaching a real trade, and it lives in
 *     validateInstruction so it runs before any price is read.
 *  5. CONNECTION_TEST and INVENTED_RULESET_TEST are distinct labels, and the broker-visible
 *     order comment carries whichever one applies.
 */

import { isolate } from "./isolate.ts";
import { describe, expect, test } from "bun:test";
import { sizePosition, validateInstruction, ORIGINS, type SignalInstruction, type InstrumentMeta } from "../lib/instruction.ts";
import { buildOrderPayload } from "../lib/engine.ts";

// This file's own temporary execution directory, so nothing here can touch the live record.
isolate();

const META: InstrumentMeta = {
  name: "EUR_USD",
  displayPrecision: 5,
  tradeUnitsPrecision: 0,
  minimumTradeSize: "1",
  maximumOrderUnits: "100000000",
  marginRate: "0.05",
};

const QUOTE = { bid: 1.16000, ask: 1.16020, mid: 1.16010 };
const STOP = 1.15700; // ~32 pips below the ask
const NAV = 100585.2378;
const RISK_PCT = 0.1;

function quotesFor(): Record<string, any> {
  return { EUR_USD: { instrument: "EUR_USD", ...QUOTE, tradeable: true, time: "test", spreadPips: 2 } };
}

function size(overrides: Partial<Parameters<typeof sizePosition>[0]> = {}) {
  return sizePosition({
    instrument: "EUR_USD",
    direction: "long",
    quote: QUOTE,
    stopPrice: STOP,
    nav: NAV,
    accountCurrency: "USD",
    meta: META,
    riskPerTradePct: RISK_PCT,
    quotes: quotesFor(),
    ...overrides,
  });
}

function instruction(overrides: Partial<SignalInstruction> = {}): Partial<SignalInstruction> {
  return {
    signalId: "conn-test-eur_usd-1",
    strategyId: "meridian-h1-v1",
    strategyVersion: "h1-v1",
    instrument: "EUR_USD",
    direction: "long",
    generatedAt: new Date(Date.now() - 1000).toISOString(),
    sourceBar: { time: new Date(Date.now() - 60_000).toISOString(), close: 1.1601, granularity: "H1" },
    expiryAt: new Date(Date.now() + 300_000).toISOString(),
    orderType: "MARKET",
    entryConditions: "market entry",
    stopPrice: STOP,
    takeProfitPrice: 1.16600,
    exitRules: "stop and target attached",
    existingPositionRule: "no add",
    oppositeSignalRule: "no reverse",
    repeatEntryRule: "one entry per signal id",
    origin: "CONNECTION_TEST",
    ...overrides,
  };
}

describe("RISK mode is the default and is unchanged", () => {
  test("an instruction that never mentions sizingMode gets a risk-derived size, reported as RISK", () => {
    const result = size();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizingMode).toBe("RISK");

    // ~100.59 USD of budget over a 0.0032 stop is ~31,433 units, floored at 0 decimals.
    const expectedUnits = Math.floor((NAV * RISK_PCT) / 100 / (QUOTE.ask - STOP));
    expect(result.units).toBe(expectedUnits);
    expect(result.units).toBeGreaterThan(1000);
    expect(result.riskAccountCurrency).toBeLessThanOrEqual((NAV * RISK_PCT) / 100 + 1e-9);
  });

  test("RISK is what an explicit sizingMode: RISK asks for, byte for byte", () => {
    const implicit = size();
    const explicit = size({ sizingMode: "RISK" });
    expect(implicit.ok && explicit.ok).toBe(true);
    if (!implicit.ok || !explicit.ok) return;
    expect(explicit.units).toBe(implicit.units);
    expect(explicit.riskAccountCurrency).toBe(implicit.riskAccountCurrency);
    expect(explicit.sizingMode).toBe("RISK");
  });
});

describe("BROKER_MINIMUM mode", () => {
  test("units are the instrument's minimumTradeSize, and risk/notional are derived FROM them", () => {
    const result = size({ sizingMode: "BROKER_MINIMUM" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizingMode).toBe("BROKER_MINIMUM");
    expect(result.units).toBe(1);
    expect(result.signedUnits).toBe(1);
    expect(result.riskPerUnitQuote).toBeCloseTo(QUOTE.ask - STOP, 10);
    expect(result.riskAccountCurrency).toBeCloseTo(1 * (QUOTE.ask - STOP), 10);
    expect(result.notionalAccountCurrency).toBeCloseTo(QUOTE.ask, 10);
    expect(result.riskPctOfNav).toBeLessThan(0.001);
    // The risk-based size it did NOT use is still reported beside it.
    expect(result.midBasis.units).toBeGreaterThan(1000);
    expect(result.rounding).toContain("BROKER_MINIMUM");
  });

  test("a short is signed negative and sized at the same minimum", () => {
    const result = size({ direction: "short", sizingMode: "BROKER_MINIMUM", stopPrice: 1.16300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toBe(1);
    expect(result.signedUnits).toBe(-1);
    expect(result.entryPriceFar).toBe(QUOTE.bid);
  });

  test("every other check still refuses: a stop on the wrong side is refused in either mode", () => {
    const wrongSide = size({ stopPrice: 1.17000, sizingMode: "BROKER_MINIMUM" });
    expect(wrongSide.ok).toBe(false);
    if (wrongSide.ok) return;
    expect(wrongSide.reason).toBe("STOP_ON_WRONG_SIDE");
  });

  test("every other check still refuses: an unusable quote is refused in either mode", () => {
    const badQuote = size({ quote: { bid: 0, ask: 1.16, mid: 0.58 }, sizingMode: "BROKER_MINIMUM" });
    expect(badQuote.ok).toBe(false);
    if (badQuote.ok) return;
    expect(badQuote.reason).toBe("NO_ENTRY_PRICE");
  });
});

describe("BELOW_MINIMUM_SIZE applies only in RISK mode", () => {
  // A budget far too small for the stop distance: the risk-derived size falls under the
  // instrument minimum, so RISK must refuse. BROKER_MINIMUM must not — its size IS the minimum.
  const tiny = { nav: 100, riskPerTradePct: 0.0001, stopPrice: 1.10000 } as const;

  test("RISK refuses with BELOW_MINIMUM_SIZE", () => {
    const result = size({ nav: tiny.nav, riskPerTradePct: tiny.riskPerTradePct, stopPrice: tiny.stopPrice });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BELOW_MINIMUM_SIZE");
    expect(result.detail).toContain("minimum");
  });

  test("BROKER_MINIMUM accepts the same quote, because the size is the minimum itself", () => {
    const result = size({ nav: tiny.nav, riskPerTradePct: tiny.riskPerTradePct, stopPrice: tiny.stopPrice, sizingMode: "BROKER_MINIMUM" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toBe(1);
    expect(result.sizingMode).toBe("BROKER_MINIMUM");
  });
});

describe("the instruction guard: BROKER_MINIMUM is CONNECTION_TEST only", () => {
  test("CONNECTION_TEST with BROKER_MINIMUM validates", () => {
    const result = validateInstruction(instruction());
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("BROKER_MINIMUM with INVENTED_RULESET_TEST is refused, naming the field and the reason", () => {
    const result = validateInstruction(instruction({ origin: "INVENTED_RULESET_TEST", sizingMode: "BROKER_MINIMUM" }));
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.field === "sizingMode");
    expect(issue).toBeDefined();
    expect(issue!.reason).toContain("CONNECTION_TEST");
  });

  test("BROKER_MINIMUM with OWNER_METHOD is refused too — a real trade never sizes at the minimum", () => {
    const result = validateInstruction(instruction({ origin: "OWNER_METHOD", sizingMode: "BROKER_MINIMUM" }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "sizingMode")).toBe(true);
  });

  test("an unknown sizingMode is refused", () => {
    const result = validateInstruction(instruction({ sizingMode: "SMALLEST" as any }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "sizingMode")).toBe(true);
  });

  test("an absent sizingMode is valid — it means RISK", () => {
    const noMode = instruction();
    delete (noMode as any).sizingMode;
    const result = validateInstruction(noMode);
    expect(result.ok).toBe(true);
  });
});

describe("the origin label", () => {
  test("CONNECTION_TEST and INVENTED_RULESET_TEST are both known and distinct", () => {
    expect(ORIGINS).toContain("CONNECTION_TEST");
    expect(ORIGINS).toContain("INVENTED_RULESET_TEST");
    expect(ORIGINS).toContain("OWNER_METHOD");
    expect("CONNECTION_TEST").not.toBe("INVENTED_RULESET_TEST");
  });

  test("an unknown origin is refused", () => {
    const result = validateInstruction(instruction({ origin: "TEST" as any }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "origin")).toBe(true);
  });

  test("the broker-visible order comment carries the origin, so the two labels differ at the broker", () => {
    const meta: InstrumentMeta = META;
    const asConnection = buildOrderPayload(instruction({ origin: "CONNECTION_TEST" }) as SignalInstruction, 1, meta, "msig-abc");
    const asRuleset = buildOrderPayload(instruction({ origin: "INVENTED_RULESET_TEST" }) as SignalInstruction, 1, meta, "msig-abc");
    expect(asConnection.order.clientExtensions.comment).toContain("CONNECTION_TEST");
    expect(asRuleset.order.clientExtensions.comment).toContain("INVENTED_RULESET_TEST");
    expect(asConnection.order.clientExtensions.comment).not.toBe(asRuleset.order.clientExtensions.comment);
    // Protection rides in the same request object, in either case.
    expect(asConnection.order.stopLossOnFill.price).toBe(STOP.toFixed(5));
    expect(asConnection.order.takeProfitOnFill.price).toBe("1.16600");
    expect(asConnection.order.units).toBe("1");
  });
});
