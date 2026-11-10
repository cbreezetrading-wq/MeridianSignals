/**
 * Tests for the execution report, the notification seam and the console's report endpoint.
 *
 * These are the properties that matter, and each one is a test rather than a comment:
 *
 *  - an order request is NOT a trade: only a broker-confirmed fill is counted as a fill;
 *  - a FILL-kind record without the broker's trade id and price is listed as unconfirmed
 *    and never counted;
 *  - refusals carry their named reason, errors carry their message, and both name the record
 *    id they came from;
 *  - an open position with no stop-loss is reported as unprotected, and an unreadable broker
 *    is reported as UNMEASURED rather than as "protected";
 *  - with no notification channel configured the exact sentence
 *    "no notification channel configured — report generated, nothing sent" appears in the
 *    report and in the log, and `delivered` is false — always;
 *  - the console endpoint answers 401 without the operator key and 200 with it, and a
 *    refusal discloses nothing about the account or the record;
 *  - a broken hash chain is stated as broken, with the seq, not smoothed over;
 *  - no account id and no credential can reach the report.
 */

import { isolate } from "./isolate.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "../lib/client.ts";
import { parseConfig, DEFAULT_REPORT_INTERVAL_HOURS } from "../lib/config.ts";
import { buildReport, generateReport, money, readLatestReport, readReportState, renderReportText, reportDue, resolveWindowStart, scrubAccountIds, type LedgerLike, type ReportBrokerState } from "../report.ts";
import { deliverReport, NO_TRANSPORT_DETAIL, registerTransport, resolveTransport, type NotificationTransport } from "../notify.ts";
import { authorizeOperatorKey, handleReportAction } from "../lib/reportApi.ts";
import { readRecords } from "../lib/record.ts";
import { appendRecord } from "../lib/record.ts";

// This file's own temporary execution directory: lib/paths.ts resolves at call time, so the
// whole file — including generateReport's file writes and its REPORT_GENERATED append — stays
// off the live record and out of the live reports directory.
const dir = isolate();

const ACCOUNT_ID_IN_A_RECORD = "101-001-25538627-001";

/* ------------------------------------------------------------------ fixtures */

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 4, 1, minute, 0)).toISOString();

/** A ledger with one request, one broker-confirmed fill, one refusal, one error, one close. */
function ledger(): LedgerLike[] {
  return [
    {
      seq: 1,
      recordedAt: at(0),
      kind: "ORDER_REQUESTED",
      signalId: "sig-1",
      orderKey: "msig-aaa",
      state: "REQUESTED",
      payload: { request: { method: "POST", path: `/v3/accounts/${ACCOUNT_ID_IN_A_RECORD}/orders`, body: { order: { type: "MARKET", instrument: "EUR_USD", units: "-10000" } } } },
    },
    {
      seq: 2,
      recordedAt: at(1),
      kind: "FILL",
      signalId: "sig-1",
      orderKey: "msig-aaa",
      state: "FILLED",
      payload: { orderId: "11", tradeId: "111", transactionId: "111", units: "-10000", price: "1.10050", pl: "0.0000" },
    },
    {
      seq: 3,
      recordedAt: at(2),
      kind: "VALIDATION_REFUSED",
      signalId: "sig-2",
      orderKey: "msig-bbb",
      state: "REFUSED_GUARD",
      payload: { reasons: ["GUARD_MAX_POSITIONS: 1 Meridian-managed position(s) open, maxPositions is 1"] },
    },
    {
      seq: 4,
      recordedAt: at(3),
      kind: "CONNECTION_FAILURE",
      signalId: "sig-3",
      orderKey: "msig-ccc",
      state: "UNAVAILABLE",
      payload: { error: "TypeError: read ECONNRESET (simulated drop)" },
    },
    {
      seq: 5,
      recordedAt: at(4),
      kind: "CLOSED",
      orderKey: "msig-aaa",
      state: "CLOSED",
      payload: {
        control: "close-managed",
        tradeId: "111",
        instrument: "EUR_USD",
        units: "-10000",
        realizedPL: -12.5,
        transactionId: "112",
        brokerResponse: { orderFillTransaction: { id: "112", pl: "-12.5", financing: "-0.42", commission: "0.0000", price: "1.10175" } },
      },
    },
    // A repair re-recording the same close: it must not be counted twice.
    {
      seq: 6,
      recordedAt: at(5),
      kind: "CLOSED",
      orderKey: "msig-aaa",
      state: "CLOSED",
      payload: { control: "close-managed", tradeId: "111", instrument: "EUR_USD", realizedPL: -12.5, transactionId: "112" },
    },
  ];
}

function broker(overrides: Partial<ReportBrokerState> = {}): ReportBrokerState {
  return {
    ok: true,
    readAt: at(10),
    errors: [],
    account: { currency: "USD", nav: 100585.24, balance: 100585.24, unrealizedPL: 0, openTradeCount: 1 },
    openTrades: [
      // No stopLossOrder: an unprotected Meridian position.
      { id: "222", instrument: "GBP_USD", currentUnits: "-5000", price: "1.3000", clientExtensions: { id: "msig-ddd", tag: "MERIDIAN-PRACTICE-TEST" } },
    ],
    closedTrades: {
      ok: true,
      readAt: at(10),
      error: null,
      trades: [
        { id: "111", instrument: "EUR_USD", realizedPL: "-12.5", financing: "-0.42", clientExtensions: { id: "msig-aaa", tag: "MERIDIAN-PRACTICE-TEST" } },
      ],
    },
    ...overrides,
  };
}

