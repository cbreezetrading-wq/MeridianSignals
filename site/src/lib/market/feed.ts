import type { Bar } from "./types";

/**
 * Upstream price feed for Meridian Signals.
 *
 * Source: the Yahoo Finance chart API — free, no API key, and the only candidate
 * tested that returns genuine hourly OHLC bars for FX. See /home/team/shared/ruleset.md
 * and the site's data-source note for what was tried and rejected.
 *
 * Two rules this module never breaks:
 *  1. Nothing is interpolated, back-filled or smoothed. Only values the source
 *     actually returned are used.
 *  2. A failure is a failure. On a failed refresh the caller gets an error and the
 *     page shows "data unavailable" — a cached value is never re-dated and passed
 *     off as current.
 */

const SOURCE_NAME = "Yahoo Finance chart API (no API key)";
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const INTERVAL = "1h";
const RANGE = "1mo";
const HOUR_SECONDS = 3600;

/** How long a successful upstream response may be reused. Keeps us off the free endpoint. */
export const CACHE_SECONDS = 300;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;

const GRANULARITY_NOTE =
  "Hourly bars (Yahoo returns dataGranularity '1h'). Yahoo labels its FX quotes as delayed, so these are recent hourly bars, not a live quote. Bars are UTC-stamped; only bars whose hour had already closed when we fetched are used.";

export type UpstreamProvenance = {
  symbol: string;
  dataGranularity: string;
  exchangeTimezoneName: string;
  currency: string;
  regularMarketTime: string | null;
};

export type FeedOk = {
  ok: true;
  bars: Bar[];
  fetchedAt: string;
  upstreamUrl: string;
  source: string;
  granularityNote: string;
  upstream: UpstreamProvenance;
  /** Bars the upstream returned that we refused to use, and why. Shown for auditability. */
  rejected: { formingBar: number; emptyBar: number };
  /** True when this response came from the in-process cache rather than a live fetch. */
  fromCache: boolean;
};

export type FeedErr = {
  ok: false;
  error: string;
  detail: string;
  attemptedAt: string;
  upstreamUrl: string;
  source: string;
};

export type FeedResult = FeedOk | FeedErr;

type CacheEntry = { result: FeedOk; storedAtMs: number };

/** In-process cache: this server is the only process, so a Map is enough. */
const cache = new Map<string, CacheEntry>();

/** Rate-limit observations, surfaced on the page so a degraded feed is visible. */
export const feedWarnings: string[] = [];

function noteWarning(message: string): void {
  if (!feedWarnings.includes(message)) feedWarnings.push(message);
}

function upstreamUrl(host: string, symbol: string): string {
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${INTERVAL}&range=${RANGE}`;
}

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: Record<string, unknown>;
      timestamp?: number[];
      indicators?: { quote?: Array<Record<string, Array<number | null> | null>> };
    }>;
    error?: { code?: string; description?: string } | null;
  };
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fetch closed hourly bars for one symbol, using the cache when it is fresh.
 * Never throws: every failure path returns a FeedErr carrying a plain-English reason.
 */
export async function fetchHourlyBars(symbol: string): Promise<FeedResult> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.storedAtMs < CACHE_TTL_MS) {
    return { ...cached.result, fromCache: true };
  }

  const attemptedAt = new Date().toISOString();
  const urls: string[] = [];
  let lastError: FeedErr | null = null;

  for (const host of HOSTS) {
    const url = upstreamUrl(host, symbol);
    urls.push(url);
    try {
      const res = await fetch(url, {
        headers: {
          // Yahoo rejects requests without a browser-ish UA.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        noteWarning(`Upstream returned HTTP 429 (rate limited) for ${symbol} at ${attemptedAt}.`);
        lastError = {
          ok: false,
          error: "Data source rate-limited this request (HTTP 429).",
          detail: `GET ${url} -> 429 Too Many Requests`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }
      if (!res.ok) {
        lastError = {
          ok: false,
          error: `Data source answered HTTP ${String(res.status)}.`,
          detail: `GET ${url} -> ${String(res.status)} ${res.statusText}`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }

      const text = await res.text();
      let parsed: YahooChart;
      try {
        parsed = JSON.parse(text) as YahooChart;
      } catch {
        lastError = {
          ok: false,
          error: "Data source returned a response that is not JSON.",
          detail: `GET ${url} -> body starts: ${text.slice(0, 120)}`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }

      const result = parsed.chart?.result?.[0];
      if (!result) {
        const desc = parsed.chart?.error?.description ?? "no result object in the response";
        lastError = {
          ok: false,
          error: "Data source returned no chart data for this pair.",
          detail: `GET ${url} -> ${desc}`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }

      const timestamps = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0] ?? null;
      if (timestamps.length === 0 || quote === null) {
        lastError = {
          ok: false,
          error: "Data source returned an empty bar series for this pair.",
          detail: `GET ${url} -> 0 bars`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const bars: Bar[] = [];
      let formingBar = 0;
      let emptyBar = 0;
      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i]!;
        const o = num(quote.open?.[i]);
        const h = num(quote.high?.[i]);
        const l = num(quote.low?.[i]);
        const c = num(quote.close?.[i]);
        if (o === null || h === null || l === null || c === null) {
          emptyBar += 1;
          continue;
        }
        // Only bars whose hour has already closed. A forming bar's close is not a close.
        if (t + HOUR_SECONDS > nowSeconds) {
          formingBar += 1;
          continue;
        }
        bars.push({ t, o, h, l, c });
      }
      bars.sort((a, b) => a.t - b.t);

      const MIN_BARS = 210; // EMA(200) plus a previous bar: below this the ruleset cannot run.
      if (bars.length < MIN_BARS) {
        lastError = {
          ok: false,
          error: `Data source returned only ${String(bars.length)} usable hourly bars — the ruleset needs at least ${String(MIN_BARS)}.`,
          detail: `GET ${url} -> ${String(bars.length)} closed, non-empty bars`,
          attemptedAt,
          upstreamUrl: url,
          source: SOURCE_NAME,
        };
        continue;
      }

      const meta = result.meta ?? {};
      const regularMarketTime = num(meta.regularMarketTime);
      const outcome: FeedOk = {
        ok: true,
        bars,
        fetchedAt: new Date().toISOString(),
        upstreamUrl: url,
        source: SOURCE_NAME,
        granularityNote: GRANULARITY_NOTE,
        upstream: {
          symbol: typeof meta.symbol === "string" ? meta.symbol : symbol,
          dataGranularity: typeof meta.dataGranularity === "string" ? meta.dataGranularity : "unknown",
          exchangeTimezoneName:
            typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "unknown",
          currency: typeof meta.currency === "string" ? meta.currency : "unknown",
          regularMarketTime:
            regularMarketTime === null ? null : new Date(regularMarketTime * 1000).toISOString(),
        },
        rejected: { formingBar, emptyBar },
        fromCache: false,
      };
      cache.set(symbol, { result: outcome, storedAtMs: Date.now() });
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = {
        ok: false,
        error: "Could not reach the data source.",
        detail: `GET ${url} -> ${message}`,
        attemptedAt,
        upstreamUrl: url,
        source: SOURCE_NAME,
      };
    }
  }

  // Every host failed. Do NOT serve a stale cached series in its place.
  return (
    lastError ?? {
      ok: false,
      error: "Could not reach the data source.",
      detail: `Tried: ${urls.join(", ")}`,
      attemptedAt,
      upstreamUrl: urls[0] ?? "",
      source: SOURCE_NAME,
    }
  );
}
