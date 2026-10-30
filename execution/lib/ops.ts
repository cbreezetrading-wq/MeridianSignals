/**
 * Operations around the order path: reconciliation, the three stop controls, and a
 * read-only status snapshot for the dashboard.
 *
 * The reconciliation policy, stated once and applied without exception:
 *
 *  - A Meridian order is identified by the broker's own clientExtensions:
 *    tag === "MERIDIAN-PRACTICE-TEST" and id starting "msig-". Nothing else is ours.
 *  - Anything open at the broker that is NOT Meridian-managed is MANUAL_EXTERNAL.
 *    Meridian does not adopt it, protect it, modify it or close it. It is reported.
 *  - Meridian's belief comes from replaying the append-only record. Where belief and
 *    broker disagree, the BROKER wins and the disagreement is recorded — Meridian
 *    never rewrites the broker's version of events into its own.
 *  - After a timeout or a lost connection, broker state is read BEFORE any retry.
 */

import type { Client, BrokerResponse, BrokerFailure } from "./client.ts";
import { appendRecord, replay } from "./record.ts";
import { readAccount, readPause, writePause, isManaged, managedTradeIdsFromRecord, MERIDIAN_TAG } from "./engine.ts";
import { riskBreachesFromRecord } from "./risk.ts";
import type { AccountSnapshot } from "./engine.ts";
import { resolveSettings, type ExecutionConfig, type ResolvedSettings } from "./config.ts";
import { PRACTICE_HOST } from "./interlock.ts";

type ExecutionConfigLike = ExecutionConfig;
function resolveSettingsLike(c: ExecutionConfig): Array<{ key: string; value: unknown; source: string }> {
  const r = resolveSettings(c);
  return Object.values(r.values).map((v) => ({ key: v.key, value: v.value, source: v.source }));
}

function isTransportFailure(r: BrokerResponse | BrokerFailure): r is BrokerFailure {
  return (r as BrokerFailure).transportFailure === true;
}

export type BrokerState = {
  ok: boolean;
  readAt: string;
  account: AccountSnapshot | null;
  positions: any[];
  trades: any[];
  orders: any[];
  errors: string[];
};

export async function readBrokerState(client: Client): Promise<BrokerState> {
  const errors: string[] = [];
  const accountRes = await readAccount(client);
  const account = accountRes.ok ? accountRes.account : null;
  if (!accountRes.ok) errors.push(`account: ${JSON.stringify(accountRes.detail)}`);

  const posRes = await client.openPositions();
  const positions = !isTransportFailure(posRes) && posRes.ok ? (posRes.body.positions ?? []) : [];
  if (isTransportFailure(posRes) || !posRes.ok) errors.push("positions: read failed");

  const trRes = await client.openTrades();
  const trades = !isTransportFailure(trRes) && trRes.ok ? (trRes.body.trades ?? []) : [];
  if (isTransportFailure(trRes) || !trRes.ok) errors.push("trades: read failed");

  const orRes = await client.orders("PENDING");
  const orders = !isTransportFailure(orRes) && orRes.ok ? (orRes.body.orders ?? []) : [];
  if (isTransportFailure(orRes) || !orRes.ok) errors.push("orders: read failed");

  return { ok: errors.length === 0, readAt: new Date().toISOString(), account, positions, trades, orders, errors };
}

/* ------------------------------------------------------------ reconciliation */

export type ReconciliationReport = {
  readAt: string;
  brokerOk: boolean;
  errors: string[];
  belief: Array<{ orderKey: string; signalId: string | null; state: string | null; tradeId: string | null; instrument: string | null; lastRecordedAt: string }>;
  matched: Array<{ orderKey: string; tradeId: string; instrument: string; units: string; stopPrice: string | null; takeProfitPrice: string | null; stopAttached: boolean }>;
  manualExternal: Array<{ tradeId: string; instrument: string; units: string; clientExtensions: unknown }>;
  unrecordedManaged: Array<{ tradeId: string; instrument: string; units: string }>;
  missingAtBroker: Array<{ orderKey: string; lastKnownTradeId: string | null; lastState: string | null }>;
  pendingManagedOrders: Array<{ orderId: string; instrument: string; units: string; type: string }>;
  policy: string;
};

