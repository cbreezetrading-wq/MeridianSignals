import type { PairSignal, SignalsPayload } from "./types";

/**
 * The signal record: an append-only, hash-chained JSONL log of what the engine
 * said, written from server-side code at the moment the signals are computed.
 *
 * Rules this module never breaks:
 *  1. Append-only. Existing bytes are never rewritten, reordered, truncated or
 *     deleted. The only write is one `appendFile` of one complete line.
 *  2. Nothing is invented. A field is written from the computed signal, or it is
 *     null. A failed fetch is recorded as a failure, never as a stale number.
 *  3. Tamper-EVIDENT, not tamper-proof. See verifyChain() and the note below.
 *
 * Pure Node (no framework imports) so the same code runs inside the site and from
 * the standalone verifier at /home/team/shared/signal-log/verify-chain.ts.
 */

/**
 * Where the log is read from, and when it may be written to.
 *
 * Reads go through resolveData("signal-log") in bundledData.ts, in the same
 * documented order as the backtest files: env override → the shared path on the
 * owner's machine → the snapshot bundled into this build → nothing. On the
 * published site the owner's machine is unreachable, so the page serves the
 * publish-time snapshot and says so, with its cutoff and record count.
 *
 * Writes are narrower than reads, on purpose. This module only ever APPENDS to a
 * log file that already exists on this machine; it never creates one and it never
 * continues a chain from a snapshot. Before that rule existed, the published host —
 * which cannot see /home/team/shared — created an empty log there and presented it
 * as the beginning of the record: four records, and "Log begins" reading like the
 * start of history. A fresh or partial log must never impersonate the record, so a
 * missing file now means "read-only", never "start a new one".
 */
import { resolveData, type BundledSnapshot, type Provenance } from "./bundledData";

/** The env override honoured for the log (see bundledData.ts). */
export const SIGNAL_LOG_ENV = "SIGNAL_LOG_PATH";

/** Where the owner's log lives when no override is set. */
export const DEFAULT_LOG_PATH = "/home/team/shared/signal-log/signals.jsonl";

/** The path this deployment is configured to read (and, on the owner's machine, append to). */
export function configuredLogPath(): string {
  const override = typeof process === "undefined" ? undefined : process.env[SIGNAL_LOG_ENV];
  return override !== undefined && override.trim() !== "" ? override : DEFAULT_LOG_PATH;
}

/** The prevHash of the very first record: 64 zeroes. */
export const GENESIS_HASH = "0".repeat(64);

export const HASH_ALGORITHM = "SHA-256 hash chain";

/** A pair is re-recorded at least this often even when nothing changed. */
export const HEARTBEAT_SECONDS = 3600;

export type RecordKind = "change" | "heartbeat";
export type RecordReason = "first-record" | "state-changed" | "heartbeat-due";

export type SignalRecord = {
  /** 1-based position in the log. */
  seq: number;
  /** When this record was written, UTC ISO 8601. */
  recordedAt: string;
  kind: RecordKind;
  reason: RecordReason;
  pair: string;
  label: string;
  status: "ok" | "unavailable";
  signal: "LONG" | "SHORT" | "FLAT" | "UNAVAILABLE";
  entry: number | null;
  stop: number | null;
  target: number | null;
  /** UTC timestamp of the bar the recorded rule fired on (null when no signal was computed). */
  triggerBarUtc: string | null;
  triggerBarClose: number | null;
  /** The plain-English rule that fired, verbatim from ruleset.ts. */
  rule: string;
  /** The rule-event identifier behind that sentence (null when no signal was computed). */
  ruleEvent: string | null;
  /** The newest closed bar the computation used, and its close. */
  newestClosedBarUtc: string | null;
  newestClosedBarClose: number | null;
  /** Whether that computation was served from the server's few-minute cache. */
  fromCache: boolean | null;
  source: string;
  granularity: string;
  /** Present only when the fetch failed: the plain-English reason. */
  error: string | null;
  prevHash: string;
  hash: string;
};

