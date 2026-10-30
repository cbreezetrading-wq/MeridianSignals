#!/usr/bin/env bun
/**
 * PROOF 2 — one real Practice order, with protection attached in the same request,
 * read back from a FRESH broker GET.
 *
 *   bun /home/team/shared/execution/scripts/02-one-order.ts
 *
 * Writes /home/team/shared/verify/execution/02-one-order.json
 *
 * Flow, and why each step is where it is:
 *  1. bootstrap: attestation must pass (practice readable AND the live host refuses
 *     this token) or nothing runs.
 *  2. load config.test.json: approve-before-execution, TEST profile, invented ruleset
 *     enabled for Practice only.
 *  3. evaluate(): builds the full proposal — instrument, units, direction, entry,
 *     stop, take-profit, estimated risk in account currency — from a fresh price and
 *     a fresh account read. This is what "approve" would look at.
 *  4. submitSignal(): re-evaluates (another fresh price + account read) and only then
 *     POSTs, so the displayed proposal is never the thing that is sent.
 *  5. confirmProtection(): GET the trade by id and require the broker's own object to
 *     carry stopLossOrder and takeProfitOrder. PROTECTED is never set from memory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { evaluate, submitSignal } from "../lib/engine.ts";
import { buildConnectionVerificationInstruction } from "../lib/testInstruction.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const INSTRUMENT = process.env.VERIFY_INSTRUMENT ?? "EUR_USD";
const SIGNAL_ID = process.env.VERIFY_SIGNAL_ID ?? `cv-${INSTRUMENT.toLowerCase()}-${Date.now()}`;

const { client, accountId, attestation } = await bootstrapClient();
const config = await loadConfig("/home/team/shared/execution/config.test.json");
const settings = resolveSettingsFrom(config);
if (!settings.allSet) throw new Error(`settings UNSET: ${settings.missing.join(", ")}`);

const built = await buildConnectionVerificationInstruction({
  instrument: INSTRUMENT,
  signalId: SIGNAL_ID,
  expirySeconds: Number(settings.values.signalExpirySeconds.value),
  displayPrecision: INSTRUMENT.includes("JPY") ? 3 : 5,
});

// ---- Step 3: the proposal an approver would see.
const preview = await evaluate(client, built.instruction, config, settings);
if (!preview.ok) {
  const failure = { ok: false, stage: "evaluate", state: preview.state, reasons: preview.reasons, basis: built.basis };
  await writeFile(`${OUT_DIR}/02-one-order.json`, JSON.stringify(failure, null, 2), "utf8");
  console.log(JSON.stringify(failure, null, 2));
  process.exit(1);
}

// ---- Step 4: re-evaluate inside submitSignal (fresh price + account read) and POST.
const result = await submitSignal(client, built.instruction, config, { settings });

const evidence = {
  proof: "one real Practice order with protection attached in the same request",
  generatedAt: new Date().toISOString(),
  accountId,
  attestation: { ok: attestation.ok, practice: attestation.practiceProbe, live: attestation.liveProbe },
  config: {
    path: "/home/team/shared/execution/config.test.json",
    mode: settings.mode,
    modeSource: settings.modeSource,
    testProfileInUse: settings.testProfileInUse,
    settings: Object.values(settings.values).map((s) => ({ key: s.key, value: s.value, source: s.source })),
  },
  basis: built.basis,
  instruction: built.instruction,
  proposalShownForApproval: preview.proposal,
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
  },
  protectionReadBackFromFreshBrokerGet: result.protection,
};

await writeFile(`${OUT_DIR}/02-one-order.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      state: result.state,
      orderKey: result.orderKey,
      orderId: result.broker?.orderId,
      tradeId: result.broker?.tradeId,
      units: preview.proposal?.units,
      riskAccountCurrency: preview.proposal?.riskAccountCurrency,
      roundTripMs: result.timing?.roundTripMs,
      protected: (result.protection as any)?.protected,
    },
    null,
    2,
  ),
);
