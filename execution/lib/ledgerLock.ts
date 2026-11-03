/**
 * Cross-process exclusive lock for the execution record.
 *
 * Why this exists (2026-11-03): `appendRecord` serialised writers only INSIDE one
 * process (a promise chain), so two watcher processes appending at the same moment
 * each read the same last hash and both wrote seq 1417 — one branch was orphaned and
 * every later record's seq was one below its line number, so the chain verified BROKEN
 * at line 1418. See execution/INCIDENT-2026-11-03-chain-break.md. The in-process chain
 * stays (it avoids needless work) but it cannot protect across processes; this does.
 *
 * Mechanism: an exclusive `flock` held by a short-lived helper process
 * (`flock -x -w N <lockfile> sh -c 'printf LOCKED; exec cat >/dev/null'`). The helper
 * prints LOCKED only after the kernel has granted the lock, and releases it when its
 * stdin closes — which happens when we close the pipe, and also when THIS process dies,
 * because the kernel closes the pipe. So a crash cannot leave the record locked.
 *
 * Fallback: if the `flock` binary is missing (spawn ENOENT) an O_EXCL lock file is used
 * instead, with the same wait budget. It refuses with a named error rather than
 * appending unlocked: an append without the lock is how the chain forks.
 */

import { spawn } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** How long a writer waits for the lock before giving up loudly. */
export const LOCK_WAIT_SECONDS = 30;

export type HeldLock = {
  mechanism: "flock" | "exclusive-file";
  release: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function acquireFlock(lockPath: string): Promise<HeldLock> {
  return new Promise<HeldLock>((resolvePromise, reject) => {
    const child = spawn(
      "flock",
      ["-x", "-w", String(LOCK_WAIT_SECONDS), lockPath, "sh", "-c", "printf 'LOCKED\\n'; exec cat >/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let settled = false;
    let stdout = "";
    let stderr = "";

    child.on("error", (error) => {
      // ENOENT here means the flock binary is missing; withLedgerLock falls back.
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (settled || !stdout.includes("LOCKED")) return;
      settled = true;
      resolvePromise({
        mechanism: "flock",
        release: async () => {
          child.stdin?.end();
          await new Promise<void>((done) => {
            if (child.exitCode !== null) {
              done();
              return;
            }
            const timer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
              done();
            }, 2000);
            timer.unref?.();
            child.once("exit", () => {
              clearTimeout(timer);
              done();
            });
          });
        },
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      const detail = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
      reject(
        new Error(
          `could not take the execution-record lock ${lockPath} (flock exited rc=${code}${detail}); ` +
            "refusing to append unlocked — an unlocked append is how the hash chain forks",
        ),
      );
    });
  });
}

async function acquireExclusiveFile(lockPath: string): Promise<HeldLock> {
  const deadline = Date.now() + LOCK_WAIT_SECONDS * 1000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return {
        mechanism: "exclusive-file",
        release: async () => {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new Error(
          `could not take the execution-record lock ${lockPath} within ${LOCK_WAIT_SECONDS}s; ` +
            "another writer holds it. Refusing to append unlocked rather than risk a forked chain.",
        );
      }
      await sleep(25);
    }
  }
}

/**
 * Run `run` while holding the exclusive lock on `lockPath`. Always released, including
 * when `run` throws. Nested use of the same lock in one process deadlocks — callers take
 * it once, around the whole read-compute-append.
 */
export async function withLedgerLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await acquireFlock(lockPath).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return acquireExclusiveFile(lockPath);
    throw error;
  });
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
