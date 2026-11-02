/**
 * Where the published site gets its data.
 *
 * One resolution order, used by every page loader and every JSON endpoint, for all
 * three published data files (the hourly results, the daily results, the signal log):
 *
 *   1. An explicit env override — BACKTEST_RESULTS_PATH / DAILY_BACKTEST_RESULTS_PATH
 *      / SIGNAL_LOG_PATH — if that file is readable.
 *   2. The absolute shared path the file lives at on the owner's machine, if it is
 *      readable.
 *   3. The snapshot bundled into this build: src/data/bundled, copied by
 *      scripts/bundle-data.ts at publish time and inlined by the bundler, described
 *      by src/data/bundled/manifest.json (source path, sha256, byte size, copy time).
 *   4. Nothing. The caller is told there is no data and says so on the page; it never
 *      shows a remembered, cached or plausible-looking figure.
 *
 * Why step 3 exists: the published site is a different host and cannot see
 * /home/team/shared. Before this module, every read there failed with ENOENT — the
 * backtest pages said "unavailable", and the signal log was worse: a missing log was
 * silently created empty and shown as the beginning of the record. A snapshot inside
 * the artifact cannot be missing, and the manifest makes its vintage visible.
 *
 * The bundled text is the file byte for byte and is re-hashed against the manifest
 * on every read: a bundle that does not match its own manifest is treated as absent,
 * not served.
 */
import manifestJson from "../../data/bundled/manifest.json";
/** The shape of src/data/bundled/manifest.json (written by scripts/bundle-data.ts). */
type BundleEntry = {
  key: DataKey;
  description: string;
  sourcePath: string;
  envVar: string;
  envOverrideUsed: boolean;
  bundledPath: string;
  sha256: string;
  bytes: number;
  copiedAt: string;
  sourceModifiedAt: string | null;
  verifiedAgainstSource: boolean;
  note: string | null;
};

type BundleManifest = {
  generatedBy: string;
  bundledAt: string;
  entries: Partial<Record<DataKey, BundleEntry>>;
};

export type DataKey = "backtest" | "daily-backtest" | "signal-log";

const MANIFEST = manifestJson as BundleManifest;

export const DATA_SOURCES: Record<DataKey, { envVar: string; sharedPath: string; bundledPath: string }> = {
  backtest: {
    envVar: "BACKTEST_RESULTS_PATH",
    sharedPath: "/home/team/shared/backtest/results.json",
    bundledPath: "src/data/bundled/backtest-results.json",
  },
  "daily-backtest": {
    envVar: "DAILY_BACKTEST_RESULTS_PATH",
    sharedPath: "/home/team/shared/daily/results.json",
    bundledPath: "src/data/bundled/daily-results.json",
  },
  "signal-log": {
    envVar: "SIGNAL_LOG_PATH",
    sharedPath: "/home/team/shared/signal-log/signals.jsonl",
    bundledPath: "src/data/bundled/signals.jsonl",
  },
};

export type Origin = "env-override" | "shared-path" | "bundle";

export type BundledSnapshot = {
  /** The absolute path the bytes were copied from. */
  sourcePath: string;
  sha256: string;
  bytes: number;
  /** When the copy was made — this is the snapshot's cutoff. */
  copiedAt: string;
  bundledPath: string;
  /** Set when the copy could not be re-verified against its source at bundle time. */
  note: string | null;
};

export type SkippedCandidate = { path: string; reason: string };

export type Provenance = {
  key: DataKey;
  origin: Origin;
  /** The path the bytes came from: a file path, or the source path of the snapshot. */
  path: string;
  /** The env override this file honours, whether or not it was set. */
  envVar: string;
  bytes: number;
  sha256: string;
  /** Non-null only when origin === "bundle". */
  bundled: BundledSnapshot | null;
  /** Candidates tried before the one that worked, and why each was skipped. */
  skipped: SkippedCandidate[];
  /** When this resolution happened. */
  readAt: string;
};

