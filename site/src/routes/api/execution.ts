import { createFileRoute } from "@tanstack/react-router";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createClient, redactDeep } from "../../../../execution/lib/client.ts";
import { loadConfigFromDisk, resolveSettings } from "../../../../execution/lib/config.ts";
import { configPath } from "../../../../execution/lib/paths.ts";
import { buildStatus, pauseEntries, resumeEntries } from "../../../../execution/lib/ops.ts";
import { evaluate, submitSignal, payloadHash } from "../../../../execution/lib/engine.ts";
import { bootstrapClient } from "../../../../execution/lib/bootstrap.ts";
import { instructionsFromSignals } from "../../../../execution/lib/signalAdapter.ts";
import { getSignals } from "~/lib/market/service";

/**
 * ONE execution backend is authoritative: this working host — the live
 * `execution/` directory plus the supervised worker that writes to it.
 *
 * A published build carries compiled output only: no ledger, no config, no
 * worker, no writable shared volume. So it must not answer execution requests
 * from its own (empty) state — that would be a second, silently diverging
 * backend showing a record nobody is writing. Instead it is a transparent
 * server-side pass-through to the authoritative backend: same request body, the
 * client's Authorization header forwarded unchanged, the backend's own status
 * and body returned verbatim. If the backend cannot be reached, the answer is
 * 503 naming it — never fabricated state.
 *
 * Which role this process plays is decided per request:
 *   - MERIDIAN_EXECUTION_BACKEND_URL set  -> pass-through to that URL;
 *   - else live execution config on disk  -> authoritative, serve locally;
 *   - else                                -> pass-through to the backend below.
 * A request already relayed by a pass-through (x-meridian-backend-hop) is never
 * relayed again, so a misconfiguration cannot loop.
 */
const AUTHORITATIVE_BACKEND_URL = "https://f18acd832760c783c8b1cf1b27811368-dev.cto.site";
const HOP_HEADER = "x-meridian-backend-hop";
const PROXY_TIMEOUT_MS = 30_000;

/** True when this process owns the live execution directory (the working host). */
function hasLocalExecutionState(): boolean {
  try {
    return existsSync(configPath());
  } catch {
    return false;
  }
}

/** The backend URL to relay to, or null when this process is the backend. */
function proxyTarget(request: Request): string | null {
  if (request.headers.get(HOP_HEADER) !== null) return null;
  const override = (process.env.MERIDIAN_EXECUTION_BACKEND_URL ?? "").trim();
  if (override !== "") return override.replace(/\/+$/, "");
  if (hasLocalExecutionState()) return null;
  return AUTHORITATIVE_BACKEND_URL;
}

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

async function relay(request: Request, target: string): Promise<Response> {
  const body = await request.text();
  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "application/json",
    [HOP_HEADER]: "1",
  };
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.authorization = authorization;
  let upstream: Response;
  try {
    upstream = await fetch(`${target}/api/execution`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch {
    // Nothing was read from the backend, so nothing is claimed about the account.
    return Response.json(
      {
        error:
          `Execution backend unreachable at ${target}. No execution state is shown because none could be read; ` +
          "the authoritative record and worker are on that host, not this one.",
        backend: target,
        reachable: false,
      },
      {
        status: 503,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-meridian-backend": target },
      },
    );
  }
  // The backend is the authority on status codes too: a 401 for a missing or
  // wrong operator key, a 409 for a stale signal, its own 503 — all forwarded.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-meridian-backend": target,
    },
  });
}

export const Route = createFileRoute("/api/execution")({ server: { handlers: {
  POST: async ({ request }) => {
    const target = proxyTarget(request);
    if (target !== null) return relay(request, target);
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
