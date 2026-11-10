/**
 * The execution engine: the order path.
 *
 * Order of checks on every signal, in this order and no other:
 *
 *   1. settings     — every required setting must be set, else refuse naming it
 *   2. mode         — signals-only submits nothing, ever
 *   3. strategy     — no enabled strategy ⇒ NO_ELIGIBLE_STRATEGY, submit nothing
 *   4. instruction  — complete and unexpired, else refuse naming the field
 *   5. pause        — a pause blocks new entries (and nothing else)
 *   6. duplicate    — stable key, checked against the record AND the broker
 *   7. pre-flight   — price and account state re-fetched immediately before submit
 *   8. guards       — spread, entry deviation, trading hours, max positions, daily loss
 *   9. sizing       — units from stop distance, equity, account currency
 *  10. submit       — protection attached IN THE SAME REQUEST
 *  11. confirm      — read the trade back from the broker; PROTECTED only when the
 *                     broker's own object shows the stop
 */

import { type Client, type BrokerResponse, type BrokerFailure } from "./client.ts";
import { createHash } from "node:crypto";
import { PRACTICE_HOST, assertPracticeTarget, interlockStatement } from "./interlock.ts";
import { appendRecord, replay, readRecords, type ExecutionRecord } from "./record.ts";
import {
  loadConfigFromDisk,
  type ExecutionConfig,
  type ResolvedSettings,
  resolveSettings,
  TEST_PROFILE,
  DEMO_TEST_LABEL,
} from "./config.ts";
import {
  validateInstruction,
  sizePosition,
  formatPrice,
  farSideEntryPrice,
  pipSize,
  type SignalInstruction,
  type InstrumentMeta,
  type Quote,
} from "./instruction.ts";
import { appendRealisedRisk, appendUnmeasuredRisk, computeRealisedRisk, riskAtPrice, RISK_EPSILON, dailyLossBudget } from "./risk.ts";
import { carriedForwardFromRecord, SUBMISSION_KINDS } from "./rotation.ts";

export const MERIDIAN_TAG = "MERIDIAN-PRACTICE-TEST";
export const MANAGED_ID_PREFIX = "msig-";

export type EngineState =
  | "SIGNALS_ONLY"
  | "NO_ELIGIBLE_STRATEGY"
  | "REFUSED_SETTINGS"
  | "REFUSED_INSTRUCTION"
  | "PAUSED"
  | "DUPLICATE_SUPPRESSED"
  | "REFUSED_GUARD"
  /** Refused at the last moment because filling at the current price would risk more than the cap. */
  | "REFUSED_RISK_RECHECK"
  | "REQUESTED"
  | "ACKNOWLEDGED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "PROTECTED"
  | "REJECTED"
  | "CANCELLED"
  | "CLOSED"
  | "UNAVAILABLE";

export type Outcome = {
  state: EngineState;
  ok: boolean;
  signalId: string | null;
  orderKey: string | null;
  reasons: string[];
  detail: Record<string, unknown>;
};

/* ------------------------------------------------------------------ helpers */

export function idempotencyKey(instruction: Pick<SignalInstruction, "signalId" | "strategyId" | "strategyVersion" | "instrument" | "direction">): string {
  const material = [instruction.signalId, instruction.strategyId, instruction.strategyVersion, instruction.instrument, instruction.direction].join("|");
  return `${MANAGED_ID_PREFIX}${sha256(material).slice(0, 24)}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function isTransportFailure(r: BrokerResponse | BrokerFailure): r is BrokerFailure {
  return (r as BrokerFailure).transportFailure === true;
}

/**
 * Is this broker object Meridian's?
 *
 * Measured, not assumed: OANDA does NOT copy an order's clientExtensions onto the
 * trade that order opens — the trade comes back with clientExtensions: null. What it
 * DOES carry is the clientExtensions of the protective orders attached at entry, so
 * the stop (-sl) and take-profit (-tp) legs are the reliable marker for a trade.
 * Orders carry their own tag directly.
 *
 * A trade whose protective orders have been removed therefore loses its broker-side
 * marker. That is not hypothetical: it happened during verification. So identity also
 * comes from the append-only record — `knownTradeIds` is the set of trade ids Meridian
 * recorded opening. A trade is Meridian's if EITHER marker says so.
 */
export function isManaged(
  entity: { clientExtensions?: { id?: string; tag?: string }; stopLossOrder?: any; takeProfitOrder?: any; id?: string } | undefined,
  knownTradeIds?: Set<string>,
): boolean {
  if (!entity) return false;
  const direct = entity.clientExtensions;
  if (direct?.tag === MERIDIAN_TAG && typeof direct.id === "string" && direct.id.startsWith(MANAGED_ID_PREFIX)) return true;
  for (const leg of [entity.stopLossOrder, entity.takeProfitOrder]) {
    const ce = leg?.clientExtensions;
    if (ce?.tag === MERIDIAN_TAG && typeof ce.id === "string" && ce.id.startsWith(MANAGED_ID_PREFIX)) return true;
  }
  if (knownTradeIds && entity.id !== undefined && knownTradeIds.has(String(entity.id))) return true;
  return false;
}

/** Trade ids Meridian recorded opening, from the append-only record. */
export async function managedTradeIdsFromRecord(): Promise<Set<string>> {
  const { all } = await replay();
  const ids = new Set<string>();
  for (const r of all) {
    if (r.kind !== "FILL" && r.kind !== "PARTIAL_FILL") continue;
    const p = (r.payload ?? {}) as any;
    const id = p.tradeId ?? p.tradeOpened?.tradeID;
    if (id !== undefined && id !== null) ids.add(String(id));
  }
  // Trade ids from archived segments. Without this a rotation would make a trade Meridian
  // opened before the rotation invisible to `isManaged()`, so it would be treated as an
  // external manual trade — the opposite of the truth. See lib/rotation.ts.
  for (const id of (await carriedForwardFromRecord()).knownTradeIds) ids.add(id);
  return ids;
}

export async function loadConfig(path?: string): Promise<ExecutionConfig> {
  return loadConfigFromDisk(path);
}

/* ---------------------------------------------------------------- attestation */

export type Attestation = {
  ok: boolean;
  practiceHost: string;
  practiceProbe: { status: number; ok: boolean; accountsSeen: number };
  liveProbe: { host: string; status: number; refused: boolean; errorMessage: string | null };
  statement: ReturnType<typeof interlockStatement>;
  checkedAt: string;
};

/**
 * Ask the LIVE host the same question with the same token, and require it to refuse.
 *
 * The live probe deliberately does NOT go through the client (which would refuse the
 * host). It uses a bare fetch to a hard-coded live URL for one GET /v3/accounts, the
 * cheapest possible read, with the token in a header. No order can be built against
 * that host: the client has no code path that will accept it.
 *
 * If the live host ever answers 200, this token can move real money and the engine
 * fails closed — `ok` is false and every submit refuses.
 */
export async function attest(client: Client): Promise<Attestation> {
  const practiceRes = await client.accounts();
  let practiceProbe = { status: 0, ok: false, accountsSeen: 0 };
  if (!isTransportFailure(practiceRes)) {
    practiceProbe = {
      status: practiceRes.status,
      ok: practiceRes.ok,
      accountsSeen: Array.isArray(practiceRes.body?.accounts) ? practiceRes.body.accounts.length : 0,
    };
  }

  const liveHost = "https://api-fxtrade.oanda.com/v3/accounts";
  let liveProbe: Attestation["liveProbe"] = { host: liveHost, status: 0, refused: false, errorMessage: null };
  try {
    const res = await fetch(liveHost, {
      headers: { Authorization: `Bearer ${(process.env.OANDA ?? "").trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let msg: string | null = null;
    try {
      msg = (JSON.parse(text) as { errorMessage?: string }).errorMessage ?? null;
    } catch {
      msg = text.slice(0, 200);
    }
    liveProbe = { host: liveHost, status: res.status, refused: res.status === 401 || res.status === 403, errorMessage: msg };
  } catch (error) {
    liveProbe = {
      host: liveHost,
      status: 0,
      refused: false, // a network error is not proof that a token was rejected
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const ok = practiceProbe.ok && liveProbe.refused;
  const attestation: Attestation = {
    ok,
    practiceHost: PRACTICE_HOST,
    practiceProbe,
    liveProbe,
    statement: interlockStatement(),
    checkedAt: new Date().toISOString(),
  };
  await appendRecord({
    kind: "INTERLOCK_ATTEST",
    state: ok ? "PASSED" : "FAILED_CLOSED",
    payload: attestation,
  });
  return attestation;
}

/* -------------------------------------------------------------- account read */

export type AccountSnapshot = {
  id: string;
  currency: string;
  balance: number;
  nav: number;
  marginAvailable: number;
  marginUsed: number;
  openPositionCount: number;
  openTradeCount: number;
  pendingOrderCount: number;
  unrealizedPL: number;
  lastTransactionID: string;
  readAt: string;
  /** The broker's open trade ids, when the caller read them. Omitted when unknown. */
  openTradeIds?: string[];
};

/**
 * AN ACCOUNT POLL IS EVIDENCE ONLY WHEN IT SAYS SOMETHING NEW.
 *
 * The watcher polls the account every 10 seconds, and each poll used to append an
 * ACCOUNT_READ record whether or not anything had changed. Measured 2026-11-10: the
 * record grew ~4.3 MB/day while the account was flat (NAV unchanged, no open trade, no
 * order), of which ~600 of 636 records were identical account polls — on a disk with
 * 334 MB free, a few months from filling it and taking the site, the watcher and the
 * console down with it.
 *
 * The rule now, and it is the whole rule:
 *  - a read is recorded when it differs MATERIALLY from the last recorded read — NAV,
 *    balance, unrealised P/L, open trade count, or the set of open trade ids;
 *  - when nothing material has changed, one is recorded at most every 5 minutes, so a
 *    quiet account still leaves a dated heartbeat rather than silence;
 *  - the first read is always recorded;
 *  - NOTHING ELSE IS SUPPRESSED. Every instruction, order, acknowledgement, fill,
 *    protection, close, refusal and error still appends immediately and is never subject
 *    to this rule — the throttle is applied in `readAccount` and nowhere else, so it
 *    cannot touch the append path an execution event uses.
 *
 * Comparison is by the named fields only, never by timestamp: two polls of an unchanged
 * account differ in `readAt` and must still count as the same state.
 */
export const ACCOUNT_READ_HEARTBEAT_MS = 5 * 60_000;
/** One hundredth of a currency unit. Below this, a difference is float noise, not a change. */
const ACCOUNT_READ_MONEY_EPSILON = 0.0001;

export type AccountReadDecision = {
  append: boolean;
  reason: "FIRST_READ" | "MATERIAL_CHANGE" | "HEARTBEAT" | "UNCHANGED" | "UNREADABLE_PREVIOUS";
  /** The material fields that moved, e.g. ["nav"]. Empty when nothing did. */
  changed: string[];
  /** When the current unchanged stretch began; null when this read is itself a change. */
  unchangedSince: string | null;
};

function moneyChanged(a: unknown, b: unknown): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) !== String(b);
  return Math.abs(x - y) > ACCOUNT_READ_MONEY_EPSILON;
}

