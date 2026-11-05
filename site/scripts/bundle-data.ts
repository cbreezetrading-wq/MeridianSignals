/**
 * bundle-data — copy the three published data files into the site tree as static
 * snapshots, described by a manifest.
 *
 * Why this exists
 * ---------------
 * The published site is a separate host: it cannot see /home/team/shared. Until
 * this script existed, every read of a backtest result or of the signal log there
 * failed with ENOENT and the pages said "unavailable" — and the signal log was
 * worse than that, because a missing log was silently *created* empty and then
 * presented as the beginning of the record. The fix is to ship the files inside the
 * deployed artifact, as data the bundler inlines, so a deployed build cannot fail to
 * find them and cannot fall back to "an empty log that looks like the record".
 *
 * What is copied, and what is not
 * -------------------------------
 * Exactly three files: the hourly results.json, the daily results.json and the
 * append-only signals.jsonl. The raw broker bar files (backtest/data, daily/data,
 * ~60 MB, personal-use broker terms) are deliberately NOT copied and must never be.
 * Each copy is byte-identical to its source, so its sha256 is the source's sha256.
 *
 * The manifest (src/data/bundled/manifest.json) records, for each file: the source
 * path the bytes came from, the env override in force (if any), the sha256, the byte
 * size, when it was copied and when the source was last modified. The pages print
 * that provenance so a reader can tell which vintage of the data they are looking
 * at. The manifest is written last, so a half-finished copy can never describe
 * itself as complete.
 *
 * Freshness
 * ---------
 * `bundleData()` re-copies on every publish (publish.sh runs it, and the Vite build
 * runs it too), so a stale bundle cannot be shipped by accident. `checkBundle()`
 * then re-hashes both sides: if a source is readable and its sha256 no longer
 * matches the bundle, the publish fails loudly instead of shipping old numbers.
 * If a source is not readable at build time (a build sandbox that does not have the
 * owner's files), the previous snapshot is carried forward and labelled as such in
 * the manifest — never silently presented as freshly verified.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The site root (this file lives in <site>/scripts/). */
export const SITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the snapshots are written, relative to the site root. */
export const BUNDLE_DIR = "src/data/bundled";

export type DataKey = "backtest" | "daily-backtest" | "signal-log";

export type DataFileSpec = {
  key: DataKey;
  /** The env override the readers honour, in the same precedence. */
  envVar: string;
  /** Where the file lives on the owner's machine. */
  sharedPath: string;
  /** The bundled file name inside src/data/bundled/. */
  file: string;
  /** What it is, for the manifest and the log line. */
  description: string;
};

export const DATA_FILES: readonly DataFileSpec[] = [
  {
    key: "backtest",
    envVar: "BACKTEST_RESULTS_PATH",
    sharedPath: "/home/team/shared/backtest/results.json",
    file: "backtest-results.json",
    description: "hourly backtest results",
  },
  {
    key: "daily-backtest",
    envVar: "DAILY_BACKTEST_RESULTS_PATH",
    sharedPath: "/home/team/shared/daily/results.json",
    file: "daily-results.json",
    description: "daily backtest results",
  },
  {
    key: "signal-log",
    envVar: "SIGNAL_LOG_PATH",
    sharedPath: "/home/team/shared/signal-log/signals.jsonl",
    file: "signals.jsonl",
    description: "append-only signal log",
  },
] as const;

export type BundleEntry = {
  key: DataKey;
  description: string;
  /** Absolute path the bytes were copied from. */
  sourcePath: string;
  /** The env override name for this file, and whether it was set at bundle time. */
  envVar: string;
  envOverrideUsed: boolean;
  /** Path of the bundled copy, relative to the site root. */
  bundledPath: string;
  sha256: string;
  bytes: number;
  /** When this copy was made (UTC ISO 8601). This is the snapshot's cutoff. */
  copiedAt: string;
  /** Last modification time of the source, when it was readable. */
  sourceModifiedAt: string | null;
  /** True only when the copy was re-hashed from the source in this run. */
  verifiedAgainstSource: boolean;
  /** Set when the source could not be read and an earlier copy was carried forward. */
  note: string | null;
};