export async function reconcile(client: Client): Promise<ReconciliationReport> {
  const state = await readBrokerState(client);
  const { all } = await replay();

  // Belief per order key.
  //
  // The lifecycle state is the FURTHEST state the record shows, not the state field of
  // the most recent line: a later DUPLICATE_SUPPRESSED or VALIDATION_REFUSED record
  // says something about a resubmission attempt, not about the trade. Taking the last
  // line's state would make a filled, protected trade look suppressed.
  const LIFECYCLE = ["REQUESTED", "ACKNOWLEDGED", "FILLED", "PARTIALLY_FILLED", "PROTECTED", "CLOSED"];
  const rank = (s: string | null): number => (s && LIFECYCLE.includes(s) ? LIFECYCLE.indexOf(s) : -1);
  type Belief = { orderKey: string; signalId: string | null; state: string | null; tradeId: string | null; instrument: string | null; lastRecordedAt: string; lastEvent: string };
  const beliefMap = new Map<string, Belief>();
  for (const r of all) {
    if (!r.orderKey) continue;
    const p = (r.payload ?? {}) as any;
    const prev = beliefMap.get(r.orderKey);
    const tradeId = p.tradeId ?? p.trade?.id ?? p.tradeOpened?.tradeID ?? prev?.tradeId ?? null;
    const instrument = p.instrument ?? p.trade?.instrument ?? prev?.instrument ?? null;
    const furthest = rank(r.state) >= rank(prev?.state ?? null) ? r.state : (prev?.state ?? null);
    beliefMap.set(r.orderKey, {
      orderKey: r.orderKey,
      signalId: r.signalId,
      state: furthest,
      tradeId: tradeId ? String(tradeId) : null,
      instrument: instrument ? String(instrument) : null,
      lastRecordedAt: r.recordedAt,
      lastEvent: r.kind,
    });
  }
  const belief = [...beliefMap.values()];

  const matched: ReconciliationReport["matched"] = [];
  const unrecordedManaged: ReconciliationReport["unrecordedManaged"] = [];
  const manualExternal: ReconciliationReport["manualExternal"] = [];

  const beliefByTradeId = new Map(belief.filter((b) => b.tradeId).map((b) => [b.tradeId!, b]));
  const knownTradeIds = await managedTradeIdsFromRecord();

  for (const t of state.trades) {
    const managed = isManaged(t, knownTradeIds);
    if (!managed) {
      manualExternal.push({ tradeId: String(t.id), instrument: t.instrument, units: t.currentUnits, clientExtensions: t.clientExtensions ?? null });
      continue;
    }
    const key = (t.clientExtensions?.id as string) ?? (t.stopLossOrder?.clientExtensions?.id as string)?.replace(/-sl$/, "") ?? beliefByTradeId.get(String(t.id))?.orderKey ?? null;
    const b = (key ? beliefMap.get(key) : undefined) ?? beliefByTradeId.get(String(t.id));
    if (!b) {
      unrecordedManaged.push({ tradeId: t.id, instrument: t.instrument, units: t.currentUnits });
      continue;
    }
    matched.push({
      orderKey: key ?? b.orderKey,
      tradeId: String(t.id),
      instrument: t.instrument,
      units: t.currentUnits,
      stopPrice: t.stopLossOrder?.price ?? null,
      takeProfitPrice: t.takeProfitOrder?.price ?? null,
      stopAttached: Boolean(t.stopLossOrder),
    });
  }

  const brokerTradeIds = new Set(state.trades.map((t) => String(t.id)));
  // Only a trade the record believes is OPEN can be "missing at the broker".
  const missingAtBroker = belief
    .filter((b) => b.tradeId && !brokerTradeIds.has(b.tradeId) && rank(b.state) >= rank("FILLED") && b.state !== "CLOSED")
    .map((b) => ({ orderKey: b.orderKey, lastKnownTradeId: b.tradeId, lastState: b.state }));

  const pendingManagedOrders = state.orders
    .filter((o) => o.clientExtensions?.tag === MERIDIAN_TAG)
    .map((o) => ({ orderId: o.id, instrument: o.instrument, units: o.units, type: o.type }));

  const report: ReconciliationReport = {
    readAt: state.readAt,
    brokerOk: state.ok,
    errors: state.errors,
    belief,
    matched,
    manualExternal,
    unrecordedManaged,
    missingAtBroker,
    pendingManagedOrders,
    policy:
      "Broker wins over belief. Manual (non-Meridian) trades are recorded as MANUAL_EXTERNAL and never adopted, modified, protected or closed. Managed trades present at the broker but absent from the record are recorded as unrecorded; managed trades in the record but absent at the broker are recorded as closed-elsewhere. Nothing is silently overwritten.",
  };

  await appendRecord({ kind: "RECONCILIATION", state: report.brokerOk ? "OK" : "PARTIAL", payload: report });
  return report;
}

