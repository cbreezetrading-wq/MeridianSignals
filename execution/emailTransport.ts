/**
 * Email transport for the execution report — a small, hand-rolled SMTP client.
 *
 * WHY THIS FILE EXISTS. Automatic Practice execution is live and the owner is notified of
 * nothing: an order can fill while nobody is looking, and the only trace is the console and
 * the append-only record. On 2026-11-04 the owner chose EMAIL as the channel (push and SMS
 * were considered and declined; there is no SMS capability here). This module is that
 * channel, and nothing else: it sends one plain-text message per report and it cannot place,
 * modify or cancel an order. No order path imports it.
 *
 * THE RULES IT IS BUILT TO:
 *
 *  1. FAIL CLOSED. All three secrets must be present and non-empty — MERIDIAN_SMTP_USER,
 *     MERIDIAN_SMTP_PASS, MERIDIAN_ALERT_TO. If any is missing, `configured()` is false,
 *     NOTHING CONNECTS ANYWHERE, and the detail names the missing VARIABLE NAMES (never a
 *     value). A configured send that the server refuses comes back delivered:false with the
 *     stage it failed at and the SMTP code. Only a 250 acceptance after the DATA terminator
 *     sets delivered:true, and then the final code and the server's message-id (if it gave
 *     one) are recorded.
 *  2. THE PASSWORD IS NEVER WRITTEN DOWN. Every string this module produces — detail lines,
 *     attempt records, error messages, thrown stacks — goes through `scrubSecrets`, which
 *     removes the password (and its base64 wire form) before anything is logged, returned or
 *     stored. The password is read from the environment at send time and exists only in the
 *     AUTH exchange.
 *  3. RETRIES ARE BOUNDED AND VISIBLE. A transient failure (a connection error or a 4xx) is
 *     retried at most twice with backoff. A 5xx rejection — an auth refusal above all — is
 *     never retried. Every attempt is recorded as one line with its stage, its SMTP code and
 *     its outcome, so a flapping mailbox shows up in the report instead of being retried
 *     silently into the ground.
 *  4. THE MESSAGE IS THE REPORT. The body is the report's own plain-language text, plus the
 *     execution mode, the strategy label and the measured-losing warning, taken from the
 *     report object the console and the record already carry. There is no second source of
 *     truth for what happened.
 *
 * WHY A HAND-ROLLED CLIENT. There is no mail binary and no MTA on this machine, and no npm
 * dependency can be added offline. The protocol needed here is small and fixed: EHLO →
 * STARTTLS → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT.
 *
 * HOST. smtp.gmail.com is a frozen constant, like the OANDA Practice host: no config value
 * and no environment variable can point this at another server. Port 587 with STARTTLS is
 * preferred; 465 with implicit TLS is the fallback when 587 cannot be reached. Tests inject a
 * local fake server through `createEmailTransport({ host, endpoints })`; production calls
 * `createEmailTransport()` with no arguments.
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { NotificationPayload, NotificationTransport } from "./notify.ts";

/* ------------------------------------------------------------------ the secrets */

/** The three environment variables this transport needs. Names only, ever. */
export const EMAIL_ENV_VARS = ["MERIDIAN_SMTP_USER", "MERIDIAN_SMTP_PASS", "MERIDIAN_ALERT_TO"] as const;
export type EmailEnvVar = (typeof EMAIL_ENV_VARS)[number];

/** The frozen relay. Nothing in config or the environment can change this. */
export const SMTP_HOST = "smtp.gmail.com";

/** 587 + STARTTLS first, 465 + implicit TLS as the fallback. */
export const SMTP_ENDPOINTS: ReadonlyArray<SmtpEndpoint> = [
  { port: 587, mode: "starttls" },
  { port: 465, mode: "tls" },
];

export type SmtpEndpoint = { port: number; mode: "starttls" | "tls" };

export type EmailSettings = {
  user: string;
  pass: string;
  to: string;
  host: string;
  endpoints: SmtpEndpoint[];
};