export type VerifyResult = {
  ok: boolean;
  algorithm: string;
  logPath: string;
  /** Non-empty lines in the file. */
  recordCount: number;
  /** Records whose hash and back-link were actually recomputed. */
  recordsChecked: number;
  firstBreak: { line: number; reason: string } | null;
  lastHash: string | null;
  /** Longest gap between two consecutive records, in seconds — shows whether the log stayed awake. */
  maxGapSeconds: number | null;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  /** True when the final line had no terminating newline and is not valid JSON (torn write). */
  tornTrailingLine: boolean;
  /** Set by the caller when the answer came from a cached walk rather than a fresh one. */
  cached?: boolean;
  verifiedAt: string;
};

export type LogSummary = {
  /** The path this deployment reads (and, on the owner's machine, appends to). */
  logPath: string;
  /**
   * "file" when the bytes came from a file on this machine (the owner's live log),
   * "bundle" when they came from the snapshot taken at publish time, "none" when
   * neither could be read — in which case nothing is shown at all.
   */
  origin: "file" | "bundle" | "none";
  /** The snapshot's description, present only when origin === "bundle". */
  bundled: BundledSnapshot | null;
  /** False when no log could be read: the page then says so instead of showing an empty record. */
  available: boolean;
  recordCount: number;
  beginsAt: string | null;
  lastRecordedAt: string | null;
  secondsSinceLastRecord: number | null;
  heartbeatSeconds: number;
  fileBytes: number;
  /** A file that exists and has never been written to. Not the same as "unavailable". */
  empty: boolean;
};

type LoadedState = {
  seq: number;
  lastHash: string;
  pairs: Map<string, { key: string; recordedAtMs: number }>;
  /** The last line had no newline and did not parse: terminate it before appending. */
  torn: boolean;
};

/* ------------------------------------------------------------------ hashing */

/**
 * Canonical serialisation: the record's own fields, keys sorted, JSON-encoded with
 * no whitespace. Values are primitives only, so this is byte-for-byte stable
 * across processes and runs.
 */
export function canonicalRecord(record: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return JSON.stringify(sorted);
}

/**
 * hash = SHA-256 over the canonical record (which includes prevHash), excluding
 * `hash`. Uses WebCrypto so the same code path runs under Bun, Node and a browser
 * without pulling a Node built-in into the client bundle; it is only ever called
 * from server code.
 */
export async function hashRecord(fieldsWithPrevHash: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRecord(fieldsWithPrevHash));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/* --------------------------------------------------------------- file reading */

/**
 * The Node filesystem is imported dynamically, inside the functions that use it,
 * so this module can sit in a client-side import graph (the page reaches it via
 * the shared market service) without dragging a Node built-in into the browser
 * bundle. Nothing here is ever called from the browser: the log is written and
 * read on the server only.
 */
type FsPromises = typeof import("node:fs/promises");

let fsModule: FsPromises | null = null;

async function fs(): Promise<FsPromises> {
  fsModule ??= await import("node:fs/promises");
  return fsModule;
}

export function getLogPath(): string {
  return configuredLogPath();
}

export type LogRead = {
  text: string;
  bytes: number;
  /** "file" = a log on this machine; "bundle" = the publish-time snapshot; "none" = neither. */
  origin: "file" | "bundle" | "none";
  bundled: BundledSnapshot | null;
  provenance: Provenance | null;
  /** True only for a log file on this machine — the one case where appending is allowed. */
  writableSource: boolean;
  /** Why nothing could be read, when origin === "none". */
  error: string | null;
};

/**
 * Read the log through the shared resolution order (see bundledData.ts). A missing
 * log is reported as missing — it is never turned into an empty string that could
 * be mistaken for the beginning of the record.
 */
async function readLogRaw(): Promise<LogRead> {
  const resolved = await resolveData("signal-log");
  if (!resolved.ok) {
    return {
      text: "",
      bytes: 0,
      origin: "none",
      bundled: null,
      provenance: null,
      writableSource: false,
      error: resolved.error,
    };
  }
  const provenance = resolved.provenance;
  const isBundle = provenance.origin === "bundle";
  return {
    text: resolved.text,
    bytes: provenance.bytes,
    origin: isBundle ? "bundle" : "file",
    bundled: provenance.bundled,
    provenance,
    writableSource: !isBundle,
    error: null,
  };
}

