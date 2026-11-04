/**
 * Tests for the email transport — the channel the owner chose on 2026-11-04.
 *
 * EVERY TEST RUNS AGAINST A FAKE SMTP SERVER IN THIS FILE. No real network, no real
 * credentials, no mail leaves this machine: the server is a `node:net` listener on 127.0.0.1
 * with an ephemeral port, and it does TLS with a self-signed certificate generated once for
 * these tests. The transport is pointed at it with the `host`/`endpoints` options, which exist
 * only for this purpose — production calls `createEmailTransport()` and gets the frozen
 * smtp.gmail.com.
 *
 * The addresses used here end in `.invalid`, the domain reserved for exactly this: no mailbox
 * exists at them, and none of them is the owner's address.
 *
 * What the tests pin down:
 *  - a message is delivered over STARTTLS, and `delivered` becomes true only after the
 *    server's 250 for the DATA terminator;
 *  - with a secret missing nothing connects anywhere, and the recorded detail names the
 *    missing VARIABLES and no value;
 *  - a 535 auth refusal is final — one attempt, no retry, delivered:false;
 *  - a 451 is retried once and then delivered, with both attempts recorded;
 *  - a refused connection is a recorded failure, not a crash and not a delivery;
 *  - the app password never appears in a result, a log line or an attempt record, including
 *    when the server echoes the username and the base64 it was sent back at us;
 *  - the subject leads with what happened and when, and a quiet window still sends a message;
 *  - notify.ts registers the transport and reports it as unconfigured.
 */

import { isolate } from "./isolate.ts";

const testDir = isolate();

import net from "node:net";
import tls from "node:tls";
import { afterAll, describe, expect, test } from "bun:test";
import {
  EMAIL_ENV_VARS,
  MEASURED_LOSING_WARNING,
  STRATEGY_LABEL,
  createEmailTransport,
  readEmailEnv,
  scrubSecrets,
  sendEmail,
  type EmailAttempt,
} from "../emailTransport.ts";
import { deliverReport, resolveTransport } from "../notify.ts";
import { reportSubject } from "../report.ts";

/* -------------------------------------------------------------- the test mailbox */

// Test values only. example.invalid is reserved for tests: no such mailbox exists.
const SENDER = "meridian-sender@example.invalid";
const RECIPIENT = "owner-alerts@example.invalid";
const PASSWORD = "app-password-do-not-log-9f3a2c";
const FULL_ENV = { MERIDIAN_SMTP_USER: SENDER, MERIDIAN_SMTP_PASS: PASSWORD, MERIDIAN_ALERT_TO: RECIPIENT };
const PASSWORD_B64 = Buffer.from(PASSWORD, "utf8").toString("base64");

/** A self-signed certificate for 127.0.0.1/localhost, generated once and embedded as base64. */
const TLS_KEY = Buffer.from("LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZys5dHVoWHJSbnBPekNrY0oKdGNEQzFlMTZNMzAramFzblNGQkxMcTlRaHFXaFJBTkNBQVJJbmhUVWpGemhMWnRBWUpqVHdIakVsbDh0SGRUZgo0SlBXRXdDbUxqVmxwK3F5c1o5QzlsdlVXenc0dXIyZTk3T0Ixei9Qb3ZIa1RGWjRGNmJrUWE0RgotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==", "base64").toString("utf8");
const TLS_CERT = Buffer.from("LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJtVENDQVQrZ0F3SUJBZ0lVV1RNU1hLMFR4OWtLMnZ5M2hpeituSkJnU1RFd0NnWUlLb1pJemowRUF3SXcKRkRFU01CQUdBMVVFQXd3SmJHOWpZV3hvYjNOME1CNFhEVEkyTVRFd05ESXdOREl5T1ZvWERUTTJNVEV3TVRJdwpOREl5T1Zvd0ZERVNNQkFHQTFVRUF3d0piRzlqWVd4b2IzTjBNRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBECkFRY0RRZ0FFU0o0VTFJeGM0UzJiUUdDWTA4QjR4SlpmTFIzVTMrQ1QxaE1BcGk0MVphZnFzckdmUXZaYjFGczgKT0xxOW52ZXpnZGMvejZMeDVFeFdlQmVtNUVHdUJhTnZNRzB3SFFZRFZSME9CQllFRkhMM1V0bFFQblFJUThHTQpvZnFHSVlGbnFCRFZNQjhHQTFVZEl3UVlNQmFBRkhMM1V0bFFQblFJUThHTW9mcUdJWUZucUJEVk1BOEdBMVVkCkV3RUIvd1FGTUFNQkFmOHdHZ1lEVlIwUkJCTXdFWUlKYkc5allXeG9iM04waHdSL0FBQUJNQW9HQ0NxR1NNNDkKQkFNQ0EwZ0FNRVVDSVFEYkl0dmlJUFhBSlJWcWdjNm90RUxJaEJ5cWtPai94eWJuc0M3cC94Y1c3d0lnSXJPegoraEFYd0o5WG01VnFFR29YZnh5MVcvSmlLWWxoNnVYQVY3VXFBVjg9Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K", "base64").toString("utf8");

