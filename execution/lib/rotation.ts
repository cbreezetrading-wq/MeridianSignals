/**
 * LEDGER ROTATION — closing a record segment and opening a new one.
 *
 * WHY THIS EXISTS
 * On 2026-11-03 two writers appended to `orders.jsonl` at the same moment and both wrote
 * seq 1417 (INCIDENT-2026-11-03-chain-break.md). The flock that now prevents that was
 * added afterwards, but the damage is permanent: `verifyChain()` stops at the duplicate
 * and `submitSignal()` refuses every submission while the chain is invalid. Two days of
 * nothing being submittable followed. The owner chose ROTATION over a "tolerate a known
 * break" allowance (2026-11-05): history stays exactly as it happened, the broken segment
 * is archived byte-for-byte and never edited, and a new segment opens with a chain that
 * verifies from genesis.
 *
 * WHAT ROTATION MUST NOT DESTROY
 * Three things live in the record and would be silently lost by starting a new file:
 *
 *  1. DUPLICATE SUPPRESSION. `checkDuplicate()` asks the record whether an order key has
 *     already been submitted. Old keys are no longer in the live file after rotation, so
 *     they are carried forward INTO the checkpoint record itself (see
 *     `carriedForwardFromRecord`) — not into a side file that can rot or be edited.
 *     The checkpoint is seq 1 of the new chain, so the carry-forward is as tamper-evident
 *     as any other record.
 *  2. KNOWN TRADE IDS. A trade Meridian opened is recognised at the broker partly by the
 *     ids the record says it opened.
 *  3. THE DAY'S REALISED P/L. The daily loss guard measures against the day's opening NAV;
 *     a rotation must not reset today's loss budget to zero.
 *
 * THE ARCHIVE IS IMMUTABLE. `commitRotation()` copies, verifies the copy's SHA-256 and byte
 * size against the source, and only then replaces the live path atomically (write the new
 * segment to `orders.jsonl.new`, verify it, rename). The archived bytes are never rewritten,
 * re-hashed or "cleaned".
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GENESIS_PREV_HASH, appendRecord, readRecords, verifyChain, type ExecutionRecord } from "./record.ts";
import { withLedgerLock } from "./ledgerLock.ts";
import { recordPath, executionDir } from "./paths.ts";

/** Record kinds that mean "this order key was actually submitted". Same set checkDuplicate uses. */
export const SUBMISSION_KINDS = ["ORDER_REQUESTED", "ORDER_ACKNOWLEDGED", "FILL", "PARTIAL_FILL", "PROTECTED"] as const;

export type SegmentStats = {
  path: string;
  bytes: number;
  sha256: string;
  recordCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  lastRecordedAt: string | null;
  /** Every seq that appears more than once, with the 1-based line numbers it occupies. */
  duplicateSeqs: Array<{ seq: number; lines: number[] }>;
  chainOk: boolean;
  firstBreak: { line: number; seq: number; reason: string } | null;
};

export async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Everything the manifest has to state about a segment, measured rather than assumed. */
export async function segmentStats(path: string): Promise<SegmentStats> {
  const info = await stat(path);
  const sha256 = await sha256File(path);
  const records = await readRecords(path);
  const lines = new Map<number, number[]>();
  records.forEach((r, i) => {
    const at = lines.get(r.seq) ?? [];
    at.push(i + 1);
    lines.set(r.seq, at);
  });
  const duplicateSeqs = [...lines.entries()]
    .filter(([, l]) => l.length > 1)
    .map(([seq, l]) => ({ seq, lines: l }))
    .sort((a, b) => a.seq - b.seq);
  const chain = await verifyChain(path);
  return {
    path,
    bytes: info.size,
    sha256,
    recordCount: records.length,
    firstSeq: records[0]?.seq ?? null,
    lastSeq: records[records.length - 1]?.seq ?? null,
    lastRecordedAt: records[records.length - 1]?.recordedAt ?? null,
    duplicateSeqs,
    chainOk: chain.ok,
    firstBreak: chain.firstBreak,
  };
}

/* --------------------------------------------------------- carry-forward state */

export type CarriedOrderKey = {
  orderKey: string;
  signalId: string | null;
  /** Which record kinds this key appears under — duplicate suppression needs the submission ones. */
  kinds: string[];
  state: string | null;
  tradeId: string | null;
  instrument: string | null;
  lastRecordedAt: string;
};

