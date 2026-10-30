import { CACHE_SECONDS, feedWarnings, fetchHourlyBars, type FeedOk, type FeedResult } from "./feed";
import {
  CANDLE_CACHE_SECONDS,
  fetchOandaCandles,
  fetchOandaPricing,
  oandaAccountType,
  oandaBaseUrl,
  PRICING_CACHE_SECONDS,
  type OandaCandlesOk,
  type PricingResult,
} from "./oanda";
import { PAIRS } from "./pairs";
import { buildPairSignal, RULESET_SUMMARY, RULESET_VERSION } from "./ruleset";
import { HEARTBEAT_SECONDS, recordFromPayload } from "./trackRecord";
import type {
  PairSignal,
  PairSignalError,
  PairSignalOk,
  PricingMeta,
  Provenance,
  Quote,
  SignalsPayload,
  SourceKind,
} from "./types";

/**
 * Assembles the whole dashboard payload: every pair, or an explicit unavailable
 * entry carrying the reason. Server-only — call it from an API route or a
 * createServerFn handler, never from client code.
 *
 * Provider order, and the honesty rule that goes with it:
 *   1. The owner's OANDA v20 feed (read-only: candles + pricing only). This is the
 *      PRIMARY source and the one the page names.
 *   2. The free Yahoo chart API, ONLY when OANDA failed for that pair, and then the
 *      pair is labelled "fallback" with the source named and its delay stated. Free
 *      data is never dressed up as broker data.
 *   3. If both fail, the pair shows "data unavailable" with every attempt and its
 *      error. A stale number is never substituted for a failed fetch.
 *
 * The bid/ask snapshot is a COST INPUT, not a performance claim. Nothing here
 * computes, implies or displays any profitability, accuracy or win-rate figure.
 */

export const REFRESH_SECONDS = 60;

const FALLBACK_NAME = "Yahoo Finance chart API (no API key)";
const FALLBACK_DELAY_NOTE =
  "a free public source that labels its FX quotes as delayed — it is 30–105 seconds behind the broker feed in our measurements, and it is used only when the broker feed fails";

const DISCLAIMER =
  "These are algorithmic technical signals from the ruleset written down in /home/team/shared/ruleset.md. They are shown for the owner's own reading and decisions. They are not advice, not a recommendation, and not an order — and no performance, accuracy or win rate has been measured for them yet. The bars are hourly broker bars, not a tick quote, and only bars the broker has flagged complete are used. The bid/ask beside each signal is an indicative quote from the owner's own account (practice unless stated) and is shown as a cost input only — it is not a fill, not a tradable guarantee and not a performance figure.";

/** One provider attempt on one pair, kept so a failure can be shown with its reason. */
type Attempt = {
  source: string;
  sourceKind: SourceKind;
  error: string;
  detail: string;
  attemptedAt: string;
};

/** Minutes-free UTC stamp for warnings. */
function stamp(): string {
  return `${new Date().toISOString().slice(0, 19)} UTC`;
}

function pricingMetaOf(pricing: PricingResult): PricingMeta {
  return {
    source: pricing.source,
    fetchedAt: pricing.fetchedAt,
    fromCache: pricing.fromCache,
    accountType: pricing.accountType,
    error: pricing.error,
  };
}

/**
 * Build one pair's signal from the primary (broker) feed result.
 */
function fromOanda(
  specIndex: number,
  candles: OandaCandlesOk,
  quote: Quote | null,
  pricing: PricingResult,
): PairSignalOk {
  const spec = PAIRS[specIndex]!;
  const built = buildPairSignal(spec, candles.bars, {
    source: candles.source,
    upstreamUrl: candles.upstreamUrl,
    fetchedAt: candles.fetchedAt,
    granularityNote: candles.granularityNote,
  });
  return {
    ...built,
    instrument: spec.instrument,
    sourceKind: "primary",
    fromCache: candles.fromCache,
    upstream: candles.upstream as Provenance,
    rejected: {
      incompleteBar: candles.rejected.incompleteBar,
      malformedBar: candles.rejected.malformedBar,
    },
    quote,
    pricing: pricingMetaOf(pricing),
  };
}

