/**
 * The start guard, as tests — so the 2026-11-05 duplicate site server cannot come back.
 *
 * WHAT HAPPENED. The platform's managed wrapper fired the start path twice, concurrently,
 * after a machine replacement. The guard at the time was
 * `sudo lsof -t -iTCP:3000 -sTCP:LISTEN` — a probe, not a lock. Both starts found the port
 * free before either bound it; one server took 3000, and Vite silently moved the other to
 * 3001, where nothing looked. Two site servers, one of them invisible.
 *
 * WHAT THESE TESTS PIN DOWN.
 *   (a) the guard is an exclusive flock held for the life of the server — a second
 *       concurrent start cannot pass it, and it exits 0 with a named reason;
 *   (b) the lock is released when the server exits, including on a signal;
 *   (c) a lock record whose pid is gone is reclaimed AND logged — never silently ignored,
 *       never blindly trusted (a live pid that holds no lock is not trusted either);
 *   (d) a port held by another process is a named failure with a non-zero exit, and the
 *       holder is named from /proc — no sudo, no lsof, nothing that can prompt;
 *   (e) a server that comes up on a port other than the expected one is a named failure;
 *   (f) the lock file descriptor is not leaked to the server (without `flock -o` the
 *       server's own children inherit it and an orphan then holds the lock forever);
 *   (g) nothing in the start path needs sudo, lsof, or a terminal.
 *
 * Every test uses its own temporary directory and its own free port. Nothing here touches
 * the live tree, the live site, the worker or the record.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { isPidAlive, portHolders, probeBind, procStartTime } from "./site-start-guard.ts";

const GUARD = join(import.meta.dir, "site-start-guard.ts");
const SITE_DIR = join(import.meta.dir, "..");
const BUN = process.execPath;

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) { // LIFO: kill the process group before its temp dir is removed
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

/** A port that is free right now. Racy by nature; each test also asserts what it needs. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : rejectPort(new Error("no port"))));
    });
  });
}

/** A scratch site dir: its own lock, log and a fake server that really binds a port. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "start-guard-"));
  const serverPath = join(dir, "fake-server.ts");
  writeFileSync(
    serverPath,
    'const port = Number(process.argv[2]);\nconst s = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("ok") });\nconsole.log(`fake-server on ${s.port}`);\n',
  );
  mkdirSync(join(dir, ".run"), { recursive: true });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    serverPath,
    lockPath: join(dir, ".run", "site.lock"),
    logPath: join(dir, ".run", "start-guard.log"),
    log(): string {
      try {
        return readFileSync(this.logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

interface GuardRun {
  child: ChildProcess;
  output: string;
  done: Promise<number>;
  exited: boolean;
}

function startGuard(opts: {
  port: number;
  lockPath: string;
  logPath: string;
  command: string;
  args: string[];
  driftWindowMs?: number;
}): GuardRun {
  const argv = [GUARD, "--port", String(opts.port), "--lock", opts.lockPath, "--log", opts.logPath];
  if (opts.driftWindowMs) argv.push("--drift-window", String(opts.driftWindowMs));
  argv.push("--", opts.command, ...opts.args);

  const child = spawn(BUN, argv, { stdio: ["ignore", "pipe", "pipe"] });
  const run: GuardRun = { child, output: "", done: Promise.resolve(-1), exited: false };
  child.stdout!.on("data", (chunk) => (run.output += String(chunk)));
  child.stderr!.on("data", (chunk) => (run.output += String(chunk)));
  run.done = new Promise<number>((resolveExit) => {
    child.once("exit", (code) => {
      run.exited = true;
      resolveExit(code ?? 0);
    });
  });
  cleanup.push(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    killGuardGroup(opts.lockPath); // the flock group is a separate session; take it down
  });
  return run;
}

async function waitFor(check: () => boolean, timeoutMs = 10000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function lockIsFree(lockPath: string): boolean {
  // The same kernel question the guard asks: can an exclusive flock be taken right now?
  const result = spawnSync("flock", ["-n", "-E", "75", lockPath, "true"], { encoding: "utf8" });
  return result.status === 0;
}

/**
 * Kill the guard's whole process group, which is a separate session (flock is the group
 * leader), so a test cannot leave a server running. Only kills a group whose leader is
 * demonstrably this lock's flock — never a pid that was merely reused.
 */
function killGuardGroup(lockPath: string): void {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (!record.pid) return;
    const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const pgrp = Number(rest[2]); // field 5: process group id
    if (!Number.isInteger(pgrp) || pgrp <= 1) return;
    const leaderCmd = readFileSync(`/proc/${pgrp}/cmdline`, "utf8");
    if (leaderCmd.includes("flock") && leaderCmd.includes(lockPath)) process.kill(-pgrp, "SIGKILL");
  } catch {
    /* nothing left to kill */
  }
}