/**
 * A different SET of ids is a change even when the count is the same (one trade closed and
 * another opened between polls). When either side did not read the ids, the set is unknown
 * on that side and is not counted as a change — an unknown is not evidence of movement.
 */
function tradeIdsChanged(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const x = [...new Set(a.map(String))].sort();
  const y = [...new Set(b.map(String))].sort();
  if (x.length !== y.length) return true;
  return x.some((value, index) => value !== y[index]);
}

/** The material differences between two account reads. Empty means "the same state". */
export function accountReadChanges(previous: Record<string, unknown> | null, next: Record<string, unknown>): string[] {
  if (!previous) return ["no previous account read recorded"];
  const changed: string[] = [];
  if (moneyChanged(previous.nav, next.nav)) changed.push("nav");
  if (moneyChanged(previous.balance, next.balance)) changed.push("balance");
  if (moneyChanged(previous.unrealizedPL, next.unrealizedPL)) changed.push("unrealizedPL");
  if (Number(previous.openTradeCount) !== Number(next.openTradeCount)) changed.push("openTradeCount");
  if (tradeIdsChanged(previous.openTradeIds, next.openTradeIds)) changed.push("openTradeIds");
  return changed;
}

/**
 * Should this read be appended? Pure, so the heartbeat boundary can be tested without
 * waiting five minutes. `previous` is the last ACCOUNT_READ already in the record.
 */
export function decideAccountReadAppend(input: {
  previous: { payload: unknown; recordedAt: string } | null;
  next: Record<string, unknown>;
  nowMs?: number;
  heartbeatMs?: number;
}): AccountReadDecision {
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatMs = input.heartbeatMs ?? ACCOUNT_READ_HEARTBEAT_MS;
  if (!input.previous) return { append: true, reason: "FIRST_READ", changed: [], unchangedSince: null };
  const changed = accountReadChanges((input.previous.payload ?? {}) as Record<string, unknown>, input.next);
  if (changed.length > 0) return { append: true, reason: "MATERIAL_CHANGE", changed, unchangedSince: null };
  const lastMs = Date.parse(input.previous.recordedAt);
  // An unreadable timestamp is treated as "long enough": record rather than stay silent.
  if (!Number.isFinite(lastMs) || nowMs - lastMs >= heartbeatMs) {
    return { append: true, reason: "HEARTBEAT", changed: [], unchangedSince: input.previous.recordedAt };
  }
  return { append: false, reason: "UNCHANGED", changed: [], unchangedSince: input.previous.recordedAt };
}

/**
 * When the current run of unchanged reads began: walk back over the recorded account polls
 * while each still matches `next`, and take the earliest one. Non-account events in between
 * do not end the stretch — the account state is what is being compared, not the record.
 */
function unchangedStretchStart(records: ExecutionRecord[], next: Record<string, unknown>): string | null {
  let start: string | null = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.kind !== "ACCOUNT_READ") continue;
    if (accountReadChanges((record.payload ?? {}) as Record<string, unknown>, next).length > 0) break;
    start = record.recordedAt;
  }
  return start;
}

export type AccountReadResult =
  | { ok: true; account: AccountSnapshot; recorded: boolean; recordReason: AccountReadDecision["reason"]; changes: string[] }
  | { ok: false; reason: string; detail: unknown };

export async function readAccount(client: Client, options: { openTradeIds?: string[] } = {}): Promise<AccountReadResult> {
  const res = await client.summary();
  if (isTransportFailure(res)) return { ok: false, reason: "ACCOUNT_READ_FAILED", detail: res.error };
  if (!res.ok) return { ok: false, reason: "ACCOUNT_READ_FAILED", detail: { status: res.status, text: res.text } };
  const a = res.body?.account;
  if (!a || !Number.isFinite(Number(a.NAV)) || Number(a.NAV) <= 0 || !Number.isFinite(Number(a.marginAvailable)) || typeof a.currency !== "string") return { ok: false, reason: "ACCOUNT_READ_FAILED", detail: "Malformed account state" };
  const account: AccountSnapshot = {
    id: a.id,
    currency: a.currency,
    balance: Number(a.balance),
    nav: Number(a.NAV),
    marginAvailable: Number(a.marginAvailable),
    marginUsed: Number(a.marginUsed),
    openPositionCount: Number(a.openPositionCount),
    openTradeCount: Number(a.openTradeCount),
    pendingOrderCount: Number(a.pendingOrderCount),
    unrealizedPL: Number(a.unrealizedPL),
    lastTransactionID: String(a.lastTransactionID),
    readAt: new Date().toISOString(),
    ...(options.openTradeIds ? { openTradeIds: [...new Set(options.openTradeIds.map(String))].sort() } : {}),
  };

  let decision: AccountReadDecision;
  let unchangedSince: string | null = null;
  try {
    const records = await readRecords();
    let previous: ExecutionRecord | null = null;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].kind === "ACCOUNT_READ") {
        previous = records[i];
        break;
      }
    }
    decision = decideAccountReadAppend({
      previous: previous ? { payload: previous.payload, recordedAt: previous.recordedAt } : null,
      next: account as unknown as Record<string, unknown>,
    });
    if (decision.append) unchangedSince = unchangedStretchStart(records, account as unknown as Record<string, unknown>);
  } catch (error) {
    // A record we cannot read is not a reason to stay silent: record the read and say so.
    decision = { append: true, reason: "UNREADABLE_PREVIOUS", changed: [`previous record unreadable: ${String(error)}`], unchangedSince: null };
  }

  if (decision.append) {
    await appendRecord({
      kind: "ACCOUNT_READ",
      state: "OK",
      payload: {
        ...account,
        readDecision: decision.reason,
        ...(decision.changed.length > 0 ? { changed: decision.changed } : {}),
        ...(decision.reason === "HEARTBEAT" ? { unchangedSince: unchangedSince ?? decision.unchangedSince } : {}),
      },
    });
  }
  return { ok: true, account, recorded: decision.append, recordReason: decision.reason, changes: decision.changed };
}

export async function readInstruments(client: Client): Promise<Record<string, InstrumentMeta>> {
  const res = await client.instruments();
  if (isTransportFailure(res) || !res.ok) return {};
  const out: Record<string, InstrumentMeta> = {};
  for (const i of res.body.instruments ?? []) {
    out[i.name] = {
      name: i.name,
      displayPrecision: i.displayPrecision,
      tradeUnitsPrecision: i.tradeUnitsPrecision,
      minimumTradeSize: i.minimumTradeSize,
      maximumOrderUnits: i.maximumOrderUnits,
      marginRate: i.marginRate,
    };
  }
  return out;
}