/* --------------------------------------------------------------- stop controls */

/** Control 1 — pause new entries. Does not touch anything already at the broker. */
export async function pauseEntries(reason: string): Promise<{ ok: true; before: Awaited<ReturnType<typeof readPause>>; after: Awaited<ReturnType<typeof readPause>> }> {
  const before = await readPause();
  await writePause(true, reason);
  const after = await readPause();
  await appendRecord({
    kind: "PAUSE_SET",
    state: "PAUSED",
    payload: {
      reason,
      before,
      after,
      scope: "new entries only — existing orders, positions and their attached stopLossOnFill/takeProfitOnFill are not touched by a pause",
    },
  });
  return { ok: true, before, after };
}

/** Resume new entries. */
export async function resumeEntries(reason: string): Promise<{ ok: true; before: Awaited<ReturnType<typeof readPause>>; after: Awaited<ReturnType<typeof readPause>> }> {
  const before = await readPause();
  await writePause(false, reason);
  const after = await readPause();
  await appendRecord({ kind: "PAUSE_CLEARED", state: "RUNNING", payload: { reason, before, after } });
  return { ok: true, before, after };
}

/**
 * Order types that CREATE exposure and may therefore be cancelled by control 2.
 * Everything else — and in particular STOP_LOSS, TAKE_PROFIT and TRAILING_STOP_LOSS —
 * is protection and is never cancelled by a control.
 */
const ENTRY_ORDER_TYPES = new Set(["MARKET", "LIMIT", "STOP", "MARKET_IF_TOUCHED"]);
const PROTECTIVE_ORDER_TYPES = new Set(["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP_LOSS", "GUARANTEED_STOP_LOSS"]);

function isCancellableEntryOrder(o: any): { ok: boolean; why: string } {
  const type = String(o?.type ?? "");
  if (PROTECTIVE_ORDER_TYPES.has(type)) return { ok: false, why: `type ${type} is protective and is never cancelled by a control` };
  if (!ENTRY_ORDER_TYPES.has(type)) return { ok: false, why: `type ${type} is not an entry order type` };
  if (o?.tradeID !== undefined && o?.tradeID !== null && String(o.tradeID) !== "") {
    return { ok: false, why: `order is attached to trade ${String(o.tradeID)} and is therefore protection, not an entry` };
  }
  return { ok: true, why: "entry order" };
}

/** Snapshot of every open trade's protective legs, for before/after comparison. */
async function protectionSnapshot(client: Client): Promise<Array<{ tradeId: string; stopId: string | null; stopPrice: string | null; tpId: string | null; tpPrice: string | null }>> {
  const res = await client.openTrades();
  const trades = !isTransportFailure(res) && res.ok ? (res.body.trades ?? []) : [];
  return trades.map((t: any) => ({
    tradeId: String(t.id),
    stopId: t.stopLossOrder ? String(t.stopLossOrder.id) : null,
    stopPrice: t.stopLossOrder?.price ?? null,
    tpId: t.takeProfitOrder ? String(t.takeProfitOrder.id) : null,
    tpPrice: t.takeProfitOrder?.price ?? null,
  }));
}

/**
 * Control 2 — cancel pending ENTRY orders. Only Meridian's own, only orders that can
 * create exposure. Protective orders are never touched: this was a real defect found
 * in verification (a first version cancelled the stop and take-profit legs, because
 * OANDA reports them as PENDING), so the control now refuses those types outright and
 * verifies its own side effects before reporting success.
 */