export type EmailEnvRead =
  | { configured: true; settings: EmailSettings; missing: [] }
  | { configured: false; settings: null; missing: string[] };

const clean = (value: string | undefined): string => (typeof value === "string" ? value.trim() : "");

/**
 * Read the three secrets. A value that is absent, empty or only whitespace counts as missing:
 * a blank app password is not a configured mailbox, and pretending otherwise would produce an
 * attempt that fails at AUTH every six hours.
 */
export function readEmailEnv(env: NodeJS.ProcessEnv = process.env, host = SMTP_HOST, endpoints = SMTP_ENDPOINTS): EmailEnvRead {
  const user = clean(env.MERIDIAN_SMTP_USER);
  const pass = clean(env.MERIDIAN_SMTP_PASS);
  const to = clean(env.MERIDIAN_ALERT_TO);
  const missing: string[] = [];
  if (!user) missing.push("MERIDIAN_SMTP_USER");
  if (!pass) missing.push("MERIDIAN_SMTP_PASS");
  if (!to) missing.push("MERIDIAN_ALERT_TO");
  if (missing.length > 0) return { configured: false, settings: null, missing };
  return { configured: true, settings: { user, pass, to, host, endpoints: [...endpoints] }, missing: [] };
}

/**
 * The sentence the report carries when email is not configured. It names the VARIABLES that
 * are missing and never a value, and it says plainly that nothing connected anywhere.
 */
export function missingEnvDetail(missing: string[]): string {
  const list = missing.length ? missing.join(", ") : EMAIL_ENV_VARS.join(", ");
  const verb = missing.length === 1 ? "is" : "are";
  return `email notification is not configured: ${list} ${verb} not set; nothing was sent and no connection to any mail server was opened`;
}

/* ------------------------------------------------------------------ redaction */

/**
 * Remove secrets from any string before it can reach a log, a report, a record entry or a
 * thrown stack. Both the raw value and its base64 form are scrubbed, because base64 of the
 * password is what actually crosses the wire and a chatty server can echo it back.
 */
export function scrubSecrets(input: string, secrets: ReadonlyArray<string>): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret.length >= 4) out = out.split(secret).join("[REDACTED]");
    if (secret.length >= 8) {
      const b64 = Buffer.from(secret, "utf8").toString("base64");
      out = out.split(b64).join("[REDACTED]");
      out = out.split(b64.replace(/=+$/, "")).join("[REDACTED]");
    }
  }
  return out;
}

/* ------------------------------------------------------------------ attempt records */

/** One line per attempt: what was tried, where it stopped, and what the server said. */
export type EmailAttempt = {
  /** 1-based across every attempt in this send. */
  attempt: number;
  /** "smtp.gmail.com:587 STARTTLS" — the endpoint, never a credential. */
  endpoint: string;
  /** CONNECT | GREETING | EHLO | STARTTLS | AUTH | MAIL FROM | RCPT TO | DATA | QUIT | DONE */
  stage: string;
  ok: boolean;
  /** The SMTP reply code, or null when the failure was at the socket level. */
  smtpCode: number | null;
  /** Scrubbed. Never contains the password. */
  detail: string;
  at: string;
};

export type EmailSendResult = {
  configured: boolean;
  /** True ONLY after the server's 250 acceptance of the DATA terminator. */
  delivered: boolean;
  detail: string;
  /** The stage the last attempt reached, or "DONE" on success. */
  stage: string | null;
  smtpCode: number | null;
  messageId: string | null;
  attempts: EmailAttempt[];
};

