import type { Workspace, WorkspaceState } from "../shared/types.ts";

interface TableProps {
  readonly workspaces: Workspace[];
  readonly busy: boolean;
  /**
   * The signed-in member's owner id.
   *
   * Every member can SEE every workspace; only the owner can change one. The list is not
   * filtered, so the table has to be the thing that knows the difference -- otherwise it
   * offers a Delete that answers 403.
   */
  readonly ownerId: string;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}

export function WorkspaceTable({ workspaces, busy, ownerId, onRemove, onRetry }: TableProps) {
  if (workspaces.length === 0) {
    return <p className="empty">No workspaces yet.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Slug</th>
          <th scope="col">State</th>
          <th scope="col">Endpoint</th>
          <th scope="col">Created</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {workspaces.map((workspace) => (
          <Row
            key={workspace.id}
            workspace={workspace}
            busy={busy}
            mine={workspace.ownerId === ownerId}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </tbody>
    </table>
  );
}

interface RowProps {
  readonly workspace: Workspace;
  readonly busy: boolean;
  /** True when the signed-in member owns it, and may therefore change it. */
  readonly mine: boolean;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}

function Row({ workspace, busy, mine, onRemove, onRetry }: RowProps) {
  const { state, id } = workspace;
  return (
    <tr>
      <td>
        <code>{workspace.slug}</code>
        {!mine && (
          // Muted rather than hidden: a colleague's workspace being visible but not
          // actionable is the intended model, and saying so beats a row whose buttons
          // mysteriously vanish.
          <span className="muted" title="Only the owner can change this workspace">
            {" "}
            &middot; colleague
          </span>
        )}
        {/* The error is kept off the table itself: it is long, usually empty, and
            the operator only wants it when looking at a row that has failed. */}
        {workspace.lastError !== "" && (
          <span className="warn" title={workspace.lastError}>
            {" "}
            &#9888;
          </span>
        )}
      </td>
      <td>
        <StateBadge state={state} />
      </td>
      <td>
        <Endpoint workspace={workspace} />
      </td>
      <td className="muted">{formatTime(workspace.createdAt)}</td>
      <td className="row-actions">
        {mine && state === "FAILED" && (
          <button type="button" onClick={() => onRetry(id)} disabled={busy}>
            Retry
          </button>
        )}
        {mine && isDeletable(state) && (
          <button type="button" className="danger" onClick={() => onRemove(id)} disabled={busy}>
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

interface EndpointProps {
  readonly workspace: Workspace;
}

/**
 * Only links a workspace that is actually serving.
 *
 * A link to a workspace still provisioning is a link to a connection error, and
 * offering it teaches the operator to distrust the column.
 *
 * The link goes THROUGH TOWN rather than straight at the workspace hostname. The
 * workspace edge needs a grant, and town is the only party that can mint one: it holds
 * the session, and the workspace's own subdomain never sees that cookie -- see
 * src/server/edge.ts for why that is deliberate.
 */
function Endpoint({ workspace }: EndpointProps) {
  if (workspace.state !== "RUNNING") {
    return <span className="muted">{workspace.hostname}</span>;
  }
  return (
    <a href={`/workspaces/open?host=${encodeURIComponent(workspace.hostname)}`} target="_blank" rel="noreferrer">
      {workspace.hostname}
    </a>
  );
}

interface StateBadgeProps {
  readonly state: WorkspaceState;
}

function StateBadge({ state }: StateBadgeProps) {
  return <span className={`state state-${state.toLowerCase()}`}>{state}</span>;
}

/** DELETING is already under way and DELETED is finished, so neither is offered. */
function isDeletable(state: WorkspaceState): boolean {
  return state !== "DELETING" && state !== "DELETED";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "\u2014" : date.toLocaleString();
}
