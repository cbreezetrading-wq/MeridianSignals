#!/usr/bin/env bun
/**
 * PROOF 4 — reconciliation across a restart.
 *
 *   bun /home/team/shared/execution/scripts/04-restart.ts
 *
 * Writes /home/team/shared/verify/execution/04-restart.json
 *
 * "Restart" is not simulated: this process reconciles, then SPAWNS A SECOND PROCESS
 * (`--child`) which has no memory of the first. The child bootstraps from scratch,
 * rebuilds Meridian's belief by replaying /home/team/shared/execution/orders.jsonl
 * from disk, reads the broker fresh, reconciles again, and prints its report. The
 * parent then compares the two reports field by field.
 *
 * Pass = both processes agree on the managed trade, its units, its stop price and its
 * take-profit price, the record chain verifies, and nothing is classified as
 * unrecorded or missing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { reconcile } from "../lib/ops.ts";
import { verifyChain } from "../lib/record.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

if (process.argv.includes("--child")) {
  const { client } = await bootstrapClient();
  const report = await reconcile(client);
  const chain = await verifyChain();
  console.log(
    JSON.stringify({
      process: "child",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      report,
      chain: { ok: chain.ok, records: chain.recordCount, lastHash: chain.lastHash },
    }),
  );
  process.exit(0);
}

const { client, accountId } = await bootstrapClient();
const parentStartedAt = new Date().toISOString();
const parentReport = await reconcile(client);
const parentChain = await verifyChain();

// ---- spawn a genuinely separate process
const child = Bun.spawn(["bun", "/home/team/shared/execution/scripts/04-restart.ts", "--child"], {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});
const childOut = await new Response(child.stdout).text();
await child.exited;
const childErr = await new Response(child.stderr).text();

let childParsed: any = null;
try {
  childParsed = JSON.parse(childOut.trim().split("\n").filter(Boolean).pop() ?? "");
} catch {
  childParsed = null;
}

const cmp = (a: any[], b: any[]) => {
  const key = (x: any) => `${x.tradeId}|${x.units}|${x.stopPrice}|${x.takeProfitPrice}`;
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
};

const identical =
  childParsed !== null &&
  cmp(parentReport.matched, childParsed.report.matched) &&
  parentReport.matched.length > 0 &&
  parentReport.manualExternal.length === childParsed.report.manualExternal.length &&
  parentReport.unrecordedManaged.length === 0 &&
  childParsed.report.unrecordedManaged.length === 0 &&
  parentReport.missingAtBroker.length === 0 &&
  childParsed.report.missingAtBroker.length === 0;

const evidence = {
  proof: "reconciliation across a restart",
  generatedAt: new Date().toISOString(),
  accountId,
  parent: { pid: process.pid, startedAt: parentStartedAt, report: parentReport, chain: { ok: parentChain.ok, records: parentChain.recordCount, lastHash: parentChain.lastHash } },
  child: {
    pid: childParsed?.pid ?? null,
    startedAt: childParsed?.startedAt ?? null,
    stderr: childErr.slice(0, 800) || null,
    report: childParsed?.report ?? null,
    chain: childParsed?.chain ?? null,
  },
  comparison: {
    managedTradesParent: parentReport.matched.length,
    managedTradesChild: childParsed?.report.matched.length ?? null,
    identicalManagedSet: childParsed ? cmp(parentReport.matched, childParsed.report.matched) : false,
    chainIntactInBoth: parentChain.ok && (childParsed?.chain?.ok ?? false),
    recordCountParent: parentChain.recordCount,
    recordCountChild: childParsed?.chain?.records ?? null,
  },
  verdict: identical && parentChain.ok && (childParsed?.chain?.ok ?? false) ? "PASS" : "FAIL",
  note: "The child rebuilt belief purely from orders.jsonl on disk — it inherited nothing from the parent except the environment. Both read the broker with fresh GETs.",
};

await writeFile(`${OUT_DIR}/04-restart.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      verdict: evidence.verdict,
      parentPid: process.pid,
      childPid: childParsed?.pid ?? null,
      managedParent: parentReport.matched,
      managedChild: childParsed?.report.matched ?? null,
      manualExternal: parentReport.manualExternal.length,
      unrecorded: parentReport.unrecordedManaged.length,
      missing: parentReport.missingAtBroker.length,
      chainOk: parentChain.ok,
    },
    null,
    2,
  ),
);
