/**
 * The execution report: a plain-language digest of what the system actually did.
 *
 * WHY IT EXISTS. Automatic Practice execution is live and the owner is notified of nothing.
 * An order can fill while nobody is looking; the only trace is the console and the
 * append-only record. This module turns those two sources into one short document that says
 * what happened, in words, with every number traceable to the record id it came from.
 *
 * THE RULES IT IS BUILT TO, and where each one lives in the code:
 *
 *  1. Stored, reproducible data only. Every figure comes from (a) the append-only record
 *     (`execution/orders.jsonl`, quoted by `seq`) or (b) a live broker read, whose own
 *     timestamp is recorded next to it. Nothing is estimated.
 *  2. An order request is NOT a trade. `ORDER_REQUESTED` records are listed as requests.
 *     Only a fill the broker itself confirmed — a `FILL`/`PARTIAL_FILL` record carrying the
 *     broker's trade id and fill price, or a trade the broker reports — is called a fill.
 *     `buildReport` puts anything short of that in `unconfirmedFillRecords`, never in `fills`.
 *  3. Anything not measurable is labelled unmeasured, never guessed. No broker read means
 *     `measured:false` and the numbers are null, not zero. A close with no broker fill
 *     transaction has `realizedPL: null` and the reason is stated.
 *  4. The record's own defects are reported, not hidden. The hash chain is BROKEN at
 *     sequence 1417 from the 2026-11-03 duplicate-writer incident
 *     (execution/INCIDENT-2026-11-03-chain-break.md); the report states that, with the
 *     first break's seq and reason, on every page.
 *  5. A gap between the record and the broker is stated as a gap. The broker's closed-trade
 *     history is read and compared with the record's `CLOSED` records; a trade the broker
 *     closed but the record never recorded appears in `reconciliation.closedAtBrokerNotInRecord`
 *     with its P/L — as a missing event in our record, not as our measurement.
 *  6. Nothing sent is not delivery. The notification section carries the result of
 *     `notify.deliverReport` verbatim, including the exact sentence used when no channel is
 *     configured.
 *
 * OUTPUT. Two files per report in `execution/reports/`: `<reportId>.json` (machine-readable,
 * the same object this module returns) and `<reportId>.md` (the short human-readable
 * version), plus `latest.json` / `latest.md` copies for the console. The report id, the
 * record ids it was built from and the delivery outcome are appended to the record as a
 * `REPORT_GENERATED` entry, so the report itself is auditable from the record.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendRecord, readRecords, recordPath, verifyChain, type ExecutionRecord, type VerifyResult } from "./lib/record.ts";
import { withLedgerLock } from "./lib/ledgerLock.ts";
import { reportsDir, reportStatePath } from "./lib/paths.ts";
import { redact, type Client } from "./lib/client.ts";
import { MERIDIAN_TAG } from "./lib/engine.ts";
import { readBrokerState } from "./lib/ops.ts";
import type { ExecutionConfig } from "./lib/config.ts";
import { resolveTransport, deliverReport, NO_TRANSPORT_DETAIL, type NotificationResult, type NotificationTransport } from "./notify.ts";

/* ------------------------------------------------------------------ trigger events */

/**
 * Record kinds that make a report due IMMEDIATELY, without waiting for the interval: a
 * fill, a close, a refusal or an error. These are the events a person would want to hear
 * about while it is still news.
 */
export const REPORT_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "FILL",
  "PARTIAL_FILL",
  "CLOSED",
  "VALIDATION_REFUSED",
  "CONTROL_REFUSED",
  "ORDER_REJECTED",
  "CONNECTION_FAILURE",
]);

export type ReportTrigger = "SCHEDULED" | "EVENT" | "MANUAL" | "CONSOLE";

/* ------------------------------------------------------------------------ shapes */

export type LedgerLike = Pick<ExecutionRecord, "seq" | "recordedAt" | "kind"> & {
  signalId?: string | null;
  strategyId?: string | null;
  orderKey?: string | null;
  state?: string | null;
  payload?: unknown;
};

export type ReportBrokerTrade = {
  id: string;
  instrument: string;
  currentUnits?: string;
  price?: string;
  unrealizedPL?: string;
  stopLossOrder?: { id?: string; price?: string } | null;
  takeProfitOrder?: { id?: string; price?: string } | null;
  clientExtensions?: { id?: string; tag?: string } | null;
};

export type ReportBrokerClosedTrade = {
  id: string;
  instrument: string;
  realizedPL: string;
  financing: string;
  openTime?: string;
  closeTime?: string;
  clientExtensions?: { id?: string; tag?: string } | null;
};

export type ReportBrokerState = {
  ok: boolean;
  readAt: string;
  errors: string[];
  account: {
    currency: string;
    nav: number;
    balance: number;
    unrealizedPL: number;
    openTradeCount: number;
    marginAvailable?: number;
  } | null;
  openTrades: ReportBrokerTrade[];
  closedTrades: {
    ok: boolean;
    readAt: string;
    error: string | null;
    trades: ReportBrokerClosedTrade[];
  };
};

export type ReportWindow = {
  /** Exclusive: the last record the PREVIOUS report covered. */
  fromSeq: number;
  /** Inclusive: the last record this report covers. */
  toSeq: number;
  fromRecordedAt: string | null;
  toRecordedAt: string;
  /** How the start was chosen. */
  basis: "RECORD_START" | "PREVIOUS_REPORT" | "EXPLICIT";
  description: string;
};

export type ReportFill = {
  seq: number;
  kind: "FILL" | "PARTIAL_FILL";
  orderKey: string | null;
  signalId: string | null;
  tradeId: string;
  instrument: string | null;
  units: string | null;
  price: string | null;
  /** True only because the record carries the broker's own trade id and fill price. */
  brokerConfirmed: true;
  recordedAt: string;
};

export type ReportClose = {
  seq: number;
  tradeId: string | null;
  instrument: string | null;
  units: string | null;
  realizedPL: number | null;
  financing: number | null;
  commission: number | null;
  transactionId: string | null;
  /** True only when the record carries a broker fill transaction (id + P/L). */
  brokerConfirmed: boolean;
  recordedAt: string;
  reason: string | null;
};

export type ReportRefusal = {
  seq: number;
  kind: "VALIDATION_REFUSED" | "CONTROL_REFUSED";
  state: string | null;
  orderKey: string | null;
  signalId: string | null;
  reasons: string[];
  recordedAt: string;
};

export type ReportError = {
  seq: number;
  kind: "CONNECTION_FAILURE" | "ORDER_REJECTED";
  state: string | null;
  orderKey: string | null;
  message: string;
  recordedAt: string;
};

export type ReportOpenPosition = {
  tradeId: string;
  instrument: string;
  units: string | null;
  stopPrice: string | null;
  takeProfitPrice: string | null;
  hasStop: boolean;
  hasTarget: boolean;
  managed: boolean;
  /** Where this came from. Always the broker: belief never appears as an open position. */
  source: "BROKER_OPEN_TRADES";
};