/**
 * The config as a COMPLETE report may state it: read from a file, with the path it came from.
 * `modeSource` is "CONFIG" because that is what the file says; a defaulted config is refused
 * by buildReport and produces an UNAVAILABLE report from generateReport.
 */
const parsed = parseConfig({ mode: "automatic", automaticAcknowledged: true, acknowledgedBy: "test acknowledgement", report: { intervalHours: 6 } });
const config = { ...parsed, modeSource: "CONFIG" as const, configPath: join(dir, "config.json") };

const noNotification = {
  transport: "none",
  transportDescription: "none",
  configured: false,
  delivered: false,
  detail: NO_TRANSPORT_DETAIL,
  attemptedAt: at(10),
};

const goodChain = { ok: true, recordCount: 6, firstBreak: null };

/* ------------------------------------------------------------------ the builder */

test("an order request is not a trade: only the broker-confirmed fill is a fill", () => {
  const report = buildReport({
    records: ledger(),
    broker: broker(),
    config,
    chain: goodChain,
    notification: noNotification,
    generatedAt: at(10),
    trigger: "EVENT",
    triggerDetail: "FILL at record 2",
  });

  assert.equal(report.counts.orderRequests, 1, "one order request");
  assert.equal(report.counts.brokerConfirmedFills, 1, "one broker-confirmed fill");
  assert.equal(report.fills.length, 1);
  assert.equal(report.fills[0]!.seq, 2);
  assert.equal(report.fills[0]!.tradeId, "111");
  assert.equal(report.fills[0]!.brokerConfirmed, true);
  assert.deepEqual(report.sources.fills, [2]);
  assert.deepEqual(report.sources.orderRequests, [1]);

  // The refusal carries its named reason and the error its message, each with its record id.
  assert.equal(report.counts.refusals, 1);
  assert.deepEqual(report.sources.refusals, [3]);
  assert.match(report.refusals[0]!.reasons[0]!, /GUARD_MAX_POSITIONS/);
  assert.equal(report.counts.errors, 1);
  assert.deepEqual(report.sources.errors, [4]);
  assert.match(report.errors[0]!.message, /ECONNRESET/);

  // The close carries broker-confirmed P/L and financing; the repeat is not counted twice.
  assert.equal(report.closes.length, 1);
  assert.equal(report.closes[0]!.seq, 5);
  assert.equal(report.closes[0]!.realizedPL, -12.5);
  assert.equal(report.closes[0]!.financing, -0.42);
  assert.equal(report.closes[0]!.brokerConfirmed, true);
  assert.equal(report.closeRecordDuplicates.length, 1);
  assert.equal(report.closeRecordDuplicates[0]!.seq, 6);
  assert.equal(report.totals.ledgerConfirmedRealizedPL, -12.5);
  assert.equal(report.totals.ledgerConfirmedFinancing, -0.42);

  // An open Meridian position with no stop is UNPROTECTED, and it says so.
  assert.equal(report.protection.measured, true);
  assert.equal(report.protection.managedOpenCount, 1);
  assert.equal(report.protection.anyLacksStop, true);
  assert.deepEqual(report.protection.lacksStop.map((p) => p.tradeId), ["222"]);

  // Account figures come from the broker read and are labelled with its timestamp.
  assert.equal(report.account.measured, true);
  assert.equal(report.account.nav, 100585.24);
  assert.equal(report.account.readAt, at(10));

  // The broker's closed-trade history, and the gap it reveals in the record.
  assert.equal(report.brokerClosedTrades.measured, true);
  assert.equal(report.brokerClosedTrades.managedCount, 1);
  assert.equal(report.brokerClosedTrades.realizedPLSum, -12.5);
  assert.equal(report.brokerClosedTrades.financingSum, -0.42);
  assert.equal(report.reconciliation.closedAtBrokerNotInRecord.length, 0);
  assert.deepEqual(report.reconciliation.enteredAtBrokerWithoutFillRecord, [], "trade 111 has a FILL record, so there is no entry gap");
  assert.equal(report.counts.closesBrokerConfirmed, 1);
  assert.equal(report.reconciliation.impliedOpeningBalance, 100598.16);
});

