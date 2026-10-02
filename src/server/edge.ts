// The workspace edge: who may reach a tenant's own endpoint.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY TOWN'S SESSION COOKIE CANNOT DO THIS
// ────────────────────────────────────────────────────────────────────────────
//
// The obvious design is for Traefik's ForwardAuth to send the original request to town,
// which reads `town_session` and answers. That cannot work: `town_session` is host-only
// for `town.gobackto.work`, so a browser requesting `<slug>.gobackto.work` never sends it,
// and Traefik would arrive at town with no cookie and no way to say who the user is.
//
// The obvious fix -- widening the session cookie to `Domain=.gobackto.work` -- is worse
// than it looks. Tenant workspaces are SIBLING subdomains serving tenant-controlled
// content, so widening the cookie hands every tenant a cookie they can shadow, and one
// tenant can then log out every other user. See cookies.ts.
//
// So the workspace edge gets its OWN credential, scoped to one hostname:
//
//   1. browser -> https://<slug>.gobackto.work/          (no edge cookie yet)
//   2. Traefik ForwardAuth -> town GET /authz            (no cookie, no handoff)
//   3. town redirects the BROWSER to its own hostname, where the session cookie IS sent
//   4. town /workspaces/open asks pestilence who owns that hostname, mints a 2-minute
//      grant with `aud` = the hostname, and redirects back to the workspace with it
//   5. Traefik ForwardAuth -> town GET /authz            (handoff present)
//   6. town verifies it, sets a HOST-SCOPED cookie on the workspace's own domain, and
//      redirects to the same URL with the handoff stripped
//   7. browser -> the workspace again, now carrying that cookie
//   8. Traefik ForwardAuth -> town GET /authz            (cookie present) -> 2xx
//
// Step 6 is what makes this work without a route on the workspace host: Traefik passes a
// 3xx from the auth server through to the browser **along with its Set-Cookie**, and a
// cookie with no Domain attribute is scoped by the browser to the host that was asked
// for. Verified live rather than assumed -- that behaviour is the whole design.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY TWO SIGNATURE SCHEMES
// ────────────────────────────────────────────────────────────────────────────
//
// The handoff and the edge cookie travel through the BROWSER, so town both mints and
// verifies them: symmetric signing (HS256, the session secret) is sufficient and simpler.
//
// The assertion handed to the bridge is different: a THIRD PARTY verifies it, and it
// never passes through the browser at all. That one is Ed25519 with the same key town
// already uses for pestilence, so scarab needs a public key and nothing else.

import { SignJWT, jwtVerify } from "jose";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ApiError } from "../shared/errors.ts";
import type { EdgeFailureCode } from "../shared/types.ts";
import { requireSession } from "./auth.ts";
import { COOKIE_EDGE, cookieName, overTLS } from "./cookies.ts";
import type { AppEnv, Deps } from "./deps.ts";

/** HS256: town mints and verifies these itself. */
const ALG = "HS256";

/** The query parameter carrying the handoff, and the header the bridge verifies. */
export const HANDOFF_PARAM = "__t";
export const HEADER_USER = "X-Auth-User";
export const HEADER_ASSERTION = "X-Scarab-Assertion";

/** How long the handoff is valid. It is in a URL, so it is deliberately brief. */
const HANDOFF_TTL_SECONDS = 120;

export class EdgeGrants {
	readonly #key: Uint8Array;
	readonly #cookieTtl: number;

	constructor(secret: string, cookieTtlSeconds: number) {
		this.#key = new TextEncoder().encode(secret);
		this.#cookieTtl = cookieTtlSeconds;
	}

