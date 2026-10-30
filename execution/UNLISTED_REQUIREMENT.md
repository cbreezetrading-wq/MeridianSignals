# Hard requirement: the site stays unlisted, and execution surfaces never go public

**Owner instruction (2026-10-30): "Don't advertise the dashboard — keep it off any public list."**

## What is already in place (done, verified on the public host)
- `public/robots.txt` — `Disallow: /` for `*` plus named blocks for Googlebot, Bingbot,
  YandexBot, Baiduspider, AhrefsBot, SemrushBot, GPTBot, CCBot.
- `src/routes/__root.tsx` — every route sends
  `<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">`
  (and `name="googlebot"`).
- Verified 2026-10-30: `/robots.txt` → 200 on both localhost:3000 and the public host;
  all four pages carry the noindex meta on the public host.

## The distinction that matters — do not blur it in any report
**Unlisted is not private.** Nothing above is authentication. Anyone holding the URL can
still read the dashboard, the backtests and the signal record. It is out of search indexes
and referenced nowhere; it is not locked.

## Binding constraint on the execution build
The owner's own plan says: *"Account details, trading controls, and execution endpoints
must be private and authenticated."*

Therefore:
1. **No account numbers, balances, equity, margin, order ids, position sizes, risk
   settings or execution endpoints may be rendered on the public port.** The public site
   is served by `serve.ts` on 0.0.0.0:3000 and is reachable by URL.
2. Any execution surface (proposed order, approve button, stop controls, order list,
   reconciliation state) must live somewhere that is **not** the public port — a
   localhost-only listener, a CLI, or a surface behind real authentication.
3. If authentication is not built yet, the approval step must be exercised from the
   command line or a loopback-only interface, not by adding a page to the public site.
4. Do not add links to an execution surface from the public dashboard.
5. Anything that must appear on the public site is limited to non-account signal/backtest
   content that already exists, plus a flat statement that execution is not exposed here.

If a session is unsure whether a surface is safe to publish, it is not. Keep it off the
public port and say so in the report.
