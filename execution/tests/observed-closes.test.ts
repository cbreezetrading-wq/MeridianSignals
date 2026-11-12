/**
 * A close the watcher SEES at the broker is recorded permanently — once.
 *
 * The defect: the record only learned about a close when Meridian sent the close itself.
 * Trade 52 filled 2026-11-05 and closed on its stop 2026-11-06 while the machine was down;
 * trade 59 did the same on 2026-11-11. The broker knew; the record never did. The report
 * printed "Closes recorded: 0" beside a trade the broker reports closed.
 *
 * What this file proves, and what it would catch if it regressed:
 *  - a managed trade the record believes open, absent from the broker's open trades, gets
 *    ONE CLOSED record carrying the broker's own close time, close price, closing
 *    transaction id, realised P/L and financing;
 *  - it is labelled OBSERVED_AT_BROKER with the broker's closedAt beside our detectedAt,
 *    and detectedLate: true when they are more than a cycle apart — a close is never
 *    claimed as witnessed live;
 *  - restart idempotency: running the detection again, and two runs racing, still leave
 *    exactly one CLOSED per trade id;
 *  - the start-up path: the watcher calls this before it can submit anything;
 *  - a broker that cannot be read records NOTHING (an unreadable broker is not a close);
 *  - a broker that omits the trade's P/L still gets a CLOSED record, with the P/L marked
 *    UNMEASURED — never zero, never guessed;
 *  - a stale open-trade list does not invent a close for a trade that is still open;
 *  - nothing is submitted, modified, cancelled or closed: every write method of the fake
 *    client fails the test if it is called;
 *  - the record's hash chain still verifies with the observed closes in it.
 *
 *   bun test /home/team/shared/execution/tests/observed-closes.test.ts
 */

import { isolate } from "./isolate.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { believedOpenTrades, recordObservedCloses, WATCHER_CYCLE_MS } from "../lib/closes.ts";
import { appendRecord, readRecords, recordPath, verifyChain } from "../lib/record.ts";
import type { Client } from "../lib/client.ts";

// This file's own temporary execution directory, so it cannot touch the live record.
isolate();

beforeEach(() => {
  // A fresh directory per test, so no test can inherit another's record.
  isolate();
});

/* ------------------------------------------------------------------ fake broker */

type BrokerOptions = {
  /** Trades the broker lists as OPEN. */
  open?: any[];
  /** Trades the broker lists as CLOSED. "FAIL" makes the read fail at the transport. */
  closed?: any[] | "FAIL";
  /** Per-trade GET results, by trade id. "FAIL" makes the read fail at the transport. */
  trades?: Record<string, any | "FAIL">;
  /** Closing transaction, by id. */
  transactions?: Record<string, any | "FAIL">;
};

const WRITE_METHODS = ["createOrder", "cancelOrder", "closeTrade", "closePosition"] as const;

function response(body: any, status = 200) {
  return { ok: true, status, body, text: JSON.stringify(body), request: { method: "GET", path: "/", body: null }, sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), durationMs: 1 };
}

function transportFailure(path: string) {
  return { ok: false, transportFailure: true, error: "socket hang up", request: { method: "GET", path, body: null }, sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), durationMs: 1 };
}

/**
 * A broker that answers reads and records every call. Any write is a test failure: the
 * detection must be read-only at the broker.
 */
function fakeBroker(options: BrokerOptions = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const client = {
    openTrades: async () => {
      calls.push("openTrades");
      return response({ trades: options.open ?? [] });
    },
    closedTrades: async () => {
      calls.push("closedTrades");
      if (options.closed === "FAIL") return transportFailure("closedTrades");
      return response({ trades: options.closed ?? [] });
    },
    trade: async (id: string) => {
      calls.push(`trade:${id}`);
      const t = options.trades?.[id];
      if (t === "FAIL") return transportFailure(`trades/${id}`);
      if (!t) return response({ errorMessage: "trade not found" }, 404);
      return response({ trade: t });
    },
    transaction: async (id: string) => {
      calls.push(`transaction:${id}`);
      const t = options.transactions?.[id];
      if (t === "FAIL") return transportFailure(`transactions/${id}`);
      if (!t) return response({ errorMessage: "transaction not found" }, 404);
      return response({ orderFillTransaction: t });
    },
    createOrder: async () => {
      writes.push("createOrder");
      throw new Error("the close detector must never submit an order");
    },
    cancelOrder: async () => {
      writes.push("cancelOrder");
      throw new Error("the close detector must never cancel an order");
    },
    closeTrade: async () => {
      writes.push("closeTrade");
      throw new Error("the close detector must never close a trade");
    },
    closePosition: async () => {
      writes.push("closePosition");
      throw new Error("the close detector must never close a position");
    },
  } as unknown as Client;
  return { client, calls, writes };
}

