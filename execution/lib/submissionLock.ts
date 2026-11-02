import { mkdir, rmdir } from "node:fs/promises";
import { executionDir, executionPath } from "./paths.ts";

// Never expire a lock automatically: a slow broker request may still be in flight.
// After a crash, reconcile broker state before manually removing this directory.
export async function withSubmissionLock<T>(run: () => Promise<T>): Promise<T> {
  await mkdir(executionDir(), { recursive: true });
  const lock = executionPath("submission.lock");
  await mkdir(lock).catch(() => { throw new Error("Another submission is running, or a crash left a lock. Reconcile before removing submission.lock."); });
  try { return await run(); } finally { await rmdir(lock); }
}
