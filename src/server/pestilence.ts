// The client for the pestilence control plane.
//
// The only place that knows the control plane's URL or its error shape. Everything
// else in the BFF deals in these types and these two errors.

import type {
  ApiErrorBody,
  AuthorizedWorkspace,
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceList,
} from "../shared/types.ts";
import { ApiError } from "../shared/errors.ts";
import { UpstreamUnreachable } from "./errors.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * The control plane operations the BFF uses.
 *
 * An interface rather than the concrete client so that callers depend on the shape
 * they need, and tests can supply a fake without a network. A class with private
 * fields is nominal in TypeScript, so a plain object is not assignable to it -- which
 * is a good property for a class and a bad one for a dependency.
 */
export interface ControlPlane {
  list(signal?: AbortSignal): Promise<Workspace[]>;
  get(id: string, signal?: AbortSignal): Promise<Workspace>;
  create(request: CreateWorkspaceRequest, signal?: AbortSignal): Promise<Workspace>;
  remove(id: string, signal?: AbortSignal): Promise<Workspace>;
  retry(id: string, signal?: AbortSignal): Promise<Workspace>;
  /**
   * Asks pestilence whether this caller may reach the workspace serving a hostname.
   *
   * The ownership rule lives there, so town asks rather than re-implementing it. Two
   * copies would drift, and the one that drifted would be the one nobody tested.
   */
  authorize(hostname: string, signal?: AbortSignal): Promise<AuthorizedWorkspace>;
}

/**
 * Pings the control plane's health endpoint.
 *
 * Standalone rather than a method on the client, because the client now needs a
 * credential and readiness has no user to mint one for. pestilence's /healthz is
 * deliberately unauthenticated, so this needs nothing.
 */
export async function controlPlaneHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${trimTrailingSlashes(baseUrl)}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class ControlPlaneClient implements ControlPlane {
  readonly #baseUrl: string;
  readonly #assertion: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, assertion: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.#baseUrl = trimTrailingSlashes(baseUrl);
    this.#assertion = assertion;
    this.#timeoutMs = timeoutMs;
  }

  async list(signal?: AbortSignal): Promise<Workspace[]> {
    const body = await this.#request<WorkspaceList>("/api/workspaces", "GET", undefined, signal);
    return body.workspaces;
  }

  async get(id: string, signal?: AbortSignal): Promise<Workspace> {
    return this.#request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, "GET", undefined, signal);
  }

  async create(request: CreateWorkspaceRequest, signal?: AbortSignal): Promise<Workspace> {
    return this.#request<Workspace>("/api/workspaces", "POST", request, signal);
  }

  /** Requests deletion. Idempotent on the control plane's side, by design. */
  async remove(id: string, signal?: AbortSignal): Promise<Workspace> {
    return this.#request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, "DELETE", undefined, signal);
  }

  async retry(id: string, signal?: AbortSignal): Promise<Workspace> {
    return this.#request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}/retry`, "POST", {}, signal);
  }

  async authorize(hostname: string, signal?: AbortSignal): Promise<AuthorizedWorkspace> {
    return this.#request<AuthorizedWorkspace>("/api/authorize", "POST", { hostname }, signal);
  }

  /** True if the control plane answers its health endpoint. Used by /readyz. */

  async #request<T>(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.#send(url, method, body, signal);
    const text = await response.text();
    if (!response.ok) {
      const parsed = parseErrorBody(text);
      throw new ApiError(response.status, parsed.code, parsed.message);
    }
    return parseBody<T>(text);
  }

  async #send(url: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = {
      method,
      // The caller's signal covers a disconnected client; the timeout covers a
      // control plane that accepts the connection and then says nothing. Both are
      // needed, and neither implies the other.
      signal: AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), ...(signal ? [signal] : [])]),
      // The assertion town minted for THIS request's user. pestilence verifies it
      // locally; it never sees a GitHub token.
      headers: { authorization: `Bearer ${this.#assertion}` },
    };
    if (body !== undefined) {
      init.headers = { ...(init.headers as Record<string, string>), "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    try {
      return await fetch(url, init);
    } catch (cause) {
      throw new UpstreamUnreachable("the control plane", cause);
    }
  }
}

/**
 * Drops trailing slashes, which would otherwise produce a double slash in every path.
 *
 * A loop rather than `/\/+$/` because that pattern backtracks on a long run of
 * slashes, and the linter is right to say so even though the input is a config value.
 */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  return url.slice(0, end);
}

function parseBody<T>(text: string): T {
  if (text === "") {
    // Every endpoint answers with a body. An empty one means something between us
    // and the control plane answered instead of it, which is worth saying plainly.
    throw new ApiError(502, "malformed_response", "control plane returned an empty body");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(502, "malformed_response", `control plane returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Extracts the control plane's error body, falling back to the raw text.
 *
 * The fallback matters: a proxy or a panic produces HTML, and reporting that verbatim
 * beats reporting "unknown error", because the body is the only evidence left.
 */
function parseErrorBody(text: string): { code: string; message: string } {
  if (text !== "") {
    try {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody>;
      const error = parsed.error;
      if (typeof error?.code === "string" && typeof error.message === "string") {
        return { code: error.code, message: error.message };
      }
    } catch {
      // Not JSON. Fall through to the raw text.
    }
  }
  return { code: "malformed_response", message: text.slice(0, 500) || "empty response body" };
}
