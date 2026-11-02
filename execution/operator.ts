/** Private terminal operator. Never expose this as an unauthenticated HTTP route. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { bootstrapClient } from "./lib/bootstrap.ts";
import { loadConfigFromDisk, resolveSettings } from "./lib/config.ts";
import { evaluate, submitSignal, payloadHash } from "./lib/engine.ts";
import { buildStatus, pauseEntries, resumeEntries, reconcile, cancelPendingOrders, closeManagedPositions } from "./lib/ops.ts";
import { executionPath, EXECUTION_DIR } from "./lib/paths.ts";
import { redactDeep } from "./lib/client.ts";
import { instructionsFromSignals } from "./lib/signalAdapter.ts";
import type { SignalInstruction } from "./lib/instruction.ts";
import type { SignalsPayload } from "../site/src/lib/market/types.ts";

const [command = "help", file, approvedHash] = process.argv.slice(2);
if (command === "help") {
  console.log(`Meridian OANDA PRACTICE operator (Node 24+ or Bun)
status | reconcile | pause | resume | cancel-entries | close-managed
preview <instruction.json>
submit <instruction.json> <reviewed-payload-hash>
watch

watch reads MERIDIAN_SIGNALS_URL, writes pending-instructions.json and status.json
inside MERIDIAN_EXECUTION_DIR. Only explicit automatic mode submits on watch.
Approval mode requires preview + submit. Nothing in this build trades live.`);
} else {
  const allowed = ["status", "reconcile", "pause", "resume", "cancel-entries", "close-managed", "preview", "submit", "watch"];
  if (!allowed.includes(command)) throw new Error("Unknown command; run help");
  const output = (value: unknown) => console.log(JSON.stringify(redactDeep(value), null, 2));
  if (command === "pause") output(await pauseEntries("Owner terminal command"));
  else if (command === "resume") output(await resumeEntries("Owner terminal command"));
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
      await mkdir(EXECUTION_DIR, { recursive: true });
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
          output({ checkedAt: status.generatedAt, mode: current.mode, brokerOk: status.broker.ok, pending: instructions.length });
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