export async function cancelPendingOrders(client: Client, reason: string): Promise<{
  cancelled: Array<{ orderId: string; instrument: string; type: string }>;
  refused: Array<{ orderId: string; reason: string }>;
  untouchedManual: Array<{ orderId: string; instrument: string; type: string }>;
  untouchedProtective: Array<{ orderId: string; tradeId: string | null; type: string; why: string }>;
  protectionsBefore: Awaited<ReturnType<typeof protectionSnapshot>>;
  protectionsAfter: Awaited<ReturnType<typeof protectionSnapshot>>;
  protectionsPreserved: boolean;
}> {
  const protectionsBefore = await protectionSnapshot(client);
  const res = await client.orders("PENDING");
  if (isTransportFailure(res) || !res.ok) {
    await appendRecord({ kind: "CONTROL_REFUSED", state: "UNAVAILABLE", payload: { control: "cancel-pending", reason, error: isTransportFailure(res) ? res.error : res.text } });
    return {
      cancelled: [],
      refused: [{ orderId: "-", reason: "could not read pending orders from the broker" }],
      untouchedManual: [],
      untouchedProtective: [],
      protectionsBefore,
      protectionsAfter: protectionsBefore,
      protectionsPreserved: true,
    };
  }
  const cancelled: Array<{ orderId: string; instrument: string; type: string }> = [];
  const refused: Array<{ orderId: string; reason: string }> = [];
  const untouchedManual: Array<{ orderId: string; instrument: string; type: string }> = [];
  const untouchedProtective: Array<{ orderId: string; tradeId: string | null; type: string; why: string }> = [];

  for (const o of res.body.orders ?? []) {
    if (o.clientExtensions?.tag !== MERIDIAN_TAG) {
      untouchedManual.push({ orderId: String(o.id), instrument: o.instrument, type: String(o.type) });
      continue;
    }
    const gate = isCancellableEntryOrder(o);
    if (!gate.ok) {
      untouchedProtective.push({ orderId: String(o.id), tradeId: o.tradeID ? String(o.tradeID) : null, type: String(o.type), why: gate.why });
      continue;
    }
    const c = await client.cancelOrder(o.id);
    if (isTransportFailure(c) || !c.ok) {
      refused.push({ orderId: String(o.id), reason: isTransportFailure(c) ? c.error : (c.body?.errorMessage ?? c.text) });
      continue;
    }
    cancelled.push({ orderId: String(o.id), instrument: o.instrument, type: String(o.type) });
    await appendRecord({
      kind: "CANCELLED",
      state: "CANCELLED",
      payload: { control: "cancel-pending", reason, orderId: String(o.id), instrument: o.instrument, orderType: String(o.type), brokerResponse: c.body },
    });
  }

  const protectionsAfter = await protectionSnapshot(client);
  const protectionsPreserved = JSON.stringify(protectionsBefore) === JSON.stringify(protectionsAfter);
  await appendRecord({
    kind: protectionsPreserved ? "RECONCILIATION" : "CONTROL_REFUSED",
    state: protectionsPreserved ? "OK" : "PROTECTION_LOST",
    payload: {
      control: "cancel-pending",
      reason,
      cancelled,
      refused,
      untouchedManual,
      untouchedProtective,
      protectionsBefore,
      protectionsAfter,
      protectionsPreserved,
      note: protectionsPreserved
        ? "every open trade still carries the same stop-loss and take-profit order ids and prices as before the control ran"
        : "PROTECTION CHANGED during a cancel-pending control — this must be treated as a defect, not a result",
    },
  });

  return { cancelled, refused, untouchedManual, untouchedProtective, protectionsBefore, protectionsAfter, protectionsPreserved };
}

/**
 * Control 3 — close Meridian-managed positions. Manual trades are never closed here.
 */
export async function closeManagedPositions(client: Client, reason: string): Promise<{
  closed: Array<{ tradeId: string; instrument: string; units: string; realizedPL: number | null; transactionId: string | null }>;
  refused: Array<{ tradeId: string; reason: string }>;
  untouchedManual: Array<{ tradeId: string; instrument: string }>;
}> {
  const res = await client.openTrades();
  if (isTransportFailure(res) || !res.ok) {
    await appendRecord({ kind: "CONTROL_REFUSED", state: "UNAVAILABLE", payload: { control: "close-managed", reason, error: isTransportFailure(res) ? res.error : res.text } });
    return { closed: [], refused: [{ tradeId: "-", reason: "could not read open trades from the broker" }], untouchedManual: [] };
  }
  const known = await managedTradeIdsFromRecord();
  const closed: Array<{ tradeId: string; instrument: string; units: string; realizedPL: number | null; transactionId: string | null }> = [];
  const refused: Array<{ tradeId: string; reason: string }> = [];
  const untouchedManual: Array<{ tradeId: string; instrument: string }> = [];
  for (const t of res.body.trades ?? []) {
    if (!isManaged(t, known)) {
      untouchedManual.push({ tradeId: String(t.id), instrument: t.instrument });
      continue;
    }
    // The order key must travel with the close, or the record cannot attribute the
    // closure to the signal that opened the trade and reconciliation will believe a
    // closed trade is still open. Derived from the protective legs (which carry the
    // key) with the record as the fallback.
    const closeKey =
      (t.stopLossOrder?.clientExtensions?.id as string | undefined)?.replace(/-sl$/, "") ??
      (t.takeProfitOrder?.clientExtensions?.id as string | undefined)?.replace(/-tp$/, "") ??
      null;
    await appendRecord({
      kind: "CLOSE_REQUESTED",
      orderKey: closeKey,
      state: "OPEN",
      payload: { control: "close-managed", reason, tradeId: t.id, instrument: t.instrument, units: t.currentUnits },
    });
    const c = await client.closeTrade(t.id);
    if (isTransportFailure(c) || !c.ok) {
      refused.push({ tradeId: t.id, reason: isTransportFailure(c) ? c.error : (c.body?.errorMessage ?? c.text) });
      continue;
    }
    const fill = c.body?.orderFillTransaction ?? null;
    const realizedPL = fill?.pl !== undefined ? Number(fill.pl) : null;
    closed.push({ tradeId: t.id, instrument: t.instrument, units: t.currentUnits, realizedPL, transactionId: fill?.id ? String(fill.id) : null });
    await appendRecord({
      kind: "CLOSED",
      orderKey: closeKey,
      state: "CLOSED",
      payload: {
        control: "close-managed",
        reason,
        tradeId: t.id,
        instrument: t.instrument,
        units: t.currentUnits,
        realizedPL,
        transactionId: fill?.id ?? null,
        brokerTimestamp: fill?.time ?? null,
        brokerResponse: c.body,
      },
    });
  }
  return { closed, refused, untouchedManual };
}

