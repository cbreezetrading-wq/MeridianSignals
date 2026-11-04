/**
 * Where execution state lives.
 *
 * ONE EXPLICIT SOURCE, AND IT IS ABSOLUTE. The execution root is either
 * `MERIDIAN_EXECUTION_DIR` (which must itself be absolute) or `DEFAULT_EXECUTION_DIR`
 * below. It is NEVER `process.cwd()` and NEVER a path derived from the running file's own
 * location.
 *
 * WHY, in the form of the defect that made this rule: until 2026-11-04 the default was
 * `new URL("../", import.meta.url)`. That is correct when the file runs from source
 * (`bun operator.ts report` inside execution/), and wrong the moment the same module is
 * BUNDLED into another program: the site server compiles execution/lib/*.ts into
 * site/dist/server/server.js, so `import.meta.url` became that bundle's own path and every
 * execution path resolved to `site/dist/server/`. The console then generated a report that
 * stated, as fact, `signals-only (source: DEFAULT)`, a 0-record window and 0 fills — while
 * the real record held 1,827 records and the real config said `automatic`. It also CREATED
 * an empty `site/dist/server/orders.jsonl` and a `site/dist/server/reports/` directory.
 * A report that misstates the execution mode is worse than no report at all.
 *
 * A path that depends on where the process was started from is not a fact about the
 * system, it is a fact about the caller. There is exactly one execution directory and it
 * has a name.
 *
 * These are FUNCTIONS, not module-level constants, and that is a correctness requirement
 * rather than a style choice. When the paths were frozen at import time, `bun test` over
 * the whole tests/ directory leaked test records into the live ledger: one test file
 * imported these modules before another test file had pointed MERIDIAN_EXECUTION_DIR at a
 * temporary directory, so the import-time constant captured the live directory and every
 * later append from any test went there. Resolving on each call means the value in force
 * when the call happens is the value used, so no import order can pin a test to live
 * storage.
 *
 * The second half of the guard is `executionDir()`: if a test runner is detected and
 * nothing has redirected storage, it REFUSES instead of falling back to the live
 * directory. A forgotten `MERIDIAN_EXECUTION_DIR` in a test is therefore a loud failure,
 * never a quiet write to the real record.
 */

import { isAbsolute, resolve } from "node:path";

/**
 * The one execution directory on the machine that runs the worker.
 *
 * Absolute, spelled out, and not derived from anything: this is the directory the watcher,
 * `bun operator.ts report` and the site server must all agree on. A clone of this repository
 * elsewhere sets MERIDIAN_EXECUTION_DIR instead of relying on this constant.
 */
export const DEFAULT_EXECUTION_DIR = "/home/team/shared/execution";

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

/**
 * An override must be absolute. A relative one would be resolved against the caller's
 * working directory — the exact defect this module exists to prevent — so it is refused
 * loudly rather than quietly made to depend on where the process was started.
 */
function absoluteOverride(name: string, value: string): string {
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `REFUSED: ${name} is ${JSON.stringify(value)}, which is not an absolute path. Execution paths never depend on ` +
        `the process's working directory, so a relative override is refused rather than resolved against it.`,
    );
  }
  return resolve(trimmed);
}

/** The directory holding config, the record and the pause state. Read on every call. */
export function executionDir(): string {
  const override = process.env.MERIDIAN_EXECUTION_DIR;
  if (typeof override === "string" && override.trim() !== "") return absoluteOverride("MERIDIAN_EXECUTION_DIR", override);
  if (runningUnderTestRunner()) {
    throw new Error(
      "REFUSED: a test runner has no MERIDIAN_EXECUTION_DIR set, and the default is the LIVE " +
        "execution directory. Set MERIDIAN_EXECUTION_DIR to a temporary directory (tests/isolate.ts does this) " +
        "rather than writing into the live record.",
    );
  }
  return DEFAULT_EXECUTION_DIR;
}

/** Where the execution root came from, for a report that has to name its own provenance. */
export function executionDirSource(): { dir: string; source: "MERIDIAN_EXECUTION_DIR" | "DEFAULT_EXECUTION_DIR" } {
  const override = process.env.MERIDIAN_EXECUTION_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    return { dir: absoluteOverride("MERIDIAN_EXECUTION_DIR", override), source: "MERIDIAN_EXECUTION_DIR" };
  }
  return { dir: executionDir(), source: "DEFAULT_EXECUTION_DIR" };
}

export function executionPath(name: string): string {
  return resolve(executionDir(), name);
}

/** The execution configuration file. */
export function configPath(): string {
  const override = process.env.MERIDIAN_CONFIG_PATH;
  if (typeof override === "string" && override.trim() !== "") return absoluteOverride("MERIDIAN_CONFIG_PATH", override);
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

/**
 * Where the periodic plain-language reports are written. A directory of its own so the
 * report files (and the state that decides when the next one is due) are never mistaken
 * for the append-only record: they are derived, reproducible artefacts, and the record
 * remains the only authority.
 */
export function reportsDir(): string {
  const override = process.env.MERIDIAN_REPORTS_DIR;
  if (typeof override === "string" && override.trim() !== "") return absoluteOverride("MERIDIAN_REPORTS_DIR", override);
  return executionPath("reports");
}

/** The report scheduler's own state: last report id/time and the last record seq it covered. */
export function reportStatePath(dir: string = reportsDir()): string {
  return resolve(dir, "state.json");
}
