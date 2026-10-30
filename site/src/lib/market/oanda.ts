/**
 * OANDA v20 market-data client — READ ONLY. This file is a market-data reader and
 * nothing else.
 *
 * HARD CONSTRAINT — the only upstream calls this codebase is permitted to make are
 * these three GET endpoints, and nothing else:
 *
 *   GET /v3/accounts
 *   GET /v3/accounts/{accountID}/pricing
 *   GET /v3/instruments/{instrument}/candles
 *
 * It must NEVER call /v3/accounts/{id}/orders, /v3/accounts/{id}/trades,
 * /v3/accounts/{id}/positions, /v3/accounts/{id}/transactions, /v3/accounts/{id}/orders/preview
 * or any other endpoint, and must never use a non-GET method. There is no order
 * placement, no trade management and no account mutation anywhere in this project.
 *
 * How that is enforced rather than merely intended: every request goes through
 * oandaGet() below, which (a) matches the path against an exact, frozen whitelist of
 * the three permitted URL templates, (b) refuses any path containing an order/trade/
 * position/transaction segment outright, and (c) never passes a method to fetch, so
 * GET is the only verb that can be sent. Adding an order endpoint would mean editing
 * the frozen list in a file whose top comment says not to — it cannot happen by
 * accident from a caller.
 *
 * Secrets: the API token is read from process.env.OANDA at call time. It goes into
 * the Authorization header only. It is never logged, never returned in a payload,
 * never written to a file and never placed in a URL. Anything this module returns is
 * safe to render on the page.
 */

import type { Bar, Quote } from "./types";

/* --------------------------------------------------------------- configuration */

/** Practice by default. The practice-vs-funded choice is the owner's, not ours. */
const DEFAULT_BASE = "https://api-fxpractice.oanda.com";

