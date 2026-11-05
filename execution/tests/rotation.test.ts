/**
 * Ledger rotation.
 *
 * These tests exist because rotation is the one operation that can quietly WEAKEN a
 * guarantee: start a new file and duplicate suppression forgets every key that was ever
 * submitted, the day's loss budget resets to zero, and a trade Meridian opened looks like
 * someone else's. Every one of those is asserted here, in a temporary directory the test
 * owns (tests/isolate.ts), never against the live record.
 *
 * What is proven here is proven IN A TEST. The live rotation is a separate operation and
 * its own evidence is in execution/archive/MANIFEST.md.
 */

import { isolate } from "./isolate.ts";

const testDir = isolate();

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { appendRecord, readRecords, verifyChain, GENESIS_PREV_HASH, recordPath } from "../lib/record.ts";
import { dayStartNav, writeDayState } from "../lib/engine.ts";
import { checkDuplicate, realisedToday, managedTradeIdsFromRecord } from "../lib/engine.ts";
import { dailyLossBudget } from "../lib/risk.ts";
import {
  carryFromRecords,
  carriedForwardFromRecord,
  commitRotation,
  manifestMarkdown,
  mergeCarried,
  reconcileSegment,
  segmentStats,
  sha256File,
  writeManifest,
  archivePathFor,
} from "../lib/rotation.ts";

/** A segment with the 2026-11-03 shape: a duplicated seq, and a submission under a key. */
async function brokenSegment(path: string) {
  await appendRecord({ kind: "ACCOUNT_READ", payload: { nav: 100000 } }, path);
  await appendRecord({ kind: "INSTRUCTION_RECEIVED", signalId: "sig-1", orderKey: "msig-aaa", state: "RECEIVED", payload: { instruction: {} } }, path);
  await appendRecord({ kind: "ORDER_REQUESTED", signalId: "sig-1", orderKey: "msig-aaa", state: "REQUESTED", payload: { proposal: {} } }, path);
  await appendRecord({ kind: "FILL", signalId: "sig-1", orderKey: "msig-aaa", state: "FILLED", payload: { tradeId: "11", instrument: "EUR_USD" } }, path);
  await appendRecord({ kind: "CLOSED", signalId: "sig-1", orderKey: "msig-aaa", state: "CLOSED", payload: { tradeId: "11", realizedPL: -12.5 } }, path);

  // The duplicate: a second record numbered like the third, with its own hash, so the chain
  // breaks exactly as it did on 2026-11-03. Written by hand because appendRecord would
  // never produce it.
  const raw = await readFile(path, "utf8");
  const lines = raw.trimEnd().split("\n");
  const victim = JSON.parse(lines[2]);
  const forked = { ...victim, payload: { proposal: { forked: true } } };
  const { hash: _drop, ...rest } = forked;
  const { hashRecord } = await import("../lib/record.ts");
  const hash = await hashRecord(rest as Record<string, unknown>);
  await writeFile(path, `${lines.join("\n")}\n${JSON.stringify({ ...rest, hash })}\n`, "utf8");
  return { raw: await readFile(path, "utf8") };
}

