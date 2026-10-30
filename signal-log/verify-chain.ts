#!/usr/bin/env bun
/**
 * Standalone verifier for the signal record.
 *
 *   bun /home/team/shared/signal-log/verify-chain.ts
 *
 * Walks /home/team/shared/signal-log/signals.jsonl in order and either reports
 * "chain intact, N records" or the FIRST record where the chain breaks, with its
 * 1-based line number and the reason. Read-only: it never writes to the log.
 *
 * Tamper-EVIDENT, not tamper-proof: an accidental edit, a deletion, a reordering,
 * or any edit made after you hold an earlier copy is detected here. It cannot stop
 * whoever controls the file from rewriting the whole chain and recomputing it.
 */
import { verifyChain } from "/home/team/shared/site/src/lib/market/trackRecord.ts";

const result = await verifyChain();

console.log(`log:      ${result.logPath}`);
console.log(`algorithm: ${result.algorithm}`);
console.log(`verified:  ${result.verifiedAt}`);
console.log(`begins:    ${result.firstRecordedAt ?? "(empty log)"}`);
console.log(`newest:    ${result.lastRecordedAt ?? "(empty log)"}`);
console.log(`longest gap between records: ${result.maxGapSeconds ?? "-"} seconds`);
if (result.tornTrailingLine) {
  console.log("note: the final line is a torn write (incomplete, no newline) — ignored, not repaired.");
}
if (result.ok) {
  console.log(`chain intact, ${String(result.recordCount)} records`);
} else {
  console.log(
    `CHAIN BROKEN at line ${String(result.firstBreak?.line)}: ${String(result.firstBreak?.reason)}`,
  );
}
process.exit(result.ok ? 0 : 1);
