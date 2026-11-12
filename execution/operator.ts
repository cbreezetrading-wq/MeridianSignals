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
import { generateReport, reportDue, readReportState, readLatestReportResult, subjectStamp } from "./report.ts";
import { createEmailTransport, readEmailEnv, missingEnvDetail } from "./emailTransport.ts";
import { instructionsFromSignals } from "./lib/signalAdapter.ts";
import { recordObservedCloses, WATCHER_CYCLE_MS } from "./lib/closes.ts";
import type { SignalInstruction } from "./lib/instruction.ts";
import type { SignalsPayload } from "../site/src/lib/market/types.ts";

const [command = "help", file, approvedHash] = process.argv.slice(2);
if (command === "help") {
  console.log(`Meridian OANDA PRACTICE operator (Node 24+ or Bun)
status | reconcile | pause | resume | cancel-entries | close-managed | report
preview <instruction.json>
submit <instruction.json> <reviewed-payload-hash>
watch
notify-test

report builds a plain-language report from the record and a live broker read and writes it
to MERIDIAN_EXECUTION_DIR/reports/. It sends nothing anywhere unless a notification
transport is configured. Email is the transport the owner chose (2026-11-04); it needs
MERIDIAN_SMTP_USER, MERIDIAN_SMTP_PASS and MERIDIAN_ALERT_TO, and until all three are saved
it sends nothing, connects to nothing, and says which of the three is missing.

notify-test sends ONE real test message through the configured transport and prints the
outcome with the SMTP code. It is a terminal command on purpose: there is no console or HTTP
action that can send mail on demand, because an authenticated endpoint that can send mail is
a spam vector this system does not need.

watch reads MERIDIAN_SIGNALS_URL, writes pending-instructions.json and status.json
inside MERIDIAN_EXECUTION_DIR. Only explicit automatic mode submits on watch.
Approval mode requires preview + submit. Nothing in this build trades live.`);
} else {
  const allowed = ["status", "reconcile", "pause", "resume", "cancel-entries", "close-managed", "preview", "submit", "watch", "report", "notify-test"];
  if (!allowed.includes(command)) throw new Error("Unknown command; run help");
  const output = (value: unknown) => console.log(JSON.stringify(redactDeep(value), null, 2));
  if (command === "pause") output(await pauseEntries("Owner terminal command"));
  else if (command === "resume") output(await resumeEntries("Owner terminal command"));
  else if (command === "report") {
    // Read-only against the broker: the report reads the account, the open trades and the
    // closed-trade history, and writes files. It cannot submit, cancel or modify anything.
    // createClient() rather than bootstrapClient(): a report is most useful exactly when the
    // interlock attestation is failing, so it must not depend on that check passing.
    //
    // No config is passed in: generateReport reads it itself, strictly, and produces an
    // UNAVAILABLE report naming the path rather than a default mode when it cannot. Passing a
    // config from here is how the console came to print `signals-only (source: DEFAULT)`.
    const result = await generateReport({ client: createClient(), trigger: "MANUAL", triggerDetail: "operator terminal command" });
    output({
      reportId: result.report.reportId,
      generatedAt: result.report.generatedAt,
      status: result.report.status,
      files: result.files,
      recordSeq: result.recordSeq,
      notification: result.notification,
      ...(result.report.status === "OK" ? { mode: result.report.mode, counts: result.report.counts } : { unavailable: result.report.unavailable }),
    });
  }
  else if (command === "notify-test") {
    // ONE real message through the configured transport, and its outcome in the terminal.
    // Deliberately a terminal command and not an HTTP action: an authenticated endpoint that
    // can send mail on demand is a spam vector this system does not need. It touches no
    // order, no record entry and no report file — it sends and prints.
    const settings = readEmailEnv();
    if (!settings.configured) {
      output({
        configured: false,
        delivered: false,
        missing: settings.missing,
        detail: missingEnvDetail(settings.missing),
        note: "nothing was sent and no connection to any mail server was opened",
      });
      process.exitCode = 1;
    } else {
      // Attempt lines go to stderr so stdout stays one JSON object.
      const transport = createEmailTransport({ log: (line) => console.error(line) });
      const latest = await readLatestReportResult();
      const now = new Date();
      const result = await transport.send({
        reportId: latest.found ? latest.report.reportId : "notify-test",
        generatedAt: now.toISOString(),
        subject: `Meridian: notification test — ${subjectStamp(now.toISOString())}`,
        text: [
          "This is a delivery test of the Meridian Signals email transport.",
          "It is not a report and it is not an order: nothing was submitted, cancelled or modified.",
          "",
          latest.found
            ? `The most recent report on disk (${latest.report.reportId}) is included below for reference.`
            : "No report has been written to the reports directory yet.",
          "",
          latest.found ? latest.report.text : "",
        ].join("\n"),
        json: latest.found ? latest.report.json : null,
      });
      output({
        configured: result.configured,
        delivered: result.delivered,
        smtpCode: result.smtpCode,
        messageId: result.messageId,
        stage: result.stage,
        detail: result.detail,
        attempts: result.attempts,
      });
      if (!result.delivered) process.exitCode = 1;
    }
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
          // FIRST THING EVERY CYCLE, INCLUDING THE FIRST CYCLE AFTER A RESTART: record any
          // close the broker has already made that the record has not seen. A stop or target
          // that fills while the machine is down is invisible to the order path, so without
          // this the record would never hold that close. It is read-only at the broker, it
          // writes at most one CLOSED per trade id ever, and it runs BEFORE anything can be
          // submitted. Its own try/catch: a detection that cannot run must not stop the
          // watcher, and must never be mistaken for a trading failure.
          let closeInfo: unknown = null;
          try {
            const detected = await recordObservedCloses(client, { cycleMs: WATCHER_CYCLE_MS });
            closeInfo = {
              ok: detected.ok,
              ...(detected.ok ? {} : { reason: detected.reason }),
              recorded: detected.recorded.map((c) => ({
                tradeId: c.tradeId,
                closedAt: c.closedAt,
                detectedAt: c.detectedAt,
                detectedLate: c.detectedLate,
                realizedPL: c.realizedPL,
                plMeasured: c.plMeasured,
              })),
              skipped: detected.skipped,
            };
            if (detected.recorded.length > 0) console.log(JSON.stringify({ closes: "RECORDED", ...(closeInfo as object) }));
          } catch (closeError) {
            closeInfo = { state: "CLOSE_DETECTION_FAILED", error: String(closeError) };
          }
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
          output({ checkedAt: status.generatedAt, mode: current.mode, brokerOk: status.broker.ok, pending: instructions.length, closes: closeInfo, report: reportInfo });
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
