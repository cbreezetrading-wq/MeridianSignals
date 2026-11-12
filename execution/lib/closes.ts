/**
 * Recording a close the watcher SEES at the broker.
 *
 * The defect this fixes: the record only learned about a close when Meridian itself sent
 * the close (control #3) — and nothing closes a trade when a stop or take-profit fills at
 * the broker while the machine is down. Trade 52 filled on 2026-11-05 and closed on its
 * stop the next morning; the record has a FILL for it and no CLOSED, forever. Trade 59
 * repeated it on 2026-11-11. The broker knew both times; the record did not.
 *
 * The rule, and it is the whole rule:
 *
 *  - A trade the record believes is OPEN (a FILL/PARTIAL_FILL naming its id, or a trade id
 *    carried across a rotation, with no CLOSED record for it anywhere) that is ABSENT from
 *    the broker's open trades is a close we missed.
 *  - The close is recorded ONCE per trade id, ever. The record is checked first, and the
 *    same check runs again inside the ledger's exclusive lock at append time, so a restart,
 *    a second process or two watchers cannot write it twice.
 *  - The broker's own numbers are used: its close time, its close price, its closing
 *    transaction id, its realised P/L and its financing. If the broker's read fails or
 *    omits the trade, what is known is recorded and the P/L is marked UNMEASURED — never
 *    guessed, never zero.
 *  - It is labelled for what it is: `detection: "OBSERVED_AT_BROKER"`, the broker's
 *    `closedAt` beside our `detectedAt`, and `detectedLate: true` when the two differ by
 *    more than one watcher cycle. A close this code records was never witnessed live and
 *    the record never says it was.
 *  - READ-ONLY at the broker. Every call in here is a GET: open trades, closed trades, one
 *    trade, one transaction. Nothing submits, modifies, cancels or closes anything, and the
 *    tests prove that with a client whose write methods fail the test if they are called.
 *
 * It runs at the top of every watcher cycle, which includes the first cycle after a
 * restart — so a close that happened while the machine was down is recorded at the next
 * start, before anything can be submitted.
 */

import type { Client, BrokerResponse, BrokerFailure } from "./client.ts";
import { appendRecordUnless, readRecords, type ExecutionRecord } from "./record.ts";
import { carriedForwardFromRecord, type CarriedForward } from "./rotation.ts";
import { recordPath } from "./paths.ts";

/**
 * The watcher's cycle. A close seen more than one cycle after the broker's own close time
 * was not witnessed live, and `detectedLate` says so.
 */
export const WATCHER_CYCLE_MS = 10_000;

function isTransportFailure(r: BrokerResponse | BrokerFailure): r is BrokerFailure {
  return (r as BrokerFailure).transportFailure === true;
}