export type CarriedForward = {
  /** Every order key seen so far, from all segments, in first-seen order. */
  orderKeys: CarriedOrderKey[];
  /** Every trade id the record says Meridian opened. */
  knownTradeIds: string[];
  /** Realised P/L per UTC date, summed from CLOSED records, carried across the rotation. */
  realisedByDay: Record<string, number>;
  /** Where the carried state came from. Provenance, so a reader can go and check. */
  sources: Array<{ segment: number | null; path: string; sha256: string | null }>;
};

const LIFECYCLE = ["REQUESTED", "ACKNOWLEDGED", "FILLED", "PARTIALLY_FILLED", "PROTECTED", "CLOSED"];
function rank(state: string | null): number {
  return state && LIFECYCLE.includes(state) ? LIFECYCLE.indexOf(state) : -1;
}

function tradeIdOf(p: any): string | null {
  const id = p?.tradeId ?? p?.trade?.id ?? p?.tradeOpened?.tradeID ?? null;
  return id === null || id === undefined ? null : String(id);
}

/** What one segment's records contribute to the carried state. Pure. */
export function carryFromRecords(records: ExecutionRecord[]): CarriedForward {
  const byKey = new Map<string, CarriedOrderKey>();
  const knownTradeIds = new Set<string>();
  const realisedByDay: Record<string, number> = {};

  for (const r of records) {
    const p = (r.payload ?? {}) as any;
    const tid = tradeIdOf(p);
    if (tid && (r.kind === "FILL" || r.kind === "PARTIAL_FILL")) knownTradeIds.add(tid);
    if (r.kind === "CLOSED") {
      const pl = Number(p?.realizedPL ?? 0);
      const day = r.recordedAt.slice(0, 10);
      if (Number.isFinite(pl)) realisedByDay[day] = (realisedByDay[day] ?? 0) + pl;
    }
    if (!r.orderKey) continue;
    const prev = byKey.get(r.orderKey);
    const furthest = rank(r.state) >= rank(prev?.state ?? null) ? r.state : (prev?.state ?? null);
    byKey.set(r.orderKey, {
      orderKey: r.orderKey,
      signalId: r.signalId ?? prev?.signalId ?? null,
      kinds: [...new Set([...(prev?.kinds ?? []), r.kind])],
      state: furthest,
      tradeId: tid ?? prev?.tradeId ?? null,
      instrument: (p?.instrument as string) ?? prev?.instrument ?? null,
      lastRecordedAt: r.recordedAt,
    });
  }
  return { orderKeys: [...byKey.values()], knownTradeIds: [...knownTradeIds], realisedByDay, sources: [] };
}

/** Merge two carried states. Later `b` wins on a key collision; per-day P/L sums (dates are disjoint by construction). */
export function mergeCarried(a: CarriedForward, b: CarriedForward): CarriedForward {
  const keys = new Map<string, CarriedOrderKey>();
  for (const k of [...a.orderKeys, ...b.orderKeys]) {
    const prev = keys.get(k.orderKey);
    keys.set(k.orderKey, prev ? { ...k, kinds: [...new Set([...prev.kinds, ...k.kinds])], state: rank(k.state) >= rank(prev.state) ? k.state : prev.state } : k);
  }
  const realisedByDay: Record<string, number> = { ...a.realisedByDay };
  for (const [day, v] of Object.entries(b.realisedByDay)) realisedByDay[day] = (realisedByDay[day] ?? 0) + v;
  return {
    orderKeys: [...keys.values()],
    knownTradeIds: [...new Set([...a.knownTradeIds, ...b.knownTradeIds])],
    realisedByDay,
    sources: [...a.sources, ...b.sources],
  };
}

/**
 * The carried state as the LIVE record states it: the most recent LEDGER_ROTATION
 * checkpoint, which is itself cumulative (each rotation carries everything before it).
 * Reading only the newest one means a day's P/L cannot be counted twice.
 */
export async function carriedForwardFromRecord(path = recordPath()): Promise<CarriedForward> {
  const records = await readRecords(path);
  const empty: CarriedForward = { orderKeys: [], knownTradeIds: [], realisedByDay: {}, sources: [] };
  let latest: CarriedForward = empty;
  for (const r of records) {
    if (r.kind !== "LEDGER_ROTATION") continue;
    const carried = ((r.payload ?? {}) as any)?.carriedForward as CarriedForward | undefined;
    if (carried && Array.isArray(carried.orderKeys)) latest = carried;
  }
  return latest;
}

/* ------------------------------------------------------------ reconciliation */