export type EmailTransportOptions = {
  /** The environment to read. Defaults to process.env. Tests pass an explicit object. */
  env?: NodeJS.ProcessEnv;
  /** Test seam only. Production uses the frozen SMTP_HOST. */
  host?: string;
  /** Test seam only. Production uses SMTP_ENDPOINTS (587 STARTTLS, then 465 TLS). */
  endpoints?: SmtpEndpoint[];
  /** Retries after the first attempt. Default 2, so at most three attempts per endpoint. */
  maxRetries?: number;
  /** Delay before each retry, in ms. Default [1000, 2000]. */
  backoffMs?: number[];
  /** Per-reply and per-connect timeout. Default 20 s. */
  timeoutMs?: number;
  /** Test seam only: the fake server presents a self-signed certificate. */
  tlsOptions?: tls.ConnectionOptions;
  /** Where attempt lines go. Defaults to console.log; everything is scrubbed first. */
  log?: (line: string) => void;
  now?: () => Date;
};

/* ------------------------------------------------------------------ the SMTP error */

/** A failure with the stage it happened at and the code the server gave, if any. */
class SmtpError extends Error {
  readonly stage: string;
  readonly smtpCode: number | null;
  readonly transient: boolean;
  constructor(stage: string, smtpCode: number | null, detail: string) {
    super(detail);
    this.name = "SmtpError";
    this.stage = stage;
    this.smtpCode = smtpCode;
    // 4xx is a temporary refusal; a socket failure is worth one more try. 5xx is final:
    // retrying a rejected credential only teaches the server to block us.
    this.transient = smtpCode === null || (smtpCode >= 400 && smtpCode < 500);
  }
}

/* ------------------------------------------------------------------ the wire */

/** A servername must be a host name; Node refuses an IP address there. */
const tlsServername = (host: string): string | undefined => (net.isIP(host) ? undefined : host);

type SmtpReply = { code: number; lines: string[]; text: string };

/**
 * One connection. Line-based, because SMTP is line-based: every reply is "NNN text" and a
 * multi-line reply repeats the code with a hyphen until the last line.
 */
class SmtpSession {
  private socket: net.Socket;
  private buffer = "";
  private queue: string[] = [];
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.buffer.indexOf("\r\n")) >= 0) {
        this.queue.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 2);
      }
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.failure ??= error;
      this.wake();
    });
    socket.on("close", () => {
      this.failure ??= new Error("the server closed the connection");
      this.wake();
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.slice()) waiter();
  }

  private take(): string | null {
    return this.queue.length ? (this.queue.shift() as string) : null;
  }

  private readLine(timeoutMs: number): Promise<string> {
    const ready = this.take();
    if (ready !== null) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        drop();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for the mail server`));
      }, timeoutMs);
      const drop = () => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(check);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const check = () => {
        const line = this.take();
        if (line !== null) {
          drop();
          resolve(line);
        } else if (this.failure) {
          drop();
          reject(this.failure);
        }
      };
      this.waiters.push(check);
    });
  }

  async readReply(timeoutMs: number): Promise<SmtpReply> {
    const first = await this.readLine(timeoutMs);
    const code = Number(first.slice(0, 3));
    const lines = [first];
    if (first.charAt(3) === "-") {
      // Multi-line reply: keep reading until a line with the same code and a space.
      for (;;) {
        const line = await this.readLine(timeoutMs);
        lines.push(line);
        if (line.slice(0, 3) === first.slice(0, 3) && line.charAt(3) !== "-") break;
      }
    }
    return { code: Number.isFinite(code) ? code : 0, lines, text: lines.join("\n") };
  }

  write(line: string): void {
    this.socket.write(line + "\r\n");
  }

  async command(line: string, timeoutMs: number, stage: string): Promise<SmtpReply> {
    this.write(line);
    const reply = await this.readReply(timeoutMs);
    if (reply.code < 200 || reply.code >= 400) {
      throw new SmtpError(stage, reply.code, `${stage} was refused with SMTP ${reply.code}: ${reply.text}`);
    }
    return reply;
  }

  /** Upgrade this connection to TLS after a 220 to STARTTLS. */
  async startTls(host: string, options: tls.ConnectionOptions, timeoutMs: number): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buffer = "";
    this.queue = [];
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        { socket: plain, servername: tlsServername(host), rejectUnauthorized: true, ...options },
        () => resolve(socket),
      );
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TLS handshake timed out after ${timeoutMs} ms`)));
      socket.once("error", reject);
    });
    secure.removeAllListeners("error");
    this.socket = secure;
    this.failure = null;
    this.attach(secure);
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // A connection already gone is not a failure worth reporting.
    }
  }
}

