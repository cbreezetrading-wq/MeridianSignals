#!/usr/bin/env bun
/**
 * PROOF 7 — the dashboard snapshot.
 *
 *   bun /home/team/shared/execution/scripts/08-status.ts
 *
 * Writes /home/team/shared/execution/status.json and copies it into the site so the
 * dashboard can render a snapshot without the page ever holding a credential or
 * calling the broker itself.
 */

import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { loadConfig, resolveSettingsFrom } from "../lib/configHelper.ts";
import { buildStatus } from "../lib/ops.ts";
import { verifyChain } from "../lib/record.ts";

const { client } = await bootstrapClient();
const config = await loadConfig("/home/team/shared/execution/config.json");
const settings = resolveSettingsFrom(config);
const status = await buildStatus(client, config);
const chain = await verifyChain();

const evidenceDir = "/home/team/shared/verify/execution";
const proofs: Record<string, string | null> = {};
for (const name of ["01-interlock-account", "02-one-order", "03-duplicate", "04-restart", "05-connection-drop", "06-pause-keeps-stops", "07-controls"]) {
  try {
    const raw = await Bun.file(`${evidenceDir}/${name}.json`).json();
    proofs[name] = raw.verdict ?? raw.state ?? (raw.protectionReadBackFromFreshBrokerGet?.protected ? "PROTECTED" : null);
  } catch {
    proofs[name] = null;
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  source: "scripts/08-status.ts — built from a live broker read, the append-only record and the config",
  status,
  missingSettings: settings.missing,
  proofs,
  recordChain: { ok: chain.ok, records: chain.recordCount, firstBreak: chain.firstBreak, algorithm: chain.algorithm },
};

await mkdir("/home/team/shared/execution", { recursive: true });
await writeFile("/home/team/shared/execution/status.json", JSON.stringify(out, null, 2), "utf8");
await mkdir("/home/team/shared/site/src/lib", { recursive: true });
await copyFile("/home/team/shared/execution/status.json", "/home/team/shared/site/src/lib/executionStatus.json");
console.log(JSON.stringify({ generatedAt: out.generatedAt, mode: status.mode, proofs, chainOk: chain.ok, orders: status.orders.length }, null, 2));
