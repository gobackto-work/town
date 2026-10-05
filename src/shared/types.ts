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

/**
 * Mirrors the Go run states in pestilence/internal/eventlog.
 *
 * A batch run cannot reach "waiting". A run that waits for a person who is not there waits
 * for ever, so the record refuses the transition rather than storing a state nothing can
 * leave.
 */
// Not exported: only ever reached through Run, and knip is right that an unused export is
// just a second way to name the same thing. Export them when a consumer needs to name one,
// which is what a control that switches on the state would do.
type RunState =
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "budget_exhausted";

/** Whether a run can block on a person. */
type RunMode = "interactive" | "batch";

/**
 * One run, from the control plane's log.
 *
 * This is the LOG and not the queue. The control plane's events are a delivery queue with a
 * cursor, and reading them without acknowledging pins its retention bound at zero; the log is
 * one retained row per run, and reading it consumes nothing and blocks nothing.
 *
 * It carries a workspace id and not a slug, because the record does not duplicate the
 * workspace registry. Join it with the workspace list to show a name.
 */
export interface Run {
  id: string;
  workspaceId: string;
  state: RunState;
  mode: RunMode;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  lastSequence: number;
}

export interface RunList {
  runs: Run[];
}
