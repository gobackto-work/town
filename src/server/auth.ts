// Sign-in, sign-out, and the gate in front of the API.
//
// GitHub is the only identity provider and org membership is the only authorization
// rule. There is no role, no allowlist of logins, and no second path in.

import { randomBytes } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Deps } from "./deps.ts";
import { ApiError } from "../shared/errors.ts";
import type { AuthFailureCode } from "../shared/types.ts";
import { UpstreamError, UpstreamUnreachable } from "./errors.ts";
import { ownerIdOf } from "../shared/identity.ts";
import { COOKIE_SESSION, COOKIE_STATE, cookieName, overTLS } from "./cookies.ts";

/** How long the OAuth nonce cookie lives. */
const STATE_TTL_SECONDS = 600;

/**
 * Routes for signing in, signing out, and asking who is signed in.
 *
 * The failure CODES live in shared/types.ts, next to the client that renders them into
 * readable text, because they cross the wire in a redirect URL.
 */
export function registerAuth(app: Hono<AppEnv>, deps: Deps): void {
  app.get("/auth/login", (c: Context) => beginLogin(c, deps));
  app.get("/auth/callback", (c: Context) => completeLogin(c, deps));
  app.post("/auth/logout", (c: Context<AppEnv>) => {
    // `secure` is not optional here: a `__Host-` cookie without it is rejected, by
    // Hono when setting and by the browser when receiving.
    deleteCookie(c, name(COOKIE_SESSION, deps), { path: "/", secure: overTLS(deps.config.publicUrl) });
    return c.json({ status: "signed out" });
  });
  app.get("/api/me", requireSession(deps), (c: Context<AppEnv>) =>
    c.json({ user: c.get("session") }),
  );
}

/**
 * The gate. Everything under /api goes through it.
 *
 * It also builds the per-request control plane client, because the assertion is
 * per-request: minting it here means no handler can forget to, and there is one place
 * where an unauthenticated request could become an authenticated one.
 */
export function requireSession(deps: Deps): MiddlewareHandler<AppEnv> {  return async (c, next) => {
    const token = getCookie(c, name(COOKIE_SESSION, deps));
    const session = token === undefined ? null : await deps.sessions.verify(token);
    if (session === null) {
      throw new ApiError(401, "unauthorized", "sign in with GitHub");
    }
    c.set("session", session);
    c.set("controlPlane", deps.controlPlaneFor(await deps.assertions.mint(session.ownerId)));
    await next();
  };
}

function beginLogin(c: Context, deps: Deps): Response {
  // A nonce, checked against a cookie on the way back. Without it an attacker can hand
  // a victim a callback URL carrying the attacker's code and silently sign them in as
  // the attacker -- after which the victim's workspaces are created in the attacker's
  // name.
  const state = randomBytes(32).toString("base64url");
  setCookie(c, name(COOKIE_STATE, deps), state, { ...cookieOptions(deps), maxAge: STATE_TTL_SECONDS });
  return c.redirect(deps.github.authorizeUrl(`${deps.config.publicUrl}/auth/callback`, state));
}

async function completeLogin(c: Context, deps: Deps): Promise<Response> {
  const expected = getCookie(c, name(COOKIE_STATE, deps));
  deleteCookie(c, name(COOKIE_STATE, deps), { path: "/", secure: overTLS(deps.config.publicUrl) });

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (expected === undefined || state === undefined || state !== expected || code === undefined || code === "") {
    return failure(c, deps, "state_mismatch");
  }

  const exchanged = await exchange(c, deps, code);
  if (typeof exchanged !== "string") {
    return exchanged;
  }
  return signIn(c, deps, exchanged);
}

/** Returns the access token, or the failure Response to send instead. */
async function exchange(c: Context, deps: Deps, code: string): Promise<string | Response> {
  try {
    return await deps.github.exchangeCode(code, `${deps.config.publicUrl}/auth/callback`);
  } catch (err) {
    return upstreamFailure(c, deps, err);
  }
}

async function signIn(c: Context, deps: Deps, accessToken: string): Promise<Response> {
  try {
    const user = await deps.github.user(accessToken);
    const membership = await deps.github.orgMembership(accessToken, deps.config.github.org, user.login);
    if (membership !== "active") {
      // `pending` is its own answer: invited is not the same as joined, and letting an
      // unaccepted invitation through would admit someone who is not yet a member.
      return failure(c, deps, membership === "pending" ? "pending_invitation" : "not_a_member");
    }

    const session = { ownerId: ownerIdOf(user.id), login: user.login, name: user.name };
    setCookie(c, name(COOKIE_SESSION, deps), await deps.sessions.issue(session), {
      ...cookieOptions(deps),
      maxAge: deps.config.sessionTtlSeconds,
    });
    // The access token is deliberately dropped here. It exists only long enough to
    // learn who this is, so nothing downstream can leak it.
    return c.redirect(deps.config.publicUrl);
  } catch (err) {
    return upstreamFailure(c, deps, err);
  }
}

function failure(c: Context, deps: Deps, code: AuthFailureCode): Response {
  // The reason goes in the URL rather than the body so a reload is harmless and the
  // client can render it. It is a fixed code, never upstream text.
  return c.redirect(`${deps.config.publicUrl}/?auth_error=${code}`);
}

function upstreamFailure(c: Context, deps: Deps, err: unknown): Response {
  if (err instanceof UpstreamUnreachable || err instanceof UpstreamError) {
    console.error("github:", err.message);
    return failure(c, deps, "github_unavailable");
  }
  throw err;
}

function cookieOptions(deps: Deps): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
} {
  return {
    path: "/",
    httpOnly: true,
    // Secure whenever town is served over TLS, which in the cluster is always. It is
    // derived rather than hardcoded so that local development over http is possible
    // without a second code path.
    secure: overTLS(deps.config.publicUrl),
    // Lax, not Strict: the callback arrives as a top-level navigation from github.com,
    // and Strict would withhold the state cookie on exactly that request, breaking the
    // flow in a way that looks like a bug in the state check.
    sameSite: "Lax",
  };
}

/**
 * The cookie name, with the `__Host-` prefix when TLS allows it.
 *
 * Every cookie here is prefixed, including the OAuth nonce. The nonce is what stops an
 * attacker handing a victim a callback URL carrying the attacker's code -- and a tenant
 * workspace, being a sibling subdomain of town, can set a `Domain=.gobackto.work` cookie.
 * Without the prefix, that is a cookie-shadowing path to exactly that attack.
 */
function name(base: string, deps: Deps): string {
  return cookieName(base, overTLS(deps.config.publicUrl));
}
