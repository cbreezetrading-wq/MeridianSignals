/**
 * Rotate the execution ledger: archive the closed segment, open a new one.
 *
 *   bun tools/rotate-ledger.ts inspect [--out /tmp/rotation-inspect.json]
 *   bun tools/rotate-ledger.ts commit --inspect /tmp/rotation-inspect.json \
 *        --archive /home/team/shared/execution/archive/orders.segment-1-2026-11-05.jsonl \
 *        --reason "..." --authority "..."
 *
 * `inspect` is READ-ONLY against the broker and the record: it measures the segment, reads
 * the account, the open trades, the pending orders and the closed trades, and writes the
 * reconciliation. `commit` performs the rotation described in lib/rotation.ts and writes
 * the manifest.
 *
 * SAFETY. `commit` refuses if:
 *   - the record changed between inspect and commit (so the reconciliation quoted in the
 *     checkpoint is about the bytes that were actually archived);
 *   - the archive path already exists;
 *   - the copy does not match the source byte for byte;
 *   - the new segment does not verify from genesis;
 *   - any writer holds the record's flock (it waits for the lock, then re-checks).
 * It never touches a broker object: no order, position or stop is created, cancelled or
 * modified by a rotation.
 *
 * The caller is responsible for PAUSING and STOPPING THE WRITERS first. This tool checks
 * that it can take the ledger lock and that the file did not change under it, but the
 * clean cutover is: pause → stop supervisor and watcher → prove zero writers → inspect →
 * commit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "../lib/client.ts";
import { executionDir, recordPath, dayStatePath } from "../lib/paths.ts";
import { readRecords } from "../lib/record.ts";
import { dayStartNav, writeDayState } from "../lib/engine.ts";
import {
  archivePathFor,
  carryFromRecords,
  commitRotation,
  manifestMarkdown,
  manifestFromRecord,
  reconcileSegment,
  segmentStats,
  writeManifest,
  type ReconciliationSummary,
  type RotationResult,
} from "../lib/rotation.ts";

const [command = "help", ...rest] = process.argv.slice(2);

function flag(name: string): string | null {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : (rest[i + 1] ?? null);
}

function redact<T>(value: T): T {
  const secret = (process.env.OANDA ?? "").trim();
  if (secret.length < 8) return value;
  return JSON.parse(JSON.stringify(value).split(secret).join("[REDACTED]"));
}

/**
 * GET with bounded retries.
 *
 * These are READ-ONLY requests, so retrying one cannot create, duplicate or modify
 * anything at the broker. That matters because OANDA's Practice API returned intermittent
 * 401 ("Insufficient authorization to perform request") and 504 on identical, valid
 * requests during 2026-11-05 — measured: a curl GET /v3/accounts returned 200 while a
 * bun fetch of the same URL returned 504 seconds later, and a 401 on
 * /v3/accounts/{id}/summary preceded a 200 on the same URL. Retrying a READ is honest;
 * retrying a submission is not, and nothing here submits.
 */
async function readWithRetry<T extends { ok?: boolean; status?: number; transportFailure?: boolean; error?: string; text?: string; body?: any }>(
  call: () => Promise<T>,
  what: string,
  attempts = 4,
): Promise<T> {
  let last: T | null = null;
  for (let i = 1; i <= attempts; i += 1) {
    const res = await call();
    last = res;
    const failed = res?.transportFailure === true || res?.ok !== true;
    if (!failed) return res;
    if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
  }
  const r: any = last;
  throw new Error(
    `could not read ${what} from the broker after ${attempts} attempts: ${r?.error ?? `HTTP ${r?.status} ${String(r?.text ?? "").slice(0, 200)}`}`,
  );
}

