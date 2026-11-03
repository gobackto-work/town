// The BFF's application: the HTTP surface the browser talks to.
//
// Constructed separately from the listening socket, and from its dependencies, so tests
// can drive it directly without binding a port or reaching GitHub.

import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "../shared/errors.ts";
import type { CreateWorkspaceRequest } from "../shared/types.ts";
import { registerAuth, requireSession } from "./auth.ts";
import { registerEdge } from "./edge.ts";
import type { AppEnv, Deps } from "./deps.ts";
import { UpstreamError, UpstreamUnreachable } from "./errors.ts";
import { RunStream } from "./runStream.ts";

/**
 * Control plane statuses that are passed through unchanged.
 *
 * These are the ones the UI acts on differently. Anything else becomes 502: from
 * town's perspective an unrecognised status from upstream is an upstream fault, not
 * something to relay verbatim.
 */
const PASSTHROUGH: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422, 500]);

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", accessLog);
  // Unauthenticated, and deliberately so: probes must work without a session, and
  // pestilence's own /healthz is what /readyz reaches.
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    if (!(await deps.healthy())) {
      return c.json({ error: { code: "unavailable", message: "control plane unreachable" } }, 503);
    }
    return c.json({ status: "ok" });
  });

  registerAuth(app, deps);
  registerEdge(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerRunRoutes(app, deps);

  registerNotFound(app);
  registerStatic(app, deps.config.staticDir);
  app.onError((err, c) => handleError(err, c));

  return app;
}

/**
 * The run log, behind the session gate.
 *
 * Two routes for one read. `/api/runs` answers one request, and `/api/stream` holds a
 * connection open and pushes what changed. Both read the LOG and not the event queue, so
 * neither takes a cursor, consumes nothing, and cannot hold the record's retention bound.
 *
 * There is one stream per OWNER and not one per tab. Each read mints a fresh assertion: a
 * stream outlives the 120-second assertion that opened it, so the credential has to be
 * derived per read rather than captured at connect time.
 */
function registerRunRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const gate = requireSession(deps);
  const streams = new Map<string, RunStream>();

  app.get("/api/runs", gate, async (c) => c.json({ runs: await c.get("controlPlane").runs() }));

  app.get("/api/stream", gate, (c) => {
    const { ownerId } = c.get("session");
    const stream = streamFor(streams, deps, ownerId);

    return streamSSE(c, async (sse) => {
      const unsubscribe = stream.subscribe((update) => {
        // A tab that closed between the write and the abort surfaces here. There is
        // nothing to do about it and nothing worth logging: the abort handler is the
        // one that cleans up.
        void sse.writeSSE({ event: "runs", data: JSON.stringify(update) }).catch(() => {});
      });

      const release = () => {
        unsubscribe();
        if (stream.size === 0) {
          streams.delete(ownerId);
        }
      };
      sse.onAbort(release);

      try {
        // A ping and not a comment: some proxies buffer anything that is not an event,
        // and an idle connection that proxies nothing is one a proxy may drop.
        while (!sse.aborted) {
          await sse.sleep(STREAM_HEARTBEAT_MS);
          if (sse.aborted) {
            break;
          }
          await sse.writeSSE({ event: "ping", data: "1" });
        }
      } finally {
        release();
      }
    });
  });
}

/** How often an idle stream says something, so a proxy does not drop it. */
const STREAM_HEARTBEAT_MS = 15_000;

/**
 * The stream for one owner, started on first use.
 *
 * The read is built here rather than passed in because it needs that owner's assertion,
 * and the assertion is minted per read. When the last tab goes away the entry is removed
 * by the caller, so a person who never returns leaves no timer running.
 */
function streamFor(streams: Map<string, RunStream>, deps: Deps, ownerId: string): RunStream {
  const existing = streams.get(ownerId);
  if (existing !== undefined) {
    return existing;
  }
  const stream = new RunStream(
    async () => deps.controlPlaneFor(await deps.assertions.mint(ownerId)).runs(),
    (err) => console.error("run stream:", err instanceof Error ? err.message : err),
  );
  streams.set(ownerId, stream);
  return stream;
}

/**
 * The workspace API, behind the session gate.
 *
 * `requireSession` also builds the per-request control plane client, so a handler cannot
 * reach pestilence without an identity even by mistake -- there is no client in scope
 * that lacks one.
 */
function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const gate = requireSession(deps);

  app.get("/api/workspaces", gate, async (c) => c.json({ workspaces: await c.get("controlPlane").list() }));

  app.post("/api/workspaces", gate, async (c) => {
    const request = await readJsonObject<CreateWorkspaceRequest>(c);
    return c.json(await c.get("controlPlane").create(request), 201);
  });

  app.get("/api/workspaces/:id", gate, async (c) => c.json(await c.get("controlPlane").get(c.req.param("id"))));

  app.delete("/api/workspaces/:id", gate, async (c) =>
    c.json(await c.get("controlPlane").remove(c.req.param("id"))),
  );

  app.post("/api/workspaces/:id/retry", gate, async (c) =>
    c.json(await c.get("controlPlane").retry(c.req.param("id"))),
  );
}

/**
 * Unknown API paths must 404 as JSON rather than fall through to the app shell.
 *
 * Registered before the static middleware for that reason: the wildcard below serves
 * index.html for any GET, so without this an unknown endpoint would answer with HTML
 * and a 200, and the client would try to parse a web page as JSON.
 */
function registerNotFound(app: Hono<AppEnv>): void {
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));
}

function registerStatic(app: Hono<AppEnv>, staticDir: string): void {
  if (!existsSync(staticDir)) {
    // Not an error at startup: in development vite serves the client and proxies
    // /api here, so there is nothing to serve. Saying so beats a bare 404.
    app.get("*", (c) => c.text(`client not built: run \`npm run build\` (looked in ${staticDir})\n`, 503));
    return;
  }

  app.use("/*", serveStatic({ root: staticDir }));

  // Anything left is a client-side route. The client does its own routing, so
  // /workspaces/<id> has to return the app shell rather than a 404.
  app.get("*", serveStatic({ path: `${staticDir}/index.html` }));
}

function handleError(err: unknown, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, passthroughStatus(err.status));
  }
  if (err instanceof UpstreamUnreachable || err instanceof UpstreamError) {
    console.error("upstream:", err.message);
    return c.json({ error: { code: "upstream_error", message: err.message } }, 502);
  }
  // Logged in full, returned as nothing. The message may name internals and the
  // caller can do nothing with it either way.
  console.error("unhandled error:", err);
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
}

function passthroughStatus(status: number): ContentfulStatusCode {
  return PASSTHROUGH.has(status) ? (status as ContentfulStatusCode) : 502;
}

/**
 * Reads a JSON object body, treating an empty body as `{}`.
 *
 * An empty body means "use the defaults" -- the control plane accepts `{}` for the
 * same reason, so refusing it here would be town inventing a rule the platform does
 * not have. Anything that is not an object is refused, because forwarding it would
 * only move the failure somewhere less legible.
 */
async function readJsonObject<T extends object>(c: Context): Promise<T> {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    return {} as unknown as T;
  }
  const parsed = parseJson(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request", "request body must be a JSON object");
  }
  return parsed as T;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, "invalid_request", "request body must be JSON");
  }
}

// Deliberately not audit logging: this records that a request happened, not who made
// it. Audit logging is a separate, unbuilt design item.
async function accessLog(c: Context, next: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
}
