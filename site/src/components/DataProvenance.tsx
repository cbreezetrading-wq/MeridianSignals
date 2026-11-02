/**
 * Where the numbers on the page came from.
 *
 * The published site cannot see the owner's machine, so it serves a snapshot of the
 * data bundled into the build. That is legitimate — it is the same file, byte for
 * byte — but a reader is entitled to know which vintage of the file they are looking
 * at, so every page that shows a stored figure prints the provenance: whether the
 * bytes were read from the file on this machine or from the publish-time snapshot,
 * when the copy was taken, its sha256 and its size.
 *
 * Nothing here invents anything: it renders what resolveData() reported.
 */
import type { Provenance, SkippedCandidate } from "~/lib/market/bundledData";

/** "2026-10-31 19:40 UTC" from an ISO timestamp. */
export function stampOf(iso: string): string {
  if (!iso) return "unknown";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Thousands separators, computed by hand so server and browser always agree. */
export function bytesOf(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} bytes`;
}

/** The full sha256 is in the title attribute and in the JSON endpoint. */
function Sha({ sha }: { sha: string }) {
  return (
    <span className="font-mono" title={sha}>
      sha256 {sha.slice(0, 12)}…
    </span>
  );
}

export function ProvenanceLine({ provenance, what }: { provenance: Provenance; what: string }) {
  const { origin, bundled } = provenance;

  return (
    <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-500">
      {origin === "bundle" && bundled ? (
        <>
          <strong className="font-semibold text-slate-600">Data:</strong> {what} read from a snapshot
          bundled into this deployment when the site was published — data bundled{" "}
          <span className="font-mono">{stampOf(bundled.copiedAt)}</span> · <Sha sha={bundled.sha256} /> ·{" "}
          <span className="font-mono">{bytesOf(bundled.bytes)}</span> · copied byte for byte from{" "}
          <span className="font-mono">{bundled.sourcePath}</span>. This host cannot read the
          owner&rsquo;s machine, so it serves that dated copy; no figure was re-typed or recalculated
          to produce this page. The same answer, with the full manifest entry, is available as JSON
          from{" "}
          <a
            className="underline"
            href={provenance.key === "daily-backtest" ? "/api/daily-backtest" : "/api/backtest"}
          >
            {provenance.key === "daily-backtest" ? "/api/daily-backtest" : "/api/backtest"}
          </a>
          .
        </>
      ) : (
        <>
          <strong className="font-semibold text-slate-600">Data:</strong> {what} read from{" "}
          <span className="font-mono">{provenance.path}</span> on this machine at{" "}
          <span className="font-mono">{stampOf(provenance.readAt)}</span> · <Sha sha={provenance.sha256} /> ·{" "}
          <span className="font-mono">{bytesOf(provenance.bytes)}</span>
          {origin === "env-override" ? (
            <>
              {" "}
              — that path is set by the <span className="font-mono">{provenance.envVar}</span> override
            </>
          ) : null}
          .
        </>
      )}
      {bundled?.note ? (
        <span className="mt-1 block text-amber-800">Note recorded at bundle time: {bundled.note}.</span>
      ) : null}
    </p>
  );
}

/**
 * Every place that was tried, in order, with the reason it was skipped. Shown only
 * when nothing could be read, so the page can say exactly what is missing instead of
 * showing a figure it cannot source.
 */
export function SkippedNotes({ skipped }: { skipped: SkippedCandidate[] }) {
  if (skipped.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-amber-900">
      {skipped.map((candidate) => (
        <li key={`${candidate.path}-${candidate.reason}`}>
          <span className="font-mono">{candidate.path}</span> — {candidate.reason}
        </li>
      ))}
    </ul>
  );
}
