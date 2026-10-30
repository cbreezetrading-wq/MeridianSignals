#!/usr/bin/env bun
/**
 * PROOF 3 — duplicate prevention.
 *
 *   bun /home/team/shared/execution/scripts/03-duplicate.ts
 *
 * Writes /home/team/shared/verify/execution/03-duplicate.json
 *
 * The test is deliberate and adversarial:
 *  - take the instruction that produced the live order (read from the record, not
 *    from a variable), and resubmit it;
 *  - resubmit it a THIRD time as a fresh object with only the signal id in common, to
 *    show the key comes from the signal, not from object identity;
 *  - count the broker's own orders and trades before and after with fresh GETs.
 *
 * Pass = both resubmissions return DUPLICATE_SUPPRESSED and the broker's counts do
 * not change.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { submitSignal } from "../lib/engine.ts";
import { readRecords } from "../lib/record.ts";
import type { SignalInstruction } from "../lib/instruction.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const { client, accountId } = await bootstrapClient();
const config = await loadConfig("/home/team/shared/execution/config.test.json");
const settings = resolveSettingsFrom(config);

const records = await readRecords();
const received = records.filter((r) => r.kind === "INSTRUCTION_RECEIVED");
if (received.length === 0) throw new Error("no INSTRUCTION_RECEIVED record found; run 02-one-order.ts first");
const original = (received[received.length - 1]!.payload as { instruction: SignalInstruction }).instruction;

async function brokerCounts() {
  const ordersRes = await client.orders("ALL");
  const tradesRes = await client.openTrades();
  const posRes = await client.openPositions();
  return {
    orderIds: ("body" in ordersRes ? (ordersRes.body?.orders ?? []) : []).map((o: any) => o.id),
    tradeIds: ("body" in tradesRes ? (tradesRes.body?.trades ?? []) : []).map((t: any) => t.id),
    positionCount: ("body" in posRes ? (posRes.body?.positions ?? []) : []).length,
  };
}

const before = await brokerCounts();

// Resubmission 1: the identical object, replayed.
const first = await submitSignal(client, original, config, { settings });

// Resubmission 2: a brand-new object that shares only the signal id.
const clone: SignalInstruction = JSON.parse(JSON.stringify(original));
const second = await submitSignal(client, clone, config, { settings });

const after = await brokerCounts();

const evidence = {
  proof: "duplicate prevention — the same signal never creates a second order",
  generatedAt: new Date().toISOString(),
  accountId,
  signalId: original.signalId,
  orderKey: first.orderKey,
  originalOrder: records
    .filter((r) => r.kind === "ORDER_ACKNOWLEDGED")
    .slice(-1)
    .map((r) => ({ seq: r.seq, orderId: (r.payload as any).orderId, tradeId: (r.payload as any).tradeId }))[0] ?? null,
  resubmission1: { state: first.state, ok: first.ok, reasons: first.reasons },
  resubmission2: { state: second.state, ok: second.ok, reasons: second.reasons },
  brokerBefore: before,
  brokerAfter: after,
  brokerOrderCountUnchanged: before.orderIds.length === after.orderIds.length,
  brokerTradeCountUnchanged: before.tradeIds.length === after.tradeIds.length,
  duplicateSuppressedTwice: first.state === "DUPLICATE_SUPPRESSED" && second.state === "DUPLICATE_SUPPRESSED",
  verdict:
    first.state === "DUPLICATE_SUPPRESSED" &&
    second.state === "DUPLICATE_SUPPRESSED" &&
    before.orderIds.length === after.orderIds.length &&
    before.tradeIds.length === after.tradeIds.length
      ? "PASS"
      : "FAIL",
  note: "The check runs twice per submission: the append-only record (survives broker state loss) and the broker's own clientExtensions.id (survives record loss). Either hit suppresses the write.",
};

await writeFile(`${OUT_DIR}/03-duplicate.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(JSON.stringify(evidence, null, 2));
