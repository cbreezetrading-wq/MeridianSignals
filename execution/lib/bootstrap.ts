/**
 * Bootstrap: resolve the account id the token actually sees, then hand back a client.
 *
 * The account id is never guessed. If OANDA_ACCOUNT_ID is set it is used as-is; if
 * not, GET /v3/accounts is asked and the id is adopted only when the token sees
 * exactly one account. Two accounts means we do not know which one the owner meant,
 * so we refuse rather than pick.
 */

import { createClient, type Client, type Transport } from "./client.ts";
import { attest, type Attestation } from "./engine.ts";

export async function bootstrapClient(options: { transport?: Transport } = {}): Promise<{ client: Client; accountId: string; attestation: Attestation }> {
  const client = createClient({ transport: options.transport });
  let id = process.env.OANDA_ACCOUNT_ID?.trim() ?? "";
  if (id === "") {
    const res = await client.accounts();
    if ("transportFailure" in res) throw new Error(`could not reach OANDA to resolve the account: ${res.error}`);
    if (!res.ok) throw new Error(`could not resolve the account: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    const accounts = (res.body?.accounts ?? []) as Array<{ id: string }>;
    if (accounts.length !== 1) {
      throw new Error(`the token sees ${accounts.length} accounts; refusing to guess which one to trade. Set OANDA_ACCOUNT_ID.`);
    }
    id = accounts[0]!.id;
    process.env.OANDA_ACCOUNT_ID = id;
  }
  const attestation = await attest(client);
  if (!attestation.ok) {
    throw new Error(
      `INTERLOCK FAILED CLOSED: practice probe ok=${String(attestation.practiceProbe.ok)}, live probe refused=${String(attestation.liveProbe.refused)}. ` +
        `Nothing may be submitted. Live response: ${attestation.liveProbe.status} ${attestation.liveProbe.errorMessage ?? ""}`,
    );
  }
  return { client, accountId: id, attestation };
}
