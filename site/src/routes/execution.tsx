import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/execution")({ component: Execution });
function Execution() {
  const [key, setKey] = useState("");
  const [data, setData] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
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
    {data && <>
      {!!data.status.alerts?.length && <section role="alert" className="rounded border border-red-400 bg-red-50 p-4"><h2 className="font-semibold">Risk and record alerts</h2><ul className="list-disc space-y-2 pl-5">{data.status.alerts.map((alert: string, index: number) => <li key={index}>{alert}</li>)}</ul></section>}
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
