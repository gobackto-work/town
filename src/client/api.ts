// The browser's client for town's own API.
//
// It talks to the BFF and never to the control plane: pestilence is cluster-internal
// and unreachable from a browser, and the BFF is where the user's identity is
// attached.

import { ApiError } from "../shared/errors.ts";
import type { ApiErrorBody, CreateWorkspaceRequest, Identity, Workspace, WorkspaceList } from "../shared/types.ts";

export const api = {
  me: () => request<{ user: Identity }>("/api/me", {}).then((r) => r.user),
  list: () => request<WorkspaceList>("/api/workspaces", {}).then((r) => r.workspaces),
  create: (body: CreateWorkspaceRequest) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  remove: (id: string) => request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
  retry: (id: string) => request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}/retry`, { method: "POST" }),
};

/**
 * The narrow slice of RequestInit these calls use.
 *
 * Narrower than RequestInit on purpose: faithful use of the real type needs every
 * optional field to be conditionally assigned under exactOptionalPropertyTypes, and
 * spreading a `Headers` instance into an object literal silently produces nothing.
 */
interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const init: RequestInit = { headers: { accept: "application/json", ...options.headers } };
  if (options.method !== undefined) {
    init.method = options.method;
  }
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await fetch(path, init);
  const text = await response.text();
  if (!response.ok) {
    throw toApiError(response.status, text);
  }
  return JSON.parse(text) as T;
}

function toApiError(status: number, text: string): ApiError {
  if (text !== "") {
    try {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody>;
      if (typeof parsed.error?.code === "string" && typeof parsed.error.message === "string") {
        return new ApiError(status, parsed.error.code, parsed.error.message);
      }
    } catch {
      // Not JSON. Fall through to the raw text, which is the only evidence left.
    }
  }
  return new ApiError(status, "malformed_response", text.slice(0, 500) || "empty response body");
}

/** True when the caller is simply not signed in, as opposed to anything having gone wrong. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** A message worth showing a person, without leaking a stack trace. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.message} (${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}