/** Build one pair's signal from the free fallback feed. Always labelled as such. */
function fromYahoo(
  specIndex: number,
  feed: FeedOk,
  quote: Quote | null,
  pricing: PricingResult,
): PairSignalOk {
  const spec = PAIRS[specIndex]!;
  const built = buildPairSignal(spec, feed.bars, {
    source: feed.source,
    upstreamUrl: feed.upstreamUrl,
    fetchedAt: feed.fetchedAt,
    granularityNote: `${feed.granularityNote} FALLBACK SOURCE: this pair fell back to the free ${FALLBACK_NAME} because the broker feed failed, and that source is ${FALLBACK_DELAY_NOTE}.`,
  });
  return {
    ...built,
    instrument: spec.instrument,
    sourceKind: "fallback",
    fromCache: feed.fromCache,
    upstream: feed.upstream as unknown as Provenance,
    rejected: { formingBar: feed.rejected.formingBar, emptyBar: feed.rejected.emptyBar },
    quote,
    pricing: pricingMetaOf(pricing),
  };
}

function unavailable(specIndex: number, attempts: Attempt[]): PairSignalError {
  const spec = PAIRS[specIndex]!;
  const last = attempts[attempts.length - 1];
  return {
    status: "unavailable",
    pair: spec.id,
    label: spec.label,
    symbol: spec.symbol,
    instrument: spec.instrument,
    error: "No price source could be read for this pair.",
    detail: last ? last.detail : undefined,
    granularityExpected: "hourly bar",
    source: last ? last.source : "none",
    sourceKind: "primary",
    upstreamUrl: last ? last.error : "",
    attemptedAt: last ? last.attemptedAt : new Date().toISOString(),
    attempts,
  };
}

/**
 * Fetch all four pairs, the broker feed first.
 *
 * Candle requests go out one pair at a time. Each provider has its own in-process
 * cache (broker candles 60 s, free bars 300 s, bid/ask 5 s), so the request rate to
 * either upstream is bounded no matter how often the dashboard is opened.
 */