/**
 * Appending is allowed only to a log file that already exists on this machine.
 * No mkdir, no create: on the published host the shared directory does not exist,
 * and creating it there is exactly how a fresh four-record log came to be shown as
 * the beginning of the record.
 */
async function appendTarget(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const path = configuredLogPath();
  const { stat } = await fs();
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, reason: `${path} is not a regular file` };
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown error";
    return {
      ok: false,
      reason: `the log file ${path} does not exist on this machine (${code}), and this deployment never creates one`,
    };
  }
}

function parseLine(line: string): SignalRecord | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as SignalRecord;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- appending */

let state: LoadedState | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Rebuild the in-memory view of the log (last hash + last record per pair). */
async function loadState(): Promise<LoadedState> {
  if (state) return state;
  const raw = await readLogRaw();
  if (raw.origin !== "file") {
    throw new Error(
      `the signal log is not a file on this machine (${raw.origin}), so the chain cannot be extended from it`,
    );
  }
  const { text } = raw;
  const pairs = new Map<string, { key: string; recordedAtMs: number }>();
  let lastHash = GENESIS_HASH;
  let seq = 0;
  let torn = false;

  // A trailing "" element simply means the file ended with a newline.
  const contentLines = text === "" ? [] : text.split("\n").slice(0, text.endsWith("\n") ? -1 : undefined);

  contentLines.forEach((line, index) => {
    const record = parseLine(line);
    if (!record) {
      // Only the very last line may be torn; anything else is a real break and the
      // verifier will report it. Never rewrite it — we only ever append.
      if (index === contentLines.length - 1) torn = !text.endsWith("\n");
      return;
    }
    lastHash = record.hash;
    seq = record.seq;
    pairs.set(record.pair, {
      key: changeKeyOf(record),
      recordedAtMs: Date.parse(record.recordedAt),
    });
  });

  state = { seq, lastHash, pairs, torn };
  return state;
}

/** What counts as "the state changed" for one pair. */
function changeKeyOf(record: {
  status: string;
  signal: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  triggerBarUtc: string | null;
  ruleEvent: string | null;
  error: string | null;
}): string {
  return [
    record.status,
    record.signal,
    record.entry,
    record.stop,
    record.target,
    record.triggerBarUtc,
    record.ruleEvent,
    record.error,
  ].join("|");
}

type Candidate = Omit<SignalRecord, "seq" | "kind" | "reason" | "recordedAt" | "prevHash" | "hash">;

const NO_SIGNAL_RULE =
  "No rule fired — the price source could not be read for this pair, so no signal was computed.";

function candidateFor(pair: PairSignal): Candidate {
  const source = pair.source;
  const granularity = pair.status === "ok" ? pair.granularity : pair.granularityExpected;
  if (pair.status === "unavailable") {
    return {
      pair: pair.pair,
      label: pair.label,
      status: "unavailable",
      signal: "UNAVAILABLE",
      entry: null,
      stop: null,
      target: null,
      triggerBarUtc: null,
      triggerBarClose: null,
      rule: NO_SIGNAL_RULE,
      ruleEvent: null,
      newestClosedBarUtc: null,
      newestClosedBarClose: null,
      fromCache: null,
      source,
      granularity,
      error: pair.detail ? `${pair.error} (${pair.detail})` : pair.error,
    };
  }
  return {
    pair: pair.pair,
    label: pair.label,
    status: "ok",
    signal: pair.signal,
    entry: pair.entry,
    stop: pair.stop,
    target: pair.target,
    triggerBarUtc: pair.ruleFired.barUtc,
    triggerBarClose: pair.ruleFired.barClose,
    rule: pair.ruleFired.text,
    ruleEvent: pair.ruleFired.name,
    newestClosedBarUtc: pair.latestBarUtc,
    newestClosedBarClose: pair.latestClose,
    fromCache: pair.fromCache,
    source,
    granularity,
    error: null,
  };
}

