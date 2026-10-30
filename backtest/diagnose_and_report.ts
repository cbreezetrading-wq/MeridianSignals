/**
 * (1) Diagnose the two live signals the long-history replay did not reproduce, by
 *     running the SAME live ruleset code over the exact window the live dashboard uses
 *     (the newest 500 complete bars) and comparing with the long-history replay.
 * (2) Print every figure the report needs out of results.json.
 */
import { ema, atr } from "../site/src/lib/market/indicators.ts";
import { runRulesetEvents } from "../site/src/lib/market/ruleset.ts";
import type { Bar } from "../site/src/lib/market/types.ts";

const DATA = "/home/team/shared/backtest/data";
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"];

async function load(instrument: string): Promise<{ t: number[]; bars: Bar[] }> {
  const text = await Bun.file(`${DATA}/${instrument}.jsonl`).text();
  const t: number[] = [];
  const bars: Bar[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as number[];
    t.push(r[0]!);
    bars.push({ t: r[0]!, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
  }
  return { t, bars };
}

function lastOpen(bars: Bar[]) {
  const { events, state, trend } = runRulesetEvents(bars);
  const opens = events.filter((e) => e.name.startsWith("opened"));
  const last = opens[opens.length - 1] ?? null;
  const lastEvent = events[events.length - 1] ?? null;
  return {
    n: bars.length,
    state,
    trend,
    lastOpenRule: last?.name ?? null,
    lastOpenBarUtc: last ? new Date(bars[last.index]!.t * 1000).toISOString() : null,
    lastOpenClose: last ? bars[last.index]!.c : null,
    lastEventRule: lastEvent?.name ?? null,
    lastEventBarUtc: lastEvent ? new Date(bars[lastEvent.index]!.t * 1000).toISOString() : null,
    ema50: ema(bars.map((b) => b.c), 50).at(-1) ?? null,
    ema200: ema(bars.map((b) => b.c), 200).at(-1) ?? null,
    atr14: atr(bars, 14).at(-1) ?? null,
  };
}

console.log("=== window sensitivity: full history vs the live dashboard's 500-bar window ===");
for (const p of PAIRS) {
  const { bars } = await load(p);
  const full = lastOpen(bars);
  const w500 = lastOpen(bars.slice(-500));
  console.log(`\n${p}`);
  console.log(`  FULL   : ${JSON.stringify(full)}`);
  console.log(`  LAST500: ${JSON.stringify(w500)}`);
  console.log(
    `  SAME last open? ${full.lastOpenBarUtc === w500.lastOpenBarUtc && full.lastOpenRule === w500.lastOpenRule}`,
  );
}

const results = JSON.parse(await Bun.file("/home/team/shared/backtest/results.json").text()) as Record<string, any>;
const rr = results.results;
const which = [
  ["headline", "headline_nextBarOpen_bidAsk"],
  ["zeroCost", "zeroCost_mid_nextBarOpen"],
  ["optimistic", "optimisticUpperBound_triggerClose"],
] as const;
console.log("\n=== per-pair full stats (all three variants) ===");
for (const [short, key] of which) {
  console.log(`\n--- ${short} ---`);
  const fp = rr[key].fullPeriod;
  for (const [pair, s] of Object.entries<any>(fp.perPair)) {
    console.log(
      `  ${pair}: n=${s.trades} W=${s.wins} L=${s.losses} win%=${s.winRatePct} avgWin=${s.avgWinPips} avgLoss=${s.avgLossPips} exp=${s.expectancyPipsPerTrade} pips=${s.totalPips} avgR=${s.avgRPerTrade} R=${s.totalR} maxDD=${s.maxDrawdownPips}p/${s.maxDrawdownR}R PF=${s.profitFactor} maxLossStreak=${s.longestLosingStreak} medHold=${s.medianHoldingHours}h meanHold=${s.meanHoldingHours}h meaningful=${s.statisticallyMeaningful} openAtEnd=${s.tradesStillOpenAtDataEnd} exits=${JSON.stringify(s.exitReasons)}`,
    );
  }
  const c = fp.combined;
  console.log(
    `  COMBINED: n=${c.trades} W=${c.wins} L=${c.losses} win%=${c.winRatePct} avgWin=${c.avgWinPips} avgLoss=${c.avgLossPips} exp=${c.expectancyPipsPerTrade} pips=${c.totalPips} avgR=${c.avgRPerTrade} R=${c.totalR} maxDD=${c.maxDrawdownPips}p/${c.maxDrawdownR}R PF=${c.profitFactor} maxLossStreak=${c.longestLosingStreak}`,
  );
  const h = rr[key].last12MonthsHeldOut;
  console.log("  HELD-OUT last 12 months:");
  for (const [pair, s] of Object.entries<any>(h.perPair)) {
    console.log(
      `    ${pair}: n=${s.trades} win%=${s.winRatePct} exp=${s.expectancyPipsPerTrade} pips=${s.totalPips} R=${s.totalR} PF=${s.profitFactor} meaningful=${s.statisticallyMeaningful}`,
    );
  }
  console.log(
    `    COMBINED: n=${h.combined.trades} win%=${h.combined.winRatePct} exp=${h.combined.expectancyPipsPerTrade} pips=${h.combined.totalPips} R=${h.combined.totalR} PF=${h.combined.profitFactor} maxDD=${h.combined.maxDrawdownPips}p/${h.combined.maxDrawdownR}R`,
  );
}

console.log("\n=== spreads actually paid ===");
console.log(JSON.stringify(results.spreadsPaid, null, 2));
console.log("\n=== holding times ===");
console.log(JSON.stringify(results.holdingTimes, null, 2));
console.log("\n=== year by year (headline, combined) ===");
for (const y of results.yearByYear.headline.combined) {
  console.log(
    `  ${y.year}: n=${y.trades} win%=${y.winRatePct} pips=${y.totalPips} R=${y.totalR}`,
  );
}
console.log("\n=== year by year (headline, per pair) ===");
console.log(JSON.stringify(results.yearByYear.headline.perPair));
console.log("\n=== measurement period ===");
console.log(JSON.stringify(results.measurementPeriod, null, 2));
console.log("\n=== exit reason mix (headline, combined) ===");
{
  const all: Record<string, number> = {};
  for (const p of Object.values<any>(rr.headline_nextBarOpen_bidAsk.fullPeriod.perPair)) {
    for (const [k, v] of Object.entries<number>(p.exitReasons)) all[k] = (all[k] ?? 0) + v;
  }
  console.log(JSON.stringify(all));
}
console.log("\n=== cost decomposition (combined) ===");
{
  const a = rr.headline_nextBarOpen_bidAsk.fullPeriod.combined;
  const z = rr.zeroCost_mid_nextBarOpen.fullPeriod.combined;
  const o = rr.optimisticUpperBound_triggerClose.fullPeriod.combined;
  console.log(
    `headline pips=${a.totalPips} R=${a.totalR} | zeroCost pips=${z.totalPips} R=${z.totalR} | optimistic pips=${o.totalPips} R=${o.totalR}`,
  );
  console.log(`spread drag (headline - zeroCost) = ${(a.totalPips - z.totalPips).toFixed(1)} pips`);
  console.log(`look-ahead/delay effect (zeroCost - optimistic) = ${(z.totalPips - o.totalPips).toFixed(1)} pips`);
}
