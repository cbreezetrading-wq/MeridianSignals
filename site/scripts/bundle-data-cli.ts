/**
 * CLI for scripts/bundle-data.ts. Run by publish.sh before every build, and by hand
 * with `bun run bundle-data`.
 *
 *   bun run scripts/bundle-data-cli.ts           copy + manifest + verify
 *   bun run scripts/bundle-data-cli.ts --check    verify only; exits 1 if the bundle
 *                                                 is missing, inconsistent, or older
 *                                                 than its source file
 */
import { bundleData, checkBundle, DATA_FILES } from "./bundle-data";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

let failed = false;

if (!checkOnly) {
  const outcome = await bundleData();
  for (const spec of DATA_FILES) {
    const entry = outcome.manifest.entries[spec.key];
    if (!entry) continue;
    console.log(
      `bundled ${spec.key}: ${entry.bundledPath} <- ${entry.sourcePath} (${String(entry.bytes)} bytes, sha256 ${entry.sha256})`,
    );
  }
  for (const warning of outcome.warnings) console.warn(`WARNING: ${warning}`);
  console.log(`manifest written: ${outcome.manifest.bundledAt}`);
}

const check = await checkBundle();
for (const line of check.lines) console.log(`ok   ${line}`);
for (const warning of check.warnings) console.warn(`WARN ${warning}`);
for (const problem of check.problems) {
  console.error(`FAIL ${problem}`);
  failed = true;
}

if (failed) {
  console.error(
    "bundle-data: the bundled data is missing, inconsistent, or older than its source. Not shipping it — fix the bundle first.",
  );
  process.exit(1);
}
console.log("bundle-data: bundle verified");
