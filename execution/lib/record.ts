/**
 * Append-only execution record: /home/team/shared/execution/orders.jsonl
 *
 * Separate from the signal log (/home/team/shared/signal-log/signals.jsonl). Same
 * hash-chain construction as the signal log so tampering is evident: each line
 * carries prevHash (the previous line's hash) and hash (SHA-256 over the canonical
 * record including prevHash).
 *
 * Two properties beyond the signal log:
 *  - every payload is passed through redactDeep() before hashing, so the credential
 *    cannot be written even by accident, and a post-write assertion re-reads the
 *    line and throws if the token appears in it;
 *  - the file is opened with O_APPEND and each line is written in a single call, so
 *    concurrent writers cannot interleave within a line.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { redactDeep } from "./client.ts";

import { recordPath } from "./paths.ts";
export { recordPath };

export const GENESIS_PREV_HASH = "0".repeat(64);

export type RecordKind =
  | "SESSION_START"
  | "INTERLOCK_ATTEST"
  | "ACCOUNT_READ"
  | "CONFIG_RESOLVED"
  | "INSTRUCTION_RECEIVED"
  | "VALIDATION_REFUSED"
  | "NO_ELIGIBLE_STRATEGY"
  | "SIGNALS_ONLY"
  | "DUPLICATE_SUPPRESSED"
  | "ORDER_REQUESTED"
  | "ORDER_ACKNOWLEDGED"
  | "ORDER_REJECTED"
  | "FILL"
  | "PARTIAL_FILL"
  | "PROTECTED"
  | "CONNECTION_FAILURE"
  | "RETRY_DECISION"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "CLOSE_REQUESTED"
  | "CLOSED"
  | "PAUSE_SET"
  | "PAUSE_CLEARED"
  | "CONTROL_REFUSED"
  | "RECONCILIATION"
  | "BROKER_STATE_READ"
  /** Realised risk at the broker fill, recorded next to the budgeted figure. */
  | "REALISED_RISK";

export type ExecutionRecord = {
  seq: number;
  recordedAt: string;
  kind: RecordKind;
  signalId: string | null;
  strategyId: string | null;
  strategyVersion: string | null;
  /** Stable idempotency key for the signal, when one exists. */
  orderKey: string | null;
  /** Meridian's lifecycle state for this order/signal at this point. */
  state: string | null;
  /** Everything else, already redacted. */
  payload: unknown;
  prevHash: string;
  hash: string;
};

export function canonical(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function hashRecord(fieldsWithPrevHash: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonical(fieldsWithPrevHash));
}

export async function readRecords(path = recordPath()): Promise<ExecutionRecord[]> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const text = await readFile(path, "utf8");
  const out: ExecutionRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      throw new Error("Execution record contains malformed JSON; submissions require operator inspection");
    }
  }
  return out;
}

export type VerifyResult = {
  ok: boolean;
  recordCount: number;
  algorithm: string;
  logPath: string;
  verifiedAt: string;
  firstBreak: { line: number; seq: number; reason: string } | null;
  lastHash: string;
};

export async function verifyChain(path = recordPath()): Promise<VerifyResult> {
  const records = await readRecords(path);
  let expectedPrev = GENESIS_PREV_HASH;
  let firstBreak: VerifyResult["firstBreak"] = null;
  let index = 0;
  for (const rec of records) {
    index += 1;
    if (rec.seq !== index) {
      firstBreak = { line: index, seq: rec.seq, reason: `seq ${rec.seq} is not the expected ${index}` };
      break;
    }
    if (rec.prevHash !== expectedPrev) {
      firstBreak = {
        line: index,
        seq: rec.seq,
        reason: `prevHash ${rec.prevHash.slice(0, 12)}… is not the previous record's hash ${expectedPrev.slice(0, 12)}…`,
      };
      break;
    }
    const { hash, ...rest } = rec;
    const recomputed = await hashRecord(rest as unknown as Record<string, unknown>);
    if (recomputed !== hash) {
      firstBreak = { line: index, seq: rec.seq, reason: `record content does not match its hash (recomputed ${recomputed.slice(0, 12)}…)` };
      break;
    }
    expectedPrev = rec.hash;
  }
  return {
    ok: firstBreak === null,
    recordCount: records.length,
    algorithm: "SHA-256 over canonical JSON (sorted keys, no whitespace), chained by prevHash",
    logPath: path,
    verifiedAt: new Date().toISOString(),
    firstBreak,
    lastHash: expectedPrev,
  };
}

let writeLock: Promise<unknown> = Promise.resolve();

export type AppendInput = {
  kind: RecordKind;
  signalId?: string | null;
  strategyId?: string | null;
  strategyVersion?: string | null;
  orderKey?: string | null;
  state?: string | null;
  payload: unknown;
};

/**
 * Append one record. Serialised through a promise chain so two concurrent appends
 * in this process cannot read the same "last hash" and fork the chain.
 */
export async function appendRecord(input: AppendInput, path = recordPath()): Promise<ExecutionRecord> {
  const run = async (): Promise<ExecutionRecord> => {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const existing = await readRecords(path);
    const last = existing[existing.length - 1];
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_PREV_HASH;
    const fields = {
      seq,
      recordedAt: new Date().toISOString(),
      kind: input.kind,
      signalId: input.signalId ?? null,
      strategyId: input.strategyId ?? null,
      strategyVersion: input.strategyVersion ?? null,
      orderKey: input.orderKey ?? null,
      state: input.state ?? null,
      payload: redactDeep(input.payload),
      prevHash,
    };
    const hash = await hashRecord(fields as unknown as Record<string, unknown>);
    const record: ExecutionRecord = { ...(fields as any), hash };
    const line = JSON.stringify(record) + "\n";
    const secret = process.env.OANDA ?? "";
    if (secret.length >= 8 && line.includes(secret)) {
      throw new Error("REFUSED to append: the credential appears in the serialised record.");
    }
    await appendFile(path, line, { encoding: "utf8", flag: "a" });
    return record;
  };
  const chained = writeLock.then(run, run);
  writeLock = chained.catch(() => undefined);
  return chained;
}

/** Replay: the latest record per signal id, plus the full event list. */
export async function replay(path = recordPath()): Promise<{
  bySignal: Map<string, ExecutionRecord[]>;
  byOrderKey: Map<string, ExecutionRecord[]>;
  all: ExecutionRecord[];
}> {
  const all = await readRecords(path);
  const bySignal = new Map<string, ExecutionRecord[]>();
  const byOrderKey = new Map<string, ExecutionRecord[]>();
  for (const rec of all) {
    if (rec.signalId) {
      if (!bySignal.has(rec.signalId)) bySignal.set(rec.signalId, []);
      bySignal.get(rec.signalId)!.push(rec);
    }
    if (rec.orderKey) {
      if (!byOrderKey.has(rec.orderKey)) byOrderKey.set(rec.orderKey, []);
      byOrderKey.get(rec.orderKey)!.push(rec);
    }
  }
  return { bySignal, byOrderKey, all };
}
