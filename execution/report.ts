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

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendRecord, readRecords, recordPath, verifyChain, type ExecutionRecord, type VerifyResult } from "./lib/record.ts";
import { withLedgerLock } from "./lib/ledgerLock.ts";
import { configPath, reportsDir, reportStatePath } from "./lib/paths.ts";
import { redact, type Client } from "./lib/client.ts";
import { MERIDIAN_TAG } from "./lib/engine.ts";
import { readBrokerState } from "./lib/ops.ts";
import { DEFAULT_REPORT_TRANSPORT, readConfigForReport, type ExecutionConfig } from "./lib/config.ts";
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
  basis: "RECORD_START" | "PREVIOUS_REPORT" | "EXPLICIT" | "LEDGER_ROTATION";
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
  /**
   * Why the order existed: INVENTED_RULESET_TEST, CONNECTION_TEST or OWNER_METHOD, taken from
   * the record's own instruction/proposal. Null when the record does not say — never guessed.
   */
  origin: string | null;
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

export type ReportJson = ReportComplete | ReportUnavailable;

/**
 * What is produced when the report CANNOT BE BUILT.
 *
 * It is a report about the failure, not a report with holes in it: it carries the absolute
 * path that was looked for and the reason it could not be read, and it carries NO counts, NO
 * account figures and NO mode — the fields do not exist, so nothing downstream can print a
 * zero or a default where a measurement should be. That shape is the fix for 2026-11-04, when
 * a console report printed `signals-only (source: DEFAULT)`, "0 record(s) from seq 0 to 0" and
 * 0 fills because it had resolved the execution directory from the bundle's own location.
 */
export type ReportUnavailable = {
  reportId: string;
  generatedAt: string;
  trigger: ReportTrigger;
  triggerDetail: string | null;
  status: "UNAVAILABLE";
  /** Every source that could not be read, with the exact path that was looked for. */
  unavailable: Array<{ source: "RECORD" | "CONFIG"; path: string; reason: string }>;
  /** The last complete report, if there is one, so a reader can go and look at it. */
  previousReportId: string | null;
  /** What the report did and did not do: no record was read, nothing was appended, nothing sent. */
  statement: string;
  notification: NotificationResult;
};

