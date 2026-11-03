#!/bin/bash
# Re-installable, idempotent installer for the Meridian Practice worker supervisor.
#
# What it does, and why:
#  1. Ensures run-watcher.sh exists and is executable. run-watcher.sh is the supervisor: it
#     restarts the watcher (`bun operator.ts watch`) if it dies, with a backoff, logging to
#     .run/watcher.log. It is kept as it is; this script never rewrites it.
#  2. Installs a boot hook into /entrypoint.sh, between two marker lines. PID 1 on this
#     machine is /entrypoint.sh and it runs on every boot; there is no systemd and no cron.
#     The hook calls this script with --boot, which starts the supervisor only if it is not
#     already running. Re-running this script replaces the marked block in place, so the
#     hook can never be installed twice.
#  3. Stops any ORPHAN watcher (`bun operator.ts watch` whose parent is not a live
#     run-watcher.sh) before starting anything. An orphan is a second writer on
#     orders.jsonl; on 2026-11-03 one forked the hash chain
#     (INCIDENT-2026-11-03-chain-break.md). A supervised watcher is identified by its
#     parent process and left alone.
#  4. Starts the supervisor now if nothing is running, detached (setsid) so it outlives the
#     terminal or session that started it.
#
# Safe to run any number of times: it starts nothing twice, and re-writing the entrypoint
# hook is a no-op once the block is current. Nothing here submits orders — submission is
# gated inside engine.ts on an explicit approval (approve-before-execution) or automatic mode,
# and config.json is approve-before-execution with automatic unreachable.
#
# Usage:  install-supervisor.sh                    install hook + start if not running (re-runnable)
#         install-supervisor.sh --boot             same, quieter, as called from /entrypoint.sh
#         install-supervisor.sh --boot --no-entrypoint
#                                                  same, but never touch /entrypoint.sh — used by the
#                                                  site's own start path (site/dev-server.sh), because the
#                                                  entrypoint hook is image-level and does not survive a
#                                                  machine restart, so that path must not depend on it.
set -u

EXEC_DIR=/home/team/shared/execution
WATCHER="$EXEC_DIR/run-watcher.sh"
PIDFILE="$EXEC_DIR/.run/supervisor.pid"
OUTLOG="$EXEC_DIR/.run/supervisor.log"
LOCKFILE="$EXEC_DIR/.run/install.lock"
ENTRYPOINT=/entrypoint.sh
BOOT=0
NO_ENTRY=0
for arg in "$@"; do
  case "$arg" in
    --boot) BOOT=1 ;;
    --no-entrypoint) NO_ENTRY=1 ;;
  esac
done

say() { echo "[install-supervisor] $(date -u +%FT%TZ) $*"; }

if [ ! -f "$WATCHER" ]; then
  echo "[install-supervisor] MISSING $WATCHER — cannot supervise a watcher that is not there" >&2
  exit 1
fi
chmod +x "$WATCHER"
mkdir -p "$EXEC_DIR/.run"

# ---------------------------------------------------------------- 1. boot hook (idempotent)
if [ "$NO_ENTRY" = "1" ]; then
  [ "$BOOT" = "1" ] || say "called with --no-entrypoint; /entrypoint.sh left untouched"
elif [ -w "$ENTRYPOINT" ]; then
  python3 - "$ENTRYPOINT" <<'PY'
import sys

path = sys.argv[1]
BEGIN = "# >>> meridian-worker-supervisor"
END = "# <<< meridian-worker-supervisor"
BLOCK = """# >>> meridian-worker-supervisor (installed by execution/install-supervisor.sh; re-run that to refresh) >>>
# Start the Meridian Practice worker under its restarting supervisor. Idempotent: it starts
# nothing if the supervisor is already running. Best-effort — a failure here must not abort
# the entrypoint (set -e) and take the sandbox API down with it.
if [ -x /home/team/shared/execution/install-supervisor.sh ]; then
  /home/team/shared/execution/install-supervisor.sh --boot || true
fi
# <<< meridian-worker-supervisor <<<"""

with open(path) as fh:
    src = fh.read()

