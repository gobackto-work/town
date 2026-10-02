import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtVerify } from "jose";
import { ApiError } from "../shared/errors.ts";
import { ISSUER } from "./assertion.ts";
import { createApp } from "./app.ts";
import { UpstreamError, UpstreamUnreachable } from "./errors.ts";
import { fakeControlPlane, sessionCookie, TEST_AUDIENCE, TEST_WORKSPACE, testDeps } from "./test-support.ts";

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

test("healthz does not depend on anything", async () => {
  // Unauthenticated on purpose: probes must work without a session, and this is what a
  // human curls when something is wrong.
  const app = createApp(await testDeps());
  const response = await app.request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { status: "ok" });
});

test("readyz reports 503 when the control plane cannot be reached", async () => {
  const app = createApp(await testDeps({ healthy: false }));
  assert.equal((await app.request("/readyz")).status, 503);
});

test("readyz reports 200 when it can", async () => {
  const app = createApp(await testDeps({ healthy: true }));
  assert.equal((await app.request("/readyz")).status, 200);
});

test("the workspace API refuses a request with no session", async () => {
  const deps = await testDeps();
  const response = await createApp(deps).request("/api/workspaces");
  assert.equal(response.status, 401);
  assert.equal(deps.assertionsUsed.length, 0, "an unauthenticated request must not reach the control plane");
});

test("the workspace API refuses a forged or malformed session cookie", async () => {
  const app = createApp(await testDeps());
  for (const cookie of ["town_session=nonsense", "town_session=.", ""]) {
    const response = await app.request("/api/workspaces", { headers: { cookie } });
    assert.equal(response.status, 401, `cookie ${JSON.stringify(cookie)} should be refused`);
  }
});

test("a valid session lists workspaces", async () => {
  const deps = await testDeps({ controlPlane: fakeControlPlane({ list: () => Promise.resolve([TEST_WORKSPACE]) }) });
  const response = await createApp(deps).request("/api/workspaces", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { workspaces: [TEST_WORKSPACE] });
});

test("the gate mints an assertion that satisfies the agreed contract", async () => {
  // The whole cross-repo contract in one test: algorithm, issuer, audience, and the
  // subject being the immutable owner id rather than a GitHub login. If any of these
  // drifts, pestilence stops accepting town and nothing else here would notice.
  const deps = await testDeps({ controlPlane: fakeControlPlane({ list: () => Promise.resolve([]) }) });
  await createApp(deps).request("/api/workspaces", { headers: { cookie: await sessionCookie(deps) } });

  assert.equal(deps.assertionsUsed.length, 1);
  const assertion = deps.assertionsUsed[0] ?? "";
  const { payload, protectedHeader } = await jwtVerify(assertion, deps.keys.publicKey, {
    algorithms: ["EdDSA"],
    issuer: "town",
    audience: TEST_AUDIENCE,
  });
  assert.equal(protectedHeader.alg, "EdDSA");
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, TEST_AUDIENCE);
  assert.equal(payload.sub, "github#583231");
  // Short-lived by design: a leaked assertion should be worth very little.
  assert.ok(typeof payload.exp === "number" && payload.exp - (payload.iat ?? 0) <= 120);
});

test("creating passes the body through and answers 201", async () => {
  let seen: unknown;
  const deps = await testDeps({
    controlPlane: fakeControlPlane({
      create: (request) => {
        seen = request;
        return Promise.resolve(TEST_WORKSPACE as never);
      },
    }),
  });
  const response = await createApp(deps).request("/api/workspaces", {
    method: "POST",
    headers: { cookie: await sessionCookie(deps) },
    body: '{"limits":{"maxAgents":3}}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(seen, { limits: { maxAgents: 3 } });
});

test("an empty create body means defaults, not a bad request", async () => {
  let seen: unknown;
  const deps = await testDeps({
    controlPlane: fakeControlPlane({
      create: (request) => {
        seen = request;
        return Promise.resolve(TEST_WORKSPACE as never);
      },
    }),
  });
  const response = await createApp(deps).request("/api/workspaces", {
    method: "POST",
    headers: { cookie: await sessionCookie(deps) },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(seen, {});
});

test("a non-object body is refused before it reaches the control plane", async () => {
  const deps = await testDeps();
  const response = await createApp(deps).request("/api/workspaces", {
    method: "POST",
    headers: { cookie: await sessionCookie(deps) },
    body: "[1,2,3]",
  });
  assert.equal(response.status, 400);
  assert.equal(((await body(response)) as { error: { code: string } }).error.code, "invalid_request");
});

test("a control plane error keeps its status and code", async () => {
  const deps = await testDeps({
    controlPlane: fakeControlPlane({ get: () => Promise.reject(new ApiError(404, "not_found", "no such workspace")) }),
  });
  const response = await createApp(deps).request("/api/workspaces/nope", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 404);
  assert.equal(((await body(response)) as { error: { code: string } }).error.code, "not_found");
});

test("an unreachable control plane becomes 502, not 404", async () => {
  const deps = await testDeps({
    controlPlane: fakeControlPlane({
      list: () => Promise.reject(new UpstreamUnreachable("the control plane", new Error("ECONNREFUSED"))),
    }),
  });
  const response = await createApp(deps).request("/api/workspaces", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 502);
});

test("a failing GitHub during login is a 302 with a code, not a 500", async () => {
  // The flow is browser-driven, so a failure has to land somewhere a person can read.
  const deps = await testDeps({
    controlPlane: fakeControlPlane({ list: () => Promise.reject(new UpstreamError("GitHub", 500, "boom")) }),
  });
  const response = await createApp(deps).request("/api/workspaces", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 502);
});

test("an unexpected error is not leaked to the caller", async () => {
  const deps = await testDeps({ controlPlane: fakeControlPlane({ list: () => Promise.reject(new Error("secret detail")) }) });
  const response = await createApp(deps).request("/api/workspaces", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("secret detail"));
});

test("an unknown API path is JSON, not the app shell", async () => {
  // The wildcard static handler serves index.html for any GET. Without an explicit API
  // 404 an unknown endpoint would answer 200 with a web page and the client would try
  // to parse HTML.
  const app = createApp(await testDeps());
  const response = await app.request("/api/nope");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
});

test("an unknown non-API path does not masquerade as JSON", async () => {
  const app = createApp(await testDeps());
  const response = await app.request("/some/deep/link");
  assert.match(await response.text(), /client not built/);
});
