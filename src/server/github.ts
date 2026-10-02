// The GitHub client: OAuth code exchange, the user record, and the org check.
//
// GitHub is OAuth 2.0 and NOT OpenID Connect -- it issues no ID token, so there is
// nothing here to verify offline. Identity comes from asking the API with the access
// token, which is why these three calls are the whole of the authentication.

import { UpstreamError, UpstreamUnreachable } from "./errors.ts";

const API = "https://api.github.com";
const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const TIMEOUT_MS = 10_000;
const WHAT = "GitHub";

/**
 * The minimum scope. `read:org` is what the membership check needs and nothing else is
 * requested -- a GitHub token grants access to whatever else it was issued for, so
 * asking for more than this hands town reach it has no use for.
 */
export const REQUIRED_SCOPE = "read:org";

/**
 * Whether a user is in the org.
 *
 * `pending` is deliberately its own case rather than being folded into `active` or
 * `none`: it means invited-but-not-accepted, and treating an unaccepted invitation as
 * membership would let someone in who is not yet a member.
 */
export type OrgMembership = "active" | "pending" | "none";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

export interface GitHubConfigInput {
  clientId: string;
  clientSecret: string;
}

/**
 * The GitHub operations authentication needs.
 *
 * An interface rather than the class, so tests can supply a fake -- and because a class
 * with private fields is nominal in TypeScript, a plain object is not assignable to it.
 */
export interface GitHubOAuth {
  authorizeUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  user(token: string): Promise<GitHubUser>;
  orgMembership(token: string, org: string, login: string): Promise<OrgMembership>;
}

export class GitHub implements GitHubOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;

  constructor(config: GitHubConfigInput) {
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
  }

  /**
   * Where to send the browser to begin the flow.
   *
   * `allow_signup=false` so the flow cannot be used to create a GitHub account -- the
   * org is invitation-based, so a new account could not be a member anyway, and offering
   * the option only invites confusion.
   */
  authorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", REQUIRED_SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return url.toString();
  }

  /** Exchanges the one-time code for an access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const response = await this.#send(TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const body = (await parse(response)) as { access_token?: unknown; error?: unknown; error_description?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      // GitHub answers 200 with an error body for a bad code, so `response.ok` is not
      // the check that matters here.
      throw new UpstreamError(WHAT, 200, `code exchange failed: ${describeError(body)}`);
    }
    return body.access_token;
  }

  /** The authenticated user. `id` is the immutable key; `login` is not. */
  async user(token: string): Promise<GitHubUser> {
    const response = await this.#send(`${API}/user`, { headers: this.#headers(token) });
    const body = (await parse(response)) as Partial<GitHubUser>;
    if (typeof body.id !== "number" || typeof body.login !== "string") {
      throw new UpstreamError(WHAT, response.status, "user response has no id/login");
    }
    return { id: body.id, login: body.login, name: typeof body.name === "string" ? body.name : null };
  }

  /**
   * The user's membership of the org.
   *
   * A 404 means "not a member" and is a normal answer, not an error. It can also mean
   * the token is not permitted to see the membership at all -- both cases deny, so the
   * ambiguity is harmless and fail-closed.
   */
  async orgMembership(token: string, org: string, login: string): Promise<OrgMembership> {
    const response = await this.#send(`${API}/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, {
      headers: this.#headers(token),
    });
    if (response.status === 404) {
      return "none";
    }
    const body = (await parse(response)) as { state?: unknown };
    if (body.state === "active" || body.state === "pending") {
      return body.state;
    }
    throw new UpstreamError(WHAT, response.status, `unexpected membership state ${String(body.state)}`);
  }

  #headers(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      // GitHub rejects API requests without one.
      "user-agent": "town",
    };
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch (cause) {
      throw new UpstreamUnreachable(WHAT, cause);
    }
  }
}

/**
 * A short, safe description of GitHub's error field.
 *
 * `error` is typed unknown because it is whatever GitHub sent, and interpolating it
 * blindly would put `[object Object]` in the message at best -- at worst it would put
 * something unvetted into a log line.
 */
function describeError(body: { error?: unknown }): string {
  return typeof body.error === "string" && body.error !== "" ? body.error : "no access_token";
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(WHAT, response.status, text.slice(0, 200));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError(WHAT, response.status, `invalid JSON: ${text.slice(0, 200)}`);
  }
}
