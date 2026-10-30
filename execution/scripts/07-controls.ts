#!/usr/bin/env bun
/**
 * PROOF 6b — the three stop controls, each as a separate operation.
 *
 *   bun /home/team/shared/execution/scripts/07-controls.ts
 *
 * Writes /home/team/shared/verify/execution/07-controls.json
 *
 * Control 1 (pause) is proven separately in 06-pause-keeps-stops.ts. This script
 * proves controls 2 and 3:
 *
 *  - Control 2, cancel pending entry orders. A pending order has to exist to be
 *    cancelled, so the harness places one Meridian-tagged LIMIT order far from the
 *    market as a FIXTURE (labelled as such below), then asks the control to cancel
 *    pending orders and confirms with a fresh broker read that it is gone.
 *  - Control 3, close Meridian-managed positions. Every managed open trade is closed
 *    and the broker's realised P/L for each close is recorded. Manual trades are
 *    listed and left alone.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { cancelPendingOrders, closeManagedPositions } from "../lib/ops.ts";
import { MERIDIAN_TAG, isManaged } from "../lib/engine.ts";
import { appendRecord } from "../lib/record.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const { client, accountId } = await bootstrapClient();

/* ---- fixture for control 2: one Meridian-tagged pending LIMIT order ---------- */
const quotes = await client.pricing(["EUR_USD"]);
const px: any = "body" in quotes ? (quotes.body?.prices ?? [])[0] : null;
const mid = (Number(px?.bids?.[0]?.price) + Number(px?.asks?.[0]?.price)) / 2;
const fixturePrice = (mid - 0.05).toFixed(5); // 500 pips below market: will not fill
const fixtureKey = `msig-fixture-${Date.now()}`;
const fixture = await client.createOrder({
  order: {
    type: "LIMIT",
    instrument: "EUR_USD",
    units: "1000",
    price: fixturePrice,
    timeInForce: "GTC",
    positionFill: "DEFAULT",
    clientExtensions: { id: fixtureKey, tag: MERIDIAN_TAG, comment: "CONTROL-2 FIXTURE — placed only to be cancelled" },
    stopLossOnFill: { price: (Number(fixturePrice) - 0.02).toFixed(5), timeInForce: "GTC", clientExtensions: { id: `${fixtureKey}-sl`, tag: MERIDIAN_TAG } },
    takeProfitOnFill: { price: (Number(fixturePrice) + 0.02).toFixed(5), timeInForce: "GTC", clientExtensions: { id: `${fixtureKey}-tp`, tag: MERIDIAN_TAG } },
  },
});
const fixtureOrderId = "body" in fixture ? (fixture.body?.orderCreateTransaction?.id ?? null) : null;
await appendRecord({
  kind: "ORDER_ACKNOWLEDGED",
  state: "ACKNOWLEDGED",
  orderKey: fixtureKey,
  payload: {
    fixture: true,
    purpose: "control 2 fixture — a pending order that exists only to be cancelled",
    orderId: fixtureOrderId,
    instrument: "EUR_USD",
    units: "1000",
    price: fixturePrice,
    brokerResponse: "body" in fixture ? fixture.body : null,
  },
});

const pendingBefore = await client.orders("PENDING");
const pendingBeforeIds = ("body" in pendingBefore ? (pendingBefore.body?.orders ?? []) : []).map((o: any) => String(o.id));

const cancelled = await cancelPendingOrders(client, "verification: control 2 — cancel pending entry orders");

const pendingAfter = await client.orders("PENDING");
const pendingAfterIds = ("body" in pendingAfter ? (pendingAfter.body?.orders ?? []) : []).map((o: any) => String(o.id));

/* ---- control 3: close every Meridian-managed position ----------------------- */
const tradesBefore = await client.openTrades();
const tradesBeforeList = ("body" in tradesBefore ? (tradesBefore.body?.trades ?? []) : []) as any[];
const managedBefore = tradesBeforeList.filter((t) => isManaged(t)).map((t) => ({ id: t.id, instrument: t.instrument, units: t.currentUnits, stop: t.stopLossOrder?.price ?? null }));
const manualBefore = tradesBeforeList.filter((t) => !isManaged(t)).map((t) => ({ id: t.id, instrument: t.instrument }));

const closed = await closeManagedPositions(client, "verification: control 3 — close Meridian-managed positions");

const tradesAfter = await client.openTrades();
const tradesAfterList = ("body" in tradesAfter ? (tradesAfter.body?.trades ?? []) : []) as any[];
const managedAfter = tradesAfterList.filter((t) => isManaged(t)).map((t) => t.id);

const evidence = {
  proof: "controls 2 and 3 as separate operations (control 1 is 06-pause-keeps-stops.json)",
  generatedAt: new Date().toISOString(),
  accountId,
  control2_cancelPending: {
    fixture: { orderId: fixtureOrderId, instrument: "EUR_USD", units: "1000", price: fixturePrice, note: "labelled CONTROL-2 FIXTURE in the record" },
    pendingBefore: pendingBeforeIds,
    cancelled,
    pendingAfter: pendingAfterIds,
    fixtureGone: fixtureOrderId !== null && !pendingAfterIds.includes(String(fixtureOrderId)),
  },
  control3_closeManaged: {
    managedBefore,
    manualBefore,
    closed,
    managedAfter,
    allManagedClosed: managedAfter.length === 0,
  },
  verdict:
    fixtureOrderId !== null &&
    !pendingAfterIds.includes(String(fixtureOrderId)) &&
    managedAfter.length === 0 &&
    closed.refused.length === 0
      ? "PASS"
      : "FAIL",
};

await writeFile(`${OUT_DIR}/07-controls.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(JSON.stringify({ verdict: evidence.verdict, control2: evidence.control2_cancelPending, control3: evidence.control3_closeManaged }, null, 2));
