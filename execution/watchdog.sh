#!/bin/bash
# Self-healing watchdog for the Meridian Practice worker.
#
# WHY THIS EXISTS (2026-11-19). run-watcher.sh restarts its own watcher child, but nothing
# restarted run-watcher.sh itself. On 2026-11-19 the record showed the worker silent from
# 2026-11-13T10:57Z and the site silent from 2026-11-12T22:36Z; the computer's own boot time
# (`uptime -s`) was 2026-11-19T00:01:30Z, so for 5½ days there was no process of ours to
# restart — the machine was not running. When it did come back, nothing started the worker
# until the site's start path was invoked at 00:14:32Z. This loop is the missing rung below
# the supervisor: while the computer is up, a supervisor that disappears comes back within
# one interval.
#
# WHAT IT CANNOT DO: it cannot run while the computer is off. Nothing on the computer can.
# A pause resumes this loop with everything else; a reboot needs the boot hook in
# /entrypoint.sh (installed by install-supervisor.sh, best-effort — the platform rebuilds
# that file from the image, which is how the hook went missing before 2026-11-19) or the
# site's own start path.
#
# SAFETY. This starts nothing itself. It calls install-supervisor.sh, which holds the
# installer lock, stops orphan watchers, and starts exactly one supervisor — so a repair can
# never produce a second writer on orders.jsonl (the 2026-11-03 chain break). One watchdog
# per machine, by flock held for the life of the loop; a second one exits 0 immediately.
#
# Usage:  watchdog.sh            loop forever, one repair attempt every MERIDIAN_WATCHDOG_INTERVAL
#                               seconds (default 30)
#         watchdog.sh --once     one repair attempt, then exit (a manual check; used by tests)
#
# Env:    MERIDIAN_EXECUTION_DIR  execution directory (default /home/team/shared/execution)
#         MERIDIAN_INSTALLER      installer to call (default <exec dir>/install-supervisor.sh)
#         MERIDIAN_WATCHDOG_INTERVAL  seconds between attempts (default 30)
set -u

EXEC_DIR="${MERIDIAN_EXECUTION_DIR:-/home/team/shared/execution}"
INSTALLER="${MERIDIAN_INSTALLER:-$EXEC_DIR/install-supervisor.sh}"
INTERVAL="${MERIDIAN_WATCHDOG_INTERVAL:-30}"
RUN_DIR="$EXEC_DIR/.run"
LOG="$RUN_DIR/watchdog.log"
LOCK="$RUN_DIR/watchdog.lock"
mkdir -p "$RUN_DIR" 2>/dev/null || true

say() { echo "[watchdog] $(date -u +%FT%TZ) $*" >> "$LOG" 2>/dev/null; }

# One watchdog per machine. The lock is held for as long as this process lives, so a second
# start (the platform restarts the site, two installers fire together) exits 0 and does
# nothing. fd 8 is closed for everything this script spawns, or a child would inherit the
# lock and keep the machine believing a watchdog is running after this one died.
if command -v flock >/dev/null 2>&1; then
  exec 8>"$LOCK" || { echo "[watchdog] cannot open $LOCK" >&2; exit 1; }
  if ! flock -n 8; then
    echo "[watchdog] another watchdog already holds $LOCK; nothing to do" >&2
    exit 0
  fi
fi

# One repair attempt. install-supervisor.sh decides everything: it stops an orphan watcher,
# starts a supervisor only if none is running, and is safe to call at any moment.
tick() {
  if [ ! -x "$INSTALLER" ]; then
    say "installer $INSTALLER is missing or not executable; cannot repair"
    return 1
  fi
  # --boot keeps it quiet when there is nothing to do; --no-entrypoint because /entrypoint.sh
  # is image-level and this path must not depend on being able to rewrite it.
  "$INSTALLER" --boot --no-entrypoint 8>&- >> "$LOG" 2>&1
}

if [ "${1:-}" = "--once" ]; then
  tick
  exit $?
fi

say "watchdog started (interval ${INTERVAL}s, installer $INSTALLER); repairing a missing supervisor"
while true; do
  tick
  # 8>&- on the sleep too: a child that inherits the lock fd keeps the lock held after this
  # process is killed, so the next watchdog would refuse to run for as long as the orphan
  # lived. Caught by tests/watchdog.test.ts.
  sleep "$INTERVAL" 8>&-
done
