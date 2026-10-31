/**
 * The recorded Practice fills, as fixtures.
 *
 * Every number here is read from /home/team/shared/execution/orders.jsonl — the broker's
 * own orderFillTransaction price, the units that were submitted, and the stop the broker
 * reports as attached to the trade. Nothing is invented, and the derived values (mid,
 * cap) are marked as derived and are checkable: `midBasisReproducesRecordedUnits` in
 * tools/reproduce-risk-defect.py shows that sizing on the mid with these inputs reproduces
 * the recorded unit count exactly, which is what proves the derivation is right.
 *
 * The two named in the brief are trade 33 (EUR_USD short) and trade 43 (GBP_USD long).
 * Trades 5, 15 and 25 are included because they are the same defect measured again, and a
 * fix that only satisfies the two headline cases would not be a fix.
 */

import type { Direction, InstrumentMeta } from "../lib/instruction.ts";

export type RecordedFill = {
  label: string;
  orderKey: string;
  tradeId: string;
  instrument: string;
  direction: Direction;
  /** NAV at the account read immediately before the order was sized. */
  nav: number;
  /** riskPerTradePct from the resolved settings (TEST profile value, labelled as such). */
  riskPctSetting: number;
  bid: number;
  ask: number;
  /** Derived as (bid + ask) / 2 where it is not recorded verbatim; validated below. */
  mid: number;
  midSource: string;
  stopPrice: number;
  /** The broker's own fill price. */
  brokerFillPrice: number;
  /** The units the OLD, mid-based sizing submitted. */
  unitsAsSubmitted: number;
  /** riskAccountCurrency from the ORDER_REQUESTED proposal, or rebuilt as noted. */
  budgetAsRecorded: number;
  budgetSource: string;
  meta: InstrumentMeta;
  /** Where the fill came from, when it is not a FILL record. */
  note?: string;
};

const EUR_USD_META: InstrumentMeta = {
  name: "EUR_USD",
  displayPrecision: 5,
  tradeUnitsPrecision: 0,
  minimumTradeSize: "1",
  maximumOrderUnits: "100000000",
  marginRate: "0.05",
};

const GBP_USD_META: InstrumentMeta = {
  name: "GBP_USD",
  displayPrecision: 5,
  tradeUnitsPrecision: 0,
  minimumTradeSize: "1",
  maximumOrderUnits: "100000000",
  marginRate: "0.05",
};

export const RECORDED_FILLS: RecordedFill[] = [
  {
    label: "trade 5 — EUR_USD short",
    orderKey: "msig-5b0a40fdae043bcf44f90e60",
    tradeId: "5",
    instrument: "EUR_USD",
    direction: "short",
    nav: 100000,
    riskPctSetting: 0.25,
    bid: 1.11642,
    ask: 1.11658,
    mid: 1.1164999999999998,
    midSource: "recorded verbatim in the ORDER_REQUESTED proposal (entryPriceReference)",
    stopPrice: 1.11912,
    brokerFillPrice: 1.11642,
    unitsAsSubmitted: 95419,
    budgetAsRecorded: 250,
    budgetSource: "recorded verbatim in the ORDER_REQUESTED proposal (riskAccountCurrency)",
    meta: EUR_USD_META,
  },
  {
    label: "trade 15 — EUR_USD short",
    orderKey: "msig-410e5c823c70b0bb4882e016",
    tradeId: "15",
    instrument: "EUR_USD",
    direction: "short",
    nav: 99986.6413,
    riskPctSetting: 0.25,
    bid: 1.11636,
    ask: 1.11653,
    mid: 1.1164450000000001,
    midSource: "recorded verbatim in the ORDER_REQUESTED proposal (entryPriceReference)",
    stopPrice: 1.11912,
    brokerFillPrice: 1.11637,
    unitsAsSubmitted: 93445,
    budgetAsRecorded: 249.97,
    budgetSource: "recorded verbatim in the ORDER_REQUESTED proposal (riskAccountCurrency)",
    meta: EUR_USD_META,
  },
  {
    label: "trade 25 — GBP_USD long",
    orderKey: "msig-936eba0ea136854bcaae1a84",
    tradeId: "25",
    instrument: "GBP_USD",
    direction: "long",
    nav: 99971.6901,
    riskPctSetting: 0.25,
    bid: 1.3389700222196108,
    ask: 1.33926,
    mid: 1.3391150111098054,
    midSource: "derived: stop + (cap / recorded units); validated by reproducing the recorded 131888 units exactly",
    stopPrice: 1.33722,
    brokerFillPrice: 1.33926,
    unitsAsSubmitted: 131888,
    budgetAsRecorded: 249.9292,
    budgetSource: "derived: 0.25% of the last recorded NAV before the fill (no proposal was recorded — the order response was lost)",
    meta: GBP_USD_META,
    note: "no ORDER_REQUESTED proposal: the connection was dropped after the broker had filled it; fill price and units come from the PROTECTED trade read-back",
  },
  {
    label: "trade 33 — EUR_USD short (named in the brief)",
    orderKey: "msig-860248514fc4262b502527f4",
    tradeId: "33",
    instrument: "EUR_USD",
    direction: "short",
    nav: 99937.3992,
    riskPctSetting: 0.25,
    bid: 1.11633,
    ask: 1.11652,
    mid: 1.116425,
    midSource: "recorded verbatim in the ORDER_REQUESTED proposal (entryPriceReference)",
    stopPrice: 1.11912,
    brokerFillPrice: 1.11633,
    unitsAsSubmitted: 92706,
    budgetAsRecorded: 249.84,
    budgetSource: "recorded verbatim in the ORDER_REQUESTED proposal (riskAccountCurrency)",
    meta: EUR_USD_META,
  },
  {
    label: "trade 43 — GBP_USD long (named in the brief)",
    orderKey: "msig-03f092003acff9de406d2570",
    tradeId: "43",
    instrument: "GBP_USD",
    direction: "long",
    nav: 99920.7121,
    riskPctSetting: 0.25,
    bid: 1.3389800179541202,
    ask: 1.33926,
    mid: 1.33912000897706,
    midSource: "derived: stop + (cap / recorded units); validated by reproducing the recorded 131474 units exactly",
    stopPrice: 1.33722,
    brokerFillPrice: 1.33926,
    unitsAsSubmitted: 131474,
    budgetAsRecorded: 249.8018,
    budgetSource: "derived: 0.25% of the last recorded NAV before the fill (no proposal was recorded — the order response was lost)",
    meta: GBP_USD_META,
    note: "no ORDER_REQUESTED proposal: the connection was dropped after the broker had filled it; fill price and units come from the PROTECTED trade read-back",
  },
];

export function capFor(f: RecordedFill): number {
  return (f.nav * f.riskPctSetting) / 100;
}

/** Realised risk of the fill as it happened: units × |broker fill − attached stop|. */
export function realisedFor(f: RecordedFill, units: number): number {
  return Math.abs(units) * Math.abs(f.brokerFillPrice - f.stopPrice);
}