const openServers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of openServers) await close();
});

type Behaviour = {
  /** Present TLS from the first byte (the 465 shape) rather than after STARTTLS. */
  implicitTls?: boolean;
  /** Advertise STARTTLS. Default true. */
  offerStartTls?: boolean;
  /** "ACCEPT" (default), "REJECT" (answer 535) — both speak AUTH. */
  auth?: "ACCEPT" | "REJECT";
  /** The mechanisms advertised after EHLO. Default "LOGIN PLAIN". */
  advertise?: string;
  /** How many times to answer 451 at the DATA terminator before accepting. */
  dataRejects?: number;
  /** The message-id to return, or null to return none. */
  messageId?: string | null;
  /** When set, the 535 reply quotes what the client sent (username and base64 password). */
  echoCredentials?: boolean;
};

type FakeSmtp = {
  port: number;
  connections: () => number;
  commands: () => string[];
  messages: () => string[];
  credentials: () => { user: string | null; pass: string | null };
  sawDataTerminator: () => boolean;
  close: () => Promise<void>;
};

function startFakeSmtp(behaviour: Behaviour = {}): Promise<FakeSmtp> {
  const state = {
    connections: 0,
    commands: [] as string[],
    messages: [] as string[],
    user: null as string | null,
    pass: null as string | null,
    dataTerminator: false,
    rejections: 0,
  };
  const secureContext = tls.createSecureContext({ key: TLS_KEY, cert: TLS_CERT });

  const handle = (rawSocket: net.Socket, alreadySecure: boolean): void => {
    state.connections += 1;
    let socket: net.Socket = rawSocket;
    let secured = alreadySecure;
    let buffer = "";
    let phase: "CMD" | "DATA" | "AUTH_USER" | "AUTH_PASS" = "CMD";
    let dataLines: string[] = [];

    const send = (lines: string | string[]): void => {
      for (const line of Array.isArray(lines) ? lines : [lines]) socket.write(line + "\r\n");
    };

    const attach = (target: net.Socket): void => {
      target.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        pump();
      });
      target.on("error", () => {
        // A test server that outlives a deliberately broken client is not a failure.
      });
    };

    const reject = (user: string | null, echoed: string | null): void => {
      // A multi-line reply: every line but the last carries a hyphen after the code.
      const lines = ["535-5.7.8 Username and Password not accepted. Learn more at", "535 5.7.8 https://support.example.invalid/accounts/answer"];
      if (behaviour.echoCredentials) {
        // A chatty server: it quotes back what it received. The username is not a secret; the
        // base64 password is, and the transport must not pass it on.
        lines.unshift(`535-5.7.8 <${user ?? "unknown"}> was rejected${echoed ? ` (received ${echoed})` : ""}`);
      }
      send(lines);
    };

    const finishAuth = (echoed: string | null): void => {
      phase = "CMD";
      if (behaviour.auth === "REJECT") {
        reject(state.user, echoed);
        return;
      }
      send("235 2.7.0 Accepted");
    };

    const handleLine = (line: string): void => {
      if (phase === "DATA") {
        if (line === ".") {
          state.dataTerminator = true;
          state.messages.push(dataLines.join("\r\n"));
          dataLines = [];
          phase = "CMD";
          if (state.rejections < (behaviour.dataRejects ?? 0)) {
            state.rejections += 1;
            send("451 4.3.0 temporary failure, please try again later");
          } else if (behaviour.messageId === null) {
            send("250 2.0.0 OK queued as fake");
          } else {
            send(`250 2.0.0 OK <${behaviour.messageId ?? "fake-message-1@fake.smtp.local"}> - gsmtp`);
          }
          return;
        }
        dataLines.push(line);
        return;
      }

      state.commands.push(line);

      if (phase === "AUTH_USER") {
        state.user = Buffer.from(line, "base64").toString("utf8");
        phase = "AUTH_PASS";
        send("334 UGFzc3dvcmQ6");
        return;
      }
      if (phase === "AUTH_PASS") {
        state.pass = Buffer.from(line, "base64").toString("utf8");
        finishAuth(line);
        return;
      }

      const [verbRaw, ...rest] = line.split(" ");
      const verb = (verbRaw ?? "").toUpperCase();
      if (verb === "EHLO" || verb === "HELO") {
        const lines = ["250-fake.smtp.local", "250-SIZE 35882577"];
        if ((behaviour.offerStartTls ?? true) && !secured) lines.push("250-STARTTLS");
        lines.push(`250-AUTH ${behaviour.advertise ?? "LOGIN PLAIN"}`);
        lines.push("250 SMTPUTF8");
        send(lines);
        return;
      }
      if (verb === "STARTTLS") {
        send("220 2.0.0 Ready to start TLS");
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
        secure.on("error", () => {});
        socket = secure as unknown as net.Socket;
        secured = true;
        buffer = "";
        attach(socket);
        return;
      }
      if (verb === "AUTH") {
        const mechanism = (rest[0] ?? "").toUpperCase();
        if (mechanism === "LOGIN") {
          send("334 VXNlcm5hbWU6");
          phase = "AUTH_USER";
          return;
        }
        if (mechanism === "PLAIN") {
          const token = rest[1] ?? "";
          const decoded = Buffer.from(token, "base64").toString("utf8").split("\0");
          state.user = decoded[1] ?? null;
          state.pass = decoded[2] ?? null;
          if (behaviour.auth === "REJECT") {
            reject(state.user, token);
            return;
          }
          send("235 2.7.0 Accepted");
          return;
        }
        send("504 5.5.4 Unrecognised authentication type");
        return;
      }
      if (verb === "MAIL") {
        send("250 2.1.0 OK");
        return;
      }
      if (verb === "RCPT") {
        send("250 2.1.5 OK");
        return;
      }
      if (verb === "DATA") {
        send("354 End data with <CR><LF>.<CR><LF>");
        phase = "DATA";
        return;
      }
      if (verb === "QUIT") {
        send("221 2.0.0 Bye");
        socket.end();
        return;
      }
      send("250 2.0.0 OK");
    };

    const pump = (): void => {
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleLine(line);
      }
    };

    attach(rawSocket);
    send("220 fake.smtp.local ESMTP ready");
  };

  const server = behaviour.implicitTls
    ? tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => handle(socket as unknown as net.Socket, true))
    : net.createServer((socket) => handle(socket, false));

  return new Promise<FakeSmtp>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake server did not report a port"));
        return;
      }
      const close = (): Promise<void> => new Promise((done) => server.close(() => done()));
      openServers.push(close);
      resolve({
        port: address.port,
        connections: () => state.connections,
        commands: () => state.commands.slice(),
        messages: () => state.messages.slice(),
        credentials: () => ({ user: state.user, pass: state.pass }),
        sawDataTerminator: () => state.dataTerminator,
        close,
      });
    });
  });
}