export type ReportComplete = {
  reportId: string;
  generatedAt: string;
  trigger: ReportTrigger;
  triggerDetail: string | null;
  status: "OK";
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
    /**
     * The mode as stated by the config file that was read. There is no default here: a
     * report that cannot read the config is an UNAVAILABLE report and has no mode at all.
     */
    current: string;
    source: "CONFIG";
    /** The config file the mode was read from, so a reader can check it. */
    configPath: string;
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

/**
 * The config facts a complete report may state. `modeSource` is pinned to "CONFIG" so a
 * defaulted config cannot be handed to the builder at all: a value that did not come from a
 * file does not describe the system, and the type says so.
 */
export type ReportConfigFacts = Pick<ExecutionConfig, "mode" | "automaticAcknowledged" | "acknowledgedBy"> & {
  modeSource: "CONFIG";
  /** The file the facts were read from. */
  configPath: string;
};

export type BuildReportInput = {
  records: LedgerLike[];
  broker: ReportBrokerState | null;
  config: ReportConfigFacts;
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

/**
 * Money for the text version. Never used for the JSON, which keeps the raw numbers.
 *
 * Two decimals is the normal rendering, but a NON-ZERO amount must never print as zero:
 * trade 52's realised P/L of -0.0021 was rendered "-0.00", which reads as no P/L at all.
 * Anything that would round away at two decimals keeps gaining decimals until two
 * significant digits show (0.0021 -> "0.0021"), and anything too small even for that is
 * written in exponential form, which cannot read as zero either.
 */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unmeasured";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  let decimals = 2;
  if (abs !== 0 && Number(abs.toFixed(2)) === 0) {
    decimals = Math.min(8, -Math.floor(Math.log10(abs)) + 1);
  }
  const fixed = abs.toFixed(decimals);
  if (abs !== 0 && Number(fixed) === 0) return `${sign}${abs.toExponential(2)}`;
  const [whole, fraction] = fixed.split(".");
  // Extra decimals are there to show a small amount is not zero, not to pad it: 0.00010
  // reads as 0.0001, while the two decimals every ordinary amount has are always kept.
  const trimmed = fraction!.length > 2 ? fraction!.replace(/0+$/, "").padEnd(2, "0") : fraction!;
  return `${sign}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${trimmed}`;
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
 * Where a report's window starts, given the last seq the previous report covered.
 *
 * THE ROTATION PROBLEM. The record was rotated on 2026-11-05 (see
 * execution/INCIDENT-2026-11-03-chain-break.md): segment 2 opens at seq 1 with a
 * `LEDGER_ROTATION` checkpoint as its first record, so the seq numbering restarts. A window
 * start carried over from segment 1 (e.g. 2100) names a sequence this record does not have,
 * and comparing the two produced a digest reading "records 2101–560" with a window covering
 * nothing at all — while the state file was advanced to 560 as if all 560 records had been
 * reported.
 *
 * THE RULE. A start beyond the end of the record means the previous report covered a
 * DIFFERENT segment. When the record carries a `LEDGER_ROTATION` checkpoint, the window
 * restarts at that checkpoint: everything before it belongs to the archived segment, and
 * the checkpoint itself is the first record of this one, so it is reported. Without a
 * checkpoint the start is left alone — a record that shrank with no rotation to explain it
 * is an integrity problem, and the report says so instead of quietly re-reporting.
 */
export function resolveWindowStart(
  records: LedgerLike[],
  requestedFromSeq: number,
): { fromSeq: number; reset: { from: number; checkpointSeq: number } | null } {
  const toSeq = records.reduce((max, r) => (r.seq > max ? r.seq : max), 0);
  if (requestedFromSeq <= toSeq) return { fromSeq: requestedFromSeq, reset: null };
  const checkpoint = records.find((r) => r.kind === "LEDGER_ROTATION");
  if (!checkpoint) return { fromSeq: requestedFromSeq, reset: null };
  return { fromSeq: checkpoint.seq - 1, reset: { from: requestedFromSeq, checkpointSeq: checkpoint.seq } };
}

/**
 * Build the report from stored records and a broker read. Pure: no I/O, no clock, no
 * environment. `generateReport` supplies the inputs; the tests supply their own.
 */
export function buildReport(input: BuildReportInput): ReportComplete {
  // Fail closed even at the type boundary: a config that did not come from a file cannot
  // produce a mode. Callers that could not read the config build an UNAVAILABLE report
  // instead (buildUnavailableReport), never a complete one with a defaulted mode.
  if (input.config?.modeSource !== "CONFIG") {
    throw new Error(
      "REFUSED: buildReport was given a config that did not come from a config file (modeSource is not CONFIG), " +
        "so any mode it printed would be an invention. Build an unavailable report instead.",
    );
  }
  const records = [...input.records].sort((a, b) => a.seq - b.seq);
  const requestedFromSeq = input.fromSeq ?? 0;
  const { fromSeq, reset } = resolveWindowStart(records, requestedFromSeq);
  const toSeq = records.length ? records[records.length - 1]!.seq : 0;
  const inWindow = records.filter((r) => r.seq > fromSeq && r.seq <= toSeq);
  const firstInWindow = inWindow[0] ?? null;

  const basis: ReportWindow["basis"] = reset
    ? "LEDGER_ROTATION"
    : (input.windowBasis ?? (fromSeq > 0 ? "PREVIOUS_REPORT" : "RECORD_START"));
  const windowDescription = reset
    ? `records ${fromSeq + 1}–${toSeq} (the window restarted at the LEDGER_ROTATION checkpoint, seq ${reset.checkpointSeq}: ` +
      `the previous report's last record, ${reset.from}, belongs to the segment archived before it)`
    : fromSeq > toSeq
      ? `records ${fromSeq + 1}–${toSeq} — the previous report's last record (${fromSeq}) is BEYOND the end of this record ` +
        `(${toSeq}) and no LEDGER_ROTATION checkpoint explains it, so this window covers nothing`
      : basis === "PREVIOUS_REPORT"
        ? inWindow.length === 0
          ? `no records after the last record the previous report covered (seq ${fromSeq}) — this report covers nothing new`
          : `records ${fromSeq + 1}–${toSeq} (after the last record the previous report covered, ${fromSeq})`
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
        /** Why this order existed, straight from the record. Null when the record does not say. */
        origin: str(p.proposal?.origin),
        recordedAt: r.recordedAt,
        note: "an order REQUEST sent to the broker — not a trade. Only a broker-confirmed fill below is a trade.",
      };
    });

  /* ---- fills: broker-confirmed only ---- */
  // The instrument of a fill is not always on the FILL record itself; the ORDER_REQUESTED
  // record for the same order key always names it. The map is built over the WHOLE record so
  // a fill whose request fell outside this window still resolves.
  //
  // The same map carries the instruction's ORIGIN, so every fill is labelled with why its
  // order existed (INVENTED_RULESET_TEST / CONNECTION_TEST / OWNER_METHOD). INSTRUCTION_RECEIVED
  // is the fallback: it is written before any evaluation, so it survives a request that was
  // refused before a proposal existed.
  const orderInfoByKey = new Map<string, { instrument: string | null; units: string | null; origin: string | null }>();
  for (const r of records) {
    if (!r.orderKey) continue;
    const p = payloadOf(r);
    if (r.kind === "ORDER_REQUESTED") {
      const order = p.request?.body?.order ?? {};
      orderInfoByKey.set(r.orderKey, {
        instrument: str(order.instrument),
        units: str(order.units),
        origin: str(p.proposal?.origin) ?? orderInfoByKey.get(r.orderKey)?.origin ?? null,
      });
    } else if (r.kind === "INSTRUCTION_RECEIVED" && !orderInfoByKey.get(r.orderKey)?.origin) {
      const prior = orderInfoByKey.get(r.orderKey);
      orderInfoByKey.set(r.orderKey, {
        instrument: prior?.instrument ?? null,
        units: prior?.units ?? null,
        origin: str(p.origin ?? p.instruction?.origin),
      });
    }
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
      origin: str(p.origin ?? p.proposal?.origin) ?? orderInfoByKey.get(r.orderKey ?? "")?.origin ?? null,
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
  const account: ReportComplete["account"] = brokerOk && broker!.account
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
    status: "OK",
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
        explanation: input.chain.ok
          ? "The append-only record's hash chain is the proof that no line was altered, and it verifies over all " +
            `${input.chain.recordCount} records of this record. The 2026-11-03 duplicate-writer break is NOT in this record: ` +
            "it is in segment 1, which was archived byte-for-byte at execution/archive/orders.segment-1-2026-11-05.jsonl " +
            "when the record was rotated on 2026-11-05 (execution/INCIDENT-2026-11-03-chain-break.md). It remains broken " +
            "there and was not rewritten."
          : "The append-only record's hash chain is the proof that no line was altered. It is BROKEN at the seq below " +
            "because of the 2026-11-03 duplicate-writer incident (two watchers appended at once); see " +
            "execution/INCIDENT-2026-11-03-chain-break.md. The break is explained in writing and NOT rewritten, so every " +
            "figure after it is reported with that caveat rather than presented as verified.",
      },
    },
    mode: {
      current: input.config.mode,
      source: "CONFIG",
      configPath: input.config.configPath,
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
      netOfFinancing: brokerRealized !== null ? Number((brokerRealized + (brokerFinancing ?? 0)).toFixed(6)) : null,
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
  if (report.status === "UNAVAILABLE") return renderUnavailableText(report);
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);
  const acct = report.account;

  add(`# Meridian execution report ${report.reportId}`);
  add();
  add(`Generated ${report.generatedAt} · trigger: ${report.trigger}${report.triggerDetail ? ` (${report.triggerDetail})` : ""}`);
  add(`Reporting window: ${report.window.description}.`);
  add(
    report.ledger.firstSeqInWindow === null
      ? `Built from the append-only record (${report.ledger.path}): no record in this window; the record holds ${report.ledger.recordsTotal}.`
      : `Built from the append-only record (${report.ledger.path}), records ${report.ledger.firstSeqInWindow}–${report.ledger.lastSeqInWindow} of ${report.ledger.recordsTotal}.`,
  );
  add();
  add("## What the system is doing");
  add(`Execution mode: ${report.mode.current} (source: ${report.mode.source}, read from ${report.mode.configPath}). ${report.mode.note}`);
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
  for (const o of report.orderRequests) {
    add(`  · seq ${o.seq}: ${o.instrument ?? "?"} ${o.units ?? "?"} units — origin ${o.origin ?? "not stated in the record"}.`);
  }
  add(`Fills confirmed by the broker: ${report.counts.brokerConfirmedFills + report.counts.partialFills}${report.sources.fills.length ? ` (records ${report.sources.fills.join(", ")})` : ""}.`);
  if (report.reconciliation.enteredAtBrokerWithoutFillRecord.length) {
    add(
      `  · The broker reports these closed trades with NO FILL record in our record: ${report.reconciliation.enteredAtBrokerWithoutFillRecord.join(", ")}. ` +
        "Their entry was recorded as RETRY_DECISION/PROTECTED after a dropped response, so the fill count above is lower than the number of trades that actually existed.",
    );
  }
  for (const f of report.fills) {
    add(`  · seq ${f.seq}: ${f.instrument ?? "?"} ${f.units ?? "?"} units filled at ${f.price} (trade ${f.tradeId}, order ${f.orderKey ?? "?"}, origin ${f.origin ?? "not stated in the record"}).`);
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

/* ------------------------------------------------------- the notification subject */

/** "2026-11-04 20:41 UTC" — the stamp a subject line carries. */
export function subjectStamp(at: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return at;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * The subject line: what happened first, then when.
 *
 *     Meridian: 2 fills, 1 refusal — 2026-11-04 20:41 UTC
 *
 * A quiet window still sends a message, and the subject says so plainly ("nothing happened"):
 * the owner must hear "nothing happened" as reliably as "something did", or the silence
 * becomes the ambiguous thing. The counts are the report's own, so the subject cannot drift
 * away from the body it belongs to.
 */
export function reportSubject(report: ReportComplete): string {
  const counts = report.counts;
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const fills = counts.brokerConfirmedFills + counts.partialFills;
  if (fills > 0) parts.push(plural(fills, "fill", "fills"));
  if (counts.closes > 0) parts.push(plural(counts.closes, "close", "closes"));
  if (counts.refusals > 0) parts.push(plural(counts.refusals, "refusal", "refusals"));
  if (counts.errors > 0) parts.push(plural(counts.errors, "error", "errors"));
  if (parts.length === 0 && counts.orderRequests > 0) {
    parts.push(`${plural(counts.orderRequests, "order request", "order requests")} (not a fill)`);
  }
  return `Meridian: ${parts.length ? parts.join(", ") : "nothing happened"} — ${subjectStamp(report.generatedAt)}`;
}

/* --------------------------------------------------------- the unavailable report */

/**
 * The report produced when a source it needs cannot be read.
 *
 * It deliberately has no `mode`, no `counts`, no `account` and no P&L, so nothing can print
 * "0" or "signals-only" where a measurement should be. What it does have is the absolute path
 * that was looked for, the reason the read failed, and a plain statement of what was not done.
 */
export function buildUnavailableReport(input: {
  generatedAt: string;
  trigger: ReportTrigger;
  triggerDetail?: string | null;
  unavailable: Array<{ source: "RECORD" | "CONFIG"; path: string; reason: string }>;
  previousReportId?: string | null;
  notification: NotificationResult;
}): ReportUnavailable {
  return {
    reportId: newReportId(new Date(input.generatedAt)),
    generatedAt: input.generatedAt,
    trigger: input.trigger,
    triggerDetail: input.triggerDetail ?? null,
    status: "UNAVAILABLE",
    unavailable: input.unavailable,
    previousReportId: input.previousReportId ?? null,
    statement:
      "This report could not be built, so it states no execution mode, no record count, no fill count and no P&L. " +
      "Those figures would have had to be invented, and a report that misstates the execution mode is worse than no " +
      "report. Nothing was appended to the record, the report scheduler's window was NOT advanced, and nothing was sent.",
    notification: input.notification,
  };
}

function renderUnavailableText(report: ReportUnavailable): string {
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);
  add(`# Meridian execution report ${report.reportId} — UNAVAILABLE`);
  add();
  add(`Generated ${report.generatedAt} · trigger: ${report.trigger}${report.triggerDetail ? ` (${report.triggerDetail})` : ""}`);
  add();
  add("## This report could not be built");
  for (const u of report.unavailable) {
    add(`  · ${u.source === "RECORD" ? "the append-only record" : "the execution config"} at ${u.path} — ${u.reason}`);
  }
  add();
  add(report.statement);
  // Say what is unknown, and never a value in its place. The word for the setting is
  // deliberately not printed with any value beside it: there is no default to fall back to.
  const recordGone = report.unavailable.some((u) => u.source === "RECORD");
  const configGone = report.unavailable.some((u) => u.source === "CONFIG");
  if (configGone) {
    add(
      "Because no config file could be read, what the system is set to do is UNKNOWN here. No default is printed in its place: " +
        "a default would be a claim about this account that nothing supports.",
    );
  }
  if (recordGone) {
    add("Because no record could be read, no count, no fill and no P&L is stated anywhere in this document.");
  }
  if (report.previousReportId) add(`The most recent complete report is ${report.previousReportId}, in the same directory as this file.`);
  add();
  add("## Notification");
  add(
    report.notification.delivered
      ? `Delivered by ${report.notification.transport} at ${report.notification.attemptedAt}: ${report.notification.detail}`
      : `${report.notification.detail} (transport: ${report.notification.transportDescription})`,
  );
  add();
  return lines.join("\n");
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

/**
 * Read the most recent report, or null when none has been generated yet.
 *
 * Kept for callers that only need "is there one". It says nothing about WHY there is none;
 * anything that shows the answer to a reader uses `readLatestReportResult`, which
 * distinguishes "the reports directory holds no report yet" from "it could not be read" and
 * names the path either way.
 */
export async function readLatestReport(dir = reportsDir()): Promise<LatestReport | null> {
  const result = await readLatestReportResult(dir);
  return result.found ? result.report : null;
}

/** The outcome of looking for the newest report, with the path that was looked in. */
export type LatestReportResult =
  | { found: true; report: LatestReport }
  | { found: false; path: string; reason: "NOT_GENERATED_YET" | "UNREADABLE"; detail: string };

/**
 * Look for the newest report in a directory and say exactly what happened.
 *
 * The console's "show latest report" used to answer "no report has been generated yet" for
 * every failure, including reading the wrong directory — while the watcher's real reports sat
 * in the right one. A reader is now told which directory was searched and, when the answer is
 * not simply "nothing there", what was wrong with it.
 */
export async function readLatestReportResult(dir = reportsDir()): Promise<LatestReportResult> {
  const jsonPath = resolve(dir, "latest.json");
  const textPath = resolve(dir, "latest.md");
  let jsonText: string;
  try {
    jsonText = await readFile(jsonPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      found: false,
      path: jsonPath,
      reason: code === "ENOENT" ? "NOT_GENERATED_YET" : "UNREADABLE",
      detail:
        code === "ENOENT"
          ? "no report has been written there yet"
          : `the report file could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  let json: ReportJson;
  try {
    json = JSON.parse(jsonText) as ReportJson;
  } catch (error) {
    return {
      found: false,
      path: jsonPath,
      reason: "UNREADABLE",
      detail: `the report file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  let text: string;
  try {
    text = await readFile(textPath, "utf8");
  } catch (error) {
    return {
      found: false,
      path: textPath,
      reason: "UNREADABLE",
      detail: `the report's text file is missing or unreadable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return {
    found: true,
    report: { reportId: json.reportId, generatedAt: json.generatedAt, jsonPath, textPath, text, json },
  };
}

export type GenerateReportOptions = {
  /** The live client. When null, the broker sections are labelled unmeasured rather than guessed. */
  client?: Client | null;
  /**
   * The config, ONLY as read from a config file. Omitted entirely: `generateReport` reads it
   * itself with `readConfigForReport()` and produces an UNAVAILABLE report if it cannot.
   * A config carrying `modeSource: "DEFAULT"` is refused for the same reason: it did not come
   * from a file, so it does not describe the system.
   */
  config?: Pick<ExecutionConfig, "mode" | "modeSource" | "automaticAcknowledged" | "acknowledgedBy" | "reportTransport"> | null;
  /** A config read the caller already attempted and that FAILED, with its path and reason. */
  configUnavailable?: { path: string; reason: string } | null;
  /** The config file the facts came from. Defaults to the one absolute config path. */
  configPath?: string;
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
 * FAILS CLOSED. If the config cannot be read, or the record cannot be read, the result is an
 * UNAVAILABLE report that names both paths and states no mode, no count and no P&L. In that
 * case nothing is appended to the record and the scheduler's window is NOT advanced, so the
 * next complete report still covers everything since the last complete one.
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
    /* ---- the two inputs that must be readable, or the report says why it is not ---- */
    const unavailable: Array<{ source: "RECORD" | "CONFIG"; path: string; reason: string }> = [];

    let configFacts: ReportConfigFacts | null = null;
    let transportName = DEFAULT_REPORT_TRANSPORT;
    const lookedForConfigPath = options.configPath ?? configPath();
    if (options.configUnavailable) {
      unavailable.push({ source: "CONFIG", path: options.configUnavailable.path, reason: options.configUnavailable.reason });
    } else if (options.config) {
      if (options.config.modeSource !== "CONFIG") {
        unavailable.push({
          source: "CONFIG",
          path: lookedForConfigPath,
          reason:
            "the config supplied did not come from a config file (modeSource is \"DEFAULT\"), so it does not describe this " +
            "account's execution setting; no mode is printed in its place",
        });
      } else {
        configFacts = {
          mode: options.config.mode,
          modeSource: "CONFIG",
          configPath: lookedForConfigPath,
          automaticAcknowledged: options.config.automaticAcknowledged,
          acknowledgedBy: options.config.acknowledgedBy,
        };
        transportName = options.config.reportTransport;
      }
    } else {
      const read = await readConfigForReport(lookedForConfigPath);
      if (read.ok) {
        configFacts = {
          mode: read.config.mode,
          modeSource: "CONFIG",
          configPath: read.path,
          automaticAcknowledged: read.config.automaticAcknowledged,
          acknowledgedBy: read.config.acknowledgedBy,
        };
        transportName = read.config.reportTransport;
      } else {
        unavailable.push({ source: "CONFIG", path: read.path, reason: read.reason });
      }
    }

    const recordFile = recordPath();
    let records: ExecutionRecord[] | null = null;
    let chain: VerifyResult | null = null;
    try {
      // readRecords() returns [] for a missing file, which is indistinguishable from an empty
      // record. A report must never present "I could not find it" as "there are none", so the
      // file is checked for existence first and its absence is a named failure.
      const info = await stat(recordFile);
      if (!info.isFile()) {
        unavailable.push({ source: "RECORD", path: recordFile, reason: "the path exists but is not a regular file" });
      } else {
        records = await readRecords(recordFile);
        chain = await verifyChain(recordFile);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      unavailable.push({
        source: "RECORD",
        path: recordFile,
        reason:
          code === "ENOENT"
            ? "the record file does not exist at that path"
            : `the record could not be read (${error instanceof Error ? error.message : String(error)})`,
      });
    }

    const state = await readReportState(dir);
    const previous = await readLatestReportResult(dir);
    const previousReportId = previous.found ? previous.report.reportId : null;

    const resolvedTransport = resolveTransport(transportName);
    const notSent = (detail: string): NotificationResult => ({
      transport: resolvedTransport.transport.id,
      transportDescription: resolvedTransport.transport.describe(),
      configured: false,
      delivered: false,
      detail,
      attemptedAt: now.toISOString(),
    });

    if (unavailable.length > 0 || records === null || chain === null || configFacts === null) {
      const report = buildUnavailableReport({
        generatedAt: now.toISOString(),
        trigger: options.trigger,
        triggerDetail: options.triggerDetail ?? null,
        unavailable,
        previousReportId,
        notification: notSent(
          "this report could not be built, so it is written to the reports directory only and nothing was sent anywhere",
        ),
      });
      const text = scrubAccountIds(redact(renderReportText(report)));
      const jsonBody = scrubAccountIds(JSON.stringify(report, null, 2));
      const jsonPath = resolve(dir, `${report.reportId}.json`);
      const textPath = resolve(dir, `${report.reportId}.md`);
      const writeAtomic = async (path: string, body: string) => {
        const tmp = `${path}.tmp-${process.pid}`;
        await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, path);
      };
      await writeAtomic(jsonPath, jsonBody);
      await writeAtomic(textPath, text);
      await writeAtomic(resolve(dir, "latest.json"), jsonBody);
      await writeAtomic(resolve(dir, "latest.md"), text);
      // No REPORT_GENERATED append (the record may be exactly what could not be read) and no
      // state.json update (the window must not move past records no report has covered).
      for (const u of unavailable) options.log?.(`report UNAVAILABLE: ${u.source} at ${u.path} — ${u.reason}`);
      return { report, text, files: { json: jsonPath, text: textPath }, notification: report.notification, recordSeq: null };
    }

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
    const resolved = resolvedTransport;
    const draft = buildReport({
      records: records as LedgerLike[],
      broker,
      config: configFacts,
      chain,
      generatedAt: now.toISOString(),
      trigger: options.trigger,
      triggerDetail: options.triggerDetail ?? null,
      fromSeq: options.fromSeq ?? state.lastSeqSeen,
      windowBasis: options.fromSeq !== undefined ? "EXPLICIT" : state.lastSeqSeen > 0 ? "PREVIOUS_REPORT" : "RECORD_START",
      // The draft is rendered BEFORE delivery, so its notification line must not pretend the
      // send already failed. When a transport is configured the line says the report is being
      // handed over now and where the outcome is recorded; when it is not, the line is the
      // exact sentence for that case (or the transport's own list of missing settings).
      notification: {
        transport: resolved.transport.id,
        transportDescription: resolved.transport.describe(),
        configured: false,
        delivered: false,
        detail:
          resolved.problem ??
          (resolved.transport.configured()
            ? "this report is handed to the transport immediately after it is written; the delivery outcome is recorded in the stored copy and in the record"
            : (resolved.transport.unconfiguredDetail?.() ?? NO_TRANSPORT_DETAIL)),
        attemptedAt: now.toISOString(),
      },
      recordPath: recordFile,
    });

    const text = scrubAccountIds(redact(renderReportText(draft)));
    const notification = await deliverReport(
      {
        reportId: draft.reportId,
        generatedAt: draft.generatedAt,
        // What happened first, then when — the one line the owner sees in a list of mail.
        subject: reportSubject(draft),
        text,
        json: draft,
      },
      { transport: resolved.transport, log: options.log },
    );
    if (resolved.problem) options.log?.(resolved.problem);

    const report: ReportComplete = { ...draft, notification };

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
  // The same window rule as the report itself: after a rotation the last seq the previous
  // report covered belongs to the archived segment, and comparing it with this record's
  // seqs found no events at all — so an event-triggered report could never fire again.
  const { fromSeq } = resolveWindowStart(records, state.lastSeqSeen);
  const events = records.filter((r) => r.seq > fromSeq && REPORT_TRIGGER_KINDS.has(r.kind));
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