export type ReconciliationSummary = {
  recordedIntents: Array<{
    orderKey: string;
    signalId: string | null;
    instrument: string | null;
    state: string | null;
    submitted: boolean;
    tradeId: string | null;
    lastRecordedAt: string;
  }>;
  /** Recorded intents whose trade id the broker knows (open or closed). */
  matched: Array<{ orderKey: string; tradeId: string; where: "OPEN" | "CLOSED"; instrument: string | null }>;
  /** Trades at the broker with no recorded intent — reported, never adopted or edited. */
  brokerWithoutRecord: Array<{ tradeId: string; instrument: string | null; state: "OPEN" | "CLOSED"; realizedPL: string | null; reason: string }>;
  /** Recorded intents naming a trade id the broker does not have in either state. */
  recordWithoutBroker: Array<{ orderKey: string; tradeId: string | null; state: string | null; reason: string }>;
  /** Anything still live at the broker. Must be empty for a clean rotation. */
  unresolved: { openTrades: number; pendingOrders: number; detail: string };
  statement: string;
};

/**
 * Compare the record's submission intents with the broker's own objects. Pure: the broker
 * state is passed in, so this is testable without a network.
 */
export function reconcileSegment(
  records: ExecutionRecord[],
  broker: {
    openTrades: Array<{ id: string; instrument?: string }>;
    pendingOrders: Array<{ id: string; instrument?: string }>;
    closedTrades: Array<{ id: string; instrument?: string; realizedPL?: string }>;
  },
): ReconciliationSummary {
  const carried = carryFromRecords(records);
  const openIds = new Set(broker.openTrades.map((t) => String(t.id)));
  const closedIds = new Set(broker.closedTrades.map((t) => String(t.id)));

  const recordedIntents = carried.orderKeys.map((k) => ({
    orderKey: k.orderKey,
    signalId: k.signalId,
    instrument: k.instrument,
    state: k.state,
    submitted: k.kinds.some((kind) => (SUBMISSION_KINDS as readonly string[]).includes(kind)),
    tradeId: k.tradeId,
    lastRecordedAt: k.lastRecordedAt,
  }));

  const matched: ReconciliationSummary["matched"] = [];
  const recordWithoutBroker: ReconciliationSummary["recordWithoutBroker"] = [];
  for (const intent of recordedIntents) {
    if (!intent.submitted) continue;
    if (!intent.tradeId) {
      recordWithoutBroker.push({ orderKey: intent.orderKey, tradeId: null, state: intent.state, reason: "submitted per the record, but the record names no trade id" });
      continue;
    }
    if (openIds.has(intent.tradeId)) matched.push({ orderKey: intent.orderKey, tradeId: intent.tradeId, where: "OPEN", instrument: intent.instrument });
    else if (closedIds.has(intent.tradeId)) matched.push({ orderKey: intent.orderKey, tradeId: intent.tradeId, where: "CLOSED", instrument: intent.instrument });
    else recordWithoutBroker.push({ orderKey: intent.orderKey, tradeId: intent.tradeId, state: intent.state, reason: "the broker has no such trade in OPEN or CLOSED state" });
  }

  const recordedTradeIds = new Set<string>([
    ...carried.knownTradeIds,
    ...recordedIntents.map((i) => i.tradeId).filter((v): v is string => typeof v === "string"),
  ]);
  const brokerWithoutRecord: ReconciliationSummary["brokerWithoutRecord"] = [];
  for (const t of broker.openTrades) {
    if (!recordedTradeIds.has(String(t.id))) {
      brokerWithoutRecord.push({ tradeId: String(t.id), instrument: t.instrument ?? null, state: "OPEN", realizedPL: null, reason: "open trade at the broker with no recorded intent" });
    }
  }
  for (const t of broker.closedTrades) {
    if (!recordedTradeIds.has(String(t.id))) {
      brokerWithoutRecord.push({
        tradeId: String(t.id),
        instrument: t.instrument ?? null,
        state: "CLOSED",
        realizedPL: t.realizedPL ?? null,
        reason: "closed trade at the broker with no recorded intent (no FILL record names it); the broker's own P/L is quoted and nothing is invented for it",
      });
    }
  }

  const unresolvedCount = broker.openTrades.length + broker.pendingOrders.length;
  return {
    recordedIntents,
    matched,
    brokerWithoutRecord,
    recordWithoutBroker,
    unresolved: {
      openTrades: broker.openTrades.length,
      pendingOrders: broker.pendingOrders.length,
      detail:
        unresolvedCount === 0
          ? "No open trade and no pending order at the broker: nothing is outstanding, so nothing has to be carried forward as unresolved."
          : "OUTSTANDING STATE AT THE BROKER — these are carried forward explicitly in the checkpoint, not dropped.",
    },
    statement:
      "The broker is the authority on what exists; the record is the authority on what was intended. Differences are reported, never reconciled by editing either side.",
  };
}

