#!/usr/bin/env bun
/**
 * PROOF 6 — pausing blocks new entries and leaves the attached stop exactly as it was.
 *
 *   bun /home/team/shared/execution/scripts/06-pause-keeps-stops.ts
 *
 * Writes /home/team/shared/verify/execution/06-pause-keeps-stops.json
 *
 * Three things are measured, not asserted:
 *  1. the broker's own view of the open trade — stop order id, stop price, target
 *     order id, target price — read immediately BEFORE the pause;
 *  2. the same read immediately AFTER the pause;
 *  3. an attempt to submit a fresh signal while paused, which must be refused with
 *     state PAUSED and must not reach the broker (order count before/after).
 *
 * Pass = the stop and target are byte-identical across the pause, no broker order was
 * created or cancelled by the pause, and the new signal was refused.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { pauseEntries, resumeEntries } from "../lib/ops.ts";
import { submitSignal, isManaged } from "../lib/engine.ts";
import { buildConnectionVerificationInstruction } from "../lib/testInstruction.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const { client, accountId } = await bootstrapClient();

async function readProtection() {
  const res = await client.openTrades();
  const trades = ("body" in res ? (res.body?.trades ?? []) : []) as any[];
  const ordersRes = await client.orders("ALL");
  const orders = ("body" in ordersRes ? (ordersRes.body?.orders ?? []) : []) as any[];
  return {
    readAt: new Date().toISOString(),
    managedTrades: trades
      .filter((t) => isManaged(t))
      .map((t) => ({
        tradeId: String(t.id),
        instrument: t.instrument,
        currentUnits: t.currentUnits,
        stopLossOrder: t.stopLossOrder
          ? { id: String(t.stopLossOrder.id), price: t.stopLossOrder.price, state: t.stopLossOrder.state, timeInForce: t.stopLossOrder.timeInForce }
          : null,
        takeProfitOrder: t.takeProfitOrder
          ? { id: String(t.takeProfitOrder.id), price: t.takeProfitOrder.price, state: t.takeProfitOrder.state, timeInForce: t.takeProfitOrder.timeInForce }
          : null,
      })),
    allOrderIds: orders.map((o) => String(o.id)).sort(),
  };
}

const before = await readProtection();
if (before.managedTrades.length === 0) throw new Error("no Meridian-managed open trade to test the pause against; run 02-one-order.ts first");

const pause = await pauseEntries("verification: pause-keeps-stops test");

const after = await readProtection();

// A fresh signal while paused must be refused before it can reach the broker.
const config = await loadConfig("/home/team/shared/execution/config.test.json");
const settings = resolveSettingsFrom(config);
const built = await buildConnectionVerificationInstruction({
  instrument: "GBP_USD",
  signalId: `pause-test-${Date.now()}`,
  expirySeconds: Number(settings.values.signalExpirySeconds.value),
  displayPrecision: 5,
});
const pausedSubmit = await submitSignal(client, built.instruction, config, { settings });

const afterSubmit = await readProtection();

const sameStops = JSON.stringify(before.managedTrades.map((t) => [t.tradeId, t.stopLossOrder?.id, t.stopLossOrder?.price, t.takeProfitOrder?.id, t.takeProfitOrder?.price])) ===
  JSON.stringify(after.managedTrades.map((t) => [t.tradeId, t.stopLossOrder?.id, t.stopLossOrder?.price, t.takeProfitOrder?.id, t.takeProfitOrder?.price]));

const ordersUnchanged = JSON.stringify(before.allOrderIds) === JSON.stringify(after.allOrderIds) && JSON.stringify(after.allOrderIds) === JSON.stringify(afterSubmit.allOrderIds);

// Leave the engine running again so the rest of the verification can proceed.
const resumed = await resumeEntries("verification: pause test complete");

const evidence = {
  proof: "pause blocks new entries and does not touch existing protective stops",
  generatedAt: new Date().toISOString(),
  accountId,
  pause,
  resumed,
  before,
  after,
  pausedSubmit: { state: pausedSubmit.state, ok: pausedSubmit.ok, reasons: pausedSubmit.reasons },
  afterPausedSubmit: afterSubmit,
  checks: {
    stopsIdenticalAcrossPause: sameStops,
    brokerOrderSetUnchanged: ordersUnchanged,
    newEntryRefused: pausedSubmit.state === "PAUSED",
    noOrderReachedBroker: JSON.stringify(after.allOrderIds) === JSON.stringify(afterSubmit.allOrderIds),
  },
  verdict: sameStops && ordersUnchanged && pausedSubmit.state === "PAUSED" ? "PASS" : "FAIL",
};

await writeFile(`${OUT_DIR}/06-pause-keeps-stops.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(JSON.stringify({ verdict: evidence.verdict, checks: evidence.checks, pausedSubmit: evidence.pausedSubmit, before: before.managedTrades, after: after.managedTrades }, null, 2));
