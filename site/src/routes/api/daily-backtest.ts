import { createFileRoute } from "@tanstack/react-router";

import { loadDailyBacktestResults } from "~/lib/market/dailyBacktestResults";

/**
 * JSON mirror of /backtest/daily, from the same module the page's loader uses, so
 * the rendered page and the endpoint can never disagree — including where the bytes
 * came from: `provenance` says whether this answer was read from the owner's file on
 * this machine or from the snapshot bundled into this build, with its sha256 and
 * copy time.
 */
export const Route = createFileRoute("/api/daily-backtest")({
  server: {
    handlers: {
      GET: async () => {
        const load = await loadDailyBacktestResults();
        if (!load.ok) {
          return Response.json(
            { ok: false, error: load.error, skipped: load.skipped },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, payload: load.payload, derived: load.derived, provenance: load.provenance },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
