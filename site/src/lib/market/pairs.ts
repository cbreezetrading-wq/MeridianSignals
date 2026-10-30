import type { PairId, PairSpec } from "./types";

/** The four majors this version watches, with each pair's conventional precision. */
export const PAIRS: PairSpec[] = [
  {
    id: "EURUSD",
    label: "EUR/USD",
    symbol: "EURUSD=X",
    instrument: "EUR_USD",
    decimals: 5,
    pipNote: "prices shown to 5 decimal places",
  },
  {
    id: "GBPUSD",
    label: "GBP/USD",
    symbol: "GBPUSD=X",
    instrument: "GBP_USD",
    decimals: 5,
    pipNote: "prices shown to 5 decimal places",
  },
  {
    id: "USDJPY",
    label: "USD/JPY",
    symbol: "USDJPY=X",
    instrument: "USD_JPY",
    decimals: 3,
    pipNote: "prices shown to 3 decimal places",
  },
  {
    id: "AUDUSD",
    label: "AUD/USD",
    symbol: "AUDUSD=X",
    instrument: "AUD_USD",
    decimals: 5,
    pipNote: "prices shown to 5 decimal places",
  },
];

export const PAIR_BY_ID: Record<PairId, PairSpec> = Object.fromEntries(
  PAIRS.map((p) => [p.id, p]),
) as Record<PairId, PairSpec>;
