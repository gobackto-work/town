// The assertion town presents to pestilence.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL
// ────────────────────────────────────────────────────────────────────────────
//
// GitHub is OAuth 2.0, not OpenID Connect, and issues no ID token -- so there is nothing
// pestilence could verify for itself. The alternative, forwarding the GitHub access token
// and having pestilence call GitHub, was rejected: it would open the control plane's
// egress to the internet, make the trusted plane's availability depend on GitHub, and
// hand it a credential with `read:org` on the whole org when all it needs is one opaque
// owner id.
//
// So town signs a short-lived assertion and pestilence verifies it locally. Ed25519
// rather than a shared secret, for two practical reasons: the private key exists in
// exactly one place, and the public key is not sensitive, so pestilence's copy of it can
// live in a ConfigMap instead of a Secret. It is also the same shape pestilence already
// uses for the broker capability token, so there is one JWT pattern in the platform
// rather than two.

import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";
import type { AssertionConfig } from "./config.ts";

const ALG = "EdDSA";

/** The issuer claim. A contract value; pestilence checks it. */
export const ISSUER = "town";

export class Assertions {
  readonly #key: CryptoKey;
  readonly #audience: string;
  readonly #ttlSeconds: number;

  private constructor(key: CryptoKey, audience: string, ttlSeconds: number) {
    this.#key = key;
    this.#audience = audience;
    this.#ttlSeconds = ttlSeconds;
  }

  /**
   * Loads the signing key.
   *
   * Fails loudly at startup rather than at the first request: a town that cannot mint
   * assertions can authenticate nobody, and discovering that on someone's first login is
   * strictly worse than not starting.
   */
  static async load(config: AssertionConfig): Promise<Assertions> {
    let pem: string;
    try {
      pem = readFileSync(config.keyFile, "utf8");
    } catch (cause) {
      throw new Error(
        `cannot read the assertion signing key at ${config.keyFile}. ` +
          "Generate one with cluster-setup-scripts/generate-keys.sh -- see docs/auth.md.",
        { cause },
      );
    }
    return Assertions.fromPem(pem, config.audience, config.ttlSeconds);
  }

  /**
   * The same thing from a PEM already in hand.
   *
   * Used by tests, which generate a throwaway key pair and exercise the real signing
   * path rather than a stub -- a stubbed signer would not have caught an algorithm
   * mismatch, which is exactly the bug this boundary can have.
   */
  static async fromPem(pem: string, audience: string, ttlSeconds: number): Promise<Assertions> {
    return new Assertions(await importPKCS8(pem, ALG), audience, ttlSeconds);
  }

  /**
   * Mints an assertion for one owner under the configured audience.
   *
   * Short-lived and minted per request rather than per session: it is a few bytes and a
   * signature, and a per-session token would need storing, refreshing and revoking. Two
   * minutes is long enough to cross a request and short enough that a leaked one is
   * worth very little.
   */
  async mint(ownerId: string): Promise<string> {
    return this.mintFor(ownerId, this.#audience);
  }

  /**
   * The same, for a caller-chosen audience.
   *
   * The workspace edge uses this with the workspace's HOSTNAME as the audience, which
   * binds the assertion to one workspace: a token minted for one bridge cannot be
   * replayed against another's. The signature and issuer are unchanged -- only the
   * audience differs -- so the same public key verifies both.
   */
  async mintFor(ownerId: string, audience: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: ALG })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(ownerId)
      .setIssuedAt()
      .setExpirationTime(`${this.#ttlSeconds}s`)
      .sign(this.#key);
  }
}
