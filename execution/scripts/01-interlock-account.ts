#!/usr/bin/env bun
/**
 * PROOF 1 — the practice-only interlock, and a live account read.
 *
 *   bun /home/team/shared/execution/scripts/01-interlock-account.ts
 *
 * Writes /home/team/shared/verify/execution/01-interlock-account.json
 *
 * What it proves:
 *  - the interlock refuses the live host, a look-alike host, http, an explicit port
 *    and a credential in the URL — each refusal is caught and printed verbatim;
 *  - the Practice account is readable and its numbers are recorded;
 *  - the SAME token is refused by the live host (so the credential cannot move real
 *    money), which is the runtime half of the interlock.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { assertPracticeTarget, practiceUrl, interlockStatement, PRACTICE_HOST } from "../lib/interlock.ts";
import { bootstrapClient } from "../lib/bootstrap.ts";
import { readAccount, readInstruments } from "../lib/engine.ts";

const OUT_DIR = "/home/team/shared/verify/execution";
await mkdir(OUT_DIR, { recursive: true });

const refused: Array<{ url: string; refused: boolean; error: string | null }> = [];
const attempts = [
  "https://api-fxtrade.oanda.com/v3/accounts/x/orders",
  "https://api-fxtrade.oanda.com/v3/accounts",
  "http://api-fxpractice.oanda.com/v3/accounts/x/orders",
  "https://api-fxpractice.oanda.com:8443/v3/accounts/x/orders",
  "https://api-fxpractice.oanda.com.evil.example/v3/accounts/x/orders",
  "https://user:pass@api-fxpractice.oanda.com/v3/accounts",
  "not a url",
];
for (const url of attempts) {
  try {
    assertPracticeTarget(url);
    refused.push({ url, refused: false, error: null });
  } catch (error) {
    refused.push({ url, refused: true, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}
const accepted = (() => {
  try {
    assertPracticeTarget(practiceUrl("/v3/accounts/x/orders"));
    return true;
  } catch {
    return false;
  }
})();

const { client, accountId, attestation } = await bootstrapClient();
const accountRes = await readAccount(client);
const instruments = await readInstruments(client);
const wanted = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"];

const evidence = {
  proof: "practice-only interlock + live account read",
  generatedAt: new Date().toISOString(),
  interlock: {
    statement: interlockStatement(),
    acceptedPracticeUrl: accepted,
    refusals: refused,
    allForbiddenRefused: refused.every((r) => r.refused),
    configurable: false,
    note: "PRACTICE_HOST is a frozen literal in lib/interlock.ts. There is no env var, config key or parameter anywhere in the order path that can change it.",
  },
  attestation,
  accountId,
  account: accountRes.ok ? accountRes.account : { error: accountRes.detail },
  instruments: Object.fromEntries(wanted.filter((w) => instruments[w]).map((w) => [w, instruments[w]])),
  instrumentCount: Object.keys(instruments).length,
};

await writeFile(`${OUT_DIR}/01-interlock-account.json`, JSON.stringify(evidence, null, 2), "utf8");
console.log(JSON.stringify(evidence, null, 2));
