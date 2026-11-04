/**
 * Delivery seam for the execution report.
 *
 * WHY THIS FILE EXISTS: automatic Practice execution is live and the owner is notified of
 * nothing. An order can fill while nobody is looking, and the only trace is the console and
 * the append-only record. This module is the place a real delivery channel plugs into.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent one. The default transport is `none`. With no
 * transport configured, `deliverReport` records the exact sentence
 *
 *     no notification channel configured — report generated, nothing sent
 *
 * in the report and in the log, and returns delivered:false. It never claims a message was
 * delivered, because none was. A channel that "looks delivered" in a report would be a lie in
 * the one document the owner is meant to trust when they are not watching.
 *
 * THE CHANNEL THE OWNER CHOSE: EMAIL (2026-11-04; push and SMS were considered and declined,
 * and there is no SMS capability here). `./emailTransport.ts` is that channel — a real SMTP
 * client — and it is registered below under the name "email". It is inert until all three
 * secrets exist: with any of MERIDIAN_SMTP_USER, MERIDIAN_SMTP_PASS, MERIDIAN_ALERT_TO
 * missing, `configured()` is false, nothing connects anywhere, and the report carries the
 * missing VARIABLE NAMES rather than a claim of delivery.
 *
 * HOW ANOTHER CHANNEL IS ADDED (the rest of the seam):
 *
 *     import { registerTransport } from "./notify.ts";
 *     registerTransport("push", () => ({
 *       id: "push",
 *       describe: () => "push to the device registered out of band",
 *       configured: () => Boolean(process.env.SOMETHING),
 *       unconfiguredDetail: () => "push is not configured: SOMETHING is not set; nothing was sent",
 *       send: async (payload) => ({ delivered: true, detail: "accepted by the push service" }),
 *     }));
 *
 * and set `"transport": "push"` under `report` in config.json. `send` must return
 * delivered:true only after the channel has actually accepted the message. Anything else —
 * a timeout, a refusal, an unconfigured address — must come back delivered:false with a
 * truthful detail, and the report will say nothing was delivered.
 */

import { redact } from "./lib/client.ts";
import { createEmailTransport } from "./emailTransport.ts";

/** The exact sentence recorded when no channel is configured. Asserted by the tests. */
export const NO_TRANSPORT_DETAIL = "no notification channel configured — report generated, nothing sent";

export type NotificationPayload = {
  reportId: string;
  generatedAt: string;
  /** One line, suitable for a subject line. Never claims a delivery. */
  subject: string;
  /** The human-readable report, verbatim. */
  text: string;
  /** The machine-readable report. */
  json: unknown;
};

/** One recorded attempt. The email transport fills this in; a transport may omit it. */
export type NotificationAttempt = {
  attempt: number;
  endpoint: string;
  stage: string;
  ok: boolean;
  smtpCode: number | null;
  detail: string;
  at: string;
};

export type NotificationSendOutcome = {
  delivered: boolean;
  detail: string;
  configured?: boolean;
  stage?: string | null;
  smtpCode?: number | null;
  messageId?: string | null;
  attempts?: NotificationAttempt[];
};

export type NotificationTransport = {
  /** Short stable id, stored in the report. */
  id: string;
  /** Human description of what this transport would do. Shown in the report. */
  describe: () => string;
  /**
   * Whether the transport has what it needs to deliver. A transport that is registered but
   * unconfigured (no address, no key) must answer false: the report then says nothing was
   * sent, rather than reporting a failure as an attempt.
   */
  configured: () => boolean;
  /**
   * What to record when the transport is not configured. A transport that needs named
   * settings should name them here (variable NAMES only, never values) instead of leaving
   * the report to say the generic sentence. Optional: the default is NO_TRANSPORT_DETAIL.
   */
  unconfiguredDetail?: () => string;
  /** Deliver. `delivered:true` only when the channel actually accepted the message. */
  send: (payload: NotificationPayload) => Promise<NotificationSendOutcome>;
};

