import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { createClient, redactDeep } from "../../../../execution/lib/client.ts";
import { loadConfigFromDisk, resolveSettings } from "../../../../execution/lib/config.ts";
import { buildStatus, pauseEntries, resumeEntries } from "../../../../execution/lib/ops.ts";
import { evaluate, submitSignal, payloadHash } from "../../../../execution/lib/engine.ts";
import { bootstrapClient } from "../../../../execution/lib/bootstrap.ts";
import { instructionsFromSignals } from "../../../../execution/lib/signalAdapter.ts";
import { getSignals } from "~/lib/market/service";

const reply = (body: unknown, status = 200) => Response.json(redactDeep(body), {
  status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
});
function authorized(request: Request): boolean {
  const secret = process.env.MERIDIAN_OPERATOR_KEY ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  if (secret.length < 32) return false;
  const a = Buffer.from(supplied), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const Route = createFileRoute("/api/execution")({ server: { handlers: {
  POST: async ({ request }) => {
    if (!authorized(request)) return reply({ error: "Execution access is locked. Configure a separate operator key of at least 32 characters on the server." }, 401);
    try {
      if (!process.env.OANDA_ACCOUNT_ID) return reply({ error: "Set the intended OANDA Practice account ID on the server first." }, 503);
      const body = await request.json();
      const config = await loadConfigFromDisk();
      if (body.action === "pause") return reply(await pauseEntries("Owner dashboard action"));
      if (body.action === "resume") return reply(await resumeEntries("Owner dashboard action"));
      if (body.action === "status") {
        const status = await buildStatus(createClient(), config);
        const signals = await getSignals();
        const instructions = instructionsFromSignals(signals, Number(resolveSettings(config).values.signalExpirySeconds.value));
        return reply({ status, instructions });
      }
      if (body.action === "preview" || body.action === "submit") {
        const instructions = instructionsFromSignals(await getSignals(), Number(resolveSettings(config).values.signalExpirySeconds.value));
        const instruction = instructions.find((i) => i.signalId === body.signalId);
        if (!instruction) return reply({ error: "Signal no longer eligible. Refresh the dashboard." }, 409);
        if (body.action === "preview") {
          const result = await evaluate(createClient(), instruction, config, resolveSettings(config));
          return reply({ ...result, approvalHash: result.ok ? payloadHash(result.orderPayload) : null });
        }
        if (config.mode !== "approve-before-execution") return reply({ error: "Dashboard approval requires approve-before-execution mode." }, 409);
        const { client } = await bootstrapClient();
        return reply(await submitSignal(client, instruction, config, { approvedPayloadHash: body.approvalHash }));
      }
      return reply({ error: "Unknown execution action" }, 400);
    } catch {
      // Avoid returning broker/account/credential-bearing exception text to clients.
      return reply({ error: "Execution unavailable. No automatic retry was attempted; inspect server logs and reconcile broker state." }, 503);
    }
  },
} } });
