import { createFileRoute } from "@tanstack/react-router";

import { loadDailyBacktestResults } from "~/lib/market/dailyBacktestResults";

/**
 * JSON mirror of /backtest/daily, from the same module the page's loader uses,
 * so the rendered page and the endpoint can never disagree.
 */
export const Route = createFileRoute("/api/daily-backtest")({
  server: {
    handlers: {
      GET: async () => {
        const load = await loadDailyBacktestResults();
        if (!load.ok) {
          return Response.json(
            { ok: false, error: load.error },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, payload: load.payload, derived: load.derived },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