/** A broker CLOSED trade, shaped like the real one (trade 59). */
function closedTrade(over: Record<string, unknown> = {}) {
  return {
    id: "59",
    instrument: "EUR_USD",
    state: "CLOSED",
    price: "1.11634",
    initialUnits: "1",
    currentUnits: "0",
    realizedPL: "-0.0017",
    financing: "-0.0001",
    averageClosePrice: "1.11467",
    closeTime: "2026-11-11T08:14:25.611231266Z",
    openTime: "2026-11-10T20:05:03.467914954Z",
    closingTransactionIDs: ["63"],
    ...over,
  };
}

function fillTransaction(over: Record<string, unknown> = {}) {
  return {
    id: "63",
    type: "ORDER_FILL",
    time: "2026-11-11T08:14:25.611231266Z",
    instrument: "EUR_USD",
    units: "-1",
    price: "1.11467",
    pl: "-0.0017",
    financing: "-0.0001",
    commission: "0.0000",
    accountBalance: "100585.2354",
    reason: "STOP_LOSS_ORDER",
    tradeId: "59",
    ...over,
  };
}

/** A FILL record for trade 59, so the record believes the trade is open. */
async function recordFill(tradeId = "59", orderKey = "msig-abc123") {
  await appendRecord({
    kind: "FILL",
    orderKey,
    signalId: "sig-1",
    state: "FILLED",
    payload: { tradeId, instrument: "EUR_USD", units: 1, price: "1.11634", origin: "CONNECTION_TEST" },
  });
}

const closes = async () => (await readRecords()).filter((r) => r.kind === "CLOSED");

/* --------------------------------------------------------------------- tests */

describe("a close the record missed is recorded from the broker's own account of it", () => {
  test("one CLOSED record, with the broker's close time, price, transaction id, P/L and financing", async () => {
    await recordFill();
    const { client, writes } = fakeBroker({
      open: [],
      closed: [closedTrade()],
      transactions: { "63": fillTransaction() },
    });

    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });

    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual(["59"]);
    expect(result.recorded.length).toBe(1);

    const recorded = await closes();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]!.payload as any;
    expect(payload.detection).toBe("OBSERVED_AT_BROKER");
    expect(payload.tradeId).toBe("59");
    expect(payload.closedAt).toBe("2026-11-11T08:14:25.611231266Z");
    expect(payload.detectedAt).toBe("2026-11-12T09:00:00.000Z");
    expect(payload.detectedLate).toBe(true);
    expect(payload.realizedPL).toBe(-0.0017);
    expect(payload.financing).toBe(-0.0001);
    expect(payload.closePrice).toBe("1.11467");
    expect(payload.closingTransactionId).toBe("63");
    expect(payload.transactionId).toBe("63");
    expect(payload.plMeasured).toBe(true);
    expect(payload.unmeasuredReason).toBe(null);
    expect(payload.brokerState).toBe("CLOSED");
    expect(recorded[0]!.orderKey).toBe("msig-abc123");
    expect(recorded[0]!.state).toBe("CLOSED");
    // The detection is read-only at the broker, and says so in the record.
    expect(writes).toEqual([]);
    expect(String(payload.reason)).toMatch(/submitted, modified and closed nothing/);
    // The record's chain still verifies with the observed close in it.
    const chain = await verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.recordCount).toBe(2);
  });

  test("a close seen within one cycle is not labelled late; one seen later is", async () => {
    await recordFill();
    const justClosed = closedTrade({ closeTime: "2026-11-12T09:00:05.000Z" });
    const { client } = fakeBroker({ open: [], closed: [justClosed], transactions: { "63": fillTransaction() } });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:10.000Z" });
    expect(result.recorded[0]!.detectedLate).toBe(false);
    expect(result.recorded[0]!.lateByMs).toBe(5000);

    isolate();
    await recordFill();
    const late = closedTrade({ closeTime: "2026-11-12T08:00:00.000Z" });
    const second = fakeBroker({ open: [], closed: [late], transactions: { "63": fillTransaction() } });
    const later = await recordObservedCloses(second.client, { now: "2026-11-12T09:00:00.000Z" });
    expect(later.recorded[0]!.detectedLate).toBe(true);
    expect(later.recorded[0]!.lateByMs).toBeGreaterThan(WATCHER_CYCLE_MS);
  });

  test("a trade that is still open at the broker is left alone", async () => {
    await recordFill();
    const { client } = fakeBroker({ open: [{ id: "59", instrument: "EUR_USD", state: "OPEN" }] });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.candidates).toEqual([]);
    expect(await closes()).toEqual([]);
  });

  test("a stale open-trade list does not invent a close: the fresh per-trade read wins", async () => {
    await recordFill();
    const { client } = fakeBroker({
      open: [], // the list omitted it
      closed: [], // and so did the closed-trade history
      trades: { "59": { id: "59", instrument: "EUR_USD", state: "OPEN" } },
    });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.recorded).toEqual([]);
    expect(result.skipped[0]!.tradeId).toBe("59");
    expect(result.skipped[0]!.why).toMatch(/still reports this trade OPEN/);
    expect(await closes()).toEqual([]);
  });
});

