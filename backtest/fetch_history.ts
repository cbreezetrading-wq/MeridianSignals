/**
 * Fetch H1 candle history for the four majors from the owner's OANDA v20 account
 * and cache it to disk so the backtest is reproducible and cheap to re-run.
 *
 * READ-ONLY by construction: the only path this file ever requests is
 *   GET /v3/instruments/{instrument}/candles
 * There is no code here that can place, modify or read an order, trade, position
 * or transaction. The token is read from process.env.OANDA and sent as a header;
 * it is never printed, logged or written to a file.
 *
 * Paging: OANDA caps one request at 5000 candles. We start with the newest 5000
 * (no `to`), then repeatedly pass `to=<first bar time of the previous page>`,
 * walking backwards until a page comes back empty or short. When both `from` and
 * `to` are supplied OANDA ignores `count`, so `to` + `count` is the paging form used.
 *
 * Cache layout (all under /home/team/shared/backtest/data/):
 *   <PAIR>.jsonl      one JSON array per line, oldest first:
 *                     [t, mid_o, mid_h, mid_l, mid_c, ask_o, ask_h, ask_l, ask_c,
 *                      bid_o, bid_h, bid_l, bid_c, complete?1:0]
 *                     t is the bar's OPEN time in Unix seconds, UTC.
 *   <PAIR>.meta.json  span, bar counts, request audit, earliest served per pair.
 *   fetch-log.jsonl   one line per HTTP page actually requested.
 */

