// The browser session: a signed, stateless cookie.
//
// Stateless rather than a server-side store, for three reasons that all point the same
// way. It survives a restart, which matters because town has no database to lose it in.
// It works with more than one replica, which an in-memory map would not -- so `replicas:
// 1` in the deployment is a choice rather than a constraint. And it needs no eviction
// policy, no store to back up, and no new dependency.
//
// Signed, not encrypted: the payload holds a GitHub id and login, which are not secrets,
// and the only property that matters is that the holder cannot alter it. The user's
// GitHub access token is deliberately NOT in here -- it is used once, at login, and then
// dropped.

import { SignJWT, jwtVerify } from "jose";
import type { Identity } from "../shared/types.ts";

/** HS256 is all that is needed: the same process signs and verifies. */
const ALG = "HS256";

/** Shorter than this and the secret is not worth the name. */
const MIN_SECRET_LENGTH = 32;

/**
 * The signed-in user, as stored in the cookie.
 *
 * An alias rather than a second declaration: the cookie's payload and the browser's
 * Identity are one contract, and two shapes with the same fields drift.
 */
export type Session = Identity;

export class Sessions {
  readonly #key: Uint8Array;
  readonly #ttlSeconds: number;

  constructor(secret: string, ttlSeconds: number) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.#key = new TextEncoder().encode(secret);
    this.#ttlSeconds = ttlSeconds;
  }

  async issue(session: Session): Promise<string> {
    return new SignJWT({ login: session.login, name: session.name })
      .setProtectedHeader({ alg: ALG })
      .setSubject(session.ownerId)
      .setIssuedAt()
      .setExpirationTime(`${this.#ttlSeconds}s`)
      .sign(this.#key);
  }

  /**
   * Returns the session, or null for anything at all wrong with it.
   *
   * `algorithms` is pinned rather than inferred. Without it a verifier will accept any
   * algorithm the key type supports, which is the shape of the classic JWT confusion
   * bugs; with it, a token claiming a different algorithm is simply rejected.
   */
  async verify(token: string): Promise<Session | null> {
    try {
      const { payload } = await jwtVerify(token, this.#key, { algorithms: [ALG] });
      const ownerId = payload.sub;
      const login = payload.login;
      if (typeof ownerId !== "string" || typeof login !== "string") {
        return null;
      }
      return { ownerId, login, name: typeof payload.name === "string" ? payload.name : null };
    } catch {
      return null;
    }
  }
}