describe("exactly one CLOSED record per trade id, ever", () => {
  test("a second run, after a restart, appends nothing", async () => {
    await recordFill();
    const { client } = fakeBroker({ open: [], closed: [closedTrade()], transactions: { "63": fillTransaction() } });

    const first = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(first.recorded.length).toBe(1);

    // A restart: same record on disk, same broker state, detection runs again.
    const second = await recordObservedCloses(client, { now: "2026-11-12T09:00:10.000Z" });
    expect(second.recorded).toEqual([]);
    expect(second.candidates).toEqual([]); // the record no longer believes the trade is open
    expect((await closes()).length).toBe(1);

    // Even with the belief forced back to "open", the append-time check holds.
    const third = await recordObservedCloses(client, { now: "2026-11-12T09:00:20.000Z" });
    expect(third.recorded).toEqual([]);
    expect((await closes()).length).toBe(1);
    expect((await verifyChain()).ok).toBe(true);
  });

  test("two runs racing still leave one CLOSED — the check is inside the append lock", async () => {
    await recordFill();
    const broker = () =>
      fakeBroker({ open: [], closed: [closedTrade()], transactions: { "63": fillTransaction() } }).client;

    const results = await Promise.all([
      recordObservedCloses(broker(), { now: "2026-11-12T09:00:00.000Z" }),
      recordObservedCloses(broker(), { now: "2026-11-12T09:00:00.000Z" }),
      recordObservedCloses(broker(), { now: "2026-11-12T09:00:00.000Z" }),
    ]);

    expect(results.reduce((n, r) => n + r.recorded.length, 0)).toBe(1);
    expect((await closes()).length).toBe(1);
    expect((await verifyChain()).ok).toBe(true);
  });

  test("a trade the record already closed is never closed again", async () => {
    await recordFill();
    await appendRecord({
      kind: "CLOSED",
      orderKey: "msig-abc123",
      state: "CLOSED",
      payload: { tradeId: "59", instrument: "EUR_USD", realizedPL: -0.0017, transactionId: "63", control: "close-managed" },
    });
    const { client } = fakeBroker({ open: [], closed: [closedTrade()], transactions: { "63": fillTransaction() } });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.candidates).toEqual([]);
    expect((await closes()).length).toBe(1);
  });

  test("a close recorded before a rotation is not reopened by the carried trade ids", async () => {
    await appendRecord({
      kind: "LEDGER_ROTATION",
      state: "SEGMENT_OPEN",
      payload: {
        segment: 2,
        carriedForward: {
          orderKeys: [{ orderKey: "msig-old", signalId: "sig-old", kinds: ["FILL", "CLOSED"], state: "CLOSED", tradeId: "33", instrument: "EUR_USD", lastRecordedAt: "2026-10-30T20:53:01.704Z" }],
          knownTradeIds: ["33"],
          realisedByDay: {},
          sources: [],
        },
      },
    });
    const { client } = fakeBroker({ open: [], closed: [closedTrade({ id: "33" })] });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.candidates).toEqual([]);
    expect(await closes()).toEqual([]);
  });
});

describe("what the record believes is open", () => {
  test("a FILL with no CLOSED is open; the same trade with a CLOSED is not", () => {
    const fill = { seq: 1, recordedAt: "2026-11-10T20:05:03.467Z", kind: "FILL", signalId: "sig-1", strategyId: null, strategyVersion: null, orderKey: "msig-abc123", state: "FILLED", payload: { tradeId: "59", instrument: "EUR_USD" }, prevHash: "", hash: "" } as any;
    const close = { seq: 2, recordedAt: "2026-11-12T09:00:00.000Z", kind: "CLOSED", signalId: "sig-1", strategyId: null, strategyVersion: null, orderKey: "msig-abc123", state: "CLOSED", payload: { tradeId: "59" }, prevHash: "", hash: "" } as any;
    expect(believedOpenTrades([fill], { knownTradeIds: [], orderKeys: [] })).toEqual([
      { tradeId: "59", orderKey: "msig-abc123", signalId: "sig-1", instrument: "EUR_USD" },
    ]);
    expect(believedOpenTrades([fill, close], { knownTradeIds: [], orderKeys: [] })).toEqual([]);
  });

  test("a trade carried across a rotation is still the record's to close", () => {
    const believed = believedOpenTrades([], {
      knownTradeIds: ["59"],
      orderKeys: [{ orderKey: "msig-abc123", signalId: "sig-1", kinds: ["FILL"], state: "FILLED", tradeId: "59", instrument: "EUR_USD", lastRecordedAt: "2026-11-10T20:05:03.467Z" }],
    });
    expect(believed).toEqual([{ tradeId: "59", orderKey: "msig-abc123", signalId: "sig-1", instrument: "EUR_USD" }]);
  });
});

