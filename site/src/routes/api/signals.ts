import { createFileRoute } from "@tanstack/react-router";
import { getSignals } from "~/lib/market/service";

/**
 * JSON endpoint: the same numbers the dashboard renders, so they can be checked
 * independently. Server-only — `getSignals()` fetches the upstream bars here and
 * never in the visitor's browser.
 */
export const Route = createFileRoute("/api/signals")({
  server: {
    handlers: {
      GET: async () => {
        const payload = await getSignals();
        return Response.json(payload, {
          headers: {
            // The payload carries its own fetch timestamps; caching it at the edge
            // would make "last successful fetch" a lie.
            "cache-control": "no-store, max-age=0",
            "content-type": "application/json; charset=utf-8",
          },
        });
      },
    },
  },
});