/* ------------------------------------------------------------------ message assembly */

/** A header value may not carry a newline, and an address may not carry angle brackets. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(subject: string): string {
  const flat = headerSafe(subject);
  // RFC 2047 for anything outside printable ASCII — the em dash in the subject is not.
  if (/^[\x20-\x7E]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** Base64 the body: it removes dot-stuffing and line-length limits as a class of bug. */
function encodeBody(body: string): string {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join("\r\n");
}

/**
 * The prose that rides with every message. Two facts must never be missing from a message
 * the owner reads out of hours: which mode is running, and that the strategy it is executing
 * is a measured losing one.
 */
export const STRATEGY_LABEL = "INVENTED_RULESET_TEST";
export const MEASURED_LOSING_WARNING =
  "The strategy being executed is a measured losing one: both tested variants (hourly and daily) lost money over ~24 years " +
  "of this account's own OANDA history, and both were independently replayed. Automatic execution exercises the order path, " +
  "not an edge. It is not a reason to go live.";

/** The mode, taken from the report object itself. No default, no guess. */
function modeLine(json: unknown): string {
  const report = json as { status?: string; mode?: { current?: unknown; configPath?: unknown } } | null;
  if (report && report.status === "OK" && report.mode && typeof report.mode.current === "string") {
    return `Execution mode: ${report.mode.current} (read from ${String(report.mode.configPath ?? "the config file")}).`;
  }
  return "Execution mode: not stated — this report could not be built, so it carries no mode. Nothing here should be read as a mode.";
}

export function buildEmailBody(payload: NotificationPayload, now: Date): string {
  return [
    payload.text.trimEnd(),
    "",
    "--",
    `Sent by Meridian Signals' execution worker at ${now.toISOString()} from the report ${payload.reportId}.`,
    modeLine(payload.json),
    `Strategy label: ${STRATEGY_LABEL} — the label stamped on every order this ruleset originates.`,
    MEASURED_LOSING_WARNING,
    "An order request is not a trade: only fills the broker confirmed are called fills.",
    "",
  ].join("\r\n");
}

export type AssembledMessage = {
  subject: string;
  /** The full RFC 5322 message, CRLF line endings, ready for DATA. */
  raw: string;
};