export async function readQuotes(client: Client, instruments: string[]): Promise<Record<string, Quote>> {
  if (instruments.length === 0) return {};
  const res = await client.pricing(instruments);
  if (isTransportFailure(res) || !res.ok) return {};
  const out: Record<string, Quote> = {};
  for (const p of res.body.prices ?? []) {
    const bid = Number(p.bids?.[0]?.price);
    const ask = Number(p.asks?.[0]?.price);
    out[p.instrument] = {
      instrument: p.instrument,
      bid,
      ask,
      mid: (bid + ask) / 2,
      tradeable: p.tradeable === true,
      time: p.time,
      spreadPips: (ask - bid) / pipSize(p.instrument),
    };
  }
  return out;
}

/* ------------------------------------------------------------------- pause */

import { readFile, writeFile, mkdir } from "node:fs/promises";

import { executionDir, pausePath, dayStatePath } from "./paths.ts";

export async function readPause(): Promise<{ paused: boolean; reason: string | null; setAt: string | null }> {
  try {
    const raw = JSON.parse(await readFile(pausePath(), "utf8"));
    return { paused: raw.paused === true, reason: raw.reason ?? null, setAt: raw.setAt ?? null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paused: false, reason: null, setAt: null };
    return { paused: true, reason: "Pause state is unreadable; operator inspection required", setAt: null };
  }
}

export async function writePause(paused: boolean, reason: string | null): Promise<void> {
  await mkdir(executionDir(), { recursive: true });
  await writeFile(pausePath(), JSON.stringify({ paused, reason, setAt: new Date().toISOString() }, null, 2), "utf8");
}

/* -------------------------------------------------------------- daily state */

/**
 * The day's opening NAV — the base the daily loss threshold is measured against.
 *
 * `source` says where the value came from, so a report can state it rather than assert it:
 *  - DAY_STATE_FILE: read back from a value written earlier today (the normal case);
 *  - FIRST_READ_OF_DAY: this is the first account read of the day, so the current NAV IS
 *    the opening NAV;
 *  - LEDGER_ROTATION: written by a rotation, which carries today's opening NAV forward
 *    (lib/rotation.ts) instead of letting a new file start the day again at the current NAV.
 */
export async function dayStartNav(nav: number): Promise<{ date: string; nav: number; source: string }> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = JSON.parse(await readFile(dayStatePath(), "utf8"));
    if (raw.date === today && Number.isFinite(raw.nav)) return { date: today, nav: raw.nav, source: String(raw.source ?? "DAY_STATE_FILE") };
  } catch {
    /* fall through */
  }
  await writeDayState({ date: today, nav, source: "FIRST_READ_OF_DAY" });
  return { date: today, nav, source: "FIRST_READ_OF_DAY" };
}

/**
 * Write the day state. Refuses to overwrite a value for the SAME day that is already on
 * disk unless `replace` is set: an opening NAV, once taken, is not re-taken.
 */
export async function writeDayState(state: {
  date: string;
  nav: number;
  source: string;
  carriedFrom?: string;
  realisedAtCutover?: number;
  openingNavFrom?: string | null;
}, opts: { replace?: boolean } = {}): Promise<void> {
  await mkdir(executionDir(), { recursive: true });
  if (!opts.replace) {
    try {
      const raw = JSON.parse(await readFile(dayStatePath(), "utf8"));
      if (raw.date === state.date && Number.isFinite(raw.nav)) return;
    } catch {
      /* no existing state: write it */
    }
  }
  await writeFile(dayStatePath(), JSON.stringify({ ...state, setAt: new Date().toISOString() }, null, 2), "utf8");
}

/* ------------------------------------------------------------------ evaluate */

export type Evaluation = {
  ok: boolean;
  state: EngineState;
  reasons: string[];
  instruction: SignalInstruction;
  orderKey: string;
  proposal: Record<string, unknown> | null;
  orderPayload: Record<string, unknown> | null;
};

/**
 * Everything up to (but excluding) the network write. Re-reads price and account
 * state itself, so it is safe to call immediately before submission.
 */
