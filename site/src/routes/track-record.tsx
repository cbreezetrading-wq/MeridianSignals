import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { RULESET_VERSION } from "~/lib/market/ruleset";
import {
  buildTrackRecordPayload,
  type SignalRecord,
  type TrackRecordPayload,
} from "~/lib/market/trackRecord";

/**
 * /track-record — the record of what the engine said, newest first.
 *
 * This page is a reader for an append-only JSONL log written by the server at
 * /home/team/shared/signal-log/signals.jsonl. It shows records and an integrity
 * verdict. It deliberately calculates nothing: no result, no accuracy, no win
 * rate — a record of signals is not a track record of trades, and nothing here
 * pretends otherwise.
 */
export const Route = createFileRoute("/track-record")({
  head: () => ({
    meta: [
      { title: "Meridian Signals — signal record" },
      {
        name: "description",
        content:
          "Append-only, hash-chained record of every signal the engine has produced, with the rule, the trigger bar and the data source behind each one. No performance figure is calculated or implied.",
      },
    ],
  }),
  loader: async () => {
    if (typeof window === "undefined") {
      return await buildTrackRecordPayload({ rulesetVersion: RULESET_VERSION });
    }
    const res = await fetch("/api/track-record", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The track-record endpoint answered HTTP ${String(res.status)}.`);
    return (await res.json()) as TrackRecordPayload;
  },
  component: TrackRecordPage,
});

function formatUtc(iso: string | null): string {
  if (!iso) return "unknown";
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

/** Stored values are raw; show them to 6 significant figures and say so. */
function showNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return String(Number(value.toPrecision(6)));
}

function gapText(seconds: number | null): string {
  if (seconds === null) return "not enough records to measure a gap yet";
  if (seconds < 120) return `${String(seconds)} seconds`;
  if (seconds < 7200) return `${String(Math.round(seconds / 60))} minutes`;
  return `${String(Math.round(seconds / 3600))} hours`;
}

const SIGNAL_STYLE: Record<SignalRecord["signal"], string> = {
  LONG: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  SHORT: "bg-rose-100 text-rose-900 ring-rose-300",
  FLAT: "bg-slate-100 text-slate-700 ring-slate-300",
  UNAVAILABLE: "bg-amber-100 text-amber-900 ring-amber-300",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="font-mono text-sm text-slate-900 tabular-nums">{value}</dd>
    </div>
  );
}

function RecordCard({ record }: { record: SignalRecord }) {
  const levels = record.entry !== null || record.stop !== null || record.target !== null;
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-slate-500">#{record.seq}</span>
          <h3 className="text-base font-semibold text-slate-900">{record.label}</h3>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide ring-1 ${SIGNAL_STYLE[record.signal]}`}
          >
            {record.signal}
          </span>
          <span className="text-xs text-slate-500">
            {record.kind} · {record.reason.replace(/-/g, " ")}
          </span>
        </div>
        <span className="font-mono text-xs text-slate-500">{formatUtc(record.recordedAt)}</span>
      </div>

      {levels ? (
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <Field label="Entry (reference)" value={showNumber(record.entry)} />
          <Field label="Stop" value={showNumber(record.stop)} />
          <Field label="Target" value={showNumber(record.target)} />
        </dl>
      ) : (
        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
          No live entry, stop or target in this record — the engine held no position on this pair.
        </p>
      )}

      <dl className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
        <Field
          label="Trigger bar (UTC)"
          value={
            record.triggerBarUtc === null
              ? "none — no signal computed"
              : `${formatUtc(record.triggerBarUtc)} · close ${showNumber(record.triggerBarClose)}`
          }
        />
        <Field
          label="Newest closed bar (UTC)"
          value={
            record.newestClosedBarUtc === null
              ? "none — no signal computed"
              : `${formatUtc(record.newestClosedBarUtc)} · close ${showNumber(record.newestClosedBarClose)}`
          }
        />
      </dl>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <h4 className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Rule</h4>
        <p className="text-sm text-slate-900">{record.rule}</p>
      </div>

      <dl className="mt-3 grid gap-1 border-t border-slate-100 pt-3 text-xs text-slate-600 sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Source:</dt>
          <dd>{record.source}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-500">Granularity:</dt>
          <dd>
            {record.granularity}
            {record.fromCache === null
              ? ""
              : record.fromCache
                ? " · served from the server cache"
                : " · fetched fresh from upstream"}
          </dd>
        </div>
        {record.error ? (
          <div className="flex flex-wrap gap-x-2 sm:col-span-2">
            <dt className="font-medium text-slate-500">Failure recorded:</dt>
            <dd className="text-amber-900">{record.error}</dd>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-2 sm:col-span-2">
          <dt className="font-medium text-slate-500">Record hash:</dt>
          <dd className="font-mono break-all">{record.hash}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2 sm:col-span-2">
          <dt className="font-medium text-slate-500">Links back to:</dt>
          <dd className="font-mono break-all">{record.prevHash}</dd>
        </div>
      </dl>
    </li>
  );
}

function TrackRecordPage() {
  const initial = Route.useLoaderData() as TrackRecordPayload;
  const [payload, setPayload] = useState<TrackRecordPayload>(initial);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/track-record", { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const next = (await res.json()) as TrackRecordPayload;
        if (cancelled) return;
        setPayload(next);
        setPollError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setPollError(
          `The page could not re-read its own /api/track-record endpoint (${message}). The records below are from the last payload it did read — they are not re-dated.`,
        );
      }
    };
    const id = window.setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const { log, integrity, about, records } = payload;
  const intact = integrity.ok;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl px-5 py-10 text-slate-900">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Meridian Signals
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Signal record</h1>
        <p className="mt-3 max-w-3xl text-sm text-slate-700">
          Every signal this engine has produced, newest first, exactly as it was written down at the
          time. The dashboard shows only the current state; this page is the record that a change
          happened — the earlier reading is still here after the state moves on.{" "}
          <a className="underline" href="/">
            Back to the dashboard
          </a>
          .
        </p>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          A record of signals is not a record of results: this page calculates no performance. The
          measured result of the ruleset behind every line below is on{" "}
          <a className="underline" href="/backtest">
            the backtest page
          </a>{" "}
          — it is negative, and it is worth reading before any signal here is acted on.
        </p>
      </header>

      <section
        className={`mb-6 rounded-xl border p-5 ${
          intact ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50"
        }`}
      >
        <h2 className="text-lg font-semibold text-slate-900">
          {intact
            ? `Chain intact, ${String(integrity.recordCount)} records`
            : `Chain BROKEN at line ${String(integrity.firstBreak?.line ?? "?")}`}
        </h2>
        <ul className="mt-2 space-y-1 text-sm text-slate-800">
          <li>
            <strong className="font-semibold">Records in the log:</strong>{" "}
            {String(integrity.recordCount)} ({String(integrity.recordsChecked)} checked against the
            chain).
          </li>
          <li>
            <strong className="font-semibold">Log begins:</strong> {formatUtc(log.beginsAt)} — the log
            starts on the date of its first record and contains nothing before that.
          </li>
          <li>
            <strong className="font-semibold">Most recent record:</strong>{" "}
            {formatUtc(log.lastRecordedAt)}
            {log.secondsSinceLastRecord === null
              ? ""
              : ` (${String(log.secondsSinceLastRecord)} seconds ago)`}
            .
          </li>
          <li>
            <strong className="font-semibold">Longest gap between two records:</strong>{" "}
            {gapText(integrity.maxGapSeconds)}. A pair is recorded at least every{" "}
            {String(Math.round(log.heartbeatSeconds / 60))} minutes, so a longer gap means the engine
            stopped computing or its records did not reach this file.
          </li>
          {!intact && integrity.firstBreak ? (
            <li className="font-medium text-rose-900">
              First break — line {String(integrity.firstBreak.line)}: {integrity.firstBreak.reason}
            </li>
          ) : null}
          {integrity.tornTrailingLine ? (
            <li className="text-amber-900">
              The final line is a torn write (no terminating newline, not valid JSON). The chain is
              verified up to the last complete record; nothing was rewritten to hide it.
            </li>
          ) : null}
        </ul>
        <p className="mt-3 text-xs text-slate-600">
          {integrity.algorithm}. Verified {formatUtc(integrity.verifiedAt)}.{" "}
          {integrity.cached
            ? "This verdict was reused because the log file has not changed since it was last walked — a full walk re-runs whenever the file changes, or on request with ?full=1."
            : "This verdict is from a full walk of the whole file."}{" "}
          Log file: <span className="font-mono">{log.logPath}</span> ({String(log.fileBytes)} bytes).
          Machine-readable copy:{" "}
          <a className="underline" href="/api/track-record">
            /api/track-record
          </a>
          .
        </p>
      </section>

      <section className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
        <h2 className="text-lg font-semibold text-slate-900">What this page is — and what it is not</h2>
        <ul className="mt-2 space-y-2 text-sm text-slate-700">
          <li>{about.whatThisIs}</li>
          <li>{about.begins}</li>
          <li>{about.notPerformance}</li>
          <li>{about.tamperEvidentNotProof}</li>
          <li>{about.heartbeat}</li>
          <li>
            Levels are the engine&rsquo;s reference levels, written down at the moment it computed
            them; they are not filled orders and not quotes. Stored numbers are drawn raw — the
            display rounds them to 6 significant figures and nothing else is changed.
          </li>
        </ul>
      </section>

      {pollError ? (
        <p className="mb-6 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          {pollError}
        </p>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">
          Records — newest first
          <span className="ml-2 text-sm font-normal text-slate-500">
            showing {String(payload.recordsShown)} of {String(integrity.recordCount)}
          </span>
        </h2>
        {records.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            The log is empty. No record has been written yet, so there is nothing to show — and
            nothing before this. Records appear here as soon as the engine next computes.
          </p>
        ) : (
          <ul className="space-y-4">
            {records.map((record) => (
              <RecordCard key={`${String(record.seq)}-${record.hash.slice(0, 8)}`} record={record} />
            ))}
          </ul>
        )}
        {integrity.recordCount > payload.recordsShown ? (
          <p className="mt-3 text-sm text-slate-600">
            {String(integrity.recordCount - payload.recordsShown)} older records are in the log but
            not shown on this page. Read them from{" "}
            <a className="underline" href="/api/track-record?limit=500">
              /api/track-record?limit=500
            </a>{" "}
            or from the file itself.
          </p>
        ) : null}
      </section>

      <footer className="mt-10 pb-4 text-xs text-slate-500">
        Append-only record of signals, not of trades. No performance, accuracy or win-rate figure is
        calculated or implied anywhere on this page — none has been measured. Personal use tool; no
        accounts, no order placement, no data collected. Ruleset {payload.rulesetVersion}.
      </footer>
    </main>
  );
}
