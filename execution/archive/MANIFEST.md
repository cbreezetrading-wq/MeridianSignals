# Ledger segment manifest

Written 2026-11-05T19:32:22.219Z. This file is the human-readable record of a rotation. It is not the
authority — the archive is, byte for byte, and the checkpoint is, as seq 1 of the live
chain. Nothing here is re-derived later: it is what was measured at rotation time.

## Segment 1 (closed) — archived, immutable

- **Archive path:** `/home/team/shared/execution/archive/orders.segment-1-2026-11-05.jsonl`
- **SHA-256:** `fa1f4f349ab30804c59266920e2698732b9513104af2bd9667c77cfb634b7464`
- **Bytes:** 1458662
- **Records:** 2177
- **Seq range:** 1 … 2176
- **Last recordedAt:** 2026-11-05T19:26:14.547Z
- **Duplicate sequence numbers:** seq 1417 (lines 1417 and 1418)
- **Chain verifies:** NO — first break at line 1418, seq 1417: seq 1417 is not the expected 1418

This file is never edited, never re-hashed and never "cleaned". Any later statement about
segment 1 is checked against that SHA-256, not against a copy of it.

## Why it was rotated

Ledger rotation 2026-11-05: the hash chain is broken at the duplicate seq 1417 (the 2026-11-03 duplicate-writer incident), and submitSignal refuses every submission while the chain is invalid, so nothing has been submittable for two days. Segment 1 is archived byte-for-byte and segment 2 opens with a recovery checkpoint as its first record.

**Authority:** Owner instruction dated 2026-11-05: rotate the Practice ledger rather than grant an allowance for a known-broken chain. The owner chose rotation over tolerance.

## The break at seq 1417

The archived segment contains TWO records numbered seq 1417. That duplicate is the 2026-11-03 duplicate-writer incident: two watcher processes each read the same last hash and both appended seq 1417, one branch was orphaned, and every later record's seq is one below its line number, so the chain reads broken at line 1418. `execution/INCIDENT-2026-11-03-chain-break.md` is the incident account. The break is NOT fixed and is NOT claimed to be fixed here. No record was rewritten, removed or renumbered. The archived file is the history exactly as it happened.

The break is **not fixed and is not claimed to be fixed**. It happened, it is explained in
`execution/INCIDENT-2026-11-03-chain-break.md`, and it stays in the record exactly as it
happened. Rotation does not repair history; it starts a new segment whose chain verifies
from genesis.

## Segment 2 (open) — first record

- **Checkpoint record seq:** 1
- **Kind:** LEDGER_ROTATION (state SEGMENT_OPEN)
- **Hash:** `331a7e017c7eab1932af92439b1f501b6e92d6845171fb975117adfff8bd2e3f`
- **Chains from:** GENESIS (000000000000…)
- **Replaced the live path at:** 2026-11-05T19:31:34.530Z
- **New segment verifies:** yes (1 record(s) at verification)

## Carried forward (what a rotation would otherwise destroy)

- **Order keys:** 12 — `msig-5b0a40fdae043bcf44f90e60`, `msig-28326d5f137959030876a721`, `msig-fixture-1793393404282`, `msig-410e5c823c70b0bb4882e016`, `msig-062fc0daa40d387a1829e6cc`, `msig-fixture-1793393486573`, `msig-b9bd8f7df1daa0407cddad92`, `msig-936eba0ea136854bcaae1a84`, `msig-860248514fc4262b502527f4`, `msig-fd2f2b6ded11753370d24389`, `msig-fixture-1793393581004`, `msig-03f092003acff9de406d2570`
- **Known trade ids:** 5, 15, 33
- **Realised P/L by UTC date:** 2026-10-30: -110.92620000000001
- **Day state carried:** {"date":"2026-11-05","openingNav":100585.2378,"openingNavFrom":"earliest ACCOUNT_READ of 2026-11-05 in the segment (seq 2097)","realisedAtCutover":0}

## Reconciliation at rotation

The broker is the authority on what exists; the record is the authority on what was intended. Differences are reported, never reconciled by editing either side.

- Recorded submission intents: 8 submitted of 12 keys
- Matched at the broker: 5 (trade 5 CLOSED, trade 15 CLOSED, trade 25 CLOSED, trade 33 CLOSED, trade 43 CLOSED)
- At the broker with no recorded intent: 0 (none)
- Recorded with no broker counterpart: 3 (msig-fixture-1793393404282: submitted per the record, but the record names no trade id; msig-fixture-1793393486573: submitted per the record, but the record names no trade id; msig-fixture-1793393581004: submitted per the record, but the record names no trade id)
- Unresolved: No open trade and no pending order at the broker: nothing is outstanding, so nothing has to be carried forward as unresolved.

## Corrections to this manifest

The first version of this manifest, written at 19:31:34Z, named the LIVE record path (execution/orders.jsonl) where it should have named the archive path. That was a defect in the manifest generator (commitRotation returned the source file's stats instead of the archive's), found immediately after the rotation. It was not a defect in the rotation: the archive was copied and hash-verified before the live path was replaced, and the sha256, byte count, record count, seq range and duplicate it states are unchanged in this version. The generator is fixed, and the archive's current hash is compared with the hash the checkpoint recorded above.

Re-minted 2026-11-05T19:32:22.219Z from the checkpoint record (seq 1) and the archive on disk.
Archive hash now matches the hash the checkpoint recorded: **yes**.
