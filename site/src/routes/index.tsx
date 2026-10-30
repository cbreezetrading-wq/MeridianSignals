import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSignals } from "~/lib/market/service";
import type { PairSignal, PairSignalOk, SignalsPayload } from "~/lib/market/types";

/**
 * Meridian Signals — the signals dashboard.
 *
 * Server renders the first payload through the route loader (so the page has real
 * numbers in the HTML), then the browser re-reads our own /api/signals every 60s.
 * Nothing is fetched from an upstream source in the browser, and nothing shown
 * here is invented: an unavailable pair renders its error, never a stale number.
 *
 * The bid/ask block is a COST INPUT. No performance figure is derived from it.
 */
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Meridian Signals — FX signal dashboard" },
      {
        name: "description",
        content:
          "One ruleset, four major FX pairs, hourly bars from the owner's own OANDA v20 account with the broker's complete-flag enforced. Technical signals with their entry, stop, target, trigger bar, rule and the current bid/ask spread. Negative historical backtests reported; not a profitable strategy.",
      },
    ],
  }),
  loader: async () => {
    if (typeof window === "undefined") return await getSignals();
    // Client-side navigation: read our own endpoint rather than the upstream feed.
    const res = await fetch("/api/signals", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The signals endpoint answered HTTP ${String(res.status)}.`);
    return (await res.json()) as SignalsPayload;
  },
  component: Dashboard,
});

/** Deterministic UTC rendering, so server HTML and client HTML always agree. */
function formatUtc(iso: string | null): string {
  if (!iso) return "unknown";
  const t = iso.replace("T", " ");
  return `${t.slice(0, 16)} UTC`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="font-mono text-base text-slate-900 tabular-nums">{value}</dd>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** Humanise a provenance / rejection key for display, e.g. "incompleteBar" -> "incomplete bar". */
function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toLowerCase())
    .replace(/Utc\b/g, "UTC");
}

/**
 * The bid/ask block. The quote's AGE is shown as prominently as the spread, because
 * a tight spread on an old quote is a misleading number.
 */
function SpreadBlock({ pair }: { pair: PairSignalOk }) {
  const q = pair.quote;
  const practice = pair.pricing?.accountType !== "live";
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-sky-900">
          Broker bid / ask — spread is a cost input, not a performance claim
        </h3>
        {practice ? (
          <span className="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 ring-1 ring-amber-300">
            Practice-account spreads
          </span>
        ) : null}
      </div>
      {q && q.missing === null ? (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Bid" value={q.bid === null ? "—" : q.bid.toFixed(pair.decimals)} />
            <Metric label="Ask" value={q.ask === null ? "—" : q.ask.toFixed(pair.decimals)} />
            <Metric
              label="Spread"
              value={q.spreadPips === null ? "—" : `${q.spreadPips.toFixed(1)} pips`}
              hint={q.pipSize === 0.01 ? "1 pip = 0.01" : "1 pip = 0.0001"}
            />
            <Metric
              label="Quote age"
              value={q.ageSeconds === null ? "—" : `${q.ageSeconds.toFixed(1)} s`}
              hint={`quoted ${formatUtc(q.quoteTimeUtc)}`}
            />
          </dl>
          <p className="mt-2 text-[11px] text-slate-700">
            {q.tradeable === true
              ? "The broker reports this pair tradeable in this snapshot."
              : q.tradeable === false
                ? "The broker reports this pair NOT tradeable in this snapshot (market closed or trading halted) — the quote above is the last one it gave."
                : "The broker did not report a tradeable flag for this snapshot."}{" "}
            {practice
              ? "These are PRACTICE-ACCOUNT spreads. A funded account's are typically tighter, so do not read these as the cost you would actually pay."
              : null}{" "}
            The spread is what a round trip costs at this level; nothing on this page computes a result from it.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-800">
          No usable bid/ask for this pair: {q?.missing ?? pair.pricing?.error ?? "the pricing feed could not be read."}
        </p>
      )}
      {pair.pricing ? (
        <p className="mt-2 text-[11px] text-slate-500">
          Quote source: {pair.pricing.source} · snapshot {formatUtc(pair.pricing.fetchedAt)}
          {pair.pricing.fromCache ? " (reused from the ≥5 s cache)" : " (fetched fresh)"}
        </p>
      ) : null}
    </div>
  );
}

const SIGNAL_STYLE: Record<PairSignalOk["signal"], string> = {
  LONG: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  SHORT: "bg-rose-100 text-rose-900 ring-rose-300",
  FLAT: "bg-slate-100 text-slate-700 ring-slate-300",
};

function SignalCard({ pair }: { pair: PairSignal }) {
  if (pair.status === "unavailable") {
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">{pair.label}</h2>
          <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-semibold tracking-wide text-amber-900 uppercase ring-1 ring-amber-300">
            Data unavailable
          </span>
        </header>
        <p className="text-sm text-slate-800">
          No signal is shown for this pair. No price source could be read, so there is nothing honest
          to display — these numbers are not stale, they are absent.
        </p>
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Reason</dt>
            <dd className="text-slate-900">{pair.error}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Sources tried, in order
            </dt>
            <dd>
              <ul className="space-y-1 text-xs">
                {pair.attempts.map((a) => (
                  <li key={`${a.sourceKind}-${a.attemptedAt}`} className="font-mono break-all text-slate-700">
                    <span className="font-sans font-semibold">
                      {a.sourceKind === "primary" ? "primary (broker)" : "fallback (free)"}:
                    </span>{" "}
                    {a.source} — {a.error} ({a.detail}) at {formatUtc(a.attemptedAt)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Last fetch attempt (UTC)
            </dt>
            <dd className="text-slate-900">{formatUtc(pair.attemptedAt)}</dd>
          </div>
        </dl>
      </section>
    );
  }

  const flat = pair.signal === "FLAT";
  const isFallback = pair.sourceKind === "fallback";
  return (
    <section
      className={`flex flex-col gap-4 rounded-xl border bg-white p-5 shadow-sm ${
        isFallback ? "border-orange-400 ring-1 ring-orange-300" : "border-slate-200"
      }`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{pair.label}</h2>
          <p className="text-xs text-slate-500">
            {pair.decimals} decimal places · broker instrument {pair.instrument}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold tracking-wide ring-1 ${SIGNAL_STYLE[pair.signal]}`}
        >
          {pair.display.signal}
        </span>
      </header>

      {isFallback ? (
        <p className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900">
          <strong className="font-semibold">FALLBACK SOURCE.</strong> The broker feed failed for this
          pair, so these bars come from the free {pair.source} — which is delayed, not broker data.
          Treat the levels below as indicative until the broker feed is readable again.
        </p>
      ) : null}

      {flat ? (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          <strong className="font-semibold">Flat:</strong> the ruleset has no open position on this
          pair, so there is no current entry, stop or target to show. The levels appear only when a
          trigger fires.
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-3">
          <Metric
            label="Entry (reference)"
            value={pair.display.entry ?? "—"}
            hint="close of the trigger bar"
          />
          <Metric label="Stop" value={pair.display.stop ?? "—"} hint="1.5 × ATR(14)" />
          <Metric label="Target" value={pair.display.target ?? "—"} hint="3.0 × ATR(14)" />
        </dl>
      )}

      <SpreadBlock pair={pair} />

      <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
        <Metric
          label="Trigger bar (UTC)"
          value={formatUtc(pair.ruleFired.barUtc)}
          hint={`bar close ${pair.ruleFired.barClose.toFixed(pair.decimals)}`}
        />
        <Metric
          label="Newest closed bar (UTC)"
          value={formatUtc(pair.latestBarUtc)}
          hint={`close ${pair.display.lastClose}`}
        />
      </div>

      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Rule that fired
        </h3>
        <p className="text-sm text-slate-900">{pair.ruleFired.text}</p>
      </div>

      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          What the ruleset reads now
        </h3>
        <p className="text-sm text-slate-700">{pair.reading}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-4">
        <Metric label="Trend filter" value={pair.indicators.trend} />
        <Metric
          label="EMA(20) / EMA(50)"
          value={`${pair.indicators.ema20?.toFixed(pair.decimals) ?? "—"} / ${
            pair.indicators.ema50?.toFixed(pair.decimals) ?? "—"
          }`}
        />
        <Metric label="EMA(200)" value={pair.indicators.ema200?.toFixed(pair.decimals) ?? "—"} />
        <Metric label="ATR(14)" value={pair.display.atr ?? "—"} hint="price units, not pips" />
      </dl>

      <dl className="grid gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Bars come from:</dt>
          <dd>
            <span
              className={`mr-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                isFallback ? "bg-orange-200 text-orange-900" : "bg-sky-200 text-sky-900"
              }`}
            >
              {isFallback ? "fallback (free, delayed)" : "primary (broker)"}
            </span>
            {pair.source} · <span className="font-medium">{pair.granularity}</span>
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Upstream request:</dt>
          <dd className="font-mono break-all">{pair.upstreamUrl}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Last successful fetch (UTC):</dt>
          <dd>
            {formatUtc(pair.fetchedAt)}
            {pair.fromCache ? " (served from the cache)" : " (fetched fresh)"}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Calculation window:</dt>
          <dd>
            {pair.barsUsed} closed hourly bars, from {formatUtc(pair.firstBarUtc)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Granularity note:</dt>
          <dd>{pair.granularityNote}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Bars refused:</dt>
          <dd>
            {Object.entries(pair.rejected)
              .map(([k, v]) => `${String(v)} ${humanise(k)}`)
              .join(", ") || "none"}{" "}
            — discarded, never filled in
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Upstream reported:</dt>
          <dd className="font-mono break-all">
            {Object.entries(pair.upstream)
              .map(([k, v]) => `${humanise(k)}=${String(v)}`)
              .join(" · ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Dashboard() {
  const initial = Route.useLoaderData() as SignalsPayload;
  const [payload, setPayload] = useState<SignalsPayload>(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const intervalMs = Math.max(30, payload.data.refreshSeconds) * 1000;
    const tick = async () => {
      try {
        const res = await fetch("/api/signals", { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const next = (await res.json()) as SignalsPayload;
        if (cancelled) return;
        setPayload(next);
        setPollError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setPollError(
          `The page could not re-read its own signals endpoint (${message}). The numbers above are from the last payload it did read — see the fetch time on each pair — and older ones are not presented as newer.`,
        );
      } finally {
        if (!cancelled) setLastChecked(new Date().toISOString());
      }
    };
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [payload.data.refreshSeconds]);

  const okCount = payload.pairs.filter((p) => p.status === "ok").length;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
      <header className="mb-8">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Meridian Signals
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">FX signal dashboard</h1>
        <a href="/execution" className="mt-3 inline-block text-sm underline">Open private Practice execution console →</a>
        <p className="mt-3 max-w-3xl text-sm text-slate-700">
          One ruleset, applied to four major pairs, on hourly bars from the owner&rsquo;s own broker
          account. Each pair shows the current state, the reference entry, stop and target, the bar
          the trigger fired on, the rule that fired, and the current bid/ask with its spread in pips
          and the age of the quote. Every number here is computed from the bars named on the card —
          nothing is typed in by hand.
        </p>
        <div className="mt-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4">
          <p className="text-xs font-semibold tracking-[0.2em] text-rose-700 uppercase">
            Read this before acting on a signal
          </p>
          <p className="mt-2 text-sm text-rose-900">
            The ruleset has been measured over the full history of the owner&rsquo;s own broker data, with
            the real spread on every fill. <strong className="font-semibold">It is not tradeable: it lost
            money.</strong> The dashboard below is a faithful readout of what the rules say — not evidence
            that following them makes money.
          </p>
          <p className="mt-2 text-sm">
            <a className="font-semibold text-rose-900 underline" href="/backtest">
              The backtest, in full: the negative result, the assumptions and the exclusions →
            </a>
          </p>
          <p className="mt-1 text-sm text-rose-900">
            The same ruleset was also measured on daily bars, a lower-frequency variant tested because
            a spread costs the same per trade either way, and it lost money there too –{" "}
            <a className="underline" href="/backtest/daily">
              daily-bar result
            </a>
            .
          </p>
        </div>
        <p className="mt-3 text-sm">
          <a className="font-medium text-slate-900 underline" href="/track-record">
            Track record: every signal this engine has said, in an append-only log →
          </a>
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-slate-200 bg-slate-50 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-900 uppercase">
          Where these prices come from
        </h2>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
          <li>
            <strong className="font-semibold">Primary source:</strong> {payload.data.primary.name} ·
            host <span className="font-mono">{payload.data.primary.host}</span> ·{" "}
            {payload.data.primary.granularity}
          </li>
          <li>
            <strong className="font-semibold">Granularity:</strong>{" "}
            <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-xs text-white">
              {payload.data.granularity}
            </span>{" "}
            — {payload.data.granularityNote}
          </li>
          <li>
            <strong className="font-semibold">Bid / ask:</strong> {payload.data.pricing.note}
          </li>
          <li>
            <strong className="font-semibold">Fallback:</strong> {payload.data.fallback.name} (
            {payload.data.fallback.delayNote}) is used only when the broker feed fails for a pair, and
            every such card is labelled{" "}
            <span className="rounded bg-orange-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-orange-900">
              fallback
            </span>
            . {payload.data.fallbackActive ? "It is in use right now — see the warning below." : "It is not in use right now."}
          </li>
          <li>
            <strong className="font-semibold">Fetch times:</strong> the page re-reads this data every{" "}
            {payload.data.refreshSeconds} seconds; the server reuses a bar series for up to{" "}
            {payload.data.cacheSeconds} seconds and a bid/ask snapshot for at least{" "}
            {payload.data.pricingCacheSeconds} seconds. Each card shows the time of the last
            successful fetch of its own numbers, and each quote its own age in seconds.
          </li>
          <li>
            <strong className="font-semibold">This payload:</strong> built {formatUtc(payload.generatedAt)},{" "}
            {okCount} of {payload.pairs.length} pairs refreshed.
          </li>
          <li>
            <strong className="font-semibold">Read-only:</strong> the broker client only ever reads
            candles, pricing and the account list. It cannot place an order — there is no order,
            trade, position or transaction endpoint in this codebase.
          </li>
        </ul>
        {payload.data.warnings.length > 0 ? (
          <ul className="mt-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {payload.data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section
        id="freshness"
        className="mb-8 rounded-xl border border-slate-300 bg-white p-5"
        data-testid="freshness-panel"
      >
        <h2 className="text-lg font-semibold text-slate-900">How fresh is this?</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          Measured figures, not a description. Both were measured on the same hourly bar boundary and
          are stated as the delay after the hour at which a newly completed bar first became visible.
          Nothing here says anything about whether the signals are any good — freshness only.
        </p>
        <dl className="mt-4 grid gap-4 text-sm">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Broker feed — the source this page uses
            </dt>
            <dd className="mt-1 text-slate-800">
              Across the <strong>17:00Z bar boundary on 2026-10-06</strong>, the broker first served
              that completed hourly bar at{" "}
              <span className="font-mono font-semibold">+1.3 s</span> after the hour for EUR/USD,
              GBP/USD and USD/JPY, and at{" "}
              <span className="font-mono font-semibold">+12.8 s</span> for AUD/USD. On 114 further
              checks of each pair the bar&rsquo;s close held exactly{" "}
              <strong>one distinct value</strong> — it was not revised after the broker first served
              it.
            </dd>
          </div>
          <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-orange-900">
              Free fallback feed — numbers belong to the fallback source, used only when the broker
              feed fails
            </dt>
            <dd className="mt-1 text-slate-800">
              The same boundary on the free Yahoo source: it first flagged the bar closed at{" "}
              <span className="font-mono font-semibold">+20.05 s</span>; this page&rsquo;s endpoint
              first reported it as the newest closed bar at{" "}
              <span className="font-mono font-semibold">+36.97 s</span> (that reading was served from
              the server&rsquo;s cache, which had been filled at +19.7 s); and{" "}
              <strong>2 of the 4 pairs (GBP/USD, AUD/USD) had their close revised after the bar
              appeared closed</strong>, up to{" "}
              <span className="font-mono font-semibold">+50.05 s</span>. So the number visible at
              +37 s was not yet final on that half of the pairs. These figures describe the fallback
              source only — they are not the broker feed&rsquo;s.
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-slate-700">
          <strong className="font-semibold">How it was measured (so it can be repeated):</strong> a
          separate poller read the broker&rsquo;s candle endpoint and this page&rsquo;s own{" "}
          <a className="font-mono underline" href="/api/signals">
            /api/signals
          </a>{" "}
          endpoint every few seconds straight through the 17:00Z boundary on 2026-10-06, and recorded
          the first tick at which each showed a newly completed bar, then kept checking whether the
          close changed. The raw ticks are kept in{" "}
          <span className="font-mono">boundary_1700.jsonl</span> and the analysis in{" "}
          <span className="font-mono">boundary_analysis.txt</span>. The screen-lag figures below are
          the same run&rsquo;s cache and refresh settings.
        </p>
        <p className="mt-3 text-sm text-slate-700">
          <strong className="font-semibold">Screen lag to allow for:</strong> the server reuses a bar
          series for up to{" "}
          <span className="font-mono">{payload.data.cacheSeconds} s</span> and this page re-reads it
          every <span className="font-mono">{payload.data.refreshSeconds} s</span>, so at a bar
          boundary the screen can be up to about{" "}
          <span className="font-mono">
            {payload.data.cacheSeconds + payload.data.refreshSeconds} s
          </span>{" "}
          behind the feed even though the broker serves the bar within ~1.3 s. When the two
          measurements above were taken the candle cache was still 60 s, so the ceiling then was
          about 2 minutes; it has since been reduced, and the panel reports the settings actually in
          force.
        </p>
      </section>

      {pollError ? (
        <p className="mb-8 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          {pollError}
          {lastChecked ? ` Last re-read attempt: ${formatUtc(lastChecked)}.` : ""}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        {payload.pairs.map((pair) => (
          <SignalCard key={pair.pair} pair={pair} />
        ))}
      </div>

      <section className="mt-10 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">How this signal is calculated</h2>
        <p className="mt-2 text-sm text-slate-700">{payload.ruleset.summary}</p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Trend filter
            </dt>
            <dd className="text-slate-800">{payload.ruleset.trendFilter}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Entry trigger
            </dt>
            <dd className="text-slate-800">{payload.ruleset.entryTrigger}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Entry level
            </dt>
            <dd className="text-slate-800">{payload.ruleset.entryLevel}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Stop and target
            </dt>
            <dd className="text-slate-800">
              {payload.ruleset.stop} {payload.ruleset.target}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Exit to flat
            </dt>
            <dd className="text-slate-800">{payload.ruleset.exit}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Bars used
            </dt>
            <dd className="text-slate-800">{payload.ruleset.candles}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-slate-700">
          The full ruleset — including the exact EMA and ATR definitions, and the price series the
          indicators are read from — is written down and kept with the code as ruleset{" "}
          {payload.ruleset.version}. These signals are mechanical: they follow that text and nothing
          else, and the wording above is reused verbatim from it.
        </p>
        <p className="mt-4 text-xs text-slate-600">
          Independently checkable: the same numbers are served as JSON at{" "}
          <a className="font-mono text-slate-900 underline" href="/api/signals">
            /api/signals
          </a>
          , including the raw indicator values, the bid/ask snapshot and the exact upstream request
          used.
        </p>
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
        <h2 className="text-lg font-semibold text-slate-900">Risk note</h2>
        <p className="mt-2 text-sm text-slate-700">{payload.disclaimer}</p>
        <p className="mt-3 text-sm text-slate-700">
          Historical backtests: negative at hourly and daily granularity.
          See the backtest and signal record pages for their separate measurements. Nothing here is a
          prediction, and leverage can lose more than is put in.
        </p>
      </section>

      <footer className="mt-8 pb-4 text-xs text-slate-500">
        Personal use tool. Practice execution is available only through the authenticated execution console or backend operator. Hourly bars from the
        owner&rsquo;s own broker account feed, with only broker-completed bars used. Bid/ask figures
        are indicative {payload.data.primary.accountType} account quotes shown as a cost input only.
      </footer>
    </main>
  );
}