/** A port nothing is listening on: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 1;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/* -------------------------------------------------------------- message parsing */

/** Split a received message into headers (lower-cased names, RFC 2047 decoded) and body. */
function parseMessage(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const headerBlock = split >= 0 ? raw.slice(0, split) : raw;
  const encodedBody = split >= 0 ? raw.slice(split + 4) : "";
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const encoded = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(value);
    headers[name] = encoded ? Buffer.from(encoded[1], "base64").toString("utf8") : value;
  }
  const body = Buffer.from(encodedBody.replace(/\r\n/g, ""), "base64").toString("utf8");
  return { headers, body };
}

/* -------------------------------------------------------------- the report payload */

const PAYLOAD = {
  reportId: "rpt-20261104T204100Z",
  generatedAt: "2026-11-04T20:41:00.000Z",
  subject: "Meridian: 2 fills, 1 refusal — 2026-11-04 20:41 UTC",
  text: "# Meridian execution report rpt-20261104T204100Z\n\nExecution mode: automatic (source: CONFIG).\n\nFills confirmed by the broker: 2.",
  json: { status: "OK", mode: { current: "automatic", configPath: "/srv/execution/config.json" } },
};

const transportFor = (server: FakeSmtp, overrides: Record<string, unknown> = {}) =>
  createEmailTransport({
    env: FULL_ENV,
    host: "127.0.0.1",
    endpoints: [{ port: server.port, mode: "starttls" as const }],
    tlsOptions: { rejectUnauthorized: false },
    timeoutMs: 4000,
    log: () => {},
    ...overrides,
  });

/* ------------------------------------------------------------------------ tests */

