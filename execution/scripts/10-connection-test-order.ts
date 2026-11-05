#!/usr/bin/env bun
/**
 * PROOF 10 — ONE 1-unit Practice order labelled CONNECTION_TEST, with stop and take-profit
 * attached in the SAME request, and protection read back from a FRESH broker GET.
 *
 *   cd /home/team/shared/execution && bun scripts/10-connection-test-order.ts
 *
 * Writes /home/team/shared/verify/execution/10-connection-test-order.json
 *
 * Why this exists, stated plainly: the earlier verification orders were sized from the risk
 * budget (0.1% of NAV over a ~30-pip stop is ~20,000 units). This is a CONNECTION test, not a
 * trade, so its size is the instrument's own minimum — 1 unit for EUR_USD — via sizingMode
 * BROKER_MINIMUM, and its origin is CONNECTION_TEST so it can never be read as the invented
 * ruleset trading.
 *
 * What is deliberately NOT relaxed:
 *   - the Practice/live interlock (bootstrap refuses if the live host answers this token);
 *   - the hash chain, the config problems check, the settings check, the mode check, the
 *     enabled-strategy check, the instruction validation, the pause check, the duplicate
 *     check against record + archive + broker, the spread / entry-deviation / trading-time /
 *     manual-position / max-positions / existing-position / daily-loss guards, the exposure
 *     cap, and the pre-submit risk re-check.
 * BROKER_MINIMUM changes ONE thing: where the unit count comes from. Risk and notional are
 * then derived FROM those units, so the proposal still states what the position carries.
 *
 * One POST, never retried. If the submission returns 401/504 (OANDA Practice has been
 * intermittently flaky on identical valid requests) the exact HTTP code and body are recorded
 * and reported, and nothing is resubmitted. A READ-BACK may be retried; a submission may not.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { evaluate, submitSignal } from "../lib/engine.ts";
import { buildConnectionVerificationInstruction } from "../lib/testInstruction.ts";
import { replay } from "../lib/record.ts";
import type { Client } from "../lib/client.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
const OUT_FILE = `${OUT_DIR}/10-connection-test-order.json`;
const CONFIG_PATH = process.env.MERIDIAN_CONFIG ?? "/home/team/shared/execution/config.json";

const INSTRUMENT = process.env.VERIFY_INSTRUMENT ?? "EUR_USD";
/** Unique per run: the idempotency key is derived from it, so this cannot collide. */
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const SIGNAL_ID = process.env.VERIFY_SIGNAL_ID ?? `conn-test-${INSTRUMENT.toLowerCase()}-${STAMP}`;

await mkdir(OUT_DIR, { recursive: true });

const { client, accountId, attestation } = await bootstrapClient();
const config = await loadConfig(CONFIG_PATH);
const settings = resolveSettingsFrom(config);
if (!settings.allSet) throw new Error(`settings UNSET: ${settings.missing.join(", ")}`);

const built = await buildConnectionVerificationInstruction({
  instrument: INSTRUMENT,
  signalId: SIGNAL_ID,
  expirySeconds: Number(settings.values.signalExpirySeconds.value),
  displayPrecision: INSTRUMENT.includes("JPY") ? 3 : 5,
});

const base = {
  proof: "one 1-unit Practice CONNECTION_TEST order, protection attached in the same request, read back from the broker",
  generatedAt: new Date().toISOString(),
  accountId,
  configPath: CONFIG_PATH,
  mode: settings.mode,
  modeSource: settings.modeSource,
  settingsProfile: settings.profileLabel,
  attestation: { ok: attestation.ok, practice: attestation.practiceProbe, live: attestation.liveProbe },
  instruction: built.instruction,
  basis: built.basis,
};

