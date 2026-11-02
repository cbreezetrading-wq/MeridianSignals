/**
 * Test isolation. Every test file starts with:
 *
 *   import { isolate } from "./isolate.ts";
 *   const testDir = isolate();          // before any other top-level work
 *
 * The rule it enforces: a test run must never be able to write into the live
 * execution directory. Three things make that structural rather than a convention:
 *
 *  1. lib/paths.ts resolves every path at CALL time, so importing a lib module
 *     before this file runs cannot freeze a path. (That import-order bug is what
 *     leaked test records into the live orders.jsonl: paths were frozen at import
 *     time to the source-relative default, which is the live directory.)
 *  2. This module sets MERIDIAN_EXECUTION_DIR to a temporary directory the moment
 *     it is imported, so even a path resolved before a file calls isolate() is a
 *     temporary one.
 *  3. lib/paths.ts REFUSES the live fallback when it detects a test runner and
 *     MERIDIAN_EXECUTION_DIR is unset — so a test file that forgets this module
 *     fails loudly instead of writing into the real record.
 *
 * isolate() hands the calling file its own fresh directory and removes every
 * directory it created when the process exits.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meridian-test-"));
  created.push(dir);
  return dir;
}

// Import-time safety net: never let a path resolve to the live directory, even
// before a test file has called isolate().
process.env.MERIDIAN_EXECUTION_DIR ??= freshDir();
process.env.MERIDIAN_TEST_RUN = "1";
process.env.OANDA = "FAKE-TEST-TOKEN-NEVER-REAL";
process.env.OANDA_ACCOUNT_ID = "test-account";

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is not worth failing a test run over */
    }
  }
}
process.on("exit", cleanup);
process.on("beforeExit", cleanup);

/** Give the calling test file its own temporary execution directory. */
export function isolate(): string {
  const dir = freshDir();
  process.env.MERIDIAN_EXECUTION_DIR = dir;
  return dir;
}
