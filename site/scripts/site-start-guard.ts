#!/usr/bin/env bun
/**
 * site-start-guard.ts — the start path's single-instance guard.
 *
 * WHY THIS FILE EXISTS. On 2026-11-05 a machine replacement made the platform's managed
 * dev-server wrapper fire its start path TWICE, concurrently. Both starts looked for a
 * listener on port 3000, both found the port free before either had bound it, and the
 * result was two site servers: one on 3000 (the real one) and a second that Vite silently
 * moved to 3001. The old guard was `sudo lsof -t -iTCP:3000 -sTCP:LISTEN` — a check-then-act
 * probe, not a lock. It could lose the race, it could block on a password prompt in a
 * non-interactive shell (and a failed probe reads as "port free"), and it only ever looked
 * at 3000, so a server that drifted to 3001 was invisible to it and to every later check.
 *
 * WHAT REPLACES IT.
 *   1. An exclusive lock, not a probe: `flock -n` on `.run/site.lock`, held by the kernel
 *      for the whole life of the site server and released on exit — including on SIGKILL,
 *      because the kernel drops it. A second start that cannot take the lock exits with a
 *      named reason instead of starting a second server.
 *   2. No sudo, no lsof, no interactive prompt. util-linux `flock`, /proc and node's own
 *      `net` module. Nothing in this path can block waiting for a password.
 *   3. A port check as a second, cheap confirmation AFTER the lock: a real bind attempt,
 *      and if the port is held, the holder is named from /proc and the start exits non-zero
 *      rather than letting Vite drift to 3001. Drift is also watched after the server is up,
 *      and a listener on any port other than the expected one is a named failure.
 *
 * HOW IT IS BUILT. `flock <lock> <command>` runs the command only once it holds the lock, so
 * the guard runs itself twice:
 *
 *   outer  — sees an existing lock record, spawns `flock -n -E 75 <lock> <bun> <self> --inner …`
 *            and turns flock's conflict exit (75) into a named refusal. Exit 0: the site is
 *            already running; nothing to do.
 *   inner  — runs only while the lock is held. Records who holds it, checks the port, spawns
 *            the real server, watches for port drift, forwards signals, propagates the exit.
 *
 * The lock file's CONTENT is diagnostic only (who holds it, since when) — the lock is the
 * flock, so a stale record can never be trusted into a second server. A record whose pid is
 * gone is reported and reclaimed in the log; never silently ignored, never blindly trusted.
 *
 * It holds no secrets and reads no environment: nothing here can print a credential.
 */

import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const CONFLICT_EXIT = 75; // util-linux flock -E: "could not take the lock"

export interface LockRecord {
  pid: number;
  /** /proc/<pid>/stat field 22 — start time in clock ticks. Defeats pid reuse. */
  pidStartTime: string | null;
  startedAt: string;
  port: number;
  argv: string[];
}

export interface GuardOptions {
  /** Path of the lock file. The lock is an flock on it; its content is diagnostic. */
  lockPath: string;
  /** The port the site must be listening on. */
  port: number;
  /** The command to run once the lock is held (vite, in production). */
  command: string;
  args: string[];
  /** Append-only log of every start decision. */
  logPath: string;
  /** How long to watch for the server to appear on the expected port (ms). */
  driftWindowMs?: number;
  /** Injectables so the tests can drive this without touching the live tree. */
  flockBin?: string;
  bunBin?: string;
  selfPath?: string;
}

// ------------------------------------------------------------------ /proc helpers

/** Start time of a pid from /proc/<pid>/stat field 22, or null if the pid is gone. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so split after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // rest[0] is field 3 (state); field 22 is therefore rest[19].
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/** True if a process with this pid exists and can be signalled. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A record is live only if its pid exists AND has the same start time (not a reused pid). */
export function recordIsLive(record: LockRecord | null): boolean {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1) return false;
  if (!isPidAlive(record.pid)) return false;
  if (record.pidStartTime === null) return true; // no start time recorded: trust liveness only
  return procStartTime(record.pid) === record.pidStartTime;
}

export function readLockRecord(lockPath: string): { record: LockRecord | null; raw: string | null; error: string | null } {
  try {
    const raw = readFileSync(lockPath, "utf8");
    if (raw.trim() === "") return { record: null, raw, error: null }; // first start: empty file
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed?.pid !== "number") {
      return { record: null, raw, error: `lock record has no numeric pid (${raw.trim().slice(0, 80) || "empty"})` };
    }
    return {
      record: {
        pid: parsed.pid,
        pidStartTime: typeof parsed.pidStartTime === "string" ? parsed.pidStartTime : null,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
        port: typeof parsed.port === "number" ? parsed.port : -1,
        argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
      },
      raw,
      error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { record: null, raw: null, error: null };
    return { record: null, raw: null, error: `lock record unreadable: ${(error as Error).message}` };
  }
}

