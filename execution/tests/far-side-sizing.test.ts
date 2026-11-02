/**
 * Proof that the maximum-risk-per-trade defect is fixed — and that this test would have
 * caught it.
 *
 *   bun test /home/team/shared/execution/tests/far-side-sizing.test.ts
 *     → PASSES on the far-side sizing that ships now
 *
 *   SIZING_BASIS=mid bun test /home/team/shared/execution/tests/far-side-sizing.test.ts
 *     → FAILS on the old mid-based sizing, with the same assertions and the same fixtures
 *
 * The fixtures are the five real Practice fills in orders.jsonl (see fixtures.ts): the
 * broker's own fill price, the units that were submitted, and the stop the broker reports
 * as attached. Nothing here needs the market to be open, and nothing here simulates a
 * fill: the fills already happened.
 */

import { isolate } from "./isolate.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sizePosition, farSideEntryPrice, type SizingResult } from "../lib/instruction.ts";
import { computeRealisedRisk, riskAtPrice, RISK_EPSILON } from "../lib/risk.ts";
import { legacyMidBasedSizing } from "./legacyMidSizing.ts";
import { RECORDED_FILLS, capFor, realisedFor, type RecordedFill } from "./fixtures.ts";

// This file's own temporary execution directory, so it cannot touch the live
// record even when the whole tests/ directory runs in one process.
isolate();

/**
 * Which sizing is under test. The assertions below are identical either way; only the
 * implementation changes. That is what makes "fails on the old code" meaningful.
 */
const BASIS: "far" | "mid" = (process.env.SIZING_BASIS ?? "far").toLowerCase() === "mid" ? "mid" : "far";

function quotesFor(f: RecordedFill) {
  return {
    [f.instrument]: { instrument: f.instrument, bid: f.bid, ask: f.ask, mid: f.mid, tradeable: true, time: "fixture", spreadPips: 0 },
  };
}

/** The sizing that ships: the far side of the spread. */
function sizeFar(f: RecordedFill): SizingResult {
  return sizePosition({
    instrument: f.instrument,
    direction: f.direction,
    quote: { bid: f.bid, ask: f.ask, mid: f.mid },
    stopPrice: f.stopPrice,
    nav: f.nav,
    accountCurrency: "USD",
    meta: f.meta,
    riskPerTradePct: f.riskPctSetting,
    quotes: quotesFor(f),
  });
}

/** The sizing that shipped before the fix: the mid. Used only to show the test fails on it. */
function sizeMid(f: RecordedFill) {
  return legacyMidBasedSizing({
    instrument: f.instrument,
    direction: f.direction,
    entryPrice: f.mid,
    stopPrice: f.stopPrice,
    nav: f.nav,
    accountCurrency: "USD",
    meta: f.meta,
    riskPerTradePct: f.riskPctSetting,
    quotes: quotesFor(f),
  });
}

function sizeByBasis(f: RecordedFill, basis: "far" | "mid") {
  return basis === "mid" ? sizeMid(f) : sizeFar(f);
}

describe("far-side entry price", () => {
  test("a long fills at the ask and a short at the bid, never the mid", () => {
    const quote = { bid: 1.11633, ask: 1.11652, mid: 1.116425 };
    expect(farSideEntryPrice("short", quote)).toBe(1.11633);
    expect(farSideEntryPrice("long", quote)).toBe(1.11652);
    expect(farSideEntryPrice("short", quote)).not.toBe(quote.mid);
    expect(farSideEntryPrice("long", quote)).not.toBe(quote.mid);
  });
});

describe(`sizing basis under test: ${BASIS}`, () => {
  for (const f of RECORDED_FILLS) {
    test(`${f.label}: realised risk at the broker's actual fill is within the configured maximum`, () => {
      const sized = sizeByBasis(f, BASIS);
      expect(sized.ok).toBe(true);
      if (!sized.ok) return;

      const cap = capFor(f);
      const realised = realisedFor(f, sized.units);

      // The whole point: the loss if the attached stop is hit must not exceed the maximum.
      expect(realised).toBeLessThanOrEqual(cap + RISK_EPSILON);
      // And it must not exceed the budget the size was derived to risk, either.
      expect(realised).toBeLessThanOrEqual(sized.riskAccountCurrency + RISK_EPSILON);
    });
  }
});

describe("the old mid-based sizing breaches the cap (the defect, reproduced)", () => {
  for (const f of RECORDED_FILLS) {
    test(`${f.label}: mid-based sizing risks more than the maximum`, () => {
      const sized = sizeMid(f);
      expect(sized.ok).toBe(true);
      if (!sized.ok) return;
      const realised = realisedFor(f, sized.units);
      expect(realised).toBeGreaterThan(capFor(f));
    });
  }

  test("mid-based sizing reproduces the units actually submitted, so the fixtures are the real inputs", () => {
    for (const f of RECORDED_FILLS) {
      const sized = sizeMid(f);
      expect(sized.ok).toBe(true);
      if (!sized.ok) continue;
      expect(sized.units).toBe(f.unitsAsSubmitted);
    }
  });
});

