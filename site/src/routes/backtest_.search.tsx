import { createFileRoute } from "@tanstack/react-router";

import { ProvenanceLine, SkippedNotes } from "~/components/DataProvenance";
import type { Provenance, SkippedCandidate } from "~/lib/market/bundledData";
import {
  loadStrategySearchResults,
  type SearchCandidate,
  type SearchDerived,
  type SearchLoad,
  type SearchPayload,
} from "~/lib/market/strategySearchResults";

/**
 * /backtest/search — the pre-registered strategy search, and its negative result.
 *
 * This page exists because the owner asked whether the strategy could be improved to
 * cut losses. Nine candidates were written down in a protocol *before* any number was
 * computed, then run over ~24 years of the owner's own hourly history with the real
 * stored bid/ask on every fill. Every figure on the page is read from the search
 * harness's own results.json (or, for the cost arithmetic, computed from two stored
 * fields of it); the protocol supplies only the pre-registered rules and the fixed
 * period boundaries. Nothing is typed in, and a missing file renders no figure at all.
 */
export const Route = createFileRoute("/backtest_/search")({
  head: () => ({
    meta: [
      { title: "Meridian Signals — pre-registered strategy search (nothing survived)" },
      {
        name: "description",
        content:
          "Nine strategy candidates, fixed in a protocol before any number was computed, run over 24 years of the owner's own hourly broker data with real historical bid/ask spreads: all nine lose out of sample and all nine lose again in the held-out period. The search, the selection rule and the cost arithmetic stated in full.",
      },
      // The site is deliberately unlisted; say so on the page as well as in robots.txt.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  loader: async (): Promise<SearchLoad> => {
    if (typeof window === "undefined") return await loadStrategySearchResults();
    const res = await fetch("/api/strategy-search", { headers: { accept: "application/json" } });
    const body = (await res.json()) as {
      ok: boolean;
      payload?: SearchPayload;
      derived?: SearchDerived;
      provenance?: Provenance;
      error?: string;
      skipped?: SkippedCandidate[];
    };
    if (!body.ok || !body.payload || !body.derived || !body.provenance) {
      return {
        ok: false,
        skipped: body.skipped ?? [],
        error: body.error ?? `The strategy search endpoint answered HTTP ${String(res.status)}.`,
      };
    }
    return { ok: true, payload: body.payload, derived: body.derived, provenance: body.provenance };
  },
  component: StrategySearchPage,
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

function signed(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${num(v, dp)}`;
}

function pct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${num(v, dp)}%`;
}

/** "2026-11-10 20:05 UTC" from an ISO timestamp, without touching the locale. */
function stamp(iso: string): string {
  if (!iso) return "unknown";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function day(iso: string): string {
  if (!iso) return "unknown";
  return iso.slice(0, 10);
}

function pairLabel(pair: string): string {
  return pair.replace("_", "/");
}

/** The four anchored walk-forward folds, in order. */
function foldsText(c: SearchCandidate): string {
  return c.foldR.map((r) => signed(r, 1)).join(" / ");
}

/**
 * What each candidate is, in one line. Quoted from the pre-registered protocol; the
 * rules and their fixed parameters were fixed there before any result was seen. The
 * measured figures are never taken from this table — they are read from results.json.
 */
const FAMILY: Record<string, string> = {
  A1: "Donchian breakout",
  A2: "Donchian breakout",
  A3: "Donchian breakout",
  B1: "Mean reversion",
  B2: "Bollinger reversion",
  C1: "Trend + pullback",
  C2: "MACD trend",
  D1: "Range breakout, session-filtered",
  E0: "Control (buy-and-hold proxy)",
};

/* ── page ─────────────────────────────────────────────────────────────────── */

function StrategySearchPage() {
  const load = Route.useLoaderData();
  if (!load.ok) return <Unavailable load={load} />;

  const { payload: p, derived: d, provenance } = load;
  const candidates = p.candidates;
  const best = d.bestOos;
  const bestGross = d.bestGross;
  const minP = d.minP;
  const pairCell = d.nominallySignificantPair;
  const oracle = p.selfTests.oracle;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-10 text-slate-900">
      <header className="mb-8">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Meridian Signals
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          The strategy search: nine candidates fixed in advance, and none of them survived
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          {d.candidateCount} candidates · run <span className="font-mono">{stamp(p.generatedAt)}</span>{" "}
          · {group(String(d.totalBars))} hourly bars over {d.pairs} pairs ·{" "}
          <span className="font-mono">
            {day(Object.values(p.dataRange)[0]?.first ?? "")}
          </span>{" "}
          → <span className="font-mono">{day(Object.values(p.dataRange)[0]?.last ?? "")}</span>, the
          owner&rsquo;s own broker history, with the stored bid/ask of every bar used for every fill.
        </p>
        <ProvenanceLine provenance={provenance} what="the strategy search result" />
        <p className="mt-2 text-sm">
          <a className="font-medium text-slate-900 underline" href="/backtest">
            ← Hourly backtest
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/backtest/daily">
            Daily backtest
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
          All nine pre-registered candidates lose to the spread — out of sample and in the held-out
          period.
        </h2>
        <p className="mt-3 text-sm text-rose-900">
          Pooled walk-forward, {d.oosNegative} of {d.candidateCount} negative,{" "}
          <strong className="font-semibold">{num(d.oosTotalR, 1)}R</strong> in total. Held-out
          period, {d.heldNegative} of {d.candidateCount} negative,{" "}
          <strong className="font-semibold">{num(d.heldTotalR, 1)}R</strong> in total. The best of
          the nine is still a loser: <span className="font-mono">{best?.id}</span> at{" "}
          {num(best?.avgR, 3)} R per trade, against the {num(0.05, 2)} R per trade the protocol
          required. Nothing met the selection rule, so nothing was adopted.
        </p>
        <p className="mt-3 text-sm text-rose-900">
          This is not a result that a different parameter would rescue. The nine candidates pay{" "}
          {num(d.spreadPaidRangeOos?.min, 2)}–{num(d.spreadPaidRangeOos?.max, 2)} pips of spread per
          trade. The largest gross edge in the whole family, before any cost, is{" "}
          <span className="font-mono">{bestGross?.id}</span> at{" "}
          {signed(bestGross?.grossExpR, 3)} R per trade — only{" "}
          {pct(bestGross?.shareOfCostPct, 0)} of what that same candidate pays in spread. It would
          need to be <strong className="font-semibold">{num(bestGross?.breakEvenMultiple, 2)}×</strong>{" "}
          better just to reach zero, before swap, commission or slippage.
        </p>
        <p className="mt-3 text-sm font-semibold text-rose-900">
          The honest end of the &ldquo;improve the strategy&rdquo; line: this is a cost problem, not
          a tuning problem. Nothing here is tradeable and nothing was tuned until it looked better.
        </p>
      </section>

      {/* ── what was tested ─────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">What was tested, and how the test was fixed in advance</h2>
        <p className="mt-3 text-sm text-slate-700">
          The nine candidates, their fixed parameters and the selection rule were written into a
          protocol <em>before any number was computed</em>. Nothing was added afterwards, no
          parameter was tuned on this data, and no candidate derived from the dead ruleset appears
          here — its measured result is treated as settled. The candidate set is one hypothesis per
          family, applied unchanged to all four majors.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          Every candidate is executed identically: a signal is read only on a <em>closed</em> bar;
          entry is at the <em>next</em> bar&rsquo;s open on the side actually traded (ask for longs,
          bid for shorts); exit is on the far side; a stop is assumed hit before a target when both
          fall inside one bar; a gap through a stop fills at the open, which is worse than the stop.
          One position per instrument at a time.
        </p>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-300 text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">id</th>
                <th className="py-2 pr-3 font-medium">family</th>
                <th className="py-2 pr-3 font-medium">rule (fixed in the protocol)</th>
                <th className="py-2 text-right font-medium">trades, full history</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-mono font-semibold">{c.id}</td>
                  <td className="py-2 pr-3 text-slate-600">{FAMILY[c.id] ?? "—"}</td>
                  <td className="py-2 pr-3 text-slate-800">{c.name}</td>
                  <td className="py-2 text-right font-mono">{group(String(c.nTradesTotal))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
          <p className="font-semibold text-slate-800">The selection rule, fixed before the results</p>
          <p className="mt-1">
            A candidate was to be adopted only if <em>all four</em> held on pooled walk-forward
            out-of-sample data: (1) net R &gt; 0 in each of the four folds; (2) a one-sided p on
            per-trade R below the Benjamini&ndash;Hochberg threshold at q = {num(p.fdr.q, 2)} over{" "}
            {p.fdr.m} tests, with Bonferroni {num(p.fdr.bonferroni, 4)} reported alongside; (3) net
            expectancy ≥ +{num(0.05, 2)} R per trade; (4) net R &gt; 0 in the sealed held-out
            period. Any candidate failing 1–3 was rejected on the out-of-sample data alone, and the
            held-out period could not rescue it.
          </p>
          <p className="mt-2">
            The periods were fixed at the same time: development{" "}
            <span className="font-mono">2002-05-06 → 2015-12-31</span> (sanity checks only, never
            used to pick a winner); walk-forward out-of-sample{" "}
            <span className="font-mono">2016-01-01 → 2024-06-30</span> in four anchored folds; and a
            sealed held-out period <span className="font-mono">2024-07-01 → 2026-10-12</span>.
          </p>
        </div>
      </section>

      {/* ── out of sample ───────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">
          Walk-forward out-of-sample — 2016-01-01 → 2024-06-30
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          The period the selection was made on. Every candidate, including the losers, with its
          per-fold net R so a fold bet cannot hide as an edge.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-300 text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">id</th>
                <th className="py-2 pr-3 text-right font-medium">trades</th>
                <th className="py-2 pr-3 text-right font-medium">win %</th>
                <th className="py-2 pr-3 text-right font-medium">net R</th>
                <th className="py-2 pr-3 text-right font-medium">R/trade</th>
                <th className="py-2 pr-3 text-right font-medium">net pips</th>
                <th className="py-2 pr-3 text-right font-medium">spread paid/trade</th>
                <th className="py-2 pr-3 text-right font-medium">folds positive</th>
                <th className="py-2 pr-3 font-medium">net R by fold</th>
                <th className="py-2 text-right font-medium">p (1-sided)</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono font-semibold">{c.id}</td>
                  <td className="py-2 pr-3 text-right font-mono">{group(String(c.oos.n))}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.oos.win, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.oos.R, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono font-semibold">{num(c.oos.avgR, 3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.oos.pips, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.oos.avgSpread, 2)}</td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {d.foldsPositive[c.id]} of {c.foldR.length}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-600">{foldsText(c)}</td>
                  <td className="py-2 text-right font-mono">{num(c.oosP, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Positive in all four folds:{" "}
          {d.positiveInAllFolds.length === 0 ? (
            <strong className="font-semibold">none of the nine</strong>
          ) : (
            <span className="font-mono">{d.positiveInAllFolds.join(", ")}</span>
          )}
          . The smallest one-sided p of the nine is{" "}
          <span className="font-mono">{minP?.id}</span> at {num(minP?.p, 4)}. Benjamini&ndash;Hochberg
          at q = {num(p.fdr.q, 2)} over {p.fdr.m} tests rejects{" "}
          <strong className="font-semibold">
            {p.fdr.k} of {p.fdr.m}
          </strong>{" "}
          — nothing came near the threshold — and the harsher Bonferroni bound would have required p
          &lt; {num(p.fdr.bonferroni, 4)}. Both reject{" "}
          <strong className="font-semibold">
            {p.fdr.k} of {p.fdr.m}
          </strong>
          . These candidates are not &ldquo;unproven&rdquo;: on this data they are rejected as
          profitable.
        </p>
      </section>

      {/* ── held out ────────────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">
          Held-out period — 2024-07-01 → 2026-10-12, never used for selection
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          Reported for every candidate, not only the ones that looked best, so the seal cannot be
          used to hide anything.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-300 text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">id</th>
                <th className="py-2 pr-3 text-right font-medium">trades</th>
                <th className="py-2 pr-3 text-right font-medium">win %</th>
                <th className="py-2 pr-3 text-right font-medium">net R</th>
                <th className="py-2 pr-3 text-right font-medium">R/trade</th>
                <th className="py-2 pr-3 text-right font-medium">net pips</th>
                <th className="py-2 text-right font-medium">spread paid/trade</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono font-semibold">{c.id}</td>
                  <td className="py-2 pr-3 text-right font-mono">{group(String(c.held.n))}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.held.win, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.held.R, 1)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.held.avgR, 3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{num(c.held.pips, 1)}</td>
                  <td className="py-2 text-right font-mono">{num(c.held.avgSpread, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-slate-700">
          <strong className="font-semibold">
            {d.heldNegative} of {d.candidateCount} negative
          </strong>
          , {num(d.heldTotalR, 1)}R in total. Nothing that looked best on the selection period did
          better when the data was fresh, and the spreads in the held-out period (
          {num(d.spreadPaidRangeHeld?.min, 2)}–{num(d.spreadPaidRangeHeld?.max, 2)} pips per trade)
          are the same as in the out-of-sample period — so this is not old wide spreads being
          applied to today.
        </p>
      </section>

      {/* ── cost arithmetic ─────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">
          Break-even cost arithmetic: the spread against the gross edge
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          The same rules, the same fills, priced twice: once at the mid with the spread removed and
          once at the real bid/ask. The difference between the two is what the spread costs per
          trade. Both columns are stored in the results file; the share and the multiple are
          computed from them here.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-300 text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">id</th>
                <th className="py-2 pr-3 text-right font-medium">gross R/trade (no spread)</th>
                <th className="py-2 pr-3 text-right font-medium">spread cost R/trade</th>
                <th className="py-2 pr-3 text-right font-medium">net R/trade</th>
                <th className="py-2 pr-3 text-right font-medium">gross edge as a share of its cost</th>
                <th className="py-2 text-right font-medium">needed to break even</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const row = d.cost[c.id];
                return (
                  <tr key={c.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-mono font-semibold">{c.id}</td>
                    <td className="py-2 pr-3 text-right font-mono">{signed(row?.grossExpR, 3)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{num(row?.costExpR, 3)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{num(row?.netExpR, 3)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {row?.shareOfCostPct === null
                        ? "gross edge is itself negative"
                        : pct(row?.shareOfCostPct, 0)}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {row?.breakEvenMultiple === null
                        ? "—"
                        : `${num(row?.breakEvenMultiple, 2)}× more edge`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-slate-700">
          This is the same arithmetic that killed the original ruleset, reproduced independently: a
          near-fixed cost per trade against a gross tendency of about half that cost. Where the
          gross edge is negative the spread is not even the binding problem — the rule has nothing
          to pay it with.
        </p>
        <p className="mt-2 text-xs text-slate-600">
          Computed from the stored per-candidate figures:{" "}
          <span className="font-mono">selfTests.midOnly[id].exp</span> (gross R per trade at the
          mid) and <span className="font-mono">candidates[id].oos.avgR</span> (net R per trade at the
          real bid/ask); the cost is the difference. The mid-priced re-run&rsquo;s trade counts differ
          slightly from the cost run&rsquo;s because a mid-priced series produces slightly different
          fills at the same rules — both counts are in the JSON endpoint.
        </p>
      </section>

      {/* ── did the harness work ────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">
          Could the harness have found a win? Two self-tests
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          A search that reports only losses has to show it could have detected an edge. Neither of
          these is a candidate, and neither entered the selection.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
            <p className="font-semibold text-slate-800">1. A look-ahead oracle</p>
            <p className="mt-1">
              A signal that knows the next bar&rsquo;s direction, run through the identical simulator
              with real bid/ask, returns{" "}
              <strong className="font-semibold">{num(oracle.R, 1)}R</strong> over{" "}
              {group(String(oracle.n))} trades — {num(oracle.avgR, 3)} R per trade,{" "}
              {num(oracle.win, 1)}% win rate, profit factor {num(oracle.pf, 2)} — and it pays{" "}
              {num(oracle.avgSpread, 2)} pips of spread per trade while doing it. The machinery
              detects an edge when one exists; the losses above are the rules, not the plumbing.
            </p>
            <p className="mt-2 text-slate-500">{oracle.note}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
            <p className="font-semibold text-slate-800">2. The spread, priced directly</p>
            <p className="mt-1">
              The mid-priced re-run prices the cost of each candidate at{" "}
              {num(
                Math.min(
                  ...Object.values(p.selfTests.midOnly).map((m) => m.spreadCostPipsPerTrade),
                ),
                2,
              )}
              –
              {num(
                Math.max(
                  ...Object.values(p.selfTests.midOnly).map((m) => m.spreadCostPipsPerTrade),
                ),
                2,
              )}{" "}
              pips per trade, which matches the independently computed per-pair spread averages
              below. The cost is not double-counted and not understated.
            </p>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-300 text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">pair</th>
                <th className="py-2 text-right font-medium">mean spread, whole history (pips)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(d.spreadByPairPips).map(([pair, v]) => (
                <tr key={pair} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono">{pairLabel(pair)}</td>
                  <td className="py-2 text-right font-mono">{num(v, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── multiple testing ────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">How many tests this actually was</h2>
        <p className="mt-2 text-sm text-slate-700">
          Nine candidates applied to four majors is not 36 independent hypotheses: each candidate is
          one hypothesis. The family is therefore counted as{" "}
          <strong className="font-semibold">{p.fdr.m} tests</strong> and, separately, as{" "}
          <strong className="font-semibold">{p.pairFdr.m} pair-level tests</strong>. Both had to be
          survivable for adoption.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          Pair level: Benjamini&ndash;Hochberg at q = {num(p.pairFdr.q, 2)} rejects{" "}
          <strong className="font-semibold">
            {p.pairFdr.k} of {p.pairFdr.m}
          </strong>
          ; the Bonferroni threshold is {num(p.pairFdr.bonferroni, 4)}.{" "}
          {pairCell ? (
            <>
              The one nominally significant cell is{" "}
              <span className="font-mono">
                {pairCell.id} / {pairLabel(pairCell.pair)}
              </span>{" "}
              at {signed(pairCell.R, 1)}R over {group(String(pairCell.trades))} trades, p ={" "}
              {num(pairCell.p, 4)} — which would need to be {num(p.pairFdr.bonferroni, 4)} to clear
              the correction. And it does not hold: in the held-out period that same cell returns{" "}
              <strong className="font-semibold">
                {signed(pairCell.heldR, 1)}R ({num(pairCell.heldAvgR, 3)} R/trade, p ={" "}
                {num(pairCell.heldP, 3)})
              </strong>{" "}
              over {group(String(pairCell.heldTrades))} trades. It was a bet on a trend in one pair
              during the selection window, not an edge.
            </>
          ) : (
            <>No pair-level cell reached p &lt; 0.05 at all.</>
          )}
        </p>
      </section>

      {/* ── what is not in the numbers ──────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-amber-300 bg-amber-50 p-6">
        <h2 className="text-xl font-semibold tracking-tight text-amber-900">
          What is excluded, what was assumed, and what was not tested
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-amber-900">
          <li>
            <strong className="font-semibold">Excluded from every figure:</strong> swap/financing,
            commission, taxes, position sizing and slippage beyond the spread. Every one of these
            makes the results worse, not better.
          </li>
          <li>
            <strong className="font-semibold">Assumed, and stated in the protocol:</strong> one
            position per instrument at a time; a new signal while a position is open is dropped
            rather than queued; a stop is hit before a target when both are touched inside one bar;
            a gap through a stop fills at the open. These are conservative choices.
          </li>
          <li>
            <strong className="font-semibold">Not tested:</strong> any timeframe beyond the daily
            measurement already in the record (which lost), any candidate outside the pre-registered
            nine, and any combination of the nine. Combining nine losing rules does not produce a
            winner, and testing combinations after seeing the individual results would be exactly
            the multiple-testing error this exercise exists to avoid.
          </li>
          <li>
            <strong className="font-semibold">A defect in the harness, found and fixed:</strong> the
            first run of C2 (MACD) produced zero trades because the exponential moving average could
            not seed from a series beginning in NaNs. It was fixed and re-run; the pre-fix C2 row is
            not reported as a result and the corrected row is the one above. No other candidate was
            affected.
          </li>
        </ul>
      </section>

      {/* ── what it means ───────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border-2 border-slate-300 bg-white p-6">
        <h2 className="text-xl font-semibold tracking-tight">What this means</h2>
        <p className="mt-3 text-sm text-slate-700">
          There is no strategy in this family to improve. At this frequency the spread costs{" "}
          {num(d.spreadPaidRangeOos?.min, 2)}–{num(d.spreadPaidRangeOos?.max, 2)} pips per trade and
          the best gross tendency any of these rules found was {signed(bestGross?.grossExpR, 3)} R —
          about half the cost of taking the trade. The least-bad candidate still loses{" "}
          {num(Math.abs(best?.avgR ?? Number.NaN), 3)} R per trade, and losing less is not the same
          as winning.
        </p>
        <p className="mt-2 text-sm text-slate-700">
          The only lever the data supports is trading less often, in larger moves, so that a
          near-fixed per-trade cost is a smaller share of the result. That lever was measured once
          already on daily bars —{" "}
          <a className="underline" href="/backtest/daily">
            the daily result
          </a>{" "}
          — and it lost too. This account&rsquo;s cost structure, not the ruleset, is what has to
          change before any ruleset can work, and that is not something this tool can change.
        </p>
        <p className="mt-3 text-sm font-semibold text-slate-800">
          The tool stays a Practice instrument. No strategy has been adopted, and the execution path
          running on this site is exercising the plumbing, not an edge.
        </p>
        <p className="mt-4 text-sm">
          <a className="font-medium text-slate-900 underline" href="/backtest">
            Hourly backtest — the ruleset the dashboard runs
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/backtest/daily">
            Daily backtest
          </a>
          <span className="mx-2 text-slate-400">·</span>
          <a className="font-medium text-slate-900 underline" href="/">
            Dashboard
          </a>
        </p>
      </section>
    </main>
  );
}

/** Nothing was readable. Say exactly what was tried; show no figure at all. */
function Unavailable({ load }: { load: Extract<SearchLoad, { ok: false }> }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-5 py-10 text-slate-900">
      <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
        Meridian Signals
      </p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        Pre-registered strategy search — unavailable
      </h1>
      <div className="mt-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-6">
        <p className="text-sm text-amber-900">{load.error}</p>
        <SkippedNotes skipped={load.skipped} />
        <p className="mt-3 text-xs text-amber-900">
          Every number on this page would have to come from that file, so the page shows none of
          them. It does not show a remembered figure, an earlier run, or an estimate.
        </p>
      </div>
      <p className="mt-4 text-sm">
        <a className="font-medium text-slate-900 underline" href="/backtest">
          ← Hourly backtest
        </a>
        <span className="mx-2 text-slate-400">·</span>
        <a className="font-medium text-slate-900 underline" href="/">
          Dashboard
        </a>
      </p>
    </main>
  );
}