export async function evaluate(
  client: Client,
  instruction: SignalInstruction,
  config: ExecutionConfig,
  settings: ResolvedSettings,
): Promise<Evaluation> {
  const orderKey = idempotencyKey(instruction);
  const reasons: string[] = [];
  const base = { instruction, orderKey };

  // 1. settings
  if (!settings.allSet) {
    reasons.push(`Invalid or missing settings: ${[...settings.missing, ...settings.problems].join("; ")}`);
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "REFUSED_SETTINGS",
      payload: { reasons, missingSettings: settings.missing, mode: settings.mode },
    });
    return { ...base, ok: false, state: "REFUSED_SETTINGS", reasons, proposal: null, orderPayload: null };
  }

  // 2. mode
  if (settings.mode === "signals-only") {
    reasons.push("mode is signals-only: signals are displayed, nothing is submitted");
    await appendRecord({
      kind: "SIGNALS_ONLY",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "SIGNALS_ONLY",
      payload: { reasons, mode: settings.mode, modeSource: settings.modeSource },
    });
    return { ...base, ok: false, state: "SIGNALS_ONLY", reasons, proposal: null, orderPayload: null };
  }

  // 3. strategy eligibility
  const strategy = config.strategies.find((s) => s.id === instruction.strategyId && s.version === instruction.strategyVersion);
  const anyEnabled = config.strategies.some((s) => s.enabled);
  if (!anyEnabled) {
    reasons.push("NO_ELIGIBLE_STRATEGY: no strategy is enabled, so nothing is submitted");
    await appendRecord({
      kind: "NO_ELIGIBLE_STRATEGY",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "NO_ELIGIBLE_STRATEGY",
      payload: { reasons, strategies: config.strategies.map((s) => ({ id: s.id, version: s.version, enabled: s.enabled })) },
    });
    return { ...base, ok: false, state: "NO_ELIGIBLE_STRATEGY", reasons, proposal: null, orderPayload: null };
  }
  if (!strategy) {
    reasons.push(`NO_ELIGIBLE_STRATEGY: strategy ${instruction.strategyId}@${instruction.strategyVersion} is not a known strategy`);
    await appendRecord({
      kind: "NO_ELIGIBLE_STRATEGY",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "NO_ELIGIBLE_STRATEGY",
      payload: { reasons },
    });
    return { ...base, ok: false, state: "NO_ELIGIBLE_STRATEGY", reasons, proposal: null, orderPayload: null };
  }
  if (!strategy.enabled) {
    reasons.push(`NO_ELIGIBLE_STRATEGY: strategy ${strategy.id} is disabled (${strategy.note})`);
    await appendRecord({
      kind: "NO_ELIGIBLE_STRATEGY",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "NO_ELIGIBLE_STRATEGY",
      payload: { reasons },
    });
    return { ...base, ok: false, state: "NO_ELIGIBLE_STRATEGY", reasons, proposal: null, orderPayload: null };
  }

  // 4. instruction completeness
  const validation = validateInstruction(instruction);
  if (!validation.ok) {
    reasons.push(...validation.issues.map((i) => `${i.field}: ${i.reason}`));
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "REFUSED_INSTRUCTION",
      payload: { issues: validation.issues },
    });
    return { ...base, ok: false, state: "REFUSED_INSTRUCTION", reasons, proposal: null, orderPayload: null };
  }

  const ageMs = Date.now() - Date.parse(instruction.generatedAt);
  if (ageMs > Number(settings.values.signalExpirySeconds.value) * 1000) return { ...base, ok: false, state: "REFUSED_INSTRUCTION", reasons: ["Signal exceeds configured maximum age"], proposal: null, orderPayload: null };

  // 5. pause
  const pause = await readPause();
  if (pause.paused) {
    reasons.push(`PAUSED: new entries are paused (${pause.reason ?? "no reason given"}) since ${pause.setAt ?? "unknown"}; protective stops are untouched`);
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "PAUSED",
      payload: { reasons, pause },
    });
    return { ...base, ok: false, state: "PAUSED", reasons, proposal: null, orderPayload: null };
  }

  // 7. pre-flight reads — fresh price and account state, every time.
  const accountRes = await readAccount(client);
  if (!accountRes.ok) {
    reasons.push(`UNAVAILABLE: could not read account state (${JSON.stringify(accountRes.detail)})`);
    return { ...base, ok: false, state: "UNAVAILABLE", reasons, proposal: null, orderPayload: null };
  }
  const account = accountRes.account;
  const allowed = settings.values.allowedInstruments.value as string[];
  const meta = await readInstruments(client);
  const quoteCcy = instruction.instrument.split("_")[1] ?? "";
  // Conversion pairs are only requested when the quote currency is not the account
  // currency. Asking for a nonsense pair such as USD_USD makes OANDA reject the whole
  // pricing request, which would look like "no price" for the instrument we care about.
  const conversionPairs = quoteCcy === account.currency ? [] : [`${account.currency}_${quoteCcy}`, `${quoteCcy}_${account.currency}`].filter((pair) => meta[pair]);
  const quotes = await readQuotes(client, [...new Set([instruction.instrument, ...conversionPairs])]);
  const quote = quotes[instruction.instrument];

  if (!quote || !Number.isFinite(quote.mid) || quote.mid <= 0) {
    reasons.push(`UNAVAILABLE: no price for ${instruction.instrument}`);
    return { ...base, ok: false, state: "UNAVAILABLE", reasons, proposal: null, orderPayload: null };
  }

  const quoteAge = Date.now() - Date.parse(quote.time);
  if (!Number.isFinite(quoteAge) || quoteAge < -5000 || quoteAge > 30000 ||
      !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
    return { ...base, ok: false, state: "UNAVAILABLE", reasons: ["Broker quote is stale or malformed"], proposal: null, orderPayload: null };
  }

  // 8. guards
  const maxSpread = Number(settings.values.maxSpreadPips.value);
  const maxDeviation = Number(settings.values.maxEntryDeviationPips.value);
  const maxPositions = Number(settings.values.maxPositions.value);
  const maxExposurePct = Number(settings.values.maxCombinedExposurePct.value);
  const riskPct = Number(settings.values.riskPerTradePct.value);
  const times = settings.values.allowedTradingTimes.value as { days: string[]; fromUtc: string; toUtc: string };

  if (!allowed.includes(instruction.instrument)) {
    reasons.push(`GUARD_INSTRUMENT: ${instruction.instrument} is not in allowedInstruments (${allowed.join(", ")})`);
  }
  if (!quote.tradeable) reasons.push(`GUARD_NOT_TRADEABLE: OANDA reports ${instruction.instrument} as not tradeable right now`);
  if (quote.spreadPips > maxSpread) {
    reasons.push(`GUARD_SPREAD: spread ${quote.spreadPips.toFixed(2)} pips exceeds maxSpreadPips ${maxSpread}`);
  }
  const deviationPips = Math.abs(quote.mid - instruction.sourceBar.close) / pipSize(instruction.instrument);
  if (deviationPips > maxDeviation) {
    reasons.push(
      `GUARD_ENTRY_DEVIATION: price has moved ${deviationPips.toFixed(2)} pips from the signal bar close ${instruction.sourceBar.close}, beyond maxEntryDeviationPips ${maxDeviation}`,
    );
  }
  const now = new Date();
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getUTCDay()];
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  if (!times.days.includes(dayName) || hhmm < times.fromUtc || hhmm > times.toUtc) {
    reasons.push(`GUARD_TRADING_TIME: ${dayName} ${hhmm} UTC is outside allowedTradingTimes ${times.days.join("/")} ${times.fromUtc}-${times.toUtc}`);
  }

  const openTradesRes = await client.openTrades();
  if (isTransportFailure(openTradesRes) || !openTradesRes.ok || !Array.isArray(openTradesRes.body?.trades)) {
    return { ...base, ok: false, state: "UNAVAILABLE", reasons: ["Cannot verify open trades; new entries refused"], proposal: null, orderPayload: null };
  }
  const openTrades: any[] = openTradesRes.body.trades;
  if (openTrades.some((t) => t.instrument === instruction.instrument && !isManaged(t))) {
    reasons.push("GUARD_MANUAL_POSITION: external trade in this instrument; refusing possible netting or interference");
  }
  const knownTradeIds = await managedTradeIdsFromRecord();
  const managedOpen = openTrades.filter((t) => isManaged(t, knownTradeIds));
  if (managedOpen.length >= maxPositions) {
    reasons.push(`GUARD_MAX_POSITIONS: ${managedOpen.length} Meridian-managed position(s) open, maxPositions is ${maxPositions}`);
  }
  if (managedOpen.some((t) => t.instrument === instruction.instrument)) {
    reasons.push(`GUARD_EXISTING_POSITION: a Meridian-managed position in ${instruction.instrument} is already open; existingPositionRule="${instruction.existingPositionRule}"`);
  }

  const day = await dayStartNav(account.nav);
  const realised = await realisedToday();
  const unrealisedManaged = managedOpen.reduce((sum, t) => sum + Number(t.unrealizedPL ?? 0), 0);
  const budget = dailyLossBudget({
    openingNav: day.nav,
    realisedPnl: realised,
    unrealisedPnl: unrealisedManaged,
    thresholdPct: Number(settings.values.dailyLossThresholdPct.value),
  });
  const dayPnl = budget.dayPnl;
  const threshold = budget.threshold;
  if (budget.breached) {
    reasons.push(`GUARD_DAILY_LOSS: day P/L ${dayPnl.toFixed(2)} ${account.currency} has reached the daily threshold -${threshold.toFixed(2)} (${String(settings.values.dailyLossThresholdPct.value)}% of opening NAV ${day.nav.toFixed(2)}, source ${day.source ?? "day-state"})`);
  }

  const executablePrice = instruction.direction === "long" ? quote.ask : quote.bid;
  const priceBound = instruction.sourceBar.close + (instruction.direction === "long" ? 1 : -1) * maxDeviation * pipSize(instruction.instrument);
  if (instruction.direction === "long" ? executablePrice > priceBound : executablePrice < priceBound) reasons.push("GUARD_ENTRY_DEVIATION: executable price exceeds permitted entry bound");
  if (instruction.direction === "long" ? instruction.stopPrice >= executablePrice || instruction.takeProfitPrice <= executablePrice : instruction.stopPrice <= executablePrice || instruction.takeProfitPrice >= executablePrice) {
    reasons.push("GUARD_LEVELS: stop or target is on the wrong side of the executable price");
  }

  // 9. sizing
  const instrumentMeta = meta[instruction.instrument];
  if (!instrumentMeta) {
    reasons.push(`UNAVAILABLE: OANDA returned no instrument metadata for ${instruction.instrument}, so minimum size and precision are unknown`);
  }
  let sizing = null as ReturnType<typeof sizePosition> | null;
  if (instrumentMeta) {
    sizing = sizePosition({
      instrument: instruction.instrument,
      direction: instruction.direction,
      quote,
      stopPrice: instruction.stopPrice,
      nav: account.nav,
      accountCurrency: account.currency,
      meta: instrumentMeta,
      riskPerTradePct: riskPct,
      quotes,
      // Explicit, never inferred: absent means RISK. BROKER_MINIMUM reaches this point only
      // for origin CONNECTION_TEST — validateInstruction (step 4) has already refused it for
      // any other origin, so it cannot be smuggled onto a real trade.
      sizingMode: instruction.sizingMode ?? "RISK",
    });
    if (!sizing.ok) reasons.push(`SIZING_${sizing.reason}: ${sizing.detail}`);
  }

  if (reasons.length > 0 || !sizing || !sizing.ok || !instrumentMeta) {
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "REFUSED_GUARD",
      payload: { reasons, price: quote, account },
    });
    return { ...base, ok: false, state: "REFUSED_GUARD", reasons, proposal: null, orderPayload: null };
  }

  const exposureCap = (account.nav * maxExposurePct) / 100;
  const existingExposure = managedOpen.reduce((sum, t) => sum + Math.abs(Number(t.currentUnits ?? 0)) * Number(t.price ?? 0), 0);
  if (existingExposure + sizing.notionalAccountCurrency > exposureCap) {
    reasons.push(
      `GUARD_EXPOSURE: adding ${sizing.notionalAccountCurrency.toFixed(2)} ${account.currency} notional to existing ${existingExposure.toFixed(2)} would exceed maxCombinedExposure ${exposureCap.toFixed(2)} (${maxExposurePct}% of NAV)`,
    );
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "REFUSED_GUARD",
      payload: { reasons, sizing, account },
    });
    return { ...base, ok: false, state: "REFUSED_GUARD", reasons, proposal: null, orderPayload: null };
  }

  // 10. the order, with protection attached in the same request object.
  const orderPayload = buildOrderPayload(instruction, sizing.signedUnits, instrumentMeta, orderKey);
  // Bound the fill to the same executable-side price used by the risk fix.
  // A moved market may reject rather than fill beyond the approved risk basis.
  orderPayload.order.priceBound = formatPrice(sizing.entryPriceFar, instrumentMeta.displayPrecision);
  const riskCapAccountCurrency = (account.nav * riskPct) / 100;
  const proposal = {
    mode: settings.mode,
    modeSource: settings.modeSource,
    testProfile: settings.testProfileInUse,
    /** Which label supplied the risk settings that produced this order: OWNER, DEMO-TEST or TEST. */
    settingsProfile: settings.profileLabel,
    settingsProfileLabel: settings.profileLabel === "DEMO-TEST" ? DEMO_TEST_LABEL : settings.profileLabel,
    origin: instruction.origin,
    /** Which sizing mode produced `units`, and what it means. Stated, never inferred. */
    sizingMode: sizing.sizingMode,
    sizingModeNote:
      sizing.sizingMode === "BROKER_MINIMUM"
        ? "BROKER_MINIMUM: the units are the instrument's own minimumTradeSize, not the risk budget. Permitted only for origin CONNECTION_TEST, whose purpose is to prove the order path. Risk and notional below are derived FROM these units."
        : "RISK: the units are derived from the stop distance, NAV and riskPerTradePct — the only mode a real trade may use.",
    strategy: { id: strategy.id, version: strategy.version, label: strategy.label, enabled: strategy.enabled, note: strategy.note },
    instrument: instruction.instrument,
    direction: instruction.direction,
    units: sizing.units,
    signedUnits: sizing.signedUnits,
    /** The mid at sizing time. Recorded for reference only — the size is NOT derived from it. */
    entryPriceReference: quote.mid,
    /** The price the order is expected to fill at: ask for a long, bid for a short. */
    entryPriceFar: sizing.entryPriceFar,
    sizingBasis: sizing.sizingBasis,
    bid: quote.bid,
    ask: quote.ask,
    spreadPips: Number(quote.spreadPips.toFixed(2)),
    stopPrice: instruction.stopPrice,
    takeProfitPrice: instruction.takeProfitPrice,
    stopDistancePips: Number((sizing.riskPerUnitQuote / pipSize(instruction.instrument)).toFixed(1)),
    /** units × far-side stop distance × conversion: the risk being budgeted. 4 dp, so a
     * one-unit connection test's risk (a fraction of a cent) is not printed as 0.00 and then
     * compared against a realised figure it cannot equal. */
    riskAccountCurrency: Number(sizing.riskAccountCurrency.toFixed(4)),
    riskPctOfNav: Number(sizing.riskPctOfNav.toFixed(4)),
    riskPctSetting: riskPct,
    riskSettingSource: settings.values.riskPerTradePct.source,
    /** The configured maximum for one trade, which realised risk is checked against. */
    riskCapAccountCurrency: Number(riskCapAccountCurrency.toFixed(4)),
    riskCapPctOfNav: riskPct,
    /**
     * What the old mid-based sizing would have submitted for this same quote, and what it
     * would have risked at the far side. Kept so the defect and the fix are comparable in
     * the record itself rather than only in a report.
     */
    midBasis: {
      units: sizing.midBasis.units,
      stopDistancePips: Number((sizing.midBasis.riskPerUnitQuote / pipSize(instruction.instrument)).toFixed(1)),
      budgetedRiskAccountCurrency: Number(sizing.midBasis.riskAccountCurrency.toFixed(2)),
      riskAtFarSideAccountCurrency: Number(
        (sizing.midBasis.units * sizing.riskPerUnitQuote * sizing.quoteToAccountRate).toFixed(2),
      ),
      note: "the previous sizing, kept for comparison only; it risks more than riskCapAccountCurrency because the fill is on the far side of the spread it sized from",
    },
    quoteToAccountRate: sizing.quoteToAccountRate,
    notionalAccountCurrency: Number(sizing.notionalAccountCurrency.toFixed(2)),
    accountCurrency: account.currency,
    equity: account.nav,
    marginAvailable: account.marginAvailable,
    conversion: sizing.conversion,
    rounding: sizing.rounding,
    priceReadAt: quote.time,
    accountReadAt: account.readAt,
    idempotencyKey: orderKey,
    attachedProtection: {
      stopLossOnFill: orderPayload.order.stopLossOnFill,
      takeProfitOnFill: orderPayload.order.takeProfitOnFill,
      note: "attached in the same POST /v3/accounts/{id}/orders request as the entry — there is no follow-up call that could be lost",
    },
    orderPayload,
  };

  return { ...base, ok: true, state: "REQUESTED", reasons: [], proposal, orderPayload };
}