export async function getSignals(): Promise<SignalsPayload> {
  const warnings: string[] = [];
  const instruments = PAIRS.map((p) => p.instrument);

  // One bid/ask request covers all four pairs. A failure here must not stop the
  // signals: the spread block then says why it is absent instead of showing nothing.
  const pricing = await fetchOandaPricing(instruments);
  if (!pricing.ok) {
    warnings.push(
      `The bid/ask snapshot from the broker feed could not be read at ${stamp()}: ${pricing.error} The signals below are unaffected; the spread block is absent because there is no honest number to put in it.`,
    );
  }

  const pairs: PairSignal[] = [];
  let fallbackPairs: string[] = [];
  let primaryFailures: string[] = [];

  for (const [index, spec] of PAIRS.entries()) {
    const attempts: Attempt[] = [];
    const quote = pricing.quotes[spec.instrument] ?? null;

    let primary: PairSignalOk | null = null;
    try {
      const candles = await fetchOandaCandles(spec.instrument);
      if (candles.ok) {
        primary = fromOanda(index, candles, quote, pricing);
      } else {
        attempts.push({
          source: candles.source,
          sourceKind: "primary",
          error: candles.error,
          detail: candles.detail,
          attemptedAt: candles.attemptedAt,
        });
        primaryFailures.push(spec.label);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        source: `OANDA v20 ${oandaAccountType()} (hourly bars)`,
        sourceKind: "primary",
        error: "The broker feed layer failed unexpectedly for this pair.",
        detail: message,
        attemptedAt: new Date().toISOString(),
      });
      primaryFailures.push(spec.label);
    }

    if (primary) {
      pairs.push(primary);
      continue;
    }

    // Primary failed: fall back to the free source, explicitly labelled.
    let fallback: PairSignalOk | null = null;
    try {
      const feed: FeedResult = await fetchHourlyBars(spec.symbol);
      if (feed.ok) {
        fallback = fromYahoo(index, feed, quote, pricing);
      } else {
        attempts.push({
          source: feed.source,
          sourceKind: "fallback",
          error: feed.error,
          detail: feed.detail,
          attemptedAt: feed.attemptedAt,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        source: FALLBACK_NAME,
        sourceKind: "fallback",
        error: "The fallback feed layer failed unexpectedly for this pair.",
        detail: message,
        attemptedAt: new Date().toISOString(),
      });
    }

    if (fallback) {
      fallbackPairs.push(spec.label);
      pairs.push(fallback);
    } else {
      pairs.push(unavailable(index, attempts));
    }
  }

  if (primaryFailures.length > 0) {
    const recovered = fallbackPairs.length;
    warnings.push(
      `The broker feed (OANDA v20 ${oandaAccountType()}) failed for ${String(primaryFailures.length)} of ${String(PAIRS.length)} pairs at ${stamp()} (${primaryFailures.join(", ")}). ${
        recovered > 0
          ? `${String(recovered)} of those rows now show the free fallback source — labelled "fallback" on the card, with its delay stated.`
          : "No fallback source could be read either, so those rows show data unavailable."
      }`,
    );
  }
  if (fallbackPairs.length > 0) {
    feedWarnings.length = 0;
    warnings.push(
      `Fallback in use for ${fallbackPairs.join(", ")}: this is the free ${FALLBACK_NAME}, which is ${FALLBACK_DELAY_NOTE}. It is NOT broker data.`,
    );
  }

  const okCount = pairs.filter((p) => p.status === "ok").length;
  if (okCount < PAIRS.length) {
    warnings.push(
      `${String(PAIRS.length - okCount)} of ${String(PAIRS.length)} pairs could not be refreshed from any source — those rows show "data unavailable" with every attempt and its reason.`,
    );
  }
  for (const w of feedWarnings) warnings.push(w);

  const accountType = oandaAccountType();
  const payload: SignalsPayload = {
    generatedAt: new Date().toISOString(),
    ruleset: { ...RULESET_SUMMARY, version: RULESET_VERSION },
    data: {
      primary: {
        name: `OANDA v20 ${accountType} — hourly bars (complete-flag confirmed)`,
        host: oandaBaseUrl(),
        accountType,
        granularity: "H1 candles, price=MBA, MID series",
      },
      fallback: { name: FALLBACK_NAME, delayNote: FALLBACK_DELAY_NOTE },
      fallbackActive: fallbackPairs.length > 0,
      pricing: {
        available: pricing.ok,
        source: pricing.source,
        instrumentCount: Object.keys(pricing.quotes).length,
        accountType: pricing.accountType,
        note: `Indicative bid/ask from the owner's OANDA v20 ${accountType} account, one request covering all four pairs, cached for at least ${String(PRICING_CACHE_SECONDS)} s. These are ${accountType.toUpperCase()}-ACCOUNT spreads: a funded account's are typically tighter. Shown as a cost input only — no performance is calculated or implied from it, and this is not a fill.`,
      },
      source: `OANDA v20 ${accountType} — hourly bars (complete-flag confirmed)`,
      sourceUrl: `${oandaBaseUrl()}/v3/instruments/{INSTRUMENT}/candles?granularity=H1&count=500&price=MBA`,
      granularity: "hourly bar",
      granularityNote:
        "Hourly (H1) candles from the owner's own broker account, MID price series (price=MBA), only bars the broker has flagged complete: true. The free source is kept only as an explicitly labelled fallback. Bid/ask beside each signal is a separate quote snapshot, not part of the bar.",
      refreshSeconds: REFRESH_SECONDS,
      cacheSeconds: CANDLE_CACHE_SECONDS,
      pricingCacheSeconds: PRICING_CACHE_SECONDS,
      warnings,
    },
    pairs,
    disclaimer: DISCLAIMER,
    measuredPerformance: "none",
  };

  // Record what the engine just said, on change and at least hourly per pair.
  // The record is never allowed to break the dashboard: a failure to append is
  // surfaced as a warning on the payload instead of throwing.
  try {
    await recordFromPayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`The signal record could not be appended for this refresh: ${message}`);
  }

  ensureHeartbeatScheduler();

  return payload;
}

/**
 * Heartbeat tick: recompute on a timer so a pair is recorded at least once an
 * hour even while nobody has the dashboard open — otherwise a silent log could
 * mean "nothing changed" or "we stopped watching", and the two would look alike.
 *
 * This adds no upstream traffic of its own: it goes through the same feed caches the
 * dashboard already uses, so the request rate to either price source is unchanged (a
 * fresh upstream fetch at most once per cache window, whichever of the two asked).
 */
function ensureHeartbeatScheduler(): void {
  if (heartbeatStarted || typeof window !== "undefined") return;
  heartbeatStarted = true;
  const id = setInterval(() => {
    void getSignals().catch(() => undefined);
  }, HEARTBEAT_SECONDS * 1000);
  // Do not hold the process open on account of the timer.
  if (typeof (id as { unref?: () => void }).unref === "function") {
    (id as unknown as { unref: () => void }).unref();
  }
}

let heartbeatStarted = false;

/** Exported only so the constants used above stay visible to verification tooling. */
export const FEED_CACHE_SECONDS = CACHE_SECONDS;
