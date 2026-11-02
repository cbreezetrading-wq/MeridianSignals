import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Keep state on persistent local storage. All workers for an account must share it.
export const EXECUTION_DIR = resolve(process.env.MERIDIAN_EXECUTION_DIR ?? fileURLToPath(new URL("../", import.meta.url)));
export const executionPath = (name: string): string => resolve(EXECUTION_DIR, name);
export const CONFIG_PATH = resolve(process.env.MERIDIAN_CONFIG_PATH ?? executionPath("config.json"));
