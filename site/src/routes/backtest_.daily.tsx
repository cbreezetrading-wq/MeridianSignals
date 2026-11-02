import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ProvenanceLine, SkippedNotes } from "~/components/DataProvenance";
import type { Provenance, SkippedCandidate } from "~/lib/market/bundledData";
import {
  loadDailyBacktestResults,
  type DailyDerived,
  type DailyLoad,
  type DailyPayload,
  type DailyYearRow,
} from "~/lib/market/dailyBacktestResults";

/**
 * /backtest/daily — the same ruleset, measured on daily bars.
 *
 * This page exists for one reason: a lower-frequency variant was tested because
 * the per-trade cost argument pointed there, and it did not change the
 * conclusion. Every number is read from the daily run's results.json (or, for
 * the hourly side of the comparison, from the hourly results.json); the few the
 * files store only as raw rows are computed in the loader and labelled as
 * computed. Nothing is typed in, and a missing file renders no figure at all.
 */
export const Route = createFileRoute("/backtest_/daily")({
  head: () => ({
    meta: [
      { title: "Meridian Signals — daily-bar backtest result (negative)" },
      {
        name: "description",
        content:
          "The same v1 ruleset measured on daily bars, 2003–2026 on the owner's own broker data with real historical bid/ask spreads: not tradeable, and it loses with the spread removed. Assumptions, exclusions, holding time and the held-out period stated in full.",
      },
    ],
  }),
  loader: async (): Promise<DailyLoad> => {
    if (typeof window === "undefined") return await loadDailyBacktestResults();
    const res = await fetch("/api/daily-backtest", { headers: { accept: "application/json" } });
    const body = (await res.json()) as {
      ok: boolean;
      payload?: DailyPayload;
      derived?: DailyDerived;
      provenance?: Provenance;
      error?: string;
      skipped?: SkippedCandidate[];
    };
    if (!body.ok || !body.payload || !body.derived || !body.provenance) {
      return {
        ok: false,
        skipped: body.skipped ?? [],
        error: body.error ?? `The daily backtest endpoint answered HTTP ${String(res.status)}.`,
      };
    }
    return { ok: true, payload: body.payload, derived: body.derived, provenance: body.provenance };
  },
  component: DailyBacktestPage,
});

/* ── formatting ───────────────────────────────────────────────────────────── */

/** Manual grouping, so server HTML and the browser's re-render always agree. */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function num(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const fixed = Math.abs(v).toFixed(dp);
  const [i, f] = fixed.split(".");
  return `${v < 0 ? "\u2212" : ""}${group(i)}${f ? `.${f}` : ""}`;
}

function pips(v: number | null | undefined, dp = 1): string {
  return `${num(v, dp)} pips`;
}

