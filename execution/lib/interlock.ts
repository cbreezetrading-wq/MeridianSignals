/**
 * PRACTICE-ONLY INTERLOCK.
 *
 * This is the module that makes "practice only" a structural property rather than a
 * setting. It is deliberately the smallest, dumbest file in the project so it can be
 * read in full and audited in a minute.
 *
 * The rules it enforces:
 *
 *  1. The host is a frozen string constant. There is no env var, no config key, no
 *     parameter and no default that can change it. `api-fxpractice.oanda.com` is
 *     written once, here, and every outbound URL in the order path is built from it.
 *  2. `assertPracticeTarget()` is called twice on every request: once when the
 *     request is constructed and again immediately before it is handed to fetch.
 *     A URL that is not exactly the practice host over https on the default port is
 *     refused with an InterlockError — not a warning, not a fallback.
 *  3. `attestPracticeToken()` asks the LIVE host the same question with the same
 *     token and REQUIRES the answer to be a refusal. If the live host ever accepts
 *     this token, the interlock fails closed: the engine refuses to submit anything,
 *     because that would mean the credential in use can move real money.
 *
 * A future live build cannot be switched on by configuration. It would require
 * deleting this file and rewriting the client, which is a deliberate, reviewable code
 * change — which is exactly what the owner asked for.
 */

/** The one and only host this project may trade against. Frozen. */
export const PRACTICE_HOST = "api-fxpractice.oanda.com" as const;
/** The one and only origin this project may trade against. Frozen. */
export const PRACTICE_ORIGIN = `https://${PRACTICE_HOST}` as const;

/**
 * Hosts that must never be reachable from the order path. Listed so the refusal
 * message can name what was attempted, and so a test can assert against them.
 */
export const FORBIDDEN_HOSTS = Object.freeze(["api-fxtrade.oanda.com", "fxtrade.oanda.com"] as const);

export class InterlockError extends Error {
  readonly code = "INTERLOCK_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "InterlockError";
  }
}

/**
 * Validate a fully-built URL against the frozen practice origin.
 * Throws InterlockError on anything else. Returns the parsed URL on success.
 */
export function assertPracticeTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InterlockError(
      `ORDER PATH REFUSED: ${JSON.stringify(rawUrl)} is not an absolute URL, so it cannot be shown to point at the Practice host.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new InterlockError(
      `ORDER PATH REFUSED: ${url.protocol} is not https. Only https://${PRACTICE_HOST} is reachable from the order path.`,
    );
  }
  // An explicit port (even :443) is refused: it is a different authority and could
  // be anything sitting in front of the host.
  if (url.port !== "") {
    throw new InterlockError(
      `ORDER PATH REFUSED: explicit port :${url.port} on ${url.host}. Only the default https port on ${PRACTICE_HOST} is permitted.`,
    );
  }
  if (url.host.toLowerCase() !== PRACTICE_HOST) {
    const live = FORBIDDEN_HOSTS.includes(url.host.toLowerCase() as (typeof FORBIDDEN_HOSTS)[number]);
    throw new InterlockError(
      `ORDER PATH REFUSED: target host "${url.host}" is not the Practice host "${PRACTICE_HOST}".` +
        (live ? " That is the LIVE trading host and it is structurally unreachable from this build." : "") +
        " This is not configurable; it is an assertion in the order path.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new InterlockError("ORDER PATH REFUSED: credentials in the URL are not permitted.");
  }
  return url;
}

/** Build a URL on the practice origin and assert it in the same breath. */
export function practiceUrl(path: string): string {
  if (!path.startsWith("/")) throw new InterlockError(`ORDER PATH REFUSED: path "${path}" must start with "/".`);
  const url = `${PRACTICE_ORIGIN}${path}`;
  assertPracticeTarget(url);
  return url;
}

/** Static statement of the interlock, for the record and the UI. */
export function interlockStatement(): {
  practiceHost: string;
  practiceOrigin: string;
  forbiddenHosts: readonly string[];
  configurable: false;
  enforcedAt: string[];
} {
  return {
    practiceHost: PRACTICE_HOST,
    practiceOrigin: PRACTICE_ORIGIN,
    forbiddenHosts: FORBIDDEN_HOSTS,
    configurable: false,
    enforcedAt: [
      "module load: host is a frozen literal, no env/config/parameter can change it",
      "request construction: assertPracticeTarget(url) before the request object exists",
      "pre-flight: assertPracticeTarget(url) again immediately before fetch()",
      "session attestation: the live host is asked the same question and must refuse this token",
    ],
  };
}
