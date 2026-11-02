import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "meridian-test-"));
process.env.MERIDIAN_EXECUTION_DIR = dir;
process.env.OANDA = "FAKE-TEST-TOKEN-NEVER-REAL";
process.env.OANDA_ACCOUNT_ID = "test-account";
const { createClient } = await import("../lib/client.ts");
const { parseConfig, resolveSettings } = await import("../lib/config.ts");
const { evaluate, submitSignal, payloadHash, readPause } = await import("../lib/engine.ts");
const { readRecords, verifyChain } = await import("../lib/record.ts");
const { withSubmissionLock } = await import("../lib/submissionLock.ts");
const { assertPracticeTarget } = await import("../lib/interlock.ts");
const { instructionsFromSignals } = await import("../lib/signalAdapter.ts");
const { validateInstruction } = await import("../lib/instruction.ts");
after(() => rm(dir, { recursive: true, force: true }));

const config = parseConfig({ mode: "approve-before-execution", useTestProfile: true,
  ownerSettings: { allowedTradingTimes: { days: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], fromUtc: "00:00", toUtc: "23:59" } },
  strategies: [{ id: "meridian-h1-v1", enabled: true }] });
const instruction = () => ({ signalId: `test-${Date.now()}`, strategyId: "meridian-h1-v1", strategyVersion: "h1-v1", instrument: "EUR_USD", direction: "long" as const,
  generatedAt: new Date().toISOString(), sourceBar: { time: new Date().toISOString(), close: 1.1, granularity: "H1" }, expiryAt: new Date(Date.now()+60000).toISOString(), orderType: "MARKET" as const,
  entryConditions: "test", stopPrice: 1.09, takeProfitPrice: 1.12, exitRules: "test", existingPositionRule: "refuse", oppositeSignalRule: "refuse", repeatEntryRule: "refuse", origin: "INVENTED_RULESET_TEST" as const });
let writes = 0;
let failOrders = false;
let failTrades = false;
const client = createClient({ transport: async (url, init) => {
  assert.equal(new URL(url).host, "api-fxpractice.oanda.com");
  const path = new URL(url).pathname;
  if (init.method === "POST") {
    writes++;
    assert.ok((await readRecords()).some((r) => r.kind === "ORDER_REQUESTED"), "intent must precede broker write");
    throw new Error("simulated socket loss after possible acceptance");
  }
  let body: unknown = {};
  if (path.endsWith("/summary")) body = { account: { id:"test", currency:"USD", balance:"10000", NAV:"10000", marginAvailable:"10000", marginUsed:"0" } };
  if (path.endsWith("/instruments")) body = { instruments: [{ name:"EUR_USD", displayPrecision:5, tradeUnitsPrecision:0, minimumTradeSize:"1", maximumOrderUnits:"1000000", marginRate:"0.02" }] };
  if (path.endsWith("/pricing")) body = { prices: [{ instrument:"EUR_USD", bids:[{price:"1.0999"}], asks:[{price:"1.1001"}], tradeable:true, time:new Date().toISOString() }] };
  if (path.endsWith("/orders")) { if (failOrders) return Response.json({error:"offline"}, {status:503}); body = {orders:[]}; }
  if (path.endsWith("/openTrades")) { if (failTrades) return Response.json({}, {status:503}); body = {trades:[]}; }
  return Response.json(body);
} });

test("live host and credential-bearing URLs are refused", () => {
  assert.throws(() => assertPracticeTarget("https://api-fxtrade.oanda.com/v3/accounts"));
  assert.throws(() => assertPracticeTarget("https://user@api-fxpractice.oanda.com/v3/accounts"));
});
test("invalid numeric risk settings fail closed", () => {
  const bad = parseConfig({mode:"automatic", automaticAcknowledged:true, acknowledgedBy:"test", useTestProfile:true, ownerSettings:{riskPerTradePct:"NaN"}});
  assert.equal(resolveSettings(bad).allSet, false);
});
test("approval, pre-send record and uncertain retry suppression", async () => {
  const i = instruction();
  const preview = await evaluate(client, i, config, resolveSettings(config));
  assert.equal(preview.ok, true, preview.reasons.join("; "));
  assert.equal(preview.orderPayload.order.priceBound, "1.10010", "broker price bound must match the far-side sizing basis");
  assert.equal((await submitSignal(client,i,config)).ok, false);
  assert.equal(writes, 0);
  const result = await submitSignal(client,i,config,{approvedPayloadHash:payloadHash(preview.orderPayload)});
  assert.equal(result.state,"UNAVAILABLE");
  assert.equal(writes,1);
  assert.equal((await submitSignal(client,i,config,{approvedPayloadHash:payloadHash(preview.orderPayload)})).state,"DUPLICATE_SUPPRESSED");
  assert.equal(writes,1);
  assert.equal((await verifyChain()).ok,true);
});
test("unavailable duplicate lookup blocks submission", async () => {
  failOrders=true;
  await assert.rejects(submitSignal(client,instruction(),config), /Cannot verify broker orders/);
  failOrders=false;
  assert.equal(writes,1);
});
test("unavailable open trade state blocks preflight", async () => {
  failTrades=true;
  assert.equal((await evaluate(client,instruction(),config,resolveSettings(config))).state,"UNAVAILABLE");
  failTrades=false;
});
test("cross-process submission lock refuses overlap", async () => {
  await withSubmissionLock(async () => {
    await assert.rejects(withSubmissionLock(async () => null), /Another submission/);
  });
});
test("unreadable pause state pauses entries", async () => {
  await writeFile(join(dir,"pause.json"), "broken");
  assert.equal((await readPause()).paused,true);
});
test("future instructions are rejected", () => {
  const i=instruction(); i.generatedAt=new Date(Date.now()+60000).toISOString();
  assert.equal(validateInstruction(i).ok,false);
});
test("adapter does not execute stale or fallback dashboard positions", () => {
  const bar=new Date(Math.floor(Date.now()/3600000)*3600000-3600000).toISOString();
  const close=Date.parse(bar)+3600000;
  const p:any={data:{primary:{accountType:"practice"}},ruleset:{version:"v1"},pairs:[{status:"ok",sourceKind:"primary",pricing:{accountType:"practice"},granularity:"hourly bar",ruleFired:{name:"opened-long",barUtc:bar,barClose:1.1},latestBarUtc:bar,signal:"LONG",instrument:"EUR_USD",stop:1.09,target:1.12,entry:1.1}]};
  assert.equal(instructionsFromSignals(p,300,close+1000).length,1);
  assert.equal(instructionsFromSignals(p,300,close+301000).length,0);
  p.pairs[0].sourceKind="fallback";
  assert.equal(instructionsFromSignals(p,300,close+1000).length,0);
});
