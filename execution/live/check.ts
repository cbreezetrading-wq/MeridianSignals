/** Run manually on the trusted backend. Not started by the Practice supervisor. */
import { readFile } from "node:fs/promises";
import { createLiveSetupClient } from "./client.ts";
import { previewLiveOrder, type LivePreviewInput } from "./preview.ts";

const [command = "help", file] = process.argv.slice(2);
if (command === "help") {
  console.log("Live setup (READ ONLY):\nnode execution/live/check.ts status\nnode execution/live/check.ts preview /private/path/owner-proposal.json\nNo submit command exists. Tokens must be provided through private server environment settings.");
} else {
  try {
    if (!["status", "preview"].includes(command)) throw new Error("Unknown read-only command");
    const client = createLiveSetupClient();
    const summary = await client.summary();
    if (command === "status") {
      console.log(JSON.stringify({ ...summary, liveReady: false, blockers: [
        "Live order submission is not implemented or enabled in this setup stage",
        "The owner trading strategy and live risk settings have not been verified",
        "Broker-transaction daily loss accounting, portfolio exposure and independent live execution recovery checks are required before live execution",
      ] }, null, 2));
    } else {
      if (!file) throw new Error("Supply a private owner proposal JSON path");
      const raw = JSON.parse(await readFile(file,"utf8"));
      const { price, homeConversions } = await client.pricing(raw.instrument);
      const meta = (await client.instruments()).find((m: any) => m.name === raw.instrument);
      if (!meta) throw new Error("Instrument not available on this live account");
      const quoteCurrency = String(raw.instrument).split("_")[1];
      const conversion = quoteCurrency === summary.currency ? 1 : Number(homeConversions.find((h: any) => h.currency === quoteCurrency)?.accountLoss);
      const preview = previewLiveOrder({ strategyId: raw.strategyId, direction: raw.direction, stop: raw.stop, target: raw.target, settings: raw.settings,
        nav: summary.nav, marginAvailable: summary.marginAvailable, accountCurrency: summary.currency,
        instrument: raw.instrument, bid: Number(price.bids?.[0]?.price), ask: Number(price.asks?.[0]?.price),
        quoteTime: price.time, tradeable: price.tradeable === true, meta, quoteLossToAccount: conversion,
      } as LivePreviewInput);
      console.log(JSON.stringify({ ...preview, existingOpenTrades: summary.openTrades },null,2));
    }
  } catch {
    // No raw exception/response can leak credentials or private file contents.
    console.error("Live setup check failed. Verify private credentials, owner proposal and broker availability. Nothing was submitted.");
    process.exitCode = 1;
  }
}
