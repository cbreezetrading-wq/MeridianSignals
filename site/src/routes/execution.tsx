import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/execution")({ component: Execution });

/** Where a risk setting's value came from. DEMO TEST is its own label, never shown as OWNER. */
function SourceBadge({ source }: { source: string }) {
  const style =
    source === "OWNER" ? "bg-emerald-100 text-emerald-900 border-emerald-400"
    : source === "DEMO-TEST" ? "bg-violet-100 text-violet-900 border-violet-500"
    : source === "TEST" ? "bg-amber-100 text-amber-900 border-amber-400"
    : "bg-red-100 text-red-900 border-red-400";
  const text = source === "DEMO-TEST" ? "DEMO TEST" : source;
  return <span className={`whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold ${style}`}>{text}</span>;
}

function renderSettingValue(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function Execution() {
  const [key, setKey] = useState("");
  const [data, setData] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(name: string, extra: object = {}) {
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/execution", { method: "POST", cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ action: name, ...extra }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Execution unavailable");
      if (name === "status") { setData(result); setPreview(null); }
      else if (name === "preview") setPreview(result);
      else if (name === "report" || name === "generate-report") { setReport(result); if (result.note) setMessage(result.note); }
      else { setMessage(result.reasons?.join("; ") || result.state || "Control applied. Refresh to read broker state."); setPreview(null); }
    } catch (error) { setMessage(String(error)); setPreview(null); if (name === "status") setData(null); }
    finally { setBusy(false); }
  }
  const button = "rounded border border-slate-300 bg-white px-4 py-2 text-sm disabled:opacity-50";
  return <main className="mx-auto max-w-4xl space-y-6 p-6 text-slate-900">
    <a href="/" className="text-sm underline">← Signals</a>
    <header><p className="text-xs font-semibold tracking-widest text-amber-700">OANDA PRACTICE ONLY</p>
      <h1 className="text-3xl font-semibold">Execution console</h1>
      <p className="mt-2 text-slate-600">Review signals, approve Practice orders, and read broker-confirmed state. Live trading is disabled.</p></header>
    <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm">The existing strategy lost in its backtests. Its orders are connection tests only. Automatic execution requires the separate backend watcher; opening this page does not start it. This connector handles entries with broker stops and targets; indicator-based exits are not automated.</div>
    <form onSubmit={(e) => { e.preventDefault(); void action("status"); }} className="flex flex-wrap gap-3">
      <label className="flex-1 text-sm">Operator access key (not your OANDA token)
        <input type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); setData(null); setPreview(null); }} className="mt-1 block w-full rounded border p-2" /></label>
      <button className={button} disabled={busy || !key}>Connect / refresh</button>
    </form>
    <p className="text-xs text-slate-500">The key stays in this page’s memory. Account credentials remain on the server. Status is a snapshot; refresh before relying on it.</p>
    {message && <p role="status" className="rounded border p-4">{message}</p>}
    <section className="rounded border p-4" aria-labelledby="report-heading">
      <h2 id="report-heading" className="text-xl font-semibold">Execution report</h2>
      <p className="mt-1 text-sm text-slate-700">A plain-language digest of what the system did: orders submitted, fills the broker confirmed, closes with their P/L and financing, refusals with the reason, errors, open positions and their stops, the active mode, and the account NAV. Every figure names the record id it came from; anything that could not be measured is labelled unmeasured. An order request is never shown as a trade.</p>
      <p className="mt-2 text-sm text-slate-700">The watcher generates one on its interval and immediately after any fill, close, refusal or error. <strong>No notification channel is configured, so a generated report is stored here and on the server and nothing is sent anywhere.</strong></p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button disabled={busy || !key} className={button} onClick={() => action("report")}>Show latest report</button>
        <button disabled={busy || !key} className={button} onClick={() => action("generate-report")}>Generate now</button>
      </div>
      {report?.report && <div className="mt-4 space-y-3">
        <p className="text-sm"><strong>{report.report.reportId}</strong> · generated {report.report.generatedAt} · trigger {report.report.trigger}{report.report.triggerDetail ? ` (${report.report.triggerDetail})` : ""}{typeof report.recordSeq === "number" ? ` · recorded as seq ${report.recordSeq}` : ""}</p>
        <p className={`rounded border p-3 text-sm ${report.report.notification?.delivered ? "border-emerald-400 bg-emerald-50" : "border-amber-400 bg-amber-50"}`}>
          {report.report.notification?.delivered ? `Delivered by ${report.report.notification.transport}.` : report.report.notification?.detail}
        </p>
        <p className="text-sm text-slate-700">Orders submitted {report.report.counts?.orderRequests ?? "?"} · broker-confirmed fills {report.report.counts?.brokerConfirmedFills ?? "?"} · closes {report.report.counts?.closes ?? "?"} · refusals {report.report.counts?.refusals ?? "?"} · errors {report.report.counts?.errors ?? "?"} · open Meridian positions {report.report.protection?.managedOpenCount ?? "unmeasured"} · mode {report.report.mode?.current}</p>
        {!!report.report.unmeasured?.length && <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm"><p className="font-semibold">Unmeasured in this report</p><ul className="mt-1 list-disc space-y-1 pl-5">{report.report.unmeasured.map((u: string, index: number) => <li key={index}>{u}</li>)}</ul></div>}
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border bg-white p-3 text-xs">{report.text}</pre>
      </div>}
    </section>
    {data && <>
      {!!data.status.alerts?.length && <section role="alert" className="rounded border border-red-400 bg-red-50 p-4"><h2 className="font-semibold">Risk and record alerts</h2><ul className="list-disc space-y-2 pl-5">{data.status.alerts.map((alert: string, index: number) => <li key={index}>{alert}</li>)}</ul></section>}
      {!!data.status.settingsProfile?.demoTestProfileInUse && <section role="note" className="rounded border-2 border-violet-500 bg-violet-50 p-4 text-sm">
        <h2 className="font-semibold">DEMO TEST profile active — these are not the owner’s risk settings</h2>
        <p className="mt-1">{data.status.settingsProfile.note}</p>
        <p className="mt-2 text-xs">Every value below is labelled DEMO TEST, not OWNER. The profile cannot change the trading host, the mode, or automatic execution: the mode is {data.status.mode.current}, automatic is not acknowledged, and no strategy is enabled.</p>
      </section>}
      {data.status.entryGate && <section role="status" className={`rounded border-2 p-4 text-sm ${data.status.entryGate.allowed === true ? "border-slate-300 bg-slate-50" : "border-red-400 bg-red-50"}`}>
        <h2 className="font-semibold">New entries right now</h2>
        {data.status.entryGate.allowed === true && <p className="mt-1">The position-count guard does not refuse a new entry right now: {data.status.entryGate.managedOpenPositions} Meridian-managed position(s) open. Other guards (spread, trading time, entry deviation, daily loss) are applied when an order is actually evaluated.</p>}
        {!!data.status.entryGate.refusals?.length && <ul className="mt-1 list-disc space-y-2 pl-5">
          {data.status.entryGate.refusals.map((r: any, index: number) => <li key={index}>
            <p>{r.message}</p>
            <p className="text-xs">Produced by setting <code className="font-semibold">{r.setting}</code> = {renderSettingValue(r.settingValue)} <SourceBadge source={r.settingSource} /> · guard {r.guard} · broker state read at {data.status.entryGate.checkedAt}</p>
          </li>)}
        </ul>}
      </section>}
      <section className="rounded border p-4"><h2 className="text-xl font-semibold">Risk and control settings</h2>
        <p className="text-xs text-slate-600">Each value carries the label of where it came from. DEMO TEST values are the owner’s direction for a Practice demo run, not a statement of their risk appetite; OWNER means the owner supplied it; UNSET means nothing trades on it.</p>
        <table className="mt-2 w-full text-left text-sm"><thead><tr><th className="py-1">Setting</th><th className="py-1">Value</th><th className="py-1">Label</th></tr></thead>
          <tbody>{data.status.settings.map((s: any) => <tr key={s.key} className="border-t align-top">
            <td className="py-1 pr-3 font-mono text-xs">{s.key}</td>
            <td className="py-1 pr-3 break-words">{renderSettingValue(s.value)}</td>
            <td className="py-1"><SourceBadge source={s.source} /></td>
          </tr>)}</tbody></table>
      </section>
      <section className="rounded border p-4"><h2 className="font-semibold">Connection and controls</h2>
        <p>Mode: {data.status.mode.current} · Entries: {data.status.pause.paused ? "Paused" : "Not paused"}</p>
        <p>Broker: {data.status.broker.ok ? "Available" : "Unavailable"} · Read at {data.status.broker.readAt}</p>
        <p>NAV: {data.status.broker.nav ?? "Unavailable"} {data.status.broker.currency} · Open trades: {data.status.broker.ok ? data.status.broker.openTrades : "Unknown"}</p>
        <p>Missing settings: {data.status.missingSettings.join(", ") || "None"}</p>
        <div className="mt-3 flex gap-3"><button disabled={busy} className={button} onClick={() => action("pause")}>Pause new entries</button><button disabled={busy} className={button} onClick={() => action("resume")}>Resume new entries</button></div>
        <p className="mt-2 text-xs">Pausing preserves existing protective stops. Closing managed trades and cancelling entries are separate terminal commands.</p>
      </section>
      <section><h2 className="text-xl font-semibold">Eligible entry signals</h2>
        {!data.instructions.length && <p>No fresh eligible entry signals. Old positions are never submitted as new trades.</p>}
        {data.instructions.map((i: any) => <div key={i.signalId} className="my-3 rounded border p-4"><p>{i.instrument} · {i.direction} · expires {i.expiryAt}</p><button disabled={busy} className={button} onClick={() => action("preview", { signalId: i.signalId })}>Preview Practice order</button></div>)}
      </section>
      <section><h2 className="text-xl font-semibold">Broker snapshot</h2><p>Meridian trades: {data.status.broker.managedTrades} · External trades: {data.status.broker.manualTrades}</p><p>Execution record integrity: {data.status.record.chainOk ? "Valid" : "Failed"}</p></section>
    </>}
    {preview && <section className="rounded border p-4"><h2 className="text-xl font-semibold">Order review</h2>
      {!preview.ok ? <p>{preview.reasons.join("; ")}</p> : <>
        <p>{preview.proposal.instrument} · {preview.proposal.direction} · {preview.proposal.units} units</p>
        <p>Stop: {preview.proposal.stopPrice} · Target: {preview.proposal.takeProfitPrice}</p>
        <p>Estimated stop risk: {preview.proposal.riskAccountCurrency} {preview.proposal.accountCurrency}. Gaps can exceed this estimate.</p>
        <button disabled={busy || data?.status.mode.current !== "approve-before-execution"} className={button} onClick={() => action("submit", { signalId: preview.instruction.signalId, approvalHash: preview.approvalHash })}>Approve and submit Practice order</button>
        <p className="mt-2 text-xs">The server checks the signal and broker again. A changed order requires a new review.</p>
      </>}
    </section>}
  </main>;
}