export type ReportJson = {
  reportId: string;
  generatedAt: string;
  trigger: ReportTrigger;
  triggerDetail: string | null;
  window: ReportWindow;
  ledger: {
    path: string;
    recordsTotal: number;
    recordsInWindow: number;
    firstSeqInWindow: number | null;
    lastSeqInWindow: number | null;
    chain: {
      ok: boolean;
      recordCount: number;
      firstBreakSeq: number | null;
      firstBreakLine: number | null;
      firstBreakReason: string | null;
      explanation: string;
    };
  };
  mode: {
    current: string;
    source: string;
    automaticAcknowledged: boolean;
    acknowledgedBy: string | null;
    note: string;
  };
  account: {
    measured: boolean;
    readAt: string | null;
    currency: string | null;
    nav: number | null;
    balance: number | null;
    unrealizedPL: number | null;
    openTradeCount: number | null;
    errors: string[];
    lastRecordedRead: { seq: number; recordedAt: string; nav: number | null; balance: number | null } | null;
  };
  counts: {
    orderRequests: number;
    brokerConfirmedFills: number;
    partialFills: number;
    closes: number;
    /** Closes in the record that carry a broker fill transaction (P/L is broker-confirmed). */
    closesBrokerConfirmed: number;
    refusals: number;
    errors: number;
    duplicateSuppressions: number;
    cancellations: number;
  };
  orderRequests: Array<{
    seq: number;
    orderKey: string | null;
    signalId: string | null;
    instrument: string | null;
    units: string | null;
    type: string | null;
    recordedAt: string;
    note: string;
  }>;
  fills: ReportFill[];
  /** A FILL-kind record that does NOT carry broker confirmation. Never counted as a fill. */
  unconfirmedFillRecords: Array<{ seq: number; reason: string; recordedAt: string }>;
  closes: ReportClose[];
  /** Further CLOSED records for a trade already counted above (repeats / discoveries). */
  closeRecordDuplicates: Array<{ seq: number; tradeId: string | null; ofSeq: number | null; why: string }>;
  refusals: ReportRefusal[];
  errors: ReportError[];
  openPositions: ReportOpenPosition[];
  protection: {
    measured: boolean;
    managedOpenCount: number | null;
    anyLacksStop: boolean | null;
    lacksStop: Array<{ tradeId: string; instrument: string; units: string | null }>;
    lacksTarget: Array<{ tradeId: string; instrument: string; units: string | null }>;
    note: string;
  };
  brokerClosedTrades: {
    measured: boolean;
    readAt: string | null;
    error: string | null;
    count: number;
    managedCount: number;
    realizedPLSum: number | null;
    financingSum: number | null;
    netOfFinancing: number | null;
    trades: Array<{
      tradeId: string;
      instrument: string;
      realizedPL: number | null;
      financing: number | null;
      openTime: string | null;
      closeTime: string | null;
      managed: boolean;
    }>;
  };
  reconciliation: {
    /** Trades the BROKER reports closed that the record never recorded as closed. */
    closedAtBrokerNotInRecord: Array<{ tradeId: string; realizedPL: number | null; financing: number | null }>;
    /** Trades the broker closed for which the record has no FILL entry at all. */
    enteredAtBrokerWithoutFillRecord: string[];
    /** Trades the record closed that the broker does not list as closed. */
    closedInRecordNotAtBroker: Array<{ tradeId: string; seq: number }>;
    /** Implied account opening balance: balance − (realised P/L + financing). */
    impliedOpeningBalance: number | null;
    note: string;
  };
  totals: {
    ledgerConfirmedRealizedPL: number | null;
    ledgerConfirmedFinancing: number | null;
    ledgerFinancingUnmeasuredCloses: number;
  };
  notification: NotificationResult;
  unmeasured: string[];
  sources: {
    orderRequests: number[];
    fills: number[];
    closes: number[];
    refusals: number[];
    errors: number[];
    openPositions: "BROKER_READ" | "UNMEASURED";
    account: "BROKER_READ" | "UNMEASURED";
    brokerClosedTrades: "BROKER_READ" | "UNMEASURED";
    lastAccountReadSeq: number | null;
  };
  provenance: {
    builtBy: string;
    recordPath: string;
    recordIds: { from: number | null; to: number | null };
    statement: string;
  };
};

export type BuildReportInput = {
  records: LedgerLike[];
  broker: ReportBrokerState | null;
  config: Pick<ExecutionConfig, "mode" | "modeSource" | "automaticAcknowledged" | "acknowledgedBy">;
  chain: Pick<VerifyResult, "ok" | "recordCount" | "firstBreak">;
  notification: NotificationResult;
  generatedAt: string;
  trigger: ReportTrigger;
  triggerDetail?: string | null;
  /** Exclusive: the last seq the previous report covered. 0 = from the start of the record. */
  fromSeq?: number;
  windowBasis?: ReportWindow["basis"];
  recordPath?: string;
};

/* ------------------------------------------------------------------------ helpers */

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.trim() === "" ? null : s;
};

const payloadOf = (record: LedgerLike): Record<string, any> =>
  record.payload && typeof record.payload === "object" ? (record.payload as Record<string, any>) : {};