	/**
	 * A grant for one owner on one hostname.
	 *
	 * `aud` is the hostname, so a grant minted for one workspace cannot be replayed
	 * against another -- the same reasoning as the broker's per-slug audience.
	 */
	async issue(ownerId: string, host: string, ttlSeconds: number = this.#cookieTtl): Promise<string> {
		return new SignJWT({})
			.setProtectedHeader({ alg: ALG })
			.setSubject(ownerId)
			.setAudience(host)
			.setIssuedAt()
			.setExpirationTime(`${ttlSeconds}s`)
			.sign(this.#key);
	}

	/** The owner id, or null. The audience check IS the host binding. */
	async verify(token: string, host: string): Promise<string | null> {
		try {
			const { payload } = await jwtVerify(token, this.#key, { algorithms: [ALG], audience: host });
			return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
		} catch {
			return null;
		}
	}

	handoffTtl(): number {
		return HANDOFF_TTL_SECONDS;
	}
}

export function registerEdge(app: Hono<AppEnv>, deps: Deps): void {
	// Traefik's ForwardAuth forwards the ORIGINAL method, so a POST to a workspace
	// arrives here as a POST. `all` rather than `get` for that reason.
	app.all("/authz", (c) => authorize(c, deps));

	// The bootstrap, on town's own hostname -- which is the only place the session
	// cookie is sent.
	app.get("/workspaces/open", requireSession(deps), (c) => openWorkspace(c, deps));
}

async function authorize(c: Context<AppEnv>, deps: Deps): Promise<Response> {
	const host = workspaceHost(c);
	if (host === null) {
		return c.text("no host", 400);
	}

	const secure = overTLS(deps.config.publicUrl);
	const name = cookieName(COOKIE_EDGE, secure);

	const cookie = getCookie(c, name);
	if (cookie !== undefined) {
		const owner = await deps.edge.verify(cookie, host);
		if (owner !== null) {
			return allow(c, deps, owner, host);
		}
	}

	// URLSearchParams.get returns null, not undefined, when the parameter is absent.
	const handoff = originalParams(c).get(HANDOFF_PARAM);
	if (handoff !== null) {
		const owner = await deps.edge.verify(handoff, host);
		if (owner !== null) {
			setCookie(c, name, await deps.edge.issue(owner, host), {
				path: "/",
				httpOnly: true,
				secure,
				sameSite: "Lax",
				maxAge: deps.config.sessionTtlSeconds,
			});
			// Absolute, on the WORKSPACE's hostname. A relative path would be resolved by
			// Hono against the auth address -- `http://town.town.svc.cluster.local:8080`
			// -- so the browser would be sent to an internal Service address that is
			// unreachable from outside and leaks the cluster's shape.
			return c.redirect(absolute(c, host, withoutHandoff(c)));
		}
	}

	// Nothing identifies this browser here. Send it to town, where the session lives.
	return c.redirect(
		`${deps.config.publicUrl}/workspaces/open?host=${encodeURIComponent(host)}&next=${encodeURIComponent(originalUri(c))}`,
	);
}

/** Admit the request, telling the bridge who it is talking to. */
async function allow(c: Context<AppEnv>, deps: Deps, owner: string, host: string): Promise<Response> {
	c.header(HEADER_USER, owner);
	// Minted fresh per request and handed straight to the bridge, so it never passes
	// through the browser. `aud` is the hostname, as scarab's contract requires.
	c.header(HEADER_ASSERTION, await deps.assertions.mintFor(owner, host));
	return c.body(null, 200);
}

async function openWorkspace(c: Context<AppEnv>, deps: Deps): Promise<Response> {
	const host = c.req.query("host") ?? "";
	const owner = c.get("session").ownerId;

	// EVERY outcome is logged, including the successful one. A refusal on its own is not
	// diagnosable: it looks identical whether the session belongs to somebody else, the
	// hostname never arrived, or the workspace does not exist -- and only two of those
	// leave a trace. This line is what turns "it says forbidden" into an answer.
	const note = (outcome: string): void => {
		console.log(`edge open host=${JSON.stringify(host)} owner=${owner} -> ${outcome}`);
	};

	if (host === "") {
		note("malformed: no host parameter arrived");
		return c.redirect(`${deps.config.publicUrl}/?edge_error=malformed`);
	}

	// The ownership rule lives in pestilence. Asking rather than re-implementing it is
	// the whole reason /api/authorize exists -- two copies would drift, and the one
	// that drifted would be the one nobody tested.
	try {
		await c.get("controlPlane").authorize(host);
	} catch (err) {
		const failure = edgeFailure(err);
		if (failure !== null) {
			note(`refused: ${failure}`);
			return c.redirect(`${deps.config.publicUrl}/?edge_error=${failure}`);
		}
		note(`error: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}

	const grant = await deps.edge.issue(owner, host, deps.edge.handoffTtl());
	note("granted");
	return c.redirect(`https://${host}${safePath(c.req.query("next"))}?${HANDOFF_PARAM}=${encodeURIComponent(grant)}`);
}

function edgeFailure(err: unknown): EdgeFailureCode | null {
	if (!(err instanceof ApiError)) {
		return null;
	}
	if (err.status === 403) {
		return "forbidden";
	}
	if (err.status === 404) {
		return "not_found";
	}
	return null;
}

/**
 * The hostname this request was originally addressed to.
 *
 * `X-Forwarded-Host` because the request town receives was addressed to town; the
 * middleware is configured with `trustForwardHeader`, so only Traefik can set it.
 */
function workspaceHost(c: Context<AppEnv>): string | null {
	const raw = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
	const host = raw.split(":")[0]?.trim().toLowerCase() ?? "";
	return host === "" ? null : host;
}

/** An absolute URL on the workspace's own hostname, for the browser to follow. */
function absolute(c: Context<AppEnv>, host: string, path: string): string {
	// The edge is only ever served over TLS in the cluster; the forwarded scheme is
	// read so a plain-HTTP development setup still works rather than hardcoding one.
	const proto = c.req.header("x-forwarded-proto") ?? "https";
	return `${proto}://${host}${path}`;
}

/**
 * The URI the BROWSER asked for.
 *
 * Traefik's ForwardAuth calls town at `/authz` and does NOT append the original URI or
 * query when the auth address already has a path -- verified live, because the opposite
 * is true when the address has no path, which is a distinction that silently changes
 * what town sees. The original is in `X-Forwarded-Uri`, passed because the middleware
 * sets `trustForwardHeader`.
 *
 * Reading `c.req.path` or `c.req.query` instead would fail in a way that looks nothing
 * like the cause: the handoff would never be found, so every request would bounce to the
 * bootstrap and back, forever.
 */
function originalUri(c: Context<AppEnv>): string {
	const raw = c.req.header("x-forwarded-uri");
	return raw !== undefined && raw.startsWith("/") ? raw : "/";
}

/** The query the BROWSER sent, which is not the query town was called with. */
function originalParams(c: Context<AppEnv>): URLSearchParams {
	const [, ...rest] = originalUri(c).split("?");
	return new URLSearchParams(rest.join("?"));
}

/** Only ever a path. `next` arrives from the URL bar, so an absolute URL would be an open redirect. */
function safePath(raw: string | undefined): string {
	if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) {
		return "/";
	}
	return raw;
}

/** The browser's URI with the handoff removed, so the redirect does not loop. */
function withoutHandoff(c: Context<AppEnv>): string {
	const [path, ...query] = originalUri(c).split("?");
	const params = new URLSearchParams(query.join("?"));
	params.delete(HANDOFF_PARAM);
	const rest = params.toString();
	return rest === "" ? (path ?? "/") : `${path}?${rest}`;
}
