import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApiError } from "../shared/errors.ts";
import { UpstreamUnreachable } from "./errors.ts";
import { ControlPlaneClient, controlPlaneHealthy } from "./pestilence.ts";

const ASSERTION = "test.assertion.value";

/** The client now carries a per-request credential, so every construction needs one. */
function client(baseUrl: string): ControlPlaneClient {
  return new ControlPlaneClient(baseUrl, ASSERTION);
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** Replaces global fetch for one test and records what was asked for. */
function stubFetch(t: TestContext, respond: () => Response): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: urlOf(input),
      method: init?.method ?? "GET",
      authorization: headerOf(init, "authorization"),
    });
    return Promise.resolve(respond());
  });
  return calls;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    return null;
  }
  return (headers as Record<string, string>)[name] ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const WORKSPACE = { id: "01ABC", slug: "golden-vole-6w4q", state: "RUNNING" };

/** Returns the rejection rather than throwing, so a test can assert on its type. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

test("every request carries the assertion", async (t) => {
  // The credential is minted per request by the auth middleware, so if the client ever
  // omitted it pestilence would answer 401 and the cause would look like a policy
  // problem rather than a missing header.
  const calls = stubFetch(t, () => json({ workspaces: [] }));
  await client("http://cp:8080").list();
  assert.equal(calls[0]?.authorization, `Bearer ${ASSERTION}`);
});

test("list unwraps the workspaces envelope", async (t) => {
  stubFetch(t, () => json({ workspaces: [WORKSPACE] }));
  const workspaces = await client("http://cp:8080").list();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]?.slug, "golden-vole-6w4q");
});

test("a trailing slash on the base URL does not double up", async (t) => {
  const calls = stubFetch(t, () => json({ workspaces: [] }));
  await client("http://cp:8080///").list();
  assert.deepEqual(calls.map((call) => call.url), ["http://cp:8080/api/workspaces"]);
});

test("remove and retry use the paths and methods the control plane expects", async (t) => {
  const calls = stubFetch(t, () => json(WORKSPACE));
  const cp = client("http://cp:8080");
  await cp.remove("01ABC");
  await cp.retry("01ABC");
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["DELETE http://cp:8080/api/workspaces/01ABC", "POST http://cp:8080/api/workspaces/01ABC/retry"],
  );
});

test("ids are escaped rather than pasted into the path", async (t) => {
  const calls = stubFetch(t, () => json(WORKSPACE));
  await client("http://cp:8080").get("a/../../etc");
  assert.equal(calls[0]?.url, "http://cp:8080/api/workspaces/a%2F..%2F..%2Fetc");
});

test("a control plane error keeps its status and code", async (t) => {
  stubFetch(t, () => json({ error: { code: "not_found", message: "no such workspace" } }, 404));
  const err = await caught(client("http://cp:8080").get("missing"));
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 404);
  assert.equal(err.code, "not_found");
  assert.equal(err.message, "no such workspace");
});

test("an unreachable control plane is distinct from a missing workspace", async (t) => {
  // The distinction the UI depends on: "there is no such workspace" and "I could not
  // ask" must not arrive as the same thing.
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("ECONNREFUSED")));
  const err = await caught(client("http://cp:8080").get("01ABC"));
  assert.ok(err instanceof UpstreamUnreachable);
  assert.ok(!(err instanceof ApiError));
});

test("a non-JSON error body is surfaced rather than replaced with 'unknown'", async (t) => {
  stubFetch(t, () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  const err = await caught(client("http://cp:8080").list());
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, "malformed_response");
  assert.match(err.message, /Bad Gateway/);
});

test("an empty body on a success status is a failure, not an empty result", async (t) => {
  stubFetch(t, () => new Response("", { status: 200 }));
  const err = await caught(client("http://cp:8080").list());
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, "malformed_response");
});

test("the health probe needs no credential and reports false rather than throwing", async (t) => {
  const calls = stubFetch(t, () => json({ status: "ok" }));
  assert.equal(await controlPlaneHealthy("http://cp:8080"), true);
  assert.equal(calls[0]?.url, "http://cp:8080/healthz");
  // No bearer token: pestilence's /healthz is unauthenticated, and readiness has no
  // user to mint one for.
  assert.equal(calls[0]?.authorization, null);
});

test("the health probe reports false when the control plane is down", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("ECONNREFUSED")));
  assert.equal(await controlPlaneHealthy("http://cp:8080"), false);
});
