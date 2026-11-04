/** Offline calculation only: there is deliberately no order submission function. */
export type LiveRiskSettings = {
  source: "OWNER";
  riskPerTradePct: number;
  maxNotionalPct: number;
  maxSpreadPips: number;
};
export type LivePreviewInput = {
  strategyId: string;
  direction: "long" | "short";
  stop: number;
  target: number;
  nav: number;
  marginAvailable: number;
  accountCurrency: string;
  instrument: string;
  bid: number;
  ask: number;
  quoteTime: string;
  tradeable: boolean;
  meta: { tradeUnitsPrecision: number; displayPrecision: number; minimumTradeSize: string; maximumOrderUnits: string; marginRate: string };
  /** Broker home conversion for quote-currency losses, never an assumed mid rate. */
  quoteLossToAccount: number;
  settings: LiveRiskSettings;
};
export function previewLiveOrder(input: LivePreviewInput, now = Date.now()) {
  const i = input;
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (i.strategyId !== "owner-method") throw new Error("The failed invented strategy is not eligible for a live preview");
  if (!i.settings || i.settings.source !== "OWNER") throw new Error("Explicit live owner settings required; DEMO TEST values cannot be inherited");
  if (![i.nav, i.marginAvailable, i.bid, i.ask, i.stop, i.target, i.quoteLossToAccount, i.settings.riskPerTradePct, i.settings.maxNotionalPct, i.settings.maxSpreadPips].every(positive)) throw new Error("Invalid live sizing inputs");
  if (i.settings.riskPerTradePct > 100 || i.settings.maxNotionalPct > 100) throw new Error("Preview supports at most 100% notional exposure and risk percentages at most 100");
  if (!["long", "short"].includes(i.direction) || !/^[A-Z]{3}_[A-Z]{3}$/.test(i.instrument) || !/^[A-Z]{3}$/.test(i.accountCurrency)) throw new Error("Invalid direction or currency");
  const age = now - Date.parse(i.quoteTime);
  if (!i.tradeable || !Number.isFinite(age) || age < -5000 || age > 30000 || i.ask < i.bid) throw new Error("Price is stale, malformed or not tradeable");
  const pip = i.instrument.endsWith("_JPY") ? 0.01 : 0.0001;
  const spread = (i.ask - i.bid) / pip;
  if (spread > i.settings.maxSpreadPips) throw new Error("Spread exceeds the owner limit");
  const entry = i.direction === "long" ? i.ask : i.bid;
  if (i.direction === "long" ? i.stop >= entry || i.target <= entry : i.stop <= entry || i.target >= entry) throw new Error("Stop or target on wrong side of executable entry");
  const m = i.meta;
  const min = Number(m.minimumTradeSize), max = Number(m.maximumOrderUnits), marginRate = Number(m.marginRate);
  if (![min,max,marginRate].every(positive) || marginRate > 1 || !Number.isInteger(m.tradeUnitsPrecision) || m.tradeUnitsPrecision < 0 || m.tradeUnitsPrecision > 8 || !Number.isInteger(m.displayPrecision) || m.displayPrecision < 0 || m.displayPrecision > 8) throw new Error("Invalid broker instrument metadata");
  if (Number(i.stop.toFixed(m.displayPrecision)) !== i.stop || Number(i.target.toFixed(m.displayPrecision)) !== i.target) throw new Error("Stop and target exceed broker price precision");
  const riskPerUnit = Math.abs(entry-i.stop) * i.quoteLossToAccount;
  const notionalPerUnit = entry * i.quoteLossToAccount;
  const riskBudget = i.nav*i.settings.riskPerTradePct/100;
  const notionalCap = i.nav*i.settings.maxNotionalPct/100;
  // Cap by risk, notional, broker maximum and available margin; never round up.
  const raw = Math.min(riskBudget/riskPerUnit, notionalCap/notionalPerUnit, i.marginAvailable/(notionalPerUnit*marginRate),max);
  const scale = 10**m.tradeUnitsPrecision;
  const units = Math.floor(raw*scale)/scale;
  if (!positive(units) || units < min) throw new Error("Permitted size is below the broker minimum; skip this trade");
  return { environment: "LIVE", state: "PREVIEW_ONLY", submitted: false, submissionAvailable: false,
    instrument: i.instrument, direction: i.direction, units, signedUnits: i.direction === "long" ? units : -units,
    entryReference: entry, stop: i.stop, target: i.target, accountCurrency: i.accountCurrency,
    riskBudget, estimatedStopRisk: units*riskPerUnit, notional: units*notionalPerUnit,
    quoteTime: i.quoteTime,
    limitations: ["This is a calculation, not a broker order", "Existing portfolio exposure is not incorporated; this preview cannot authorize submission", "Stop fills, financing, commission and currency-conversion changes can increase losses"] };
}