/**
 * Build the v20 order body. Called only from evaluate(), and it re-asserts the
 * practice target as its very last act before returning, so a caller cannot obtain a
 * submittable payload without the interlock having run.
 *
 * The broker-visible `comment` carries the instruction's origin, so the label travels with
 * the order itself and not only with our record: an order submitted for a connection test
 * reads `CONNECTION_TEST ...` at the broker, which is a different string from the invented
 * ruleset's `INVENTED_RULESET_TEST ...`. The sizing mode is in the proposal and the record
 * (it is not part of the broker's comment, whose 120-character budget is already spent on
 * origin, strategy and signal id).
 */
export function buildOrderPayload(
  instruction: SignalInstruction,
  signedUnits: number,
  meta: InstrumentMeta,
  orderKey: string,
): any {
  const payload = {
    order: {
      type: "MARKET",
      instrument: instruction.instrument,
      units: String(signedUnits),
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      clientExtensions: {
        id: orderKey,
        tag: MERIDIAN_TAG,
        comment: `${instruction.origin} ${instruction.strategyId}@${instruction.strategyVersion} signal ${instruction.signalId}`.slice(0, 120),
      },
      stopLossOnFill: {
        price: formatPrice(instruction.stopPrice, meta.displayPrecision),
        timeInForce: "GTC",
        clientExtensions: { id: `${orderKey}-sl`, tag: MERIDIAN_TAG, comment: "attached at entry" },
      },
      takeProfitOnFill: {
        price: formatPrice(instruction.takeProfitPrice, meta.displayPrecision),
        timeInForce: "GTC",
        clientExtensions: { id: `${orderKey}-tp`, tag: MERIDIAN_TAG, comment: "attached at entry" },
      },
    },
  };
  // The interlock's last line of defence: no payload exists unless the target is the
  // practice host. (The URL is rebuilt from the frozen constant by the client too.)
  assertPracticeTarget(`https://${PRACTICE_HOST}/v3/accounts/x/orders`);
  return payload;
}

/* --------------------------------------------------------------- duplicates */

export type DuplicateCheck = {
  duplicate: boolean;
  /** RECORD = the live segment; RECORD_ARCHIVE = carried forward from a closed segment. */
  foundIn: "RECORD" | "RECORD_ARCHIVE" | "BROKER_ORDER" | "BROKER_TRADE" | null;
  evidence: unknown;
};

/**
 * Duplicate prevention, in three independent places:
 *  - the live segment of the append-only record (works even if the broker has forgotten
 *    the order);
 *  - the order keys carried forward from every CLOSED segment (a rotation must not make a
 *    previously submitted key look new — see lib/rotation.ts);
 *  - the broker itself (works even if the record is lost).
 * Any one finding the key means no second order is sent.
 */
export async function checkDuplicate(client: Client, orderKey: string, _signalId: string): Promise<DuplicateCheck> {
  const { byOrderKey } = await replay();
  const existing = byOrderKey.get(orderKey) ?? [];
  const submitted = existing.filter((r) =>
    ["ORDER_REQUESTED", "ORDER_ACKNOWLEDGED", "FILL", "PARTIAL_FILL", "PROTECTED"].includes(r.kind),
  );
  if (submitted.length > 0) {
    return { duplicate: true, foundIn: "RECORD", evidence: submitted.map((r) => ({ seq: r.seq, kind: r.kind, state: r.state, recordedAt: r.recordedAt })) };
  }

  // Carried forward from archived segments. Same test applied to the same kinds, so the
  // guarantee is unchanged by rotation rather than re-implemented for it.
  const carried = await carriedForwardFromRecord();
  const archived = carried.orderKeys.find((k) => k.orderKey === orderKey);
  if (archived && archived.kinds.some((kind) => (SUBMISSION_KINDS as readonly string[]).includes(kind))) {
    return {
      duplicate: true,
      foundIn: "RECORD_ARCHIVE",
      evidence: {
        orderKey,
        kinds: archived.kinds.filter((kind) => (SUBMISSION_KINDS as readonly string[]).includes(kind)),
        state: archived.state,
        tradeId: archived.tradeId,
        lastRecordedAt: archived.lastRecordedAt,
        carriedFrom: carried.sources,
        note: "this key was submitted in a closed segment that has been archived; the checkpoint record (LEDGER_ROTATION, seq 1 of the live segment) carries it forward",
      },
    };
  }

  const ordersRes = await client.orders("ALL");
  if (isTransportFailure(ordersRes) || !ordersRes.ok || !Array.isArray(ordersRes.body?.orders)) throw new Error("Cannot verify broker orders for duplicate prevention");
  if (!isTransportFailure(ordersRes) && ordersRes.ok) {
    const hit = (ordersRes.body.orders ?? []).find((o: any) => o.clientExtensions?.id === orderKey);
    if (hit) return { duplicate: true, foundIn: "BROKER_ORDER", evidence: { id: hit.id, state: hit.state, type: hit.type, clientExtensions: hit.clientExtensions } };
  }
  const tradesRes = await client.openTrades();
  if (isTransportFailure(tradesRes) || !tradesRes.ok || !Array.isArray(tradesRes.body?.trades)) throw new Error("Cannot verify broker trades for duplicate prevention");
  if (!isTransportFailure(tradesRes) && tradesRes.ok) {
    const hit = (tradesRes.body.trades ?? []).find(
      (t: any) =>
        isManaged(t) &&
        [t.stopLossOrder?.clientExtensions?.id, t.takeProfitOrder?.clientExtensions?.id, t.clientExtensions?.id].some(
          (id: unknown) => typeof id === "string" && (id === orderKey || id.startsWith(orderKey)),
        ),
    );
    if (hit) return { duplicate: true, foundIn: "BROKER_TRADE", evidence: { id: hit.id, instrument: hit.instrument, currentUnits: hit.currentUnits, stopLossOrder: hit.stopLossOrder?.clientExtensions ?? null } };
  }
  return { duplicate: false, foundIn: null, evidence: null };
}

