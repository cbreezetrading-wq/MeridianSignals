/**
 * The two defects of 2026-11-04, as tests, so neither can come back.
 *
 * WHAT HAPPENED. The console generated a report that stated facts that were false:
 *
 *   Execution mode: signals-only (source: DEFAULT)
 *   Reporting window: the whole record so far: 0 record(s) from seq 0 to 0
 *   Built from the append-only record (/home/team/shared/site/dist/server/orders.jsonl)
 *
 * The real mode was `automatic` (config.json), the real record held 1,827 records at
 * /home/team/shared/execution/orders.jsonl, and the run CREATED an empty
 * site/dist/server/orders.jsonl and a site/dist/server/reports/ directory. Two causes:
 *
 *  1. the execution directory defaulted to `new URL("../", import.meta.url)`, which is the
 *     module's own location — correct from source, and the BUNDLE's location once the site
 *     server compiled execution/lib/*.ts into site/dist/server/server.js;
 *  2. when the config file was not found, the config loader returned the built-in defaults
 *     and the report printed them as the mode.
 *
 * These tests cover the three things the fix must guarantee:
 *   (a) the paths do not depend on the working directory or the running file's location;
 *   (b) a config that could not be read yields an UNAVAILABLE report with NO mode in it;
 *   (c) a record that could not be read yields UNAVAILABLE, not zeros.
 */

import { isolate } from "./isolate.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXECUTION_DIR, executionDir, recordPath, configPath, reportsDir } from "../lib/paths.ts";
import { generateReport, readLatestReport, readLatestReportResult, renderReportText } from "../report.ts";
import { buildReport, type ReportComplete } from "../report.ts";
import { parseConfig } from "../lib/config.ts";

const dir = isolate();
const here = dirname(fileURLToPath(import.meta.url));
const pathsModule = resolve(here, "../lib/paths.ts");

/** A config file that states a mode, written where the isolated execution dir points. */
function writeConfig(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
}

/**
 * Put an environment variable back the way it was. Assigning `undefined` would set the
 * literal string "undefined", which the absolute-path guard then correctly refuses — a trap
 * worth naming, since it cost one test run.
 */
function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

const MODE_VALUES = /signals-only|approve-before-execution|automatic/;

/* ------------------------------------------------------- (a) paths are absolute */

test("the execution directory is an absolute constant, not the running file's location", () => {
  assert.ok(isAbsolute(DEFAULT_EXECUTION_DIR), "the default execution directory must be absolute");
  assert.equal(DEFAULT_EXECUTION_DIR, "/home/team/shared/execution");
});

