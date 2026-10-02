// The server entry point.
//
// Node runs this file directly: it strips the types rather than compiling, so there is
// no build step for the server at all. Only the client is bundled, by vite.

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { Assertions } from "./assertion.ts";
import { callbackUrl, loadConfig } from "./config.ts";
import { EdgeGrants } from "./edge.ts";
import { GitHub } from "./github.ts";
import { ControlPlaneClient, controlPlaneHealthy } from "./pestilence.ts";
import { Sessions } from "./session.ts";

const config = loadConfig();

const deps = {
  config,
  controlPlaneFor: (assertion: string) => new ControlPlaneClient(config.controlPlaneUrl, assertion),
  healthy: () => controlPlaneHealthy(config.controlPlaneUrl),
  github: new GitHub({ clientId: config.github.clientId, clientSecret: config.github.clientSecret }),
  sessions: new Sessions(config.sessionSecret, config.sessionTtlSeconds),
  // The workspace edge's credential, bound to a hostname as well as an owner.
  edge: new EdgeGrants(config.sessionSecret, config.sessionTtlSeconds),
  // Fails here, not on someone's first login, if the signing key is missing.
  assertions: await Assertions.load(config.assertion),
};

serve({ fetch: createApp(deps).fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`town listening on :${info.port}`);
  console.log(`  control plane: ${config.controlPlaneUrl}`);
  console.log(`  static dir:    ${config.staticDir}`);
  console.log(`  org:           ${config.github.org}`);
  // Printed because it has to match the GitHub app's callback URL EXACTLY, and a
  // mismatch is the single most common way this flow fails -- with GitHub showing a
  // redirect_uri error that does not name the value it wanted.
  console.log(`  callback:      ${callbackUrl(config)}`);
});