export type ResolveResult =
  | { ok: true; text: string; provenance: Provenance }
  | { ok: false; skipped: SkippedCandidate[]; error: string };

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function readTextFile(path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    // Lazy, so the browser bundle never tries to resolve node:fs.
    const { readFile } = await import("node:fs/promises");
    return { ok: true, text: await readFile(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return { ok: false, reason: code };
  }
}

/**
 * The snapshot inlined into this build. Returns the text only if it matches the
 * manifest's sha256 and byte count, so a half-written or hand-edited bundle is
 * reported as absent rather than served.
 */
async function readBundled(
  key: DataKey,
): Promise<{ ok: true; text: string; entry: BundledSnapshot } | { ok: false; reason: string }> {
  if (typeof window !== "undefined") {
    return { ok: false, reason: "the bundled snapshot is only readable on the server" };
  }
  let text: string;
  try {
    // Literal specifiers, so the bundler inlines all three at build time.
    if (key === "backtest") {
      text = (await import("../../data/bundled/backtest-results.json?raw")).default;
    } else if (key === "daily-backtest") {
      text = (await import("../../data/bundled/daily-results.json?raw")).default;
    } else {
      text = (await import("../../data/bundled/signals.jsonl?raw")).default;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `the bundled snapshot could not be loaded (${message})` };
  }

  const entry = MANIFEST.entries[key];
  if (!entry) return { ok: false, reason: "the manifest has no entry describing the bundled snapshot" };

  const digest = await sha256Hex(text);
  if (digest !== entry.sha256 || byteLength(text) !== entry.bytes) {
    return {
      ok: false,
      reason: `the bundled snapshot does not match its manifest (sha256 ${digest.slice(0, 12)}… vs ${entry.sha256.slice(0, 12)}…)`,
    };
  }

  return {
    ok: true,
    text,
    entry: {
      sourcePath: entry.sourcePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      copiedAt: entry.copiedAt,
      bundledPath: entry.bundledPath,
      note: entry.note,
    },
  };
}

/**
 * Resolve one data file: env override → shared path → bundled snapshot → nothing.
 * Never throws for a missing file; the failure is reported, not swallowed.
 */
export async function resolveData(key: DataKey): Promise<ResolveResult> {
  const spec = DATA_SOURCES[key];
  const skipped: SkippedCandidate[] = [];

  if (typeof window === "undefined") {
    const override = process.env[spec.envVar];
    const candidates: { origin: Origin; path: string }[] = [];
    if (override !== undefined && override.trim() !== "") candidates.push({ origin: "env-override", path: override });
    // The shared path is still tried when no override is set, or when the override
    // names a different file that could not be read.
    if (!override || override.trim() === "" || override !== spec.sharedPath) {
      candidates.push({ origin: "shared-path", path: spec.sharedPath });
    }

    for (const candidate of candidates) {
      const read = await readTextFile(candidate.path);
      if (read.ok) {
        return {
          ok: true,
          text: read.text,
          provenance: {
            key,
            origin: candidate.origin,
            path: candidate.path,
            envVar: spec.envVar,
            bytes: byteLength(read.text),
            sha256: await sha256Hex(read.text),
            bundled: null,
            skipped,
            readAt: new Date().toISOString(),
          },
        };
      }
      skipped.push({ path: candidate.path, reason: read.reason });
    }
  }

  const bundled = await readBundled(key);
  if (bundled.ok) {
    return {
      ok: true,
      text: bundled.text,
      provenance: {
        key,
        origin: "bundle",
        path: bundled.entry.sourcePath,
        envVar: spec.envVar,
        bytes: bundled.entry.bytes,
        sha256: bundled.entry.sha256,
        bundled: bundled.entry,
        skipped,
        readAt: new Date().toISOString(),
      },
    };
  }
  skipped.push({ path: spec.bundledPath, reason: bundled.reason });

  return {
    ok: false,
    skipped,
    error: skipped.map((s) => `${s.path} (${s.reason})`).join("; "),
  };
}

/** "2026-10-31 19:40 UTC" from an ISO timestamp. */
export function provenanceStamp(iso: string): string {
  if (!iso) return "unknown";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Short form of a sha256 for display; the full value is in the manifest and the API. */
export function shortSha(sha: string): string {
  return `${sha.slice(0, 12)}…`;
}