// ------------------------------------------------------------------ (a) one server, two starts

describe("two concurrent starts", () => {
  test("exactly one server runs; the second refuses by name and exits 0", async () => {
    const s = scratch();
    const port = await freePort();
    const options = { port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] };

    const first = startGuard(options);
    const second = startGuard(options);
    const runs = [first, second];

    await waitFor(() => portHolders(port).length > 0, 12000, "one server on the port");
    // Either start may win the race — the point is that exactly one of them refuses.
    await waitFor(() => runs.some((r) => r.exited), 8000, "the losing start to exit");

    const loser = runs.find((r) => r.exited)!;
    const winner = runs.find((r) => r !== loser)!;
    expect(await loser.done).toBe(0);
    expect(loser.output).toContain("refused");
    expect(loser.output).toMatch(/recorded holder pid \d+/);
    expect(loser.output).toContain("not starting a second site server");
    expect(loser.output).not.toContain("is free — starting"); // it started nothing

    // Exactly one process holds the listening socket, and only one guard is still alive.
    expect(portHolders(port).length).toBe(1);
    expect(winner.exited).toBe(false);
    await waitFor(() => winner.output.includes("single instance confirmed"), 6000, "the winner to confirm its port");
    expect(winner.output).toContain("single instance confirmed");

    // The lock record names the holder that is actually running.
    const record = JSON.parse(readFileSync(s.lockPath, "utf8"));
    expect(isPidAlive(record.pid)).toBe(true);
    expect(record.port).toBe(port);
  }, 25000);

  test("the lock is a kernel flock, not a file that merely exists", async () => {
    const s = scratch();
    const port = await freePort();
    const run = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the server");

    // The lock file exists AND the exclusive lock on it is genuinely held.
    expect(readFileSync(s.lockPath, "utf8").length).toBeGreaterThan(0);
    expect(lockIsFree(s.lockPath)).toBe(false);

    // Release: signalling the guard takes the whole group down and frees the lock.
    run.child.kill("SIGTERM");
    const code = await run.done;
    expect(code).not.toBe(-1);
    await waitFor(() => lockIsFree(s.lockPath), 8000, "the lock to be released");
    await waitFor(() => portHolders(port).length === 0, 8000, "the port to be released");

    // And a fresh start now succeeds — the lock is genuinely free, not merely stale.
    const again = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the second server");
    expect(again.exited).toBe(false);
  }, 30000);
});

// ------------------------------------------------------------------ (b) stale / reused pid

describe("lock records that are not trustworthy", () => {
  test("a record whose pid is gone is reclaimed and the reclamation is logged", async () => {
    const s = scratch();
    const port = await freePort();

    const dead = spawnSync("true", [], { stdio: "ignore" }); // exits at once: its pid is gone
    const deadPid = dead.pid!;
    await waitFor(() => !isPidAlive(deadPid), 5000, "the helper process to die");

    writeFileSync(
      s.lockPath,
      JSON.stringify({ pid: deadPid, pidStartTime: "1", startedAt: "2026-01-01T00:00:00.000Z", port, argv: [] }),
    );

    const run = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the server");

    const log = s.log();
    expect(log).toContain("reclaiming stale lock record");
    expect(log).toContain(`pid ${deadPid}`);
    expect(log).toContain("is gone");
    expect(run.exited).toBe(false);
  }, 25000);

  test("a record naming a live pid that holds no lock is not trusted", async () => {
    const s = scratch();
    const port = await freePort();
    const startTime = procStartTime(process.pid)!;

    writeFileSync(
      s.lockPath,
      JSON.stringify({ pid: process.pid, pidStartTime: startTime, startedAt: "2026-01-01T00:00:00.000Z", port, argv: [] }),
    );

    const run = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the server");

    const log = s.log();
    expect(log).toContain(`live pid ${process.pid}`);
    expect(log).toContain("does NOT hold the lock");
    expect(run.exited).toBe(false);
  }, 25000);

  test("a record whose pid was reused (same pid, different start time) is reclaimed", async () => {
    const s = scratch();
    const port = await freePort();

    writeFileSync(
      s.lockPath,
      // Our own pid, but a start time that is not ours: exactly what pid reuse looks like.
      JSON.stringify({ pid: process.pid, pidStartTime: "1", startedAt: "2026-01-01T00:00:00.000Z", port, argv: [] }),
    );

    const run = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the server");
    expect(s.log()).toContain("pid reused");
    expect(run.exited).toBe(false);
  }, 25000);
});

// ------------------------------------------------------------------ (c) port held by another

