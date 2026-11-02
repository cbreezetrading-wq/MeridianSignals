import { createFileRoute } from "@tanstack/react-router";

import { loadBacktestResults } from "~/lib/market/backtestResults";

/**
 * JSON mirror of /backtest, from the same module the page's loader uses, so the
 * rendered page and the endpoint can never disagree — including where the bytes came
 * from: `provenance` says whether this answer was read from the owner's file on this
 * machine or from the snapshot bundled into this build, with its sha256 and copy time.
 */
export const Route = createFileRoute("/api/backtest")({
  server: {
    handlers: {
      GET: async () => {
        const load = await loadBacktestResults();
        if (!load.ok) {
          return Response.json(
            { ok: false, error: load.error, skipped: load.skipped },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, payload: load.payload, provenance: load.provenance },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
