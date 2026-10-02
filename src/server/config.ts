// Configuration, read once at startup.
//
// Everything the SERVER needs has a default, so it runs with no environment at all.
// Everything AUTHENTICATION needs does not, and town refuses to start without it. That
// asymmetry is the point: a town that cannot identify anyone is an unauthenticated
// workspace-provisioning API, and the safest way to never deploy one is to make it
// impossible to start.

interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  /** The org whose members may use the platform. Membership is the entire gate. */
  org: string;
}

export interface AssertionConfig {
  /** PKIX PEM Ed25519 private key, read from a file rather than the environment. */
  keyFile: string;
  /** Contract value, agreed with pestilence. See docs/town-interface.md. */
  audience: string;
  ttlSeconds: number;
}

export interface Config {
  port: number;
  /** Base URL of the pestilence control plane. */
  controlPlaneUrl: string;
  /** Directory holding the built client, served as static assets. */
  staticDir: string;
  /** town's own public base URL. Must match the OAuth app's callback exactly. */
  publicUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  github: GitHubConfig;
  assertion: AssertionConfig;
}

/** The variables town cannot run without. Named here so the error can list them. */
const REQUIRED = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ORG", "SESSION_SECRET"] as const;

/**
 * Reads configuration from the environment.
 *
 * Throws rather than falling back when authentication is unconfigured. A default here
 * would mean either a guessable session secret or an open API, and "the process would
 * not start" is a much better failure than either.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(
      `town refuses to start without authentication configured. Missing: ${missing.join(", ")}. ` +
        "This is deliberate -- a town that cannot identify anyone is an unauthenticated " +
        "workspace-provisioning API.",
    );
  }

  return {
    port: parsePort(env.PORT),
    // The in-cluster Service. Local development points this at a port-forward.
    controlPlaneUrl: env.PESTILENCE_URL ?? "http://control-plane.pestilence.svc.cluster.local:8080",
    staticDir: env.STATIC_DIR ?? "dist/client",
    publicUrl: trimTrailingSlash(env.TOWN_URL ?? "https://town.gobackto.work"),
    sessionSecret: requireValue(env, "SESSION_SECRET"),
    sessionTtlSeconds: parsePositiveInt(env.SESSION_TTL_SECONDS, 12 * 60 * 60, "SESSION_TTL_SECONDS"),
    github: {
      clientId: requireValue(env, "GITHUB_CLIENT_ID"),
      clientSecret: requireValue(env, "GITHUB_CLIENT_SECRET"),
      // GitHub org names are case-insensitive; storing one form avoids comparing two.
      org: requireValue(env, "GITHUB_ORG").toLowerCase(),
    },
    assertion: {
      keyFile: env.ASSERTION_KEY_FILE ?? "/var/run/town/assertion-key.pem",
      audience: env.ASSERTION_AUDIENCE ?? "pestilence-api",
      ttlSeconds: parsePositiveInt(env.ASSERTION_TTL_SECONDS, 120, "ASSERTION_TTL_SECONDS"),
    },
  };
}

/** The OAuth callback URL. Must match the value registered on the GitHub app exactly. */
export function callbackUrl(config: Config): string {
  return `${config.publicUrl}/auth/callback`;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  // Non-empty is already guaranteed by the check above; this narrows the type.
  return env[name] ?? "";
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 8080;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  return url.slice(0, end);
}
