// What the application needs to run, as one object.
//
// Its own module so that app.ts and auth.ts can both refer to it without importing each
// other -- auth is registered BY app, and needs the same types.

import type { Assertions } from "./assertion.ts";
import type { Config } from "./config.ts";
import type { EdgeGrants } from "./edge.ts";
import type { GitHubOAuth } from "./github.ts";
import type { ControlPlane } from "./pestilence.ts";
import type { Session, Sessions } from "./session.ts";

/**
 * Builds a control plane client bound to one user's assertion.
 *
 * A factory rather than a single client, because the credential is per-request: town
 * mints a short-lived assertion for whoever is making this request, and the client that
 * reaches pestilence must carry it.
 */
type ControlPlaneFactory = (assertion: string) => ControlPlane;

export interface Deps {
  config: Config;
  controlPlaneFor: ControlPlaneFactory;
  /**
   * Whether the control plane answers, for /readyz.
   *
   * Separate from the factory because readiness has no user and therefore no assertion
   * to mint. It uses pestilence's deliberately unauthenticated /healthz.
   */
  healthy: () => Promise<boolean>;
  github: GitHubOAuth;
  sessions: Sessions;
  assertions: Assertions;
  /**
   * The workspace edge's own credential.
   *
   * Separate from Sessions because it is bound to a HOSTNAME as well as an owner: a
   * grant for one workspace must not be replayable against another.
   */
  edge: EdgeGrants;
}

/** Values the auth middleware puts on the request for the handlers to use. */
interface AppVars {
  session: Session;
  controlPlane: ControlPlane;
}

export type AppEnv = { Variables: AppVars };
