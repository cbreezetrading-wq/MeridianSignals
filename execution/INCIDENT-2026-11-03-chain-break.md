# Incident 2026-11-03 — the execution record's hash chain forked at seq 1417

**Status: open in the record, fixed in the code. The record was not rewritten.**

`/home/team/shared/execution/orders.jsonl` no longer verifies as a single unbroken chain.
`verifyChain()` (`execution/lib/record.ts`) reports:

```
ok: false
firstBreak: { line: 1418, seq: 1417, reason: "seq 1417 is not the expected 1418" }
```

## What is in the file

Two writers were appending at the same moment. File lines 1417 and 1418 both carry
`seq: 1417`:

| file line | seq | recordedAt | kind | hash | prevHash |
|---|---|---|---|---|---|
| 1417 | 1417 | 2026-11-03T02:05:54.234Z | ACCOUNT_READ | `e226348ef3aa…` | `e84e8a3189a4…` |
| 1418 | 1417 | 2026-11-03T02:05:54.238Z | ACCOUNT_READ | `3e98ee20d34f…` | `e84e8a3189a4…` |

Both name the same predecessor — record 1416 (`INTERLOCK_ATTEST`, hash `e84e8a3189a4…`) —
which is the signature of a fork: each writer read 1416 as the last record, and each
computed seq 1417 from it.

Consequences, all visible in the file rather than repaired:

- The branch that survived is the one written 4 ms later: line 1419 (`seq: 1418`,
  `prevHash: 3e98ee20d34f…`) continues from it. Record `e226348ef3aa…` is **orphaned** —
  no later record references its hash.
- From file line 1419 onward every record's `seq` is **one lower than its line number**
  (line 1419 → seq 1418, line 1420 → seq 1419, …). Verification therefore fails at line
  1418 and would fail again at every subsequent line: the chain's numbering is shifted,
  not merely locally duplicated. Only one `seq` value is actually duplicated (1417); the
  rest of the damage is that offset, which is what the team saw across the 1417–1424
  region.
- The file continues to grow (1,472 records when this note was written, ~320/hour while
  the watcher runs) and the offset persists for every new record.

Reproduce with, from `/home/team/shared/execution`:

```
MERIDIAN_EXECUTION_DIR=/home/team/shared/execution bun -e \
  'import {verifyChain} from "./lib/record.ts"; console.log(await verifyChain())'
```

## Cause

1. `run-watcher.sh` ran `bun operator.ts watch` in the **foreground**. Killing
   `run-watcher.sh` killed the script and left the watcher alive and unsupervised — the
   watcher does not exit on the TERM it never receives.
2. `install-supervisor.sh` decided whether a supervisor was already running by looking for
   a live pid in `.run/supervisor.pid` and by `pgrep -f run-watcher.sh`. An orphaned
   watcher is neither, so the installer concluded nothing was running and started a
   second supervisor, which started a second watcher.
3. `appendRecord()` serialised writers only **inside one process** (a promise chain). Two
   processes each read the last record, each computed seq 1417, and each appended — and
   because each line is written with a single `O_APPEND` write, both lines landed intact
   and in order. Per-line atomicity was never the problem; read-modify-write across
   processes was.

## No order was involved

Every record in the affected window is an account read or an interlock attestation:
`ACCOUNT_READ` at lines 1417–1418 and `INTERLOCK_ATTEST` at 1416. There is no
`ORDER_REQUESTED`, `ORDER_ACKNOWLEDGED`, `FILL`, `PARTIAL_FILL`, `PROTECTED`, `CANCEL*` or
`CLOSED` record anywhere near the fork. No order was submitted, none was acknowledged,
none was filled, and no position was opened, changed or closed by this defect. The
damage is to the integrity of the record's chain, not to the account.

## Fixes (code, not history)

1. **`execution/lib/ledgerLock.ts` (new) + `execution/lib/record.ts`** — the whole
   read-compute-append now runs under an exclusive cross-process `flock` on
   `orders.jsonl.lock`, held by a short-lived helper process so the kernel releases it if
   the writer dies. A writer that cannot take the lock within 30 s **refuses** with a named
   error instead of appending unlocked. If the `flock` binary is unavailable, an `O_EXCL`
   lock file is used with the same wait budget — never an unlocked append.
2. **`execution/run-watcher.sh`** — the watcher runs in the background; the supervisor
   traps `TERM`/`INT`/`HUP`/`EXIT`, stops the child (TERM, then SIGKILL after a 5 s grace
   period, because the watcher can ignore TERM), waits for it to be gone, and only then
   exits. A supervisor can no longer leave a writer behind.
3. **`execution/install-supervisor.sh`** — before starting anything it looks for
   `bun operator.ts watch` processes whose parent is not a live `run-watcher.sh` and stops
   them (TERM, then SIGKILL), failing loudly if one survives. A supervised watcher is
   identified by its parent and is never touched.

## What is deliberately not done

The duplicate record and the seq offset are **left exactly as they are**. Deleting the
orphaned line or renumbering the tail would make the file verify while destroying the only
proof that two writers ever ran — the opposite of what an append-only, hash-chained record
is for. Whether the record is ever re-based (for example: keep the file as-is, and start a
new segment with an explicit "chain re-based here, see INCIDENT-2026-11-03" record that
carries the old last hash) is an owner decision, not a repair to be done quietly.

Until then, `verifyChain()` reporting BROKEN at line 1418 is the **correct** answer and
should be shown as such.
