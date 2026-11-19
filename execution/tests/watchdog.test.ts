/**
 * watchdog.sh — the rung below the supervisor.
 *
 * Why this test exists: run-watcher.sh restarts its watcher child, but until 2026-11-19 nothing
 * restarted run-watcher.sh itself. The worker was silent from 2026-11-13T10:57Z to 2026-11-19
 * and came back only because the site's start path was invoked by hand. watchdog.sh re-runs
 * install-supervisor.sh every interval while the machine is up.
 *
 * What is asserted here, without touching the live tree:
 *   - one attempt calls the installer exactly once;
 *   - a missing installer is a named failure, not a silent no-op;
 *   - the loop keeps attempting;
 *   - a second watchdog refuses to run (one watchdog per machine, by flock).
 *
 * install-supervisor.sh itself hardcodes the live execution directory, so it is never invoked
 * from here: MERIDIAN_INSTALLER points at a stub that counts its calls in the test directory.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate } from "./isolate.ts";

const testDir = isolate();
const WATCHDOG = join(import.meta.dir, "..", "watchdog.sh");
const COUNTER = join(testDir, "installer-calls.txt");
const STUB = join(testDir, "install-supervisor.sh");

mkdirSync(join(testDir, ".run"), { recursive: true });
writeFileSync(
  STUB,
  `#!/bin/bash\n# test stub for install-supervisor.sh: counts one call, starts nothing\necho call >> ${JSON.stringify(COUNTER)}\n`,
);
chmodSync(STUB, 0o755);

const calls = (): number =>
  existsSync(COUNTER) ? readFileSync(COUNTER, "utf8").trim().split("\n").filter(Boolean).length : 0;

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  MERIDIAN_EXECUTION_DIR: testDir,
  MERIDIAN_INSTALLER: STUB,
  ...extra,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loops: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const child of loops) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

describe("watchdog.sh", () => {
  test("--once runs the installer exactly once", () => {
    const before = calls();
    const r = spawnSync("bash", [WATCHDOG, "--once"], { env: env(), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(calls()).toBe(before + 1);
  });

  test("a missing installer is a named failure, not a silent no-op", () => {
    const r = spawnSync("bash", [WATCHDOG, "--once"], {
      env: env({ MERIDIAN_INSTALLER: join(testDir, "does-not-exist.sh") }),
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    const log = readFileSync(join(testDir, ".run", "watchdog.log"), "utf8");
    expect(log).toContain("is missing or not executable; cannot repair");
  });

  test(
    "the loop keeps attempting, and a second watchdog refuses to run",
    async () => {
      const before = calls();
      const loop = spawn("bash", [WATCHDOG], {
        env: env({ MERIDIAN_WATCHDOG_INTERVAL: "1" }),
        stdio: "ignore",
        detached: true,
      });
      loops.push(loop);

      // Two attempts take a little over a second; give the flock a moment to be taken.
      await sleep(2600);
      const afterLoop = calls();
      expect(afterLoop).toBeGreaterThanOrEqual(before + 2);

      // A second watchdog must exit 0 and start nothing: the lock is held for the first's life.
      const second = spawnSync("bash", [WATCHDOG, "--once"], { env: env(), encoding: "utf8" });
      expect(second.status).toBe(0);
      expect(second.stderr).toContain("another watchdog already holds");
      expect(calls()).toBe(afterLoop);

      // Killing the loop releases the lock, and the next one is allowed to run again.
      loop.kill("SIGKILL");
      await sleep(300);
      const after = calls();
      const third = spawnSync("bash", [WATCHDOG, "--once"], { env: env(), encoding: "utf8" });
      expect(third.status).toBe(0);
      expect(calls()).toBe(after + 1);
    },
    15000,
  );
});