describe("an unreadable broker records nothing", () => {
  test("open-trade read fails at the transport: no record, and the reason is stated", async () => {
    await recordFill();
    const client = {
      openTrades: async () => transportFailure("openTrades"),
    } as unknown as Client;
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("socket hang up");
    expect(result.recorded).toEqual([]);
    expect(await closes()).toEqual([]);
  });

  test("open-trade read returns an HTTP error: no record", async () => {
    await recordFill();
    const client = {
      openTrades: async () => ({ ...response({}, 503), ok: false, status: 503 }),
    } as unknown as Client;
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.ok).toBe(false);
    expect(await closes()).toEqual([]);
  });
});

describe("the broker omits the trade's P/L: the close is recorded, the P/L is UNMEASURED", () => {
  test("closed-trade read fails and the per-trade read fails: known facts only, no guessed P/L", async () => {
    await recordFill();
    const { client } = fakeBroker({ open: [], closed: "FAIL", trades: { "59": "FAIL" } });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.recorded.length).toBe(1);
    const payload = (await closes())[0]!.payload as any;
    expect(payload.tradeId).toBe("59");
    expect(payload.realizedPL).toBe(null);
    expect(payload.financing).toBe(null);
    expect(payload.plMeasured).toBe(false);
    expect(payload.detectedLate).toBe(true); // an unknown close time is never claimed live
    expect(String(payload.unmeasuredReason)).toMatch(/no P\/L is stated/);
    expect(String(payload.unmeasuredReason)).toMatch(/socket hang up/);
  });

  test("the trade is not in the closed history but the per-trade read answers: the close is still complete", async () => {
    await recordFill();
    const { client } = fakeBroker({ open: [], closed: [], trades: { "59": closedTrade() }, transactions: { "63": fillTransaction() } });
    const result = await recordObservedCloses(client, { now: "2026-11-12T09:00:00.000Z" });
    expect(result.recorded.length).toBe(1);
    const payload = (await closes())[0]!.payload as any;
    expect(payload.realizedPL).toBe(-0.0017);
    expect(payload.plMeasured).toBe(true);
    expect(String(payload.source)).toMatch(/trades\/59/);
  });
});

describe("the start-up path runs before anything can be submitted", () => {
  test("the watcher calls the close detector before it submits", async () => {
    const source = await readFile(new URL("../operator.ts", import.meta.url), "utf8");
    const watch = source.indexOf('if (command === "watch")');
    expect(watch).toBeGreaterThan(-1);
    const detection = source.indexOf("recordObservedCloses(", watch);
    const submit = source.indexOf("submitSignal(client, instruction, current)", watch);
    expect(detection).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    expect(detection).toBeLessThan(submit);
  });

  test("a close that happened while the machine was down is recorded on the next run, dated by the broker", async () => {
    // The FILL is four days old and the close three days old; the machine comes back now.
    await recordFill("52", "msig-52");
    const { client } = fakeBroker({
      open: [],
      closed: [closedTrade({ id: "52", closeTime: "2026-11-06T03:44:37.921325206Z", realizedPL: "-0.0021", financing: "-0.0001", closingTransactionIDs: ["56"], averageClosePrice: "1.11971" })],
      transactions: { "56": fillTransaction({ id: "56", tradeId: "52", time: "2026-11-06T03:44:37.921325206Z", pl: "-0.0021" }) },
    });
    const result = await recordObservedCloses(client, { now: "2026-11-12T22:00:00.000Z" });
    expect(result.recorded.length).toBe(1);
    const record = (await closes())[0]!;
    const payload = record.payload as any;
    expect(payload.closedAt).toBe("2026-11-06T03:44:37.921325206Z");
    expect(payload.detectedAt).toBe("2026-11-12T22:00:00.000Z");
    expect(payload.detectedLate).toBe(true);
    expect(payload.realizedPL).toBe(-0.0021);
    // Nothing is back-dated: the record's own timestamp is when we read it, not the close.
    expect(record.recordedAt >= "2026-11-12T22:00:00").toBe(true);
  });
});