export type BundleManifest = {
  generatedBy: string;
  bundledAt: string;
  /** The three files, keyed by DataKey. */
  entries: Partial<Record<DataKey, BundleEntry>>;
};

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readManifest(outDir: string): Promise<BundleManifest | null> {
  try {
    const text = await readFile(join(outDir, "manifest.json"), "utf8");
    return JSON.parse(text) as BundleManifest;
  } catch {
    return null;
  }
}

/** The source path for one file, honouring the same env override the readers do. */
export function sourcePathFor(spec: DataFileSpec): { path: string; fromEnvOverride: boolean } {
  const override = process.env[spec.envVar];
  if (override !== undefined && override.trim() !== "") return { path: override, fromEnvOverride: true };
  return { path: spec.sharedPath, fromEnvOverride: false };
}

export type BundleOutcome = {
  manifest: BundleManifest;
  /** Non-fatal notes: a source was unreadable and an earlier copy was carried forward. */
  warnings: string[];
};

/**
 * Copy the three data files into src/data/bundled and write the manifest.
 * Throws when a file cannot be bundled and cannot be accounted for.
 */
export async function bundleData(): Promise<BundleOutcome> {
  const outDir = join(SITE_ROOT, BUNDLE_DIR);
  await mkdir(outDir, { recursive: true });
  const previous = await readManifest(outDir);
  const warnings: string[] = [];
  const entries: Partial<Record<DataKey, BundleEntry>> = {};
  const copiedAt = new Date().toISOString();

  for (const spec of DATA_FILES) {
    const { path: sourcePath, fromEnvOverride } = sourcePathFor(spec);
    const outPath = join(outDir, spec.file);
    const bundledPath = `${BUNDLE_DIR}/${spec.file}`;

    let sourceBytes: Buffer | null = null;
    let sourceModifiedAt: string | null = null;
    let readError = "";
    try {
      sourceBytes = await readFile(sourcePath);
      sourceModifiedAt = (await stat(sourcePath)).mtime.toISOString();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      readError = code;
      sourceBytes = null;
    }

    if (sourceBytes) {
      // Write the same bytes we hashed — never a re-serialisation — then re-read the
      // file we just wrote and hash it again, so the manifest can only describe what
      // is actually on disk.
      await writeFile(outPath, sourceBytes);
      const written = await readFile(outPath);
      const digest = sha256(sourceBytes);
      if (written.length !== sourceBytes.length || sha256(written) !== digest) {
        throw new Error(
          `bundle-data: the copy of ${spec.description} at ${bundledPath} does not match its source ${sourcePath} after writing. Refusing to continue.`,
        );
      }
      entries[spec.key] = {
        key: spec.key,
        description: spec.description,
        sourcePath,
        envVar: spec.envVar,
        envOverrideUsed: fromEnvOverride,
        bundledPath,
        sha256: digest,
        bytes: sourceBytes.length,
        copiedAt,
        sourceModifiedAt,
        verifiedAgainstSource: true,
        note: null,
      };
      continue;
    }

    // Source unreadable. Carry forward the previous copy only if we can account for
    // it exactly; never invent one.
    let existing: Buffer | null = null;
    try {
      existing = await readFile(outPath);
    } catch {
      existing = null;
    }
    const prior = previous?.entries[spec.key] ?? null;
    if (!existing) {
      throw new Error(
        `bundle-data: cannot read ${spec.description} at ${sourcePath} (${readError}) and there is no previous bundled copy at ${bundledPath}. Refusing to build a site that would have to say "unavailable".`,
      );
    }
    const digest = sha256(existing);
    if (!prior || prior.sha256 !== digest) {
      throw new Error(
        `bundle-data: cannot read ${spec.description} at ${sourcePath} (${readError}), and the existing copy at ${bundledPath} is not described by the manifest. Refusing to ship data it cannot account for.`,
      );
    }
    const note = `source not readable at this bundle run (${readError}); the copy from ${prior.copiedAt} was carried forward and could NOT be re-verified against the source`;
    warnings.push(`${spec.description}: ${note}`);
    entries[spec.key] = { ...prior, note };
  }

  const manifest: BundleManifest = {
    generatedBy: "site/scripts/bundle-data.ts",
    bundledAt: copiedAt,
    entries,
  };
  // Written last: a partial copy never describes itself as complete.
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, warnings };
}