test("the archive copy is byte-identical and the new segment verifies from genesis", async () => {
  const dir = join(testDir, "rotate-basic");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);

  const before = await segmentStats(source);
  assert.equal(before.chainOk, false, "the fixture must actually be broken");
  assert.deepEqual(before.duplicateSeqs.map((d) => d.seq), [3]);

  const archive = join(dir, "archive", "orders.segment-1-2026-11-05.jsonl");
  const result = await commitRotation({
    sourcePath: source,
    archivePath: archive,
    previousSegment: 1,
    nextSegment: 2,
    reason: "test: the chain is broken at the duplicate and nothing can be submitted",
    authority: "test",
    breakNote: "the duplicate seq 3 is the 2026-11-03 duplicate-writer incident, reproduced",
    reconciliation: reconcileSegment(await readRecords(source), { openTrades: [], pendingOrders: [], closedTrades: [{ id: "11", instrument: "EUR_USD", realizedPL: "-12.50" }] }),
  });

  assert.equal(result.archive.sha256, before.sha256);
  assert.equal(result.archive.bytes, before.bytes);
  assert.equal(await sha256File(archive), before.sha256, "the archive is the source bytes, exactly");
  assert.equal((await stat(archive)).size, before.bytes);

  const live = await verifyChain(source);
  assert.equal(live.ok, true, `the new segment must verify: ${JSON.stringify(live.firstBreak)}`);
  assert.equal(live.recordCount, 1);

  const records = await readRecords(source);
  assert.equal(records[0].seq, 1);
  assert.equal(records[0].kind, "LEDGER_ROTATION");
  assert.equal(records[0].prevHash, GENESIS_PREV_HASH);
  const payload = records[0].payload as any;
  assert.equal(payload.previousSegment.sha256, before.sha256);
  assert.equal(payload.previousSegment.path, archive);
  assert.equal(payload.previousSegment.duplicateSeqs[0].seq, 3);
});

test("an existing archive is never overwritten", async () => {
  const dir = join(testDir, "rotate-twice");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "orders.jsonl");
  await appendRecord({ kind: "ACCOUNT_READ", payload: { nav: 1 } }, source);
  const archive = join(dir, "archive", "orders.segment-1-2026-11-05.jsonl");
  await mkdir(join(dir, "archive"), { recursive: true });
  await writeFile(archive, "an archive that must not change\n", "utf8");

  await assert.rejects(
    () =>
      commitRotation({
        sourcePath: source,
        archivePath: archive,
        previousSegment: 1,
        nextSegment: 2,
        reason: "test",
        authority: "test",
        breakNote: "test",
        reconciliation: reconcileSegment([], { openTrades: [], pendingOrders: [], closedTrades: [] }),
      }),
    /already exists/,
  );
  assert.equal(await readFile(archive, "utf8"), "an archive that must not change\n");
});

test("carry-forward keeps every order key, trade id and per-day realised P/L", async () => {
  const dir = join(testDir, "carry");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);
  const records = await readRecords(source);
  const carried = carryFromRecords(records);

  const key = carried.orderKeys.find((k) => k.orderKey === "msig-aaa");
  assert.ok(key, "the submitted key must be carried");
  assert.ok(key!.kinds.includes("ORDER_REQUESTED"));
  assert.equal(key!.tradeId, "11");
  assert.equal(key!.state, "CLOSED");
  assert.deepEqual(carried.knownTradeIds, ["11"]);
  const day = records[0].recordedAt.slice(0, 10);
  assert.equal(carried.realisedByDay[day], -12.5);
});

test("mergeCarried is cumulative, not additive on the same day twice", () => {
  const a = { orderKeys: [{ orderKey: "k1", signalId: null, kinds: ["ORDER_REQUESTED"], state: "REQUESTED", tradeId: null, instrument: null, lastRecordedAt: "t" }], knownTradeIds: ["1"], realisedByDay: { "2026-11-05": -10 }, sources: [] };
  const b = { orderKeys: [{ orderKey: "k2", signalId: null, kinds: ["FILL"], state: "FILLED", tradeId: "2", instrument: "EUR_USD", lastRecordedAt: "t" }], knownTradeIds: ["2"], realisedByDay: { "2026-11-06": -5 }, sources: [] };
  const merged = mergeCarried(a, b);
  assert.equal(merged.orderKeys.length, 2);
  assert.deepEqual(merged.knownTradeIds, ["1", "2"]);
  assert.deepEqual(merged.realisedByDay, { "2026-11-05": -10, "2026-11-06": -5 });
});