export type AppendResult = {
  appended: number;
  skipped: number;
  seq: number;
  logPath: string;
  /** True when nothing was written because there is no log file on this machine. */
  readOnly: boolean;
  /** Why nothing was written, when readOnly is true. */
  reason: string | null;
};

/**
 * Decide what this computation deserves in the log, and append it. Serialised
 * through a promise queue so two concurrent requests can never interleave writes
 * or race on the hash chain.
 */
export function recordFromPayload(payload: SignalsPayload): Promise<AppendResult> {
  const run = queue.then(
    () => appendForPayload(payload),
    () => appendForPayload(payload),
  );
  queue = run.catch(() => undefined);
  return run;
}

async function appendForPayload(payload: SignalsPayload): Promise<AppendResult> {
  // No log file on this machine means read-only: report it, never create one.
  const target = await appendTarget();
  if (!target.ok) {
    return {
      appended: 0,
      skipped: payload.pairs.length,
      seq: 0,
      logPath: configuredLogPath(),
      readOnly: true,
      reason: target.reason,
    };
  }

  const loaded = await loadState();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lines: string[] = [];
  let seq = loaded.seq;
  let prevHash = loaded.lastHash;
  let skipped = 0;

  for (const pair of payload.pairs) {
    const candidate = candidateFor(pair);
    const key = changeKeyOf(candidate);
    const previous = loaded.pairs.get(candidate.pair);
    const changed = !previous || previous.key !== key;
    const heartbeatDue =
      !previous || !Number.isFinite(previous.recordedAtMs) || nowMs - previous.recordedAtMs >= HEARTBEAT_SECONDS * 1000;

    if (!changed && !heartbeatDue) {
      skipped += 1;
      continue;
    }

    const kind: RecordKind = changed ? "change" : "heartbeat";
    const reason: RecordReason = !previous ? "first-record" : changed ? "state-changed" : "heartbeat-due";
    seq += 1;
    const fields = { ...candidate, seq, recordedAt: nowIso, kind, reason, prevHash };
    const hash = await hashRecord(fields);
    const record: SignalRecord = { ...fields, hash };
    lines.push(JSON.stringify(record));
    prevHash = hash;
    loaded.pairs.set(candidate.pair, { key, recordedAtMs: nowMs });
  }

  if (lines.length > 0) {
    const { appendFile } = await fs();
    const path = configuredLogPath();
    // One appendFile of one complete, newline-terminated buffer. Never a rewrite,
    // and never a mkdir: the file's directory already exists because the file does.
    const body = (loaded.torn ? "\n" : "") + lines.join("\n") + "\n";
    await appendFile(path, body, { encoding: "utf8", mode: 0o664 });
    loaded.torn = false;
  }

  loaded.seq = seq;
  loaded.lastHash = prevHash;

  return {
    appended: lines.length,
    skipped,
    seq,
    logPath: configuredLogPath(),
    readOnly: false,
    reason: null,
  };
}

/* ------------------------------------------------------------------- verifying */

/**
 * Walk the whole log in order. For each record: recompute its hash from its own
 * fields and check that its prevHash is the previous record's hash. Reports either
 * "chain intact, N records" or the FIRST break, with its 1-based line number.
 *
 * What this proves: no accidental edit, no reordering, no deletion, and no edit
 * made after someone holds an earlier copy — any of those changes the chain from
 * that line on. What it cannot do: stop whoever controls the file from rewriting
 * the entire chain and recomputing every hash.
 */
