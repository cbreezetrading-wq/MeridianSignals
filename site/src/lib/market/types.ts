/** Shared types for the Meridian Signals market/signal layer. Pure types — safe to import anywhere. */

/** One OHLC bar. `t` is the bar's start time as a Unix epoch second, UTC. */
export type Bar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type PairId = "EURUSD" | "GBPUSD" | "USDJPY" | "AUDUSD";

export type PairSpec = {
  id: PairId;
  /** Display name, e.g. "EUR/USD". */
  label: string;
  /** The symbol as the upstream source knows it. */
  symbol: string;
  /** The instrument name the broker feed knows it by, e.g. "EUR_USD". */
  instrument: string;
  /** Conventional display precision for this pair. */
  decimals: number;
  /** What one unit of price movement is called for this pair (for labels). */
  pipNote: string;
};

/**
 * Provenance is provider-specific, so it is a flat bag of primitives rather than a
 * fixed shape: the page renders whatever the source actually reported. Values are
 * verbatim from upstream, never computed for display.
 */
export type Provenance = Record<string, string | number | boolean | null>;

/** Which provider actually produced a pair's bars. A fallback is always labelled. */
export type SourceKind = "primary" | "fallback";

/**
 * A quoted bid/ask snapshot for one pair. Every field is either what the broker
 * returned or null — never filled in, never carried over from an earlier snapshot.
 */
export type Quote = {
  instrument: string;
  bid: number | null;
  ask: number | null;
  /** (ask - bid) / pipSize. 1 pip = 0.0001, or 0.01 on a JPY-quoted pair. */
  spreadPips: number | null;
  pipSize: number;
  quoteTimeUtc: string | null;
  /** now - quote time in seconds. A tight spread on an old quote is not a tight spread. */
  ageSeconds: number | null;
  tradeable: boolean | null;
  status: string | null;
  /** Plain-English reason when this pair had no usable quote in the snapshot. */
  missing: string | null;
};

/** How the bid/ask snapshot itself was obtained, so its freshness is auditable. */
export type PricingMeta = {
  source: string;
  fetchedAt: string;
  fromCache: boolean;
  accountType: "practice" | "live" | "unknown";
  /** Present only when the whole pricing call failed. */
  error: string | null;
};

export type TrendFilter = "up" | "down" | "none";

export type SignalState = "LONG" | "SHORT" | "FLAT";

/** The rule events the engine can record, each with its plain-English name. */
export type RuleEventName =
  | "opened-long"
  | "opened-short"
  | "cross-against-trend-ignored"
  | "closed-long-on-cross"
  | "closed-short-on-cross"
  | "closed-long-on-trend-flick"
  | "closed-short-on-trend-flick"
  | "no-event";

export type RuleEvent = {
  name: RuleEventName;
  /** Plain-English description, written once in ruleset.ts. */
  text: string;
  /** UTC timestamp (ISO 8601) of the bar the event fired on. */
  barUtc: string;
  /** The triggering bar's close, as the reference level of the event. */
  barClose: number;
};

export type PairSignalOk = {
  status: "ok";
  pair: PairId;
  label: string;
  symbol: string;
  /** The broker instrument name the primary feed knows this pair by. */
  instrument: string;
  decimals: number;
  signal: SignalState;
  /** Reference levels. Null when flat — a flat state has no live entry/stop/target. */
  entry: number | null;
  stop: number | null;
  target: number | null;
  /** Same numbers rounded to the pair's conventional precision, as strings. */
  display: {
    signal: string;
    entry: string | null;
    stop: string | null;
    target: string | null;
    atr: string | null;
    lastClose: string;
  };
  /** ATR(14) in price units on the newest closed bar. */
  atr14: number | null;
  /** Wilder ATR expressed in the pair's own price units (not pips). */
  indicators: {
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    trend: TrendFilter;
  };
  /** The rule that produced the current state. */
  ruleFired: RuleEvent;
  /** One sentence describing what the engine currently reads. */
  reading: string;
  /** UTC timestamp of the newest closed bar used in the calculation. */
  latestBarUtc: string;
  /** Close of the newest closed bar. */
  latestClose: number;
  /** How many closed bars the calculation used. */
  barsUsed: number;
  firstBarUtc: string;
  granularity: "hourly bar" | "daily close";
  granularityNote: string;
  source: string;
  /** "primary" = the broker feed; "fallback" = the free source, explicitly labelled. */
  sourceKind: SourceKind;
  upstreamUrl: string;
  fetchedAt: string;
  /** True when the numbers came from the in-process cache, not a fresh upstream fetch. */
  fromCache: boolean;
  /** Verbatim values from the upstream response, as evidence of what was claimed. */
  upstream: Provenance;
  /** How many upstream bars were refused, and under which headings. */
  rejected: Record<string, number>;
  /** Current bid/ask for this pair, or null when no usable quote was available. */
  quote: Quote | null;
  /** How the quote snapshot was obtained. Null when pricing was never reachable. */
  pricing: PricingMeta | null;
};

export type PairSignalError = {
  status: "unavailable";
  pair: PairId;
  label: string;
  symbol: string;
  instrument: string;
  decimals: number;
  /** Plain-English reason, shown verbatim on the page. */
  error: string;
  /** Extra detail when there is any (e.g. an HTTP status). */
  detail?: string;
  granularityExpected: "hourly bar";
  source: string;
  /** Which provider the failed attempt was against. */
  sourceKind: SourceKind;
  upstreamUrl: string;
  /** When the last fetch attempt was made — NOT a fetch time of good data. */
  attemptedAt: string;
  /** Every provider that was tried for this pair, in order, with its outcome. */
  attempts: Array<{ source: string; sourceKind: SourceKind; error: string; detail: string; attemptedAt: string }>;
};

export type PairSignal = PairSignalOk | PairSignalError;

export type SignalsPayload = {
  generatedAt: string;
  ruleset: {
    version: string;
    file: string;
    summary: string;
    stop: string;
    target: string;
    entryLevel: string;
    trendFilter: string;
    entryTrigger: string;
    exit: string;
    candles: string;
  };
  data: {
    /** The provider the dashboard prefers, named as it is on the page. */
    primary: {
      name: string;
      host: string;
      accountType: "practice" | "live" | "unknown";
      granularity: string;
    };
    /** The free source, kept only as an explicitly labelled fallback. */
    fallback: {
      name: string;
      delayNote: string;
    };
    /** True when at least one pair's bars came from the fallback this refresh. */
    fallbackActive: boolean;
    pricing: {
      available: boolean;
      source: string;
      instrumentCount: number;
      accountType: "practice" | "live" | "unknown";
      note: string;
    };
    source: string;
    sourceUrl: string;
    granularity: "hourly bar" | "daily close";
    granularityNote: string;
    refreshSeconds: number;
    /** How long a fetched candle series may be reused. */
    cacheSeconds: number;
    /** How long a bid/ask snapshot may be reused (>= 5 s: one upstream request per 5 s). */
    pricingCacheSeconds: number;
    warnings: string[];
  };
  pairs: PairSignal[];
  disclaimer: string;
  measuredPerformance: "none";
};
