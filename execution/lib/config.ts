/**
 * Execution configuration: three modes and eleven required settings.
 *
 * The governing rule from the owner's brief: NO ORDER MAY BE SUBMITTED WITH A
 * MISSING REQUIRED SETTING. So every setting has an explicit UNSET state, and
 * `resolveSettings()` returns the list of settings that are still UNSET. The order
 * path refuses, naming them, if that list is non-empty.
 *
 * We are not allowed to invent values for these. What we are allowed to do — and
 * what the brief asks for — is ship a clearly-labelled TEST profile for exercising
 * the Practice connection. Every value taken from that profile is tagged
 * source:"TEST" here, in the record, and in the UI. If `useTestProfile` is false and
 * the owner has not supplied a value, the setting stays UNSET and nothing trades.
 */

export type Mode = "signals-only" | "approve-before-execution" | "automatic";

export const MODES: readonly Mode[] = ["signals-only", "approve-before-execution", "automatic"];
export const DEFAULT_MODE: Mode = "signals-only";

export type SettingSource = "OWNER" | "TEST" | "UNSET";

export type ResolvedSetting = { key: string; value: unknown; source: SettingSource };

export const REQUIRED_SETTINGS = [
  "riskPerTradePct",
  "maxCombinedExposurePct",
  "maxPositions",
  "dailyLossThresholdPct",
  "dailyLossCalculation",
  "allowedInstruments",
  "allowedTradingTimes",
  "maxSpreadPips",
  "maxEntryDeviationPips",
  "signalExpirySeconds",
  "entryRetryPolicy",
  "manualTradePolicy",
] as const;

export type RequiredSettingKey = (typeof REQUIRED_SETTINGS)[number];

/**
 * TEST profile — Practice only, conservative, and labelled as TEST everywhere it
 * surfaces. The owner overrides any of it in config.json under "ownerSettings".
 */
export const TEST_PROFILE: Record<RequiredSettingKey, unknown> = {
  riskPerTradePct: 0.25,
  maxCombinedExposurePct: 200,
  maxPositions: 1,
  dailyLossThresholdPct: 0.75,
  dailyLossCalculation:
    "realised + unrealised P/L in account currency of Meridian-managed trades filled during the current UTC day, measured against that day's opening NAV; at or below -0.75% of opening NAV, new entries are paused until the next UTC day",
  allowedInstruments: ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"],
  allowedTradingTimes: {
    days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    fromUtc: "00:00",
    toUtc: "23:59",
    note: "TEST policy: weekday trading only, all hours. Not an owner instruction.",
  },
  maxSpreadPips: 3,
  maxEntryDeviationPips: 10,
  signalExpirySeconds: 300,
  entryRetryPolicy: {
    maxAttempts: 2,
    retryOnlyAfterBrokerStateCheck: true,
    neverRetryOnBrokerReject: true,
    backoffMs: 1500,
    note: "TEST policy: at most one retry, and only after a fresh broker read shows the order is absent.",
  },
  manualTradePolicy:
    "Manual (non-Meridian) trades and positions are never adopted, modified, protected or closed by Meridian. Reconciliation records them as MANUAL_EXTERNAL and leaves them exactly as the owner left them.",
};

export type StrategyConfig = {
  id: string;
  version: string;
  label: string;
  enabled: boolean;
  /** Why it is or is not allowed to originate orders. */
  note: string;
};

export type ExecutionConfig = {
  mode: Mode;
  modeSource: "DEFAULT" | "CONFIG";
  useTestProfile: boolean;
  automaticAcknowledged: boolean;
  acknowledgedBy: string | null;
  ownerSettings: Partial<Record<RequiredSettingKey, unknown>>;
  strategies: StrategyConfig[];
  /** Anything the config file got wrong, kept verbatim for the record. */
  problems: string[];
};

import { CONFIG_PATH } from "./paths.ts";
export { CONFIG_PATH };

/**
 * The strategies this build knows about.
 *
 * `meridian-h1-v1` is the invented ruleset that both backtests measured and found
 * not tradeable. Per the owner's directive it stays DISABLED for live execution
 * permanently, and it may only originate Practice orders for connection testing —
 * every order it originates is labelled ORIGIN=INVENTED_RULESET_TEST.
 *
 * There is no entry for the owner's own method, because the owner has not given us
 * one. That absence is deliberate: an unknown strategy cannot be enabled by accident.
 */
export function defaultStrategies(): StrategyConfig[] {
  return [
    {
      id: "meridian-h1-v1",
      version: "h1-v1",
      label: "Invented H1 ruleset (EMA 20/50 + trend filter)",
      enabled: false,
      note:
        "Measured not tradeable at hourly (PF 0.94) and daily (PF 0.82). Permanently disabled for live execution. " +
        "May originate Practice orders for connection testing only; every such order is labelled INVENTED_RULESET_TEST.",
    },
    {
      id: "owner-method",
      version: "unset",
      label: "Owner's own method",
      enabled: false,
      note: "No rule has been supplied by the owner. Nothing to test, so nothing can be enabled.",
    },
  ];
}

export function defaultConfig(): ExecutionConfig {
  return {
    mode: DEFAULT_MODE,
    modeSource: "DEFAULT",
    useTestProfile: false,
    automaticAcknowledged: false,
    acknowledgedBy: null,
    ownerSettings: {},
    strategies: defaultStrategies(),
    problems: [],
  };
}

/**
 * Parse a config file defensively. Anything unrecognised FAILS CLOSED: an unknown
 * mode string becomes signals-only with a recorded problem, never automatic.
 */