// ---- Step 1: the proposal. Every guard runs here; nothing is sent if any of them refuses.
const preview = await evaluate(client, built.instruction, config, settings);
if (!preview.ok) {
  const refusal = {
    ...base,
    outcome: "REFUSED_BEFORE_SUBMISSION",
    stage: "evaluate",
    state: preview.state,
    reasons: preview.reasons,
    note: "No POST was made: the proposal was refused by the engine's own checks before any submission.",
  };
  await writeFile(OUT_FILE, JSON.stringify(refusal, null, 2), "utf8");
  console.log(JSON.stringify({ outcome: refusal.outcome, state: refusal.state, reasons: refusal.reasons }, null, 2));
  process.exit(1);
}

// ---- Step 2: submit ONCE. submitSignal re-evaluates (fresh price, fresh account read, fresh
// duplicate check) and performs exactly one POST. Nothing below retries it.
const result = await submitSignal(client, built.instruction, config, { settings });

/**
 * Read the trade back from the broker, retrying the READ (never the submission). PROTECTED is
 * only ever set from what this returns.
 */
async function readTradeBack(tradeId: string, attempts = 3): Promise<Record<string, unknown>> {
  const reads: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await client.trade(tradeId);
    if ("transportFailure" in res) {
      reads.push({ attempt, transportFailure: true, error: res.error, at: new Date().toISOString() });
    } else {
      const trade = res.body?.trade ?? null;
      reads.push({
        attempt,
        at: new Date().toISOString(),
        status: res.status,
        ok: res.ok,
        errorText: res.ok ? null : res.text.slice(0, 400),
        tradeFound: Boolean(trade),
      });
      if (res.ok && trade) {
        return {
          source: `GET /v3/accounts/${accountId}/trades/${tradeId}`,
          attempts: reads,
          trade: {
            id: trade.id,
            instrument: trade.instrument,
            state: trade.state,
            currentUnits: trade.currentUnits,
            price: trade.price,
            openTime: trade.openTime,
            unrealizedPL: trade.unrealizedPL,
            stopLossOrder: trade.stopLossOrder
              ? { id: trade.stopLossOrder.id, price: trade.stopLossOrder.price, state: trade.stopLossOrder.state, timeInForce: trade.stopLossOrder.timeInForce, clientExtensions: trade.stopLossOrder.clientExtensions }
              : null,
            takeProfitOrder: trade.takeProfitOrder
              ? { id: trade.takeProfitOrder.id, price: trade.takeProfitOrder.price, state: trade.takeProfitOrder.state, timeInForce: trade.takeProfitOrder.timeInForce, clientExtensions: trade.takeProfitOrder.clientExtensions }
              : null,
          },
          // The ONLY thing that may call this protected: the broker's own object carrying both legs.
          protected: Boolean(trade.stopLossOrder && trade.takeProfitOrder && trade.state === "OPEN"),
        };
      }
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000));
  }
  return { source: `GET /v3/accounts/${accountId}/trades/${tradeId}`, attempts: reads, trade: null, protected: false };
}

const tradeId = result.broker?.tradeId ?? null;
const protection = tradeId ? await readTradeBack(tradeId) : null;
const trade = (protection?.trade ?? null) as Record<string, any> | null;

