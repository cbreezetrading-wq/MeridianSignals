import { createFileRoute } from "@tanstack/react-router";
import { createClient, redactDeep } from "../../../../execution/lib/client.ts";
import { loadConfigFromDisk, readConfigForReport, resolveSettings } from "../../../../execution/lib/config.ts";
import { buildStatus, pauseEntries, resumeEntries } from "../../../../execution/lib/ops.ts";
import { evaluate, submitSignal, payloadHash } from "../../../../execution/lib/engine.ts";
import { bootstrapClient } from "../../../../execution/lib/bootstrap.ts";
import { instructionsFromSignals } from "../../../../execution/lib/signalAdapter.ts";
import { authorizeOperatorKey, handleReportAction, isReportAction } from "../../../../execution/lib/reportApi.ts";
import { getSignals } from "~/lib/market/service";
import { isPublishedHost, publishedHostNotFound } from "~/lib/hostRole";

/**
 * ONE execution backend is authoritative: the working host — the live `execution/`
 * directory plus the supervised worker that writes to it.
 *
 * The published build carries compiled output only: no ledger, no config, no worker,
 * no writable shared volume. It therefore serves NO execution endpoint. It used to be a
 * server-side pass-through to the working host, which is exactly what put live account
 * state behind the public URL (owner decision 2026-11-01: the console is
 * working-host-only, unlisted; `execution/UNLISTED_REQUIREMENT.md` makes it binding).
 * That relay is gone: a published build answers 404 and discloses nothing — no mode, no
 * count, no account figure, no backend address. A 404 is the honest answer, because a
 * published build has no state to read and must not borrow someone else's.
 */
const reply = (body: unknown, status = 200) => Response.json(redactDeep(body), {
  status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
});
function authorized(request: Request): boolean {
  return authorizeOperatorKey(request.headers.get("authorization"), process.env.MERIDIAN_OPERATOR_KEY ?? null).ok;
}

export const Route = createFileRoute("/api/execution")({ server: { handlers: {
  POST: async ({ request }) => {
    // First, before the body is read or any state is touched: the public port has no
    // execution surface. Not a setting, not a fallback — a build-time fact.
    if (isPublishedHost()) return publishedHostNotFound();
    if (!authorized(request)) return reply({ error: "Execution access is locked. Configure a separate operator key of at least 32 characters on the server." }, 401);
    try {
      if (!process.env.OANDA_ACCOUNT_ID) return reply({ error: "Set the intended OANDA Practice account ID on the server first." }, 503);
      const body = await request.json();
      // The report actions carry their own authentication decision (the same function this
      // route uses above) and return their own Response, so a refusal here is a 401 that
      // discloses nothing. Neither action can submit, cancel or modify an order.
      if (isReportAction(body.action)) {
        return handleReportAction({ action: body.action, authorization: request.headers.get("authorization") });
      }
      const config = await loadConfigFromDisk();
      if (body.action === "pause") return reply(await pauseEntries("Owner dashboard action"));
      if (body.action === "resume") return reply(await resumeEntries("Owner dashboard action"));
      if (body.action === "status") {
        // The status line states the mode, so it must come from a config file that was READ.
        // `loadConfigFromDisk` falls back to signals-only defaults, which is safe for an order
        // path and a lie on a dashboard: it was printed as `signals-only (source: DEFAULT)`
        // while config.json said `automatic`. Unreadable config -> refuse, naming the path.
        const configRead = await readConfigForReport();
        if (!configRead.ok) {
          return reply(
            {
              error:
                `The execution config could not be read at ${configRead.path} (${configRead.reason}). No mode, no status and ` +
                "no account figure is shown, because every one of them would be an invention.",
              configPath: configRead.path,
              reason: configRead.reason,
            },
            503,
          );
        }
        const config = configRead.config;
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
