/**
 * The console's report actions, with the authentication decision in ONE place.
 *
 * Why a module rather than code inline in the route: the auth behaviour of the console is a
 * safety property, and a safety property that can only be exercised by hand through a
 * browser is not tested. `handleReportAction` is the exact function the route calls; the
 * tests call it with no key, a wrong key, a short configured key and the right key, and
 * assert the status and body of the Response it returns.
 *
 * The rules it keeps:
 *  - every request needs the operator key, sent as `Authorization: Bearer <key>`, compared in
 *    constant time, and only against a key of at least 32 characters (a shorter secret is
 *    treated as "not configured", so a misconfiguration locks the console rather than
 *    opening it);
 *  - a refusal says nothing about the account, the record or the report — only that access is
 *    locked;
 *  - the key is read from the server's environment, never from the request body, never
 *    echoed into a response or a log;
 *  - generating a report is the ONLY side effect, and it submits nothing to the broker.
 */

import { timingSafeEqual } from "node:crypto";
import { createClient, redactDeep } from "./client.ts";
import { loadConfigFromDisk } from "./config.ts";
import { generateReport, readLatestReport, scrubAccountIds, type LatestReport } from "../report.ts";

export const MIN_OPERATOR_KEY_LENGTH = 32;

export type AuthDecision = { ok: true } | { ok: false; reason: string };

/**
 * The console's authentication decision. Constant-time comparison, minimum key length, no
 * distinction between "no header", "wrong key" and "no key configured" in the response.
 */
export function authorizeOperatorKey(authorization: string | null | undefined, secret: string | null | undefined): AuthDecision {
  const key = (secret ?? "").trim();
  if (key.length < MIN_OPERATOR_KEY_LENGTH) {
    return { ok: false, reason: "the operator key is not configured on this server (or is shorter than 32 characters), so nothing is served" };
  }
  const supplied = (authorization ?? "").trim();
  if (supplied === "") return { ok: false, reason: "no operator key was supplied" };
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(`Bearer ${key}`, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "the operator key did not match" };
  return { ok: true };
}

export const REPORT_ACTIONS = ["report", "generate-report"] as const;
export type ReportActionName = (typeof REPORT_ACTIONS)[number];

export function isReportAction(action: unknown): action is ReportActionName {
  return typeof action === "string" && (REPORT_ACTIONS as readonly string[]).includes(action);
}

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (body: unknown, status = 200): Response => Response.json(redactDeep(body), { status, headers });

export type ReportActionDeps = {
  /** Defaults to process.env.MERIDIAN_OPERATOR_KEY. Injectable for the tests. */
  operatorKey?: string | null;
  /** Defaults to reading the newest report from the reports directory. */
  readLatest?: () => Promise<LatestReport | null>;
  /** Defaults to generating one against the live Practice account. Injectable for the tests. */
  generate?: (action: ReportActionName) => Promise<{ reportId: string; generatedAt: string; text: string; json: unknown; notification: unknown; recordSeq: number | null }>;
};

export type ReportActionInput = {
  action: ReportActionName;
  authorization: string | null;
  deps?: ReportActionDeps;
};

/**
 * Handle `report` (read the newest report) or `generate-report` (build one now).
 *
 * Both require the operator key. Neither touches an order: `generate-report` reads the
 * record and the broker and writes files — it cannot submit, cancel or modify anything.
 */
export async function handleReportAction(input: ReportActionInput): Promise<Response> {
  const deps = input.deps ?? {};
  const secret = deps.operatorKey !== undefined ? deps.operatorKey : (process.env.MERIDIAN_OPERATOR_KEY ?? null);
  const auth = authorizeOperatorKey(input.authorization, secret);
  if (!auth.ok) {
    // Nothing about the account, the record or any report is disclosed on a refusal.
    return json({ error: "Execution access is locked. Configure a separate operator key of at least 32 characters on the server." }, 401);
  }

  const readLatest = deps.readLatest ?? (() => readLatestReport());
  const generate =
    deps.generate ??
    (async () => {
      const config = await loadConfigFromDisk();
      const result = await generateReport({
        client: createClient(),
        config,
        trigger: "CONSOLE",
        triggerDetail: "generated on request from the authenticated console",
      });
      return {
        reportId: result.report.reportId,
        generatedAt: result.report.generatedAt,
        text: result.text,
        json: result.report,
        notification: result.notification,
        recordSeq: result.recordSeq,
      };
    });

  try {
    if (input.action === "generate-report") {
      const generated = await generate(input.action);
      return json({ report: generated.json, text: generated.text, notification: generated.notification, recordSeq: generated.recordSeq });
    }
    const latest = await readLatest();
    if (!latest) {
      return json(
        {
          report: null,
          text: null,
          note:
            "No report has been generated yet. The watcher generates one on its interval and immediately after any fill, close, refusal or error; this button generates one now.",
        },
        200,
      );
    }
    return json({ report: latest.json, text: latest.text, generatedAt: latest.generatedAt, reportId: latest.reportId });
  } catch (error) {
    // A failed generation is reported as a failure. It is never dressed up as a report.
    return json(
      {
        error: "The report could not be generated. Nothing was sent anywhere and no order was touched; inspect the server log and the execution record.",
        detail: scrubAccountIds(error instanceof Error ? error.message : String(error)),
      },
      503,
    );
  }
}