/* ------------------------------------------------------------ risk re-check */

export type RiskRecheck = { ok: boolean; state: EngineState; reasons: string[]; recheck: Record<string, unknown> };

/**
 * THE LAST POINT AT WHICH THE ORDER CAN STILL BE REFUSED.
 *
 * The size was derived from the far side of the spread read during evaluation. Between
 * that read and this call the price can move, and an approved unit count cannot be
 * re-sized at the last moment (that would submit something other than what the owner
 * approved). So the price is read once more and the order is refused if filling at the
 * price now available would risk more than the configured maximum.
 *
 * This is the ONLY refusal that is still possible. The entry is a MARKET order with
 * timeInForce FOK, filled inside the request that submits it, so once the POST has been
 * made there is no moment at which Meridian could refuse or cancel: a fill worse than the
 * far side is detected after the fact instead (lib/risk.ts, REALISED_RISK records).
 *
 * Unreadable price ⇒ no submission. Guessing here would be exactly the kind of assumption
 * the rest of this engine refuses to make.
 */
export async function recheckRiskBeforeSubmit(
  client: Client,
  instruction: SignalInstruction,
  proposal: Record<string, any> | null,
): Promise<RiskRecheck> {
  const checkedAt = new Date().toISOString();
  if (!proposal) {
    return { ok: false, state: "REFUSED_RISK_RECHECK", reasons: ["REFUSED_RISK_RECHECK: no proposal exists to re-check, so the risk cannot be confirmed"], recheck: { checkedAt } };
  }
  const units = Number(proposal.units);
  const stopPrice = Number(proposal.stopPrice);
  const rate = Number(proposal.quoteToAccountRate ?? 1);
  const cap = Number(proposal.riskCapAccountCurrency);
  const sizedAt = Number(proposal.entryPriceFar);
  const pip = pipSize(instruction.instrument);
  const farSide = instruction.direction === "long" ? "ask" : "bid";
  const base = {
    checkedAt,
    units,
    stopPrice,
    quoteToAccountRate: rate,
    sizedAtEntryPriceFar: sizedAt,
    capAccountCurrency: Number.isFinite(cap) ? cap : null,
  };

  const quotes = await readQuotes(client, [instruction.instrument]);
  const quote = quotes[instruction.instrument];
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
    return {
      ok: false,
      state: "UNAVAILABLE",
      reasons: [`UNAVAILABLE: could not re-read ${instruction.instrument} immediately before submission, so the risk at the price this order would fill at cannot be confirmed. Nothing was submitted.`],
      recheck: { ...base, quoteRead: false },
    };
  }

  const entryNow = farSideEntryPrice(instruction.direction, quote);
  const stopCrossed = instruction.direction === "long" ? entryNow <= stopPrice : entryNow >= stopPrice;
  const riskNow = riskAtPrice({ units, entryPrice: entryNow, stopPrice, quoteToAccountRate: rate });
  const adverseDrift = (instruction.direction === "long" ? entryNow - sizedAt : sizedAt - entryNow) / pip;
  const withinCap = Number.isFinite(cap) && !stopCrossed && riskNow <= cap + RISK_EPSILON;
  const recheck = {
    ...base,
    quoteRead: true,
    quoteTime: quote.time,
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    farSideUsed: farSide,
    entryPriceFarNow: entryNow,
    adverseDriftPips: Number(adverseDrift.toFixed(2)),
    riskAtCurrentFarSide: Number(riskNow.toFixed(4)),
    withinCap,
    stopAlreadyCrossed: stopCrossed,
  };

  if (!Number.isFinite(cap)) {
    return { ok: false, state: "REFUSED_RISK_RECHECK", reasons: ["REFUSED_RISK_RECHECK: the configured maximum risk could not be determined, so this order cannot be shown to be safe"], recheck };
  }
  if (stopCrossed) {
    return {
      ok: false,
      state: "REFUSED_RISK_RECHECK",
      reasons: [`REFUSED_RISK_RECHECK: the price available now (${farSide} ${entryNow}) is already through the stop ${stopPrice}, so the stop distance — and the risk — cannot be derived. Nothing was submitted.`],
      recheck,
    };
  }
  if (!withinCap) {
    return {
      ok: false,
      state: "REFUSED_RISK_RECHECK",
      reasons: [
        `REFUSED_RISK_RECHECK: at the price available now (${farSide} ${entryNow}) the approved ${units} units would risk ${riskNow.toFixed(2)} ${String(proposal.accountCurrency ?? "")}, above the configured maximum of ${cap.toFixed(2)} (${String(proposal.riskPctSetting ?? "")}% of NAV). The price moved ${adverseDrift.toFixed(2)} pips against the entry since the size was derived. Nothing was submitted.`,
      ],
      recheck,
    };
  }
  return { ok: true, state: "REQUESTED", reasons: [], recheck };
}

/* ------------------------------------------------------------------ submit */

export type SubmitResult = {
  state: EngineState;
  ok: boolean;
  orderKey: string;
  signalId: string;
  reasons: string[];
  proposal: Record<string, unknown> | null;
  broker: {
    orderId: string | null;
    tradeId: string | null;
    transactionId: string | null;
    ackStatus: number;
    ackJson: unknown;
    errorMessage: string | null;
  } | null;
  timing: { requestedAt: string; acknowledgedAt: string; roundTripMs: number; instructionToAckMs: number } | null;
  protection: unknown;
};

export function payloadHash(payload: unknown): string {
  return sha256(JSON.stringify(payload));
}

import { withSubmissionLock } from "./submissionLock.ts";

export async function submitSignal(...args: Parameters<typeof submitSignalUnlocked>): Promise<SubmitResult> {
  return withSubmissionLock(() => submitSignalUnlocked(...args));
}

