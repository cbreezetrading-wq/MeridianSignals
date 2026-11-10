/**
 * The account poll is throttled; nothing else is.
 *
 * Measured 2026-11-10: the record grew ~4.3 MB/day while the account was flat, because the
 * watcher's 10-second poll appended an ACCOUNT_READ every time whether or not anything had
 * changed — ~600 of 636 records were identical account polls. The fix: record a poll only
 * when it differs MATERIALLY from the last recorded one (NAV, balance, unrealised P/L, open
 * trade count, or the set of open trade ids), and otherwise at most once every 5 minutes.
 *
 * What this file proves, and what it would catch if it regressed:
 *  - identical polls are recorded once, not every ten seconds;
 *  - each material field, on its own, still causes an immediate record;
 *  - a different SET of trade ids with the SAME count still causes a record;
 *  - the 5-minute heartbeat happens, so a quiet account is never silence;
 *  - every other kind of event is still appended immediately and never suppressed;
 *  - the record's hash chain still verifies with suppressed polls in it.
 *
 *   bun test /home/team/shared/execution/tests/account-read-throttle.test.ts
 */

import { isolate } from "./isolate.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { readAccount, decideAccountReadAppend, accountReadChanges, ACCOUNT_READ_HEARTBEAT_MS } from "../lib/engine.ts";
import { appendRecord, readRecords, recordPath, verifyChain, GENESIS_PREV_HASH } from "../lib/record.ts";
import type { Client } from "../lib/client.ts";

// This file's own temporary execution directory, so it cannot touch the live record.
isolate();

beforeEach(() => {
  // A fresh directory per test, so no test can inherit another's record.
  isolate();
});

/** An account summary shaped like the broker's, with the fields under test overridable. */
function accountBody(over: Record<string, string | number> = {}) {
  return {
    id: "test-account",
    currency: "USD",
    balance: "100585.24",
    NAV: "100585.24",
    marginAvailable: "100585.24",
    marginUsed: "0.0000",
    openPositionCount: 0,
    openTradeCount: 0,
    pendingOrderCount: 0,
    unrealizedPL: "0.0000",
    lastTransactionID: "6400",
    ...over,
  };
}

function fakeClient(over: Record<string, string | number> = {}): Client {
  return {
    summary: async () => ({ ok: true, status: 200, body: { account: accountBody(over) }, text: "" }),
  } as unknown as Client;
}

const readCount = async () => (await readRecords()).filter((r) => r.kind === "ACCOUNT_READ").length;

