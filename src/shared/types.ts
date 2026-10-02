// Types shared by the BFF and the browser.
//
// These mirror the pestilence API's wire format exactly -- its `workspaceDTO` in
// internal/api/api.go. Hand-written rather than generated: there is one endpoint
// family, and a codegen pipeline would be more machinery than the contract is worth.
// The cost is that a change on the Go side has to be made here too, which is why the
// field names are spelled identically and a test asserts a real response parses into
// these types rather than into something merely similar.

/** Mirrors the Go state machine in internal/workspace/workspace.go. */
export type WorkspaceState =
  | "PROVISIONING"
  | "RUNNING"
  | "SUSPENDED"
  | "FAILED"
  | "DELETING"
  | "DELETED";

/**
 * States where a change is still coming, so the UI should keep polling.
 *
 * DELETED is excluded deliberately: it means deletion *completed*, not requested,
 * and the control plane only reaches it once the namespace is actually gone.
 */
export const IN_FLIGHT_STATES: readonly WorkspaceState[] = ["PROVISIONING", "DELETING"];

// Not exported: it is only ever reached through Workspace and CreateWorkspaceRequest,
// and knip is right that an unused export is just a second way to name the same thing.
interface WorkspaceLimits {
  cpu: string;
  memory: string;
  storage: string;
  maxAgents: number;
}

export interface Workspace {
  id: string;
  slug: string;
  ownerId: string;
  namespace: string;
  hostname: string;
  url: string;
  state: WorkspaceState;
  createdAt: string;
  lastActiveAt: string;
  deletedAt: string | null;
  lastError: string;
  limits: WorkspaceLimits;
}

/**
 * The create request. Every field is optional on purpose: the control plane applies
 * its own defaults, and duplicating those defaults here would mean two places to
 * change them. A partial `limits` is accepted and merged server-side.
 */
export interface CreateWorkspaceRequest {
  limits?: Partial<WorkspaceLimits>;
}

/** Mirrors the Go errorBody. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/**
 * Why a sign-in attempt failed.
 *
 * Codes, not messages: the value travels in a redirect URL, and the readable text belongs
 * on the side that can also offer a next step. Mirrors the server's AuthFailure.
 */
export type AuthFailureCode =
  | "state_mismatch"
  | "not_a_member"
  | "pending_invitation"
  | "github_unavailable";

/**
 * Why the workspace edge refused, translated for a person.
 *
 * `forbidden` and `not_found` are kept apart even though pestilence answers the same
 * 404 for an unknown workspace and a workspace that is not RUNNING: from the user's side,
 * "that is not yours" and "that does not exist yet" are different things to be told.
 */
export type EdgeFailureCode = "forbidden" | "not_found" | "malformed";

/**
 * The answer to "may this owner reach the workspace serving this hostname?".
 *
 * The ownership rule lives in pestilence, so this is what town asks rather than
 * re-implements.
 */
export interface AuthorizedWorkspace {
  user: string;
  slug: string;
  namespace: string;
}

/**
 * The signed-in user.
 *
 * Mirrors the server's Session, which is the JWT payload of the session cookie. Kept in
 * step by hand, like the workspace types, and for the same reason: one contract, one
 * place it is written down.
 */
export interface Identity {
  /** `github#<numeric id>`. Immutable; see src/shared/identity.ts. */
  ownerId: string;
  login: string;
  name: string | null;
}

export interface WorkspaceList {
  workspaces: Workspace[];
}
