import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { COOKIE_SESSION, COOKIE_STATE, cookieName } from "./cookies.ts";
import { fakeGitHub, sessionCookie, TEST_CONFIG, TEST_ORG, TEST_ORIGIN, TEST_PUBLIC_URL, TEST_USER, testDeps } from "./test-support.ts";

// The REAL names, `__Host-` and all. TEST_PUBLIC_URL is https, so the prefix applies --
// hardcoding the bare names here would let the tests pass while disagreeing with the
// server about which cookie to read.
const STATE_COOKIE = cookieName(COOKIE_STATE, true);
const SESSION_COOKIE = cookieName(COOKIE_SESSION, true);

/** Set-Cookie headers, as a list. `get` would comma-join them and lose the boundaries. */
function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieNamed(response: Response, name: string): string | undefined {
  return cookiesOf(response).find((cookie) => cookie.startsWith(`${name}=`));
}

test("login sends the browser to GitHub, and plants a nonce to check on the way back", async () => {
  const app = createApp(await testDeps());
  const response = await app.request("/auth/login");

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, TEST_ORIGIN);
  assert.equal(location.searchParams.get("redirect_uri"), `${TEST_PUBLIC_URL}/auth/callback`);

  // The exact authorize URL -- scope, allow_signup and all -- is asserted against the
  // real GitHub client in github.test.ts, where it is built. This asserts only that the
  // browser is sent there carrying a nonce, and that the nonce is also in a cookie.
  const state = location.searchParams.get("state") ?? "";
  assert.ok(state.length >= 20, "the state must be unguessable");
  assert.ok(cookieNamed(response, STATE_COOKIE)?.includes(state));
});

test("a callback with no nonce cookie is refused", async () => {
  const app = createApp(await testDeps());
  const response = await app.request("/auth/callback?code=abc&state=whatever");
  assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?auth_error=state_mismatch`);
  assert.equal(cookieNamed(response, SESSION_COOKIE), undefined);
});

test("a callback whose state does not match the cookie is refused", async () => {
  const app = createApp(await testDeps());
  const response = await app.request("/auth/callback?code=abc&state=from-the-attacker", {
    headers: { cookie: `${STATE_COOKIE}=the-real-one` },
  });
  assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?auth_error=state_mismatch`);
});

test("a member of the org is signed in", async () => {
  const deps = await testDeps({ github: fakeGitHub({ membership: "active" }) });
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), TEST_PUBLIC_URL);

  const session = cookieNamed(response, SESSION_COOKIE) ?? "";
  assert.ok(session.startsWith(`${SESSION_COOKIE}=`));

  // The session must not carry the GitHub access token. It is used once, to learn who
  // this is, and then dropped -- nothing downstream can leak what it never had.
  assert.ok(!session.includes("gho_"), "the GitHub access token must not be in the cookie");
});

test("the session cookie is httpOnly, Secure and SameSite=Lax", async () => {
  const deps = await testDeps();
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  const session = cookieNamed(response, SESSION_COOKIE) ?? "";
  assert.match(session, /HttpOnly/i);
  assert.match(session, /Secure/i);
  // Lax, not Strict: the callback arrives as a top-level navigation from github.com, and
  // Strict would withhold this cookie on exactly that request.
  assert.match(session, /SameSite=Lax/i);
});

test("someone outside the org is refused, with no session", async () => {
  const deps = await testDeps({ github: fakeGitHub({ membership: "none" }) });
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?auth_error=not_a_member`);
  assert.equal(cookieNamed(response, SESSION_COOKIE), undefined);
});

test("an unaccepted invitation is NOT membership", async () => {
  // The distinction that matters: invited is not joined. Folding `pending` into either
  // `active` or `none` would admit someone who has not accepted.
  const deps = await testDeps({ github: fakeGitHub({ membership: "pending" }) });
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?auth_error=pending_invitation`);
  assert.equal(cookieNamed(response, SESSION_COOKIE), undefined);
});

test("GitHub being unreachable is a readable failure, not a 500", async () => {
  const deps = await testDeps({ github: fakeGitHub({ fail: "unreachable" }) });
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?auth_error=github_unavailable`);
});

test("the exchange is given the code, and the code is used only once", async () => {
  const github = fakeGitHub();
  const deps = await testDeps({ github });
  await createApp(deps).request("/auth/callback?code=the-code&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  assert.deepEqual(github.exchanged, ["the-code"]);
});

test("the owner id is the immutable numeric id, not the login", async () => {
  // Renaming a GitHub account frees the old login for anyone to claim. Keying workspaces
  // on it would mean a rename loses your workspaces, and whoever takes the freed name
  // inherits them. See shared/identity.ts.
  const deps = await testDeps({ github: fakeGitHub({ user: { id: 583231, login: "renameable", name: null } }) });
  const response = await createApp(deps).request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });

  const token = (cookieNamed(response, SESSION_COOKIE) ?? "").split(";")[0]?.split("=")[1] ?? "";
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { sub: string };
  assert.equal(payload.sub, `github#${TEST_USER.id}`);
  assert.ok(!payload.sub.includes("renameable"));
});

test("me returns the signed-in identity", async () => {
  const deps = await testDeps();
  const response = await createApp(deps).request("/api/me", { headers: { cookie: await sessionCookie(deps) } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: { ownerId: string } };
  assert.equal(body.user.ownerId, "github#583231");
});

test("me refuses an anonymous caller", async () => {
  const response = await createApp(await testDeps()).request("/api/me");
  assert.equal(response.status, 401);
});

test("logout clears the session cookie", async () => {
  const app = createApp(await testDeps());
  const response = await app.request("/auth/logout", { method: "POST" });
  assert.equal(response.status, 200);
  const cleared = cookieNamed(response, SESSION_COOKIE) ?? "";
  // An expired, empty cookie is how a browser is told to drop it.
  assert.match(cleared, /town_session=;/);
});

test("the configured org is what membership is checked against", async () => {
  // Guards the seam between config and the check: a typo in GITHUB_ORG would otherwise
  // fail closed but silently, and look identical to "nobody is a member".
  let seenOrg = "";
  const github = fakeGitHub();
  const app = createApp(
    await testDeps({
      github: { ...github, orgMembership: (_token, org) => { seenOrg = org; return Promise.resolve("active"); } },
    }),
  );
  await app.request("/auth/callback?code=abc&state=s1", { headers: { cookie: `${STATE_COOKIE}=s1` } });
  assert.equal(seenOrg, TEST_ORG);
  assert.equal(TEST_CONFIG.github.org, TEST_ORG);
});

test("a programming error is not swallowed into a readable code", async () => {
  // Only upstream failures become `auth_error` codes. If a plain bug were also folded
  // into one, a real defect would be indistinguishable from GitHub being down.
  const deps = await testDeps();
  const app = createApp({
    ...deps,
    github: { ...fakeGitHub(), exchangeCode: () => Promise.reject(new Error("a bug")) },
  });
  const response = await app.request("/auth/callback?code=abc&state=s1", {
    headers: { cookie: `${STATE_COOKIE}=s1` },
  });
  assert.equal(response.status, 500);
});