export type BundleCheck = {
  ok: boolean;
  /** Fatal: the bundle cannot be trusted or is out of date. */
  problems: string[];
  /** Not fatal, but must be said out loud. */
  warnings: string[];
  lines: string[];
};

/**
 * Verify the bundle against itself and, where possible, against the sources.
 * A source whose sha256 differs from the bundle's means the bundle is stale: that
 * is a problem, not a warning, and the publish must stop.
 */
export async function checkBundle(): Promise<BundleCheck> {
  const outDir = join(SITE_ROOT, BUNDLE_DIR);
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];

  const manifest = await readManifest(outDir);
  if (!manifest) {
    return {
      ok: false,
      problems: [`no readable manifest at ${BUNDLE_DIR}/manifest.json — the site would have no data to show`],
      warnings,
      lines,
    };
  }

  for (const spec of DATA_FILES) {
    const entry = manifest.entries[spec.key];
    if (!entry) {
      problems.push(`${spec.description}: the manifest has no entry for it`);
      continue;
    }
    let bundledBytes: Buffer;
    try {
      bundledBytes = await readFile(join(SITE_ROOT, entry.bundledPath));
    } catch {
      problems.push(`${spec.description}: the bundled file ${entry.bundledPath} is missing`);
      continue;
    }
    const bundledDigest = sha256(bundledBytes);
    if (bundledDigest !== entry.sha256 || bundledBytes.length !== entry.bytes) {
      problems.push(
        `${spec.description}: ${entry.bundledPath} does not match the manifest (sha256 ${bundledDigest.slice(0, 12)}… vs ${entry.sha256.slice(0, 12)}…, ${String(bundledBytes.length)} vs ${String(entry.bytes)} bytes)`,
      );
      continue;
    }

    // Now the source side: is this copy still current?
    const { path: sourcePath } = sourcePathFor(spec);
    let sourceBytes: Buffer | null = null;
    let sourceError = "";
    try {
      sourceBytes = await readFile(sourcePath);
    } catch (error) {
      sourceError = (error as NodeJS.ErrnoException).code ?? "unknown error";
      sourceBytes = null;
    }

    if (!sourceBytes) {
      if (entry.note) {
        warnings.push(`${spec.description}: ${entry.note}`);
        lines.push(`${entry.description}: bundled copy of ${String(entry.bytes)} bytes, ${entry.sha256.slice(0, 16)}… — source NOT readable here (${sourceError}), carried forward from ${entry.copiedAt}`);
      } else {
        warnings.push(
          `${spec.description}: the source ${sourcePath} is not readable here (${sourceError}), so this copy could not be checked against it. It is the copy bundled at ${entry.copiedAt}.`,
        );
        lines.push(`${entry.description}: bundled copy of ${String(entry.bytes)} bytes, ${entry.sha256.slice(0, 16)}… — freshness not verifiable in this environment`);
      }
      continue;
    }

    const sourceDigest = sha256(sourceBytes);
    if (sourceDigest !== entry.sha256) {
      problems.push(
        `${spec.description}: STALE BUNDLE — ${sourcePath} now has sha256 ${sourceDigest.slice(0, 12)}… (${String(sourceBytes.length)} bytes) but the bundled copy is ${entry.sha256.slice(0, 12)}… (${String(entry.bytes)} bytes) from ${entry.copiedAt}. Re-run the bundler; publishing this would ship old numbers.`,
      );
      continue;
    }
    lines.push(
      `${entry.description}: bundled copy ${String(entry.bytes)} bytes, sha256 ${entry.sha256.slice(0, 16)}… — matches ${sourcePath} exactly`,
    );
  }

  return { ok: problems.length === 0, problems, warnings, lines };
}