test("no execution path is derived from process.cwd() or the running file's URL", async () => {
  // A source-level guard, because this is exactly the class of bug a behavioural test can
  // miss: the wrong answer and the right answer are the same string whenever the process
  // happens to be started in the right directory.
  const source = await (await import("node:fs/promises")).readFile(pathsModule, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(code.includes("process.cwd("), false, "lib/paths.ts must never call process.cwd()");
  assert.equal(code.includes("import.meta.url"), false, "lib/paths.ts must never derive a path from its own file location");
});

test("the paths do not move when the process's working directory does", () => {
  const before = { dir: executionDir(), record: recordPath(), config: configPath(), reports: reportsDir() };
  const elsewhere = mkdtempSync(join(tmpdir(), "meridian-cwd-"));
  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    assert.deepEqual({ dir: executionDir(), record: recordPath(), config: configPath(), reports: reportsDir() }, before);
    assert.equal(recordPath().startsWith(elsewhere), false, "a path must never be built under the working directory");
  } finally {
    process.chdir(previous);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a relative MERIDIAN_EXECUTION_DIR is refused rather than resolved against the working directory", () => {
  const previous = process.env.MERIDIAN_EXECUTION_DIR;
  try {
    process.env.MERIDIAN_EXECUTION_DIR = "execution";
    assert.throws(() => executionDir(), /not an absolute path/);
  } finally {
    process.env.MERIDIAN_EXECUTION_DIR = previous;
  }
});

/**
 * The reproduction itself, in a separate process started in an empty directory: it must find
 * the record and the config in the execution directory and write its report there, and it
 * must leave the working directory untouched. That is the exact scenario that failed — the
 * site server's cwd was site/dist/server.
 */
test("a report built from a foreign working directory reads the real record and config, and writes nothing into that directory", () => {
  const executionDirForChild = mkdtempSync(join(tmpdir(), "meridian-child-exec-"));
  const foreignCwd = mkdtempSync(join(tmpdir(), "meridian-child-cwd-"));
  try {
    writeConfig(join(executionDirForChild, "config.json"), {
      mode: "automatic",
      automaticAcknowledged: true,
      acknowledgedBy: "test acknowledgement",
      report: { intervalHours: 6, transport: "none" },
    });
    writeFileSync(
      join(executionDirForChild, "orders.jsonl"),
      JSON.stringify({ seq: 1, recordedAt: "2026-11-04T00:00:00.000Z", kind: "SESSION_START", state: "OK", payload: {}, prevHash: "0".repeat(64), hash: "x" }) + "\n",
      "utf8",
    );

    const script = join(foreignCwd, "probe.ts");
    writeFileSync(
      script,
      [
        `import { generateReport, readLatestReportResult } from ${JSON.stringify(resolve(here, "../report.ts"))};`,
        `import { recordPath, configPath, reportsDir } from ${JSON.stringify(pathsModule)};`,
        `const result = await generateReport({ client: null, trigger: "MANUAL" });`,
        `const latest = await readLatestReportResult();`,
        `console.log(JSON.stringify({ cwd: process.cwd(), recordPath: recordPath(), configPath: configPath(), reportsDir: reportsDir(), status: result.report.status, mode: (result.report as any).mode ?? null, files: result.files, latestFound: latest.found }));`,
      ].join("\n"),
      "utf8",
    );

    const run = spawnSync(process.execPath, [script], {
      cwd: foreignCwd,
      env: { ...process.env, MERIDIAN_EXECUTION_DIR: executionDirForChild, MERIDIAN_CONFIG_PATH: join(executionDirForChild, "config.json"), MERIDIAN_TEST_RUN: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `the probe process failed: ${run.stderr}`);
    const out = JSON.parse(run.stdout.trim().split("\n").pop()!);

    assert.equal(out.cwd, foreignCwd, "the probe must have run in the foreign directory");
    assert.equal(out.recordPath, join(executionDirForChild, "orders.jsonl"));
    assert.equal(out.configPath, join(executionDirForChild, "config.json"));
    assert.equal(out.reportsDir, join(executionDirForChild, "reports"));
    assert.equal(out.status, "OK", "the report must be complete, not unavailable");
    assert.equal(out.mode.current, "automatic");
    assert.equal(out.mode.source, "CONFIG");
    assert.equal(out.latestFound, true);
    assert.equal(dirname(out.files.json), join(executionDirForChild, "reports"));

    // Nothing at all was created in the directory the process was started from.
    assert.deepEqual(readdirSync(foreignCwd), ["probe.ts"], "the foreign working directory must be left untouched");
  } finally {
    rmSync(executionDirForChild, { recursive: true, force: true });
    rmSync(foreignCwd, { recursive: true, force: true });
  }
});

/* ------------------------------------------- (b) a missing config has no mode */

test("a config that could not be read yields an UNAVAILABLE report that states no mode at all", async () => {
  const missing = join(dir, "no-such-config.json");
  const result = await generateReport({
    client: null,
    configUnavailable: { path: missing, reason: "the file does not exist at that path" },
    trigger: "CONSOLE",
    now: new Date("2026-11-04T12:00:00.000Z"),
    dir: join(dir, "reports-config-missing"),
  });

  assert.equal(result.report.status, "UNAVAILABLE");
  const unavailable = result.report as Extract<typeof result.report, { status: "UNAVAILABLE" }>;

  // No mode, no counts, no P&L: the fields do not exist, so nothing can print a default.
  assert.equal("mode" in unavailable, false, "an unavailable report must carry no mode");
  assert.equal("counts" in unavailable, false, "an unavailable report must carry no counts");
  assert.equal("account" in unavailable, false, "an unavailable report must carry no account figures");
  assert.equal("totals" in unavailable, false, "an unavailable report must carry no P&L");
  assert.equal("fills" in unavailable, false);

  // It names the path it looked for and why it could not read it.
  const configFailure = unavailable.unavailable.find((u) => u.source === "CONFIG");
  assert.ok(configFailure, "the config failure must be listed");
  assert.equal(configFailure!.path, missing);
  assert.match(configFailure!.reason, /does not exist/);

  // The text states no mode value anywhere, and no "Execution mode:" line.
  assert.equal(MODE_VALUES.test(result.text), false, `no mode value may appear in the text:\n${result.text}`);
  assert.equal(/Execution mode:/i.test(result.text), false);
  assert.ok(result.text.includes(missing), "the text must name the path that was looked for");
  assert.match(result.text, /UNAVAILABLE/);
  assert.match(result.text, /could not be built/);

  // The JSON on disk says the same thing.
  const onDisk = await (await import("node:fs/promises")).readFile(result.files.json, "utf8");
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.status, "UNAVAILABLE");
  assert.equal("mode" in parsed, false);
  assert.equal(MODE_VALUES.test(onDisk), false, "no mode value may appear in the JSON either");

  // And the console's read path shows this report rather than "none yet".
  const latest = await readLatestReportResult(join(dir, "reports-config-missing"));
  assert.equal(latest.found, true);
  assert.equal(latest.found && latest.report.json.status, "UNAVAILABLE");
});

test("a defaulted config is refused: no report may print signals-only (source: DEFAULT)", async () => {
  // This is the exact value the broken console printed. A config that did not come from a
  // file is not a fact about this account, so generateReport treats it as unreadable.
  const defaults = { ...parseConfig({}), reportTransport: "none" } as const;
  const result = await generateReport({
    client: null,
    config: { ...defaults, modeSource: "DEFAULT" },
    trigger: "CONSOLE",
    now: new Date("2026-11-04T12:05:00.000Z"),
    dir: join(dir, "reports-default-config"),
  });
  assert.equal(result.report.status, "UNAVAILABLE");
  assert.equal(MODE_VALUES.test(result.text), false);
  assert.equal(/\(source: DEFAULT\)/.test(result.text), false);

  // The pure builder refuses it too, so no caller can print a defaulted mode.
  assert.throws(
    () =>
      buildReport({
        records: [],
        broker: null,
        // @ts-expect-error — a DEFAULT config is not a ReportConfigFacts, and must not be accepted
        config: { ...defaults, modeSource: "DEFAULT", configPath: "/nowhere/config.json" },
        chain: { ok: true, recordCount: 0, firstBreak: null },
        notification: { transport: "none", transportDescription: "none", configured: false, delivered: false, detail: "none", attemptedAt: new Date(0).toISOString() },
        generatedAt: new Date(0).toISOString(),
        trigger: "MANUAL",
      }),
    /did not come from a config file/,
  );
});

/* ------------------------------------------- (c) a missing record is not zero */

test("a missing record file yields UNAVAILABLE, never a zero-record window", async () => {
  const executionDirForRecord = join(dir, "no-record-here");
  const previousDir = process.env.MERIDIAN_EXECUTION_DIR;
  const previousConfig = process.env.MERIDIAN_CONFIG_PATH;
  try {
    // A config that reads fine, and NO orders.jsonl at all.
    writeConfig(join(executionDirForRecord, "config.json"), { mode: "automatic", automaticAcknowledged: true, acknowledgedBy: "test", report: { intervalHours: 6 } });
    process.env.MERIDIAN_EXECUTION_DIR = executionDirForRecord;
    process.env.MERIDIAN_CONFIG_PATH = join(executionDirForRecord, "config.json");

    const result = await generateReport({ client: null, trigger: "SCHEDULED", now: new Date("2026-11-04T12:10:00.000Z") });
    assert.equal(result.report.status, "UNAVAILABLE");
    const unavailable = result.report as Extract<typeof result.report, { status: "UNAVAILABLE" }>;
    assert.equal("counts" in unavailable, false, "a missing record must not become 0 orders / 0 fills");
    const recordFailure = unavailable.unavailable.find((u) => u.source === "RECORD");
    assert.ok(recordFailure, "the record failure must be listed");
    assert.equal(recordFailure!.path, join(executionDirForRecord, "orders.jsonl"));
    assert.match(recordFailure!.reason, /does not exist/);
    assert.equal(/0 record\(s\)/.test(result.text), false, "the text must not claim a zero-record window");

    // The report is written where it belongs, and no empty record was created to fill the gap.
    assert.equal(result.files.json.startsWith(join(executionDirForRecord, "reports")), true);
    assert.deepEqual(
      readdirSync(executionDirForRecord).sort(),
      ["config.json", "reports"],
      "generating an unavailable report must not create an orders.jsonl",
    );

    // The scheduler's window did not advance: no state file was written.
    assert.equal(readdirSync(join(executionDirForRecord, "reports")).includes("state.json"), false);

    // And nothing was appended to a record that could not be read.
    assert.equal(result.recordSeq, null);
  } finally {
    restoreEnv("MERIDIAN_EXECUTION_DIR", previousDir);
    restoreEnv("MERIDIAN_CONFIG_PATH", previousConfig);
  }
});

/* ------------------------------------------- the complete path still works */

test("a readable config and record still produce a complete report naming the config file", async () => {
  const okDir = join(dir, "ok-execution");
  const previousDir = process.env.MERIDIAN_EXECUTION_DIR;
  const previousConfig = process.env.MERIDIAN_CONFIG_PATH;
  try {
    writeConfig(join(okDir, "config.json"), { mode: "automatic", automaticAcknowledged: true, acknowledgedBy: "test", report: { intervalHours: 6 } });
    writeFileSync(
      join(okDir, "orders.jsonl"),
      JSON.stringify({ seq: 1, recordedAt: "2026-11-04T00:00:00.000Z", kind: "ACCOUNT_READ", state: "OK", payload: { nav: 100585.24, balance: 100585.24 }, prevHash: "0".repeat(64), hash: "x" }) + "\n",
      "utf8",
    );
    process.env.MERIDIAN_EXECUTION_DIR = okDir;
    process.env.MERIDIAN_CONFIG_PATH = join(okDir, "config.json");

    const result = await generateReport({ client: null, trigger: "MANUAL", now: new Date("2026-11-04T12:20:00.000Z") });
    assert.equal(result.report.status, "OK");
    const report = result.report as ReportComplete;
    assert.equal(report.mode.current, "automatic");
    assert.equal(report.mode.source, "CONFIG");
    assert.equal(report.mode.configPath, join(okDir, "config.json"));
    assert.equal(report.ledger.path, join(okDir, "orders.jsonl"));
    assert.equal(report.ledger.recordsTotal, 1);
    assert.ok(result.text.includes(`Execution mode: automatic (source: CONFIG, read from ${join(okDir, "config.json")})`));
    assert.ok(result.recordSeq !== null, "a complete report is recorded in the record");
    assert.equal((await readLatestReport())?.reportId, result.report.reportId);
  } finally {
    restoreEnv("MERIDIAN_EXECUTION_DIR", previousDir);
    restoreEnv("MERIDIAN_CONFIG_PATH", previousConfig);
  }
});

test("the rendered text of an unavailable report never contains a mode value", async () => {
  // Belt and braces over the whole surface: whatever combination of missing sources is
  // passed, the renderer cannot print a mode, because the object has none.
  const result = await generateReport({
    client: null,
    configUnavailable: { path: "/x/config.json", reason: "the file does not exist at that path" },
    trigger: "CONSOLE",
    now: new Date("2026-11-04T12:30:00.000Z"),
    dir: join(dir, "reports-render"),
  });
  assert.equal(renderReportText(result.report as any), result.text);
  assert.equal(MODE_VALUES.test(result.text), false);
});