/** Ports in LISTEN state, mapped to the socket inode the kernel reports for them. */
function listeningSockets(): Map<number, Set<string>> {
  const ports = new Map<number, Set<string>>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      if (fields[3] !== "0A") continue; // 0A == TCP_LISTEN
      const port = parseInt(fields[1].split(":").pop() ?? "", 16);
      const inode = fields[9];
      if (!Number.isFinite(port) || !inode || inode === "0") continue;
      if (!ports.has(port)) ports.set(port, new Set());
      ports.get(port)!.add(inode);
    }
  }
  return ports;
}

/** Every pid that owns one of these socket inodes, with the ports it owns. */
export function pidsOwningSockets(inodes: Set<string>): Map<number, Set<number>> {
  const owners = new Map<number, Set<number>>();
  if (inodes.size === 0) return owners;
  // inode -> port, so a hit can be reported by port.
  const inodePort = new Map<string, number>();
  for (const [port, set] of listeningSockets()) for (const inode of set) inodePort.set(inode, port);

  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return owners;
  }
  for (const name of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue; // raced with the process exiting, or not ours to read
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (!match) continue;
      if (!inodes.has(match[1])) continue;
      const pid = Number(name);
      if (!owners.has(pid)) owners.set(pid, new Set());
      owners.get(pid)!.add(inodePort.get(match[1]) ?? -1);
    }
  }
  return owners;
}

/** Who is listening on this port, by name. Empty when the port is free. */
export function portHolders(port: number): { pid: number; command: string }[] {
  const inodes = listeningSockets().get(port);
  if (!inodes || inodes.size === 0) return [];
  const owners = pidsOwningSockets(inodes);
  const holders: { pid: number; command: string }[] = [];
  for (const pid of owners.keys()) {
    let command = "unknown command";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 200);
    } catch {
      /* keep "unknown command" */
    }
    holders.push({ pid, command });
  }
  return holders;
}

/** Root pid plus all its descendants, from the ppid field of /proc/<pid>/stat. */
export function pidTree(rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return new Set([rootPid]);
  }
  for (const name of pids) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ppid = Number(rest[1]);
    if (!Number.isFinite(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(Number(name));
  }
  const tree = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      queue.push(child);
    }
  }
  return tree;
}

/** Ports the given pid tree is listening on, right now. */
export function listeningPortsOfPids(pids: Set<number>): Set<number> {
  const listening = listeningSockets();
  const wanted = new Set<string>();
  for (const inodes of listening.values()) for (const inode of inodes) wanted.add(inode);
  if (wanted.size === 0) return new Set();
  const owners = pidsOwningSockets(wanted);
  const ports = new Set<number>();
  for (const [pid, pidPorts] of owners) {
    if (!pids.has(pid)) continue;
    for (const port of pidPorts) ports.add(port);
  }
  return ports;
}

/** Can this process bind the port right now? Returns null on success, or the reason. */
export function probeBind(port: number): Promise<string | null> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    const done = (reason: string | null) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolveProbe(reason);
    };
    server.once("error", (error: NodeJS.ErrnoException) => done(`${error.code ?? "error"}: ${error.message}`));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => done(null));
  });
}

// ------------------------------------------------------------------ logging

function makeLogger(logPath: string | null) {
  return (message: string) => {
    const line = `[start-guard] ${new Date().toISOString()} ${message}`;
    process.stderr.write(line + "\n");
    if (!logPath) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + "\n");
    } catch {
      /* a log that cannot be written must never stop the site starting */
    }
  };
}

// ------------------------------------------------------------------ guard

function nowIso(): string {
  return new Date().toISOString();
}

/** Signals a start must pass through to the server it started. */
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Inner mode: the lock is held. Record the holder, confirm the port, run the server,
 * watch for port drift. Never returns before the server exits.
 */
