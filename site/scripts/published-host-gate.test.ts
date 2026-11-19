import { afterEach, describe, expect, test } from "bun:test";
import { isNotFound } from "@tanstack/react-router";

import { isPublishedHost, setPublishedHostForTest } from "../src/lib/hostRole.ts";
import { Route as ApiExecutionRoute } from "../src/routes/api/execution.ts";
import { Route as ExecutionPageRoute } from "../src/routes/execution.tsx";

/**
 * The public port serves no execution surface (owner decision 2026-11-01;
 * execution/UNLISTED_REQUIREMENT.md). These tests stand in for the published build
 * and for the working host without needing a production build, and they touch no live
 * state: every request here stops at the gate or at the operator-key check.
 */

type ServerHandlers = { POST: (ctx: { request: Request }) => Promise<Response> | Response };
type PageOptions = { beforeLoad?: (ctx: unknown) => unknown };

const apiHandlers = (ApiExecutionRoute as unknown as { options: { server: { handlers: ServerHandlers } } }).options
  .server.handlers;
const pageOptions = (ExecutionPageRoute as unknown as { options: PageOptions }).options;

const postExecution = async (action = "status"): Promise<Response> =>
  apiHandlers.POST({
    request: new Request("https://example.invalid/api/execution", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-key" },
      body: JSON.stringify({ action }),
    }),
  });

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

afterEach(() => {
  setPublishedHostForTest(null);
  globalThis.fetch = realFetch;
  fetchCalls = [];
});

/** Fails the test if anything in the route tries to reach another host. */
const forbidOutboundFetch = (): void => {
  globalThis.fetch = ((input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error(`outbound fetch attempted: ${String(input)}`);
  }) as typeof fetch;
};

describe("published build", () => {
  test("POST /api/execution answers 404 and relays nothing", async () => {
    setPublishedHostForTest(true);
    forbidOutboundFetch();
    const response = await postExecution();
    expect(response.status).toBe(404);
    expect(fetchCalls).toEqual([]);
  });

  test("the 404 discloses no mode, no account state and no backend address", async () => {
    setPublishedHostForTest(true);
    const text = await (await postExecution()).text();
    expect(text).not.toContain("status");
    expect(text).not.toContain("nav");
    expect(text).not.toContain("backend");
    expect(text).not.toContain("cto.site");
  });

  test("/execution is not a page here", () => {
    setPublishedHostForTest(true);
    expect(pageOptions.beforeLoad).toBeFunction();
    let thrown: unknown = null;
    try {
      pageOptions.beforeLoad?.({});
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown)).toBe(true);
  });
});

describe("working host", () => {
  test("the gate is open", () => {
    setPublishedHostForTest(false);
    expect(isPublishedHost()).toBe(false);
    expect(pageOptions.beforeLoad?.({})).toBeUndefined();
  });

  test("the execution API still answers its own way — 401 without the operator key, never 404", async () => {
    setPublishedHostForTest(false);
    forbidOutboundFetch();
    const response = await postExecution();
    expect(response.status).toBe(401);
    expect(fetchCalls).toEqual([]);
  });
});

describe("the build decides, not the environment", () => {
  test("no runtime variable can turn the published host back on", async () => {
    const previous = process.env.MERIDIAN_EXECUTION_BACKEND_URL;
    process.env.MERIDIAN_EXECUTION_BACKEND_URL = "https://f18acd832760c783c8b1cf1b27811368-dev.cto.site";
    try {
      setPublishedHostForTest(true);
      forbidOutboundFetch();
      const response = await postExecution();
      expect(response.status).toBe(404);
      expect(fetchCalls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_EXECUTION_BACKEND_URL;
      else process.env.MERIDIAN_EXECUTION_BACKEND_URL = previous;
    }
  });
});