/** Build the message from the report payload. Pure: no network, no environment. */
export function buildEmailMessage(payload: NotificationPayload, settings: Pick<EmailSettings, "user" | "to">, now: Date): AssembledMessage {
  const subject = headerSafe(payload.subject);
  const headers = [
    `From: ${headerSafe(settings.user)}`,
    `To: ${headerSafe(settings.to)}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@meridian-signals.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    `X-Meridian-Report-Id: ${headerSafe(payload.reportId)}`,
    "X-Meridian-Transport: email",
  ];
  const raw = [...headers, "", encodeBody(buildEmailBody(payload, now))].join("\r\n");
  return { subject, raw };
}

/* ------------------------------------------------------------------ one attempt */

type AttemptOutcome = { code: number; messageId: string | null; text: string };

/**
 * One full SMTP conversation. Returns only when the server accepted the DATA terminator with
 * a 250; anything else throws an SmtpError carrying the stage and the code.
 */
async function converse(
  endpoint: SmtpEndpoint,
  settings: EmailSettings,
  raw: string,
  options: { timeoutMs: number; tlsOptions: tls.ConnectionOptions },
): Promise<AttemptOutcome> {
  const { host } = settings;
  const { timeoutMs } = options;
  let session: SmtpSession | null = null;
  let stage = "CONNECT";
  try {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const connecting =
        endpoint.mode === "tls"
          ? tls.connect(
              { host, port: endpoint.port, servername: tlsServername(host), rejectUnauthorized: true, ...options.tlsOptions },
              () => resolve(connecting),
            )
          : net.connect({ host, port: endpoint.port }, () => resolve(connecting));
      connecting.setTimeout(timeoutMs, () => connecting.destroy(new Error(`connecting to ${host}:${endpoint.port} timed out after ${timeoutMs} ms`)));
      connecting.once("error", reject);
    });
    session = new SmtpSession(socket);

    stage = "GREETING";
    const greeting = await session.readReply(timeoutMs);
    if (greeting.code !== 220) throw new SmtpError(stage, greeting.code, `the server greeted with SMTP ${greeting.code}: ${greeting.text}`);

    stage = "EHLO";
    let ehlo = await session.command("EHLO meridian-signals.local", timeoutMs, stage);

    if (endpoint.mode === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) {
        throw new SmtpError("STARTTLS", null, "the server did not advertise STARTTLS on this port, so the message was not sent in clear text");
      }
      stage = "STARTTLS";
      session.write("STARTTLS");
      const ready = await session.readReply(timeoutMs);
      if (ready.code !== 220) throw new SmtpError(stage, ready.code, `STARTTLS was refused with SMTP ${ready.code}: ${ready.text}`);
      try {
        await session.startTls(host, options.tlsOptions, timeoutMs);
      } catch (error) {
        throw new SmtpError(stage, null, `the TLS handshake after STARTTLS failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      stage = "EHLO";
      ehlo = await session.command("EHLO meridian-signals.local", timeoutMs, stage);
    }

    stage = "AUTH";
    const mechanisms = /AUTH\s+([^\n]*)/i.exec(ehlo.text)?.[1] ?? "";
    if (/PLAIN/i.test(mechanisms) && !/LOGIN/i.test(mechanisms)) {
      const token = Buffer.from(`\0${settings.user}\0${settings.pass}`, "utf8").toString("base64");
      session.write(`AUTH PLAIN ${token}`);
      const reply = await session.readReply(timeoutMs);
      if (reply.code !== 235) throw new SmtpError(stage, reply.code, `AUTH PLAIN was refused with SMTP ${reply.code}: ${reply.text}`);
    } else if (/LOGIN/i.test(mechanisms)) {
      session.write("AUTH LOGIN");
      const challenge = await session.readReply(timeoutMs);
      if (challenge.code !== 334) throw new SmtpError(stage, challenge.code, `AUTH LOGIN was refused with SMTP ${challenge.code}: ${challenge.text}`);
      session.write(Buffer.from(settings.user, "utf8").toString("base64"));
      const userReply = await session.readReply(timeoutMs);
      if (userReply.code !== 334) throw new SmtpError(stage, userReply.code, `the server refused the username with SMTP ${userReply.code}: ${userReply.text}`);
      session.write(Buffer.from(settings.pass, "utf8").toString("base64"));
      const passReply = await session.readReply(timeoutMs);
      if (passReply.code !== 235) throw new SmtpError(stage, passReply.code, `the server refused the credentials with SMTP ${passReply.code}: ${passReply.text}`);
    } else {
      throw new SmtpError(stage, null, "the server advertised no AUTH mechanism this client can use (it speaks AUTH LOGIN and AUTH PLAIN)");
    }

    stage = "MAIL FROM";
    await session.command(`MAIL FROM:<${settings.user}>`, timeoutMs, stage);

    stage = "RCPT TO";
    const rcpt = await session.command(`RCPT TO:<${settings.to}>`, timeoutMs, stage);
    if (rcpt.code !== 250 && rcpt.code !== 251) throw new SmtpError(stage, rcpt.code, `the recipient was refused with SMTP ${rcpt.code}: ${rcpt.text}`);

    stage = "DATA";
    const data = await session.command("DATA", timeoutMs, stage);
    if (data.code !== 354) throw new SmtpError(stage, data.code, `DATA was refused with SMTP ${data.code}: ${data.text}`);

    // The body is base64, so no line can begin with a dot: no dot-stuffing is needed.
    session.write(raw);
    session.write(".");
    const accepted = await session.readReply(timeoutMs);
    if (accepted.code !== 250) throw new SmtpError(stage, accepted.code, `the message was refused after DATA with SMTP ${accepted.code}: ${accepted.text}`);
    // "250 2.0.0 OK <id@host> - gsmtp": the server's own message-id, when it gives one.
    const messageId = /<([^<>\s]+@[^<>\s]+)>/.exec(accepted.text)?.[1] ?? null;

    stage = "QUIT";
    try {
      session.write("QUIT");
      await session.readReply(Math.min(timeoutMs, 2000));
    } catch {
      // The message is already accepted; a broken goodbye changes nothing.
    }
    return { code: 250, messageId, text: accepted.text };
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    throw new SmtpError(stage, null, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    session?.close();
  }
}