test("the text version states every event with the record id it came from", () => {
  const report = buildReport({
    records: ledger(),
    broker: broker(),
    config,
    chain: goodChain,
    notification: noNotification,
    generatedAt: at(10),
    trigger: "EVENT",
  });
  const text = renderReportText(report);

  assert.match(text, /Execution mode: automatic/);
  assert.match(text, /Orders submitted: 1 \(records 1\)\. An order request is not a trade\./);
  assert.match(text, /Fills confirmed by the broker: 1 \(records 2\)\./);
  assert.match(text, /seq 2: EUR_USD -10000 units filled at 1\.10050 \(trade 111, order msig-aaa, origin not stated in the record\)/);
  assert.match(text, /Refusals: 1 \(records 3\)/);
  assert.match(text, /GUARD_MAX_POSITIONS/);
  assert.match(text, /Errors: 1 \(records 4\)/);
  assert.match(text, /ECONNRESET/);
  assert.match(text, /realised P\/L -12\.50, financing -0\.42/);
  assert.match(text, /AT LEAST ONE OPEN MERIDIAN POSITION HAS NO STOP-LOSS AT THE BROKER/);
  assert.match(text, /NAV 100,585\.24 USD/);
  // Nothing was sent, and the text says so in the exact words.
  assert.ok(text.includes(NO_TRANSPORT_DETAIL), "the exact 'nothing sent' sentence must appear in the report");
  // The account id that appears in the raw record must not appear in the rendered report.
  assert.equal(text.includes(ACCOUNT_ID_IN_A_RECORD), false, "an account id must never reach the report");
});

/**
 * The origin label reaches the report. A CONNECTION_TEST order must be readable as such, and
 * must not be readable as the invented ruleset trading — the two are different strings in the
 * record and must stay different strings in the text a person reads.
 */
test("every fill and order request is labelled with its origin, and the two labels differ", () => {
  function withOrigin(origin: string): LedgerLike[] {
    return [
      {
        seq: 1,
        recordedAt: at(0),
        kind: "ORDER_REQUESTED",
        signalId: "sig-1",
        orderKey: "msig-aaa",
        state: "REQUESTED",
        payload: { proposal: { origin }, request: { body: { order: { type: "MARKET", instrument: "EUR_USD", units: "1" } } } },
      },
      {
        seq: 2,
        recordedAt: at(1),
        kind: "FILL",
        signalId: "sig-1",
        orderKey: "msig-aaa",
        state: "FILLED",
        payload: { tradeId: "111", units: "1", price: "1.10050" },
      },
    ];
  }
  const build = (origin: string) =>
    buildReport({
      records: withOrigin(origin),
      broker: broker({ openTrades: [] }),
      config,
      chain: { ok: true, recordCount: 2, firstBreak: null },
      notification: noNotification,
      generatedAt: at(10),
      trigger: "EVENT",
    });

  const connection = build("CONNECTION_TEST");
  const ruleset = build("INVENTED_RULESET_TEST");
  const connectionText = renderReportText(connection);
  const rulesetText = renderReportText(ruleset);

  assert.equal(connection.fills[0]!.origin, "CONNECTION_TEST");
  assert.equal(ruleset.fills[0]!.origin, "INVENTED_RULESET_TEST");
  assert.match(connectionText, /seq 1: EUR_USD 1 units — origin CONNECTION_TEST\./);
  assert.match(connectionText, /origin CONNECTION_TEST\)\./);
  assert.match(rulesetText, /seq 1: EUR_USD 1 units — origin INVENTED_RULESET_TEST\./);
  assert.equal(connectionText.includes("INVENTED_RULESET_TEST"), false, "a connection test must never read as the ruleset trading");
});

test("a FILL-kind record without the broker's confirmation is never counted as a fill", () => {
  const records: LedgerLike[] = [
    { seq: 1, recordedAt: at(0), kind: "ORDER_REQUESTED", orderKey: "msig-x", state: "REQUESTED", payload: { request: { body: { order: { instrument: "AUD_USD", units: "1000" } } } } },
    { seq: 2, recordedAt: at(1), kind: "FILL", orderKey: "msig-x", state: "FILLED", payload: { note: "the broker's reply was lost; no trade id or fill price was recorded" } },
  ];
  const report = buildReport({ records, broker: broker({ openTrades: [] }), config, chain: { ok: true, recordCount: 2, firstBreak: null }, notification: noNotification, generatedAt: at(2), trigger: "EVENT" });
  const text = renderReportText(report);

  assert.equal(report.fills.length, 0, "no broker confirmation means no fill");
  assert.equal(report.counts.brokerConfirmedFills, 0);
  assert.equal(report.unconfirmedFillRecords.length, 1);
  assert.equal(report.unconfirmedFillRecords[0]!.seq, 2);
  assert.match(text, /Fills confirmed by the broker: 0/);
  assert.match(text, /seq 2: NOT counted as a fill/);
  assert.match(text, /Orders submitted: 1/);
});

