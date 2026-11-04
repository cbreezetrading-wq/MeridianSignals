import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveSetupClient } from "../live/client.ts";
import { previewLiveOrder, type LivePreviewInput } from "../live/preview.ts";

const input = (): LivePreviewInput => ({ strategyId:"owner-method", direction:"long",stop:1.09,target:1.12,nav:300,marginAvailable:300,accountCurrency:"USD",instrument:"EUR_USD",bid:1.0999,ask:1.1001,quoteTime:new Date().toISOString(),tradeable:true,
meta:{tradeUnitsPrecision:0,displayPrecision:5,minimumTradeSize:"1",maximumOrderUnits:"1000000",marginRate:"0.02"},quoteLossToAccount:1,
settings:{source:"OWNER",riskPerTradePct:0.1,maxNotionalPct:100,maxSpreadPips:3} });

test("live setup refuses Practice credentials and has no mutation method", async () => {
  const prevToken=process.env.OANDA_LIVE_TOKEN,prevId=process.env.OANDA_LIVE_ACCOUNT_ID;
  try {
    delete process.env.OANDA_LIVE_TOKEN; delete process.env.OANDA_LIVE_ACCOUNT_ID;
    assert.throws(()=>createLiveSetupClient(),/Practice credentials are never reused/);
    process.env.OANDA_LIVE_TOKEN="TEST-LIVE-TOKEN-FAKE";process.env.OANDA_LIVE_ACCOUNT_ID="test-live-account";
    const seen: Array<{url:string;init:RequestInit}> = [];
    const client=createLiveSetupClient(async(url,init)=>{
      seen.push({url,init});
      return Response.json({account:{id:"test-live-account",currency:"USD",NAV:"300",balance:"300",marginAvailable:"300",openTradeCount:"0"}});
    });
    const status=await client.summary();
    assert.equal(status.nav,300);assert.equal(status.orderSubmissionAvailable,false);
    assert.equal("createOrder" in client,false);assert.equal("closeTrade" in client,false);
    assert.equal(seen[0].init.method,"GET");assert.equal(seen[0].init.redirect,"error");
    assert.equal(new URL(seen[0].url).origin,"https://api-fxtrade.oanda.com");
    assert.ok(!seen[0].url.includes("TEST-LIVE-TOKEN"));
    assert.ok(!JSON.stringify(status).includes("test-live-account"));
    const failed=createLiveSetupClient(async()=>{throw new Error("TEST-LIVE-TOKEN-FAKE");});
    await assert.rejects(failed.summary(),(err:Error)=>!err.message.includes("TEST-LIVE-TOKEN-FAKE"));
    const wrong=createLiveSetupClient(async()=>Response.json({account:{id:"different"}}));
    await assert.rejects(wrong.summary(),/does not match/);
  } finally {
    if(prevToken===undefined)delete process.env.OANDA_LIVE_TOKEN;else process.env.OANDA_LIVE_TOKEN=prevToken;
    if(prevId===undefined)delete process.env.OANDA_LIVE_ACCOUNT_ID;else process.env.OANDA_LIVE_ACCOUNT_ID=prevId;
  }
});
test("$300 preview uses executable-side sizing and does not submit",()=>{
  const p=previewLiveOrder(input());
  assert.equal(p.state,"PREVIEW_ONLY");assert.equal(p.submitted,false);assert.equal(p.riskBudget,0.3);
  assert.equal(p.units,29);assert.ok(p.estimatedStopRisk<=0.3);assert.equal(p.entryReference,1.1001);
});
test("short preview uses bid and floors units",()=>{
  const i=input();i.direction="short";i.stop=1.11;i.target=1.08;
  const p=previewLiveOrder(i);assert.equal(p.entryReference,1.0999);assert.ok(p.signedUnits<0);assert.ok(p.estimatedStopRisk<=0.3);
});
test("notional cap can bind when the stop is tight",()=>{
  const i=input();i.stop=1.1;
  const p=previewLiveOrder(i);assert.equal(p.units,272);assert.ok(p.notional<=300);
});
test("below broker minimum is skipped rather than rounding up",()=>{
  const i=input();i.meta.minimumTradeSize="1000";
  assert.throws(()=>previewLiveOrder(i),/below the broker minimum/);
});
test("failed strategy and demo settings cannot become a live preview",()=>{
  const i=input();i.strategyId="meridian-h1-v1";assert.throws(()=>previewLiveOrder(i),/failed invented/);
  i.strategyId="owner-method";(i.settings as any).source="DEMO-TEST";assert.throws(()=>previewLiveOrder(i),/owner settings/);
});
test("stale or missing quotes fail closed",()=>{
  const i=input();i.quoteTime=new Date(Date.now()-60000).toISOString();assert.throws(()=>previewLiveOrder(i),/stale/);
  i.quoteTime=new Date().toISOString();i.tradeable=false;assert.throws(()=>previewLiveOrder(i),/not tradeable/);
});
test("spread, levels, margin and precision limits are enforced",()=>{
  const i=input();i.ask=1.101;assert.throws(()=>previewLiveOrder(i),/Spread/);
  i.ask=1.1001;i.stop=1.2;assert.throws(()=>previewLiveOrder(i),/wrong side/);
  i.stop=1.09;i.marginAvailable=0.001;assert.throws(()=>previewLiveOrder(i),/below the broker minimum/);
  i.marginAvailable=300;i.stop=1.090001;assert.throws(()=>previewLiveOrder(i),/precision/);
});
test("missing loss conversion and NaN risk settings fail closed",()=>{
  const i=input();i.quoteLossToAccount=NaN;assert.throws(()=>previewLiveOrder(i),/Invalid live sizing/);
  i.quoteLossToAccount=1;i.settings.riskPerTradePct=NaN;assert.throws(()=>previewLiveOrder(i),/Invalid live sizing/);
});