const BASE = (process.env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com").replace(/\/+$/, "");
const TOKEN = process.env.OANDA ?? "";
const OUT_DIR = "/home/team/shared/backtest/data";

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"];

/** Hard stop so a bug can never loop forever against the broker. */
const MAX_PAGES_PER_PAIR = 40;
const PAGE = 5000;

type Raw = { t: number; fields: unknown[]; complete: boolean };

function num(v: unknown): number | null {
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

async function page(
  instrument: string,
  to: string | null,
): Promise<{ ok: boolean; status: number; candles: unknown[]; error?: string }> {
  const q = new URLSearchParams({ granularity: "H1", price: "MBA", count: String(PAGE) });
  if (to !== null) q.set("to", to);
  const url = `${BASE}/v3/instruments/${instrument}/candles?${q.toString()}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await Bun.sleep(1500 * attempt);
          continue;
        }
        return { ok: false, status: res.status, candles: [], error: text.slice(0, 400) };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, candles: [], error: "non-JSON response" };
      }
      const candles = (body as { candles?: unknown[] }).candles;
      if (!Array.isArray(candles)) {
        return { ok: false, status: res.status, candles: [], error: "no candles[] in response" };
      }
      return { ok: true, status: res.status, candles };
    } catch (e) {
      if (attempt === 4) return { ok: false, status: 0, candles: [], error: String(e).slice(0, 400) };
      await Bun.sleep(1500 * attempt);
    }
  }
  return { ok: false, status: 0, candles: [], error: "exhausted retries" };
}

function iso(t: number): string {
  return new Date(t * 1000).toISOString();
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("No OANDA token in process.env.OANDA — cannot fetch.");
    process.exit(2);
  }
  await Bun.write(`${OUT_DIR}/.keep`, "");
  const logLines: string[] = [];
  const metas: Record<string, unknown> = {};

  for (const instrument of PAIRS) {
    const byT = new Map<number, Raw>();
    let to: string | null = null;
    let pages = 0;
    let shortest = Number.POSITIVE_INFINITY;
    let incompleteSeen = 0;
    const requested: { to: string | null; returned: number; firstT: number | null; lastT: number | null }[] = [];
    let failure: string | null = null;

    while (pages < MAX_PAGES_PER_PAIR) {
      const r = await page(instrument, to);
      pages += 1;
      if (!r.ok) {
        failure = `HTTP ${r.status}: ${r.error ?? ""}`;
        break;
      }
      if (r.candles.length === 0) {
        requested.push({ to, returned: 0, firstT: null, lastT: null });
        logLines.push(JSON.stringify({ pair: instrument, to, returned: 0, at: new Date().toISOString() }));
        break;
      }

      let firstT = Number.POSITIVE_INFINITY;
      let lastT = 0;
      for (const c of r.candles) {
        const o = c as { time?: unknown; complete?: unknown; mid?: Record<string, unknown>; ask?: Record<string, unknown>; bid?: Record<string, unknown> };
        // OANDA returns RFC3339 strings ("2026-10-09T14:00:00.000000000Z"), not epochs.
        const t =
          typeof o.time === "string" ? Date.parse(o.time) : num(o.time);
        if (t === null || !Number.isFinite(t)) continue;
        const ts = Math.floor(t / 1000);
        const complete = o.complete === true;
        if (!complete) incompleteSeen += 1;
        const seq = [
          ts,
          num(o.mid?.o), num(o.mid?.h), num(o.mid?.l), num(o.mid?.c),
          num(o.ask?.o), num(o.ask?.h), num(o.ask?.l), num(o.ask?.c),
          num(o.bid?.o), num(o.bid?.h), num(o.bid?.l), num(o.bid?.c),
        ];
        if (seq.slice(1).some((v) => v === null)) continue;
        byT.set(ts, { t: ts, fields: seq, complete });
        if (ts < firstT) firstT = ts;
        if (ts > lastT) lastT = ts;
      }

      requested.push({ to, returned: r.candles.length, firstT: Number.isFinite(firstT) ? firstT : null, lastT });
      logLines.push(
        JSON.stringify({
          pair: instrument,
          to,
          returned: r.candles.length,
          firstT: Number.isFinite(firstT) ? iso(firstT) : null,
          at: new Date().toISOString(),
        }),
      );

      shortest = Math.min(shortest, r.candles.length);
      if (r.candles.length < PAGE) break; // reached the broker's oldest served candle
      if (!Number.isFinite(firstT)) break;
      // Next page ends strictly before the oldest bar we just received.
      to = new Date((firstT - 1) * 1000).toISOString();
    }

    const all = [...byT.values()].sort((a, b) => a.t - b.t);
    const complete = all.filter((b) => b.complete);
    const lines = complete.map((b) => JSON.stringify(b.fields));
    await Bun.write(`${OUT_DIR}/${instrument}.jsonl`, lines.length > 0 ? lines.join("\n") + "\n" : "");

    const meta = {
      instrument,
      requestedGranularity: "H1",
      requestedPrice: "MBA",
      pageSize: PAGE,
      pagesRequested: pages,
      pageReturns: requested,
      candlesReturnedRaw: all.length,
      incompleteCandlesRefused: all.length - complete.length,
      barsCached: complete.length,
      firstBarUtc: complete.length > 0 ? iso(complete[0]!.t) : null,
      lastBarUtc: complete.length > 0 ? iso(complete[complete.length - 1]!.t) : null,
      earliestServedByBrokerUtc: all.length > 0 ? iso(all[0]!.t) : null,
      lastPageWasShort: shortest < PAGE,
      failure,
      cachedAt: new Date().toISOString(),
      cacheFile: `${OUT_DIR}/${instrument}.jsonl`,
      lineFormat:
        "[t, mid_o, mid_h, mid_l, mid_c, ask_o, ask_h, ask_l, ask_c, bid_o, bid_h, bid_l, bid_c]; t = bar OPEN, Unix seconds UTC; complete:false bars are excluded",
    };
    metas[instrument] = meta;
    await Bun.write(`${OUT_DIR}/${instrument}.meta.json`, JSON.stringify(meta, null, 2) + "\n");
    console.log(
      `${instrument}: ${String(complete.length)} complete bars, ${String(all.length - complete.length)} incomplete refused, ` +
        `span ${String(meta.firstBarUtc)} .. ${String(meta.lastBarUtc)}, pages ${String(pages)}` +
        (failure ? `, FAILURE ${failure}` : ""),
    );
  }

  await Bun.write(`${OUT_DIR}/fetch-log.jsonl`, logLines.join("\n") + "\n");
  await Bun.write(`${OUT_DIR}/fetch-summary.json`, JSON.stringify({ fetchedAt: new Date().toISOString(), pairs: metas }, null, 2) + "\n");
  console.log("done");
}

await main();