/** Money for the text version. Never used for the JSON, which keeps the raw numbers. */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unmeasured";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const [whole, cents] = abs.toFixed(2).split(".");
  return `${sign}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/**
 * OANDA account ids look like 101-001-25538627-001. They must never reach the report, a log
 * or the repository. Applied to the rendered text and the serialised JSON as a last guard,
 * on top of never copying an account id into the report in the first place.
 */
export function scrubAccountIds(input: string): string {
  return input.replace(/\b\d{3}-\d{3}-\d{3,8}-\d{3}\b/g, "[ACCOUNT-ID-REDACTED]");
}

/** A sortable, filename-safe id: rpt-20261104T013000Z. */
export function newReportId(at: Date): string {
  const compact = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `rpt-${compact}`;
}

/* ---------------------------------------------------------------- the builder */

/**
 * Build the report from stored records and a broker read. Pure: no I/O, no clock, no
 * environment. `generateReport` supplies the inputs; the tests supply their own.
 */
export function buildReport(input: BuildReportInput): ReportJson {
  const records = [...input.records].sort((a, b) => a.seq - b.seq);
  const fromSeq = input.fromSeq ?? 0;
  const toSeq = records.length ? records[records.length - 1]!.seq : 0;
  const inWindow = records.filter((r) => r.seq > fromSeq && r.seq <= toSeq);
  const firstInWindow = inWindow[0] ?? null;

  const basis: ReportWindow["basis"] = input.windowBasis ?? (fromSeq > 0 ? "PREVIOUS_REPORT" : "RECORD_START");
  const windowDescription =
    basis === "PREVIOUS_REPORT"
      ? `records ${fromSeq + 1}–${toSeq} (after the last record the previous report covered, ${fromSeq})`
      : basis === "RECORD_START"
        ? `the whole record so far: ${inWindow.length} record(s) from seq ${firstInWindow?.seq ?? 0} to ${toSeq}`
        : `records ${fromSeq + 1}–${toSeq}`;

  /* ---- order requests (requests, NOT trades) ---- */
  const orderRequests = inWindow
    .filter((r) => r.kind === "ORDER_REQUESTED")
    .map((r) => {
      const p = payloadOf(r);
      const order = p.request?.body?.order ?? {};
      return {
        seq: r.seq,
        orderKey: r.orderKey ?? null,
        signalId: r.signalId ?? null,
        instrument: str(order.instrument),
        units: str(order.units),
        type: str(order.type),
        recordedAt: r.recordedAt,
        note: "an order REQUEST sent to the broker — not a trade. Only a broker-confirmed fill below is a trade.",
      };
    });

  /* ---- fills: broker-confirmed only ---- */
  // The instrument of a fill is not always on the FILL record itself; the ORDER_REQUESTED
  // record for the same order key always names it. The map is built over the WHOLE record so
  // a fill whose request fell outside this window still resolves.
  const orderInfoByKey = new Map<string, { instrument: string | null; units: string | null }>();
  for (const r of records) {
    if (r.kind !== "ORDER_REQUESTED" || !r.orderKey) continue;
    const order = payloadOf(r).request?.body?.order ?? {};
    orderInfoByKey.set(r.orderKey, { instrument: str(order.instrument), units: str(order.units) });
  }
  const fills: ReportFill[] = [];
  const unconfirmedFillRecords: Array<{ seq: number; reason: string; recordedAt: string }> = [];
  for (const r of inWindow) {
    if (r.kind !== "FILL" && r.kind !== "PARTIAL_FILL") continue;
    const p = payloadOf(r);
    const tradeId = str(p.tradeId ?? p.tradeOpened?.tradeID);
    const price = str(p.price ?? p.tradeOpened?.price);
    const units = str(p.units ?? p.tradeOpened?.units);
    if (!tradeId || !price) {
      unconfirmedFillRecords.push({
        seq: r.seq,
        recordedAt: r.recordedAt,
        reason:
          "this record is of kind FILL but carries no broker trade id and fill price, so it is NOT counted as a fill: " +
          "an order request is not a trade and only the broker's own confirmation makes one.",
      });
      continue;
    }
    fills.push({
      seq: r.seq,
      kind: r.kind,
      orderKey: r.orderKey ?? null,
      signalId: r.signalId ?? null,
      tradeId,
      instrument: str(p.instrument ?? p.ackJson?.orderFillTransaction?.instrument ?? p.tradeOpened?.instrument ?? orderInfoByKey.get(r.orderKey ?? "")?.instrument),
      units,
      price,
      brokerConfirmed: true,
      recordedAt: r.recordedAt,
    });
  }
  // The broker's own open trades confirm a fill too (a dropped response can lose the FILL
  // record: trade 43 was opened that way), so the trade ids below are collected from every
  // record kind that names one — FILL, PROTECTED and RECONCILIATION included.

  /* ---- closes ---- */
  const closeRecords = inWindow.filter((r) => r.kind === "CLOSED");
  const closes: ReportClose[] = [];
  const closeRecordDuplicates: Array<{ seq: number; tradeId: string | null; ofSeq: number | null; why: string }> = [];
  const byTrade = new Map<string, LedgerLike[]>();
  const orphanCloses: LedgerLike[] = [];
  for (const r of closeRecords) {
    const p = payloadOf(r);
    const tradeId = str(p.tradeId ?? p.trade?.id);
    if (!tradeId) {
      orphanCloses.push(r);
      continue;
    }
    if (!byTrade.has(tradeId)) byTrade.set(tradeId, []);
    byTrade.get(tradeId)!.push(r);
  }
  for (const [tradeId, group] of byTrade) {
    // The primary close for a trade is the one carrying a broker fill transaction. When
    // several do (a repair re-records the same close), the earliest wins and the rest are
    // listed as repeats — counting them again would inflate the P/L.
    const withTx = group.filter((r) => {
      const p = payloadOf(r);
      return str(p.transactionId) !== null && num(p.realizedPL) !== null;
    });
    const primary = withTx[0] ?? group[0]!;
    const pp = payloadOf(primary);
    const tx = pp.brokerResponse?.orderFillTransaction ?? {};
    closes.push({
      seq: primary.seq,
      tradeId,
      instrument: str(pp.instrument ?? pp.trade?.instrument),
      units: str(pp.units ?? pp.trade?.currentUnits),
      realizedPL: num(pp.realizedPL ?? tx.pl),
      financing: num(tx.financing),
      commission: num(tx.commission),
      transactionId: str(pp.transactionId ?? tx.id),
      brokerConfirmed: str(pp.transactionId ?? tx.id) !== null && num(pp.realizedPL ?? tx.pl) !== null,
      recordedAt: primary.recordedAt,
      reason: str(pp.reason ?? pp.control),
    });
    for (const r of group) {
      if (r.seq === primary.seq) continue;
      const p = payloadOf(r);
      const sameTx = str(p.transactionId) === str(pp.transactionId) && str(p.transactionId) !== null;
      closeRecordDuplicates.push({
        seq: r.seq,
        tradeId,
        ofSeq: primary.seq,
        why: sameTx
          ? "repeat of the same broker fill transaction as the record already counted; not counted twice"
          : "a further CLOSED record for a trade already closed above (a reconciliation discovery or a repair) — it adds no new close and its P/L is not counted",
      });
    }
  }
  for (const r of orphanCloses) {
    const p = payloadOf(r);
    closes.push({
      seq: r.seq,
      tradeId: null,
      instrument: str(p.instrument),
      units: str(p.units),
      realizedPL: num(p.realizedPL),
      financing: null,
      commission: null,
      transactionId: str(p.transactionId),
      brokerConfirmed: false,
      recordedAt: r.recordedAt,
      reason: str(p.reason ?? p.control),
    });
  }
  closes.sort((a, b) => a.seq - b.seq);

  /* ---- refusals and errors ---- */
  const refusals: ReportRefusal[] = inWindow
    .filter((r) => r.kind === "VALIDATION_REFUSED" || r.kind === "CONTROL_REFUSED")
    .map((r) => {
      const p = payloadOf(r);
      const reasons = Array.isArray(p.reasons)
        ? p.reasons.map((x: unknown) => String(x))
        : [str(p.reason) ?? str(p.error) ?? "no reason recorded"].filter((x): x is string => x !== null);
      return {
        seq: r.seq,
        kind: r.kind as ReportRefusal["kind"],
        state: r.state ?? null,
        orderKey: r.orderKey ?? null,
        signalId: r.signalId ?? null,
        reasons,
        recordedAt: r.recordedAt,
      };
    });

  const errors: ReportError[] = inWindow
    .filter((r) => r.kind === "CONNECTION_FAILURE" || r.kind === "ORDER_REJECTED")
    .map((r) => {
      const p = payloadOf(r);
      const message =
        str(p.error) ??
        str(p.brokerResponse?.errorMessage) ??
        str(p.brokerResponse?.text) ??
        str(p.message) ??
        "no message recorded";
      return {
        seq: r.seq,
        kind: r.kind as ReportError["kind"],
        state: r.state ?? null,
        orderKey: r.orderKey ?? null,
        message,
        recordedAt: r.recordedAt,
      };
    });

  const duplicateSuppressions = inWindow.filter((r) => r.kind === "DUPLICATE_SUPPRESSED").length;
  const cancellations = inWindow.filter((r) => r.kind === "CANCELLED").length;

  /* ---- trade ids the record believes are Meridian's ---- */
  const knownTradeIds = new Set<string>();
  for (const r of records) {
    const p = payloadOf(r);
    if (r.kind === "FILL" || r.kind === "PARTIAL_FILL") {
      const id = str(p.tradeId ?? p.tradeOpened?.tradeID);
      if (id) knownTradeIds.add(id);
    }
    if (r.kind === "PROTECTED") {
      const id = str(p.trade?.id ?? p.tradeId);
      if (id) knownTradeIds.add(id);
    }
    if (r.kind === "RECONCILIATION") {
      for (const m of p.matched ?? []) {
        const id = str(m?.tradeId);
        if (id) knownTradeIds.add(id);
      }
    }
  }
  const isManagedTrade = (t: { id?: string; clientExtensions?: { id?: string; tag?: string } | null; stopLossOrder?: any; takeProfitOrder?: any }): boolean => {
    if (t.clientExtensions?.tag === MERIDIAN_TAG && typeof t.clientExtensions.id === "string") return true;
    for (const leg of [t.stopLossOrder, t.takeProfitOrder]) {
      if (leg?.clientExtensions?.tag === MERIDIAN_TAG && typeof leg.clientExtensions.id === "string") return true;
    }
    return t.id !== undefined && knownTradeIds.has(String(t.id));
  };

  /* ---- open positions: broker read only ---- */
  const broker = input.broker;
  const brokerOk = broker?.ok === true && broker.account !== null;
  const openPositions: ReportOpenPosition[] = (broker?.openTrades ?? []).map((t) => ({
    tradeId: String(t.id),
    instrument: String(t.instrument),
    units: str(t.currentUnits),
    stopPrice: str(t.stopLossOrder?.price),
    takeProfitPrice: str(t.takeProfitOrder?.price),
    hasStop: Boolean(t.stopLossOrder),
    hasTarget: Boolean(t.takeProfitOrder),
    managed: isManagedTrade(t),
    source: "BROKER_OPEN_TRADES",
  }));
  const managedOpen = openPositions.filter((p) => p.managed);
  const lacksStop = managedOpen.filter((p) => !p.hasStop).map((p) => ({ tradeId: p.tradeId, instrument: p.instrument, units: p.units }));
  const lacksTarget = managedOpen.filter((p) => !p.hasTarget).map((p) => ({ tradeId: p.tradeId, instrument: p.instrument, units: p.units }));

  /* ---- the broker's closed-trade history ---- */
  const closedRead = broker?.closedTrades ?? null;
  const closedMeasured = closedRead?.ok === true;
  const brokerClosed = (closedRead?.trades ?? []).map((t) => ({
    tradeId: String(t.id),
    instrument: String(t.instrument),
    realizedPL: num(t.realizedPL),
    financing: num(t.financing),
    openTime: str(t.openTime),
    closeTime: str(t.closeTime),
    managed: isManagedTrade(t),
  }));
  const managedBrokerClosed = brokerClosed.filter((t) => t.managed);
  const sumOrNull = (xs: Array<number | null>): number | null =>
    xs.length === 0 ? null : xs.every((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const brokerRealized = closedMeasured ? sumOrNull(managedBrokerClosed.map((t) => t.realizedPL)) : null;
  const brokerFinancing = closedMeasured ? sumOrNull(managedBrokerClosed.map((t) => t.financing)) : null;

  /* ---- record vs broker: say what is missing rather than smoothing it over ---- */
  const brokerClosedIds = new Set(managedBrokerClosed.map((t) => t.tradeId));
  const recordClosedIds = new Set(closes.filter((c) => c.brokerConfirmed && c.tradeId).map((c) => c.tradeId!));
  const closedAtBrokerNotInRecord = closedMeasured
    ? managedBrokerClosed
        .filter((t) => !recordClosedIds.has(t.tradeId))
        .map((t) => ({ tradeId: t.tradeId, realizedPL: t.realizedPL, financing: t.financing }))
    : [];
  const closedInRecordNotAtBroker = closedMeasured
    ? closes
        .filter((c) => c.tradeId !== null && !brokerClosedIds.has(c.tradeId))
        .map((c) => ({ tradeId: c.tradeId!, seq: c.seq }))
    : [];
  // A trade can exist at the broker with no FILL entry in the record: when the broker's reply
  // was lost, the entry was recorded as RETRY_DECISION + PROTECTED instead (trade 25 and trade
  // 43 were opened that way). Saying so keeps the fill count from reading as the number of
  // trades that ever existed.
  const recordFillIdsAll = new Set<string>();
  for (const r of records) {
    if (r.kind !== "FILL" && r.kind !== "PARTIAL_FILL") continue;
    const p = payloadOf(r);
    const id = str(p.tradeId ?? p.tradeOpened?.tradeID);
    if (id) recordFillIdsAll.add(id);
  }
  const enteredAtBrokerWithoutFillRecord = closedMeasured
    ? managedBrokerClosed.filter((t) => !recordFillIdsAll.has(t.tradeId)).map((t) => t.tradeId)
    : [];

  /* ---- totals from the record (labelled as the record's, not the broker's) ---- */
  const confirmedCloses = closes.filter((c) => c.brokerConfirmed);
  const ledgerRealized = confirmedCloses.length ? confirmedCloses.reduce((a, c) => a + (c.realizedPL ?? 0), 0) : null;
  const measuredFinancing = confirmedCloses.filter((c) => c.financing !== null);
  const ledgerFinancing = measuredFinancing.length ? measuredFinancing.reduce((a, c) => a + (c.financing ?? 0), 0) : null;
  const financingUnmeasured = confirmedCloses.length - measuredFinancing.length;

  /* ---- account ---- */
  const account: ReportJson["account"] = brokerOk && broker!.account
    ? {
        measured: true,
        readAt: broker!.readAt,
        currency: broker!.account.currency,
        nav: broker!.account.nav,
        balance: broker!.account.balance,
        unrealizedPL: broker!.account.unrealizedPL,
        openTradeCount: broker!.account.openTradeCount,
        errors: broker!.errors,
        lastRecordedRead: null,
      }
    : {
        measured: false,
        readAt: broker?.readAt ?? null,
        currency: null,
        nav: null,
        balance: null,
        unrealizedPL: null,
        openTradeCount: null,
        errors: broker?.errors ?? ["no broker read was made"],
        lastRecordedRead: null,
      };

  const lastAccountReadRecord = [...records].reverse().find((r) => r.kind === "ACCOUNT_READ");
  const lastAccountRead = lastAccountReadRecord
    ? {
        seq: lastAccountReadRecord.seq,
        recordedAt: lastAccountReadRecord.recordedAt,
        nav: num(payloadOf(lastAccountReadRecord).nav),
        balance: num(payloadOf(lastAccountReadRecord).balance),
      }
    : null;
  account.lastRecordedRead = lastAccountRead;

  const impliedOpeningBalance =
    account.measured && account.balance !== null && brokerRealized !== null
      ? Number((account.balance - (brokerRealized + (brokerFinancing ?? 0))).toFixed(2))
      : null;

  /* ---- unmeasured: the honest list ---- */
  const unmeasured: string[] = [];
  if (!account.measured) unmeasured.push("account NAV, balance and open-trade count: the broker read failed, so these are unmeasured, not zero");
  if (!closedMeasured) unmeasured.push("the broker's closed-trade history (realised P/L and financing per closed trade): the read failed");
  if (!brokerOk) unmeasured.push("open positions and their protective stops: the broker read failed, so 'no unprotected position' is NOT asserted");
  if (financingUnmeasured > 0)
    unmeasured.push(
      `${financingUnmeasured} close(s) in the record carry no broker fill transaction, so their financing is unmeasured — the record's financing total covers only the closes that do`,
    );
  if (closedAtBrokerNotInRecord.length > 0)
    unmeasured.push(
      `${closedAtBrokerNotInRecord.length} trade(s) the broker reports closed have NO close record in the append-only record (${closedAtBrokerNotInRecord
        .map((t) => t.tradeId)
        .join(", ")}); their P/L is the broker's figure, and the record is missing that event — it is not our measurement`,
    );
  if (closedMeasured && (closedRead?.trades.length ?? 0) >= 500)
    unmeasured.push("the broker's closed-trade read was capped at 500 trades; older closes may be outside it");
  if (!input.chain.ok)
    unmeasured.push(
      `the record's hash chain is BROKEN at seq ${input.chain.firstBreak?.seq ?? "?"}: records after that point cannot be proven unmodified, so every figure taken from them inherits that doubt`,
    );

  const recordIdsFrom = inWindow.length ? inWindow[0]!.seq : null;

  return {
    reportId: newReportId(new Date(input.generatedAt)),
    generatedAt: input.generatedAt,
    trigger: input.trigger,
    triggerDetail: input.triggerDetail ?? null,
    window: {
      fromSeq,
      toSeq,
      fromRecordedAt: firstInWindow?.recordedAt ?? null,
      toRecordedAt: inWindow.length ? inWindow[inWindow.length - 1]!.recordedAt : input.generatedAt,
      basis,
      description: windowDescription,
    },
    ledger: {
      path: input.recordPath ?? "orders.jsonl",
      recordsTotal: records.length,
      recordsInWindow: inWindow.length,
      firstSeqInWindow: recordIdsFrom,
      lastSeqInWindow: inWindow.length ? inWindow[inWindow.length - 1]!.seq : null,
      chain: {
        ok: input.chain.ok,
        recordCount: input.chain.recordCount,
        firstBreakSeq: input.chain.firstBreak?.seq ?? null,
        firstBreakLine: input.chain.firstBreak?.line ?? null,
        firstBreakReason: input.chain.firstBreak?.reason ?? null,
        explanation:
          "The append-only record's hash chain is the proof that no line was altered. It is BROKEN at the seq below " +
          "because of the 2026-11-03 duplicate-writer incident (two watchers appended at once); see " +
          "execution/INCIDENT-2026-11-03-chain-break.md. The break is explained in writing and NOT rewritten, so every " +
          "figure after it is reported with that caveat rather than presented as verified.",
      },
    },
    mode: {
      current: input.config.mode,
      source: input.config.modeSource,
      automaticAcknowledged: input.config.automaticAcknowledged,
      acknowledgedBy: input.config.acknowledgedBy,
      note:
        input.config.mode === "automatic"
          ? "Automatic execution is active: qualifying signals are submitted without a human in the loop. The strategy being executed is the invented ruleset, which both backtests measured as losing."
          : `Execution mode is ${input.config.mode}: the watcher does not submit on its own.`,
    },
    account,
    counts: {
      orderRequests: orderRequests.length,
      brokerConfirmedFills: fills.filter((f) => f.kind === "FILL").length,
      partialFills: fills.filter((f) => f.kind === "PARTIAL_FILL").length,
      closes: closes.length,
      closesBrokerConfirmed: confirmedCloses.length,
      refusals: refusals.length,
      errors: errors.length,
      duplicateSuppressions,
      cancellations,
    },
    orderRequests,
    fills,
    unconfirmedFillRecords,
    closes,
    closeRecordDuplicates,
    refusals,
    errors,
    openPositions,
    protection: {
      measured: brokerOk,
      managedOpenCount: brokerOk ? managedOpen.length : null,
      anyLacksStop: brokerOk ? lacksStop.length > 0 : null,
      lacksStop,
      lacksTarget,
      note: !brokerOk
        ? "UNMEASURED: the broker could not be read, so nothing is asserted about protection. An unverifiable state is not treated as protected."
        : managedOpen.length === 0
          ? "No Meridian-managed position is open, so no open position can be missing a stop or a target."
          : lacksStop.length === 0
            ? "Every open Meridian-managed position carries a stop-loss at the broker."
            : "AT LEAST ONE OPEN MERIDIAN POSITION HAS NO STOP-LOSS AT THE BROKER.",
    },
    brokerClosedTrades: {
      measured: closedMeasured,
      readAt: closedRead?.readAt ?? null,
      error: closedRead?.error ?? (closedRead ? null : "no broker read was made"),
      count: brokerClosed.length,
      managedCount: managedBrokerClosed.length,
      realizedPLSum: brokerRealized,
      financingSum: brokerFinancing,
      netOfFinancing: brokerRealized !== null ? Number((brokerRealized + (brokerFinancing ?? 0)).toFixed(2)) : null,
      trades: managedBrokerClosed,
    },
    reconciliation: {
      closedAtBrokerNotInRecord,
      enteredAtBrokerWithoutFillRecord,
      closedInRecordNotAtBroker,
      impliedOpeningBalance,
      note:
        "Broker wins. A trade the broker reports closed that the record never recorded is listed as a gap in the record, with the broker's own P/L. " +
        "Nothing is back-filled into the record to make the two agree.",
    },
    totals: {
      ledgerConfirmedRealizedPL: ledgerRealized,
      ledgerConfirmedFinancing: ledgerFinancing,
      ledgerFinancingUnmeasuredCloses: financingUnmeasured,
    },
    notification: input.notification,
    unmeasured,
    sources: {
      orderRequests: orderRequests.map((o) => o.seq),
      fills: fills.map((f) => f.seq),
      closes: closes.map((c) => c.seq),
      refusals: refusals.map((r) => r.seq),
      errors: errors.map((e) => e.seq),
      openPositions: brokerOk ? "BROKER_READ" : "UNMEASURED",
      account: account.measured ? "BROKER_READ" : "UNMEASURED",
      brokerClosedTrades: closedMeasured ? "BROKER_READ" : "UNMEASURED",
      lastAccountReadSeq: lastAccountRead?.seq ?? null,
    },
    provenance: {
      builtBy: "execution/report.ts",
      recordPath: input.recordPath ?? recordPath(),
      recordIds: { from: recordIdsFrom, to: inWindow.length ? inWindow[inWindow.length - 1]!.seq : null },
      statement:
        "Every figure above is either a record id quoted in `sources` (read from the append-only record) or a live broker read whose " +
        "timestamp is stated. Nothing is estimated. An order request is not a trade: only broker-confirmed fills and broker-reported " +
        "closes are counted as such.",
    },
  };
}

