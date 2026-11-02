/**
 * Where execution state lives.
 *
 * These are FUNCTIONS, not module-level constants, and that is a correctness
 * requirement rather than a style choice. When the paths were frozen at import
 * time, `bun test` over the whole tests/ directory leaked test records into the
 * live ledger: one test file imported these modules before another test file had
 * pointed MERIDIAN_EXECUTION_DIR at a temporary directory, so the import-time
 * constant captured the source-relative default — the live directory — and every
 * later append from any test went there. Resolving on each call means the value
 * in force when the call happens is the value used, so no import order can pin a
 * test to live storage.
 *
 * The second half of the guard is `executionDir()`: if a test runner is detected
 * and nothing has redirected storage, it REFUSES instead of falling back to the
 * live directory. A forgotten `MERIDIAN_EXECUTION_DIR` in a test is therefore a
 * loud failure, never a quiet write to the real record.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * True when this process is a test runner. Deliberately narrow: a bare
 * NODE_ENV=test is not enough on its own, because a dev server may set it, and
 * the refusal below must never fire on a host that is serving the console.
 */
export function runningUnderTestRunner(): boolean {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return true;
  if (process.env.MERIDIAN_TEST_RUN === "1") return true;
  const entry = process.argv[1] ?? "";
  return process.env.NODE_ENV === "test" && /\.test\.[cm]?[jt]s$/.test(entry);
}

/** The directory holding config, the record and the pause state. Read on every call. */
export function executionDir(): string {
  const override = process.env.MERIDIAN_EXECUTION_DIR;
  if (typeof override === "string" && override.trim() !== "") return resolve(override);
  if (runningUnderTestRunner()) {
    throw new Error(
      "REFUSED: a test runner has no MERIDIAN_EXECUTION_DIR set, and the source-relative default is the LIVE " +
        "execution directory. Set MERIDIAN_EXECUTION_DIR to a temporary directory (tests/isolate.ts does this) " +
        "rather than writing into the live record.",
    );
  }
  return resolve(fileURLToPath(new URL("../", import.meta.url)));
}

export function executionPath(name: string): string {
  return resolve(executionDir(), name);
}

/** The execution configuration file. */
export function configPath(): string {
  const override = process.env.MERIDIAN_CONFIG_PATH;
  if (typeof override === "string" && override.trim() !== "") return resolve(override);
  return executionPath("config.json");
}

/** The append-only execution record. */
export function recordPath(): string {
  return executionPath("orders.jsonl");
}

/** The entry pause flag. */
export function pausePath(): string {
  return executionPath("pause.json");
}

/** The day's opening NAV, used for the daily loss threshold. */
export function dayStatePath(): string {
  return executionPath("day-state.json");
}
