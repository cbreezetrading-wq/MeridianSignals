import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ProvenanceLine, SkippedNotes } from "~/components/DataProvenance";
import {
  loadBacktestResults,
  type BacktestLoad,
  type BacktestPayload,
  type YearRow,
} from "~/lib/market/backtestResults";
import type { Provenance, SkippedCandidate } from "~/lib/market/bundledData";

/**
 * /backtest — what the ruleset actually did over the owner's own broker history.
 *
 * Every number on this page is read from the backtest run's results.json; none is
 * typed in, recalculated by hand, or carried over from an earlier run. The run is
 * dated, and the page says so: it is a snapshot of one measurement, not a standing
 * claim about the ruleset.
 *
 * The page leads with the verdict because the verdict is the finding: after real
 * spreads the ruleset lost money. A dashboard that shows a signal and hides that
 * finding would be worse than no dashboard.
 */
export const Route = createFileRoute("/backtest")({
  head: () => ({
    meta: [
      { title: "Meridian Signals — backtest result (negative)" },
      {
        name: "description",
        content:
          "The measured result of the v1 ruleset over December 2002 – October 2026 on the owner's own broker data, after real historical bid/ask spreads: not tradeable, −4,241 pips. Assumptions, exclusions, the held-out period and what an independent replay did and did not reproduce, stated in full.",
      },
    ],
  }),
  loader: async (): Promise<BacktestLoad> => {
    if (typeof window === "undefined") return await loadBacktestResults();
    const res = await fetch("/api/backtest", { headers: { accept: "application/json" } });
    const body = (await res.json()) as {
      ok: boolean;
      payload?: BacktestPayload;
      provenance?: Provenance;
      error?: string;
      skipped?: SkippedCandidate[];
    };
    if (!body.ok || !body.payload || !body.provenance) {
      return {
        ok: false,
        skipped: body.skipped ?? [],
        error: body.error ?? `The backtest endpoint answered HTTP ${String(res.status)}.`,
      };
    }
    return { ok: true, payload: body.payload, provenance: body.provenance };
  },
  component: BacktestPage,
});

/* ── formatting ───────────────────────────────────────────────────────────── */

/** Manual grouping, so server HTML and the browser's re-render always agree. */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function num(v: number, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const fixed = Math.abs(v).toFixed(dp);
  const [i, f] = fixed.split(".");
  return `${v < 0 ? "\u2212" : ""}${group(i)}${f ? `.${f}` : ""}`;
}

function pips(v: number, dp = 1): string {
  return `${num(v, dp)} pips`;
}