describe("email transport", () => {
  test("delivers over STARTTLS and claims delivery only after the 250", async () => {
    const server = await startFakeSmtp({ messageId: "fake-message-1@fake.smtp.local" });
    const result = await transportFor(server).send(PAYLOAD);

    expect(result.delivered).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.smtpCode).toBe(250);
    expect(result.stage).toBe("DONE");
    expect(result.messageId).toBe("fake-message-1@fake.smtp.local");
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].ok).toBe(true);

    // The server saw a TLS session, the envelope and the terminator.
    expect(server.commands()).toContain(`MAIL FROM:<${SENDER}>`);
    expect(server.commands()).toContain(`RCPT TO:<${RECIPIENT}>`);
    expect(server.sawDataTerminator()).toBe(true);
    expect(server.messages().length).toBe(1);

    const { headers, body } = parseMessage(server.messages()[0]);
    expect(headers["to"]).toBe(RECIPIENT);
    expect(headers["from"]).toBe(SENDER);
    expect(headers["subject"]).toBe(PAYLOAD.subject);
    expect(headers["x-meridian-report-id"]).toBe(PAYLOAD.reportId);
    expect(headers["content-type"]).toContain("text/plain");

    // The body is the report's own text, plus the three facts that must never be missing.
    expect(body).toContain(PAYLOAD.text);
    expect(body).toContain("Execution mode: automatic");
    expect(body).toContain(STRATEGY_LABEL);
    expect(body).toContain(MEASURED_LOSING_WARNING);
    // Plain text only: no HTML part, no markup pretending to be a report.
    expect(headers["content-type"]).not.toContain("html");
    expect(body).not.toContain("<html");

    await server.close();
  });

  test("is inert without its secrets: nothing connects, and the missing names are recorded", async () => {
    const server = await startFakeSmtp();
    const logs: string[] = [];
    const transport = createEmailTransport({
      env: {},
      host: "127.0.0.1",
      endpoints: [{ port: server.port, mode: "starttls" }],
      log: (line) => logs.push(line),
    });

    const result = await deliverReport(PAYLOAD, { transport, log: (line) => logs.push(line) });
    expect(result.configured).toBe(false);
    expect(result.delivered).toBe(false);
    for (const name of EMAIL_ENV_VARS) expect(result.detail).toContain(name);
    expect(result.detail).toContain("nothing was sent");
    expect(server.connections()).toBe(0);

    // A half-configured mailbox names ONLY what is missing, and never the value it has.
    const partial = createEmailTransport({
      env: { MERIDIAN_SMTP_USER: SENDER },
      host: "127.0.0.1",
      endpoints: [{ port: server.port, mode: "starttls" }],
      log: () => {},
    });
    const second = await deliverReport(PAYLOAD, { transport: partial, log: () => {} });
    expect(second.configured).toBe(false);
    expect(second.detail).toContain("MERIDIAN_SMTP_PASS");
    expect(second.detail).toContain("MERIDIAN_ALERT_TO");
    expect(second.detail).not.toContain("MERIDIAN_SMTP_USER");
    expect(second.detail).not.toContain(SENDER);
    expect(server.connections()).toBe(0);

    // And the environment reader agrees: an empty value is a missing value.
    expect(readEmailEnv({ MERIDIAN_SMTP_USER: SENDER, MERIDIAN_SMTP_PASS: "   ", MERIDIAN_ALERT_TO: RECIPIENT }).missing).toEqual([
      "MERIDIAN_SMTP_PASS",
    ]);

    await server.close();
  });

  test("a 535 auth refusal is final: one attempt, no retry, and the password never appears", async () => {
    const server = await startFakeSmtp({ auth: "REJECT", echoCredentials: true });
    const logs: string[] = [];
    const transport = transportFor(server, { maxRetries: 2, backoffMs: [1, 1], log: (line: string) => logs.push(line) });

    const result = await transport.send(PAYLOAD);

    expect(result.delivered).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.stage).toBe("AUTH");
    expect(result.smtpCode).toBe(535);
    expect(result.attempts.length).toBe(1);
    expect(server.connections()).toBe(1);

    // The server echoed the username back; the detail says so without inventing anything.
    expect(result.detail).toContain(SENDER);
    expect(result.detail).toContain("535");

    const serialized = JSON.stringify(result) + "\n" + logs.join("\n");
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(PASSWORD_B64);
    expect(serialized).toContain("[REDACTED]");

    await server.close();
  });

  test("a 451 at the DATA terminator is retried once and then delivered, both attempts recorded", async () => {
    const server = await startFakeSmtp({ dataRejects: 1 });
    const logs: string[] = [];
    const transport = transportFor(server, { maxRetries: 2, backoffMs: [1, 1], log: (line: string) => logs.push(line) });

    const result = await transport.send(PAYLOAD);

    expect(result.delivered).toBe(true);
    expect(result.smtpCode).toBe(250);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].smtpCode).toBe(451);
    expect(result.attempts[0].stage).toBe("DATA");
    expect(result.attempts[1].ok).toBe(true);
    expect(server.messages().length).toBe(2);
    // One line per attempt, so a flapping mailbox is visible rather than silently retried.
    expect(logs.filter((line) => line.startsWith("email attempt")).length).toBe(2);

    await server.close();
  });

  test("a refused connection is a recorded failure, not a crash and not a delivery", async () => {
    const port = await closedPort();
    const result = await sendEmail(PAYLOAD, {
      env: FULL_ENV,
      host: "127.0.0.1",
      endpoints: [{ port, mode: "starttls" }],
      maxRetries: 2,
      backoffMs: [1, 1],
      timeoutMs: 2000,
      log: () => {},
    });

    expect(result.configured).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.attempts.length).toBe(3);
    expect(result.attempts.every((attempt: EmailAttempt) => attempt.ok === false)).toBe(true);
    expect(result.attempts[0].smtpCode).toBeNull();
    expect(result.attempts[0].stage).toBe("CONNECT");
    expect(result.detail).toContain("Nothing was delivered");
    expect(result.messageId).toBeNull();
  });

  test("the password stays out of every string even when the server echoes the AUTH token back", async () => {
    // PLAIN only, so the client sends user and password in one base64 token; a chatty server
    // quotes that token back in its 535.
    const server = await startFakeSmtp({ auth: "REJECT", advertise: "PLAIN", echoCredentials: true });
    const logs: string[] = [];
    const transport = transportFor(server, { maxRetries: 2, backoffMs: [1, 1], log: (line: string) => logs.push(line) });

    const result = await transport.send(PAYLOAD);
    expect(result.delivered).toBe(false);
    expect(result.smtpCode).toBe(535);

    const plainToken = Buffer.from(`\0${SENDER}\0${PASSWORD}`, "utf8").toString("base64");
    const serialized = JSON.stringify(result) + "\n" + logs.join("\n");
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(PASSWORD_B64);
    expect(serialized).not.toContain(plainToken);

    // scrubSecrets is the single place that guarantees it, and it covers both forms.
    expect(scrubSecrets(`x ${PASSWORD} y ${PASSWORD_B64} z`, [PASSWORD])).toBe("x [REDACTED] y [REDACTED] z");

    await server.close();
  });

  test("notify.ts registers email and reports it unconfigured, naming the three variables", () => {
    const saved = { ...process.env };
    delete process.env.MERIDIAN_SMTP_USER;
    delete process.env.MERIDIAN_SMTP_PASS;
    delete process.env.MERIDIAN_ALERT_TO;
    try {
      const resolved = resolveTransport("email");
      expect(resolved.transport.id).toBe("email");
      expect(resolved.problem).toBeNull();
      expect(resolved.transport.configured()).toBe(false);
      expect(resolved.transport.describe()).toContain("MERIDIAN_ALERT_TO");
      expect(resolved.transport.describe()).toContain("smtp.gmail.com");
      expect(resolved.transport.describe()).toContain("587 STARTTLS");
      const detail = resolved.transport.unconfiguredDetail?.() ?? "";
      for (const name of EMAIL_ENV_VARS) expect(detail).toContain(name);
      // The generic sentence belongs to "none", not to a channel that knows what it needs.
      expect(detail).not.toContain("no notification channel configured");
    } finally {
      process.env = saved;
    }
  });

  test("the subject leads with what happened and when, and a quiet window still sends a message", () => {
    const counts = {
      orderRequests: 0,
      brokerConfirmedFills: 0,
      partialFills: 0,
      closes: 0,
      closesBrokerConfirmed: 0,
      refusals: 0,
      errors: 0,
      duplicateSuppressions: 0,
      cancellations: 0,
    };
    const base = { reportId: "rpt-1", generatedAt: "2026-11-04T20:41:00.000Z", status: "OK" } as any;

    expect(reportSubject({ ...base, counts: { ...counts, brokerConfirmedFills: 2, refusals: 1 } })).toBe(
      "Meridian: 2 fills, 1 refusal — 2026-11-04 20:41 UTC",
    );
    // A quiet period is still a message, and it says so in the one line the owner sees.
    expect(reportSubject({ ...base, counts })).toBe("Meridian: nothing happened — 2026-11-04 20:41 UTC");
    // An order request is not a fill, and the subject does not call it one.
    expect(reportSubject({ ...base, counts: { ...counts, orderRequests: 3 } })).toBe(
      "Meridian: 3 order requests (not a fill) — 2026-11-04 20:41 UTC",
    );
  });
});
