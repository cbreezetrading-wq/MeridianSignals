#!/usr/bin/env bash
# The dev server, and the persistent start path for the Meridian Practice worker.
#
# Why here: after a machine restart the platform's managed dev-server wrapper runs
# `bun run dev` from this directory (and re-runs it whenever the dev server exits). The
# hook in /entrypoint.sh does NOT survive a restart — it is image-level and gets reverted —
# so package.json's `dev` script is the only start that actually happens after a reboot.
# Starting the supervised worker from it is what brings the worker back by itself.
#
# Idempotent by construction: install-supervisor.sh holds a lock, checks its pidfile, then
# scans for a running run-watcher.sh, so repeated starts (the wrapper restarts `bun run dev`
# in a loop) never produce a second supervisor or a second watcher.
#
# Secrets: nothing here reads, prints or exports a credential. run-watcher.sh sources
# /etc/profile.d/cto-env-vars.sh inside the detached supervisor, so the OANDA credential
# reaches the watcher without ever entering this process's environment or any log line.
set -u

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR=/home/team/shared/execution/install-supervisor.sh

if [ -x "$SUPERVISOR" ]; then
  # --no-entrypoint: the boot hook in /entrypoint.sh is image-level and does not survive a
  # restart, so this path must not depend on being able to rewrite it.
  echo "[dev-server] $(date -u +%FT%TZ) checking the worker supervisor (idempotent; starts nothing if one is running)"
  "$SUPERVISOR" --boot --no-entrypoint ||
    echo "[dev-server] $(date -u +%FT%TZ) worker supervisor not started; serving the site anyway" >&2
fi

cd "$SITE_DIR" || exit 1
VITE="$SITE_DIR/node_modules/.bin/vite"
if [ -x "$VITE" ]; then
  exec "$VITE" dev "$@"
fi
exec bun x vite dev "$@"