/* --------------------------------------------------------------------- status */

export type StatusSnapshot = {
  generatedAt: string;
  interlock: { practiceHost: string; configurable: boolean };
  mode: { current: string; source: string; automaticReachable: boolean };
  testProfile: boolean;
  pause: { paused: boolean; reason: string | null; setAt: string | null };
  settings: Array<{ key: string; value: unknown; source: string }>;
  missingSettings: string[];
  strategies: Array<{ id: string; version: string; label: string; enabled: boolean; note: string }>;
  broker: {
    ok: boolean;
    readAt: string;
    currency: string | null;
    nav: number | null;
    marginAvailable: number | null;
    openTrades: number;
    managedTrades: number;
    manualTrades: number;
    errors: string[];
  };
  orders: Array<{
    signalId: string | null;
    orderKey: string | null;
    state: string;
    instrument: string | null;
    direction: string | null;
    units: number | null;
    origin: string | null;
    brokerOrderId: string | null;
    brokerTradeId: string | null;
    stopAttached: boolean | null;
    recordedAt: string;
  }>;
  record: { path: string; records: number; chainOk: boolean };
  latency: { lastRoundTripMs: number | null; lastInstructionToAckMs: number | null; measuredCount: number; medianRoundTripMs: number | null };
  /**
   * Realised risk measured at the broker's fill against the configured maximum. A breach
   * here is a filled position that risked more than the owner allows; it is surfaced as an
   * alert as well, because a record nobody reads is a log line.
   */
  risk: {
    breaches: Awaited<ReturnType<typeof riskBreachesFromRecord>>;
    breachCount: number;
    unmeasuredCount: number;
    note: string;
  };
  /** Everything that needs a human eye, in plain sentences. Empty means nothing outstanding. */
  alerts: string[];
};

/**
 * Build the dashboard snapshot. Read-only: it reads the broker, the record and the
 * config, and writes nothing except a RECONCILIATION-free summary (no record append).
 */
