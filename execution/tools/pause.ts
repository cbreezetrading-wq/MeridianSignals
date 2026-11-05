/**
 * Set the entry pause with an EXPLICIT reason, without needing a broker read.
 *
 * `bun operator.ts pause` is the normal operator path, but it bootstraps a client first
 * (interlock attestation + account read), which means a broker that is flaky or refusing
 * can stop the operator from pausing. Pausing is a safety action and must never depend on
 * the network, so this tool calls the same `pauseEntries()` (same pause.json, same
 * PAUSE_SET record) with a reason given on the command line.
 *
 *   bun tools/pause.ts "ledger rotation 2026-11-05"
 *   bun tools/pause.ts --status
 *
 * A pause blocks NEW ENTRIES only. It does not touch an existing order, position or any
 * attached stopLoss/takeProfit leg — see lib/ops.ts pauseEntries().
 */
import { pauseEntries } from "../lib/ops.ts";
import { readPause } from "../lib/engine.ts";

const reason = process.argv.slice(2).join(" ").trim();
if (reason === "--status" || reason === "") {
  console.log(JSON.stringify(await readPause(), null, 2));
} else {
  console.log(JSON.stringify(await pauseEntries(reason), null, 2));
}