/* ------------------------------------------------------------------- text version */

/** The short human-readable version. Plain sentences; no figure that is not in the JSON. */
export function renderReportText(report: ReportJson): string {
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);
  const acct = report.account;

  add(`# Meridian execution report ${report.reportId}`);
  add();
  add(`Generated ${report.generatedAt} · trigger: ${report.trigger}${report.triggerDetail ? ` (${report.triggerDetail})` : ""}`);
  add(`Reporting window: ${report.window.description}.`);
  add(`Built from the append-only record (${report.ledger.path}), records ${report.ledger.firstSeqInWindow ?? "–"}–${report.ledger.lastSeqInWindow ?? "–"} of ${report.ledger.recordsTotal}.`);
  add();
  add("## What the system is doing");
  add(`Execution mode: ${report.mode.current} (source: ${report.mode.source}). ${report.mode.note}`);
  if (report.mode.automaticAcknowledged) add(`Automatic acknowledged by: ${report.mode.acknowledgedBy ?? "a named acknowledgement"}.`);
  add();
  add("## Account (live broker read)");
  if (acct.measured) {
    add(`NAV ${money(acct.nav)} ${acct.currency ?? ""} · balance ${money(acct.balance)} · unrealised P/L ${money(acct.unrealizedPL)} · open trades ${acct.openTradeCount ?? "unmeasured"} (read at ${acct.readAt}).`);
    if (report.sources.lastAccountReadSeq !== null) {
      const last = report.account.lastRecordedRead;
      add(`Last account read in the record: seq ${report.sources.lastAccountReadSeq} at ${last?.recordedAt ?? "?"} (NAV ${money(last?.nav ?? null)}).`);
    }
  } else {
    add(`UNMEASURED — the broker read failed (${acct.errors.join("; ") || "no detail"}). No NAV, balance or trade count is stated.`);
  }
  add();
  add("## What happened in this window");
  add(`Orders submitted: ${report.counts.orderRequests}${report.sources.orderRequests.length ? ` (records ${report.sources.orderRequests.join(", ")})` : ""}. An order request is not a trade.`);
  add(`Fills confirmed by the broker: ${report.counts.brokerConfirmedFills + report.counts.partialFills}${report.sources.fills.length ? ` (records ${report.sources.fills.join(", ")})` : ""}.`);
  if (report.reconciliation.enteredAtBrokerWithoutFillRecord.length) {
    add(
      `  · The broker reports these closed trades with NO FILL record in our record: ${report.reconciliation.enteredAtBrokerWithoutFillRecord.join(", ")}. ` +
        "Their entry was recorded as RETRY_DECISION/PROTECTED after a dropped response, so the fill count above is lower than the number of trades that actually existed.",
    );
  }
  for (const f of report.fills) {
    add(`  · seq ${f.seq}: ${f.instrument ?? "?"} ${f.units ?? "?"} units filled at ${f.price} (trade ${f.tradeId}, order ${f.orderKey ?? "?"}).`);
  }
  for (const u of report.unconfirmedFillRecords) add(`  · seq ${u.seq}: NOT counted as a fill — ${u.reason}`);
  add(
    `Closes recorded: ${report.counts.closes} (${report.counts.closesBrokerConfirmed} of them carry a broker fill transaction, so their P/L is the broker's)${report.sources.closes.length ? ` (records ${report.sources.closes.join(", ")})` : ""}.`,
  );
  for (const c of report.closes) {
    add(
      `  · seq ${c.seq}: trade ${c.tradeId ?? "?"} ${c.instrument ?? ""} ${c.units ?? ""} units — realised P/L ${money(c.realizedPL)}, financing ${c.financing === null ? "unmeasured" : money(c.financing)}, commission ${c.commission === null ? "unmeasured" : money(c.commission)}${c.brokerConfirmed ? "" : " (no broker fill transaction in the record)"}.`,
    );
  }
  for (const d of report.closeRecordDuplicates) add(`  · seq ${d.seq} (trade ${d.tradeId ?? "?"}): ${d.why}`);
  if (report.counts.refusals === 0) add("Refusals: none.");
  else {
    add(`Refusals: ${report.counts.refusals}${report.sources.refusals.length ? ` (records ${report.sources.refusals.join(", ")})` : ""}.`);
    for (const r of report.refusals) add(`  · seq ${r.seq} ${r.kind} (${r.state ?? "no state"}): ${r.reasons.join("; ")}`);
  }
  if (report.counts.errors === 0) add("Errors: none.");
  else {
    add(`Errors: ${report.counts.errors}${report.sources.errors.length ? ` (records ${report.sources.errors.join(", ")})` : ""}.`);
    for (const e of report.errors) add(`  · seq ${e.seq} ${e.kind}: ${e.message}`);
  }
  add();
  add("## Open Meridian positions");
  if (!report.protection.measured) add(`UNMEASURED — ${report.protection.note}`);
  else if (report.openPositions.length === 0) add(`None. The broker reports no open position at all (read at ${acct.readAt}).`);
  else {
    for (const p of report.openPositions) {
      add(
        `  · trade ${p.tradeId} ${p.instrument} ${p.units ?? "?"} units — stop ${p.stopPrice ?? "NONE"}, target ${p.takeProfitPrice ?? "NONE"}${p.managed ? " (Meridian-managed)" : " (not Meridian's — never adopted)"}.`,
      );
    }
  }
  add(`Protection: ${report.protection.note}`);
  add();
  add("## Closed trades, from the broker's own history");
  if (!report.brokerClosedTrades.measured) {
    add(`UNMEASURED — ${report.brokerClosedTrades.error ?? "the broker read failed"}.`);
  } else {
    add(
      `${report.brokerClosedTrades.managedCount} Meridian closed trade(s) at the broker (read at ${report.brokerClosedTrades.readAt}): realised P/L ${money(report.brokerClosedTrades.realizedPLSum)}, financing ${money(report.brokerClosedTrades.financingSum)}, net ${money(report.brokerClosedTrades.netOfFinancing)}.`,
    );
    for (const t of report.brokerClosedTrades.trades) {
      add(`  · trade ${t.tradeId} ${t.instrument}: realised P/L ${money(t.realizedPL)}, financing ${money(t.financing)}${t.closeTime ? `, closed ${t.closeTime}` : ""}.`);
    }
  }
  if (report.reconciliation.impliedOpeningBalance !== null) {
    add(`Balance minus (realised P/L + financing) = ${money(report.reconciliation.impliedOpeningBalance)} — the implied opening balance of the account.`);
  }
  if (report.reconciliation.closedAtBrokerNotInRecord.length) {
    add(`Gap in OUR record: ${report.reconciliation.closedAtBrokerNotInRecord.length} closed trade(s) have no close record — ${report.reconciliation.closedAtBrokerNotInRecord
      .map((t) => `${t.tradeId} (broker P/L ${money(t.realizedPL)}, financing ${money(t.financing)})`)
      .join("; ")}.`);
  }
  if (report.reconciliation.closedInRecordNotAtBroker.length) {
    add(`Gap at the broker: the record closes ${report.reconciliation.closedInRecordNotAtBroker.map((t) => `trade ${t.tradeId} (seq ${t.seq})`).join(", ")}, which the broker does not list as closed.`);
  }
  add();
  add("## Record integrity");
  add(
    report.ledger.chain.ok
      ? `The hash chain is intact over ${report.ledger.chain.recordCount} records.`
      : `The hash chain is BROKEN at seq ${report.ledger.chain.firstBreakSeq ?? "?"} (line ${report.ledger.chain.firstBreakLine ?? "?"}): ${report.ledger.chain.firstBreakReason ?? "no reason recorded"}. ${report.ledger.chain.explanation}`,
  );
  add();
  add("## Notification");
  add(
    report.notification.delivered
      ? `Delivered by ${report.notification.transport} at ${report.notification.attemptedAt}: ${report.notification.detail}`
      : `${report.notification.detail} (transport: ${report.notification.transportDescription})`,
  );
  add();
  add("## Unmeasured");
  if (report.unmeasured.length === 0) add("Nothing in this report is unmeasured.");
  else for (const u of report.unmeasured) add(`  · ${u}`);
  add();
  add("## Where every number came from");
  add(`Record ids used — orders ${listOrNone(report.sources.orderRequests)}, fills ${listOrNone(report.sources.fills)}, closes ${listOrNone(report.sources.closes)}, refusals ${listOrNone(report.sources.refusals)}, errors ${listOrNone(report.sources.errors)}.`);
  add(
    `Account, open positions and closed trades: ${report.sources.account === "BROKER_READ" ? "live broker read at " + acct.readAt : "unmeasured"}. ${report.provenance.statement}`,
  );
  add();
  return lines.join("\n");
}

