/**
 * Thin helper so scripts do not repeat the config/resolve incantation.
 */
import { loadConfigFromDisk, resolveSettings, type ExecutionConfig, type ResolvedSettings } from "./config.ts";

export async function loadConfig(path?: string): Promise<ExecutionConfig> {
  return loadConfigFromDisk(path);
}

export function resolveSettingsFrom(config: ExecutionConfig): ResolvedSettings {
  return resolveSettings(config);
}