test("a key submitted in an archived segment is still suppressed after rotation, without asking the broker", async () => {
  const dir = join(testDir, "dup-after-rotation");
  await mkdir(dir, { recursive: true });
  process.env.MERIDIAN_EXECUTION_DIR = dir;
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);

  // Rotate. The live file now contains ONE record: the checkpoint.
  await commitRotation({
    sourcePath: source,
    archivePath: join(dir, "archive", "orders.segment-1-2026-11-05.jsonl"),
    previousSegment: 1,
    nextSegment: 2,
    reason: "test",
    authority: "test",
    breakNote: "test",
    reconciliation: reconcileSegment(await readRecords(source), { openTrades: [], pendingOrders: [], closedTrades: [] }),
  });

  // The live record no longer mentions msig-aaa at all...
  const live = await readRecords(source);
  assert.equal(live.length, 1);
  assert.ok(!live.some((r) => r.orderKey === "msig-aaa"));

  // ...and the client is a landmine: reaching it at all fails the test, because the
  // carried key must answer first.
  const client = {
    orders: () => {
      throw new Error("the broker must not be consulted for a key the archive already knows");
    },
    openTrades: () => {
      throw new Error("the broker must not be consulted for a key the archive already knows");
    },
  } as any;

  const dup = await checkDuplicate(client, "msig-aaa", "sig-1");
  assert.equal(dup.duplicate, true);
  assert.equal(dup.foundIn, "RECORD_ARCHIVE");
  const evidence = dup.evidence as any;
  assert.deepEqual(evidence.kinds, ["ORDER_REQUESTED", "FILL"], "every submission kind the key appeared under is carried, so the same test applies after rotation");
  assert.equal(evidence.tradeId, "11");

  // A key the archive does NOT know still goes to the broker, and is not a duplicate.
  const fresh = {
    orders: () => ({ ok: true, body: { orders: [] } }),
    openTrades: () => ({ ok: true, body: { trades: [] } }),
  } as any;
  const notDup = await checkDuplicate(fresh, "msig-never-seen", "sig-2");
  assert.equal(notDup.duplicate, false);

  // Known trade ids survive too, so a pre-rotation trade is still recognised as ours.
  const ids = await managedTradeIdsFromRecord();
  assert.ok(ids.has("11"), "a trade opened before the rotation is still known");
});

test("today's realised P/L survives rotation", async () => {
  const dir = join(testDir, "realised");
  await mkdir(dir, { recursive: true });
  process.env.MERIDIAN_EXECUTION_DIR = dir;
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);
  assert.equal(await realisedToday(), -12.5, "before rotation the close is in the live segment");

  await commitRotation({
    sourcePath: source,
    archivePath: join(dir, "archive", "orders.segment-1-2026-11-05.jsonl"),
    previousSegment: 1,
    nextSegment: 2,
    reason: "test",
    authority: "test",
    breakNote: "test",
    reconciliation: reconcileSegment(await readRecords(source), { openTrades: [], pendingOrders: [], closedTrades: [] }),
  });
  assert.equal(await realisedToday(), -12.5, "after rotation the same close is carried, not lost");
});

test("the day's opening NAV is carried, and the loss budget is measured against it", async () => {
  const dir = join(testDir, "day-state");
  await mkdir(dir, { recursive: true });
  process.env.MERIDIAN_EXECUTION_DIR = dir;
  const today = new Date().toISOString().slice(0, 10);

  // A day that opened at 100,000 and is 600 down. 0.5% of 100,000 is 500, so the day is
  // already past the threshold and new entries must be refused.
  const openingNav = 100000;
  await writeDayState({ date: today, nav: openingNav, source: "LEDGER_ROTATION", carriedFrom: "/archive/segment-1.jsonl", realisedAtCutover: -600 });

  // A fresh process's first account read of the day is 99,400. If the carried value were
  // ignored, the budget would be re-based on 99,400 and the day would get a new allowance.
  const day = await dayStartNav(99400);
  assert.equal(day.nav, openingNav, "the opening NAV is the carried one, not the current NAV");
  assert.equal(day.source, "LEDGER_ROTATION");

  const budget = dailyLossBudget({ openingNav: day.nav, realisedPnl: -600, unrealisedPnl: 0, thresholdPct: 0.5 });
  assert.equal(budget.threshold, 500);
  assert.equal(budget.dayPnl, -600);
  assert.equal(budget.breached, true, "600 down against a 500 budget is a breach");

  // The same numbers with the budget reset (opening NAV taken as the current 99,400 and
  // realised P/L dropped to 0) would NOT breach — which is exactly the failure this guards.
  const reset = dailyLossBudget({ openingNav: 99400, realisedPnl: 0, unrealisedPnl: 0, thresholdPct: 0.5 });
  assert.equal(reset.breached, false);
});

