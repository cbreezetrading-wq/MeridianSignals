#!/bin/bash
# Supervised Meridian Practice watcher.
# Restarts the watcher if it exits (e.g. a transient signals-source failure),
# with a backoff, and logs everything to .run/watcher.log.
# Submissions are gated inside engine.ts on config.mode; nothing here decides a trade.
#
# THE CHILD IS OURS TO KILL (fix 2026-11-03). The watcher used to be run in the
# foreground, so killing this script left `bun operator.ts watch` alive and unsupervised:
# a second writer appended to orders.jsonl alongside the new one and forked the hash chain
# (INCIDENT-2026-11-03-chain-break.md). Now the watcher runs in the background, this script
# traps TERM/INT/HUP/EXIT, and it stops the child — TERM, then SIGKILL if the child ignores
# it — before it goes away. Never leave a child running: an unsupervised watcher is a second
# writer, and the ledger's flock is the only thing standing between it and a forked chain.
set -u

# The boot hook runs from PID 1, which never sources /etc/profile.d — so the
# OANDA credential and the operator key are absent from the environment the
# watcher inherits. Proven by the 2026-11-03 01:32Z machine restart: without
# this, the watcher exits rc=1 ("process.env.OANDA is empty") and the supervisor
# restarts it in a loop forever. Source the platform secret file explicitly.
if [ -r /etc/profile.d/cto-env-vars.sh ]; then
  . /etc/profile.d/cto-env-vars.sh
fi

EXEC_DIR=/home/team/shared/execution
export MERIDIAN_EXECUTION_DIR="$EXEC_DIR"
export MERIDIAN_CONFIG_PATH="$EXEC_DIR/config.json"
export MERIDIAN_SIGNALS_URL="${MERIDIAN_SIGNALS_URL:-https://f18acd832760c783c8b1cf1b27811368-dev.cto.site/api/signals}"
mkdir -p "$EXEC_DIR/.run"
LOG="$EXEC_DIR/.run/watcher.log"
cd "$EXEC_DIR" || exit 1

CHILD=""

# Stop the watcher child and wait for it to actually be gone. The watcher can ignore
# TERM, so escalate to SIGKILL after a 5s grace period rather than assuming it died.
stop_child() {
  local reason="$1"
  if [ -n "${CHILD:-}" ] && kill -0 "$CHILD" 2>/dev/null; then
    echo "[supervisor] $(date -u +%FT%TZ) $reason: stopping watcher pid $CHILD" >> "$LOG"
    kill -TERM "$CHILD" 2>/dev/null
    local i
    for i in $(seq 1 50); do
      kill -0 "$CHILD" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHILD" 2>/dev/null; then
      echo "[supervisor] $(date -u +%FT%TZ) watcher pid $CHILD ignored TERM for 5s; sending SIGKILL" >> "$LOG"
      kill -KILL "$CHILD" 2>/dev/null
      sleep 0.2
    fi
    if kill -0 "$CHILD" 2>/dev/null; then
      echo "[supervisor] $(date -u +%FT%TZ) FAILED to stop watcher pid $CHILD; it is still running" >> "$LOG"
    else
      echo "[supervisor] $(date -u +%FT%TZ) watcher pid $CHILD stopped" >> "$LOG"
    fi
    wait "$CHILD" 2>/dev/null
  fi
  CHILD=""
}

on_signal() {
  echo "[supervisor] $(date -u +%FT%TZ) received SIG$1; shutting down and taking the watcher with me" >> "$LOG"
  stop_child "shutdown"
  exit 0
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP
trap 'stop_child "exit"' EXIT

echo "[supervisor] $(date -u +%FT%TZ) starting; signals=$MERIDIAN_SIGNALS_URL config=$MERIDIAN_CONFIG_PATH dir=$MERIDIAN_EXECUTION_DIR" >> "$LOG"
while true; do
  bun operator.ts watch >> "$LOG" 2>&1 &
  CHILD=$!
  # `wait` is interrupted by a trapped signal, so a TERM during the watch is handled
  # immediately instead of after the child exits.
  wait "$CHILD"
  rc=$?
  CHILD=""
  echo "[supervisor] $(date -u +%FT%TZ) watcher exited rc=$rc; restarting in 15s" >> "$LOG"
  sleep 15 &
  wait $!
done