describe("the port is not free", () => {
  test("a foreign listener is a named failure with a non-zero exit, and nothing is started", async () => {
    const s = scratch();
    const port = await freePort();
    const blocker = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("not the site") });
    cleanup.push(() => blocker.stop(true));

    const run = startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    const code = await run.done;

    expect(code).toBe(2);
    expect(run.output).toContain(`port ${port} is held by`);
    expect(run.output).toContain(`pid ${process.pid}`); // the holder is named, from /proc
    expect(run.output).toContain("Vite must never drift to another port");
    // Nothing was started, and the lock was released on the way out.
    expect(portHolders(port).map((h) => h.pid)).toEqual([process.pid]);
    await waitFor(() => lockIsFree(s.lockPath), 5000, "the lock to be released");
  }, 20000);
});

// ------------------------------------------------------------------ (d) port drift

describe("port drift", () => {
  test("a server that comes up on another port is a named failure, not a quiet success", async () => {
    const s = scratch();
    const wanted = await freePort();
    let other = await freePort();
    while (other === wanted) other = await freePort();

    const run = startGuard({
      port: wanted,
      lockPath: s.lockPath,
      logPath: s.logPath,
      command: BUN,
      args: [s.serverPath, String(other)], // deliberately binds the wrong port
      driftWindowMs: 8000,
    });
    const code = await run.done;

    expect(code).toBe(3);
    expect(run.output).toContain("PORT DRIFT");
    expect(run.output).toContain(String(other));
    expect(run.output).toContain(String(wanted));
    await waitFor(() => portHolders(other).length === 0, 8000, "the drifting server to be stopped");
  }, 25000);
});

// ------------------------------------------------------------------ (e) no leaked lock fd

describe("the lock is not leaked down the process tree", () => {
  test("the running server does not hold the lock file open", async () => {
    const s = scratch();
    const port = await freePort();
    startGuard({ port, lockPath: s.lockPath, logPath: s.logPath, command: BUN, args: [s.serverPath, String(port)] });
    await waitFor(() => portHolders(port).length > 0, 12000, "the server");

    const serverPid = portHolders(port)[0].pid;
    const fds = readdirSync(`/proc/${serverPid}/fd`);
    const openPaths = fds
      .map((fd) => {
        try {
          return readlinkSync(`/proc/${serverPid}/fd/${fd}`);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    expect(openPaths).not.toContain(s.lockPath);
    // ...while the lock is still held by the guard's flock.
    expect(lockIsFree(s.lockPath)).toBe(false);
  }, 25000);
});

// ------------------------------------------------------------------ (f) the start path itself

describe("the start path", () => {
  const source = readFileSync(GUARD, "utf8");
  const devServer = readFileSync(join(SITE_DIR, "dev-server.sh"), "utf8");
  // Code only: strip block comments so the header's description of the old guard
  // ("sudo lsof") is not mistaken for the code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const devCode = devServer.replace(/^\s*#.*$/gm, "");

  test("no sudo and no lsof anywhere in the start path", () => {
    for (const [name, text] of [
      ["site-start-guard.ts", code],
      ["dev-server.sh", devCode],
    ] as const) {
      expect({ name, sudo: /\bsudo\b/.test(text) }).toEqual({ name, sudo: false });
      expect({ name, lsof: /\blsof\b/.test(text) }).toEqual({ name, lsof: false });
    }
  });

  test("nothing in the start path can block on a terminal prompt", () => {
    for (const [name, text] of [
      ["site-start-guard.ts", code],
      ["dev-server.sh", devCode],
    ] as const) {
      expect({ name, read: /\bread\s+-[a-z]*p/.test(text) }).toEqual({ name, read: false });
      expect({ name, stdin: /< *\/dev\/tty/.test(text) }).toEqual({ name, stdin: false });
    }
  });

  test("the start path uses the guard, holds the lock with flock, and refuses to drift", () => {
    expect(devCode).toContain("scripts/site-start-guard.ts");
    expect(devCode).toContain("--strictPort"); // Vite may never quietly take the next port
    expect(code).toContain('"flock"');
    expect(code).toContain('"-n"');
    expect(code).toContain('"-o"'); // no lock fd inheritance
  });

  test("dev-server.sh refuses to start at all if the guard is missing", () => {
    expect(devCode).toContain("refusing to start unguarded");
  });

  test("the guard probes a bind before starting, and a bind that fails names the holder", async () => {
    // probeBind is the cheap confirmation used after the lock is taken.
    const port = await freePort();
    expect(await probeBind(port)).toBeNull(); // free: null
    const blocker = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("x") });
    cleanup.push(() => blocker.stop(true));
    expect(await probeBind(port)).toContain("EADDRINUSE");
  }, 15000);
});