async function submitSignalUnlocked(
  client: Client,
  instruction: SignalInstruction,
  config: ExecutionConfig,
  opts: { settings?: ResolvedSettings; approvedPayloadHash?: string } = {},
): Promise<SubmitResult> {
  const settings = resolveSettings(config);
  const { verifyChain } = await import("./record.ts");
  const chain = await verifyChain();
  if (!chain.ok) throw new Error("Execution record hash chain is invalid; submissions refused");
  if (config.problems.length) throw new Error(`Invalid execution config: ${config.problems.join("; ")}`);
  const orderKey = idempotencyKey(instruction);

  await appendRecord({
    kind: "INSTRUCTION_RECEIVED",
    signalId: instruction.signalId,
    strategyId: instruction.strategyId,
    strategyVersion: instruction.strategyVersion,
    orderKey,
    state: "RECEIVED",
    payload: { instruction, origin: instruction.origin, sizingMode: instruction.sizingMode ?? "RISK", mode: settings.mode },
  });

  // Duplicate check BEFORE anything else that could refuse the signal.
  //
  // "Have I already submitted this signal?" is a property of the signal, not of the
  // account state. Checking it after the position/guard checks would let an unrelated
  // guard (max positions, daily loss) answer first and mask the real reason a
  // resubmission must do nothing — which is exactly what happened in the first pass of
  // this verification. It is checked again immediately before the POST as well.
  const earlyDup = await checkDuplicate(client, orderKey, instruction.signalId);
  if (earlyDup.duplicate) {
    const reasons = [`duplicate suppressed: key ${orderKey} already exists (found in ${earlyDup.foundIn})`];
    await appendRecord({
      kind: "DUPLICATE_SUPPRESSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "DUPLICATE_SUPPRESSED",
      payload: { reasons, foundIn: earlyDup.foundIn, evidence: earlyDup.evidence, stage: "pre-evaluation" },
    });
    return {
      state: "DUPLICATE_SUPPRESSED",
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons,
      proposal: null,
      broker: null,
      timing: null,
      protection: null,
    };
  }

  const evaluation = await evaluate(client, instruction, config, settings);
  if (!evaluation.ok) {
    return {
      state: evaluation.state,
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons: evaluation.reasons,
      proposal: null,
      broker: null,
      timing: null,
      protection: null,
    };
  }

  if (config.mode === "approve-before-execution" && opts.approvedPayloadHash !== payloadHash(evaluation.orderPayload)) {
    return { state: "REFUSED_GUARD", ok: false, orderKey, signalId: instruction.signalId,
      reasons: ["Approval missing or order changed. Preview and approve the current payload hash."],
      proposal: evaluation.proposal, broker: null, timing: null, protection: null };
  }

  // 6. duplicate check, immediately before the write.
  const dup = await checkDuplicate(client, orderKey, instruction.signalId);
  if (dup.duplicate) {
    const reasons = [`duplicate suppressed: key ${orderKey} already exists (found in ${dup.foundIn})`];
    await appendRecord({
      kind: "DUPLICATE_SUPPRESSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "DUPLICATE_SUPPRESSED",
      payload: { reasons, foundIn: dup.foundIn, evidence: dup.evidence },
    });
    return {
      state: "DUPLICATE_SUPPRESSED",
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons,
      proposal: evaluation.proposal,
      broker: null,
      timing: null,
      protection: null,
    };
  }

  // 7b. RISK RE-CHECK — the last moment at which this order can still be refused.
  // See recheckRiskBeforeSubmit: after the POST there is no window in which to refuse,
  // so this is where a price that has moved against the entry stops the order.
  const recheck = await recheckRiskBeforeSubmit(client, instruction, evaluation.proposal);
  if (!recheck.ok) {
    await appendRecord({
      kind: "VALIDATION_REFUSED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: recheck.state,
      payload: { reasons: recheck.reasons, riskRecheck: recheck.recheck, proposal: evaluation.proposal },
    });
    return {
      state: recheck.state,
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons: recheck.reasons,
      proposal: evaluation.proposal,
      broker: null,
      timing: null,
      protection: null,
    };
  }

  // Submit. Timing is measured around the write only.
  const requestedAt = new Date().toISOString();
  const t0 = Date.now();
  await appendRecord({ kind: "ORDER_REQUESTED", signalId: instruction.signalId,
    strategyId: instruction.strategyId, strategyVersion: instruction.strategyVersion,
    orderKey, state: "REQUESTED", payload: { proposal: evaluation.proposal, requestedAt, riskRecheck: recheck.recheck } });
  const res = await client.createOrder(evaluation.orderPayload);
  const roundTripMs = Date.now() - t0;
  const acknowledgedAt = new Date().toISOString();
  const instructionToAckMs = Date.parse(acknowledgedAt) - Date.parse(instruction.generatedAt);

  if (isTransportFailure(res)) {
    // The connection failed. We do NOT retry here: the caller must first read broker
    // state. Record the failure so the record shows the gap.
    await appendRecord({
      kind: "CONNECTION_FAILURE",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "UNAVAILABLE",
      payload: {
        error: res.error,
        request: res.request,
        sentAt: res.sentAt,
        // The proposal is kept here on purpose: if the response is lost the order may
        // still be filled at the broker, and the budgeted risk has to remain recoverable
        // from the record so the realised risk can be compared with it later.
        proposal: evaluation.proposal,
        riskRecheck: recheck.recheck,
        note: "no retry attempted until broker state is read",
      },
    });
    return {
      state: "UNAVAILABLE",
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons: [`connection failure: ${res.error}. Broker state must be read before any retry.`],
      proposal: evaluation.proposal,
      broker: null,
      timing: null,
      protection: null,
    };
  }



  const body = res.body ?? {};
  const ackJson = body;
  const fill = body.orderFillTransaction ?? null;
  const rejected = body.orderRejectTransaction ?? body.orderCancelTransaction ?? null;

  if (!res.ok || rejected) {
    const errorMessage =
      rejected?.rejectReason ?? body.errorMessage ?? (res.ok ? "broker returned a non-fill transaction" : `HTTP ${res.status}`);
    const reasons = [`broker rejected: ${errorMessage}${rejected?.rejectReason ? ` (${rejected.rejectReason})` : ""}`];
    await appendRecord({
      kind: "ORDER_REJECTED",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "REJECTED",
      payload: { status: res.status, brokerErrorText: rejected?.rejectReason ?? body.errorMessage ?? res.text, ackJson, roundTripMs },
    });
    return {
      state: "REJECTED",
      ok: false,
      orderKey,
      signalId: instruction.signalId,
      reasons,
      proposal: evaluation.proposal,
      broker: {
        orderId: null,
        tradeId: null,
        transactionId: rejected?.id ?? null,
        ackStatus: res.status,
        ackJson,
        errorMessage: rejected?.rejectReason ?? body.errorMessage ?? res.text,
      },
      timing: { requestedAt, acknowledgedAt, roundTripMs, instructionToAckMs },
      protection: null,
    };
  }

  const orderId: string | null = fill?.orderID ? String(fill.orderID) : null;
  const tradeId: string | null = fill?.tradeOpened?.tradeID ? String(fill.tradeOpened.tradeID) : null;
  const transactionId: string | null = fill?.id ? String(fill.id) : null;
  const partiallyFilled = Boolean(fill?.tradeOpened && fill?.units !== undefined && body.orderCancelTransaction);

  await appendRecord({
    kind: "ORDER_ACKNOWLEDGED",
    signalId: instruction.signalId,
    strategyId: instruction.strategyId,
    strategyVersion: instruction.strategyVersion,
    orderKey,
    state: "ACKNOWLEDGED",
    payload: {
      ackStatus: res.status,
      orderId,
      tradeId,
      transactionId,
      roundTripMs,
      instructionToAckMs,
      brokerTimestamp: fill?.time ?? null,
      ackJson,
    },
  });

  if (tradeId) {
    await appendRecord({
      kind: partiallyFilled ? "PARTIAL_FILL" : "FILL",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: partiallyFilled ? "PARTIALLY_FILLED" : "FILLED",
      payload: {
        orderId,
        tradeId,
        transactionId,
        units: fill?.units ?? null,
        price: fill?.price ?? null,
        pl: fill?.pl ?? null,
        brokerTimestamp: fill?.time ?? null,
        tradeOpened: fill?.tradeOpened ?? null,
        ackJson,
      },
    });
  }

  // Confirm protection from the broker's own object, not from what we sent.
  const protection = tradeId ? await confirmProtection(client, instruction, orderKey, tradeId, { proposal: evaluation.proposal }) : null;

  return {
    state: protection && (protection as any).protected ? "PROTECTED" : tradeId ? "FILLED" : "ACKNOWLEDGED",
    ok: true,
    orderKey,
    signalId: instruction.signalId,
    reasons: [],
    proposal: evaluation.proposal,
    broker: { orderId, tradeId, transactionId, ackStatus: res.status, ackJson, errorMessage: null },
    timing: { requestedAt, acknowledgedAt, roundTripMs, instructionToAckMs },
    protection,
  };
}

/**
 * Read the trade back from a FRESH broker GET and confirm the stop and target are
 * attached to it. This is the only thing that may move an order to PROTECTED.
 */
