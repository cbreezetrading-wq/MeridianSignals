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
# SINGLE INSTANCE — the start guard. On 2026-11-05 the wrapper fired this path twice at once
# and left two site servers, the second of them silently on port 3001. The old check was
# `sudo lsof -t -iTCP:3000 -sTCP:LISTEN`, which is a probe and not a lock: it can lose a
# check-then-act race, it can block on a password prompt in a non-interactive shell (and a
# failed probe reads as "port free"), and it never looks at any port but 3000.
# scripts/site-start-guard.ts replaces it with an flock held for the life of the server, a
# bind-check on the port after the lock, and --strictPort so Vite can never drift to 3001.
# A second concurrent start refuses by name and exits 0 without starting anything; a port
# held by something else, or a server that comes up on another port, is a named failure.
#
# Secrets: nothing here reads, prints or exports a credential. run-watcher.sh sources
# /etc/profile.d/cto-env-vars.sh inside the detached supervisor, so the OANDA credential
# reaches the watcher without ever entering this process's environment or any log line.
set -u

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable only so a test or a scratch demo can run this exact script without starting
# the live worker. The default is the real installer.
SUPERVISOR="${MERIDIAN_SUPERVISOR:-/home/team/shared/execution/install-supervisor.sh}"
PORT="${PORT:-3000}"

if [ -x "$SUPERVISOR" ]; then
  # --no-entrypoint: the boot hook in /entrypoint.sh is image-level and does not survive a
  # restart, so this path must not depend on being able to rewrite it.
  echo "[dev-server] $(date -u +%FT%TZ) checking the worker supervisor (idempotent; starts nothing if one is running)"
  "$SUPERVISOR" --boot --no-entrypoint ||
    echo "[dev-server] $(date -u +%FT%TZ) worker supervisor not started; serving the site anyway" >&2
fi

cd "$SITE_DIR" || exit 1
VITE="$SITE_DIR/node_modules/.bin/vite"
GUARD="$SITE_DIR/scripts/site-start-guard.ts"

# --strictPort: if 3000 is taken, Vite exits with an error instead of quietly moving to the
# next free port. That is what turned a duplicate start into an invisible second server.
if [ -x "$VITE" ]; then
  set -- "$VITE" dev --port "$PORT" --strictPort "$@"
else
  set -- bun x vite dev --port "$PORT" --strictPort "$@"
fi

# The guard takes the lock, or refuses by name. If the guard itself is missing, start
# nothing: an unguarded start is the defect this path exists to prevent.
if [ ! -f "$GUARD" ]; then
  echo "[dev-server] $(date -u +%FT%TZ) start guard $GUARD is missing; refusing to start unguarded" >&2
  exit 1
fi

exec bun run "$GUARD" --port "$PORT" --log "$SITE_DIR/.run/start-guard.log" -- "$@"
