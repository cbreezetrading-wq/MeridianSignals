import { createFileRoute } from "@tanstack/react-router";

import { loadBacktestResults } from "~/lib/market/backtestResults";

/**
 * JSON mirror of /backtest, from the same module the page's loader uses, so the
 * rendered page and the endpoint can never disagree.
 */
export const Route = createFileRoute("/api/backtest")({
  server: {
    handlers: {
      GET: async () => {
        const load = await loadBacktestResults();
        if (!load.ok) {
          return Response.json(
            { ok: false, error: load.error },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, payload: load.payload },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
