import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { UpstreamError, UpstreamUnreachable } from "./errors.ts";
import { GitHub, REQUIRED_SCOPE } from "./github.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stubFetch(t: TestContext, respond: () => Response): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function github(): GitHub {
  return new GitHub({ clientId: "cid", clientSecret: "shh" });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

test("the authorize URL requests exactly read:org, and no signup", () => {
  const url = new URL(github().authorizeUrl("https://town.test/auth/callback", "the-state"));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://town.test/auth/callback");
  // The whole of the access control rests on this scope being what is asked for.
  assert.equal(url.searchParams.get("scope"), REQUIRED_SCOPE);
  assert.equal(url.searchParams.get("state"), "the-state");
  // The org is invitation-based, so a newly created account could not be a member and
  // offering signup only invites confusion.
  assert.equal(url.searchParams.get("allow_signup"), "false");
});

test("the code exchange sends the code and the callback it was issued for", async (t) => {
  const calls = stubFetch(t, () => json({ access_token: "gho_x", token_type: "bearer" }));
  const token = await github().exchangeCode("the-code", "https://town.test/auth/callback");

  assert.equal(token, "gho_x");
  assert.equal(calls[0]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(calls[0]?.method, "POST");
  const sent = JSON.parse(calls[0]?.body ?? "{}") as Record<string, string>;
  assert.equal(sent.code, "the-code");
  assert.equal(sent.client_id, "cid");
  assert.equal(sent.client_secret, "shh");
  assert.equal(sent.redirect_uri, "https://town.test/auth/callback");
});

test("an error body with a 200 is a failure, because GitHub answers 200 for bad codes", async (t) => {
  // The quirk that makes `response.ok` the wrong check here. Getting this wrong would
  // mean a rejected code produced an empty token and the failure surfaced later,
  // somewhere with less context.
  stubFetch(t, () => json({ error: "bad_verification_code", error_description: "The code passed is incorrect" }));
  const err = await caught(github().exchangeCode("stale", "https://town.test/auth/callback"));
  assert.ok(err instanceof UpstreamError);
  assert.match(err.message, /bad_verification_code/);
});

test("a network failure is unreachable, not an upstream error", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("ENOTFOUND")));
  const err = await caught(github().user("gho_x"));
  assert.ok(err instanceof UpstreamUnreachable);
  assert.ok(!(err instanceof UpstreamError));
});

test("the user call carries the token and a user agent", async (t) => {
  const calls = stubFetch(t, () => json({ id: 583231, login: "octocat", name: "The Octocat" }));
  const user = await github().user("gho_x");

  assert.deepEqual(user, { id: 583231, login: "octocat", name: "The Octocat" });
  assert.equal(calls[0]?.url, "https://api.github.com/user");
  assert.equal(calls[0]?.headers["authorization"], "Bearer gho_x");
  // GitHub rejects API requests without one.
  assert.equal(calls[0]?.headers["user-agent"], "town");
});

test("a user response without an id is an upstream error, not a silent zero", async (t) => {
  // `id: 0` would become ownerId `github#0`, and every such user would share an owner.
  stubFetch(t, () => json({ login: "octocat" }));
  const err = await caught(github().user("gho_x"));
  assert.ok(err instanceof UpstreamError);
});

test("a missing name becomes null rather than undefined", async (t) => {
  stubFetch(t, () => json({ id: 1, login: "octocat" }));
  assert.equal((await github().user("gho_x")).name, null);
});

test("membership maps active, pending and not-a-member distinctly", async (t) => {
  const cases: Array<[Response, string]> = [
    [json({ state: "active", role: "member" }), "active"],
    [json({ state: "pending", role: "member" }), "pending"],
    [new Response("{}", { status: 404 }), "none"],
  ];
  for (const [response, expected] of cases) {
    stubFetch(t, () => response);
    assert.equal(await github().orgMembership("gho_x", "gobackto-work", "octocat"), expected);
  }
});

test("the membership URL escapes the org and the login", async (t) => {
  const calls = stubFetch(t, () => json({ state: "active" }));
  await github().orgMembership("gho_x", "my org", "a/b");
  assert.equal(calls[0]?.url, "https://api.github.com/orgs/my%20org/memberships/a%2Fb");
});

test("an unrecognised membership state is an error, not a pass", async (t) => {
  // Fail closed: a state we do not understand must never be treated as membership.
  stubFetch(t, () => json({ state: "something_new" }));
  const err = await caught(github().orgMembership("gho_x", "gobackto-work", "octocat"));
  assert.ok(err instanceof UpstreamError);
});

test("a 500 from the API is an upstream error", async (t) => {
  stubFetch(t, () => new Response("server error", { status: 500 }));
  const err = await caught(github().orgMembership("gho_x", "gobackto-work", "octocat"));
  assert.ok(err instanceof UpstreamError);
  assert.equal(err.status, 500);
});