/* ------------------------------------------------------------------ the transport */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const endpointLabel = (host: string, endpoint: SmtpEndpoint): string =>
  `${host}:${endpoint.port} ${endpoint.mode === "starttls" ? "STARTTLS" : "implicit TLS"}`;

/**
 * Send one message, honestly.
 *
 * Never throws: every failure is a returned result with a scrubbed detail, so a delivery
 * problem can neither stop the watcher nor look like a delivery.
 */
export async function sendEmail(payload: NotificationPayload, options: EmailTransportOptions = {}): Promise<EmailSendResult> {
  const now = options.now ?? (() => new Date());
  const host = options.host ?? SMTP_HOST;
  const endpoints = options.endpoints ?? SMTP_ENDPOINTS;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const backoff = options.backoffMs ?? [1000, 2000];
  const timeoutMs = options.timeoutMs ?? 20_000;
  const log = options.log ?? ((line: string) => console.log(line));
  const attempts: EmailAttempt[] = [];

  const read = readEmailEnv(options.env ?? process.env, host, endpoints);
  if (!read.configured) {
    const detail = missingEnvDetail(read.missing);
    log(detail);
    return { configured: false, delivered: false, detail, stage: null, smtpCode: null, messageId: null, attempts };
  }

  const settings = read.settings;
  // The password, in both the forms it can reach a server: on its own (AUTH LOGIN) and inside
  // the AUTH PLAIN token. The username is not a secret and is deliberately NOT scrubbed — the
  // report should be able to say which mailbox refused us.
  const secrets = [settings.pass, `\0${settings.user}\0${settings.pass}`];
  const scrub = (line: string): string => scrubSecrets(line, secrets);

  // Addresses are refused before any connection when they cannot be a header value: a
  // newline in MERIDIAN_ALERT_TO would otherwise be an injected header.
  const badAddress = [settings.user, settings.to].find((value) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value));
  if (badAddress) {
    const detail = "email notification is configured but an address is not usable (it is not a bare mailbox address); nothing was sent";
    log(scrub(detail));
    return { configured: true, delivered: false, detail, stage: "CONFIG", smtpCode: null, messageId: null, attempts };
  }

  const message = buildEmailMessage(payload, settings, now());

  for (const endpoint of endpoints) {
    const label = endpointLabel(host, endpoint);
    for (let index = 0; index <= maxRetries; index += 1) {
      const attempt = attempts.length + 1;
      const at = now().toISOString();
      try {
        const outcome = await converse(endpoint, settings, message.raw, { timeoutMs, tlsOptions: options.tlsOptions ?? {} });
        attempts.push({
          attempt,
          endpoint: label,
          stage: "DONE",
          ok: true,
          smtpCode: outcome.code,
          detail: scrub(`accepted with SMTP ${outcome.code}${outcome.messageId ? `, message-id <${outcome.messageId}>` : ", no message-id given"}`),
          at,
        });
        const detail = scrub(
          `accepted by ${label} with SMTP ${outcome.code} after ${attempts.length} attempt(s)` +
            (outcome.messageId ? `, message-id <${outcome.messageId}>` : ", the server gave no message-id"),
        );
        log(`email attempt ${attempt} ${label}: ACCEPTED (SMTP ${outcome.code})`);
        return { configured: true, delivered: true, detail, stage: "DONE", smtpCode: outcome.code, messageId: outcome.messageId, attempts };
      } catch (error) {
        const failure =
          error instanceof SmtpError
            ? { stage: error.stage, code: error.smtpCode, transient: error.transient, detail: error.message }
            : { stage: "CONNECT", code: null, transient: true, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        const detail = scrub(failure.detail);
        attempts.push({ attempt, endpoint: label, stage: failure.stage, ok: false, smtpCode: failure.code, detail, at });
        log(`email attempt ${attempt} ${label}: FAILED at ${failure.stage} (${failure.code === null ? "no SMTP code" : `SMTP ${failure.code}`}) — ${detail}`);
        if (!failure.transient) {
          // A 5xx is the server's final answer. Retrying a rejected credential is how a
          // mailbox gets locked, so this stops here and says so.
          const said = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
          const final =
            `email NOT delivered: ${failure.stage} was refused with SMTP ${failure.code} and a ${failure.code} refusal is not retried ` +
            `(${attempts.length} attempt(s)); nothing was delivered. The server said: ${said}`;
          return { configured: true, delivered: false, detail: scrub(final), stage: failure.stage, smtpCode: failure.code, messageId: null, attempts };
        }
        if (index < maxRetries) {
          await sleep(backoff[index] ?? backoff[backoff.length - 1] ?? 1000);
        }
      }
    }
  }

  const last = attempts[attempts.length - 1];
  const final = scrub(
    `email NOT delivered after ${attempts.length} attempt(s) across ${endpoints.length} endpoint(s); the last failure was at ` +
      `${last?.stage ?? "CONNECT"}${last?.smtpCode != null ? ` with SMTP ${last.smtpCode}` : " with no SMTP code"} on ${last?.endpoint ?? host}. Nothing was delivered.`,
  );
  log(final);
  return {
    configured: true,
    delivered: false,
    detail: final,
    stage: last?.stage ?? null,
    smtpCode: last?.smtpCode ?? null,
    messageId: null,
    attempts,
  };
}