export type NotificationResult = {
  /** Transport id, or "none". */
  transport: string;
  /** What the transport would have done, in words. */
  transportDescription: string;
  /** True only when a transport is registered AND says it is configured. */
  configured: boolean;
  /** True only when the transport's send() returned delivered:true. Never inferred. */
  delivered: boolean;
  /** The sentence the report carries. With no channel: NO_TRANSPORT_DETAIL, verbatim. */
  detail: string;
  attemptedAt: string;
  /** The stage the last attempt reached. Present only when a transport reports attempts. */
  stage?: string | null;
  /** The final SMTP code, when there was one. */
  smtpCode?: number | null;
  /** The server's message-id, when it gave one. */
  messageId?: string | null;
  /**
   * One entry per attempt, in order. Present only when a transport reports attempts: a
   * flapping mailbox must be visible in the report, not silently retried.
   */
  attempts?: NotificationAttempt[];
};

const noneTransport: NotificationTransport = {
  id: "none",
  describe: () => "none — the default: reports are generated and stored, nothing is sent anywhere",
  configured: () => false,
  send: async () => ({ delivered: false, detail: NO_TRANSPORT_DETAIL }),
};

const registry = new Map<string, () => NotificationTransport>([
  ["none", () => noneTransport],
  // The channel the owner chose on 2026-11-04. Registered unconditionally: it reports itself
  // unconfigured (and connects nowhere) until its three secrets exist.
  ["email", () => createEmailTransport()],
]);

/** Register a transport under a config name. Later channels plug in here and nowhere else. */
export function registerTransport(id: string, factory: () => NotificationTransport): void {
  if (id.trim() === "" || id === "none") throw new Error("a transport id must be non-empty and not \"none\"");
  registry.set(id, factory);
}

export function knownTransports(): string[] {
  return [...registry.keys()].sort();
}

export type ResolvedTransport = {
  transport: NotificationTransport;
  /** What config asked for. */
  requested: string;
  /** Set when the request could not be honoured, so the report can say why. */
  problem: string | null;
};

/**
 * Resolve a transport name from config. An unknown name falls back to `none` and says so:
 * a typo in config must never become a silent "delivered" or a crash in the watcher.
 */
export function resolveTransport(requested: string | undefined | null): ResolvedTransport {
  const name = (requested ?? "none").trim() || "none";
  const factory = registry.get(name);
  if (!factory) {
    return {
      transport: noneTransport,
      requested: name,
      problem: `notification transport "${name}" is not registered in this build (known: ${knownTransports().join(", ")}); nothing will be sent`,
    };
  }
  return { transport: factory(), requested: name, problem: null };
}

/**
 * Deliver a report, honestly.
 *
 * Never throws: a delivery failure must not stop the watcher, and it must not be able to
 * make a report look delivered. Every path returns an explicit result the report stores.
 */
export async function deliverReport(
  payload: NotificationPayload,
  options: { transport?: NotificationTransport; log?: (line: string) => void } = {},
): Promise<NotificationResult> {
  const transport = options.transport ?? noneTransport;
  const log = options.log ?? ((line: string) => console.log(line));
  const attemptedAt = new Date().toISOString();
  const base = { transport: transport.id, transportDescription: transport.describe(), attemptedAt };

  if (!transport.configured()) {
    // A transport that knows what it is missing names the settings here (variable names
    // only). The default stays the exact sentence the tests assert.
    const unconfigured = redact(transport.unconfiguredDetail?.() ?? NO_TRANSPORT_DETAIL);
    log(unconfigured);
    return { ...base, configured: false, delivered: false, detail: unconfigured };
  }

  try {
    const result = await transport.send(payload);
    const delivered = result.delivered === true;
    const detail = redact(result.detail);
    if (!delivered) log(`notification NOT delivered by ${transport.id}: ${detail}`);
    return {
      ...base,
      configured: true,
      delivered,
      detail,
      ...(result.stage !== undefined ? { stage: result.stage } : {}),
      ...(result.smtpCode !== undefined ? { smtpCode: result.smtpCode } : {}),
      ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
      ...(result.attempts !== undefined ? { attempts: result.attempts.map((attempt) => ({ ...attempt, detail: redact(attempt.detail) })) } : {}),
    };
  } catch (error) {
    // A thrown transport is a failed delivery, never a delivered one.
    const detail = redact(`transport ${transport.id} threw: ${error instanceof Error ? error.message : String(error)}; nothing was delivered`);
    log(detail);
    return { ...base, configured: true, delivered: false, detail };
  }
}