export async function verifyChain(): Promise<VerifyResult> {
  const { text } = await readLogRaw();
  const endsWithNewline = text.endsWith("\n");
  const contentLines = text === "" ? [] : text.split("\n").slice(0, endsWithNewline ? -1 : undefined);

  let expectedPrev = GENESIS_HASH;
  let recordsChecked = 0;
  let recordCount = 0;
  let firstBreak: { line: number; reason: string } | null = null;
  let lastHash: string | null = null;
  let maxGapSeconds: number | null = null;
  let firstRecordedAt: string | null = null;
  let lastRecordedAt: string | null = null;
  let previousMs: number | null = null;
  let tornTrailingLine = false;

  for (let i = 0; i < contentLines.length; i++) {
    const lineNumber = i + 1;
    const raw = contentLines[i]!;
    if (raw.trim() === "") continue;
    recordCount += 1;

    const record = parseLine(raw);
    if (!record) {
      const isLast = i === contentLines.length - 1;
      if (isLast && !endsWithNewline) {
        // A torn final write: no terminating newline, so no complete record. Not a
        // chain break — the chain is verified up to the last complete line.
        tornTrailingLine = true;
        continue;
      }
      if (!firstBreak) firstBreak = { line: lineNumber, reason: "line is not valid JSON" };
      continue;
    }

    const { hash, ...fields } = record;
    const recomputed = await hashRecord(fields as unknown as Record<string, unknown>);
    const recordedAtMs = Date.parse(record.recordedAt);
    if (firstRecordedAt === null && Number.isFinite(recordedAtMs)) firstRecordedAt = record.recordedAt;
    if (Number.isFinite(recordedAtMs)) {
      if (previousMs !== null) {
        const gap = Math.max(0, Math.round((recordedAtMs - previousMs) / 1000));
        if (maxGapSeconds === null || gap > maxGapSeconds) maxGapSeconds = gap;
      }
      previousMs = recordedAtMs;
      lastRecordedAt = record.recordedAt;
    }

    if (!firstBreak && record.prevHash !== expectedPrev) {
      firstBreak = {
        line: lineNumber,
        reason: `prevHash ${String(record.prevHash).slice(0, 12)}… is not the previous record's hash ${expectedPrev.slice(0, 12)}…`,
      };
    } else if (!firstBreak && recomputed !== hash) {
      firstBreak = {
        line: lineNumber,
        reason: `record hash does not match its own fields (stored ${String(hash).slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)`,
      };
    }

    expectedPrev = typeof hash === "string" ? hash : expectedPrev;
    lastHash = expectedPrev;
    recordsChecked += 1;
  }

  return {
    ok: firstBreak === null,
    algorithm: HASH_ALGORITHM,
    logPath: configuredLogPath(),
    recordCount,
    recordsChecked,
    firstBreak,
    lastHash,
    maxGapSeconds,
    firstRecordedAt,
    lastRecordedAt,
    tornTrailingLine,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Verification cache: a full walk is repeated only when the bytes have actually
 * changed (a file's size+mtime, or a snapshot's copy time and size), so client
 * polling does not re-hash the log every minute. `cached: true` is reported on the
 * page so the shortcut is visible, not hidden.
 */
let verifyCache: { revision: string; result: VerifyResult } | null = null;

/** A cheap fingerprint of the bytes a read would return. */
async function logRevision(): Promise<string> {
  const raw = await readLogRaw();
  if (raw.origin === "none") return "none";
  if (raw.origin === "bundle") return `bundle:${raw.bundled?.copiedAt ?? "?"}:${String(raw.bytes)}`;
  const { stat } = await fs();
  try {
    const info = await stat(configuredLogPath());
    return `file:${String(info.size)}:${String(info.mtimeMs)}`;
  } catch {
    return `file:unknown:${String(raw.bytes)}`;
  }
}

export async function verifyChainCached(force = false): Promise<VerifyResult> {
  const revision = await logRevision();
  if (!force && verifyCache && verifyCache.revision === revision) {
    return { ...verifyCache.result, cached: true };
  }
  const result = await verifyChain();
  verifyCache = { revision, result };
  return { ...result, cached: false };
}

/* -------------------------------------------------------------------- reading */

export async function readRecords(limit: number): Promise<SignalRecord[]> {
  const { text } = await readLogRaw();
  const endsWithNewline = text.endsWith("\n");
  const contentLines = text === "" ? [] : text.split("\n").slice(0, endsWithNewline ? -1 : undefined);
  const out: SignalRecord[] = [];
  for (let i = contentLines.length - 1; i >= 0 && out.length < limit; i--) {
    const record = parseLine(contentLines[i]!);
    if (record) out.push(record);
  }
  return out;
}

export async function logSummary(): Promise<LogSummary> {
  const raw = await readLogRaw();
  const { text, bytes } = raw;
  const lines = text === "" ? [] : text.split("\n");
  let recordCount = 0;
  for (const line of lines) if (line.trim() !== "") recordCount += 1;

  let beginsAt: string | null = null;
  let lastRecordedAt: string | null = null;
  for (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    if (beginsAt === null) beginsAt = record.recordedAt;
    lastRecordedAt = record.recordedAt;
  }

  // For a snapshot, "how long ago" is measured against the moment the copy was taken,
  // not against now: a published snapshot is not stale, it is a dated snapshot, and
  // saying "6 days ago" about a file that was cut an hour before the build would be
  // the wrong story.
  const referenceMs =
    raw.origin === "bundle" && raw.bundled ? Date.parse(raw.bundled.copiedAt) : Date.now();
  const lastMs = lastRecordedAt === null ? null : Date.parse(lastRecordedAt);

  return {
    logPath: configuredLogPath(),
    origin: raw.origin,
    bundled: raw.bundled,
    available: raw.origin !== "none",
    recordCount,
    beginsAt,
    lastRecordedAt,
    secondsSinceLastRecord:
      lastMs === null || !Number.isFinite(lastMs) || !Number.isFinite(referenceMs)
        ? null
        : Math.max(0, Math.round((referenceMs - lastMs) / 1000)),
    heartbeatSeconds: HEARTBEAT_SECONDS,
    fileBytes: bytes,
    empty: raw.origin !== "none" && recordCount === 0,
  };
}

/* ------------------------------------------------------------------ full read */

export type TrackRecordPayload = {
  generatedAt: string;
  rulesetVersion: string;
  log: LogSummary;
  integrity: VerifyResult & { note: string };
  records: SignalRecord[];
  recordsShown: number;
  limits: { default: number; max: number; verifyFull: boolean };
  about: {
    whatThisIs: string;
    begins: string;
    notPerformance: string;
    tamperEvidentNotProof: string;
    heartbeat: string;
  };
};

const ABOUT = {
  whatThisIs:
    "An append-only JSONL log of what this signals engine said, one line per record, written from the server when the signals were computed. It is written on a change (signal, entry, stop, target or trigger bar) and at least once an hour per pair even when nothing changed — including when the price source is failing — so a quiet log can never be confused with a stopped engine.",
  begins:
    "The log begins on the date its first record was written, and it contains NOTHING before that. There is no history in it that predates the day recording started.",
  notPerformance:
    "It records what the engine SAID, not what any trade did. Nothing here is a trade, a fill or a result. No performance, accuracy or win-rate figure is calculated or implied anywhere on this page — none has been measured.",
  tamperEvidentNotProof:
    "Tamper-evident, not tamper-proof: each record carries a SHA-256 hash of its own fields plus the previous record's hash, so an accidental edit, a deletion, a reordering or any edit made after someone holds an earlier copy is detectable. It cannot stop whoever controls the file from rewriting the whole chain and recomputing every hash.",
  heartbeat:
    "A gap longer than the heartbeat interval means either the engine did not compute, or its records did not reach this file. Both are visible rather than silent.",
};

export const TRACK_RECORD_LIMITS = { default: 100, max: 500 };

export async function buildTrackRecordPayload(options: {
  limit?: number;
  verifyFull?: boolean;
  rulesetVersion: string;
}): Promise<TrackRecordPayload> {
  const limit = Math.min(Math.max(options.limit ?? TRACK_RECORD_LIMITS.default, 1), TRACK_RECORD_LIMITS.max);
  const [summary, integrity, records] = await Promise.all([
    logSummary(),
    verifyChainCached(options.verifyFull === true),
    readRecords(limit),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    rulesetVersion: options.rulesetVersion,
    log: summary,
    integrity: { ...integrity, note: ABOUT.tamperEvidentNotProof },
    records,
    recordsShown: records.length,
    limits: { default: TRACK_RECORD_LIMITS.default, max: TRACK_RECORD_LIMITS.max, verifyFull: options.verifyFull === true },
    about: ABOUT,
  };
}
