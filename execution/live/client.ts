/** Isolated live-account setup client. No order, close, cancel or mutation methods. */
const ORIGIN = "https://api-fxtrade.oanda.com";
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function createLiveSetupClient(transport: Transport = fetch) {
  const token = process.env.OANDA_LIVE_TOKEN?.trim();
  const id = process.env.OANDA_LIVE_ACCOUNT_ID?.trim();
  if (!token || !id) throw new Error("Configure OANDA_LIVE_TOKEN and OANDA_LIVE_ACCOUNT_ID privately; Practice credentials are never reused.");
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid live account ID format");
  const account = encodeURIComponent(id);
  async function get(path: string): Promise<any> {
    // All paths below are constructed by named read-only methods.
    try {
      const response = await transport(`${ORIGIN}${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Live broker request returned HTTP ${response.status}`);
      return await response.json();
    } catch {
      // Never echo exceptions, response bodies, token or account ID into logs.
      throw new Error("Live account read unavailable. Check credentials, account eligibility and connectivity in private host settings.");
    }
  }
  return Object.freeze({
    environment: "LIVE" as const,
    orderSubmissionAvailable: false as const,
    async summary() {
      const data = await get(`/v3/accounts/${account}/summary`);
      const a = data.account;
      if (!a || a.id !== id || typeof a.currency !== "string" ||
          !Number.isFinite(Number(a.NAV)) || !Number.isFinite(Number(a.balance)) ||
          !Number.isFinite(Number(a.marginAvailable)) || !Number.isInteger(Number(a.openTradeCount)) || Number(a.openTradeCount) < 0) {
        throw new Error("Live broker account response is malformed or does not match the configured account");
      }
      return { environment: "LIVE", accountSuffix: id.slice(-4), currency: a.currency,
        nav: Number(a.NAV), balance: Number(a.balance), marginAvailable: Number(a.marginAvailable),
        openTrades: Number(a.openTradeCount), readAt: new Date().toISOString(), orderSubmissionAvailable: false };
    },
    async instruments() {
      const data = await get(`/v3/accounts/${account}/instruments`);
      if (!Array.isArray(data.instruments)) throw new Error("Broker instruments unavailable");
      return data.instruments;
    },
    async pricing(instrument: string) {
      if (!/^[A-Z]{3}_[A-Z]{3}$/.test(instrument)) throw new Error("Invalid instrument");
      const data = await get(`/v3/accounts/${account}/pricing?instruments=${instrument}&includeHomeConversions=true`);
      const price = data.prices?.find((p: any) => p.instrument === instrument);
      if (!price) throw new Error("Broker price unavailable");
      return { price, homeConversions: data.homeConversions ?? [], readAt: new Date().toISOString() };
    },
  });
}
