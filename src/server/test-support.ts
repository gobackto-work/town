// Test support: a Deps with everything fake except the crypto.
//
// Sessions and Assertions are the REAL implementations. They are pure crypto with no
// I/O, so stubbing them would cost nothing and hide everything -- a wrong algorithm, a
// claim that does not match the agreed contract, a cookie that does not round-trip. Those
// are precisely the bugs this boundary can have, so the tests use the real thing.
//
// Excluded from the image: it is only ever imported by tests.

import { exportPKCS8, generateKeyPair } from "jose";
import { Assertions } from "./assertion.ts";
import type { Config } from "./config.ts";
import type { Deps } from "./deps.ts";
import { EdgeGrants } from "./edge.ts";
import { COOKIE_SESSION, cookieName, overTLS } from "./cookies.ts";
import type { GitHubOAuth, GitHubUser, OrgMembership } from "./github.ts";
import { UpstreamUnreachable } from "./errors.ts";
import type { ControlPlane } from "./pestilence.ts";
import { Sessions, type Session } from "./session.ts";
import type { Workspace } from "../shared/types.ts";

export const TEST_ORG = "gobackto-work";
export const TEST_PUBLIC_URL = "https://town.test";
export const TEST_ORIGIN = "https://github.com";
export const TEST_AUDIENCE = "pestilence-api";

const TEST_SESSION_SECRET = "not-a-real-secret-just-long-enough-to-pass";

export const TEST_CONFIG: Config = {
  port: 0,
  controlPlaneUrl: "http://control-plane.test:8080",
  // A directory that does not exist, so the static middleware takes its "not built"
  // branch and every test is about the API rather than about asset serving.
  staticDir: "no-such-dir",
  publicUrl: TEST_PUBLIC_URL,
  sessionSecret: TEST_SESSION_SECRET,
  sessionTtlSeconds: 3600,
  github: { clientId: "test-client-id", clientSecret: "test-client-secret", org: TEST_ORG },
  assertion: { keyFile: "no-such-file", audience: TEST_AUDIENCE, ttlSeconds: 120 },
};

export interface TestKeys {
  assertions: Assertions;
  /** The public half, so a test can VERIFY what town signed rather than trust it. */
  publicKey: CryptoKey;
}

/** A throwaway Ed25519 key pair, generated once per call. */
export async function testKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return {
    assertions: await Assertions.fromPem(await exportPKCS8(privateKey), TEST_AUDIENCE, 120),
    publicKey,
  };
}

export const TEST_USER: GitHubUser = { id: 583231, login: "octocat", name: "The Octocat" };

export interface FakeGitHub extends GitHubOAuth {
  /** Codes handed to exchangeCode, so a test can assert the callback got there. */
  readonly exchanged: string[];
}

/** A GitHub that answers from memory. `membership` is the only knob that gates access. */
export function fakeGitHub(options: { membership?: OrgMembership; user?: GitHubUser; fail?: "unreachable" } = {}): FakeGitHub {
  const exchanged: string[] = [];
  const user = options.user ?? TEST_USER;
  const membership = options.membership ?? "active";
  return {
    exchanged,
    authorizeUrl: (redirectUri, state) =>
      `${TEST_ORIGIN}/login/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    exchangeCode: (code) => {
      if (options.fail === "unreachable") {
        // The SAME error type the real client raises for a network failure. A fake that
        // rejected with a plain Error would let the app's upstream handling go untested,
        // and the difference between "GitHub is down" and "we have a bug" is the whole
        // point of that handling.
        return Promise.reject(new UpstreamUnreachable("GitHub", new Error("network down")));
      }
      exchanged.push(code);
      return Promise.resolve("gho_fake_token");
    },
    user: () => Promise.resolve(user),
    orgMembership: () => Promise.resolve(membership),
  };
}

/** A complete workspace, so tests fail to compile if the wire shape changes. */
export const TEST_WORKSPACE: Workspace = {
  id: "01ABC",
  slug: "golden-vole-6w4q",
  ownerId: "github#583231",
  namespace: "ws-golden-vole-6w4q",
  hostname: "golden-vole-6w4q.gobackto.work",
  url: "https://golden-vole-6w4q.gobackto.work",
  state: "RUNNING",
  createdAt: "2026-09-27T05:00:00Z",
  lastActiveAt: "2026-09-27T05:00:00Z",
  deletedAt: null,
  lastError: "",
  limits: { cpu: "500m", memory: "768Mi", storage: "20Gi", maxAgents: 3 },
};

/** A control plane whose every method fails until a test replaces it. */
export function fakeControlPlane(overrides: Partial<ControlPlane> = {}): ControlPlane {
  const unstubbed = () => Promise.reject(new Error("not stubbed for this test"));
  return {
    list: unstubbed,
    get: unstubbed,
    create: unstubbed,
    remove: unstubbed,
    retry: unstubbed,
    authorize: unstubbed,
    ...overrides,
  };
}

/** A factory that records which assertion each client was built with. */
export function recordingFactory(controlPlane: ControlPlane): {
  factory: (assertion: string) => ControlPlane;
  assertions: string[];
} {
  const assertions: string[] = [];
  return {
    assertions,
    factory: (assertion: string) => {
      assertions.push(assertion);
      return controlPlane;
    },
  };
}

export interface DepsOptions {
  github?: GitHubOAuth;
  controlPlane?: ControlPlane;
  healthy?: boolean;
}

/** A complete Deps. Everything is overridable; nothing reaches the network. */
export async function testDeps(options: DepsOptions = {}): Promise<Deps & { keys: TestKeys; assertionsUsed: string[] }> {
  const keys = await testKeys();
  const { factory, assertions } = recordingFactory(options.controlPlane ?? fakeControlPlane());
  return {
    config: TEST_CONFIG,
    controlPlaneFor: factory,
    healthy: () => Promise.resolve(options.healthy ?? true),
    github: options.github ?? fakeGitHub(),
    sessions: new Sessions(TEST_CONFIG.sessionSecret, TEST_CONFIG.sessionTtlSeconds),
    assertions: keys.assertions,
    edge: new EdgeGrants(TEST_CONFIG.sessionSecret, TEST_CONFIG.sessionTtlSeconds),
    keys,
    assertionsUsed: assertions,
  };
}

/** A Cookie header holding a valid session for the given identity. */
export async function sessionCookie(
  deps: Deps,
  session: Session = { ownerId: "github#583231", login: "octocat", name: "The Octocat" },
): Promise<string> {
  // The real name, `__Host-` prefix and all: hardcoding it here would let the tests
  // pass while the server and the tests disagreed about what to read.
  const name = cookieName(COOKIE_SESSION, overTLS(TEST_CONFIG.publicUrl));
  return `${name}=${await deps.sessions.issue(session)}`;
}