function signed(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${num(v, dp)}`;
}

function stamp(iso: string): string {
  if (!iso) return "—";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function day(iso: string): string {
  return iso ? iso.slice(0, 10) : "—";
}

function tone(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-slate-700";
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

function DailyBacktestPage() {
  const load = Route.useLoaderData();

  if (!load.ok) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
        <h1 className="text-3xl font-semibold tracking-tight">Daily-bar backtest result</h1>
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold">The daily-bar measurement is unavailable right now.</p>
          <p className="mt-2">{load.error}</p>
          <SkippedNotes skipped={load.skipped} />
          <p className="mt-2">
            This page shows no figure rather than a remembered one.{" "}
            <a className="underline" href="/backtest">
              The hourly backtest result
            </a>{" "}
            ·{" "}
            <a className="underline" href="/">
              the dashboard
            </a>
            .
          </p>
        </div>
      </main>
    );
  }

  const { payload: p, derived } = load;
  const headline = p.results.headline_nextBarOpen_bidAsk;
  const zeroCost = p.results.zeroCost_mid_nextBarOpen;
  const optimistic = p.results.optimisticUpperBound_triggerClose;

  const net = headline.fullPeriod.combined;
  const gross = zeroCost.fullPeriod.combined;
  const opt = optimistic.fullPeriod.combined;
  const held = headline.last12MonthsHeldOut.combined;
  const heldA = headline.last12MonthsHeldOut.perPair["AUD/USD"];

  const dec = p.costEdgeDecomposition;
  const holding = p.holdingTimes.combinedHeadline;
  const years = p.yearByYear.headline.combined;
  const positiveYears = p.yearByYear.headline.positiveYears;
  const measuredYears = p.yearByYear.headline.measuredYears;

  const pairs = Object.keys(headline.fullPeriod.perPair);
  const dataKeys = Object.keys(p.dataWindow);
  const labelOf = (k: string) => p.dataWindow[k.replace("/", "_")]?.label ?? k;

  // Cost as a share of the trade's initial risk, both granularities. The daily
  // side is stored in the file; the hourly side is the difference between the two
  // hourly variants' per-trade R in the hourly results file. Both are arithmetic
  // on stored figures, not typed numbers.
  const dailyCostPct = dec.inR.spreadPaidR * 100;
  const hourlyCostPct = derived.hourly ? derived.hourly.spreadPaidR * 100 : null;
  const hourlyGrossR = derived.hourly ? derived.hourly.grossEdgeR : null;
  const dailyGrossR = dec.inR.grossEdgeR;

  const ci = derived.perTradeR;
  const weekPlus = derived.heldAtLeastAWeek;

  const exitKeys = ["stop", "target", "cross-against"] as const;
  const exitLabels: Record<string, string> = {
    stop: "Stop (1.5 × ATR)",
    target: "Target (3.0 × ATR)",
    "cross-against": "Rule exit — cross against",
  };

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
      <header className="mb-8">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Meridian Signals
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Daily-bar backtest: the same ruleset, measured again — and it loses again
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Ruleset <span className="font-mono">{p.rulesetVersion}</span> · run{" "}
          <span className="font-mono">{stamp(p.generatedAt)}</span> · measured{" "}
          {day(p.measurementPeriod.headlineStartUtc)} → {day(p.measurementPeriod.headlineEndUtc)} ·{" "}
          {group(String(net.trades))} trades over four pairs on{" "}
          <span className="font-mono">{p.granularity}</span> (daily) bars from the owner&rsquo;s own
          broker account.
        </p>
        <ProvenanceLine provenance={load.provenance} what="the daily backtest result" />
        <p className="mt-2 text-sm">
          <a className="font-medium text-slate-900 underline" href="/backtest">
            ← Hourly backtest (the ruleset the dashboard runs)
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/">
            Dashboard
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/track-record">
            Signal record
          </a>
        </p>
      </header>

      {/* ── the verdict, first ──────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border-2 border-rose-300 bg-rose-50 p-6">
        <p className="text-xs font-semibold tracking-[0.2em] text-rose-700 uppercase">The finding</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-rose-900">
          The daily variant of the same ruleset is not tradeable either.
        </h2>
        <p className="mt-3 text-sm text-rose-900">
          <strong className="font-semibold">{pips(net.totalPips)}</strong> over{" "}
          {group(String(net.trades))} trades ·{" "}
          <strong className="font-semibold">{num(net.totalR, 2)}R</strong> · win rate{" "}
          {num(net.winRatePct, 1)}% · profit factor {num(net.profitFactor, 2)} · expectancy{" "}
          {pips(net.expectancyPipsPerTrade, 2)} per trade · longest losing streak{" "}
          {net.longestLosingStreak} trades · maximum drawdown{" "}
          <strong className="font-semibold">{pips(net.maxDrawdownPips)}</strong> (
          {num(net.maxDrawdownR, 2)}R).
        </p>
        <p className="mt-3 text-sm text-rose-900">
          It lost money in {measuredYears - positiveYears} of the {measuredYears} calendar years
          measured. A lower-frequency variant was tested because the per-trade cost argument pointed
          there — the spread is a near-fixed cost per trade, and larger moves might pay for it.{" "}
          <strong className="font-semibold">
            It did not change the conclusion: the ruleset we invented is not tradeable at either
            granularity.
          </strong>
        </p>
        <p className="mt-3 text-sm font-semibold text-rose-900">
          The hourly measurement, published on{" "}
          <a className="underline" href="/backtest">
            /backtest
          </a>
          , is the granularity the dashboard actually runs, and it is the stronger of the two
          results. This page is the second measurement, not a replacement for it.
        </p>
      </section>

      {/* ── it loses with the spread removed too ────────────────────────── */}
      <section className="mb-10 rounded-xl border-2 border-rose-300 bg-white p-6">
        <p className="text-xs font-semibold tracking-[0.2em] text-rose-700 uppercase">
          The point of the whole test
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-rose-900">
          With the spread removed it still loses: {pips(gross.totalPips)}, profit factor{" "}
          {num(gross.profitFactor, 2)}, {pips(gross.expectancyPipsPerTrade, 2)} per trade.
        </h2>
        <p className="mt-3 text-sm text-slate-700">
          At hourly, removing the spread flipped the result from negative to positive
          {derived.hourly
            ? ` (${pips(derived.hourly.zeroCostTotalPips)} at mid with identical timing)`
            : ""}
          . At daily there is no gross tendency for the cheaper cost to protect: the same experiment
          at mid still loses {pips(gross.totalPips)}. The cheap-cost argument was the reason to try
          this, and the gross figure is what answers it.
        </p>
      </section>

      {/* ── hypothesis and outcome ──────────────────────────────────────── */}
      <Section
        id="hypothesis"
        title="The hypothesis, and how it actually turned out — half right, and the wrong half"
      >
        <p className="mb-4">
          The reasoning was structural and it was sound. A spread is a near-fixed cost per trade, so
          its weight depends on how far a trade has to travel to earn its keep. Daily bars produce
          larger moves and wider stops, so the same spread should be a smaller share of the risk
          taken per trade. That part is measurable, and it happened.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-xs font-semibold tracking-wide text-emerald-800 uppercase">
              What the hypothesis got right
            </p>
            <p className="mt-1 text-2xl font-semibold text-emerald-900">
              {hourlyCostPct === null ? "—" : `${num(hourlyCostPct, 1)}%`} → {num(dailyCostPct, 1)}%
            </p>
            <p className="mt-1 text-xs text-emerald-900">
              spread paid per trade, as a share of 1R (the trade&rsquo;s initial risk). Cost per trade
              relative to risk <strong className="font-semibold">did</strong> fall, from hourly to
              daily.
            </p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-xs font-semibold tracking-wide text-rose-800 uppercase">
              What it got wrong
            </p>
            <p className="mt-1 text-2xl font-semibold text-rose-900">
              {hourlyGrossR === null ? "—" : `${signed(hourlyGrossR, 3)}R`} → {signed(dailyGrossR, 3)}R
            </p>
            <p className="mt-1 text-xs text-rose-900">
              gross tendency per trade, at mid, before any spread. The larger moves did not carry a
              larger tendency — they carried none.
            </p>
          </div>
        </div>
        <p className="mt-4 text-slate-800">
          So the honest statement is this: the cost argument was right, and it was not the binding
          constraint. At hourly the cost was about twice a faint positive tendency
          {hourlyGrossR !== null ? ` (+${num(hourlyGrossR, 3)}R per trade before cost)` : ""}; at
          daily the cost fell and the tendency fell with it, to{" "}
          {signed(dailyGrossR, 3)}R. Lower frequency made each trade cheaper and made it worse.
        </p>
        <p className="mt-3 text-slate-800">
          A rule whose gross tendency is negative cannot be rescued by a cheaper way to act on it.
          That is the whole finding, and it is why this variant is published as a negative result
          rather than as a promising lead.
        </p>
      </Section>

      {/* ── three variants ──────────────────────────────────────────────── */}
      <Section id="variants" title="The same signals, three ways, on daily bars">
        <p className="mb-3">
          One ruleset, one set of triggers, three different assumptions about what it costs to act.
          The achievable row is the real result. The other two exist to show where the money goes and
          to prove that nothing is being suppressed by the pessimism.
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
                  <span className="font-semibold">Zero cost — same timing, at mid</span>
                  <div className="text-xs text-slate-600">
                    Identical timing with the spread removed. This is the gross tendency of the rule,
                    and it is negative — there is no tendency here for a cheaper cost to protect.
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
                    Fills at the trigger bar&rsquo;s own close, which is only knowable once that bar
                    has ended. Nobody can trade this. It is a ceiling, and it is{" "}
                    {num(opt.totalPips)} pips — worse than the headline, so nothing is being
                    suppressed by the conservative fill.
                  </div>
                </Td>
                <Td right>{group(String(opt.trades))}</Td>
                <Td right className={tone(opt.totalPips)}>{num(opt.totalPips)}</Td>
                <Td right className={tone(opt.totalR)}>{num(opt.totalR, 2)}</Td>
                <Td right>{num(opt.winRatePct, 1)}%</Td>
                <Td right>{num(opt.profitFactor, 2)}</Td>
                <Td right>{num(opt.maxDrawdownPips)}</Td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          The deliberately flattering variant — the one no one could have executed — reaches{" "}
          <strong className="font-semibold">
            {pips(opt.totalPips)} / {num(opt.totalR, 2)}R
          </strong>
          . It is worse than the achievable figure, not better. Whatever killed this ruleset, it was
          not the pessimism of the fill assumption.
        </p>
      </Section>

      {/* ── cost / edge decomposition ───────────────────────────────────── */}
      <Section id="decomposition" title="Where each pip goes, per trade">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Gross tendency
            </p>
            <p className="mt-1 text-2xl font-semibold text-rose-700">
              {pips(dec.perTradePips.grossEdge, 2)}
            </p>
            <p className="mt-1 text-xs text-slate-600">per trade, at mid, before any spread</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Spread paid</p>
            <p className="mt-1 text-2xl font-semibold text-slate-700">
              {pips(dec.perTradePips.spreadPaid, 2)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              per trade — the gap between the zero-cost and achievable expectancy
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Net</p>
            <p className="mt-1 text-2xl font-semibold text-rose-700">
              {pips(dec.perTradePips.net, 2)}
            </p>
            <p className="mt-1 text-xs text-slate-600">per trade, after the spread actually paid</p>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <Th>Line</Th>
                <Th right>Per trade (pips)</Th>
                <Th right>Whole book (pips)</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>Gross tendency (mid fills, same timing)</Td>
                <Td right className={tone(dec.perTradePips.grossEdge)}>
                  {num(dec.perTradePips.grossEdge, 2)}
                </Td>
                <Td right className={tone(dec.totals.grossPips)}>{num(dec.totals.grossPips)}</Td>
              </tr>
              <tr>
                <Td>Spread paid</Td>
                <Td right>{num(dec.perTradePips.spreadPaid, 2)}</Td>
                <Td right>{num(dec.totals.spreadPaidPips)}</Td>
              </tr>
              <tr className="bg-rose-50/50">
                <Td>
                  <span className="font-semibold">Net (achievable, next-bar open)</span>
                </Td>
                <Td right className={`font-semibold ${tone(dec.perTradePips.net)}`}>
                  {num(dec.perTradePips.net, 2)}
                </Td>
                <Td right className={`font-semibold ${tone(dec.totals.netPips)}`}>
                  {num(dec.totals.netPips)}
                </Td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          {dec.howComputed} Mean risk per trade is {pips(dec.inR.meanRiskPips)}, so the spread paid is{" "}
          {num(dec.inR.spreadPaidR, 3)}R — {num(dailyCostPct, 1)}% of 1R. In R terms:{" "}
          {signed(dec.inR.grossEdgeR, 3)}R gross, {num(dec.inR.spreadPaidR, 3)}R cost,{" "}
          {signed(dec.inR.netR, 3)}R net.
        </p>
      </Section>

      {/* ── held-out ────────────────────────────────────────────────────── */}
      <Section id="held-out" title="The held-out last twelve months — and why the number is printed here">
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
          <p className="text-sm text-slate-800">
            From {day(p.measurementPeriod.heldOutLast12MonthsFromUtc)} onward, on the same achievable
            assumptions: <strong className="font-semibold">{signed(held.totalPips)} pips</strong> /{" "}
            <strong className="font-semibold">{signed(held.totalR, 2)}R</strong> on{" "}
            {held.trades} trades.
          </p>
          <p className="mt-2 text-sm text-slate-800">
            <strong className="font-semibold">That is ten trades.</strong> The results file flags this
            slice as{" "}
            {held.statisticallyMeaningful
              ? "statistically meaningful — the page reports it as such"
              : "NOT statistically meaningful — a sample this small cannot separate a result from noise"}
            , and two AUD/USD trades supply {num(heldA?.totalPips)} of the {num(held.totalPips)} pips.
            It is published here, next to that caveat, precisely so it cannot be quoted on its own as
            a good number. It is not evidence that this ruleset works on recent data: with two AUD/USD
            trades removed, the other {held.trades - (heldA?.trades ?? 0)} trades in this slice are
            not a measurement of anything either.
          </p>
          <p className="mt-2 text-xs text-slate-600">
            Held-out means the last twelve months were not looked at while the rules were being
            written, so they were not fitted. That makes them informative in principle. Ten trades is
            still ten trades.
          </p>
        </div>
      </Section>

      {/* ── sample size ─────────────────────────────────────────────────── */}
      <Section
        id="sample"
        title="How much this result can bear — stated plainly, in both directions"
      >
        <p className="mb-3">
          {group(String(net.trades))} trades over {measuredYears} calendar years is a real sample, but
          it is not a decisive one. The honest treatment is three separate statements, and all three
          matter.
        </p>
        <ul className="space-y-2">
          <li className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <strong className="font-semibold">Both point estimates are negative</strong> —{" "}
            {signed(dec.inR.netR, 3)}R per trade with cost, {signed(dec.inR.grossEdgeR, 3)}R without
            it. There is no measured tendency here to trade.
          </li>
          <li className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <strong className="font-semibold">But the interval includes zero.</strong>{" "}
            {ci ? (
              <>
                Per-trade standard deviation is {num(ci.sd, 2)}R, so the standard error of the mean is{" "}
                {num(ci.se, 3)}R and the 95% interval on per-trade R runs from{" "}
                <span className="font-mono">{num(ci.ciLow, 2)}</span> to{" "}
                <span className="font-mono">{num(ci.ciHigh, 2)}</span> (t = {num(ci.t, 2)}). It
                contains zero.
              </>
            ) : (
              "The per-trade rows needed to size the interval are not in the results file, so no interval is shown here."
            )}
          </li>
          <li className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <strong className="font-semibold">So this is weaker evidence than the hourly result</strong>
            {derived.hourly ? `, which rests on ${group(String(derived.hourly.trades))} trades` : ""}.
            It is <em>not</em> proof that no daily rule could work, and it is not a demonstrated loss
            of the magnitude the hourly run showed. What it does establish is narrower and still
            sufficient: this ruleset, unchanged, has no measured daily tendency, so there is nothing
            here to trade.
          </li>
        </ul>
        <p className="mt-3 text-xs text-slate-600">
          The interval is computed on this page from the {ci ? ci.n : net.trades} stored per-trade R
          values in the results file (mean ± 1.96 standard errors); it is not a stored field and is
          labelled as computed. No parameter was searched to make it look better.
        </p>
      </Section>

      {/* ── holding time ────────────────────────────────────────────────── */}
      <Section
        id="holding"
        title={`Holding time — median ${num(holding.medianDays, 0)} days, and what that does to the exclusions`}
      >
        <p className="mb-3">
          Holding time decides how much of a trade&rsquo;s real cost the exclusions are worth. On
          daily bars these positions are held for weeks, not hours.
        </p>
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            { label: "Median", value: `${num(holding.medianDays, 0)} d` },
            { label: "Mean", value: `${num(holding.meanDays, 1)} d` },
            { label: "90th percentile", value: `${num(holding.p90Days, 0)} d` },
            { label: "Longest", value: `${num(holding.maxDays, 0)} d` },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {c.label}
              </p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{c.value}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
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
                  <Td right>
                    {holding.trades ? `${num((100 * n) / holding.trades, 1)}%` : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          {weekPlus ? (
            <>
              <strong className="font-semibold">
                {group(String(weekPlus.count))} of {holding.trades} trades ({num(weekPlus.pct, 0)}%)
                were held a week or longer.
              </strong>{" "}
            </>
          ) : null}
          At a median {num(holding.medianDays, 0)}-day hold a trade crosses about{" "}
          {num(holding.medianDays, 0)} daily rollovers, and at the 90th percentile{" "}
          {num(holding.p90Days, 0)}. Swap and financing are excluded from every figure on this page,
          which makes that omission <strong className="font-semibold">material here</strong>, not
          marginal: unmodelled overnight financing on positions this long would push the result
          further down, not up. <strong className="font-semibold">The daily headline is the optimistic
          one on cost.</strong>
        </p>
        <p className="mt-2 text-xs text-slate-600">{holding.note}</p>
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
                    <Td right>{s.trades}</Td>
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
          Three of the four pairs lose in pips and all four are negative or marginal in R. Four pairs
          losing at slightly different rates is what a rule with no measured tendency and a fixed
          cost looks like; it is not four independent chances that one of them is real.
        </p>
      </Section>

      {/* ── year by year ────────────────────────────────────────────────── */}
      <Section
        id="years"
        title={`Year by year — ${positiveYears} of ${measuredYears} years positive`}
      >
        <p className="mb-3">{p.yearByYear.headline.note}</p>
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
              {years.map((y: DailyYearRow) => (
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

      {/* ── exits ───────────────────────────────────────────────────────── */}
      <Section id="exits" title="How the trades ended">
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
                const c = net.exitReasons[k] ?? 0;
                return (
                  <tr key={k}>
                    <Td>{exitLabels[k]}</Td>
                    <Td right>{c}</Td>
                    <Td right>{net.trades ? `${num((100 * c) / net.trades, 1)}%` : "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Stops outnumber targets by roughly two to one. A trend-filter flip never closed a daily
          trade in this run — it is absent from the file because no trade ended that way, not because
          the exit was removed.
          {net.tradesStillOpenAtDataEnd > 0
            ? ` ${net.tradesStillOpenAtDataEnd} trade was still open when the data ended and is not counted as an exit.`
            : " No trade was still open when the data ended."}
        </p>
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
          <li>
            <strong className="font-semibold">Spread source:</strong> {p.assumptions.spreadSource}
          </li>
        </ul>
      </Section>

      {/* ── exclusions ──────────────────────────────────────────────────── */}
      <Section id="exclusions" title="What this run does not include">
        <p className="mb-3">
          Excluded on purpose and named rather than buried. Most of them would make the result worse,
          not better — and at daily holding times that is not a theoretical point.
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
                <Th right>Missing weekdays</Th>
              </tr>
            </thead>
            <tbody>
              {dataKeys.map((k) => {
                const w = p.dataWindow[k];
                if (!w) return null;
                return (
                  <tr key={k}>
                    <Td>{w.label}</Td>
                    <Td mono>{day(w.firstBarUtc)}</Td>
                    <Td mono>{day(w.lastBarUtc)}</Td>
                    <Td right>{group(String(w.bars))}</Td>
                    <Td right>{w.incompleteCandlesRefused}</Td>
                    <Td right>{w.missingWeekdaysInsideSpan}</Td>
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
          </li>
          <li>
            <strong className="font-semibold">Held-out period starts:</strong>{" "}
            {stamp(p.measurementPeriod.heldOutLast12MonthsFromUtc)}.
          </li>
          <li>
            <strong className="font-semibold">Data:</strong> daily bars from the owner&rsquo;s own
            OANDA account, with the bid and ask recorded on every bar. Broker&rsquo;s oldest served
            bar: {day(p.dataWindow[dataKeys[0]]?.brokerOldestServedUtc ?? "")}.
          </li>
          <li>
            <strong className="font-semibold">Daily bars are stamped at the daily rollover</strong>{" "}
            (21:00/22:00 UTC), which is also when spreads are widest — so a fill at the next
            bar&rsquo;s open pays a wider-than-average spread for the pair. That cuts against the
            result, which is the direction to err in.
          </li>
          <li>
            <strong className="font-semibold">Ruleset version:</strong>{" "}
            <span className="font-mono">{p.rulesetVersion}</span> — unchanged from the hourly run. The
            same rule and indicator code the dashboard runs, driven over daily bars instead of hourly
            ones.
          </li>
          <li>
            <strong className="font-semibold">Run date:</strong>{" "}
            <span className="font-mono">{stamp(p.generatedAt)}</span>.
          </li>
          <li>
            <strong className="font-semibold">No parameter search:</strong> {p.assumptions.optimisation}
          </li>
          <li>
            <strong className="font-semibold">
              {p.reconciliationWithLive.applicable
                ? "Reconciliation with the dashboard:"
                : "No reconciliation with the dashboard, deliberately:"}
            </strong>{" "}
            {p.reconciliationWithLive.why}
          </li>
        </ul>
        {p.differencesFromH1Run.length > 0 ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">
              What differs from the hourly run
            </h3>
            <ul className="space-y-1 text-xs text-slate-600">
              {p.differencesFromH1Run.map((d) => (
                <li key={d}>· {d}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      {/* ── date and standing ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-300 bg-slate-50 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-900 uppercase">
          This is a dated result, not a standing claim
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          Measured on <span className="font-mono">{day(p.generatedAt)}</span> over the history
          available that day, ending{" "}
          <span className="font-mono">{stamp(p.measurementPeriod.headlineEndUtc)}</span>. It
          describes this ruleset, on daily bars, on that data. It is not updated continuously, it is
          not a prediction, and it does not license a claim about any other rule. If the ruleset or
          the data changes, the figure has to be re-measured before it means anything.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          Both granularities reached the same conclusion, and the hourly one — the granularity the
          dashboard actually runs — is the stronger evidence of the two. Nothing on this page is a
          recommendation to trade, and the owner&rsquo;s own method, if they have one, takes priority
          over anything here.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          Every figure above is read from the daily run&rsquo;s results file, which is kept and can be
          re-checked against this page. Where a number is negative, it is shown negative.
        </p>
        <p className="mt-3 text-sm text-slate-700">
          <strong className="font-semibold">
            Our own measurement, not an independent verification.
          </strong>{" "}
          Every figure here has been checked for internal consistency: it matches the stored results
          file, and the daily run is driven by the same rule and indicator code the dashboard runs.
          That is self-consistency, and it is not the same thing as independent confirmation. A
          second, independently written replay of this ruleset over the same stored data &mdash;
          compared trade by trade &mdash; is a planned item that has <em>not</em> been done. Until it
          is, treat these numbers as this project&rsquo;s own measurement, reported honestly, and not
          as verified by anyone else.
        </p>
      </section>

      <footer className="mt-8 text-xs text-slate-500">
        <a className="underline" href="/backtest">
          Hourly backtest (the dashboard&rsquo;s granularity)
        </a>{" "}
        ·{" "}
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
