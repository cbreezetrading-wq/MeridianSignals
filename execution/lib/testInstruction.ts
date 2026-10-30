/**
 * Building the instruction the engine submits.
 *
 * HONESTY NOTE — read this before reading anything the engine does with it:
 *
 * At the time this connection was built, all four pairs were FLAT under the invented
 * H1 ruleset: no entry rule was firing, so there was no live signal to execute. Rather
 * than manufacture a fake "signal" and call it one, this module builds a CONNECTION
 * VERIFICATION instruction that is labelled as exactly that everywhere it appears
 * (record, dashboard, evidence):
 *
 *   - origin:  INVENTED_RULESET_TEST   (the invented ruleset may originate Practice
 *                                      orders for connection testing, and nothing else)
 *   - basis:   "CONNECTION_VERIFICATION" — explicitly not a rule firing
 *   - geometry: the ruleset's OWN stop and target construction, 1.5 x ATR(14) and
 *               3.0 x ATR(14) from the entry, computed from the newest complete H1 bar
 *               on the owner's own OANDA feed. So the order that results is sized and
 *               protected exactly as a real one would be; only its reason for existing
 *               is artificial, and that is stated.
 *
 * The direction is taken from the ruleset's trend filter (EMA50 vs EMA200) at the last
 * complete bar, so it is at least a deterministic reading of the same data rather than
 * an arbitrary coin flip.
 */

import { fetchOandaCandles } from "../../site/src/lib/market/oanda.ts";
import { atr, ema, lastDefined } from "../../site/src/lib/market/indicators.ts";
import type { SignalInstruction, Direction } from "./instruction.ts";

export type BuiltInstruction = {
  instruction: SignalInstruction;
  basis: Record<string, unknown>;
};

export async function buildConnectionVerificationInstruction(args: {
  instrument: string;
  signalId: string;
  expirySeconds: number;
  displayPrecision: number;
  /** Optional direction override; default is the trend filter's reading. */
  direction?: Direction;
}): Promise<BuiltInstruction> {
  const candles = await fetchOandaCandles(args.instrument);
  if (!candles.ok) throw new Error(`could not read bars for ${args.instrument}: ${candles.error} — ${candles.detail}`);

  const bars = candles.bars;
  const last = bars[bars.length - 1]!;
  const closes = bars.map((b) => b.c);
  const ema50 = lastDefined(ema(closes, 50));
  const ema200 = lastDefined(ema(closes, 200));
  const atr14 = lastDefined(atr(bars, 14));
  if (ema50 === null || ema200 === null || atr14 === null) {
    throw new Error(`indicators are not defined on the newest bar for ${args.instrument}`);
  }

  const trendUp = ema50 > ema200;
  const direction: Direction = args.direction ?? (trendUp ? "long" : "short");
  const entry = last.c;
  const stopDistance = 1.5 * atr14;
  const targetDistance = 3.0 * atr14;
  const stopPrice = Number((direction === "long" ? entry - stopDistance : entry + stopDistance).toFixed(args.displayPrecision));
  const takeProfitPrice = Number((direction === "long" ? entry + targetDistance : entry - targetDistance).toFixed(args.displayPrecision));

  const generatedAt = new Date();
  const instruction: SignalInstruction = {
    signalId: args.signalId,
    strategyId: "meridian-h1-v1",
    strategyVersion: "h1-v1",
    instrument: args.instrument,
    direction,
    generatedAt: generatedAt.toISOString(),
    sourceBar: {
      time: new Date(last.t * 1000).toISOString(),
      close: Number(entry.toFixed(args.displayPrecision)),
      granularity: "H1",
    },
    expiryAt: new Date(generatedAt.getTime() + args.expirySeconds * 1000).toISOString(),
    orderType: "MARKET",
    entryConditions:
      "market entry at the prevailing bid/ask; refuse if the spread exceeds maxSpreadPips or the price has moved more than maxEntryDeviationPips from the source bar close",
    stopPrice,
    takeProfitPrice,
    exitRules: "stop 1.5xATR(14) and target 3.0xATR(14) attached at entry; exit to flat on an opposite EMA(20)/EMA(50) cross or a trend-filter reversal",
    existingPositionRule: "do not add to an open position in the same instrument; one Meridian-managed position per instrument at most",
    oppositeSignalRule: "an opposite signal never reverses in place; the existing position is closed by its own exit rules first",
    repeatEntryRule: "one entry per signal id; the idempotency key makes a resubmission of the same signal a no-op",
    origin: "INVENTED_RULESET_TEST",
  };

  return {
    instruction,
    basis: {
      basis: "CONNECTION_VERIFICATION",
      statement:
        "No entry rule was firing on the invented H1 ruleset at build time (all four pairs FLAT). This instruction exists to exercise the order path end to end. It is NOT a rule firing and NOT a trading recommendation. Its stop and target use the ruleset's own 1.5xATR / 3.0xATR construction.",
      instrument: args.instrument,
      sourceBar: { time: new Date(last.t * 1000).toISOString(), close: last.c },
      atr14,
      ema50,
      ema200,
      trendFilter: trendUp ? "up" : "down",
      stopDistance: stopDistance,
      targetDistance: targetDistance,
      source: candles.source,
      newestCompleteBarUtc: candles.upstream.newestCompleteBarUtc,
    },
  };
}