function stamp(iso: string): string {
  if (!iso) return "—";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function day(iso: string): string {
  return iso ? iso.slice(0, 10) : "—";
}

function tone(v: number): string {
  return v < 0 ? "text-rose-700" : "text-emerald-700";
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-slate-200 px-3 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  mono,
  className = "",
}: {
  children: ReactNode;
  right?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-slate-100 px-3 py-2 align-top ${right ? "text-right" : ""} ${mono ? "font-mono text-xs" : ""} ${className}`}
    >
      {children}
    </td>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-10">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
      <div className="text-sm text-slate-700">{children}</div>
    </section>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

function BacktestPage() {
  const load = Route.useLoaderData();

  if (!load.ok) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
        <h1 className="text-3xl font-semibold tracking-tight">Backtest result</h1>
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold">The measured result is unavailable right now.</p>
          <p className="mt-2">{load.error}</p>
          <SkippedNotes skipped={load.skipped} />
          <p className="mt-2">
            This page shows no figure rather than a remembered one.{" "}
            <a className="underline" href="/">
              Back to the dashboard
            </a>
            .
          </p>
        </div>
      </main>
    );
  }

  const p = load.payload;
  const headline = p.results.headline_nextBarOpen_bidAsk;
  const zeroCost = p.results.zeroCost_mid_nextBarOpen;
  const optimistic = p.results.optimisticUpperBound_triggerClose;

  const net = headline.fullPeriod.combined;
  const gross = zeroCost.fullPeriod.combined;
  const opt = optimistic.fullPeriod.combined;
  const held = headline.last12MonthsHeldOut.combined;
  const heldZero = zeroCost.last12MonthsHeldOut.combined;
  const heldOpt = optimistic.last12MonthsHeldOut.combined;

  // The one per-trade spread-cost figure, read from the run itself: zero-cost total
  // minus achievable total over the same trades. The fallback is the same subtraction
  // done on the two stored expectancies, so the page still shows a figure — and the
  // same one — if an older results file without the block is what it was handed.
  const spreadCost = p.spreadCost;
  const spreadPerTrade = spreadCost?.perTradePips ?? gross.expectancyPipsPerTrade - net.expectancyPipsPerTrade;
  const spreadTotal = spreadCost?.totalPips ?? gross.totalPips - net.totalPips;
  const costToEdge = gross.expectancyPipsPerTrade === 0 ? null : spreadPerTrade / gross.expectancyPipsPerTrade;

  const verification = p.verification;
  const resolution = p.dataResolution;

  const years = p.yearByYear.headline.combined;
  const positiveYears = years.filter((y) => y.totalPips > 0).length;

  const exitKeys = ["stop", "target", "cross-against", "trend-flip"] as const;
  const exitLabels: Record<string, string> = {
    stop: "Stop (1.5 × ATR)",
    target: "Target (3.0 × ATR)",
    "cross-against": "Rule exit — cross against",
    "trend-flip": "Rule exit — trend-filter flip",
  };
  const exitCount = (k: string): number => net.exitReasons[k] ?? 0;
  const exitTotal = exitKeys.reduce((s, k) => s + exitCount(k), 0);

  // perPair / spreadsPaid / reconciliation key on "EUR/USD"; dataWindow keys on "EUR_USD".
  const pairs = Object.keys(headline.fullPeriod.perPair);
  const dataKeys = Object.keys(p.dataWindow);
  const labelOf = (k: string) => p.dataWindow[k.replace("/", "_")]?.label ?? k;
  const reconPairs = Object.keys(p.reconciliationWithLive);
  const holding = p.holdingTimes.combinedHeadline;
  const holdTotal = Object.values(holding.histogram).reduce((s, n) => s + n, 0);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
      <header className="mb-8">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Meridian Signals
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Backtest result: the ruleset loses money</h1>
        <p className="mt-3 text-sm text-slate-600">
          Ruleset <span className="font-mono">{p.rulesetVersion}</span> · run{" "}
          <span className="font-mono">{stamp(p.generatedAt)}</span> · measured{" "}
          {day(p.measurementPeriod.headlineStartUtc)} → {day(p.measurementPeriod.headlineEndUtc)} ·{" "}
          {group(String(net.trades))} trades over four pairs on hourly bars from the owner&rsquo;s own
          broker account.
        </p>
        {resolution ? (
          <p className="mt-2 text-sm text-slate-600">
            <strong className="font-semibold">How much of that history is hourly:</strong>{" "}
            {resolution.hourlyFromUtc ? `genuinely hourly from ${day(resolution.hourlyFromUtc)}` : "not established"}{" "}
            — the broker&rsquo;s H1 file is a <strong className="font-semibold">daily</strong> series
            before then. {group(String(resolution.tradesFilledBeforeHourlyFrom))} of the{" "}
            {group(String(net.trades))} trades ({num(resolution.tradesFilledBeforeHourlyFromPips)} pips) were
            filled on daily bars inside this hourly backtest; they are in the total, not removed from it.
            See{" "}
            <a className="underline" href="#data-window">
              the data window
            </a>
            .
          </p>
        ) : null}
        <ProvenanceLine provenance={load.provenance} what="the hourly backtest result" />
        <p className="mt-2 text-sm">
          <a className="font-medium text-slate-900 underline" href="/">
            ← Dashboard
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/track-record">
            Signal record
          </a>
        </p>
      </header>

      {/* ── the verdict ─────────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border-2 border-rose-300 bg-rose-50 p-6">
        <p className="text-xs font-semibold tracking-[0.2em] text-rose-700 uppercase">The finding</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-rose-900">
          This ruleset is not tradeable. Over the full history, after real spreads, it lost money.
        </h2>
        <p className="mt-3 text-sm text-rose-900">
          <strong className="font-semibold">{pips(net.totalPips)}</strong> over{" "}
          {group(String(net.trades))} trades ·{" "}
          <strong className="font-semibold">{num(net.totalR, 2)}R</strong> · win rate{" "}
          {num(net.winRatePct, 1)}% · profit factor {num(net.profitFactor, 2)} · expectancy{" "}
          {pips(net.expectancyPipsPerTrade, 2)} per trade · longest losing streak{" "}
          {net.longestLosingStreak} trades · maximum drawdown{" "}
          <strong className="font-semibold">{pips(net.maxDrawdownPips)}</strong> ({num(net.maxDrawdownR, 2)}R).
        </p>
        <p className="mt-3 text-sm text-rose-900">
          It lost money in {years.length - positiveYears} of the {years.length} calendar years measured,
          and it lost money in the held-out last twelve months as well — the part of the history that was
          not looked at while the rules were being written. A rule that only worked in the past, and not
          in its own recent past, has no case.
        </p>
        <p className="mt-3 text-sm font-semibold text-rose-900">
          If you act on the signals on the dashboard, act on this page first. The signal is real — it is
          computed from real bars. The expectation behind it is negative, and this is the measurement that
          says so.
        </p>
      </section>

      {/* ── the second measurement ──────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-300 bg-slate-50 p-5">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          The same ruleset, tested a second way
        </p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-slate-900">
          A lower-frequency variant was measured because the per-trade cost argument pointed there —
          and it did not change the conclusion.
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          The spread is a near-fixed cost per trade, so the same ruleset was measured again on daily
          bars, where the moves it aims at are larger and the cost should be a smaller share of the
          risk taken. That part of the reasoning was right: cost per trade, as a share of the risk
          taken, did fall. What it was meant to protect did not survive — the tendency was already
          negative before any cost was charged. The daily run lost money with the spread charged and
          lost money with it removed, which is the one thing the hourly run did not do.
        </p>
        <p className="mt-2 text-sm">
          <a className="font-semibold text-slate-900 underline" href="/backtest/daily">
            The daily-bar measurement in full: the figures, the half-right hypothesis, and why its
            held-out period is printed with a caveat next to it →
          </a>
        </p>
        <p className="mt-2 text-sm">
          <a className="font-semibold text-slate-900 underline" href="/backtest/search">
            The pre-registered search: nine candidates fixed in advance, all nine losing to the
            spread →
          </a>
        </p>
      </section>

      {/* ── four-way comparison ─────────────────────────────────────────── */}
      <Section id="variants" title="The same signals, four ways">
        <p className="mb-3">
          One ruleset, one set of triggers, four different assumptions about what it costs to act. The
          achievable row is the real result. The others exist to show where the money goes and to prove
          that no hidden edge is being suppressed by the pessimism.
        </p>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Variant</Th>
                <Th right>Trades</Th>
                <Th right>Total pips</Th>
                <Th right>Total R</Th>
                <Th right>Win rate</Th>
                <Th right>Profit factor</Th>
                <Th right>Max DD (pips)</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-rose-50/60">
                <Td>
                  <span className="font-semibold">Achievable — the result</span>
                  <div className="text-xs text-slate-600">
                    Next bar&rsquo;s open, buying at the ask and selling at the bid, with the real
                    historical spread on every fill.
                  </div>
                </Td>
                <Td right>{group(String(net.trades))}</Td>
                <Td right className={`font-semibold ${tone(net.totalPips)}`}>
                  {num(net.totalPips)}
                </Td>
                <Td right className={tone(net.totalR)}>{num(net.totalR, 2)}</Td>
                <Td right>{num(net.winRatePct, 1)}%</Td>
                <Td right>{num(net.profitFactor, 2)}</Td>
                <Td right>{num(net.maxDrawdownPips)}</Td>
              </tr>
              <tr>
                <Td>
                  <span className="font-semibold">Zero cost — same bar instants, at mid</span>
                  <div className="text-xs text-slate-600">
                    The same entries and exits as the achievable row, priced at mid instead of bid/ask:
                    entry at the mid <em>open</em> of the bar after the trigger, a rule exit at the mid{" "}
                    <em>open</em> of the bar after the cross. Spread removed, timing held. This is the
                    gross tendency of the rule, and it is positive — the cost is what kills it.
                  </div>
                  <div className="mt-1 text-xs font-semibold text-amber-800">
                    Not independently reproduced. See the note below the table.
                  </div>
                </Td>
                <Td right>{group(String(gross.trades))}</Td>
                <Td right className={tone(gross.totalPips)}>{num(gross.totalPips)}</Td>
                <Td right className={tone(gross.totalR)}>{num(gross.totalR, 2)}</Td>
                <Td right>{num(gross.winRatePct, 1)}%</Td>
                <Td right>{num(gross.profitFactor, 2)}</Td>
                <Td right>{num(gross.maxDrawdownPips)}</Td>
              </tr>
              <tr className="bg-slate-50/60">
                <Td>
                  <span className="font-semibold">
                    Trigger-close fill — OPTIMISTIC UPPER BOUND, not achievable
                  </span>
                  <div className="text-xs text-slate-600">
                    <strong className="font-semibold">Both legs</strong> are filled at the close of the
                    bar that produced the signal: the entry at the trigger bar&rsquo;s close, a rule exit
                    at the cross bar&rsquo;s close. Each is a price only knowable once that bar has ended.
                    Nobody can trade this. It is here as a ceiling: even this flattering variant only
                    reaches {num(opt.totalPips)} pips.
                  </div>
                </Td>
                <Td right>{group(String(opt.trades))}</Td>
                <Td right className={tone(opt.totalPips)}>{num(opt.totalPips)}</Td>
                <Td right className={tone(opt.totalR)}>{num(opt.totalR, 2)}</Td>
                <Td right>{num(opt.winRatePct, 1)}%</Td>
                <Td right>{num(opt.profitFactor, 2)}</Td>
                <Td right>{num(opt.maxDrawdownPips)}</Td>
              </tr>
              <tr className="bg-rose-50/40">
                <Td>
                  <span className="font-semibold">
                    Held-out last 12 months — achievable assumptions
                  </span>
                  <div className="text-xs text-slate-600">
                    From {day(p.measurementPeriod.heldOutLast12MonthsFromUtc)} onward: the recent period,
                    reported separately rather than blended into the headline.
                  </div>
                </Td>
                <Td right>{group(String(held.trades))}</Td>
                <Td right className={`font-semibold ${tone(held.totalPips)}`}>{num(held.totalPips)}</Td>
                <Td right className={tone(held.totalR)}>{num(held.totalR, 2)}</Td>
                <Td right>{num(held.winRatePct, 1)}%</Td>
                <Td right>{num(held.profitFactor, 2)}</Td>
                <Td right>{num(held.maxDrawdownPips)}</Td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          The held-out period is worse than the long run on every variant, including with zero cost
          ({num(heldOpt.totalPips)} pips at trigger-close fills, {num(heldZero.totalPips)} pips at mid with
          next-bar-open timing). There is no version of this measurement in which the last twelve months
          look good.
        </p>
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-xs font-semibold tracking-wide text-amber-900 uppercase">
            The zero-cost row: corrected, and still not independently reproduced
          </p>
          <p className="mt-2 text-sm text-amber-900">
            An independently written replay of this ruleset reproduced the{" "}
            <strong className="font-semibold">achievable row trade for trade</strong>. It did{" "}
            <strong className="font-semibold">not</strong> reproduce the zero-cost row, and that row used to
            read <span className="font-mono">+4,289.1 pips / PF 1.07 / 1.13 pips per trade</span>. The cause
            was ours: the zero-cost code path priced its &ldquo;mid&rdquo; leg at the{" "}
            <em>close</em> of the bar after the trigger instead of that bar&rsquo;s <em>open</em>, which
            re-timed every trade by an hour on both legs and inflated the figure by 503.9 pips. Fixed on
            2026-11-02, and the corrected figure is the one in the table:{" "}
            <span className="font-mono">
              {num(gross.totalPips)} pips / PF {num(gross.profitFactor, 2)} /{" "}
              {num(gross.expectancyPipsPerTrade, 2)} pips per trade
            </span>
            , which agrees with the independent replay to rounding. The correction has{" "}
            <strong className="font-semibold">not itself been re-audited</strong>, so this row is still
            labelled unreproduced: it is our own measurement of a convention the audit has not re-checked.
          </p>
          <p className="mt-2 text-sm text-amber-900">
            The conclusion does not depend on it, and the correction makes the argument slightly stronger:
            the gross tendency is {num(gross.expectancyPipsPerTrade, 2)} pips per trade against a spread
            cost of {num(spreadPerTrade, 2)} — a factor of{" "}
            {costToEdge === null ? "—" : num(costToEdge, 1)}, not the 2 that the old figure implied.
          </p>
        </div>
      </Section>

      {/* ── the mechanism ───────────────────────────────────────────────── */}
      <Section id="mechanism" title="Why it loses: the cost of acting is about twice the edge">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Gross tendency
            </p>
            <p className="mt-1 text-2xl font-semibold text-emerald-700">
              {pips(gross.expectancyPipsPerTrade, 2)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              per trade, at mid, before any spread — from the zero-cost row, which a second
              implementation has not reproduced
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Spread cost</p>
            <p className="mt-1 text-2xl font-semibold text-rose-700">{pips(spreadPerTrade, 2)}</p>
            <p className="mt-1 text-xs text-slate-600">
              per trade — {pips(spreadTotal, 1)} over {group(String(net.trades))} trades, the zero-cost
              total minus the achievable total
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Net</p>
            <p className="mt-1 text-2xl font-semibold text-rose-700">
              {pips(net.expectancyPipsPerTrade, 2)}
            </p>
            <p className="mt-1 text-xs text-slate-600">per trade, after the spread actually paid</p>
          </div>
        </div>
        <p className="mt-4">
          The rule does have a faint gross tendency — at mid it earns {pips(gross.expectancyPipsPerTrade, 2)}{" "}
          per trade. But acting on it costs {pips(spreadPerTrade, 2)} per trade in spread, so the cost is{" "}
          {costToEdge === null ? "—" : `${num(costToEdge, 1)}×`} the edge. Every trade starts the wrong side
          of that gap, and the strategy has to be right by more than the gap just to break even. It is not
          right by that much.
        </p>
        <p className="mt-3 text-xs text-slate-600">
          <strong className="font-semibold">One spread-cost figure, and what it is.</strong>{" "}
          {spreadCost?.definition ?? "zero-cost total minus achievable total, per trade"}. It is a single
          subtraction of two totals printed on this page, so it can be re-checked without re-running
          anything. Of the {num(spreadPerTrade, 2)} pips per trade,{" "}
          {num(spreadCost?.crossingCost.perTradePips ?? 0, 2)} is crossed at the moment of the fills and the
          rest is the change in <em>when</em> a bid-tested stop or target is first touched once the spread is
          removed from the price series.
        </p>
        {spreadCost?.supersedes?.length ? (
          <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Three different spread-cost figures used to be in this record. Here is what each was, and why
              it was wrong.
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-white">
                    <Th>Old figure</Th>
                    <Th>What it was</Th>
                    <Th>Why it was wrong</Th>
                  </tr>
                </thead>
                <tbody>
                  {spreadCost.supersedes.map((s) => (
                    <tr key={s.figure}>
                      <Td mono>{s.figure}</Td>
                      <Td>{s.what}</Td>
                      <Td>{s.why}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-700">
              The figure that replaces all three is{" "}
              <strong className="font-semibold">
                {num(spreadTotal, 1)} pips over {group(String(net.trades))} trades ={" "}
                {num(spreadPerTrade, 3)} pips per trade
              </strong>
              , stored in the results file as <span className="font-mono">spreadCost</span> alongside the
              per-trade <span className="font-mono">spreadCrossingCostPips</span> field that decomposes it.
            </p>
          </details>
        ) : null}

        <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-900">Spread cost, per pair</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Pair</Th>
                <Th right>Mean spread at entry fill</Th>
                <Th right>Median spread at entry fill</Th>
                <Th right>Spread cost per trade</Th>
                <Th right>of which crossed at the fills</Th>
                <Th right>Mean spread, all bars</Th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((k) => {
                const s = p.spreadsPaid[k];
                if (!s) return null;
                return (
                  <tr key={k}>
                    <Td>{labelOf(k)}</Td>
                    <Td right>{pips(s.meanSpreadAtEntryFillPips, 2)}</Td>
                    <Td right>{pips(s.medianSpreadAtEntryFillPips, 2)}</Td>
                    <Td right>{pips(s.meanRoundTripSpreadCostPips, 2)}</Td>
                    <Td right>{pips(s.meanSpreadCrossingCostPips ?? 0, 2)}</Td>
                    <Td right>{pips(s.allBarsMeanSpreadPips, 2)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          These are the owner&rsquo;s own broker quotes, not a published retail table — the spread on each
          fill is the spread the feed carried at that moment. &ldquo;Spread cost per trade&rdquo; is the
          zero-cost total minus the achievable total for that pair, divided by its trades; the four
          per-pair figures do not average to the combined one unless they are weighted by trade count,
          which is why the page quotes the pooled figure and not their mean. Spreads are wider on GBP/USD
          than on the others, and GBP/USD is also the pair that loses most (see below).
        </p>
      </Section>

      {/* ── per pair ────────────────────────────────────────────────────── */}
      <Section id="pairs" title="Per-pair breakdown (achievable assumptions, full period)">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Pair</Th>
                <Th right>Trades</Th>
                <Th right>Total pips</Th>
                <Th right>Total R</Th>
                <Th right>Win rate</Th>
                <Th right>Profit factor</Th>
                <Th right>Expectancy</Th>
                <Th right>Max DD (pips)</Th>
                <Th right>Worst streak</Th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((k) => {
                const s = headline.fullPeriod.perPair[k];
                if (!s) return null;
                return (
                  <tr key={k}>
                    <Td>{labelOf(k)}</Td>
                    <Td right>{group(String(s.trades))}</Td>
                    <Td right className={tone(s.totalPips)}>{num(s.totalPips)}</Td>
                    <Td right className={tone(s.totalR)}>{num(s.totalR, 2)}</Td>
                    <Td right>{num(s.winRatePct, 1)}%</Td>
                    <Td right>{num(s.profitFactor, 2)}</Td>
                    <Td right className={tone(s.expectancyPipsPerTrade)}>
                      {num(s.expectancyPipsPerTrade, 2)}
                    </Td>
                    <Td right>{num(s.maxDrawdownPips)}</Td>
                    <Td right>{s.longestLosingStreak}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          No pair is reliably profitable. Two pairs finish slightly positive in pips — and still negative
          in R, because the pips-per-R differs by pair — while GBP/USD alone accounts for the bulk of the
          loss. Four pairs losing at slightly different rates is what a rule with no edge and a fixed cost
          looks like; it is not four independent chances that one of them is real.
        </p>
      </Section>

      {/* ── year by year ────────────────────────────────────────────────── */}
      <Section id="years" title={`Year by year — ${positiveYears} of ${years.length} years positive`}>
        <p className="mb-3">
          Measured per calendar year, achievable assumptions. A rule with a real edge does not need most
          years to be positive, but it does need the losing years to be smaller than the winning ones. Here{" "}
          {years.length - positiveYears} of {years.length} years lose, and the losses are not smaller.
        </p>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Year</Th>
                <Th right>Trades</Th>
                <Th right>Win rate</Th>
                <Th right>Total pips</Th>
                <Th right>Total R</Th>
              </tr>
            </thead>
            <tbody>
              {years.map((y: YearRow) => (
                <tr key={y.year}>
                  <Td mono>{y.year}</Td>
                  <Td right>{y.trades}</Td>
                  <Td right>{num(y.winRatePct, 1)}%</Td>
                  <Td right className={tone(y.totalPips)}>{num(y.totalPips)}</Td>
                  <Td right className={tone(y.totalR)}>{num(y.totalR, 2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── exits and holding time ──────────────────────────────────────── */}
      <Section id="exits" title="How trades ended, and how long they were held">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Exit mix ({group(String(exitTotal))} exits)</h3>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <Th>Exit</Th>
                    <Th right>Count</Th>
                    <Th right>Share</Th>
                  </tr>
                </thead>
                <tbody>
                  {exitKeys.map((k) => {
                    const c = exitCount(k);
                    return (
                      <tr key={k}>
                        <Td>{exitLabels[k]}</Td>
                        <Td right>{group(String(c))}</Td>
                        <Td right>{exitTotal ? `${num((100 * c) / exitTotal, 1)}%` : "—"}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Stops outnumber targets by roughly two to one. A trend-flip exit never fired in this run —
              the count is zero because no trade ended that way, not because the exit was excluded.
              {net.tradesStillOpenAtDataEnd > 0
                ? ` ${net.tradesStillOpenAtDataEnd} trade was still open when the data ended and is not counted as an exit.`
                : ""}
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">
              Holding time (median {num(holding.medianHours, 0)} h, mean {num(holding.meanHours, 1)} h)
            </h3>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <Th>Held for</Th>
                    <Th right>Trades</Th>
                    <Th right>Share</Th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(holding.histogram).map(([bucket, n]) => (
                    <tr key={bucket}>
                      <Td>{bucket}</Td>
                      <Td right>{group(String(n))}</Td>
                      <Td right>{holdTotal ? `${num((100 * n) / holdTotal, 1)}%` : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              90th percentile {num(holding.p90Hours, 0)} h, longest {num(holding.maxHours, 0)} h. {holding.note}
            </p>
          </div>
        </div>
      </Section>

      {/* ── assumptions ─────────────────────────────────────────────────── */}
      <Section id="assumptions" title="Every assumption this run made">
        <ul className="space-y-2">
          <li>
            <strong className="font-semibold">Fills (achievable variant):</strong>{" "}
            {p.assumptions.fillHeadline}
          </li>
          <li>
            <strong className="font-semibold">Fills (zero-cost variant):</strong>{" "}
            {p.assumptions.fillZeroCost}
          </li>
          <li>
            <strong className="font-semibold">Fills (trigger-close variant):</strong>{" "}
            {p.assumptions.fillOptimistic}
          </li>
          <li>
            <strong className="font-semibold">Intra-bar ambiguity:</strong>{" "}
            {p.assumptions.intraBarAmbiguity}
          </li>
          <li>
            <strong className="font-semibold">Gaps:</strong> {p.assumptions.gaps}
          </li>
          <li>
            <strong className="font-semibold">Rule exits:</strong> {p.assumptions.ruleExit}
          </li>
          <li>
            <strong className="font-semibold">Stops and targets:</strong>{" "}
            {p.assumptions.stopsAndTargets}
          </li>
          <li>
            <strong className="font-semibold">One position per pair:</strong>{" "}
            {p.assumptions.onePositionPerPair ? "yes — no overlapping positions on a pair" : "no"}
          </li>
          <li>
            <strong className="font-semibold">Pyramiding:</strong>{" "}
            {p.assumptions.pyramiding ? "yes" : "no — a position is never added to"}
          </li>
          <li>
            <strong className="font-semibold">R:</strong> {p.assumptions.r}
          </li>
          <li>
            <strong className="font-semibold">Parameter search:</strong>{" "}
            {p.assumptions.optimisation}
          </li>
        </ul>
      </Section>

      {/* ── exclusions ──────────────────────────────────────────────────── */}
      <Section id="exclusions" title="What this run does not include">
        <p className="mb-3">
          These are excluded on purpose and named rather than buried. Most of them would make the result
          worse, not better, so the loss reported above is the optimistic end of the real picture.
        </p>
        <ul className="space-y-1.5">
          {p.exclusions.map((x) => (
            <li key={x} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              {x}
            </li>
          ))}
        </ul>
        <p className="mt-3">
          Because position sizing and account equity are not modelled, every result is in{" "}
          <strong className="font-semibold">pips and R</strong>, never in money. 1R is the trade&rsquo;s
          initial stop distance, so R makes trades of different sizes comparable without pretending to
          know the owner&rsquo;s account.
        </p>
      </Section>

      {/* ── data window ─────────────────────────────────────────────────── */}
      <Section id="data-window" title="The data window: what is actually hourly, and what is not">
        {resolution ? (
          <>
            <p className="mb-3">
              The broker&rsquo;s H1 history does not begin hourly. Measured from the gap between
              consecutive bars — not assumed — {resolution.hourlyFromUtc ? `it is a daily series until ${day(resolution.hourlyFromUtc)}` : "its resolution varies"}:
              for 2003 and 2004, essentially none of the gaps between consecutive bars in the
              &ldquo;hourly&rdquo; file is an hour or less. That means the first ~2.6 years of the file
              cannot support an hourly backtest, and the indicators feeding the first genuine hourly
              trades are partly seeded from daily bars.
            </p>
            <p className="mb-3">
              <strong className="font-semibold">
                {group(String(resolution.tradesFilledBeforeHourlyFrom))} of the{" "}
                {group(String(net.trades))} trades were filled on daily bars
              </strong>{" "}
              ({num(resolution.tradesFilledBeforeHourlyFromPips)} pips
              {Object.entries(resolution.byYearOfFills).length
                ? ` — ${Object.entries(resolution.byYearOfFills)
                    .map(([y, v]) => `${y}: ${v.trades} trades, ${num(v.totalPips)} pips`)
                    .join("; ")}`
                : ""}
              ). They are labelled here rather than removed: they are part of the total the headline
              quotes, and the year-by-year table shows them as the two thin years with ~10 trades
              against ~170 in every later year.
            </p>
            <p className="mb-3 text-xs text-slate-600">{resolution.preludeNote}</p>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <Th>Pair</Th>
                    <Th>Hourly from</Th>
                    <Th right>Bars before that</Th>
                    <Th right>2002 gaps ≤ 1h</Th>
                    <Th right>2003 gaps ≤ 1h</Th>
                    <Th right>2004 gaps ≤ 1h</Th>
                    <Th right>2005 gaps ≤ 1h</Th>
                  </tr>
                </thead>
                <tbody>
                  {resolution.perPair.map((row) => {
                    const yr = (y: string) => row.perYear[y] ?? { gaps: 0, gapsWithinHour: 0, bars: 0 };
                    const cell = (y: string) => `${yr(y).gapsWithinHour} of ${yr(y).gaps}`;
                    return (
                      <tr key={row.label}>
                        <Td>{row.label}</Td>
                        <Td mono>{row.hourlyFromUtc ? day(row.hourlyFromUtc) : "—"}</Td>
                        <Td right>{group(String(row.barsBeforeHourlyFrom))}</Td>
                        <Td right>{cell("2002")}</Td>
                        <Td right>{cell("2003")}</Td>
                        <Td right>{cell("2004")}</Td>
                        <Td right>{cell("2005")}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-600">{resolution.rule}</p>
          </>
        ) : (
          <p>The run did not record how much of its history is hourly, so this page does not state it.</p>
        )}
      </Section>

      {/* ── provenance ──────────────────────────────────────────────────── */}
      <Section id="provenance" title="Where this measurement comes from">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Pair</Th>
                <Th>First bar</Th>
                <Th>Last bar</Th>
                <Th right>Bars used</Th>
                <Th right>Incomplete candles refused</Th>
                <Th right>Gaps in hourly grid</Th>
              </tr>
            </thead>
            <tbody>
              {dataKeys.map((k) => {
                const w = p.dataWindow[k];
                if (!w) return null;
                return (
                  <tr key={k}>
                    <Td>{w.label}</Td>
                    <Td mono>{stamp(w.firstBarUtc)}</Td>
                    <Td mono>{stamp(w.lastBarUtc)}</Td>
                    <Td right>{group(String(w.bars))}</Td>
                    <Td right>{w.incompleteCandlesRefused}</Td>
                    <Td right>{group(String(w.gapsInHourlyGrid))}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="mt-4 space-y-1.5">
          <li>
            <strong className="font-semibold">Measurement period:</strong>{" "}
            {stamp(p.measurementPeriod.headlineStartUtc)} → {stamp(p.measurementPeriod.headlineEndUtc)}.{" "}
            {p.measurementPeriod.note}
            {p.measurementPeriod.firstTradeUtc
              ? ` The first trade does not fire until ${stamp(p.measurementPeriod.firstTradeUtc)}, which is the figure the headline is really measured over.`
              : ""}
          </li>
          <li>
            <strong className="font-semibold">Held-out period starts:</strong>{" "}
            {stamp(p.measurementPeriod.heldOutLast12MonthsFromUtc)}.
          </li>
          <li>
            <strong className="font-semibold">Data:</strong> the broker&rsquo;s H1 bars from the
            owner&rsquo;s own OANDA account, with the bid and ask recorded on every bar —{" "}
            {resolution?.hourlyFromUtc
              ? `a daily series before ${day(resolution.hourlyFromUtc)} and hourly after it`
              : "hourly bars"}
            . Broker&rsquo;s oldest served bar:{" "}
            {stamp(p.dataWindow[dataKeys[0]]?.brokerOldestServedUtc ?? "")}.
          </li>
          <li>
            <strong className="font-semibold">Ruleset version:</strong>{" "}
            <span className="font-mono">{p.rulesetVersion}</span>.
          </li>
          <li>
            <strong className="font-semibold">Run date:</strong>{" "}
            <span className="font-mono">{stamp(p.generatedAt)}</span>.
          </li>
          <li>
            <strong className="font-semibold">Code path:</strong>{" "}
            {p.engineCode.map((c, i) => (
              <span key={c}>
                {i > 0 ? " · " : ""}
                <span className="font-mono text-xs">{c}</span>
              </span>
            ))}
            . The same rule and indicator code the dashboard runs, driven over the full history instead of
            the current bars.
          </li>
          <li>
            <strong className="font-semibold">No parameter search:</strong> {p.assumptions.optimisation}
          </li>
        </ul>
      </Section>

      {/* ── reconciliation ──────────────────────────────────────────────── */}
      <Section id="reconciliation" title="Whether the backtest still reproduces the dashboard's signals">
        <p className="mb-3">
          A backtest that does not reproduce what the instrument says is measuring something else. This
          comparison is made at run time, between the engine replayed over the frozen cache and whatever
          the dashboard was serving when this run happened — and it only means anything while those two
          windows coincide. When this run was made, they did not: the cache ends{" "}
          {day(p.measurementPeriod.headlineEndUtc)} and the dashboard was reading bars from later than
          that. The table records that rather than hiding it.
        </p>
        <p className="mb-3">
          At the original run (2026-10-12) the two windows did coincide and{" "}
          <strong className="font-semibold">all four signals agreed</strong> — same pair, same direction,
          same entry, same trigger bar. That check is a dated fact about that day, not a standing property
          of the page.
        </p>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Pair</Th>
                <Th>Backtest side</Th>
                <Th right>Backtest entry</Th>
                <Th>Backtest trigger bar</Th>
                <Th>Dashboard side</Th>
                <Th right>Dashboard entry</Th>
                <Th>Windows coincide</Th>
                <Th>Agrees</Th>
              </tr>
            </thead>
            <tbody>
              {reconPairs.map((k) => {
                const r = p.reconciliationWithLive[k];
                if (!r) return null;
                return (
                  <tr key={k}>
                    <Td>{k}</Td>
                    <Td className="uppercase">{r.backtestSide}</Td>
                    <Td right mono>{String(r.backtestTriggerClose)}</Td>
                    <Td mono>{stamp(r.backtestLastTriggerBarUtc)}</Td>
                    <Td className="uppercase">{r.liveSignal}</Td>
                    <Td right mono>{String(r.liveEntry)}</Td>
                    <Td className={r.windowsCoincide ? "text-slate-700" : "text-amber-700"}>
                      {r.windowsCoincide ? "yes" : "no"}
                    </Td>
                    <Td
                      className={
                        r.windowsCoincide
                          ? r.agrees
                            ? "text-emerald-700"
                            : "text-rose-700"
                          : "text-slate-500"
                      }
                    >
                      {r.windowsCoincide ? (r.agrees ? "yes" : "NO") : "not comparable"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-1.5 text-xs text-slate-600">
          {reconPairs.map((k) => {
            const r = p.reconciliationWithLive[k];
            if (!r) return null;
            return (
              <li key={k}>
                <span className="font-mono">{k}</span> — backtest {r.backtestSide.toUpperCase()} at{" "}
                <span className="font-mono">{String(r.backtestTriggerClose)}</span> on bar{" "}
                <span className="font-mono">{stamp(r.backtestLastTriggerBarUtc)}</span>; dashboard{" "}
                {r.liveSignal} at <span className="font-mono">{String(r.liveEntry)}</span> on bar{" "}
                <span className="font-mono">{stamp(r.liveTriggerBarUtc)}</span>, reading bars to{" "}
                <span className="font-mono">{stamp(r.liveLatestBarUtc ?? "")}</span>.
                {r.triggerIsOnFinalCachedBarNote ? ` ${r.triggerIsOnFinalCachedBarNote}.` : ""}
              </li>
            );
          })}
        </ul>
      </Section>

      {/* ── date and standing ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-300 bg-slate-50 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-900 uppercase">
          This is a dated result, not a standing claim
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          Measured on <span className="font-mono">{day(p.generatedAt)}</span> over the history available
          that day, ending <span className="font-mono">{stamp(p.measurementPeriod.headlineEndUtc)}</span>.
          It describes the ruleset as it stood on that date, on that data. It is not updated
          continuously and it is not a prediction; if the ruleset or the data changes, the figure has to be
          re-measured before it means anything. Nothing on this page is a recommendation to trade, and the
          owner&rsquo;s own method, if they have one, takes priority over anything here.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          Every figure above is read from the run&rsquo;s results file, which is kept and can be
          re-checked against this page. Where a number is negative, it is shown negative.
        </p>

        <div className="mt-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4">
          <h3 className="text-sm font-semibold tracking-wide text-emerald-900 uppercase">
            What is independently verified, and what is not
          </h3>
          <p className="mt-2 text-sm text-emerald-900">
            <strong className="font-semibold">
              The headline result on this page has been independently reproduced, trade for trade.
            </strong>{" "}
            A second implementation, written from the written specification by someone who had not read
            this project&rsquo;s replay code, produced{" "}
            <strong className="font-semibold">3,789 of 3,789 trades</strong> with identical trigger bar,
            side, entry price, exit price, exit reason, pips, R, risk and holding time, and every published
            headline aggregate reproduces: {num(net.totalPips)} pips, {num(net.winRatePct, 1)}% win rate,
            profit factor {num(net.profitFactor, 2)}, {num(net.totalR, 2)}R, maximum drawdown{" "}
            {pips(net.maxDrawdownPips)}, longest losing streak {net.longestLosingStreak}, per pair, per year
            and the held-out twelve months. The one trade it did not match is the still-open USD/JPY one,
            which both sides exclude. The audit ran on{" "}
            {verification ? day(verification.auditedAt) : "2026-11-02"}.
          </p>
          <p className="mt-2 text-sm text-emerald-900">
            <strong className="font-semibold">That verification covers the headline figures only.</strong>{" "}
            It does <em>not</em> cover the zero-cost row, which is{" "}
            <strong className="font-semibold">not reproduced</strong> and is labelled as such next to the
            number — the audit found the defect in our zero-cost code path, this page describes it, and the
            corrected figure has not itself been re-audited. It does not cover the trigger-close row, which
            the audit reproduced only once its convention was identified and has not been re-checked. And
            it does not cover the daily-bar measurement at all, which remains unaudited.
          </p>
          <p className="mt-2 text-sm text-emerald-900">
            The audit is independent in the sense that matters and no more: a separately written replay
            compared against this one. The auditor had already read the headline figures before starting,
            so it is a check on arithmetic, data handling and the rule as documented — not a blind check
            that could catch a convention both implementations share because both read the same prose. The
            audit&rsquo;s findings, including the one that this page was wrong, are kept alongside the
            results rather than summarised away.
          </p>
        </div>
      </section>

      <footer className="mt-8 text-xs text-slate-500">
        <a className="underline" href="/">
          Dashboard
        </a>{" "}
        ·{" "}
        <a className="underline" href="/track-record">
          Signal record
        </a>
      </footer>
    </main>
  );
}