export function oandaBaseUrl(): string {
  return (process.env.OANDA_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

/** Host → account type, derived from the host name rather than guessed. */
export function oandaAccountType(): "practice" | "live" | "unknown" {
  const host = oandaBaseUrl().toLowerCase();
  if (host.includes("fxpractice")) return "practice";
  if (host.includes("fxtrade")) return "live";
  return "unknown";
}

function token(): string {
  return process.env.OANDA ?? "";
}

/* ------------------------------------------------------- the read-only whitelist */

/**
 * The three permitted request shapes. {ACCOUNT} is substituted with the resolved
 * account id. Nothing else may be requested through this module.
 */
const ALLOWED_PATHS = Object.freeze([
  "/v3/accounts",
  "/v3/accounts/{ACCOUNT}/pricing",
  "/v3/instruments/{INSTRUMENT}/candles",
] as const);

/**
 * Path segments that would indicate an account-mutating or trade-related endpoint.
 * A caller that somehow builds one of these is rejected before any request is made.
 */
const FORBIDDEN_SEGMENTS = Object.freeze([
  "orders",
  "order",
  "trades",
  "trade",
  "positions",
  "position",
  "transactions",
  "transaction",
  "close",
  "cancel",
]);

function assertReadOnlyPath(path: string): void {
  const pathOnly = path.split("?")[0] ?? path;
  const segments = pathOnly.split("/").filter((s) => s !== "");
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.includes(segment.toLowerCase())) {
      throw new Error(
        `Refused: "${segment}" is not a market-data endpoint. This client is read-only and may only GET accounts, pricing and candles.`,
      );
    }
  }
  const matches = ALLOWED_PATHS.some((template) => {
    const pattern =
      "^" +
      template
        .split("/")
        .map((part) => (part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") +
      "$";
    return new RegExp(pattern).test(pathOnly);
  });
  if (!matches) {
    throw new Error(
      `Refused: ${pathOnly} is not one of the three permitted read-only paths (${ALLOWED_PATHS.join(", ")}).`,
    );
  }
}

export type OandaError = { status: number; message: string; detail: string };

type OandaResponse = { ok: true; body: unknown } | { ok: false; error: OandaError };

/**
 * The single guarded request function. GET only — there is no method parameter to
 * pass, which is the structural part of the read-only guarantee. The token never
 * appears in the URL or in anything this function returns.
 */
async function oandaGet(path: string, timeoutMs: number): Promise<OandaResponse> {
  assertReadOnlyPath(path);
  const secret = token();
  if (secret === "") {
    return {
      ok: false,
      error: { status: 0, message: "No OANDA API token is configured.", detail: "process.env.OANDA is empty." },
    };
  }
  const url = `${oandaBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status !== 200) {
      return {
        ok: false,
        error: {
          status: res.status,
          message: `OANDA answered HTTP ${String(res.status)}.`,
          detail: `GET ${path} -> ${String(res.status)} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`,
        },
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          status: res.status,
          message: "OANDA returned a response that is not JSON.",
          detail: `GET ${path} -> body starts: ${text.slice(0, 160)}`,
        },
      };
    }
    return { ok: true, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        status: 0,
        message: "Could not reach OANDA.",
        detail: `GET ${path} -> ${message}`,
      },
    };
  }
}

/* --------------------------------------------------------------- account lookup */

let accountIdCache: { id: string; fetchedAtMs: number } | null = null;

/**
 * Resolve the account id: an explicit OANDA_ACCOUNT_ID wins; otherwise ask
 * /v3/accounts (the token itself determines the account). Cached for 10 minutes.
 */
export async function resolveAccountId(): Promise<{ ok: true; id: string } | { ok: false; error: OandaError }> {
  const override = process.env.OANDA_ACCOUNT_ID;
  if (override && override.trim() !== "") return { ok: true, id: override.trim() };
  if (accountIdCache && Date.now() - accountIdCache.fetchedAtMs < 600_000) {
    return { ok: true, id: accountIdCache.id };
  }
  const res = await oandaGet("/v3/accounts", 15_000);
  if (!res.ok) return res;
  const accounts = (res.body as { accounts?: Array<{ id?: string }> }).accounts ?? [];
  const id = accounts[0]?.id;
  if (typeof id !== "string" || id === "") {
    return {
      ok: false,
      error: { status: 200, message: "OANDA returned no account for this token.", detail: "GET /v3/accounts -> accounts[] was empty." },
    };
  }
  accountIdCache = { id, fetchedAtMs: Date.now() };
  return { ok: true, id };
}

/* -------------------------------------------------------------------- candles */

/**
 * H1 candles are cached for 15 s. Rationale (see the report and ruleset.md):
 *  - the 60 s window was inherited from the FREE source, whose 300 s window was set
 *    for a rate-limited endpoint. On the broker feed that inherited window became
 *    the LARGEST single contributor to how stale the screen can be: it delays the
 *    moment a newly-completed bar can be seen far more than the feed itself does
 *    (the broker serves the bar ~1.3 s after the hour).
 *  - 15 s is the smallest window that still bounds upstream traffic to a trivial,
 *    clearly-safe level: one candle request per pair per 15 s is at most 16 requests
 *    per minute across all four pairs, well inside OANDA's documented per-token
 *    limit, and the page itself only re-reads every 60 s.
 *  - what remains after this change is the 60 s page refresh, which the browser
 *    controls; that ceiling is stated on the page rather than hidden.
 * This is a caching choice only: no bar, indicator, level or rule changes.
 */
export const CANDLE_CACHE_SECONDS = 15;

/** Live pricing: one upstream request per instrument set at most every 5 s. */
export const PRICING_CACHE_SECONDS = 5;

const CANDLE_CACHE_MS = CANDLE_CACHE_SECONDS * 1000;
const PRICING_CACHE_MS = PRICING_CACHE_SECONDS * 1000;

/** Bar counts: 500 H1 bars is ~3 weeks, comfortably above the ruleset's 210 minimum. */
const CANDLE_COUNT = 500;

export type OandaCandlesOk = {
  ok: true;
  bars: Bar[];
  fetchedAt: string;
  upstreamUrl: string;
  source: string;
  granularityNote: string;
  upstream: Record<string, string | number | boolean | null>;
  /** Bars OANDA returned that were refused, and why. Shown for auditability. */
  rejected: { incompleteBar: number; malformedBar: number };
  fromCache: boolean;
};

export type OandaCandlesErr = {
  ok: false;
  error: string;
  detail: string;
  attemptedAt: string;
  upstreamUrl: string;
  source: string;
};

type CandleCacheEntry = { result: OandaCandlesOk; storedAtMs: number };
const candleCache = new Map<string, CandleCacheEntry>();

const SOURCE_LABEL = (): string =>
  `OANDA v20 ${oandaAccountType()} — hourly bars (complete-flag confirmed)`;

const GRANULARITY_NOTE = (): string =>
  `Hourly (H1) candles from the owner's OANDA v20 ${oandaAccountType()} account, request price=MBA, MID series used for every indicator and level. Only candles OANDA flags complete: true are used — an unfinished bar is refused, never filled in. Bar times are UTC and label the bar's OPEN. This is broker bar data, not a tick quote; the bid/ask shown alongside is a separate snapshot.`;

/** One numeric field of a candle's price object, or null when it is missing/unparseable. */
function num(value: unknown): number | null {
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * Fetch H1 candles for one instrument, using the MID series and ONLY bars OANDA has
 * flagged complete. Never throws: every failure path returns an OandaCandlesErr.
 */
export async function fetchOandaCandles(instrument: string): Promise<OandaCandlesOk | OandaCandlesErr> {
  const key = `${instrument}:H1`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.storedAtMs < CANDLE_CACHE_MS) {
    return { ...cached.result, fromCache: true };
  }

  const attemptedAt = new Date().toISOString();
  const query = `granularity=H1&count=${String(CANDLE_COUNT)}&price=MBA`;
  const path = `/v3/instruments/${instrument}/candles?${query}`;
  const upstreamUrl = `${oandaBaseUrl()}${path}`; // safe: the token is a header, never a query param

  const res = await oandaGet(path, 20_000);
  if (!res.ok) {
    return {
      ok: false,
      error: res.error.message,
      detail: res.error.detail,
      attemptedAt,
      upstreamUrl,
      source: SOURCE_LABEL(),
    };
  }

  const candles = (res.body as { candles?: unknown[] }).candles;
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      ok: false,
      error: "OANDA returned no candles for this pair.",
      detail: `GET ${path} -> candles[] was missing or empty.`,
      attemptedAt,
      upstreamUrl,
      source: SOURCE_LABEL(),
    };
  }

  const bars: Bar[] = [];
  let incompleteBar = 0;
  let malformedBar = 0;
  const times: number[] = [];
  for (const raw of candles) {
    const c = raw as { complete?: unknown; time?: unknown; mid?: Record<string, unknown> };
    if (c.complete !== true) {
      incompleteBar += 1;
      continue;
    }
    const t = typeof c.time === "string" ? Date.parse(c.time) : NaN;
    const o = num(c.mid?.o);
    const h = num(c.mid?.h);
    const l = num(c.mid?.l);
    const cl = num(c.mid?.c);
    if (!Number.isFinite(t) || o === null || h === null || l === null || cl === null) {
      malformedBar += 1;
      continue;
    }
    bars.push({ t: Math.floor(t / 1000), o, h, l, c: cl });
    times.push(Math.floor(t / 1000));
  }
  bars.sort((a, b) => a.t - b.t);
  times.sort((a, b) => a - b);

  const MIN_BARS = 210; // EMA(200) plus a previous bar: below this the ruleset cannot run.
  if (bars.length < MIN_BARS) {
    return {
      ok: false,
      error: `OANDA returned only ${String(bars.length)} complete hourly bars — the ruleset needs at least ${String(MIN_BARS)}.`,
      detail: `GET ${path} -> ${String(bars.length)} complete, well-formed bars; ${String(incompleteBar)} unfinished refused.`,
      attemptedAt,
      upstreamUrl,
      source: SOURCE_LABEL(),
    };
  }

  const lastCompleteT = times[times.length - 1]!;
  const outcome: OandaCandlesOk = {
    ok: true,
    bars,
    fetchedAt: new Date().toISOString(),
    upstreamUrl,
    source: SOURCE_LABEL(),
    granularityNote: GRANULARITY_NOTE(),
    upstream: {
      instrument,
      granularity: "H1",
      priceSeries: "M (mid)",
      requestedPrice: "MBA",
      completeFlagEnforced: true,
      completeBarsUsed: bars.length,
      incompleteBarsRefused: incompleteBar,
      newestCompleteBarUtc: new Date(lastCompleteT * 1000).toISOString(),
      newestCompleteBarAgeSeconds: Math.round(Date.now() / 1000 - lastCompleteT),
      endpoint: "/v3/instruments/{instrument}/candles",
    },
    rejected: { incompleteBar, malformedBar },
    fromCache: false,
  };
  candleCache.set(key, { result: outcome, storedAtMs: Date.now() });
  return outcome;
}

/* -------------------------------------------------------------------- pricing */

export type PricingResult = {
  ok: boolean;
  /** Per instrument, keyed by OANDA instrument name. Empty on total failure. */
  quotes: Record<string, Quote>;
  fetchedAt: string;
  fromCache: boolean;
  upstreamUrl: string | null;
  accountType: "practice" | "live" | "unknown";
  /** Plain-English reason when the whole pricing call failed. */
  error: string | null;
  detail: string | null;
  source: string;
};

const PRICING_SOURCE = (): string =>
  `OANDA v20 ${oandaAccountType()} account pricing (indicative broker bid/ask)`;

let pricingCache: { result: PricingResult; storedAtMs: number } | null = null;

function pipSizeFor(instrument: string): number {
  // Conventional FX pip: 0.01 on a JPY-quoted pair, 0.0001 otherwise.
  return instrument.toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

function emptyPricing(error: string, detail: string, upstreamUrl: string | null): PricingResult {
  return {
    ok: false,
    quotes: {},
    fetchedAt: new Date().toISOString(),
    fromCache: false,
    upstreamUrl,
    accountType: oandaAccountType(),
    error,
    detail,
    source: PRICING_SOURCE(),
  };
}

/**
 * Current bid/ask for a set of instruments, in ONE upstream request, cached for at
 * least 5 s. Never throws.
 */
export async function fetchOandaPricing(instruments: string[]): Promise<PricingResult> {
  if (pricingCache && Date.now() - pricingCache.storedAtMs < PRICING_CACHE_MS) {
    return { ...pricingCache.result, fromCache: true };
  }

  const account = await resolveAccountId();
  if (!account.ok) {
    const result = emptyPricing(account.error.message, account.error.detail, null);
    return result;
  }

  const list = instruments.join(",");
  const path = `/v3/accounts/${account.id}/pricing?instruments=${list}`;
  const upstreamUrl = `${oandaBaseUrl()}/v3/accounts/{accountID}/pricing?instruments=${list}`;

  const res = await oandaGet(path, 15_000);
  if (!res.ok) {
    const result = emptyPricing(res.error.message, res.error.detail, upstreamUrl);
    // A failed pricing call is deliberately NOT cached: the next request retries.
    return result;
  }

  const rawPrices = (res.body as { prices?: unknown[] }).prices;
  if (!Array.isArray(rawPrices) || rawPrices.length === 0) {
    return emptyPricing(
      "OANDA returned no prices for these pairs.",
      `GET ${path} -> prices[] was missing or empty.`,
      upstreamUrl,
    );
  }

  const nowMs = Date.now();
  const quotes: Record<string, Quote> = {};
  for (const raw of rawPrices) {
    const p = raw as {
      instrument?: unknown;
      time?: unknown;
      tradeable?: unknown;
      status?: unknown;
      bids?: Array<{ price?: unknown }>;
      asks?: Array<{ price?: unknown }>;
    };
    const instrument = typeof p.instrument === "string" ? p.instrument : null;
    if (instrument === null) continue;
    const pipSize = pipSizeFor(instrument);
    // OANDA returns the book best-first; index 0 is the best (highest bid / lowest ask).
    const bid = num(p.bids?.[0]?.price);
    const ask = num(p.asks?.[0]?.price);
    const quoteTimeUtc = typeof p.time === "string" ? p.time : null;
    const quoteMs = quoteTimeUtc === null ? NaN : Date.parse(quoteTimeUtc);
    const ageSeconds = Number.isFinite(quoteMs) ? Number(((nowMs - quoteMs) / 1000).toFixed(2)) : null;
    const spreadPips = bid !== null && ask !== null ? Number(((ask - bid) / pipSize).toFixed(2)) : null;
    quotes[instrument] = {
      instrument,
      bid,
      ask,
      spreadPips,
      pipSize,
      quoteTimeUtc,
      ageSeconds,
      tradeable: typeof p.tradeable === "boolean" ? p.tradeable : null,
      status: typeof p.status === "string" ? p.status : null,
      missing:
        bid === null || ask === null
          ? "OANDA returned no usable bid/ask for this pair in this snapshot."
          : null,
    };
  }

  // Any instrument we asked for but did not get back is reported as missing rather
  // than silently dropped.
  for (const instrument of instruments) {
    if (!quotes[instrument]) {
      quotes[instrument] = {
        instrument,
        bid: null,
        ask: null,
        spreadPips: null,
        pipSize: pipSizeFor(instrument),
        quoteTimeUtc: null,
        ageSeconds: null,
        tradeable: null,
        status: null,
        missing: "OANDA returned no quote for this pair in this snapshot.",
      };
    }
  }

  const result: PricingResult = {
    ok: true,
    quotes,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
    upstreamUrl,
    accountType: oandaAccountType(),
    error: null,
    detail: null,
    source: PRICING_SOURCE(),
  };
  pricingCache = { result, storedAtMs: Date.now() };
  return result;
}

/** Test/ops helper: drop every cache this module holds. Used by verification scripts. */
export function clearOandaCaches(): void {
  candleCache.clear();
  pricingCache = null;
  accountIdCache = null;
}
