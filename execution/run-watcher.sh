#!/bin/bash
# Supervised Meridian Practice watcher (signals-only).
# Restarts the watcher if it exits (e.g. a transient signals-source failure),
# with a backoff, and logs everything to .run/watcher.log.
# Nothing here submits orders: submissions are gated inside engine.ts on
# config.mode === "automatic", and execution/config.json is signals-only.
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
echo "[supervisor] $(date -u +%FT%TZ) starting; signals=$MERIDIAN_SIGNALS_URL config=$MERIDIAN_CONFIG_PATH dir=$MERIDIAN_EXECUTION_DIR" >> "$LOG"
while true; do
  bun operator.ts watch >> "$LOG" 2>&1
  rc=$?
  echo "[supervisor] $(date -u +%FT%TZ) watcher exited rc=$rc; restarting in 15s" >> "$LOG"
  sleep 15
done