async function brokerView() {
  const client = createClient();
  const account = await readWithRetry(() => client.summary(), "the account");
  const trades = await readWithRetry(() => client.openTrades(), "open trades");
  const orders = await readWithRetry(() => client.orders("PENDING"), "pending orders");
  const closed = await readWithRetry(() => client.closedTrades(), "closed trades");
  const a = (account as any).body;
  const openTrades = ((trades as any).body.trades ?? []).map((t: any) => ({ id: String(t.id), instrument: t.instrument, currentUnits: t.currentUnits, unrealizedPL: t.unrealizedPL }));
  const pendingOrders = ((orders as any).body.orders ?? []).map((o: any) => ({ id: String(o.id), instrument: o.instrument, type: o.type, units: o.units }));
  const closedTrades = ((closed as any).body.trades ?? []).map((t: any) => ({
    id: String(t.id),
    instrument: t.instrument,
    realizedPL: t.realizedPL ?? null,
    openTime: t.openTime ?? null,
    closeTime: t.closeTime ?? null,
    closingTransactionIDs: t.closingTransactionIDs ?? [],
  }));
  return {
    account: { id: a.account?.id, currency: a.account?.currency, nav: a.account?.NAV, balance: a.account?.balance, openTradeCount: a.account?.openTradeCount, pendingOrderCount: a.account?.pendingOrderCount, lastTransactionID: a.account?.lastTransactionID },
    openTrades,
    pendingOrders,
    closedTrades,
    readAt: new Date().toISOString(),
  };
}

async function inspect() {
  const path = recordPath();
  const stats = await segmentStats(path);
  const records = await readRecords(path);
  const broker = await brokerView();
  const reconciliation = reconcileSegment(records, broker);

  // Today's opening NAV: the day-state file if it already has today's entry, else the
  // earliest ACCOUNT_READ of today in this segment, else the current broker NAV — and it
  // says which, because "which" is the difference between a carried budget and a new one.
  const today = new Date().toISOString().slice(0, 10);
  let openingNav: number | null = null;
  let openingNavFrom = "";
  try {
    const raw = JSON.parse(await readFile(dayStatePath(), "utf8"));
    if (raw.date === today && Number.isFinite(raw.nav)) {
      openingNav = Number(raw.nav);
      openingNavFrom = "day-state.json (already taken today)";
    }
  } catch {
    /* none */
  }
  if (openingNav === null) {
    const firstRead = records.find((r) => r.kind === "ACCOUNT_READ" && r.recordedAt.slice(0, 10) === today);
    if (firstRead) {
      openingNav = Number((firstRead.payload as any)?.nav);
      openingNavFrom = `earliest ACCOUNT_READ of ${today} in the segment (seq ${firstRead.seq})`;
    }
  }
  if (openingNav === null || !Number.isFinite(openingNav)) {
    openingNav = Number(broker.account.nav);
    openingNavFrom = "the broker's current NAV (no earlier read today); labelled as such";
  }
  const realisedAtCutover = Object.entries(carryFromRecords(records).realisedByDay).filter(([d]) => d === today).reduce((s, [, v]) => s + v, 0);

  const out = {
    inspectedAt: new Date().toISOString(),
    recordPath: path,
    segment: stats,
    broker,
    reconciliation,
    dayState: { date: today, openingNav, openingNavFrom, realisedAtCutover },
  };
  const target = flag("out");
  if (target) await writeFile(target, JSON.stringify(redact(out), null, 2), "utf8");
  console.log(JSON.stringify(redact({ ...out, records: undefined, segment: { ...stats } }), null, 2));
  return out;
}