/* ------------------------------------------------------------------ rotation */

export type RotationInput = {
  /** Absolute path of the file to archive (normally recordPath()). */
  sourcePath: string;
  /** Absolute path of the archive. Must not already exist. */
  archivePath: string;
  /** Segment number of the file being closed. */
  previousSegment: number;
  /** Segment number of the file being opened. */
  nextSegment: number;
  reason: string;
  authority: string;
  reconciliation: ReconciliationSummary;
  /** Optional extra prose for the checkpoint, e.g. how the break is explained. */
  breakNote: string;
  /** Today's opening NAV and realised P/L, carried so a rotation does not reset the day's loss budget. */
  dayState?: Record<string, unknown> | null;
  /** Overridable for tests; defaults to "now". */
  now?: Date;
};

export type RotationResult = {
  archive: SegmentStats;
  checkpoint: ExecutionRecord;
  newSegment: SegmentStats;
  carriedForward: CarriedForward;
  replacedAt: string;
};

/**
 * Close a segment and open the next one.
 *
 * Refuses rather than proceeds when anything does not line up:
 *  - the archive already exists (an archive is immutable; never overwrite one);
 *  - the copy's SHA-256 or byte size differs from the source;
 *  - the source changed between the copy and the replace;
 *  - the new segment does not verify from genesis;
 *  - the archive's hash changes as a result of the replace.
 */