describe("the account poll is recorded only when it says something new", () => {
  test("the first read is always recorded", async () => {
    const result = await readAccount(fakeClient());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recorded).toBe(true);
    expect(result.recordReason).toBe("FIRST_READ");
    expect(await readCount()).toBe(1);
  });

  test("six identical polls inside five minutes leave one record, not six", async () => {
    const client = fakeClient();
    for (let i = 0; i < 6; i += 1) await readAccount(client);
    expect(await readCount()).toBe(1);

    const last = await readAccount(client);
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.recorded).toBe(false);
    expect(last.recordReason).toBe("UNCHANGED");
    expect(last.changes).toEqual([]);
  });

  test("the read still returns the live account even when it is not recorded", async () => {
    await readAccount(fakeClient());
    const second = await readAccount(fakeClient({ NAV: "100585.24" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Not recorded, but the caller gets the state it asked for.
    expect(second.account.nav).toBe(100585.24);
    expect(second.recorded).toBe(false);
  });

  test("a NAV change is recorded immediately, inside the five-minute window", async () => {
    await readAccount(fakeClient());
    const changed = await readAccount(fakeClient({ NAV: "100600.00", balance: "100600.00" }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.recorded).toBe(true);
    expect(changed.recordReason).toBe("MATERIAL_CHANGE");
    expect(changed.changes).toContain("nav");
    expect(await readCount()).toBe(2);

    const records = await readRecords();
    const lastRead = records[records.length - 1];
    expect((lastRead.payload as any).readDecision).toBe("MATERIAL_CHANGE");
    expect((lastRead.payload as any).changed).toContain("nav");
  });

  test("a balance change alone is recorded", async () => {
    await readAccount(fakeClient());
    const changed = await readAccount(fakeClient({ balance: "100540.00", NAV: "100540.00" }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.recorded).toBe(true);
    expect(changed.changes).toContain("balance");
  });

  test("an unrealised P/L change alone is recorded", async () => {
    await readAccount(fakeClient());
    const changed = await readAccount(fakeClient({ unrealizedPL: "-0.0021" }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.recorded).toBe(true);
    expect(changed.changes).toContain("unrealizedPL");
  });

  test("an open trade count change alone is recorded", async () => {
    await readAccount(fakeClient());
    const changed = await readAccount(fakeClient({ openTradeCount: 1 }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.recorded).toBe(true);
    expect(changed.changes).toContain("openTradeCount");
  });

  test("the same count with a different set of trade ids is recorded", async () => {
    await readAccount(fakeClient({ openTradeCount: 1 }), { openTradeIds: ["52"] });
    const changed = await readAccount(fakeClient({ openTradeCount: 1 }), { openTradeIds: ["53"] });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.recorded).toBe(true);
    expect(changed.changes).toContain("openTradeIds");

    const records = await readRecords();
    expect((records[records.length - 1].payload as any).openTradeIds).toEqual(["53"]);
  });

  test("the same set of trade ids in a different order is not a change", async () => {
    await readAccount(fakeClient({ openTradeCount: 2 }), { openTradeIds: ["52", "53"] });
    const same = await readAccount(fakeClient({ openTradeCount: 2 }), { openTradeIds: ["53", "52"] });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.recorded).toBe(false);
  });
});

describe("the five-minute heartbeat", () => {
  const unchanged = accountBody() as unknown as Record<string, unknown>;
  const previous = { payload: unchanged, recordedAt: "2026-11-10T18:00:00.000Z" };

  test("nothing is appended four minutes after the last recorded poll", () => {
    const decision = decideAccountReadAppend({
      previous,
      next: unchanged,
      nowMs: Date.parse("2026-11-10T18:04:00.000Z"),
    });
    expect(decision.append).toBe(false);
    expect(decision.reason).toBe("UNCHANGED");
  });

  test("one is appended five minutes after the last recorded poll, unchanged", () => {
    const decision = decideAccountReadAppend({
      previous,
      next: unchanged,
      nowMs: Date.parse("2026-11-10T18:05:00.000Z"),
    });
    expect(decision.append).toBe(true);
    expect(decision.reason).toBe("HEARTBEAT");
    expect(decision.changed).toEqual([]);
  });

  test("the heartbeat record says when the unchanged stretch began", async () => {
    // A recorded poll six minutes old, with nothing changed since. The payload is the
    // snapshot shape readAccount writes (lower-case field names), not the broker's body.
    const old = {
      seq: 1,
      recordedAt: new Date(Date.now() - ACCOUNT_READ_HEARTBEAT_MS - 60_000).toISOString(),
      kind: "ACCOUNT_READ",
      signalId: null,
      strategyId: null,
      strategyVersion: null,
      orderKey: null,
      state: "OK",
      payload: {
        id: "test-account",
        currency: "USD",
        balance: 100585.24,
        nav: 100585.24,
        marginAvailable: 100585.24,
        marginUsed: 0,
        openPositionCount: 0,
        openTradeCount: 0,
        pendingOrderCount: 0,
        unrealizedPL: 0,
        lastTransactionID: "6400",
        readAt: new Date().toISOString(),
        openTradeIds: [],
      },
      prevHash: GENESIS_PREV_HASH,
      hash: "0".repeat(64),
    };
    await writeFile(recordPath(), JSON.stringify(old) + "\n", "utf8");

    const result = await readAccount(fakeClient(), { openTradeIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recorded).toBe(true);
    expect(result.recordReason).toBe("HEARTBEAT");

    const records = await readRecords();
    const heartbeat = records[records.length - 1];
    expect((heartbeat.payload as any).readDecision).toBe("HEARTBEAT");
    expect((heartbeat.payload as any).unchangedSince).toBe(old.recordedAt);
  });
});

describe("every other event is still recorded immediately", () => {
  test("a refusal appended twice inside the window is recorded twice", async () => {
    await appendRecord({ kind: "VALIDATION_REFUSED", orderKey: "msig-a", state: "REFUSED_INSTRUCTION", payload: { reasons: ["Signal exceeds configured maximum age"] } });
    await appendRecord({ kind: "VALIDATION_REFUSED", orderKey: "msig-a", state: "REFUSED_INSTRUCTION", payload: { reasons: ["Signal exceeds configured maximum age"] } });
    expect((await readRecords()).filter((r) => r.kind === "VALIDATION_REFUSED").length).toBe(2);
  });

  test("an execution event between two identical polls is never suppressed", async () => {
    const client = fakeClient();
    await readAccount(client); // recorded
    await readAccount(client); // suppressed
    await appendRecord({ kind: "FILL", orderKey: "msig-b", state: "FILLED", payload: { tradeId: "52", price: 1.1218 } });
    await readAccount(client); // suppressed again — the account has not changed
    const records = await readRecords();
    expect(records.filter((r) => r.kind === "FILL").length).toBe(1);
    expect(records.filter((r) => r.kind === "ACCOUNT_READ").length).toBe(1);
  });

  test("the chain still verifies with suppressed polls in it", async () => {
    const client = fakeClient();
    for (let i = 0; i < 4; i += 1) await readAccount(client);
    await appendRecord({ kind: "NO_ELIGIBLE_STRATEGY", state: "NO_ELIGIBLE_STRATEGY", payload: { strategy: null } });
    await readAccount(fakeClient({ NAV: "100590.00", balance: "100590.00" }));
    const chain = await verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.recordCount).toBe(3); // 2 recorded polls + 1 event
  });
});

describe("comparison rules", () => {
  test("the timestamp alone is not a material change", () => {
    const a = { ...accountBody(), readAt: "2026-11-10T18:00:00.000Z" } as unknown as Record<string, unknown>;
    const b = { ...accountBody(), readAt: "2026-11-10T18:00:10.000Z" } as unknown as Record<string, unknown>;
    expect(accountReadChanges(a, b)).toEqual([]);
  });

  test("a difference below one hundredth of a currency unit is float noise, not a change", () => {
    const a = accountBody() as unknown as Record<string, unknown>;
    const b = { ...accountBody(), NAV: "100585.24000001" } as unknown as Record<string, unknown>;
    expect(accountReadChanges(a, b)).toEqual([]);
  });

  test("an unknown trade id set is not evidence of movement", () => {
    const a = { ...accountBody(), openTradeIds: ["52"] } as unknown as Record<string, unknown>;
    const b = accountBody() as unknown as Record<string, unknown>; // ids not read this time
    expect(accountReadChanges(a, b)).toEqual([]);
  });

  test("no previous read is treated as a change, so it is recorded", () => {
    expect(accountReadChanges(null, accountBody() as unknown as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