export async function buildStatus(client: Client, config: ExecutionConfigLike): Promise<StatusSnapshot> {
  const { all } = await replay();
  const { verifyChain } = await import("./record.ts");
  const chain = await verifyChain();
  const pause = await readPause();
  const broker = await readBrokerState(client);
  const settings = resolveSettingsLike(config);

  const latest = new Map<string, (typeof all)[number]>();
  for (const r of all) {
    if (!r.orderKey) continue;
    if (["INSTRUCTION_RECEIVED", "SIGNALS_ONLY", "NO_ELIGIBLE_STRATEGY", "VALIDATION_REFUSED"].includes(r.kind) && !latest.has(r.orderKey)) {
      latest.set(r.orderKey, r);
    }
    if (["ORDER_ACKNOWLEDGED", "FILL", "PARTIAL_FILL", "PROTECTED", "CLOSED", "CANCELLED", "ORDER_REJECTED", "DUPLICATE_SUPPRESSED"].includes(r.kind)) {
      latest.set(r.orderKey, r);
    }
  }

  const orders: StatusSnapshot["orders"] = [];
  for (const [orderKey, r] of latest) {
    const p = (r.payload ?? {}) as any;
    const proposal = p.proposal ?? {};
    const trade = p.trade ?? {};
    orders.push({
      signalId: r.signalId,
      orderKey,
      state: r.state ?? r.kind,
      instrument: proposal.instrument ?? trade.instrument ?? null,
      direction: proposal.direction ?? null,
      units: typeof proposal.units === "number" ? proposal.units : null,
      origin: proposal.origin ?? p.origin ?? null,
      brokerOrderId: p.orderId ?? null,
      brokerTradeId: p.tradeId ?? trade.id ?? null,
      stopAttached: typeof p.protected === "boolean" ? p.protected : trade.stopLossOrder ? true : null,
      recordedAt: r.recordedAt,
    });
  }
  orders.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));

  const trades = broker.trades ?? [];
  const knownTradeIds = await managedTradeIdsFromRecord();
  const managedTrades = trades.filter((t) => isManaged(t, knownTradeIds)).length;

  const trips = all
    .filter((r) => r.kind === "ORDER_ACKNOWLEDGED")
    .map((r) => Number((r.payload as any)?.roundTripMs))
    .filter((n) => Number.isFinite(n));
  const i2a = all
    .filter((r) => r.kind === "ORDER_ACKNOWLEDGED")
    .map((r) => Number((r.payload as any)?.instructionToAckMs))
    .filter((n) => Number.isFinite(n));
  const breaches = await riskBreachesFromRecord();
  const unmeasured = all.filter((r) => r.kind === "REALISED_RISK" && (r.payload as any)?.measured === false).length;
  const alerts: string[] = [];
  for (const b of breaches) {
    alerts.push(
      `RISK BREACH: trade ${b.tradeId ?? "?"} ${b.instrument ?? ""} ${b.direction ?? ""} ${b.units ?? "?"} units filled at ${b.fillPrice ?? "?"} with its stop at ${b.stopPrice ?? "?"} — realised risk ${b.realisedRiskAccountCurrency?.toFixed(2) ?? "?"} against a maximum of ${b.capAccountCurrency?.toFixed(2) ?? "?"} (+${b.breachAmountAccountCurrency?.toFixed(2) ?? "?"}, +${b.breachPctOfCap?.toFixed(2) ?? "?"}%), budgeted ${b.budgetedRiskAccountCurrency?.toFixed(2) ?? "unknown"}`,
    );
  }
  if (unmeasured > 0) {
    alerts.push(`${unmeasured} filled trade(s) have an UNMEASURED realised risk — see the REALISED_RISK records with state UNMEASURED for the reason`);
  }
  if (!chain.ok) {
    alerts.push(`the execution record's hash chain is BROKEN at record ${chain.firstBreak?.seq ?? "?"} (${chain.firstBreak?.reason ?? ""}) — the record is not trustworthy until this is explained`);
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };

  return {
    generatedAt: new Date().toISOString(),
    interlock: { practiceHost: PRACTICE_HOST, configurable: false },
    mode: { current: config.mode, source: config.modeSource, automaticReachable: config.mode === "automatic" },
    testProfile: config.useTestProfile,
    pause,
    settings: settings.map((s) => ({ key: s.key, value: s.value, source: s.source })),
    missingSettings: settings.filter((s) => s.source === "UNSET").map((s) => s.key),
    strategies: config.strategies,
    broker: {
      ok: broker.ok,
      readAt: broker.readAt,
      currency: broker.account?.currency ?? null,
      nav: broker.account?.nav ?? null,
      marginAvailable: broker.account?.marginAvailable ?? null,
      openTrades: trades.length,
      managedTrades,
      manualTrades: trades.length - managedTrades,
      errors: broker.errors,
    },
    orders: orders.slice(0, 25),
    record: { path: "/home/team/shared/execution/orders.jsonl", records: chain.recordCount, chainOk: chain.ok },
    latency: {
      lastRoundTripMs: trips.length ? trips[trips.length - 1]! : null,
      lastInstructionToAckMs: i2a.length ? i2a[i2a.length - 1]! : null,
      measuredCount: trips.length,
      medianRoundTripMs: median(trips),
    },
    risk: {
      breaches,
      breachCount: breaches.length,
      unmeasuredCount: unmeasured,
      note: "Realised risk is measured from the broker's fill price and the stop the broker reports as attached. A breach is a position that risked more than the configured maximum per trade; it is detected after the fill because a MARKET/FOK entry is filled inside the request that submits it.",
    },
    alerts,
  };
}
