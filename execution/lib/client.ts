/**
 * OANDA v20 execution client — Practice only.
 *
 * This is a SEPARATE client from src/lib/market/oanda.ts, which is a read-only
 * market-data module with a frozen three-GET whitelist. That file is untouched.
 *
 * Design notes that matter for safety:
 *
 *  - There is no generic `request(method, path)` function. Every operation is a
 *    named method that builds its own URL through practiceUrl() (which asserts the
 *    host) and then asserts again before fetch. You cannot pass an arbitrary path.
 *  - The token is read from process.env.OANDA at call time, goes into the
 *    Authorization header only, and is scrubbed from anything this module returns.
 *  - `transport` exists solely so a verification script can simulate a dropped
 *    connection at the socket layer without ever pointing at a different host. The
 *    URL assertion runs BEFORE the transport is chosen, so an injected transport
 *    cannot widen the target set.
 */

import { assertPracticeTarget, practiceUrl, InterlockError } from "./interlock.ts";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (url, init) => fetch(url, init);

export type ClientOptions = {
  /** Verification seam only. The URL is still asserted to be the Practice host. */
  transport?: Transport;
  timeoutMs?: number;
};

export type BrokerResponse = {
  ok: boolean;
  status: number;
  /** Parsed JSON when the body was JSON, else null. */
  body: any;
  /** Raw text, always kept so a broker error can be quoted verbatim. */
  text: string;
  /** The request as it would be logged, token redacted. */
  request: { method: string; path: string; body: unknown };
  sentAt: string;
  receivedAt: string;
  durationMs: number;
};

export type BrokerFailure = {
  ok: false;
  /** True when we never got a response: connection dropped, aborted, timed out. */
  transportFailure: true;
  error: string;
  request: { method: string; path: string; body: unknown };
  sentAt: string;
  receivedAt: string;
  durationMs: number;
};

function token(): string {
  const t = process.env.OANDA ?? "";
  if (t.trim() === "") {
    throw new Error("No OANDA credential configured: process.env.OANDA is empty.");
  }
  return t.trim();
}

/** Remove the credential from any string before it can reach a log or a payload. */
export function redact(input: string): string {
  const secret = process.env.OANDA ?? "";
  if (secret === "") return input;
  let out = input;
  if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  // Also scrub the two halves, in case a broker echo ever splits them.
  const parts = secret.split("-").filter((p) => p.length >= 16);
  for (const p of parts) out = out.split(p).join("[REDACTED]");
  return out;
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

export type Client = ReturnType<typeof createClient>;

export function createClient(options: ClientOptions = {}) {
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = options.timeoutMs ?? 20_000;

  /**
   * The single place a request is sent. `path` must already be a practice-relative
   * path; the URL is rebuilt here from the frozen origin and asserted again.
   */
  async function send(method: string, path: string, body: unknown): Promise<BrokerResponse | BrokerFailure> {
    // Assertion #2: immediately before the request leaves. Nothing below this line
    // can run against a non-practice host.
    const url = practiceUrl(path);
    assertPracticeTarget(url);
    const sentAt = new Date().toISOString();
    const startedAt = Date.now();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const request = { method, path, body: body === undefined ? null : (redactDeep(body) as unknown) };
    try {
      const res = await transport(url, {
        method,
        redirect: "error",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const receivedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;
      let parsed: any = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        body: parsed,
        text: redact(text),
        request,
        sentAt,
        receivedAt,
        durationMs,
      };
    } catch (error) {
      const receivedAt = new Date().toISOString();
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return {
        ok: false,
        transportFailure: true,
        error: redact(message),
        request,
        sentAt,
        receivedAt,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /* ---------------------------------------------------------------- account reads */

  const accountId = (): string => {
    const id = process.env.OANDA_ACCOUNT_ID?.trim();
    if (!id) throw new Error("process.env.OANDA_ACCOUNT_ID is not set; refusing to guess an account.");
    return id;
  };

  return {
    /** GET /v3/accounts — which accounts does this token see? */
    accounts: () => send("GET", "/v3/accounts", undefined),
    /** GET /v3/accounts/{id}/summary — equity, margin, currency, counts. */
    summary: () => send("GET", `/v3/accounts/${accountId()}/summary`, undefined),
    /** GET /v3/accounts/{id}/instruments — minimum size and precision per instrument. */
    instruments: () => send("GET", `/v3/accounts/${accountId()}/instruments`, undefined),
    /** GET pricing for named instruments. */
    pricing: (instruments: string[]) =>
      send("GET", `/v3/accounts/${accountId()}/pricing?instruments=${instruments.join(",")}`, undefined),
    /** GET open positions. */
    openPositions: () => send("GET", `/v3/accounts/${accountId()}/openPositions`, undefined),
    /** GET open trades (a trade is one filled order, and carries its attached stops). */
    openTrades: () => send("GET", `/v3/accounts/${accountId()}/openTrades`, undefined),
    /** GET orders by state: PENDING | FILLED | CANCELLED | ALL. */
    orders: (state: "PENDING" | "FILLED" | "CANCELLED" | "ALL" = "ALL") =>
      send("GET", `/v3/accounts/${accountId()}/orders?state=${state}&count=500`, undefined),
    /** GET a single order by broker id. */
    order: (orderId: string) => send("GET", `/v3/accounts/${accountId()}/orders/${orderId}`, undefined),
    /** GET a single trade by broker id — this is how a stop is read back. */
    trade: (tradeId: string) => send("GET", `/v3/accounts/${accountId()}/trades/${tradeId}`, undefined),
    /** GET a transaction by id (used to read back the fill that created a trade). */
    transaction: (txId: string) => send("GET", `/v3/accounts/${accountId()}/transactions/${txId}`, undefined),

    /* ------------------------------------------------------------- order placement */

    /**
     * POST /v3/accounts/{id}/orders — the only write that creates exposure.
     * The URL is built from the frozen practice origin by practiceUrl(); there is no
     * parameter here that can change the host.
     */
    createOrder: (payload: unknown) => send("POST", `/v3/accounts/${accountId()}/orders`, payload),

    /* ---------------------------------------------------------------- stop controls */

    /** PUT cancel a pending order (control #2). */
    cancelOrder: (orderId: string) => send("PUT", `/v3/accounts/${accountId()}/orders/${orderId}/cancel`, {}),
    /** PUT close a whole position (control #3). */
    closePosition: (instrument: string) =>
      send("PUT", `/v3/accounts/${accountId()}/positions/${instrument}/close`, { longUnits: "ALL", shortUnits: "ALL" }),
    /** PUT close one trade by id (control #3, trade granularity). */
    closeTrade: (tradeId: string) => send("PUT", `/v3/accounts/${accountId()}/trades/${tradeId}/close`, { units: "ALL" }),
  };
}

export { InterlockError };
