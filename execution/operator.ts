/** Private terminal operator. Never expose this as an unauthenticated HTTP route. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { bootstrapClient } from "./lib/bootstrap.ts";
import { createClient } from "./lib/client.ts";
import { loadConfigFromDisk, resolveSettings } from "./lib/config.ts";
import { evaluate, submitSignal, payloadHash } from "./lib/engine.ts";
import { buildStatus, pauseEntries, resumeEntries, reconcile, cancelPendingOrders, closeManagedPositions } from "./lib/ops.ts";
import { executionPath, executionDir } from "./lib/paths.ts";
import { readRecords } from "./lib/record.ts";
import { redactDeep } from "./lib/client.ts";
import { generateReport, reportDue, readReportState } from "./report.ts";
import { instructionsFromSignals } from "./lib/signalAdapter.ts";
import type { SignalInstruction } from "./lib/instruction.ts";
import type { SignalsPayload } from "../site/src/lib/market/types.ts";

const [command = "help", file, approvedHash] = process.argv.slice(2);
if (command === "help") {
  console.log(`Meridian OANDA PRACTICE operator (Node 24+ or Bun)
status | reconcile | pause | resume | cancel-entries | close-managed | report
preview <instruction.json>
submit <instruction.json> <reviewed-payload-hash>
watch

report builds a plain-language report from the record and a live broker read and writes it
to MERIDIAN_EXECUTION_DIR/reports/. It sends nothing anywhere unless a notification
transport is configured (the default is none).

watch reads MERIDIAN_SIGNALS_URL, writes pending-instructions.json and status.json
inside MERIDIAN_EXECUTION_DIR. Only explicit automatic mode submits on watch.
Approval mode requires preview + submit. Nothing in this build trades live.`);
} else {
  const allowed = ["status", "reconcile", "pause", "resume", "cancel-entries", "close-managed", "preview", "submit", "watch", "report"];
  if (!allowed.includes(command)) throw new Error("Unknown command; run help");
  const output = (value: unknown) => console.log(JSON.stringify(redactDeep(value), null, 2));
  if (command === "pause") output(await pauseEntries("Owner terminal command"));
  else if (command === "resume") output(await resumeEntries("Owner terminal command"));
  else if (command === "report") {
    // Read-only against the broker: the report reads the account, the open trades and the
    // closed-trade history, and writes files. It cannot submit, cancel or modify anything.
    // createClient() rather than bootstrapClient(): a report is most useful exactly when the
    // interlock attestation is failing, so it must not depend on that check passing.
    const config = await loadConfigFromDisk();
    const result = await generateReport({ client: createClient(), config, trigger: "MANUAL", triggerDetail: "operator terminal command" });
    output({
      reportId: result.report.reportId,
      generatedAt: result.report.generatedAt,
      files: result.files,
      recordSeq: result.recordSeq,
      notification: result.notification,
      counts: result.report.counts,
    });
  }
  else {
    const { client } = await bootstrapClient();
    const config = await loadConfigFromDisk();
    if (command === "status") output(await buildStatus(client, config));
    if (command === "reconcile") output(await reconcile(client));
    if (command === "cancel-entries") output(await cancelPendingOrders(client, "Owner terminal command"));
    if (command === "close-managed") output(await closeManagedPositions(client, "Owner terminal command"));
    if (command === "preview" || command === "submit") {
      if (!file) throw new Error("Instruction JSON path is required");
      const instruction = JSON.parse(await readFile(file, "utf8")) as SignalInstruction;
      if (command === "preview") {
        const result = await evaluate(client, instruction, config, resolveSettings(config));
        output({ ...result, approvalHash: result.ok ? payloadHash(result.orderPayload) : null });
      } else output(await submitSignal(client, instruction, config, { approvedPayloadHash: approvedHash }));
    }
    if (command === "watch") {
      const url = new URL(process.env.MERIDIAN_SIGNALS_URL ?? "https://f18acd832760c783c8b1cf1b27811368.cto.site/api/signals");
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Signals URL must be HTTPS without credentials");
      await mkdir(executionDir(), { recursive: true });
      let running = true;
      process.on("SIGINT", () => { running = false; });
      process.on("SIGTERM", () => { running = false; });
      while (running) {
        try {
          const current = await loadConfigFromDisk();
          const settings = resolveSettings(current);
          if (current.problems.length) throw new Error(current.problems.join("; "));
          const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
          if (!response.ok) throw new Error(`Signals source HTTP ${response.status}`);
          const payload = await response.json() as SignalsPayload;
          const instructions = instructionsFromSignals(payload, Number(settings.values.signalExpirySeconds.value));
          await writeFile(executionPath("pending-instructions.json"), JSON.stringify(instructions, null, 2), { mode: 0o600 });
          if (current.mode === "automatic") {
            for (const instruction of instructions) output(await submitSignal(client, instruction, current));
          }
          const status = await buildStatus(client, current);
          await writeFile(executionPath("status.json"), JSON.stringify(status, null, 2), { mode: 0o600 });
          // Plain-language report: on the configured interval, and IMMEDIATELY after a fill,
          // close, refusal or error. It is deliberately inside its own try/catch — a report
          // that cannot be written must never stop the watcher, delay the next cycle, or be
          // mistaken for a trading failure. Nothing here submits anything.
          let reportInfo: unknown = null;
          try {
            const state = await readReportState();
            const due = await reportDue(await readRecords(), current, state);
            if (due.due) {
              const generated = await generateReport({ client, config: current, trigger: due.trigger, triggerDetail: due.detail });
              reportInfo = {
                reportId: generated.report.reportId,
                recordSeq: generated.recordSeq,
                trigger: generated.report.trigger,
                delivered: generated.notification.delivered,
                notification: generated.notification.detail,
              };
            }
          } catch (reportError) {
            reportInfo = { state: "REPORT_FAILED", error: String(reportError) };
            console.log(JSON.stringify({ report: "FAILED", error: String(reportError) }));
          }
          output({ checkedAt: status.generatedAt, mode: current.mode, brokerOk: status.broker.ok, pending: instructions.length, report: reportInfo });
        } catch (error) {
          // Stop rather than retry uncertain orders or hide a failed source.
          output({ state: "UNAVAILABLE", error: String(error) });
          process.exitCode = 1;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }
  }
}