out, skipping = [], False
for line in src.splitlines(keepends=True):
    if line.startswith(BEGIN):
        skipping = True
        continue
    if line.startswith(END):
        skipping = False
        continue
    if not skipping:
        out.append(line)

# The hook must run before the entrypoint's trailing `wait`, which never returns.
idx = None
for i, line in enumerate(out):
    if line.strip() == "wait":
        idx = i
if idx is None:
    out.append("\n" + BLOCK + "\n")
else:
    out.insert(idx, BLOCK + "\n")

new = "".join(out)
if new == src:
    print("[install-supervisor] boot hook in %s already current" % path)
else:
    with open(path, "w") as fh:
        fh.write(new)
    print("[install-supervisor] boot hook installed in %s" % path)
PY
else
  say "cannot write $ENTRYPOINT; boot hook NOT installed (run as root)"
fi

# ---------------------------------------------------------------- 2. orphan watchers
# A `bun operator.ts watch` whose parent is not a live run-watcher.sh is an ORPHAN: it
# survived a supervisor that was killed without stopping its child. That is not a
# cosmetic leftover — it is a second writer appending to orders.jsonl. On 2026-11-03 two
# writers both wrote seq 1417 and the hash chain has read BROKEN ever since
# (INCIDENT-2026-11-03-chain-break.md). Orphans are stopped here, before anything starts.
# The supervised watcher is identified by its parent and left strictly alone.
stop_orphan_watchers() {
  local pid ppid args stopped=0
  for pid in $(pgrep -f "operator[.]ts watch" 2>/dev/null || true); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ -n "${ppid:-}" ] && [ "$ppid" != "1" ]; then
      args="$(ps -o args= -p "$ppid" 2>/dev/null || true)"
      case "$args" in
        *run-watcher[.]sh*) continue ;;   # supervised by a live supervisor: not ours to touch
      esac
    fi
    say "orphan watcher pid $pid (parent ${ppid:-none}) has no supervisor; stopping it"
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "orphan pid $pid ignored TERM for 5s; sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      sleep 0.3
    fi
    if kill -0 "$pid" 2>/dev/null; then
      say "FAILED to stop orphan watcher pid $pid — stop it by hand before starting a supervisor"
      exit 1
    fi
    say "orphan watcher pid $pid stopped"
    stopped=$((stopped + 1))
  done
  [ "$stopped" = "0" ] || say "stopped $stopped orphan watcher(s)"
}

# ---------------------------------------------------------------- 3. already running?
# One installer at a time: two starts landing together (the managed dev-server wrapper
# restarts `bun run dev`, and the entrypoint hook can fire in the same window) must not both
# pass the "not running yet" checks below and start a supervisor each. The lock is advisory
# and short-lived; the fd is closed for the detached child so the watcher does not inherit it.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE" || true
  flock -w 20 9 || say "could not take $LOCKFILE within 20s; checking for a running supervisor anyway"
fi

# Inside the installer lock: an orphan is stopped once, and a supervisor that is already
# running (whose watcher must survive) is never mistaken for one.
stop_orphan_watchers

if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    [ "$BOOT" = "1" ] || say "supervisor already running (pid $pid); nothing to start"
    exit 0
  fi
fi
# A supervisor started before this script existed has no pidfile; find it by name.
if pgrep -f "run-watcher[.]sh" >/dev/null 2>&1; then
  [ "$BOOT" = "1" ] || say "supervisor already running (no pidfile); nothing to start"
  exit 0
fi

# ---------------------------------------------------------------- 3. start it, detached
# 9>&- : the detached child must not inherit the installer's lock fd.
setsid nohup "$WATCHER" >> "$OUTLOG" 2>&1 9>&- &
pid=$!
echo "$pid" > "$PIDFILE"
sleep 1
if kill -0 "$pid" 2>/dev/null; then
  say "supervisor started (pid $pid); watcher log $EXEC_DIR/.run/watcher.log"
else
  say "supervisor FAILED to stay up (pid $pid exited); see $OUTLOG"
  exit 1
fi