export function parseConfig(raw: unknown): ExecutionConfig {
  const base = defaultConfig();
  if (raw === null || typeof raw !== "object") {
    base.problems.push("config file is not a JSON object; falling back to signals-only with everything UNSET");
    return base;
  }
  const obj = raw as Record<string, unknown>;

  // Mode.
  const requested = obj.mode;
  if (requested === undefined) {
    base.problems.push("config has no \"mode\" key; signals-only is the default");
  } else if (typeof requested !== "string" || !MODES.includes(requested as Mode)) {
    base.problems.push(
      `config mode ${JSON.stringify(requested)} is not one of ${MODES.join(", ")}; falling back to signals-only`,
    );
  } else {
    base.mode = requested as Mode;
    base.modeSource = "CONFIG";
  }

  // Automatic needs a second, explicit acknowledgement. Never implied.
  if (obj.automaticAcknowledged === true && typeof obj.acknowledgedBy === "string" && obj.acknowledgedBy.trim() !== "") {
    base.automaticAcknowledged = true;
    base.acknowledgedBy = obj.acknowledgedBy.trim();
  }
  if (base.mode === "automatic" && !base.automaticAcknowledged) {
    base.problems.push(
      "mode \"automatic\" was requested without automaticAcknowledged:true and acknowledgedBy; automatic is not reachable by a single config value — falling back to signals-only",
    );
    base.mode = "signals-only";
  }

  if (obj.useTestProfile === true) base.useTestProfile = true;

  if (obj.ownerSettings && typeof obj.ownerSettings === "object") {
    const supplied = obj.ownerSettings as Record<string, unknown>;
    for (const key of Object.keys(supplied)) {
      if (!(REQUIRED_SETTINGS as readonly string[]).includes(key)) {
        base.problems.push(`ownerSettings.${key} is not a known setting; ignored`);
        continue;
      }
      base.ownerSettings[key as RequiredSettingKey] = supplied[key];
    }
  }

  if (Array.isArray(obj.strategies)) {
    const known = new Map(defaultStrategies().map((s) => [s.id, s]));
    for (const entry of obj.strategies) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : null;
      if (id === null || !known.has(id)) {
        base.problems.push(`config names unknown strategy ${JSON.stringify(e.id)}; ignored`);
        continue;
      }
      const strat = known.get(id)!;
      if (e.enabled === true) strat.enabled = true;
    }
    base.strategies = [...known.values()];
  }

  return base;
}

export type ResolvedSettings = {
  values: Record<string, ResolvedSetting>;
  missing: RequiredSettingKey[];
  allSet: boolean;
  mode: Mode;
  modeSource: "DEFAULT" | "CONFIG";
  testProfileInUse: boolean;
  problems: string[];
};

/**
 * Merge owner values over the TEST profile (when allowed) and report what is still
 * UNSET. An owner value of null/undefined counts as UNSET — "null" is not a policy.
 */
export function resolveSettings(config: ExecutionConfig): ResolvedSettings {
  const values: Record<string, ResolvedSetting> = {};
  const missing: RequiredSettingKey[] = [];
  for (const key of REQUIRED_SETTINGS) {
    const owner = config.ownerSettings[key];
    if (owner !== undefined && owner !== null && owner !== "") {
      values[key] = { key, value: owner, source: "OWNER" };
      continue;
    }
    if (config.useTestProfile) {
      values[key] = { key, value: TEST_PROFILE[key], source: "TEST" };
      continue;
    }
    values[key] = { key, value: null, source: "UNSET" };
    missing.push(key);
  }
  const problems = [...config.problems];
  for (const key of ["riskPerTradePct", "maxCombinedExposurePct", "maxPositions", "dailyLossThresholdPct", "maxSpreadPips", "maxEntryDeviationPips", "signalExpirySeconds"] as const) {
    const value = values[key].value;
    if (values[key].source !== "UNSET" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) problems.push(`${key} must be a positive finite number`);
  }
  if (values.maxPositions.source !== "UNSET" && !Number.isInteger(values.maxPositions.value)) problems.push("maxPositions must be an integer");
  const allowed = values.allowedInstruments.value;
  if (values.allowedInstruments.source !== "UNSET" && (!Array.isArray(allowed) || !allowed.length || allowed.some((x) => typeof x !== "string" || !/^[A-Z]{3}_[A-Z]{3}$/.test(x)))) problems.push("allowedInstruments must contain valid instrument names");
  const times = values.allowedTradingTimes.value as { days?: unknown[]; fromUtc?: string; toUtc?: string } | null;
  if (values.allowedTradingTimes.source !== "UNSET" && (!times || !Array.isArray(times.days) || !times.days.length || times.days.some((d) => !["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(String(d))) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(times.fromUtc ?? "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(times.toUtc ?? "") || times.fromUtc! > times.toUtc!)) problems.push("allowedTradingTimes must define a valid same-day UTC window");
  return {
    values,
    missing,
    allSet: missing.length === 0 && problems.length === 0,
    mode: config.mode,
    modeSource: config.modeSource,
    testProfileInUse: config.useTestProfile,
    problems,
  };
}

/**
 * Read the config from disk. A missing or unreadable file is NOT an error that
 * falls through to something permissive: it yields the default config, which is
 * signals-only with every setting UNSET, so nothing can trade.
 */
export async function loadConfigFromDisk(path: string = CONFIG_PATH): Promise<ExecutionConfig> {
  const { readFile } = await import("node:fs/promises");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const cfg = defaultConfig();
    cfg.problems.push(`could not read ${path} (${error instanceof Error ? error.message : String(error)}); using signals-only defaults`);
    return cfg;
  }
  return parseConfig(raw);
}

export function num(setting: ResolvedSetting): number {
  if (typeof setting.value === "number" && Number.isFinite(setting.value)) return setting.value;
  throw new Error(`setting ${setting.key} is not a finite number (${JSON.stringify(setting.value)})`);
}