async function commit() {
  const inspectPath = flag("inspect");
  if (!inspectPath) throw new Error("--inspect <file> is required (run `inspect` first)");
  const reason = flag("reason");
  const authority = flag("authority");
  if (!reason) throw new Error("--reason is required and must say why the ledger is being rotated");
  if (!authority) throw new Error("--authority is required and must name the instruction that authorises it");

  const prior = JSON.parse(await readFile(inspectPath, "utf8"));
  const sourcePath = recordPath();
  const now = new Date();
  const archivePath = flag("archive") ?? archivePathFor(1, now);

  // The record must be the same bytes that were inspected, or the reconciliation quoted in
  // the checkpoint would be about something else.
  const current = await segmentStats(sourcePath);
  if (current.sha256 !== prior.segment.sha256) {
    throw new Error(`REFUSED: the record changed since it was inspected (${current.sha256} != ${prior.segment.sha256}). Nothing was archived or replaced; re-run inspect.`);
  }

  const breakNote = [
    "The archived segment contains TWO records numbered seq 1417. That duplicate is the",
    "2026-11-03 duplicate-writer incident: two watcher processes each read the same last",
    "hash and both appended seq 1417, one branch was orphaned, and every later record's seq",
    "is one below its line number, so the chain reads broken at line 1418.",
    "`execution/INCIDENT-2026-11-03-chain-break.md` is the incident account.",
    "The break is NOT fixed and is NOT claimed to be fixed here. No record was rewritten,",
    "removed or renumbered. The archived file is the history exactly as it happened.",
  ].join(" ");

  const result: RotationResult = await commitRotation({
    sourcePath,
    archivePath,
    previousSegment: 1,
    nextSegment: 2,
    reason,
    authority,
    breakNote,
    reconciliation: prior.reconciliation as ReconciliationSummary,
    dayState: prior.dayState,
    now,
  });

  // Carry the day state. The opening NAV is the one measured at inspect time, not the NAV
  // now: a rotation must not hand today a fresh loss budget.
  const day = await dayStartNav(Number(prior.dayState.openingNav));
  await writeDayState(
    {
      date: prior.dayState.date,
      nav: Number(prior.dayState.openingNav),
      source: day.source === "DAY_STATE_FILE" ? "DAY_STATE_FILE" : "LEDGER_ROTATION",
      carriedFrom: archivePath,
      realisedAtCutover: Number(prior.dayState.realisedAtCutover ?? 0),
      openingNavFrom: prior.dayState.openingNavFrom,
    },
    { replace: day.source !== "DAY_STATE_FILE" },
  );

  const manifestPath = resolve(executionDir(), "archive", "MANIFEST.md");
  const markdown = manifestMarkdown({
    result,
    reason,
    authority,
    breakNote,
    reconciliation: prior.reconciliation as ReconciliationSummary,
    dayState: { ...prior.dayState, writtenTo: dayStatePath() },
    writtenAt: new Date().toISOString(),
  });
  await writeManifest(manifestPath, markdown);

  console.log(
    JSON.stringify(
      {
        rotated: true,
        archive: { path: result.archive.path, sha256: result.archive.sha256, bytes: result.archive.bytes, records: result.archive.recordCount, firstSeq: result.archive.firstSeq, lastSeq: result.archive.lastSeq, lastRecordedAt: result.archive.lastRecordedAt, duplicateSeqs: result.archive.duplicateSeqs },
        checkpoint: { seq: result.checkpoint.seq, kind: result.checkpoint.kind, hash: result.checkpoint.hash },
        newSegment: { path: result.newSegment.path, bytes: result.newSegment.bytes, records: result.newSegment.recordCount, chainOk: result.newSegment.chainOk, sha256: result.newSegment.sha256 },
        carriedForward: { orderKeys: result.carriedForward.orderKeys.length, knownTradeIds: result.carriedForward.knownTradeIds, realisedByDay: result.carriedForward.realisedByDay },
        dayState: await readFile(dayStatePath(), "utf8").then((s) => JSON.parse(s)).catch(() => null),
        manifest: manifestPath,
      },
      null,
      2,
    ),
  );
}

/**
 * Re-mint the manifest from the checkpoint record and the archive on disk.
 *
 * Refuses unless `--force` is given, because a manifest is written once. `--correction
 * "text"` appends a corrections section, which is how a defect in an earlier version of the
 * manifest is disclosed rather than hidden: the measured values are re-stated from the
 * checkpoint, and the reason for the re-mint is written next to them.
 */
async function manifest() {
  const { markdown, archiveMatchesCheckpoint, result } = await manifestFromRecord();
  const path = flag("out") ?? resolve(executionDir(), "archive", "MANIFEST.md");
  const correction = flag("correction");
  const body = correction
    ? `${markdown}\n## Corrections to this manifest\n\n${correction}\n\nRe-minted ${new Date().toISOString()} from the checkpoint record (seq ${result.checkpoint.seq}) and the archive on disk.\nArchive hash now matches the hash the checkpoint recorded: **${archiveMatchesCheckpoint ? "yes" : "NO — the archive is not the bytes that were archived"}**.\n`
    : markdown;
  if (flag("force") === "true" || rest.includes("--force")) await writeFile(path, body, "utf8");
  else await writeManifest(path, body);
  console.log(JSON.stringify({ written: path, archiveMatchesCheckpoint, archive: result.archive.path, sha256: result.archive.sha256, bytes: result.archive.bytes, checkpointSeq: result.checkpoint.seq }, null, 2));
}

if (command === "inspect") await inspect();
else if (command === "commit") await commit();
else if (command === "manifest") await manifest();
else {
  console.log("usage: bun tools/rotate-ledger.ts inspect [--out file] | commit --inspect file --archive path --reason text --authority text | manifest [--force] [--correction text]");
  process.exitCode = 2;
}