test("an unreadable broker is UNMEASURED, never zero and never 'protected'", () => {
  const report = buildReport({ records: ledger(), broker: null, config, chain: goodChain, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  const text = renderReportText(report);

  assert.equal(report.account.measured, false);
  assert.equal(report.account.nav, null);
  assert.equal(report.account.balance, null);
  assert.equal(report.protection.measured, false);
  assert.equal(report.protection.anyLacksStop, null, "protection must not be asserted when the broker could not be read");
  assert.equal(report.brokerClosedTrades.measured, false);
  assert.equal(report.reconciliation.impliedOpeningBalance, null);
  assert.ok(report.unmeasured.length >= 3);
  assert.match(text, /UNMEASURED/);
  assert.equal(/NAV [\d,]/.test(text), false, "no NAV figure may be printed when it was not read");
});

test("a broken hash chain is stated as broken, with its seq", () => {
  const report = buildReport({
    records: ledger(),
    broker: broker(),
    config,
    chain: { ok: false, recordCount: 6, firstBreak: { line: 1417, seq: 1417, reason: "seq 1417 is not the expected 1418" } },
    notification: noNotification,
    generatedAt: at(10),
    trigger: "SCHEDULED",
  });
  const text = renderReportText(report);
  assert.equal(report.ledger.chain.ok, false);
  assert.equal(report.ledger.chain.firstBreakSeq, 1417);
  assert.match(text, /hash chain is BROKEN at seq 1417/);
  assert.ok(report.unmeasured.some((u) => u.includes("BROKEN at seq 1417")));
});

/* ------------------------------------------------------- after the ledger rotation */

/**
 * A record as it looks after the 2026-11-05 rotation: seq numbering restarts at 1 with a
 * `LEDGER_ROTATION` checkpoint as the first record. The seqs below are the real ones — the
 * previous report's window came from segment 1 and ended at 2100.
 */
function rotatedLedger(): LedgerLike[] {
  return [
    { seq: 1, recordedAt: at(0), kind: "LEDGER_ROTATION", state: "SEGMENT_OPEN", payload: { segment: 2, previousSegment: { segment: 1, lastSeq: 2176 } } },
    { seq: 2, recordedAt: at(1), kind: "ORDER_REQUESTED", orderKey: "msig-aaa", state: "REQUESTED", payload: { request: { body: { order: { type: "MARKET", instrument: "EUR_USD", units: "1" } } }, proposal: { origin: "CONNECTION_TEST" } } },
    { seq: 3, recordedAt: at(2), kind: "FILL", orderKey: "msig-aaa", state: "FILLED", payload: { tradeId: "52", instrument: "EUR_USD", units: "1", price: "1.12180" } },
    {
      seq: 4,
      recordedAt: at(3),
      kind: "CLOSED",
      orderKey: "msig-aaa",
      state: "CLOSED",
      payload: {
        tradeId: "52",
        instrument: "EUR_USD",
        units: "1",
        realizedPL: -0.0021,
        transactionId: "9",
        brokerResponse: { orderFillTransaction: { id: "9", pl: "-0.0021", financing: "0.0000", commission: "0.0000" } },
      },
    },
  ];
}

test("a window start left over from the archived segment restarts at the LEDGER_ROTATION checkpoint", () => {
  const report = buildReport({
    records: rotatedLedger(),
    broker: broker(),
    config,
    chain: { ok: true, recordCount: 4, firstBreak: null },
    notification: noNotification,
    generatedAt: at(10),
    trigger: "SCHEDULED",
    fromSeq: 2100,
    windowBasis: "PREVIOUS_REPORT",
  });
  const text = renderReportText(report);

  assert.equal(report.window.basis, "LEDGER_ROTATION");
  assert.equal(report.window.fromSeq, 0, "the window starts at the checkpoint, which is seq 1");
  assert.equal(report.window.toSeq, 4);
  assert.match(report.window.description, /restarted at the LEDGER_ROTATION checkpoint, seq 1/);
  assert.equal(report.ledger.recordsInWindow, 4, "every record of the current segment is in the window");
  assert.equal(report.ledger.firstSeqInWindow, 1);
  assert.equal(report.ledger.lastSeqInWindow, 4);

  // The nonsense this replaced: "records 2101–4" with a window covering nothing.
  assert.doesNotMatch(text, /2101/);
  assert.doesNotMatch(text, /records ––– of/);
  assert.match(text, /records 1–4 of 4/);
  // The records that were never reported are now counted, not skipped.
  assert.equal(report.counts.brokerConfirmedFills, 1);
  assert.equal(report.counts.closes, 1);
});

test("a window start beyond the end of the record with no rotation is stated, not quietly re-reported", () => {
  const report = buildReport({
    records: ledger(),
    broker: broker(),
    config,
    chain: goodChain,
    notification: noNotification,
    generatedAt: at(10),
    trigger: "SCHEDULED",
    fromSeq: 2100,
  });
  assert.equal(report.window.basis, "PREVIOUS_REPORT");
  assert.equal(report.ledger.recordsInWindow, 0);
  assert.match(report.window.description, /BEYOND the end of this record \(6\) and no LEDGER_ROTATION checkpoint explains it/);
});

test("a window with nothing new says so, instead of printing a range that runs backwards", () => {
  const report = buildReport({ records: ledger(), broker: broker(), config, chain: goodChain, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED", fromSeq: 6 });
  assert.equal(report.ledger.recordsInWindow, 0);
  assert.match(report.window.description, /this report covers nothing new/);
  const text = renderReportText(report);
  assert.doesNotMatch(text, /records 7–6/);
  assert.doesNotMatch(text, /records ––– of/);
  assert.match(text, /no record in this window; the record holds 6/);
});

test("an event after a rotation makes a report due, though the previous window came from segment 1", async () => {
  const state = { lastReportAt: at(0), lastReportId: "rpt-a", lastSeqSeen: 2100, intervalHours: 6, updatedAt: at(0) };
  const due = await reportDue(rotatedLedger(), { reportIntervalHours: 6 }, state, new Date(Date.parse(at(0)) + 60_000));
  assert.equal(due.due, true);
  assert.equal(due.trigger, "EVENT");
  assert.match(due.detail ?? "", /FILL/);
  // And the window the report will cover is the whole current segment, not nothing.
  assert.deepEqual(resolveWindowStart(rotatedLedger(), 2100), { fromSeq: 0, reset: { from: 2100, checkpointSeq: 1 } });
  // Without a rotation the start is left exactly as it was.
  assert.deepEqual(resolveWindowStart(ledger(), 3), { fromSeq: 3, reset: null });
});

test("a small non-zero amount never renders as zero", () => {
  assert.equal(money(-0.0021), "-0.0021", "trade 52's realised P/L, which read -0.00");
  assert.equal(money(0.0021), "0.0021");
  assert.equal(money(0), "0.00");
  assert.equal(money(-12.5), "-12.50");
  assert.equal(money(-0.42), "-0.42");
  assert.equal(money(100585.24), "100,585.24");
  assert.equal(money(0.0001), "0.0001");
  assert.equal(money(null), "unmeasured");
  assert.notEqual(money(1e-9), "0.00", "even an amount below the decimal cap must not read as zero");

  const report = buildReport({ records: rotatedLedger(), broker: broker(), config, chain: { ok: true, recordCount: 4, firstBreak: null }, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  assert.match(renderReportText(report), /trade 52 EUR_USD 1 units — realised P\/L -0\.0021/);

  // The broker's own totals: a net of -0.0022 must not be rounded to "0.00" either.
  const tinyBroker = broker({
    closedTrades: { ok: true, readAt: at(10), error: null, trades: [{ id: "52", instrument: "EUR_USD", realizedPL: "-0.0021", financing: "-0.0001", clientExtensions: { id: "msig-aaa", tag: "MERIDIAN-PRACTICE-TEST" } }] },
  });
  const tiny = buildReport({ records: rotatedLedger(), broker: tinyBroker, config, chain: { ok: true, recordCount: 4, firstBreak: null }, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  assert.equal(tiny.brokerClosedTrades.netOfFinancing, -0.0022);
  assert.match(renderReportText(tiny), /realised P\/L -0\.0021, financing -0\.0001, net -0\.0022/);
});

test("the chain explanation matches the chain's actual state", () => {
  const ok = buildReport({ records: rotatedLedger(), broker: broker(), config, chain: { ok: true, recordCount: 4, firstBreak: null }, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  assert.equal(ok.ledger.chain.ok, true);
  assert.doesNotMatch(ok.ledger.chain.explanation, /BROKEN at the seq below/, "an intact chain must not carry the BROKEN explanation");
  assert.match(ok.ledger.chain.explanation, /verifies over all 4 records/);
  assert.match(ok.ledger.chain.explanation, /archived byte-for-byte/);

  const broken = buildReport({ records: rotatedLedger(), broker: broker(), config, chain: { ok: false, recordCount: 4, firstBreak: { line: 1418, seq: 1417, reason: "seq 1417 is not the expected 1418" } }, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  assert.match(broken.ledger.chain.explanation, /BROKEN at the seq below/);
});

test("a trade the broker closed but the record never closed is reported as a gap, not absorbed", () => {
  const records = ledger().filter((r) => r.kind !== "CLOSED");
  const b = broker();
  b.closedTrades.trades.push({ id: "333", instrument: "GBP_USD", realizedPL: "670.52", financing: "-5.99", clientExtensions: { id: "msig-eee", tag: "MERIDIAN-PRACTICE-TEST" } });
  const report = buildReport({ records, broker: b, config, chain: goodChain, notification: noNotification, generatedAt: at(10), trigger: "SCHEDULED" });
  const text = renderReportText(report);

  assert.deepEqual(report.reconciliation.closedAtBrokerNotInRecord.map((t) => t.tradeId).sort(), ["111", "333"]);
  assert.deepEqual(report.reconciliation.enteredAtBrokerWithoutFillRecord.sort(), ["333"], "trade 111 does have a FILL record; 333 does not");
  assert.ok(report.unmeasured.some((u) => u.includes("NO close record in the append-only record")));
  assert.match(text, /Gap in OUR record: 2 closed trade\(s\)/);
  assert.match(text, /NO FILL record in our record: 333/);
});

/* ------------------------------------------------------------------ notification */

test("with no transport configured nothing is sent, and the exact sentence is logged and stored", async () => {
  const logged: string[] = [];
  const result = await deliverReport(
    { reportId: "rpt-x", generatedAt: at(0), subject: "s", text: "t", json: {} },
    { log: (line) => logged.push(line) },
  );

  assert.equal(result.transport, "none");
  assert.equal(result.configured, false);
  assert.equal(result.delivered, false, "nothing was sent, so nothing may be reported as delivered");
  assert.equal(result.detail, NO_TRANSPORT_DETAIL);
  assert.equal(NO_TRANSPORT_DETAIL, "no notification channel configured — report generated, nothing sent");
  assert.deepEqual(logged, [NO_TRANSPORT_DETAIL], "the log line is the same sentence, verbatim");
});

test("an unconfigured or failing transport never yields delivered:true", async () => {
  const unconfigured: NotificationTransport = {
    id: "email-ish",
    describe: () => "a channel with no address set",
    configured: () => false,
    send: async () => ({ delivered: true, detail: "this must never be reached" }),
  };
  const failing: NotificationTransport = {
    id: "broken",
    describe: () => "a channel that fails",
    configured: () => true,
    send: async () => ({ delivered: false, detail: "relay refused" }),
  };
  const throwing: NotificationTransport = {
    id: "throwing",
    describe: () => "a channel that throws",
    configured: () => true,
    send: async () => {
      throw new Error("socket hang up");
    },
  };

  const a = await deliverReport({ reportId: "r", generatedAt: at(0), subject: "s", text: "t", json: {} }, { transport: unconfigured, log: () => {} });
  assert.equal(a.delivered, false);
  assert.equal(a.detail, NO_TRANSPORT_DETAIL);

  const b = await deliverReport({ reportId: "r", generatedAt: at(0), subject: "s", text: "t", json: {} }, { transport: failing, log: () => {} });
  assert.equal(b.delivered, false);
  assert.equal(b.detail, "relay refused");

  const c = await deliverReport({ reportId: "r", generatedAt: at(0), subject: "s", text: "t", json: {} }, { transport: throwing, log: () => {} });
  assert.equal(c.delivered, false);
  assert.match(c.detail, /nothing was delivered/);
});

test("the seam works in the other direction: a transport that delivers is recorded as delivered", async () => {
  registerTransport("test-delivery", () => ({
    id: "test-delivery",
    describe: () => "an in-process test channel (sends nothing outside this process)",
    configured: () => true,
    send: async () => ({ delivered: true, detail: "accepted by the test channel" }),
  }));
  const resolved = resolveTransport("test-delivery");
  assert.equal(resolved.problem, null);
  const result = await deliverReport({ reportId: "r", generatedAt: at(0), subject: "s", text: "t", json: {} }, { transport: resolved.transport, log: () => {} });
  assert.equal(result.delivered, true);
  assert.equal(result.detail, "accepted by the test channel");
});

test("an unknown transport name falls back to none and says why", async () => {
  const resolved = resolveTransport("carrier-pigeon");
  assert.equal(resolved.transport.id, "none");
  assert.match(resolved.problem ?? "", /is not registered in this build/);
});

/* ------------------------------------------------------------------ scheduling */

test("the interval defaults to 6 hours and is read from config when given", () => {
  assert.equal(DEFAULT_REPORT_INTERVAL_HOURS, 6);
  assert.equal(parseConfig({}).reportIntervalHours, 6);
  assert.equal(parseConfig({}).reportTransport, "none");
  assert.equal(parseConfig({ report: { intervalHours: 0.5, transport: "email" } }).reportIntervalHours, 0.5);
  assert.equal(parseConfig({ report: { intervalHours: 0.5, transport: "email" } }).reportTransport, "email");
  const bad = parseConfig({ report: { intervalHours: -1 } });
  assert.equal(bad.reportIntervalHours, 6);
  assert.ok(bad.problems.some((p) => p.includes("report.intervalHours")));
});

test("a report is due immediately after an event, and otherwise on the interval", async () => {
  const state = { lastReportAt: at(0), lastReportId: "rpt-a", lastSeqSeen: 5, intervalHours: 6, updatedAt: at(0) };

  // Nothing new: not due.
  const quiet = await reportDue(ledger().slice(0, 5), { reportIntervalHours: 6 }, state, new Date(Date.parse(at(0)) + 60_000));
  assert.equal(quiet.due, false);

  // A fill recorded after the last covered seq: due NOW, whatever the interval says.
  const withFill = [...ledger().slice(0, 5), { seq: 6, recordedAt: at(5), kind: "FILL", payload: {} }];
  const event = await reportDue(withFill, { reportIntervalHours: 6 }, state, new Date(Date.parse(at(0)) + 60_000));
  assert.equal(event.due, true);
  assert.equal(event.trigger, "EVENT");
  assert.match(event.detail ?? "", /FILL at record\(s\) 6/);

  // A close, a refusal and an error are events too.
  for (const kind of ["CLOSED", "VALIDATION_REFUSED", "CONNECTION_FAILURE", "ORDER_REJECTED", "CONTROL_REFUSED", "PARTIAL_FILL"]) {
    const due = await reportDue([{ seq: 6, recordedAt: at(5), kind, payload: {} }], { reportIntervalHours: 6 }, state, new Date(Date.parse(at(0))));
    assert.equal(due.due, true, `${kind} must make a report due immediately`);
  }

  // Six hours on, with no events: due on the interval.
  const aged = await reportDue(ledger().slice(0, 5), { reportIntervalHours: 6 }, state, new Date(Date.parse(at(0)) + 6 * 3600_000));
  assert.equal(aged.due, true);
  assert.equal(aged.trigger, "SCHEDULED");
  assert.match(aged.detail ?? "", /interval of 6h/);

  // No report has ever been generated: due.
  const first = await reportDue([], { reportIntervalHours: 6 }, { lastReportAt: null, lastReportId: null, lastSeqSeen: 0, intervalHours: 6, updatedAt: at(0) }, new Date(0));
  assert.equal(first.due, true);
});

/* ------------------------------------------------------------------ generation */

test("generateReport writes both files, appends REPORT_GENERATED, and sends nothing", async () => {
  const client = createClient({
    transport: async (url) => {
      assert.equal(new URL(url).host, "api-fxpractice.oanda.com");
      const path = new URL(url).pathname;
      if (path.endsWith("/summary")) {
        return Response.json({ account: { id: ACCOUNT_ID_IN_A_RECORD, currency: "USD", balance: "100585.24", NAV: "100585.24", marginAvailable: "90000", marginUsed: "0", openPositionCount: "0", openTradeCount: "0", pendingOrderCount: "0", unrealizedPL: "0", lastTransactionID: "500" } });
      }
      if (path.endsWith("/openTrades")) return Response.json({ trades: [] });
      if (path.endsWith("/positions")) return Response.json({ positions: [] });
      if (path.endsWith("/orders")) return Response.json({ orders: [] });
      if (path.endsWith("/trades")) {
        return Response.json({ trades: [{ id: "111", instrument: "EUR_USD", realizedPL: "-12.5", financing: "-0.42", clientExtensions: { id: "msig-aaa", tag: "MERIDIAN-PRACTICE-TEST" } }] });
      }
      return Response.json({});
    },
  });

  const logged: string[] = [];
  // Two records first, so the report has a non-empty window to quote.
  await appendRecord({ kind: "ACCOUNT_READ", state: "OK", payload: { note: "fixture read", nav: 100585.24, balance: 100585.24 } });
  await appendRecord({ kind: "SESSION_START", state: "OK", payload: { note: "fixture session" } });
  const result = await generateReport({ client, config, trigger: "MANUAL", triggerDetail: "test", log: (line) => logged.push(line) });

  // Nothing sent, in the exact words, in the result and in the log.
  assert.equal(result.notification.delivered, false);
  assert.equal(result.notification.detail, NO_TRANSPORT_DETAIL);
  assert.deepEqual(logged, [NO_TRANSPORT_DETAIL]);

  // Both files exist and say the same thing.
  const jsonText = await readFile(result.files.json, "utf8");
  const textBody = await readFile(result.files.text, "utf8");
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.reportId, result.report.reportId);
  assert.equal(parsed.notification.delivered, false);
  assert.ok(textBody.includes(NO_TRANSPORT_DETAIL));
  assert.equal(jsonText.includes(ACCOUNT_ID_IN_A_RECORD), false, "no account id in the JSON");
  assert.equal(textBody.includes(ACCOUNT_ID_IN_A_RECORD), false, "no account id in the text");
  assert.match(textBody, /^# Meridian execution report rpt-/);

  // The record now names the report and what it was built from.
  const records = await readRecords();
  const entry = records.find((r) => r.kind === "REPORT_GENERATED");
  assert.ok(entry, "a REPORT_GENERATED record must be appended");
  assert.equal((entry!.payload as any).reportId, result.report.reportId);
  assert.equal((entry!.payload as any).notification.delivered, false);
  assert.equal(entry!.state, "GENERATED_NOT_SENT");

  // The scheduler's state advanced, and the latest report is readable.
  const state = await readReportState();
  assert.equal(state.lastReportId, result.report.reportId);
  assert.equal(state.lastSeqSeen, result.report.window.toSeq);
  const latest = await readLatestReport();
  assert.equal(latest?.reportId, result.report.reportId);

  // The second report's window starts where the first one ended.
  const second = await generateReport({ client, config, trigger: "SCHEDULED", log: () => {} });
  assert.equal(second.report.window.basis, "PREVIOUS_REPORT");
  assert.ok(second.report.window.fromSeq >= result.report.window.toSeq);
});

/* ------------------------------------------------------------------ the endpoint */

const OPERATOR_KEY = "k".repeat(48);

test("the console report endpoint refuses every request without the operator key", async () => {
  const deps = { operatorKey: OPERATOR_KEY, readLatest: async () => ({ found: false as const, path: "/nowhere/latest.json", reason: "NOT_GENERATED_YET" as const, detail: "no report has been written there yet" }), generate: async () => ({ reportId: "r", generatedAt: at(0), text: "t", json: {}, notification: {}, recordSeq: 1 }) };

  for (const authorization of [null, "", "Bearer ", "Bearer wrong", `Bearer ${"k".repeat(47)}`, `Basic ${OPERATOR_KEY}`, OPERATOR_KEY]) {
    for (const action of ["report", "generate-report"] as const) {
      const res = await handleReportAction({ action, authorization, deps });
      assert.equal(res.status, 401, `${action} with authorization ${JSON.stringify(authorization)} must be refused`);
      const body = await res.json();
      assert.equal(body.report, undefined, "a refusal must disclose no report");
      assert.match(String(body.error), /access is locked/i);
      assert.equal(JSON.stringify(body).includes("100585"), false, "a refusal must disclose no account state");
    }
  }

  // A key shorter than 32 characters is treated as NOT CONFIGURED: the console locks rather
  // than serving on a weak secret.
  const weak = await handleReportAction({ action: "report", authorization: "Bearer short", deps: { ...deps, operatorKey: "short" } });
  assert.equal(weak.status, 401);
  const unset = await handleReportAction({ action: "report", authorization: "Bearer anything", deps: { ...deps, operatorKey: null } });
  assert.equal(unset.status, 401);
});

test("the console report endpoint serves the report to the operator key only", async () => {
  const report = buildReport({ records: ledger(), broker: broker(), config, chain: goodChain, notification: noNotification, generatedAt: at(10), trigger: "CONSOLE" });
  const deps = {
    operatorKey: OPERATOR_KEY,
    readLatest: async () => ({ found: true as const, report: { reportId: report.reportId, generatedAt: report.generatedAt, jsonPath: "j", textPath: "t", text: renderReportText(report), json: report } }),
    generate: async () => ({ reportId: "rpt-new", generatedAt: at(11), text: "fresh text", json: report, notification: noNotification, recordSeq: 42 }),
  };

  const shown = await handleReportAction({ action: "report", authorization: `Bearer ${OPERATOR_KEY}`, deps });
  assert.equal(shown.status, 200);
  const shownBody = await shown.json();
  assert.equal(shownBody.reportId, report.reportId);
  assert.ok(String(shownBody.text).includes(NO_TRANSPORT_DETAIL));
  assert.equal(shown.headers.get("cache-control"), "no-store");

  const generated = await handleReportAction({ action: "generate-report", authorization: `Bearer ${OPERATOR_KEY}`, deps });
  assert.equal(generated.status, 200);
  const generatedBody = await generated.json();
  assert.equal(generatedBody.recordSeq, 42);
  assert.equal(generatedBody.notification.delivered, false);
  assert.equal(generatedBody.notification.detail, NO_TRANSPORT_DETAIL);

  // With no report yet, the answer names the path it looked in — the failure this replaced
  // answered "no report has been generated yet" for every failure, including reading the
  // wrong directory while the watcher's real reports sat in the right one.
  const none = await handleReportAction({
    action: "report",
    authorization: `Bearer ${OPERATOR_KEY}`,
    deps: { ...deps, readLatest: async () => ({ found: false as const, path: join(dir, "reports", "latest.json"), reason: "NOT_GENERATED_YET" as const, detail: "no report has been written there yet" }) },
  });
  assert.equal(none.status, 200);
  const noneBody = await none.json();
  assert.equal(noneBody.report, null);
  assert.match(String(noneBody.note), /No report has been written at/);
  assert.ok(String(noneBody.note).includes(join(dir, "reports", "latest.json")), "the note must name the directory searched");

  // An unreadable report is not "none yet": it is reported as unreadable, with the path.
  const unreadable = await handleReportAction({
    action: "report",
    authorization: `Bearer ${OPERATOR_KEY}`,
    deps: { ...deps, readLatest: async () => ({ found: false as const, path: "/x/latest.json", reason: "UNREADABLE" as const, detail: "the report file is not valid JSON (unexpected token)" }) },
  });
  const unreadableBody = await unreadable.json();
  assert.match(String(unreadableBody.note), /could not be read/);

  // A generation failure is a 503 that claims nothing.
  const failed = await handleReportAction({
    action: "generate-report",
    authorization: `Bearer ${OPERATOR_KEY}`,
    deps: { ...deps, generate: async () => { throw new Error(`broker read failed for ${ACCOUNT_ID_IN_A_RECORD}`); } },
  });
  assert.equal(failed.status, 503);
  const failedBody = await failed.json();
  assert.equal(failedBody.report, undefined);
  assert.equal(JSON.stringify(failedBody).includes(ACCOUNT_ID_IN_A_RECORD), false, "an error path must not leak the account id");
});

test("the authorisation helper itself: constant-time comparison against a 32+ character key", () => {
  assert.deepEqual(authorizeOperatorKey(`Bearer ${OPERATOR_KEY}`, OPERATOR_KEY), { ok: true });
  assert.equal(authorizeOperatorKey(`Bearer ${OPERATOR_KEY}`, OPERATOR_KEY + "x").ok, false, "a longer key must not match");
  assert.equal(authorizeOperatorKey(`Bearer ${OPERATOR_KEY}x`, OPERATOR_KEY).ok, false, "a longer supplied value must not match");
  assert.equal(authorizeOperatorKey(null, OPERATOR_KEY).ok, false);
  assert.equal(authorizeOperatorKey(`Bearer ${OPERATOR_KEY}`, undefined).ok, false);
  assert.equal(authorizeOperatorKey(`Bearer ${OPERATOR_KEY}`, "short").ok, false);
});

test("account ids are scrubbed from anything the report emits", () => {
  assert.equal(scrubAccountIds(`account ${ACCOUNT_ID_IN_A_RECORD} orders`), "account [ACCOUNT-ID-REDACTED] orders");
  assert.equal(scrubAccountIds("no ids here"), "no ids here");
});