export async function confirmProtection(
  client: Client,
  instruction: SignalInstruction,
  orderKey: string,
  tradeId: string,
  opts: { proposal?: Record<string, any> | null } = {},
): Promise<Record<string, unknown>> {
  const res = await client.trade(tradeId);
  if (isTransportFailure(res)) {
    await appendRecord({
      kind: "CONNECTION_FAILURE",
      signalId: instruction.signalId,
      strategyId: instruction.strategyId,
      strategyVersion: instruction.strategyVersion,
      orderKey,
      state: "FILLED",
      payload: { stage: "confirmProtection", error: res.error },
    });
    return { protected: false, reason: "broker read failed", error: res.error };
  }
  const trade = res.body?.trade ?? null;
  const sl = trade?.stopLossOrder ?? null;
  const tp = trade?.takeProfitOrder ?? null;
  const protectedOk = Boolean(sl && tp && trade?.state === "OPEN");
  const evidence = {
    readAt: new Date().toISOString(),
    source: `GET /v3/accounts/{id}/trades/${tradeId} (fresh read, not in-memory belief)`,
    trade: trade
      ? {
          id: trade.id,
          instrument: trade.instrument,
          state: trade.state,
          currentUnits: trade.currentUnits,
          price: trade.price,
          openTime: trade.openTime,
          stopLossOrder: sl
            ? { id: sl.id, price: sl.price, timeInForce: sl.timeInForce, state: sl.state, type: sl.type, clientExtensions: sl.clientExtensions }
            : null,
          takeProfitOrder: tp
            ? { id: tp.id, price: tp.price, timeInForce: tp.timeInForce, state: tp.state, type: tp.type, clientExtensions: tp.clientExtensions }
            : null,
        }
      : null,
    protected: protectedOk,
  };
  await appendRecord({
    kind: protectedOk ? "PROTECTED" : "VALIDATION_REFUSED",
    signalId: instruction.signalId,
    strategyId: instruction.strategyId,
    strategyVersion: instruction.strategyVersion,
    orderKey,
    state: protectedOk ? "PROTECTED" : "FILLED",
    payload: evidence,
  });

  // Realised risk, from the broker's own fill price and the stop the broker actually has
  // attached — recorded next to the budget. This runs on every path that confirms a trade,
  // including the adopted-after-a-dropped-connection path, so an order whose response was
  // lost is still measured. It never throws: a measurement failure is recorded as
  // UNMEASURED rather than being allowed to break protection confirmation.
  try {
    await recordRealisedRisk(client, instruction, orderKey, trade, opts.proposal ?? null);
  } catch (error) {
    await appendUnmeasuredRisk({
      orderKey,
      signalId: instruction.signalId,
      tradeId,
      reason: "MEASUREMENT_THREW",
      detail: error instanceof Error ? error.message : String(error),
      source: "confirmProtection",
    });
  }
  return evidence;
}

/* ------------------------------------------------------- realised risk record */

/**
 * Recover the proposal that produced an order from the append-only record. Needed when the
 * caller no longer holds it in memory — the adopted-after-a-dropped-connection path, where
 * submitSignal returned before the fill was known.
 */
async function proposalFromRecord(orderKey: string): Promise<Record<string, any> | null> {
  const { byOrderKey } = await replay();
  for (const r of byOrderKey.get(orderKey) ?? []) {
    const p = (r.payload ?? {}) as any;
    if (p?.proposal && typeof p.proposal === "object") return p.proposal;
  }
  return null;
}

/**
 * Quote→account conversion for the realised-risk calculation, without inventing a rate.
 * Order of preference: the rate the size was actually derived with; the account currency
 * when the instrument's quote currency is already it; otherwise a fresh price read.
 * Returns null when no rate can be established, and the caller records UNMEASURED.
 */
async function resolveQuoteToAccountRate(
  client: Client,
  instruction: SignalInstruction,
  proposal: Record<string, any> | null,
): Promise<{ rate: number | null; source: string }> {
  const fromProposal = Number(proposal?.quoteToAccountRate);
  if (Number.isFinite(fromProposal) && fromProposal > 0) {
    return { rate: fromProposal, source: `the rate the size was derived with (${String(proposal?.conversion ?? "")})` };
  }
  const quoteCcy = instruction.instrument.split("_")[1] ?? "";
  let accountCcy = typeof proposal?.accountCurrency === "string" ? proposal.accountCurrency : null;
  if (!accountCcy) {
    const summary = await client.summary();
    if (isTransportFailure(summary) || !summary.ok) return { rate: null, source: "account currency could not be read" };
    accountCcy = String(summary.body?.account?.currency ?? "");
  }
  if (!accountCcy) return { rate: null, source: "account currency unknown" };
  if (quoteCcy === accountCcy) return { rate: 1, source: `quote currency ${quoteCcy} is the account currency` };

  const quotes = await readQuotes(client, [`${accountCcy}_${quoteCcy}`, `${quoteCcy}_${accountCcy}`]);
  const direct = quotes[`${accountCcy}_${quoteCcy}`];
  const inverse = quotes[`${quoteCcy}_${accountCcy}`];
  if (direct) return { rate: 1 / direct.mid, source: `1 ${quoteCcy} = ${(1 / direct.mid).toFixed(8)} ${accountCcy} from ${accountCcy}_${quoteCcy} mid ${direct.mid}` };
  if (inverse) return { rate: inverse.mid, source: `1 ${quoteCcy} = ${inverse.mid.toFixed(8)} ${accountCcy} from ${quoteCcy}_${accountCcy} mid ${inverse.mid}` };
  return { rate: null, source: `no ${accountCcy}_${quoteCcy} or ${quoteCcy}_${accountCcy} price was available` };
}

/**
 * Measure the realised risk of a filled trade and append it to the record.
 *
 * Inputs are the broker's, never ours: the trade's own fill price (`price`) and the stop
 * the broker reports as attached (`stopLossOrder.price`). The budgeted figure comes from
 * the proposal if it is in hand, otherwise from the record.
 */
export async function recordRealisedRisk(
  client: Client,
  instruction: SignalInstruction,
  orderKey: string,
  trade: any,
  proposal: Record<string, any> | null,
): Promise<ReturnType<typeof computeRealisedRisk> | null> {
  if (!trade) return null;
  const units = Math.abs(Number(trade.currentUnits));
  const fillPrice = Number(trade.price);
  const attachedStop = Number(trade.stopLossOrder?.price);

  if (!Number.isFinite(attachedStop) || attachedStop <= 0) {
    await appendUnmeasuredRisk({
      orderKey,
      signalId: instruction.signalId,
      tradeId: trade.id ? String(trade.id) : null,
      reason: "NO_ATTACHED_STOP",
      detail: "the broker's trade object carries no stop-loss price, so the risk this position carries cannot be measured. Protection is already reported as failing for this trade.",
      source: "confirmProtection trade read-back",
    });
    return null;
  }

  const fromRecord = proposal ?? (await proposalFromRecord(orderKey));
  const conversion = await resolveQuoteToAccountRate(client, instruction, fromRecord);
  if (conversion.rate === null) {
    await appendUnmeasuredRisk({
      orderKey,
      signalId: instruction.signalId,
      tradeId: trade.id ? String(trade.id) : null,
      reason: "NO_CONVERSION_RATE",
      detail: conversion.source,
      source: "confirmProtection trade read-back",
    });
    return null;
  }

  const budget = Number(fromRecord?.riskAccountCurrency);
  const cap = Number(fromRecord?.riskCapAccountCurrency);
  const nav = Number(fromRecord?.equity);

  const measurement = computeRealisedRisk({
    instrument: String(trade.instrument ?? instruction.instrument),
    direction: instruction.direction,
    units,
    fillPrice,
    fillPriceSource: "the broker's trade.price (average fill price of the trade it opened)",
    stopPrice: attachedStop,
    stopPriceSource: "BROKER_ATTACHED_STOP",
    quoteToAccountRate: conversion.rate,
    conversionSource: conversion.source,
    nav: Number.isFinite(nav) ? nav : null,
    budgetedRiskAccountCurrency: Number.isFinite(budget) ? budget : null,
    capAccountCurrency: Number.isFinite(cap) ? cap : null,
    capPctOfNav: Number.isFinite(Number(fromRecord?.riskPctSetting)) ? Number(fromRecord?.riskPctSetting) : null,
  });

  if (!measurement.ok) {
    await appendUnmeasuredRisk({
      orderKey,
      signalId: instruction.signalId,
      tradeId: trade.id ? String(trade.id) : null,
      reason: measurement.reason,
      detail: measurement.detail,
      source: "confirmProtection trade read-back",
    });
    return measurement;
  }

  await appendRealisedRisk({
    measurement,
    orderKey,
    signalId: instruction.signalId,
    tradeId: trade.id ? String(trade.id) : null,
    origin: fromRecord?.origin ?? instruction.origin,
    source: "confirmProtection: computed from the broker's trade.price and the attached stopLossOrder.price, read back after the fill",
  });
  return measurement;
}

/* ------------------------------------------------------------- realised P/L */

/** Sum of realised P/L on Meridian-managed closes during the current UTC day. */
export async function realisedToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { all } = await replay();
  let sum = 0;
  for (const r of all) {
    if (r.kind !== "CLOSED" || r.recordedAt.slice(0, 10) !== today) continue;
    const pl = Number((r.payload as any)?.realizedPL ?? 0);
    if (Number.isFinite(pl)) sum += pl;
  }
  // Today's closes that happened BEFORE a rotation are in an archived segment. The
  // checkpoint carries them per date, so the day's loss budget is not reset to zero by
  // starting a new file (lib/rotation.ts).
  const carried = await carriedForwardFromRecord();
  const carriedToday = Number(carried.realisedByDay[today] ?? 0);
  if (Number.isFinite(carriedToday)) sum += carriedToday;
  return sum;
}

export { TEST_PROFILE };