async function runInner(options: GuardOptions, log: (m: string) => void): Promise<number> {
  // The previous holder's record is only worth a line in the log — the flock is the lock,
  // and we hold it, so the previous holder is definitively gone.
  const previous = readLockRecord(options.lockPath);
  if (previous.error) log(`previous lock record was unusable (${previous.error}); reclaiming it`);
  else if (previous.record) {
    const r = previous.record;
    const live = recordIsLive(r);
    const startTime = procStartTime(r.pid);
    if (!isPidAlive(r.pid)) {
      log(`reclaiming stale lock record: holder pid ${r.pid} (started ${r.startedAt}, port ${r.port}) is gone`);
    } else if (live) {
      // Alive and matching start time, yet we hold the lock: it never held this lock (or it
      // gave it up and is still running). Recorded, not assumed.
      log(
        `previous lock record named live pid ${r.pid} which does NOT hold the lock — the record was stale, reclaiming it`,
      );
    } else {
      log(
        `previous lock record named pid ${r.pid}, which is a different process now (pid reused: start time ${startTime} ≠ ${r.pidStartTime}) — reclaiming it`,
      );
    }
  }

  const record: LockRecord = {
    pid: process.pid,
    pidStartTime: procStartTime(process.pid),
    startedAt: nowIso(),
    port: options.port,
    argv: [options.command, ...options.args],
  };
  try {
    writeFileSync(options.lockPath, JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    log(`could not record the lock holder (${(error as Error).message}); the lock itself is still held`);
  }

  // Second, cheap confirmation, AFTER the lock: is the port genuinely free?
  const bindError = await probeBind(options.port);
  if (bindError) {
    const holders = portHolders(options.port);
    const named = holders.length
      ? holders.map((h) => `pid ${h.pid} (${h.command})`).join(", ")
      : "a process whose owner this process cannot inspect";
    log(
      `port ${options.port} is held by ${named}; refusing to start — Vite must never drift to another port (bind said: ${bindError})`,
    );
    return 2;
  }

  log(`lock held by pid ${process.pid}; port ${options.port} is free — starting: ${[options.command, ...options.args].join(" ")}`);

  let child: ChildProcess;
  try {
    child = spawn(options.command, options.args, { stdio: "inherit", env: process.env });
  } catch (error) {
    log(`could not start ${options.command}: ${(error as Error).message}`);
    return 4;
  }

  let driftTimer: ReturnType<typeof setInterval> | null = null;
  let driftSeen = false;
  let confirmed = false;
  const windowMs = options.driftWindowMs ?? 20000;
  const deadline = Date.now() + windowMs;

  const stopDriftWatch = () => {
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = null;
  };

  const checkDrift = () => {
    if (!child.pid || driftSeen || confirmed) return;
    const tree = pidTree(child.pid);
    const ports = listeningPortsOfPids(tree);
    if (ports.has(options.port)) {
      confirmed = true;
      log(`site listening on ${options.port} (pid ${child.pid}); single instance confirmed`);
      stopDriftWatch();
      return;
    }
    const elsewhere = [...ports].filter((p) => p !== options.port);
    if (elsewhere.length) {
      driftSeen = true;
      stopDriftWatch();
      log(
        `PORT DRIFT: the site is listening on ${elsewhere.join(", ")}, not ${options.port} — refusing to run a second, off-port server; stopping pid ${child.pid}`,
      );
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };

  driftTimer = setInterval(() => {
    if (Date.now() > deadline) {
      stopDriftWatch();
      if (!confirmed && !driftSeen) {
        log(`no listener on port ${options.port} observed within ${windowMs}ms of starting (the server is still running; this is reported, not hidden)`);
      }
      return;
    }
    checkDrift();
  }, 250);

  for (const signal of FORWARDED) {
    process.on(signal as NodeJS.Signals, () => {
      try {
        child.kill(signal as NodeJS.Signals);
      } catch {
        /* already gone */
      }
    });
  }

  return await new Promise<number>((resolveExit) => {
    child.once("exit", (code, signal) => {
      stopDriftWatch();
      const status = signal ? 128 + (signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0) : (code ?? 0);
      if (driftSeen) {
        log(`stopped: port drift (server exited with ${signal ?? code})`);
        resolveExit(3);
        return;
      }
      log(`site server pid ${child.pid} exited (${signal ? `signal ${signal}` : `code ${code}`}); releasing the lock`);
      resolveExit(status);
    });
    child.once("error", (error) => {
      stopDriftWatch();
      log(`site server failed to start: ${error.message}`);
      resolveExit(4);
    });
  });
}

/**
 * Outer mode: take the lock, or refuse by name. Returns the process exit code.
 *   0 — the site is already running (refused, named) or the server exited cleanly
 *   2 — the port is held by something else (named)
 *   3 — the server came up on a port other than the expected one (named)
 *   otherwise — the server's own exit code
 */
export async function runGuard(options: GuardOptions): Promise<number> {
  const log = makeLogger(options.logPath);
  const flockBin = options.flockBin ?? "flock";
  const bunBin = options.bunBin ?? process.execPath;
  const selfPath = options.selfPath ?? fileURLToPath(import.meta.url);

  // flock creates the lock file if it is missing on modern util-linux; create it ourselves
  // so an old build cannot turn "no lock file" into "no lock".
  try {
    mkdirSync(dirname(options.lockPath), { recursive: true });
    closeSync(openSync(options.lockPath, "a"));
  } catch (error) {
    log(`cannot create the lock file ${options.lockPath}: ${(error as Error).message} — refusing to start unlocked`);
    return 5;
  }

  const innerArgs = [
    "--inner",
    "--lock",
    options.lockPath,
    "--port",
    String(options.port),
    "--log",
    options.logPath,
    "--drift-window",
    String(options.driftWindowMs ?? 20000),
    "--",
    options.command,
    ...options.args,
  ];

  // flock runs the inner guard only once it holds the lock. -n: never wait. -E 75: a
  // conflict is distinguishable from the server's own exit code. -o is load-bearing:
  // without it the lock file descriptor is inherited by every process below (guard, Vite,
  // esbuild), so killing the listener would leave an esbuild holding the lock and every
  // later start refusing forever. Measured on util-linux 2.39.3: without -o a surviving
  // child keeps the lock after flock itself is signalled.
  // detached: the whole start becomes one process group, so a forwarded signal takes the
  // lock holder and the server down together — no orphan holding or losing the lock.
  const flock = spawn(
    flockBin,
    ["-n", "-o", "-E", String(CONFLICT_EXIT), options.lockPath, bunBin, selfPath, ...innerArgs],
    { stdio: "inherit", env: process.env, detached: true },
  );

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!flock.pid) return;
    try {
      process.kill(-flock.pid, signal); // the whole group: flock, the inner guard, the server
    } catch {
      try {
        flock.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  for (const signal of FORWARDED) {
    process.on(signal as NodeJS.Signals, () => signalGroup(signal as NodeJS.Signals));
  }

  return await new Promise<number>((resolveExit) => {
    flock.once("error", (error) => {
      log(`could not run ${flockBin}: ${error.message} — refusing to start unlocked`);
      resolveExit(5);
    });
    flock.once("exit", (code) => {
      if (code === CONFLICT_EXIT) {
        // The winner may still be writing its record (it takes the lock, then records
        // itself). Wait a bounded moment for the name rather than reporting "unknown" —
        // but never wait forever, and never invent a holder.
        void (async () => {
          let { record, error } = readLockRecord(options.lockPath);
          for (let waited = 0; waited < 1000 && !record && !error; waited += 25) {
            await new Promise((r) => setTimeout(r, 25));
            ({ record, error } = readLockRecord(options.lockPath));
          }
          if (error) {
            log(`refused: another start holds ${options.lockPath} and its record is unusable (${error}); not starting a second site server`);
          } else if (record) {
            const live = recordIsLive(record);
            log(
              `refused: another start holds the site lock — recorded holder pid ${record.pid} (started ${record.startedAt}, port ${record.port})${
                live ? "" : ", and that pid is GONE: an orphaned child still holds the lock (see /proc)"
              }; not starting a second site server — this start is doing nothing`,
            );
          } else {
            log(`refused: another start holds the site lock (no holder recorded); not starting a second site server`);
          }
          resolveExit(0);
        })();
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}

// ------------------------------------------------------------------ CLI

function parseArgv(argv: string[]): { inner: boolean; options: GuardOptions } {
  const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let inner = false;
  let lockPath = join(siteDir, ".run", "site.lock");
  let logPath = join(siteDir, ".run", "start-guard.log");
  let port = Number(process.env.PORT ?? 3000);
  let driftWindowMs = 20000;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--inner") inner = true;
    else if (arg === "--lock") lockPath = argv[++i];
    else if (arg === "--port") port = Number(argv[++i]);
    else if (arg === "--log") logPath = argv[++i];
    else if (arg === "--drift-window") driftWindowMs = Number(argv[++i]);
    else if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    } else rest.push(arg);
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be a port number, got ${port}`);
  }
  if (rest.length === 0) {
    throw new Error("no command to run: usage: site-start-guard.ts [--port N] -- <command> [args...]");
  }

  return {
    inner,
    options: {
      lockPath,
      port,
      command: rest[0],
      args: rest.slice(1),
      logPath,
      driftWindowMs,
    },
  };
}

if (import.meta.main ?? false) {
  let parsed: { inner: boolean; options: GuardOptions };
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[start-guard] ${(error as Error).message}\n`);
    process.exit(64);
  }
  const code = parsed.inner ? await runInner(parsed.options, makeLogger(parsed.options.logPath)) : await runGuard(parsed.options);
  process.exit(code);
}