describe("the two trades named in the brief", () => {
  const t33 = RECORDED_FILLS.find((f) => f.tradeId === "33")!;
  const t43 = RECORDED_FILLS.find((f) => f.tradeId === "43")!;

  test("trade 33: budgeted 249.84, realised 258.65 under mid sizing; far-side sizing keeps it under the cap", () => {
    const old = sizeMid(t33);
    const fixed = sizeFar(t33);
    expect(old.ok && fixed.ok).toBe(true);
    if (!old.ok || !fixed.ok) return;

    const oldRealised = realisedFor(t33, old.units);
    const newRealised = realisedFor(t33, fixed.units);

    expect(old.units).toBe(92706);
    expect(Number(oldRealised.toFixed(2))).toBe(258.65);
    expect(oldRealised).toBeGreaterThan(capFor(t33));

    expect(fixed.units).toBeLessThan(old.units);
    expect(newRealised).toBeLessThanOrEqual(capFor(t33) + RISK_EPSILON);
    expect(Number(newRealised.toFixed(2))).toBe(249.84);
  });

  test("trade 43: realised 268.21 under mid sizing; far-side sizing keeps it under the cap", () => {
    const old = sizeMid(t43);
    const fixed = sizeFar(t43);
    expect(old.ok && fixed.ok).toBe(true);
    if (!old.ok || !fixed.ok) return;

    const oldRealised = realisedFor(t43, old.units);
    const newRealised = realisedFor(t43, fixed.units);

    expect(old.units).toBe(131474);
    expect(Number(oldRealised.toFixed(2))).toBe(268.21);
    expect(oldRealised).toBeGreaterThan(capFor(t43));

    expect(fixed.units).toBeLessThan(old.units);
    expect(newRealised).toBeLessThanOrEqual(capFor(t43) + RISK_EPSILON);
    expect(Number(newRealised.toFixed(2))).toBe(249.8);
  });
});

describe("the pre-submit re-check refuses before the order is sent", () => {
  const t33 = RECORDED_FILLS.find((f) => f.tradeId === "33")!;
  const fixed = sizeFar(t33);

  test("at the far-side price it sized on, the approved units are within the cap", () => {
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const risk = riskAtPrice({ units: fixed.units, entryPrice: fixed.entryPriceFar, stopPrice: t33.stopPrice, quoteToAccountRate: 1 });
    expect(risk).toBeLessThanOrEqual(capFor(t33) + RISK_EPSILON);
  });

  test("one pip against the entry after sizing, the same units would breach — which is what the re-check refuses on", () => {
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    // A short fills at the bid, so "against" means the bid has fallen by a pip.
    const movedBid = fixed.entryPriceFar - 0.0001;
    const risk = riskAtPrice({ units: fixed.units, entryPrice: movedBid, stopPrice: t33.stopPrice, quoteToAccountRate: 1 });
    expect(risk).toBeGreaterThan(capFor(t33));
  });
});

describe("after the fill, a worse-than-far-side fill is measured and flagged", () => {
  const t33 = RECORDED_FILLS.find((f) => f.tradeId === "33")!;
  const fixed = sizeFar(t33);

  test("a fill at the far side is within the cap", () => {
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const m = computeRealisedRisk({
      instrument: t33.instrument,
      direction: t33.direction,
      units: fixed.units,
      fillPrice: t33.brokerFillPrice,
      stopPrice: t33.stopPrice,
      quoteToAccountRate: 1,
      nav: t33.nav,
      budgetedRiskAccountCurrency: fixed.riskAccountCurrency,
      capAccountCurrency: capFor(t33),
      capPctOfNav: t33.riskPctSetting,
    });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.breachOfCap).toBe(false);
    expect(m.realisedRiskAccountCurrency).toBeLessThanOrEqual(capFor(t33) + RISK_EPSILON);
  });

  test("0.2 pips of slippage beyond the far side is detected as a breach, with both figures recorded", () => {
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const slippedFill = t33.brokerFillPrice - 0.00002; // short: a worse fill is lower
    const m = computeRealisedRisk({
      instrument: t33.instrument,
      direction: t33.direction,
      units: fixed.units,
      fillPrice: slippedFill,
      stopPrice: t33.stopPrice,
      quoteToAccountRate: 1,
      nav: t33.nav,
      budgetedRiskAccountCurrency: fixed.riskAccountCurrency,
      capAccountCurrency: capFor(t33),
      capPctOfNav: t33.riskPctSetting,
    });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.breachOfCap).toBe(true);
    expect(m.budgetedRiskAccountCurrency).not.toBeNull();
    expect(m.realisedRiskAccountCurrency).toBeGreaterThan(Number(m.budgetedRiskAccountCurrency));
    expect(Number(m.breachAmountAccountCurrency)).toBeGreaterThan(0);
  });
});

describe("the engine cannot silently go back to sizing on the mid", () => {
  const engine = readFileSync(new URL("../lib/engine.ts", import.meta.url), "utf8");

  test("the sizePosition call in the order path passes the quote, not quote.mid", () => {
    const start = engine.indexOf("sizing = sizePosition({");
    const end = engine.indexOf("if (!sizing.ok)");
    expect(start).toBeGreaterThan(0);
    const call = engine.slice(start, end);
    expect(call).toContain("quote,");
    expect(call).not.toContain("entryPrice: quote.mid");
    expect(call).not.toContain("entryPrice:");
  });

  test("the order path re-checks the risk before submitting and records realised risk after the fill", () => {
    expect(engine).toContain("recheckRiskBeforeSubmit(");
    expect(engine).toContain("recordRealisedRisk(");
    expect(engine.indexOf("await recheckRiskBeforeSubmit(")).toBeLessThan(engine.indexOf("await client.createOrder("));
  });
});
