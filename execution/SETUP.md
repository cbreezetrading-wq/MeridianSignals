# OANDA Practice connection — deployment and operation

This branch adds an authenticated execution console at `/execution`, an HTTPS API
at `/api/execution`, and a terminal operator/watcher. It has not been deployed to
CTO.new and has not been tested against the owner's broker account in this session.
All automated tests use an injected, simulated broker transport. No real token is needed.

## Required server configuration

Supply these through the host's secret/environment settings, never through Git:

- `OANDA`: an OANDA Practice API token.
- `OANDA_ACCOUNT_ID`: the explicitly selected Practice account.
- `MERIDIAN_OPERATOR_KEY`: a separate random secret of at least 32 characters.
  Enter this in the console; never enter the OANDA token in the web page.
- `MERIDIAN_EXECUTION_DIR`: absolute path to a persistent, private directory for
  `orders.jsonl`, `pause.json`, `day-state.json`, pending instructions and status.
- `MERIDIAN_CONFIG_PATH`: absolute path to the execution configuration file.
- `MERIDIAN_SIGNALS_URL`: the deployed site's HTTPS `/api/signals` URL, for watch mode.

The console locks when the operator key or account ID is absent. Configure the
same state directory and config path for the website and watcher. Source-relative
path defaults are intended for direct terminal operation; bundled website builds
must use explicit absolute paths.

The host must support a Node/Bun backend, writable persistent storage and a separate
long-running worker. Do not use ephemeral serverless files for execution state.
All processes for this account must share one filesystem. Multiple hosts with
independent state directories are unsupported. Do not publish runtime snapshots as
static assets. Keep the site behind HTTPS.

## Configuration and activation

The checked-in `execution/config.json` remains `signals-only`, strategies disabled,
and `useTestProfile:false`. No new order is enabled by deploying this branch.

For connection verification in Practice, create a separate private config from
`execution/config.test.json`. It enables the failed H1 rule only as a labelled
Practice connection test; it is not a strategy recommendation. Set
`MERIDIAN_CONFIG_PATH` to that file. Review all TEST risk settings before running it.
The owner's strategy has not been supplied or implemented.

Run the server with its normal Bun build/start workflow. The generated build's
backend must have access to the private configuration and persistent state paths.

Direct operation from the repository root, using Node 24+ (or Bun):

```sh
node execution/operator.ts help
node execution/operator.ts status
node execution/operator.ts reconcile
node execution/operator.ts watch
```

The watcher refreshes every 10 seconds while running; it does not run merely because
the page is open. Use the hosting provider's process supervisor to keep it alive.
It reloads configuration each cycle. Only explicitly acknowledged `automatic` mode
submits from the watcher. In approval mode, use the execution console to preview a
fresh signal and approve its exact order payload. Changed order size or protection
requires a new preview. In signals-only mode nothing submits.

Terminal preview/approval also works for a complete instruction JSON:

```sh
node execution/operator.ts preview /absolute/path/instruction.json
node execution/operator.ts submit /absolute/path/instruction.json REVIEWED_PAYLOAD_HASH
node execution/operator.ts pause
node execution/operator.ts resume
node execution/operator.ts cancel-entries
node execution/operator.ts close-managed
```

The last two commands modify Practice broker state; they are separate controls.
Pause only blocks new entries and preserves broker protective orders.

## Signal mapping and limitations

The adapter accepts broker-primary Practice H1 v1 entry events only, on the newest
completed bar, within the configured expiry measured from the bar's close. IDs
remain stable across refreshes. Fallback data, old open-position states and future
bars cannot become new entries. MARKET/FOK entries have stop and target attached.
The order carries an adverse price bound, and sizing uses that bound rather than mid.

This connector implements entries with broker stop/target exits. It does **not**
automate the ruleset's indicator cross/filter exits or reverse positions. Therefore
its Practice results are not the original backtested strategy's results. Full
strategy parity, owner's rule implementation, broker-transaction-based daily P/L
(including broker stop/target closures and financing), and currency-consistent
portfolio exposure accounting remain prerequisites before any live build. Existing
daily P/L logic relies on locally recorded closes and is not a complete broker P/L
ledger. Existing historical claims are not independently verified by these tests.

The live endpoint remains structurally unavailable to the order client. The existing
bootstrap also probes the live account-list endpoint read-only and requires an
explicit credential refusal; a network failure no longer counts as a refusal.

## Recovery

Order intent is appended before POST. An uncertain response is not retried as a new
order. The submitted signal stays blocked by its recorded intent, even if the broker
lookup subsequently sees no order. Inspect/reconcile rather than inventing a new ID.

An exclusive `submission.lock` directory serializes submissions on the shared
filesystem. If a process crashes, the lock is intentionally not expired. Stop all
writers, inspect broker orders/trades and reconcile before an operator removes the
stale lock. Never delete the execution ledger to clear a blocked signal.

The ledger is hash checked before submitting. Malformed JSON, inaccessible pause
state, failed order/trade reads and stale quotes fail closed. The lock serializes
submissions; other administrative record writers should be run with the watcher
stopped. A transactional database would be needed for distributed writers.

## Verification

```sh
node --test execution/tests/execution.test.ts
cd site
bun install --frozen-lockfile
bun run build
```

Do not run the legacy numbered scripts as a generic test suite: several submit or
close Practice orders and retain original-machine paths. Use the new operator.
