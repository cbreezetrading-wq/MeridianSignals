# Live-account setup — isolated, read-only preparation

This is the first stage of the requested live implementation. It is **not** a live
trading engine, has no submission command, and is not wired into the Practice watcher
or public console. It cannot place, cancel, amend or close orders. Funding a live
account does not activate it.

## Current capabilities

- Verify the explicitly selected account using OANDA's live account-summary endpoint.
- Read that account's instrument metadata, prices and home-currency loss conversions.
- Calculate an owner-method order preview from actual live NAV, available margin,
  broker precision and minimum sizes. Size is capped by risk, notional, margin and
  broker maximum units; it is never rounded up to meet the minimum.
- Refuse the failed `meridian-h1-v1` strategy and settings labelled DEMO TEST.
- Keep live credentials entirely separate from `OANDA` / `OANDA_ACCOUNT_ID` used by
  Practice. No default, credential fallback, shared ledger, or worker startup exists.

## Private deployment steps for CTO

Use this branch's `execution/live/` files alongside the current main deployment.
Do not switch the Practice host constant or route the Practice engine to live.

Configure only in the trusted backend's private secret manager:

- `OANDA_LIVE_TOKEN`: the owner's live OANDA API token, obtained through their own
  OANDA account. Never put it in chat, Git, logs, a URL, the frontend or the operator key field.
- `OANDA_LIVE_ACCOUNT_ID`: the owner's explicitly selected live account ID. Verify
  account access against that exact ID; do not choose the first visible account.

Never copy or alias the Practice token into the live token variable. The read-only
code restriction is an application restriction; the underlying broker API token
may have wider powers and must still be guarded as a password.

On the trusted backend (Node 24+ or Bun):

```sh
node execution/live/check.ts status
```

The output is private account data. It identifies LIVE, a masked account suffix,
actual NAV and currency, open-trade count, fresh read time, and `liveReady:false`.
Report configured/missing and success/failure without publishing credentials or
full account IDs. Do not expose this tool through the existing public Practice API.
The status command makes GET requests only and needs no deposit to activate trading;
an unfunded eligible account may show zero NAV.

## Owner-method preview

The owner must supply the method and actual live risk limits. Do not silently copy
the 0.1% / 0.5% DEMO TEST profile or assume a $300 deposit has been made.

Store a private proposal JSON outside the repository with these fields:
`strategyId` (owner-method), `instrument`, `direction` (long or short), `stop`,
`target`, and `settings` containing `source` (OWNER), `riskPerTradePct`,
`maxNotionalPct` (at most 100 in this stage), and `maxSpreadPips`.
The instrument and stop/target must come from the owner's method, not an invented
example taken as a live recommendation.

```sh
node execution/live/check.ts preview /private/path/owner-proposal.json
```

The command reads prices and metadata itself. A proposal cannot supply fake equity,
prices, conversion rates or minimum sizes to that command. The calculation is marked
PREVIEW_ONLY and `submitted:false`. Existing portfolio exposure is reported as a
limitation: this calculation does not authorize a trade or establish strategy edge.

## Remaining work before any live submission implementation is activated

1. Define the owner's strategy and verify its entry and all exit rules; the currently
   invented strategy has negative historical results and is not live eligible.
2. Obtain explicit live risk, daily loss, portfolio exposure, manual-trade, trading
   hours, spread, expiry and reconciliation policies; no DEMO TEST inheritance.
3. Implement broker-transaction-based daily P/L, including broker stop/target closes
   and financing, and currency-consistent aggregate exposure checks.
4. Provide a distinct persistent live ledger/worker and complete a documented recovery
   design. Preserve the damaged Practice ledger as incident evidence; do not reuse or
   erase it. Prove concurrent-writer exclusion and actual machine-reboot recovery.
5. Add order construction with price bound and attached protections, checked activation,
   durable pre-submit intent, duplicate/uncertain-outcome reconciliation and post-fill
   protection/risk checks. These are not provided by this read-only stage.
6. Wire authenticated live controls with unmistakable LIVE labeling and default
   disabled status. Reuse neither the public Practice relay nor its operator key by default.

Live order execution remains unavailable at the end of this stage. No live token was
supplied, no live account was read, and no broker order was submitted while developing
this branch. No live connection success or profitable strategy is claimed.

## Verification

```sh
node --test execution/tests/live-setup.test.ts
node --test execution/tests/execution.test.ts
```

The live setup tests use simulated responses and fake credentials only. They verify
live/Practice credential separation, GET-only transport, redirect refusal, account-ID
matching, secret-safe failures, minimum sizes, spread/freshness/precision checks,
margin/notional caps, and explicit owner settings. They do not prove broker access.

Official API references:
https://developer.oanda.com/rest-live-v20/account-ep/
https://developer.oanda.com/rest-live-v20/pricing-ep/
https://developer.oanda.com/rest-live-v20/primitives-df/#HomeConversions