function tradeIdOf(p: any): string | null {
  const id = p?.tradeId ?? p?.trade?.id ?? p?.tradeOpened?.tradeID ?? null;
  return id === null || id === undefined ? null : String(id);
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------ what the record believes is open */

export type BelievedOpenTrade = {
  tradeId: string;
  orderKey: string | null;
  signalId: string | null;
  instrument: string | null;
};

/**
 * Trades the record believes are open, from the current segment and from the carried state
 * of every earlier segment (the LEDGER_ROTATION checkpoint carries both the trade ids
 * Meridian opened and the furthest state of each order key, so a close recorded before a
 * rotation is not mistaken for an open trade afterwards).
 *
 * Pure, so the belief can be tested without a broker or a file.
 */
export function believedOpenTrades(
  records: ExecutionRecord[],
  carried: Pick<CarriedForward, "knownTradeIds" | "orderKeys">,
): BelievedOpenTrade[] {
  const closed = new Set<string>();
  for (const r of records) {
    if (r.kind !== "CLOSED") continue;
    const id = tradeIdOf(r.payload);
    if (id) closed.add(id);
  }
  for (const k of carried.orderKeys ?? []) {
    if (k.state === "CLOSED" && k.tradeId) closed.add(String(k.tradeId));
  }

  const open = new Map<string, BelievedOpenTrade>();
  for (const r of records) {
    if (r.kind !== "FILL" && r.kind !== "PARTIAL_FILL") continue;
    const p = (r.payload ?? {}) as any;
    const id = tradeIdOf(p);
    if (!id || closed.has(id) || open.has(id)) continue;
    open.set(id, {
      tradeId: id,
      orderKey: r.orderKey ?? null,
      signalId: r.signalId ?? null,
      instrument: str(p.instrument ?? p.trade?.instrument),
    });
  }
  for (const raw of carried.knownTradeIds ?? []) {
    const id = String(raw);
    if (closed.has(id) || open.has(id)) continue;
    const key = (carried.orderKeys ?? []).find((k) => k.tradeId !== null && String(k.tradeId) === id);
    open.set(id, {
      tradeId: id,
      orderKey: key?.orderKey ?? null,
      signalId: key?.signalId ?? null,
      instrument: key?.instrument ?? null,
    });
  }
  return [...open.values()];
}

/* -------------------------------------------------------------------- what we record */

export type ObservedClose = {
  tradeId: string;
  orderKey: string | null;
  signalId: string | null;
  instrument: string | null;
  detection: "OBSERVED_AT_BROKER";
  /** The broker's own close time. Null when the broker would not say. */
  closedAt: string | null;
  /** When WE read it. Never the same claim as `closedAt`. */
  detectedAt: string;
  /** True when closedAt and detectedAt differ by more than one watcher cycle. */
  detectedLate: boolean;
  lateByMs: number | null;
  realizedPL: number | null;
  financing: number | null;
  commission: number | null;
  closePrice: string | null;
  closingTransactionId: string | null;
  /** False when the broker's read failed or omitted the trade: the P/L is not ours to state. */
  plMeasured: boolean;
  unmeasuredReason: string | null;
};

export type CloseDetectionResult = {
  /** False only when the broker's open-trade list could not be read: then nothing is known. */
  ok: boolean;
  reason: string | null;
  readAt: string;
  /** Trade ids the record believed open that the broker did not list as open. */
  candidates: string[];
  recorded: ObservedClose[];
  skipped: Array<{ tradeId: string; why: string }>;
};

const ORDER_FILL_FIELDS = [
  "id",
  "type",
  "time",
  "instrument",
  "units",
  "price",
  "pl",
  "financing",
  "commission",
  "accountBalance",
  "reason",
  "tradeId",
] as const;

/** The broker's closing transaction, trimmed to the fields that describe the close. */
function trimFill(t: any): Record<string, unknown> | null {
  if (!t || typeof t !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of ORDER_FILL_FIELDS) if (t[key] !== undefined) out[key] = t[key];
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Record every close the record missed, from the broker's own account of it.
 *
 * Read-only at the broker. Appends at most one CLOSED record per trade id, ever.
 */
export async function recordObservedCloses(
  client: Client,
  options: { cycleMs?: number; now?: string; path?: string } = {},
): Promise<CloseDetectionResult> {
  const path = options.path ?? recordPath();
  const readAt = options.now ?? new Date().toISOString();
  const cycleMs = options.cycleMs ?? WATCHER_CYCLE_MS;
  const empty = { readAt, candidates: [] as string[], recorded: [] as ObservedClose[], skipped: [] as Array<{ tradeId: string; why: string }> };

  // 1. What is open at the broker RIGHT NOW. If this read fails, nothing is known: an
  //    unreadable broker is not evidence that a trade closed, so nothing is recorded.
  const openRes = await client.openTrades();
  if (isTransportFailure(openRes) || !openRes.ok || !Array.isArray(openRes.body?.trades)) {
    return {
      ok: false,
      reason: isTransportFailure(openRes) ? openRes.error : `the broker's open-trade read failed (HTTP ${openRes.status})`,
      ...empty,
    };
  }
  const openIds = new Set<string>((openRes.body.trades as any[]).map((t) => String(t.id)));

  // 2. What the record believes is open.
  const records = await readRecords(path);
  const carried = await carriedForwardFromRecord(path);
  const believed = believedOpenTrades(records, carried);
  const candidates = believed.filter((b) => !openIds.has(b.tradeId));
  if (candidates.length === 0) return { ok: true, reason: null, ...empty };

  // 3. One read of the broker's closed-trade history, then a single-trade read only for a
  //    candidate it does not list (the history read is capped, and an omission there is not
  //    the same as the trade not existing).
  const closedRes = await client.closedTrades();
  const closedOk = !isTransportFailure(closedRes) && closedRes.ok && Array.isArray(closedRes.body?.trades);
  const closedById = new Map<string, any>();
  if (closedOk) for (const t of closedRes.body.trades as any[]) closedById.set(String(t.id), t);
  const closedReadError = closedOk
    ? null
    : isTransportFailure(closedRes)
      ? closedRes.error
      : `HTTP ${closedRes.status}`;

  const recorded: ObservedClose[] = [];
  const skipped: Array<{ tradeId: string; why: string }> = [];

  for (const candidate of candidates) {
    let brokerTrade: any = closedById.get(candidate.tradeId) ?? null;
    let plSource: string | null = brokerTrade ? "GET /v3/accounts/{id}/trades?state=CLOSED" : null;
    let readError: string | null = closedReadError;

    if (!brokerTrade) {
      const one = await client.trade(candidate.tradeId);
      if (!isTransportFailure(one) && one.ok && one.body?.trade) {
        brokerTrade = one.body.trade;
        plSource = `GET /v3/accounts/{id}/trades/${candidate.tradeId}`;
        readError = null;
      } else {
        readError = readError ?? (isTransportFailure(one) ? one.error : `HTTP ${one.status}`);
      }
    }

    // The open-trade list said absent, but the single-trade read says it is still open: the
    // list was stale. Nothing is recorded — a trade that is open has not closed.
    if (brokerTrade && String(brokerTrade.state ?? "").toUpperCase() === "OPEN") {
      skipped.push({
        tradeId: candidate.tradeId,
        why: "the broker still reports this trade OPEN on a fresh read; the open-trade list was stale, so no close is recorded",
      });
      continue;
    }

    const closedAt = str(brokerTrade?.closeTime);
    const closedAtMs = closedAt === null ? NaN : Date.parse(closedAt);
    const lateByMs = Number.isFinite(closedAtMs) ? Date.parse(readAt) - closedAtMs : null;
    // An unknown close time cannot be claimed as witnessed live.
    const detectedLate = lateByMs === null ? true : lateByMs > cycleMs;

    const realizedPL = num(brokerTrade?.realizedPL);
    const closingTransactionId =
      Array.isArray(brokerTrade?.closingTransactionIDs) && brokerTrade.closingTransactionIDs.length > 0
        ? String(brokerTrade.closingTransactionIDs[brokerTrade.closingTransactionIDs.length - 1])
        : null;

    // The closing transaction carries the commission and the fill the trade object only
    // summarises. It is a GET; if it fails, commission stays unmeasured rather than zero.
    let fill: Record<string, unknown> | null = null;
    if (closingTransactionId) {
      const tx = await client.transaction(closingTransactionId);
      if (!isTransportFailure(tx) && tx.ok) fill = trimFill(tx.body?.orderFillTransaction ?? tx.body?.transaction ?? null);
    }

    // The TRADE carries the financing the position accrued; the closing fill transaction
    // reports the financing settled at that instant, which OANDA posts separately and which
    // reads 0.0000 for trade 59 while the trade's own figure is -0.0001. The trade's number
    // is the trade's financing, so it wins; the fill is only the fallback.
    const financing = num(brokerTrade?.financing) ?? num(fill?.financing);

    const plMeasured = realizedPL !== null;
    const unmeasuredReason = plMeasured
      ? null
      : readError
        ? `the broker's closed-trade read failed or did not include this trade (${readError}), so no P/L is stated`
        : "the broker's closed-trade read did not include this trade, so no P/L is stated";

    const observed: ObservedClose = {
      tradeId: candidate.tradeId,
      orderKey: candidate.orderKey,
      signalId: candidate.signalId,
      instrument: candidate.instrument ?? str(brokerTrade?.instrument),
      detection: "OBSERVED_AT_BROKER",
      closedAt,
      detectedAt: readAt,
      detectedLate,
      lateByMs,
      realizedPL,
      financing,
      commission: num(fill?.commission),
      closePrice: str(brokerTrade?.averageClosePrice),
      closingTransactionId,
      plMeasured,
      unmeasuredReason,
    };

    // One CLOSED per trade id, ever. Checked here, and checked again inside the ledger's
    // exclusive lock by appendRecordUnless — that second check is what makes a restart or a
    // second writer unable to duplicate it.
    const outcome = await appendRecordUnless(
      {
        kind: "CLOSED",
        orderKey: candidate.orderKey,
        signalId: candidate.signalId,
        state: "CLOSED",
        payload: {
          detection: "OBSERVED_AT_BROKER",
          source: `broker read: GET /v3/accounts/{id}/openTrades (trade ${candidate.tradeId} absent)${plSource ? ` + ${plSource}` : " + no closed-trade read succeeded"}`,
          reason: "close observed at the broker — Meridian submitted, modified and closed nothing",
          tradeId: candidate.tradeId,
          instrument: observed.instrument,
          units: str(brokerTrade?.initialUnits),
          realizedPL,
          financing,
          commission: observed.commission,
          plMeasured,
          unmeasuredReason,
          closePrice: observed.closePrice,
          closingTransactionId,
          transactionId: closingTransactionId,
          closedAt,
          detectedAt: readAt,
          detectedLate,
          lateByMs,
          brokerState: brokerTrade ? String(brokerTrade.state ?? "UNKNOWN").toUpperCase() : "NOT_REPORTED",
          ...(fill ? { brokerResponse: { orderFillTransaction: fill } } : {}),
        },
      },
      (existing) => {
        const prior = existing.find((r) => r.kind === "CLOSED" && tradeIdOf(r.payload) === candidate.tradeId);
        return prior
          ? `trade ${candidate.tradeId} already has a CLOSED record at seq ${prior.seq} — one close per trade id, ever`
          : null;
      },
      path,
    );

    if (outcome.appended) recorded.push(observed);
    else skipped.push({ tradeId: candidate.tradeId, why: outcome.skippedBecause });
  }

  return {
    ok: true,
    reason: null,
    readAt,
    candidates: candidates.map((c) => c.tradeId),
    recorded,
    skipped,
  };
}
