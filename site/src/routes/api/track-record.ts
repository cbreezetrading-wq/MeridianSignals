import { createFileRoute } from "@tanstack/react-router";

import { RULESET_VERSION } from "~/lib/market/ruleset";
import { buildTrackRecordPayload } from "~/lib/market/trackRecord";

/**
 * JSON view of the signal record, so the log can be read without the page.
 *
 * Query parameters (both optional):
 *   ?limit=N   how many records to return, newest first (1..500, default 100)
 *   ?full=1    re-walk the whole log to verify the hash chain instead of using the
 *              cached verdict for the current file revision
 *
 * Server-only: reads the append-only log from disk. No upstream request is made.
 */
export const Route = createFileRoute("/api/track-record")({
  server: {
    handlers: {
      GET: async (ctx: { request: Request }) => {
        const url = new URL(ctx.request.url);
        const rawLimit = Number(url.searchParams.get("limit") ?? "");
        const payload = await buildTrackRecordPayload({
          limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined,
          verifyFull: url.searchParams.get("full") === "1",
          rulesetVersion: RULESET_VERSION,
        });
        return Response.json(payload, {
          headers: {
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json; charset=utf-8",
          },
        });
      },
    },
  },
});