/**
 * The NotificationTransport the report resolves from config under the name "email".
 *
 * `configured()` reads the environment at call time, so saving a secret and restarting is
 * enough: no rebuild, no code change. `unconfiguredDetail()` is what the report carries when
 * the secrets are absent — the missing variable NAMES, and a plain statement that nothing
 * connected anywhere.
 */
export function createEmailTransport(options: EmailTransportOptions = {}): NotificationTransport & {
  unconfiguredDetail: () => string;
  lastResult: () => EmailSendResult | null;
} {
  let last: EmailSendResult | null = null;
  const readEnv = () => readEmailEnv(options.env ?? process.env, options.host ?? SMTP_HOST, options.endpoints ?? SMTP_ENDPOINTS);
  return {
    id: "email",
    describe: () =>
      `email to the address in MERIDIAN_ALERT_TO via ${options.host ?? SMTP_HOST}:${(options.endpoints ?? SMTP_ENDPOINTS)
        .map((endpoint) => `${endpoint.port} ${endpoint.mode === "starttls" ? "STARTTLS" : "implicit TLS"}`)
        .join(", then ")}`,
    configured: () => readEnv().configured,
    unconfiguredDetail: () => missingEnvDetail(readEnv().missing),
    send: async (payload: NotificationPayload) => {
      last = await sendEmail(payload, options);
      return {
        delivered: last.delivered,
        detail: last.detail,
        configured: last.configured,
        stage: last.stage,
        smtpCode: last.smtpCode,
        messageId: last.messageId,
        attempts: last.attempts,
      };
    },
    lastResult: () => last,
  };
}
