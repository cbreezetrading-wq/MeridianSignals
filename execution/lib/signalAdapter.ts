import type { SignalsPayload } from "../../site/src/lib/market/types.ts";
import type { SignalInstruction } from "./instruction.ts";

/** Only new completed broker H1 entry events. Old dashboard positions are not entries. */
export function instructionsFromSignals(payload: SignalsPayload, expirySeconds: number, now = Date.now()): SignalInstruction[] {
  if (payload.data.primary.accountType !== "practice" || payload.ruleset.version !== "v1") return [];
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) return [];
  return payload.pairs.flatMap((p) => {
    if (p.status !== "ok" || p.sourceKind !== "primary" || p.pricing?.accountType !== "practice" ||
        p.granularity !== "hourly bar" || p.ruleFired.barUtc !== p.latestBarUtc) return [];
    const name = p.ruleFired.name;
    if (name !== "opened-long" && name !== "opened-short") return [];
    if (p.signal !== (name === "opened-long" ? "LONG" : "SHORT")) return [];
    const closedAt = Date.parse(p.latestBarUtc) + 3600000;
    if (!Number.isFinite(closedAt) || closedAt > now || now >= closedAt + expirySeconds * 1000) return [];
    if (p.stop === null || p.target === null || p.entry === null) return [];
    return [{
      signalId: `h1-v1:${p.instrument}:${p.latestBarUtc}:${name}`,
      strategyId: "meridian-h1-v1", strategyVersion: "h1-v1", instrument: p.instrument,
      direction: name === "opened-long" ? "long" : "short", generatedAt: new Date(closedAt).toISOString(),
      sourceBar: { time: p.latestBarUtc, close: p.ruleFired.barClose, granularity: "H1" },
      expiryAt: new Date(closedAt + expirySeconds * 1000).toISOString(), orderType: "MARKET",
      entryConditions: p.ruleFired.text, stopPrice: p.stop, takeProfitPrice: p.target,
      exitRules: "Broker stop loss or take profit. Cross/filter exits require separate owner approval; this connector does not execute them.",
      existingPositionRule: "Refuse when an existing position is present", oppositeSignalRule: "Do not reverse existing positions",
      repeatEntryRule: "One submission per stable signal ID", origin: "INVENTED_RULESET_TEST",
    } satisfies SignalInstruction];
  });
}