export async function commitRotation(input: RotationInput): Promise<RotationResult> {
  const now = input.now ?? new Date();
  const sourcePath = resolve(input.sourcePath);
  const archivePath = resolve(input.archivePath);
  if (archivePath === sourcePath) throw new Error("REFUSED: the archive path is the live record path");

  await mkdir(dirname(archivePath), { recursive: true });
  try {
    await stat(archivePath);
    throw new Error(`REFUSED: ${archivePath} already exists. An archive is immutable and is never overwritten.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // 1. COPY, then verify the copy against the source BEFORE anything is replaced.
  const before = await segmentStats(sourcePath);
  await copyFile(sourcePath, archivePath);
  const copied = await segmentStats(archivePath);
  if (copied.sha256 !== before.sha256) {
    throw new Error(`REFUSED: the archive copy hashes to ${copied.sha256} but the source is ${before.sha256}`);
  }
  if (copied.bytes !== before.bytes) {
    throw new Error(`REFUSED: the archive copy is ${copied.bytes} bytes but the source is ${before.bytes}`);
  }
  if (copied.recordCount !== before.recordCount) {
    throw new Error(`REFUSED: the archive copy has ${copied.recordCount} records but the source has ${before.recordCount}`);
  }

  // 2. Everything that must survive the rotation, from BOTH the previous carried state
  //    (already in the live record as an older checkpoint) and this segment's own records.
  const priorCarried = await carriedForwardFromRecord(sourcePath);
  const segmentCarried = carryFromRecords(await readRecords(sourcePath));
  const carriedForward: CarriedForward = mergeCarried(priorCarried, segmentCarried);
  carriedForward.sources = [
    ...priorCarried.sources,
    { segment: input.previousSegment, path: archivePath, sha256: before.sha256 },
  ];

  // 3. Open the new segment. appendRecord() with an explicit path derives seq 1 and the
  //    genesis prevHash because the file does not exist yet, and takes the same flock.
  const nextPath = `${sourcePath}.new`;
  try {
    await stat(nextPath);
    throw new Error(`REFUSED: ${nextPath} already exists; a previous rotation did not finish`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const checkpoint = await appendRecord(
    {
      kind: "LEDGER_ROTATION",
      state: "SEGMENT_OPEN",
      payload: {
        segment: input.nextSegment,
        openedAt: now.toISOString(),
        reason: input.reason,
        authority: input.authority,
        previousSegment: {
          segment: input.previousSegment,
          path: archivePath,
          sha256: before.sha256,
          bytes: before.bytes,
          recordCount: before.recordCount,
          firstSeq: before.firstSeq,
          lastSeq: before.lastSeq,
          lastRecordedAt: before.lastRecordedAt,
          duplicateSeqs: before.duplicateSeqs,
          chainOk: before.chainOk,
          firstBreak: before.firstBreak,
        },
        breakNote: input.breakNote,
        dayState: input.dayState ?? null,
        reconciliation: input.reconciliation,
        carriedForward,
        chain: {
          seq: 1,
          prevHash: GENESIS_PREV_HASH,
          note: "This record is seq 1 of the new segment and chains from GENESIS. The new chain verifies from genesis; the archived segment's history is unchanged, including its break.",
        },
      },
    },
    nextPath,
  );

  // 4. The new segment must verify from genesis BEFORE it replaces anything.
  const staged = await verifyChain(nextPath);
  if (!staged.ok) {
    throw new Error(`REFUSED: the staged new segment does not verify: ${JSON.stringify(staged.firstBreak)}`);
  }

  // 5. Replace atomically, under the ledger lock, having re-checked that the source has not
  //    moved since the copy was taken.
  const replacedAt = new Date().toISOString();
  await withLedgerLock(`${sourcePath}.lock`, async () => {
    const again = await sha256File(sourcePath);
    if (again !== before.sha256) {
      throw new Error(`REFUSED: the record changed after it was archived (${again} != ${before.sha256}); nothing was replaced`);
    }
    await rename(nextPath, sourcePath);
  });

  // 6. The archive must still be the same bytes, and the live path must verify.
  const archiveAfter = await segmentStats(archivePath);
  if (archiveAfter.sha256 !== before.sha256) {
    throw new Error(`CORRUPTION: the archive's hash changed after the replace (${archiveAfter.sha256})`);
  }
  const live = await segmentStats(sourcePath);
  if (!live.chainOk) throw new Error(`the live segment does not verify after the replace: ${JSON.stringify(live.firstBreak)}`);

  // `archive` is the ARCHIVE's own stats, re-measured after the replace: same bytes and
  // hash as the source, but with the archive path attached. Returning the source's stats
  // here (as a first version did) made the manifest name the live path as the archive.
  return { archive: archiveAfter, checkpoint, newSegment: live, carriedForward, replacedAt };
}

/* -------------------------------------------------------------------- manifest */

/** The human-readable record of the rotation. Written next to the archive, never rewritten later. */
export function manifestMarkdown(args: {
  result: RotationResult;
  reason: string;
  authority: string;
  breakNote: string;
  reconciliation: ReconciliationSummary;
  dayState: Record<string, unknown> | null;
  writtenAt: string;
}): string {
  const { result, reason, authority, breakNote, reconciliation, dayState, writtenAt } = args;
  const a = result.archive;
  const dup = a.duplicateSeqs.map((d) => `seq ${d.seq} (lines ${d.lines.join(" and ")})`).join("; ") || "none";
  const keys = result.carriedForward.orderKeys;
  return `# Ledger segment manifest

Written ${writtenAt}. This file is the human-readable record of a rotation. It is not the
authority — the archive is, byte for byte, and the checkpoint is, as seq 1 of the live
chain. Nothing here is re-derived later: it is what was measured at rotation time.

## Segment 1 (closed) — archived, immutable

- **Archive path:** \`${a.path}\`
- **SHA-256:** \`${a.sha256}\`
- **Bytes:** ${a.bytes}
- **Records:** ${a.recordCount}
- **Seq range:** ${a.firstSeq} … ${a.lastSeq}
- **Last recordedAt:** ${a.lastRecordedAt}
- **Duplicate sequence numbers:** ${dup}
- **Chain verifies:** ${a.chainOk ? "yes" : `NO — first break at line ${a.firstBreak?.line}, seq ${a.firstBreak?.seq}: ${a.firstBreak?.reason}`}

This file is never edited, never re-hashed and never "cleaned". Any later statement about
segment 1 is checked against that SHA-256, not against a copy of it.

## Why it was rotated

${reason}

**Authority:** ${authority}

## The break at seq 1417

${breakNote}

The break is **not fixed and is not claimed to be fixed**. It happened, it is explained in
\`execution/INCIDENT-2026-11-03-chain-break.md\`, and it stays in the record exactly as it
happened. Rotation does not repair history; it starts a new segment whose chain verifies
from genesis.

## Segment 2 (open) — first record

- **Checkpoint record seq:** ${result.checkpoint.seq}
- **Kind:** ${result.checkpoint.kind} (state ${result.checkpoint.state})
- **Hash:** \`${result.checkpoint.hash}\`
- **Chains from:** GENESIS (${GENESIS_PREV_HASH.slice(0, 12)}…)
- **Replaced the live path at:** ${result.replacedAt}
- **New segment verifies:** ${result.newSegment.chainOk ? "yes" : "NO"} (${result.newSegment.recordCount} record(s) at verification)

## Carried forward (what a rotation would otherwise destroy)

- **Order keys:** ${keys.length} — ${keys.map((k) => `\`${k.orderKey}\``).join(", ") || "none"}
- **Known trade ids:** ${result.carriedForward.knownTradeIds.join(", ") || "none"}
- **Realised P/L by UTC date:** ${Object.entries(result.carriedForward.realisedByDay).map(([d, v]) => `${d}: ${v}`).join(", ") || "none"}
- **Day state carried:** ${dayState ? JSON.stringify(dayState) : "not carried (no day state existed)"}