test("writeDayState does not overwrite a value already taken for the same day", async () => {
  const dir = join(testDir, "day-state-guard");
  await mkdir(dir, { recursive: true });
  process.env.MERIDIAN_EXECUTION_DIR = dir;
  const today = new Date().toISOString().slice(0, 10);
  await writeDayState({ date: today, nav: 100000, source: "FIRST_READ_OF_DAY" });
  await writeDayState({ date: today, nav: 123, source: "LEDGER_ROTATION" });
  const day = await dayStartNav(1);
  assert.equal(day.nav, 100000, "the first value taken for the day stands");
});

test("reconciliation reports a broker trade with no recorded intent and invents nothing", async () => {
  const dir = join(testDir, "reconcile");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);
  const summary = reconcileSegment(await readRecords(source), {
    openTrades: [],
    pendingOrders: [],
    closedTrades: [
      { id: "11", instrument: "EUR_USD", realizedPL: "-12.50" },
      { id: "43", instrument: "GBP_USD", realizedPL: "670.52" },
    ],
  });
  assert.equal(summary.matched.length, 1);
  assert.equal(summary.matched[0].tradeId, "11");
  const unrecorded = summary.brokerWithoutRecord.find((b) => b.tradeId === "43");
  assert.ok(unrecorded, "trade 43 has no recorded intent and must be reported as such");
  assert.equal(unrecorded!.realizedPL, "670.52", "the broker's own P/L is quoted, not derived");
  assert.equal(summary.unresolved.openTrades, 0);
  assert.match(summary.unresolved.detail, /nothing is outstanding/i);
});

test("the manifest states the break plainly and points at the incident file", async () => {
  const dir = join(testDir, "manifest");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "orders.jsonl");
  await brokenSegment(source);
  const reconciliation = reconcileSegment(await readRecords(source), { openTrades: [], pendingOrders: [], closedTrades: [] });
  const result = await commitRotation({
    sourcePath: source,
    archivePath: join(dir, "archive", "orders.segment-1-2026-11-05.jsonl"),
    previousSegment: 1,
    nextSegment: 2,
    reason: "test reason",
    authority: "owner instruction under test",
    breakNote: "the duplicate at seq 3 is the 2026-11-03 duplicate-writer incident",
    reconciliation,
  });
  const markdown = manifestMarkdown({ result, reason: "test reason", authority: "owner instruction under test", breakNote: "the duplicate at seq 3 is the 2026-11-03 duplicate-writer incident", reconciliation, dayState: null, writtenAt: new Date().toISOString() });
  assert.match(markdown, /not fixed and is not claimed to be fixed/i);
  assert.match(markdown, /INCIDENT-2026-11-03-chain-break\.md/);
  assert.match(markdown, new RegExp(result.archive.sha256));
  const path = join(dir, "archive", "MANIFEST.md");
  await writeManifest(path, markdown);
  assert.ok(existsSync(path));
  await assert.rejects(() => writeManifest(path, "second version"), /written once/);
});

test("archivePathFor names the segment and the date", () => {
  const p = archivePathFor(1, new Date("2026-11-05T19:00:00Z"), "/tmp/archive");
  assert.equal(p, "/tmp/archive/orders.segment-1-2026-11-05.jsonl");
});

test("the live record path is never the archive path", async () => {
  await assert.rejects(
    () =>
      commitRotation({
        sourcePath: recordPath(),
        archivePath: recordPath(),
        previousSegment: 1,
        nextSegment: 2,
        reason: "test",
        authority: "test",
        breakNote: "test",
        reconciliation: reconcileSegment([], { openTrades: [], pendingOrders: [], closedTrades: [] }),
      }),
    /archive path is the live record path/,
  );
});
