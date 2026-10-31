#!/usr/bin/env bun
/**
 * PROOF 9 — realised risk against the budget and the cap, for every recorded fill.
 *
 *   bun /home/team/shared/execution/scripts/09-realised-risk.ts --report
 *       Recomputes, from the append-only record only, what each filled trade actually
 *       risked: units × |broker fill price − the stop the broker has attached|, compared
 *       with the budget it was sized to and the configured maximum. Writes
 *       /home/team/shared/verify/execution/09-realised-risk-report.json. No network, no
 *       appends, so it can be run with FX closed.
 *
 *   bun /home/team/shared/execution/scripts/09-realised-risk.ts --backfill
 *       Appends a REALISED_RISK record for every historical fill that does not already
 *       have one, labelled postHoc so it can never be mistaken for a live measurement.
 *       Nothing existing is edited or rewritten: orders.jsonl is append-only.
 *
 * WHY A BACKFILL AT ALL: the engine now writes REALISED_RISK at the moment it confirms a
 * fill, but the five fills that exposed the defect were made before that code existed. Their
 * realised risk is real and already recorded in the record's own fields; appending it as a
 * new record puts it next to the budgeted figure where it belongs, without touching a line
 * of history.
 *
 * PENDING MARKET OPEN: nothing in this script needs the market. What it cannot do is obtain
 * a fresh live fill with the fixed code — FX is closed (Fri 21:00 UTC → Sun 21:00 UTC), so
 * the post-fix live re-run is pending, not claimed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { replay } from "../lib/record.ts";
import { computeRealisedRisk, appendRealisedRisk } from "../lib/risk.ts";
import type { Direction } from "../lib/instruction.ts";

const MODE = process.argv.includes("--backfill") ? "backfill" : "report";
const OUT_DIR = "/home/team/shared/verify/execution";

type Recovered = {
  orderKey: string;
  tradeId: string | null;
  instrument: string;
  direction: Direction;
  units: number;
  fillPrice: number;
  fillPriceSource: string;
  stopPrice: number;
  nav: number | null;
  riskPct: number;
  capAccountCurrency: number | null;
  budgetedRiskAccountCurrency: number | null;
  budgetSource: string;
  quoteToAccountRate: number | null;
  conversionSource: string;
  signalId: string | null;
  origin: string | null;
  alreadyRecorded: boolean;
};

const { all } = await replay();

// ---- recover one row per order key that has a fill and an attached stop
const byKey = new Map<string, typeof all>();
for (const r of all) {
  if (!r.orderKey) continue;
  if (!byKey.has(r.orderKey)) byKey.set(r.orderKey, []);
  byKey.get(r.orderKey)!.push(r);
}

const rows: Recovered[] = [];
for (const [orderKey, recs] of byKey) {
  let proposal: any = null;
  let fill: { price: number; units: number; source: string } | null = null;
  let trade: any = null;
  let signalId: string | null = null;
  let origin: string | null = null;
  let alreadyRecorded = false;

  for (const r of recs) {
    const p = (r.payload ?? {}) as any;
    if (r.signalId) signalId = r.signalId;
    if (p?.proposal) proposal = p.proposal;
    if (p?.origin) origin = p.origin;
    if ((r.kind === "FILL" || r.kind === "PARTIAL_FILL") && p?.price !== undefined) {
      fill = { price: Number(p.price), units: Number(p.units), source: "FILL record (broker orderFillTransaction price)" };
    }
    if (r.kind === "PROTECTED" && p?.trade) {
      trade = p.trade;
      if (!fill && p.trade.price !== undefined && p.trade.currentUnits !== undefined) {
        fill = {
          price: Number(p.trade.price),
          units: Number(p.trade.currentUnits),
          source: "PROTECTED trade read-back (no FILL record: the order response was lost)",
        };
      }
    }
    if (r.kind === "REALISED_RISK" && p?.tradeId !== undefined && p?.measured !== false) alreadyRecorded = true;
  }

  const attachedStop = Number(trade?.stopLossOrder?.price);
  if (!fill || !Number.isFinite(attachedStop) || attachedStop <= 0) continue;

  // The last recorded NAV before the fill, used when a proposal is missing or predates the
  // cap field.
  let nav: number | null = null;
  const fillSeq = recs.find((r) => r.kind === "FILL")?.seq ?? recs[0]!.seq;
  for (const r of all) {
    if (r.kind === "ACCOUNT_READ" && r.seq <= fillSeq) {
      const n = Number((r.payload as any)?.nav);
      if (Number.isFinite(n)) nav = n;
    }
  }

  const riskPct = Number(proposal?.riskPctSetting ?? 0.25);
  const equity = Number(proposal?.equity);
  const navUsed = Number.isFinite(equity) ? equity : nav;
  const cap = Number(proposal?.riskCapAccountCurrency);
  const budget = Number(proposal?.riskAccountCurrency);
  const instrument = String(trade?.instrument ?? proposal?.instrument ?? "");
  const quoteCcy = instrument.split("_")[1] ?? "";
  const accountCcy = String(proposal?.accountCurrency ?? "USD");
  const rate = Number(proposal?.quoteToAccountRate);

  rows.push({
    orderKey,
    tradeId: trade?.id !== undefined ? String(trade.id) : null,
    instrument,
    direction: String(proposal?.direction ?? (fill.units > 0 ? "long" : "short")) as Direction,
    units: Math.abs(fill.units),
    fillPrice: fill.price,
    fillPriceSource: fill.source,
    stopPrice: attachedStop,
    nav: navUsed ?? null,
    riskPct,
    capAccountCurrency: Number.isFinite(cap) ? cap : navUsed !== null ? (navUsed * riskPct) / 100 : null,
    budgetedRiskAccountCurrency: Number.isFinite(budget) ? budget : navUsed !== null ? (navUsed * riskPct) / 100 : null,
    budgetSource: Number.isFinite(budget)
      ? "recorded in the proposal (riskAccountCurrency, mid-basis sizing)"
      : "derived: riskPct × the last recorded NAV before the fill (no proposal was recorded)",
    quoteToAccountRate: Number.isFinite(rate) && rate > 0 ? rate : quoteCcy === accountCcy ? 1 : null,
    conversionSource: Number.isFinite(rate) && rate > 0 ? "the rate the size was derived with" : quoteCcy === accountCcy ? `quote currency ${quoteCcy} is the account currency` : "no rate available",
    signalId,
    origin,
    alreadyRecorded,
  });
}

rows.sort((a, b) => Number(a.tradeId ?? 0) - Number(b.tradeId ?? 0));

const results = rows.map((r) => {
  const m = computeRealisedRisk({
    instrument: r.instrument,
    direction: r.direction,
    units: r.units,
    fillPrice: r.fillPrice,
    fillPriceSource: r.fillPriceSource,
    stopPrice: r.stopPrice,
    stopPriceSource: "BROKER_ATTACHED_STOP",
    quoteToAccountRate: r.quoteToAccountRate ?? NaN,
    conversionSource: r.conversionSource,
    nav: r.nav,
    budgetedRiskAccountCurrency: r.budgetedRiskAccountCurrency,
    capAccountCurrency: r.capAccountCurrency,
    capPctOfNav: r.riskPct,
  });
  return { row: r, measurement: m };
});

// ---- print
const head =
  "trade  instrument dir    units    fill     stop    budget  realised    over$   over%  cap     breach";
console.log(head);
console.log("-".repeat(head.length));
for (const { row, measurement } of results) {
  if (!measurement.ok) {
    console.log(`${row.tradeId ?? "?"} ${row.instrument} — UNMEASURED (${measurement.reason}): ${measurement.detail}`);
    continue;
  }
  const m = measurement;
  console.log(
    [
      String(row.tradeId ?? "?").padStart(5),
      row.instrument.padEnd(9),
      row.direction.padEnd(5),
      String(row.units).padStart(8),
      row.fillPrice.toFixed(5).padStart(8),
      row.stopPrice.toFixed(5).padStart(8),
      (m.budgetedRiskAccountCurrency?.toFixed(2) ?? "?").padStart(8),
      m.realisedRiskAccountCurrency.toFixed(2).padStart(9),
      (m.overBudgetAccountCurrency?.toFixed(2) ?? "?").padStart(8),
      ((m.overBudgetPct ?? 0).toFixed(2) + "%").padStart(7),
      (m.capAccountCurrency?.toFixed(2) ?? "?").padStart(7),
      m.breachOfCap ? "BREACH" : "within",
    ].join(" "),
  );
}

const breaches = results.filter((r) => r.measurement.ok && r.measurement.breachOfCap);
const totalRealised = results.reduce((s, r) => s + (r.measurement.ok ? r.measurement.realisedRiskAccountCurrency : 0), 0);
const totalBudget = results.reduce((s, r) => s + (r.measurement.ok ? r.measurement.budgetedRiskAccountCurrency ?? 0 : 0), 0);
console.log(`\nfills measured: ${results.length}   over the configured maximum: ${breaches.length}`);
console.log(`total realised risk: ${totalRealised.toFixed(2)} vs total budgeted ${totalBudget.toFixed(2)}`);

await mkdir(OUT_DIR, { recursive: true });
const outPath = `${OUT_DIR}/09-realised-risk-report.json`;
await writeFile(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: MODE,
      source: "scripts/09-realised-risk.ts — recomputed from /home/team/shared/execution/orders.jsonl",
      what: "realised risk at the broker's fill vs the budget it was sized to and the configured maximum per trade",
      method:
        "realised = |broker fill price − the stop the broker reports attached| × units × quote→account rate; budget = riskAccountCurrency from the proposal where one was recorded",
      caveats: [
        "These five fills were made by the OLD, mid-based sizing. The record therefore shows the defect; it does not show the fix working live.",
        "The post-fix live re-run is PENDING MARKET OPEN: FX is closed (Fri 21:00 UTC → Sun 21:00 UTC) and no fresh fill can be obtained until it reopens.",
        "Swap, commission and slippage beyond the fill are excluded, exactly as they were in the budget.",
      ],
      results: results.map(({ row, measurement }) => ({ ...row, measurement })),
      summary: {
        fills: results.length,
        breaches: breaches.length,
        totalRealisedRisk: Number(totalRealised.toFixed(4)),
        totalBudgetedRisk: Number(totalBudget.toFixed(4)),
        liveRerun: "PENDING MARKET OPEN",
      },
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\nwrote ${outPath}`);

if (MODE === "backfill") {
  let appended = 0;
  for (const { row, measurement } of results) {
    if (!measurement.ok) continue;
    if (row.alreadyRecorded) {
      console.log(`trade ${row.tradeId}: already has a REALISED_RISK record — not appended again`);
      continue;
    }
    await appendRealisedRisk({
      measurement,
      orderKey: row.orderKey,
      signalId: row.signalId,
      tradeId: row.tradeId,
      origin: row.origin,
      source: `BACKFILL_FROM_RECORD (postHoc: true) — this fill happened before the engine recorded realised risk; recomputed from the record's own broker fill price and attached stop`,
    });
    appended += 1;
    console.log(`trade ${row.tradeId}: appended REALISED_RISK (${measurement.breachOfCap ? "RISK_BREACH" : "WITHIN_CAP"})`);
  }
  console.log(`\nappended ${appended} record(s); nothing existing was edited`);
}