function listOrNone(ids: number[]): string {
  return ids.length ? ids.join(", ") : "none";
}

/* ------------------------------------------------------------------- generation */

export type ReportState = {
  lastReportAt: string | null;
  lastReportId: string | null;
  /** The last record seq a report has covered. 0 = nothing covered yet. */
  lastSeqSeen: number;
  intervalHours: number;
  updatedAt: string;
};

export async function readReportState(dir = reportsDir()): Promise<ReportState> {
  try {
    const raw = JSON.parse(await readFile(resolve(dir, "state.json"), "utf8")) as Partial<ReportState>;
    return {
      lastReportAt: raw.lastReportAt ?? null,
      lastReportId: raw.lastReportId ?? null,
      lastSeqSeen: Number.isFinite(Number(raw.lastSeqSeen)) ? Number(raw.lastSeqSeen) : 0,
      intervalHours: Number.isFinite(Number(raw.intervalHours)) ? Number(raw.intervalHours) : 6,
      updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return { lastReportAt: null, lastReportId: null, lastSeqSeen: 0, intervalHours: 6, updatedAt: new Date(0).toISOString() };
  }
}

export type LatestReport = {
  reportId: string;
  generatedAt: string;
  jsonPath: string;
  textPath: string;
  text: string;
  json: ReportJson;
};

/** Read the most recent report, or null when none has been generated yet. */
export async function readLatestReport(dir = reportsDir()): Promise<LatestReport | null> {
  try {
    const jsonText = await readFile(resolve(dir, "latest.json"), "utf8");
    const text = await readFile(resolve(dir, "latest.md"), "utf8");
    const json = JSON.parse(jsonText) as ReportJson;
    return {
      reportId: json.reportId,
      generatedAt: json.generatedAt,
      jsonPath: resolve(dir, "latest.json"),
      textPath: resolve(dir, "latest.md"),
      text,
      json,
    };
  } catch {
    return null;
  }
}

export type GenerateReportOptions = {
  /** The live client. When null, the broker sections are labelled unmeasured rather than guessed. */
  client?: Client | null;
  config: Pick<ExecutionConfig, "mode" | "modeSource" | "automaticAcknowledged" | "acknowledgedBy" | "reportTransport">;
  trigger: ReportTrigger;
  triggerDetail?: string | null;
  now?: Date;
  dir?: string;
  /** Injected by the tests; the default is `none`, which sends nothing. */
  transport?: NotificationTransport;
  log?: (line: string) => void;
  /** Explicit window start (exclusive). Omitted: the last seq the previous report covered. */
  fromSeq?: number;
};

export type GenerateReportResult = {
  report: ReportJson;
  text: string;
  files: { json: string; text: string };
  notification: NotificationResult;
  recordSeq: number | null;
};

/**
 * Read the record and the broker, build the report, write both files, deliver (or record
 * that nothing was sent) and append a REPORT_GENERATED record naming what it was built
 * from.
 *
 * Runs under its own lock so two generators — the watcher and the console — cannot write
 * half-updated state files over each other. The lock is a DIFFERENT file from the ledger's:
 * nesting the ledger lock inside it would deadlock the append that follows.
 */
export async function generateReport(options: GenerateReportOptions): Promise<GenerateReportResult> {
  const dir = options.dir ?? reportsDir();
  const now = options.now ?? new Date();
  await mkdir(dir, { recursive: true });

  return withLedgerLock(resolve(dir, ".report.lock"), async () => {
    const records = await readRecords();
    const chain = await verifyChain();
    const state = await readReportState(dir);

    let broker: ReportBrokerState | null = null;
    if (options.client) {
      const read = await readBrokerState(options.client);
      const closed = await options.client.closedTrades();
      const closedTrades =
        closed && !("transportFailure" in closed) && closed.ok
          ? {
              ok: true,
              readAt: closed.receivedAt,
              error: null as string | null,
              trades: ((closed.body?.trades ?? []) as ReportBrokerClosedTrade[]).map((t) => ({
                id: String(t.id),
                instrument: String(t.instrument),
                realizedPL: String(t.realizedPL ?? "0"),
                financing: String(t.financing ?? "0"),
                openTime: t.openTime,
                closeTime: t.closeTime,
                clientExtensions: t.clientExtensions ?? null,
              })),
            }
          : {
              ok: false,
              readAt: new Date().toISOString(),
              error:
                closed && "transportFailure" in closed
                  ? `closed-trades read failed: ${closed.error}`
                  : `closed-trades read failed: HTTP ${(closed as any)?.status ?? "?"}`,
              trades: [] as ReportBrokerClosedTrade[],
            };
      broker = {
        ok: read.ok,
        readAt: read.readAt,
        errors: read.errors,
        account: read.account
          ? {
              currency: read.account.currency,
              nav: read.account.nav,
              balance: read.account.balance,
              unrealizedPL: read.account.unrealizedPL,
              openTradeCount: read.account.openTradeCount,
              marginAvailable: read.account.marginAvailable,
            }
          : null,
        openTrades: (read.trades ?? []) as ReportBrokerTrade[],
        closedTrades,
      };
    }

    // Delivery first, so its outcome is inside the report and in the record entry.
    const resolved = resolveTransport(options.config.reportTransport);
    const draft = buildReport({
      records: records as LedgerLike[],
      broker,
      config: options.config,
      chain,
      generatedAt: now.toISOString(),
      trigger: options.trigger,
      triggerDetail: options.triggerDetail ?? null,
      fromSeq: options.fromSeq ?? state.lastSeqSeen,
      windowBasis: options.fromSeq !== undefined ? "EXPLICIT" : state.lastSeqSeen > 0 ? "PREVIOUS_REPORT" : "RECORD_START",
      notification: {
        transport: resolved.transport.id,
        transportDescription: resolved.transport.describe(),
        configured: false,
        delivered: false,
        detail: resolved.problem ?? NO_TRANSPORT_DETAIL,
        attemptedAt: now.toISOString(),
      },
      recordPath: recordPath(),
    });

    const text = scrubAccountIds(redact(renderReportText(draft)));
    const notification = await deliverReport(
      {
        reportId: draft.reportId,
        generatedAt: draft.generatedAt,
        subject: `Meridian execution report ${draft.reportId}: ${draft.counts.orderRequests} order request(s), ${draft.counts.brokerConfirmedFills} fill(s), ${draft.counts.refusals} refusal(s), ${draft.counts.errors} error(s)`,
        text,
        json: draft,
      },
      { transport: resolved.transport, log: options.log },
    );
    if (resolved.problem) options.log?.(resolved.problem);

    const report: ReportJson = { ...draft, notification };

    // Write both files atomically: a reader never sees a half-written report.
    const jsonPath = resolve(dir, `${report.reportId}.json`);
    const textPath = resolve(dir, `${report.reportId}.md`);
    const jsonBody = scrubAccountIds(JSON.stringify(report, null, 2));
    const writeAtomic = async (path: string, body: string) => {
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
    };
    await writeAtomic(jsonPath, jsonBody);
    await writeAtomic(textPath, text);
    await writeAtomic(resolve(dir, "latest.json"), jsonBody);
    await writeAtomic(resolve(dir, "latest.md"), text);

    // Append the report's own entry: the record can prove which report was built from what.
    const appended = await appendRecord({
      kind: "REPORT_GENERATED",
      state: notification.delivered ? "DELIVERED" : "GENERATED_NOT_SENT",
      payload: {
        reportId: report.reportId,
        trigger: report.trigger,
        triggerDetail: report.triggerDetail,
        window: { fromSeq: report.window.fromSeq, toSeq: report.window.toSeq, basis: report.window.basis },
        builtFrom: report.sources,
        counts: report.counts,
        chainOk: report.ledger.chain.ok,
        notification,
        files: { json: jsonPath, text: textPath },
      },
    });

    const nextState: ReportState = {
      lastReportAt: report.generatedAt,
      lastReportId: report.reportId,
      lastSeqSeen: report.window.toSeq,
      intervalHours: state.intervalHours,
      updatedAt: new Date().toISOString(),
    };
    await writeAtomic(reportStatePath(dir), JSON.stringify(nextState, null, 2));

    return { report, text, files: { json: jsonPath, text: textPath }, notification, recordSeq: appended.seq };
  });
}

/**
 * Should a report be generated now? Used by the watcher on every cycle.
 *
 *  - immediately when a fill, close, refusal or error has been recorded since the last
 *    report (the events a person would want to hear about while it is still news);
 *  - otherwise on the configured interval, default 6 hours.
 */
export async function reportDue(
  records: LedgerLike[],
  config: Pick<ExecutionConfig, "reportIntervalHours">,
  state: ReportState,
  now: Date = new Date(),
): Promise<{ due: boolean; trigger: ReportTrigger; detail: string | null }> {
  const events = records.filter((r) => r.seq > state.lastSeqSeen && REPORT_TRIGGER_KINDS.has(r.kind));
  if (events.length > 0) {
    const kinds = [...new Set(events.map((e) => e.kind))];
    return {
      due: true,
      trigger: "EVENT",
      detail: `${kinds.join(", ")} at record(s) ${events.map((e) => e.seq).join(", ")}`,
    };
  }
  const intervalHours = Number.isFinite(config.reportIntervalHours) && config.reportIntervalHours > 0 ? config.reportIntervalHours : 6;
  if (!state.lastReportAt) return { due: true, trigger: "SCHEDULED", detail: "no report has been generated yet" };
  const ageMs = now.getTime() - Date.parse(state.lastReportAt);
  if (!Number.isFinite(ageMs)) return { due: true, trigger: "SCHEDULED", detail: "the previous report's timestamp could not be read" };
  if (ageMs >= intervalHours * 3600_000) {
    return { due: true, trigger: "SCHEDULED", detail: `the interval of ${intervalHours}h has elapsed since ${state.lastReportAt}` };
  }
  return { due: false, trigger: "SCHEDULED", detail: null };
}