## Reconciliation at rotation

${reconciliation.statement}

- Recorded submission intents: ${reconciliation.recordedIntents.filter((i) => i.submitted).length} submitted of ${reconciliation.recordedIntents.length} keys
- Matched at the broker: ${reconciliation.matched.length} (${reconciliation.matched.map((m) => `trade ${m.tradeId} ${m.where}`).join(", ") || "none"})
- At the broker with no recorded intent: ${reconciliation.brokerWithoutRecord.length} (${reconciliation.brokerWithoutRecord.map((b) => `trade ${b.tradeId} ${b.state}${b.realizedPL ? ` P/L ${b.realizedPL}` : ""}`).join(", ") || "none"})
- Recorded with no broker counterpart: ${reconciliation.recordWithoutBroker.length} (${reconciliation.recordWithoutBroker.map((r) => `${r.orderKey}: ${r.reason}`).join("; ") || "none"})
- Unresolved: ${reconciliation.unresolved.detail}
`;
}

/** Write the manifest. Refuses to overwrite one: the first account of a rotation is the account. */
export async function writeManifest(path: string, markdown: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`REFUSED: ${path} already exists; a manifest is written once`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
}

/**
 * Rebuild the manifest from what the record and the archive actually say.
 *
 * This exists because a manifest can be lost or mis-generated, and the facts behind it are
 * not lost with it: the checkpoint holds the archived segment's sha256, path, byte count,
 * record count, seq range and reconciliation, and the archive is on disk with that hash.
 * Rebuilding therefore re-states measured facts rather than inventing new ones.
 *
 * It does NOT re-hash or touch the archive: the archive's current hash is compared with the
 * hash the checkpoint recorded, and a mismatch is reported as corruption, not smoothed over.
 */
export async function manifestFromRecord(segmentPath = recordPath()): Promise<{
  markdown: string;
  result: RotationResult;
  reason: string;
  authority: string;
  breakNote: string;
  reconciliation: ReconciliationSummary;
  dayState: Record<string, unknown> | null;
  archiveMatchesCheckpoint: boolean;
}> {
  const records = await readRecords(segmentPath);
  const checkpoint = [...records].reverse().find((r) => r.kind === "LEDGER_ROTATION");
  if (!checkpoint) throw new Error(`no LEDGER_ROTATION checkpoint in ${segmentPath}`);
  const p = (checkpoint.payload ?? {}) as any;
  const archivePath = String(p.previousSegment?.path);
  const archiveStats = await segmentStats(archivePath);
  const archiveMatchesCheckpoint = archiveStats.sha256 === p.previousSegment?.sha256;
  const live = await segmentStats(segmentPath);
  const result: RotationResult = {
    archive: archiveStats,
    checkpoint,
    newSegment: live,
    carriedForward: p.carriedForward,
    replacedAt: String(p.openedAt ?? checkpoint.recordedAt),
  };
  const markdown = manifestMarkdown({
    result,
    reason: String(p.reason ?? ""),
    authority: String(p.authority ?? ""),
    breakNote: String(p.breakNote ?? ""),
    reconciliation: p.reconciliation as ReconciliationSummary,
    dayState: (p.dayState as Record<string, unknown> | null) ?? null,
    writtenAt: new Date().toISOString(),
  });
  return { markdown, result, reason: String(p.reason ?? ""), authority: String(p.authority ?? ""), breakNote: String(p.breakNote ?? ""), reconciliation: p.reconciliation, dayState: p.dayState ?? null, archiveMatchesCheckpoint };
}

/** The default archive path for a segment: execution/archive/orders.segment-N-YYYY-MM-DD.jsonl */
export function archivePathFor(segment: number, now: Date, dir = resolve(executionDir(), "archive")): string {
  return resolve(dir, `orders.segment-${segment}-${now.toISOString().slice(0, 10)}.jsonl`);
}
