#!/usr/bin/env bun
/**
 * PROOF 5 — a dropped connection, and the pre-retry state check.
 *
 *   bun /home/team/shared/execution/scripts/05-connection-drop.ts
 *
 * Writes /home/team/shared/verify/execution/05-connection-drop.json
 *
 * HOW THE DROP IS PRODUCED, HONESTLY:
 * the practice host is the only host this code may contact, so the failure is
 * injected at the transport layer, not by pointing at another server. The injected
 * transport performs the REAL request to api-fxpractice.oanda.com, waits for the
 * broker's response, and then throws ECONNRESET — which is exactly what a dropped
 * connection looks like from the client: the order exists at the broker, and the
 * client never learns its id.
 *
 * The URL assertion still runs before the transport is chosen, so the injected
 * transport cannot widen the set of hosts.
 *
 * WHAT IS PROVEN:
 *  1. the engine records CONNECTION_FAILURE and does NOT retry on its own;
 *  2. the operator reads broker state BEFORE deciding anything;
 *  3. the order is found at the broker by its idempotency key, so the decision is
 *     "adopt, do not resubmit" — and a fresh broker count proves exactly one order
 *     with that key exists.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createClient, type Transport } from "../lib/client.ts";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { submitSignal, confirmProtection, idempotencyKey } from "../lib/engine.ts";
import { appendRecord } from "../lib/record.ts";
import { buildConnectionVerificationInstruction } from "../lib/testInstruction.ts";
import { assertPracticeTarget } from "../lib/interlock.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const { client, accountId } = await bootstrapClient();
const config = await loadConfig("/home/team/shared/execution/config.test.json");
const settings = resolveSettingsFrom(config);

const INSTRUMENT = "GBP_USD";
const built = await buildConnectionVerificationInstruction({
  instrument: INSTRUMENT,
  signalId: `drop-${Date.now()}`,
  expirySeconds: Number(settings.values.signalExpirySeconds.value),
  displayPrecision: 5,
});

let dropArmed = false;
let realSendCompleted = false;
const injected: Transport = async (url, init) => {
  // The assertion runs on the URL the client built, before this transport is used.
  assertPracticeTarget(url);
  // Arm the drop ONLY on the order POST. Dropping an account read would prove nothing
  // about the order path (and did, in the first attempt at this test).
  const isOrderPost = init.method === "POST" && new URL(url).pathname.endsWith("/orders");
  if (!dropArmed || !isOrderPost) return fetch(url, init);
  const res = await fetch(url, init); // the real request really reaches OANDA
  realSendCompleted = res.status === 200 || res.status === 201;
  throw Object.assign(new Error("read ECONNRESET (simulated drop after the broker received the request)"), { name: "TypeError" });
};

const dropClient = createClient({ transport: injected });
dropArmed = true;

const dropped = await submitSignal(dropClient, built.instruction, config, { settings });
dropArmed = false;

const orderKey = idempotencyKey(built.instruction);

// ---- the pre-retry state check: read the broker BEFORE doing anything else.
const ordersAfterDrop = await client.orders("ALL");
const tradesAfterDrop = await client.openTrades();
const ordersBody: any[] = ("body" in ordersAfterDrop ? (ordersAfterDrop.body?.orders ?? []) : []) as any[];
const tradesBody: any[] = ("body" in tradesAfterDrop ? (tradesAfterDrop.body?.trades ?? []) : []) as any[];

const matchingOrders = ordersBody.filter((o) => o.clientExtensions?.id === orderKey);
const matchingTrades = tradesBody.filter((t) =>
  [t.stopLossOrder?.clientExtensions?.id, t.takeProfitOrder?.clientExtensions?.id].some(
    (id: unknown) => typeof id === "string" && id.startsWith(orderKey),
  ),
);

const foundAtBroker = matchingOrders.length > 0 || matchingTrades.length > 0;
const decision = foundAtBroker ? "ADOPT_NO_RETRY" : "RETRY_ALLOWED";

await appendRecord({
  kind: "RETRY_DECISION",
  signalId: built.instruction.signalId,
  strategyId: built.instruction.strategyId,
  strategyVersion: built.instruction.strategyVersion,
  orderKey,
  state: foundAtBroker ? "FILLED" : "UNAVAILABLE",
  payload: {
    decision,
    reason: foundAtBroker
      ? "the order is present at the broker under the idempotency key, so a retry would duplicate it; Meridian adopts the broker's copy instead"
      : "the order is absent at the broker, so a retry cannot duplicate it",
    brokerOrdersMatching: matchingOrders.map((o) => ({ id: o.id, state: o.state, type: o.type })),
    brokerTradesMatching: matchingTrades.map((t) => ({ id: t.id, instrument: t.instrument, currentUnits: t.currentUnits })),
    realSendCompleted,
  },
});

let protection: Record<string, unknown> | null = null;
if (matchingTrades.length > 0) {
  protection = await confirmProtection(client, built.instruction, orderKey, String(matchingTrades[0].id));
}

const evidence = {
  proof: "dropped connection — broker state read before any retry, no duplicate created",
  generatedAt: new Date().toISOString(),
  accountId,
  instrument: INSTRUMENT,
  signalId: built.instruction.signalId,
  orderKey,
  injectedTransport: "performs the real POST to api-fxpractice.oanda.com, then throws ECONNRESET",
  realSendCompleted,
  submitResult: { state: dropped.state, ok: dropped.ok, reasons: dropped.reasons },
  engineDidNotRetryOnItsOwn: dropped.state === "UNAVAILABLE",
  preRetryStateCheck: {
    readAt: new Date().toISOString(),
    source: "GET /v3/accounts/{id}/orders?state=ALL and GET /v3/accounts/{id}/openTrades, made by a separate healthy client",
    brokerOrdersMatchingKey: matchingOrders.map((o) => ({ id: o.id, state: o.state, type: o.type, clientExtensions: o.clientExtensions })),
    brokerTradesMatchingKey: matchingTrades.map((t) => ({ id: t.id, instrument: t.instrument, currentUnits: t.currentUnits })),
    decision,
  },
  adoptedProtection: protection,
  ordersWithKeyCount: matchingOrders.length,
  tradesWithKeyCount: matchingTrades.length,
  noDuplicateCreated: matchingOrders.length <= 1,
  verdict:
    dropped.state === "UNAVAILABLE" && foundAtBroker && matchingOrders.length === 1 && (protection as any)?.protected === true
      ? "PASS"
      : "FAIL",
};

await writeFile(`${OUT_DIR}/05-connection-drop.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      verdict: evidence.verdict,
      submitState: dropped.state,
      reasons: dropped.reasons,
      realSendCompleted,
      decision,
      ordersWithKey: matchingOrders.length,
      tradesWithKey: matchingTrades.length,
      adoptedTrade: matchingTrades[0]?.id ?? null,
      protected: (protection as any)?.protected ?? null,
    },
    null,
    2,
  ),
);
