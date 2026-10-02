import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtVerify } from "jose";
import { ApiError } from "../shared/errors.ts";
import { createApp } from "./app.ts";
import { HEADER_ASSERTION, HEADER_USER, HANDOFF_PARAM } from "./edge.ts";
import { cookieName, COOKIE_EDGE } from "./cookies.ts";
import { fakeControlPlane, sessionCookie, TEST_PUBLIC_URL, TEST_USER, testDeps } from "./test-support.ts";

const HOST = "golden-vole-6w4q.gobackto.work";
/** TEST_PUBLIC_URL is https, so every cookie is `__Host-` prefixed. */
const EDGE_COOKIE = cookieName(COOKIE_EDGE, true);

function authzHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "x-forwarded-host": HOST, ...extra };
}

function setCookieNamed(response: Response, name: string): string | undefined {
	return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

async function openAs(deps: Awaited<ReturnType<typeof testDeps>>, query: string): Promise<Response> {
	return createApp(deps).request(`/workspaces/open?${query}`, { headers: { cookie: await sessionCookie(deps) } });
}

// ---------------------------------------------------------------------------
// /authz — the gate Traefik calls
// ---------------------------------------------------------------------------

test("an unidentified browser is sent to town, where the session lives", async () => {
	// The whole reason the edge has its own credential: town's session cookie is
	// host-only, so it is simply absent on a workspace subdomain.
	const response = await createApp(await testDeps()).request("/authz", { headers: authzHeaders() });

	assert.equal(response.status, 302);
	const location = new URL(response.headers.get("location") ?? "");
	assert.equal(location.origin, TEST_PUBLIC_URL);
	assert.equal(location.pathname, "/workspaces/open");
	assert.equal(location.searchParams.get("host"), HOST);
	// A path, never an absolute URL: `next` is attacker-influenced.
	assert.equal(location.searchParams.get("next"), "/");
});

test("a valid edge cookie is admitted, and told who it is talking to", async () => {
	const deps = await testDeps();
	const token = await deps.edge.issue(TEST_USER.id ? `github#${TEST_USER.id}` : "", HOST);

	const response = await createApp(deps).request("/authz", {
		headers: authzHeaders({ cookie: `${EDGE_COOKIE}=${token}` }),
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get(HEADER_USER), "github#583231");
});

test("the assertion handed to the bridge satisfies scarab's contract", async () => {
	// This is the cross-repo value: issuer, algorithm, subject, and `aud` bound to the
	// HOSTNAME so a token minted for one workspace cannot be replayed at another's.
	const deps = await testDeps();
	const token = await deps.edge.issue("github#583231", HOST);
	const response = await createApp(deps).request("/authz", {
		headers: authzHeaders({ cookie: `${EDGE_COOKIE}=${token}` }),
	});

	const assertion = response.headers.get(HEADER_ASSERTION) ?? "";
	const { payload, protectedHeader } = await jwtVerify(assertion, deps.keys.publicKey, {
		algorithms: ["EdDSA"],
		issuer: "town",
		audience: HOST,
	});
	assert.equal(protectedHeader.alg, "EdDSA");
	assert.equal(payload.sub, "github#583231");
	assert.equal(payload.aud, HOST);
});

test("a cookie minted for one workspace is refused at another", async () => {
	// The `aud` binding, which is the reason the edge grant carries a hostname at all.
	const deps = await testDeps();
	const token = await deps.edge.issue("github#583231", "some-other-workspace.gobackto.work");

	const response = await createApp(deps).request("/authz", {
		headers: authzHeaders({ cookie: `${EDGE_COOKIE}=${token}` }),
	});

	// Not admitted -- back through the bootstrap instead.
	assert.equal(response.status, 302);
	assert.match(response.headers.get("location") ?? "", /\/workspaces\/open/);
});

test("a handoff is exchanged for a host-scoped cookie and stripped from the URL", async () => {
	const deps = await testDeps();
	const handoff = await deps.edge.issue("github#583231", HOST, deps.edge.handoffTtl());

	// The original URI travels in `X-Forwarded-Uri`. Note the handoff is NOT on the URL
	// town was called with: Traefik calls `/authz` verbatim, so a handoff read from
	// `c.req.query` would never be found and every request would loop.
	const uri = `/?${HANDOFF_PARAM}=${encodeURIComponent(handoff)}&keep=1`;
	const response = await createApp(deps).request("/authz", {
		headers: authzHeaders({ "x-forwarded-uri": uri }),
	});

	assert.equal(response.status, 302);
	// Absolute and on the WORKSPACE's hostname. A relative path would be resolved against
	// the auth address -- an internal Service name the browser cannot reach -- so this
	// asserts the whole URL, not just its path.
	const location = response.headers.get("location") ?? "";
	assert.ok(
		location.startsWith(`https://${HOST}/`),
		`the redirect should return to the workspace, got ${location}`,
	);
	assert.ok(!location.includes(HANDOFF_PARAM), `location still carries the handoff: ${location}`);
	assert.ok(location.includes("keep=1"), `unrelated query parameters should survive, got ${location}`);

	const cookie = setCookieNamed(response, EDGE_COOKIE) ?? "";
	// `__Host-` is enforced by the browser as host-only, Secure and Path=/, which is what
	// makes it impossible for a tenant to shadow with a parent-domain cookie.
	assert.ok(cookie.startsWith(`${EDGE_COOKIE}=`), `expected a ${EDGE_COOKIE} cookie, got ${cookie}`);
	assert.match(cookie, /HttpOnly/i);
	assert.match(cookie, /Secure/i);
	assert.match(cookie, /SameSite=Lax/i);
	assert.ok(!/Domain=/i.test(cookie), "a Domain attribute would defeat the __Host- prefix");
});

test("a forged handoff is refused", async () => {
	for (const forged of ["", "not.a.token", "a.b.c"]) {
		const response = await createApp(await testDeps()).request("/authz", {
			headers: authzHeaders({ "x-forwarded-uri": `/?${HANDOFF_PARAM}=${encodeURIComponent(forged)}` }),
		});
		assert.equal(response.status, 302);
		assert.match(response.headers.get("location") ?? "", /\/workspaces\/open/);
	}
});

test("a handoff for a different workspace is refused", async () => {
	// Otherwise a grant for a workspace the user does own would open one they do not.
	const deps = await testDeps();
	const handoff = await deps.edge.issue("github#583231", "someone-elses.gobackto.work", 120);
	const response = await createApp(deps).request("/authz", {
		headers: authzHeaders({ "x-forwarded-uri": `/?${HANDOFF_PARAM}=${handoff}` }),
	});
	assert.match(response.headers.get("location") ?? "", /\/workspaces\/open/);
});

test("the gate answers whatever method the browser used", async () => {
	// Traefik's ForwardAuth forwards the ORIGINAL method, so a POST to a workspace
	// arrives as a POST. A route registered only for GET would 405 and lock out writes.
	const deps = await testDeps();
	const token = await deps.edge.issue("github#583231", HOST);
	const response = await createApp(deps).request("/authz", {
		method: "POST",
		headers: authzHeaders({ cookie: `${EDGE_COOKIE}=${token}` }),
	});
	assert.equal(response.status, 200);
});

test("a request with no host at all is refused", async () => {
	const response = await createApp(await testDeps()).request("/authz");
	assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// /workspaces/open — the bootstrap, on town's own hostname
// ---------------------------------------------------------------------------

test("the bootstrap refuses an anonymous caller", async () => {
	const response = await createApp(await testDeps()).request(`/workspaces/open?host=${HOST}`);
	assert.equal(response.status, 401);
});

test("the bootstrap asks pestilence, and hands back a grant for that hostname", async () => {
	let asked = "";
	const deps = await testDeps({
		controlPlane: fakeControlPlane({
			authorize: (hostname) => {
				asked = hostname;
				return Promise.resolve({ user: "github#583231", slug: "golden-vole-6w4q", namespace: "ws-golden-vole-6w4q" });
			},
		}),
	});

	const response = await openAs(deps, `host=${HOST}`);

	// The ownership rule lives in pestilence; town asks rather than re-implementing it.
	assert.equal(asked, HOST);
	assert.equal(response.status, 302);
	const location = new URL(response.headers.get("location") ?? "");
	assert.equal(location.origin, `https://${HOST}`);
	assert.ok(location.searchParams.get(HANDOFF_PARAM) !== null, "the handoff should ride in the query");
	// Verified with the edge key, and bound to this host.
	const granted = await deps.edge.verify(location.searchParams.get(HANDOFF_PARAM) ?? "", HOST);
	assert.equal(granted, "github#583231");
});

test("a workspace the caller does not own is reported as forbidden", async () => {
	const deps = await testDeps({
		controlPlane: fakeControlPlane({ authorize: () => Promise.reject(new ApiError(403, "forbidden", "not yours")) }),
	});
	const response = await openAs(deps, `host=${HOST}`);
	assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?edge_error=forbidden`);
});

test("a workspace that is not serving is reported as such", async () => {
	const deps = await testDeps({
		controlPlane: fakeControlPlane({ authorize: () => Promise.reject(new ApiError(404, "not_found", "not running")) }),
	});
	const response = await openAs(deps, `host=${HOST}`);
	assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?edge_error=not_found`);
});

test("a missing hostname is reported as malformed rather than guessed at", async () => {
	const response = await openAs(await testDeps(), "");
	assert.equal(response.headers.get("location"), `${TEST_PUBLIC_URL}/?edge_error=malformed`);
});

test("next cannot be turned into an open redirect", async () => {
	// `next` arrives from the URL bar, so an absolute URL here would let a crafted link
	// bounce a signed-in user to an attacker's site with town's blessing.
	const deps = await testDeps({
		controlPlane: fakeControlPlane({
			authorize: () => Promise.resolve({ user: "github#1", slug: "s", namespace: "ws-s" }),
		}),
	});
	for (const hostile of ["https://evil.test/", "//evil.test/", "http://evil.test"]) {
		const response = await openAs(deps, `host=${HOST}&next=${encodeURIComponent(hostile)}`);
		const location = response.headers.get("location") ?? "";
		assert.ok(location.startsWith(`https://${HOST}/`), `escaped to ${location}`);
	}
});