/** Realised risk, recomputed from the broker's fill price and the stop the broker attached. */
function realisedRisk(proposal: Record<string, any> | null): Record<string, unknown> {
  if (!trade) return { measured: false, reason: "no trade was read back from the broker, so there is no fill price and no attached stop to measure" };
  const units = Math.abs(Number(trade.currentUnits));
  const fillPrice = Number(trade.price);
  const stopPrice = Number(trade.stopLossOrder?.price);
  const rate = Number(proposal?.quoteToAccountRate ?? 1);
  if (!Number.isFinite(units) || !Number.isFinite(fillPrice) || !Number.isFinite(stopPrice)) {
    return { measured: false, reason: "the broker's trade object does not carry a usable units / price / stop price" };
  }
  const perUnitQuote = Math.abs(fillPrice - stopPrice);
  const risk = units * perUnitQuote * rate;
  return {
    measured: true,
    units,
    fillPrice,
    fillPriceSource: "the broker's trade.price (average fill price of the trade it opened)",
    stopPrice,
    stopPriceSource: "the broker's trade.stopLossOrder.price, read back — not our own record",
    quoteToAccountRate: rate,
    riskPerUnitQuote: perUnitQuote,
    realisedRiskAccountCurrency: Number(risk.toFixed(4)),
    budgetedRiskAccountCurrency: Number.isFinite(Number(proposal?.riskAccountCurrency)) ? Number(proposal?.riskAccountCurrency) : null,
    capAccountCurrency: Number.isFinite(Number(proposal?.riskCapAccountCurrency)) ? Number(proposal?.riskCapAccountCurrency) : null,
    withinCap:
      Number.isFinite(Number(proposal?.riskCapAccountCurrency)) ? risk <= Number(proposal?.riskCapAccountCurrency) : null,
    note: "recomputed from the broker's fill price and the stop the broker reports attached; not from the size we submitted",
  };
}

// The record's own account of what happened, by seq — the submission's seq and its label.
const { byOrderKey } = await replay();
const records = (byOrderKey.get(result.orderKey) ?? []).map((r) => ({ seq: r.seq, kind: r.kind, state: r.state, recordedAt: r.recordedAt }));

const protectionOk = Boolean(protection?.protected);
const outcome = protectionOk
  ? "FILLED_AND_PROTECTED"
  : tradeId
    ? "FILLED_PROTECTION_UNCONFIRMED"
    : result.state === "REJECTED"
      ? "REJECTED_BY_BROKER"
      : result.state === "UNAVAILABLE"
        ? "SUBMISSION_OUTCOME_UNKNOWN"
        : String(result.state);

const evidence = {
  ...base,
  outcome,
  orderKey: result.orderKey,
  instructionOrigin: built.instruction.origin,
  instructionSizingMode: built.instruction.sizingMode ?? "RISK",
  proposalShownBeforeSubmission: preview.proposal,
  submitted: {
    state: result.state,
    ok: result.ok,
    reasons: result.reasons,
    orderKey: result.orderKey,
    broker: result.broker
      ? {
          orderId: result.broker.orderId,
          tradeId: result.broker.tradeId,
          transactionId: result.broker.transactionId,
          ackStatus: result.broker.ackStatus,
          errorMessage: result.broker.errorMessage,
        }
      : null,
    brokerAckJson: result.broker?.ackJson ?? null,
    timing: result.timing,
    note: "exactly one POST was made for this signal. A 401/504 or any other failure is reported here and NOT retried; only reads below are retried.",
  },
  record: {
    orderKey: result.orderKey,
    submissionSeq: records.find((r) => r.kind === "ORDER_REQUESTED")?.seq ?? null,
    records,
    label: { origin: built.instruction.origin, sizingMode: built.instruction.sizingMode ?? "RISK" },
  },
  protectionReadBackFromFreshBrokerGet: protection,
  protectionConfirmedByBroker: protectionOk,
  realisedRisk: realisedRisk(preview.proposal as Record<string, any> | null),
};

await writeFile(OUT_FILE, JSON.stringify(evidence, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      outcome,
      orderKey: result.orderKey,
      submissionSeq: evidence.record.submissionSeq,
      origin: built.instruction.origin,
      sizingMode: built.instruction.sizingMode ?? "RISK",
      units: preview.proposal?.units,
      tradeId,
      ackStatus: result.broker?.ackStatus ?? null,
      errorMessage: result.broker?.errorMessage ?? null,
      protectionConfirmedByBroker: protectionOk,
      stop: trade?.stopLossOrder?.price ?? null,
      takeProfit: trade?.takeProfitOrder?.price ?? null,
      entryPrice: trade?.price ?? null,
      realisedRisk: evidence.realisedRisk,
      evidenceFile: OUT_FILE,
    },
    null,
    2,
  ),
);

process.exit(protectionOk ? 0 : tradeId ? 2 : 1);
