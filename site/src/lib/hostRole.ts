/**
 * Which host is answering: the working host, or the published build.
 *
 * The working host runs the dev server (`bun run dev`) beside the live `execution/`
 * directory and its supervised worker. The published build is what `bun run build`
 * produces and what the public URL serves; it carries compiled output only — no
 * execution ledger, no config, no operator key, no worker, no writable shared volume.
 *
 * So the public port must not expose an execution surface at all: the owner decided
 * on 2026-11-01 that the console is working-host-only and unlisted, and
 * `execution/UNLISTED_REQUIREMENT.md` makes it binding — no account numbers, balances,
 * equity, order ids or execution endpoints on the public port. A published build has
 * nothing to answer those requests from; the only possible answers are fabricated
 * state or a proxy to the working host, and both put account data behind a public URL.
 *
 * The decision is made at BUILD time, not by a runtime setting: `import.meta.env.PROD`
 * is replaced by Vite in the client and the server bundle alike, so an environment
 * variable on the published host cannot talk it back into serving the console.
 */
const BUILD_IS_PUBLISHED = import.meta.env.PROD === true;

/**
 * Test hook only. A gate test must be able to stand in both hosts without running a
 * production build; nothing in the app calls this, so a published build always answers
 * from `BUILD_IS_PUBLISHED`.
 */
let testOverride: boolean | null = null;

export function setPublishedHostForTest(value: boolean | null): void {
  testOverride = value;
}

export function isPublishedHost(): boolean {
  return testOverride ?? BUILD_IS_PUBLISHED;
}

/**
 * The one answer a published build gives to an execution surface: 404, carrying no
 * mode, no count, no account figure and no backend address — it discloses nothing
 * about whether a working host exists behind it.
 */
export function publishedHostNotFound(): Response {
  return Response.json(
    { error: "Not found." },
    { status: 404, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}
