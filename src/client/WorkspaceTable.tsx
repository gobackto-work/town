import { Fragment, useState } from "react";
import type { Run, Workspace, WorkspaceState } from "../shared/types.ts";

/**
 * What a run's state means to a person, rather than to the record.
 *
 * A total map and not a switch. A switch with no default renders a blank cell for a state
 * nobody thought about; a map makes that state a compile error instead.
 */
const RUN_SUMMARY: Record<Run["state"], string> = {
  running: "working",
  waiting: "waiting for you",
  succeeded: "finished",
  failed: "failed",
  cancelled: "stopped",
  budget_exhausted: "hit its limit",
};

interface TableProps {
  readonly workspaces: Workspace[];
  /**
   * Every run the owner has, for every workspace on the page.
   *
   * Passed whole and grouped here rather than per row, because it arrives whole: the
   * stream carries one list and the table is the only thing that knows which row a run
   * belongs to.
   */
  readonly runs: Run[];
  /** Runs that changed in the last stream message, so their row can be marked. */
  readonly flashed: ReadonlySet<string>;
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

export function WorkspaceTable({
  workspaces,
  runs,
  flashed,
  busy,
  ownerId,
  onRemove,
  onRetry,
}: TableProps) {
  if (workspaces.length === 0) {
    return <p className="empty">No workspaces yet.</p>;
  }

  const byWorkspace = new Map<string, Run[]>();
  for (const run of runs) {
    const held = byWorkspace.get(run.workspaceId);
    if (held === undefined) {
      byWorkspace.set(run.workspaceId, [run]);
    } else {
      held.push(run);
    }
  }

  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Slug</th>
          <th scope="col">State</th>
          <th scope="col">Endpoint</th>
          <th scope="col">Created</th>
          <th scope="col">Runs</th>
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
            runs={byWorkspace.get(workspace.id) ?? []}
            flashed={flashed}
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
  readonly runs: Run[];
  readonly flashed: ReadonlySet<string>;
  readonly busy: boolean;
  /** True when the signed-in member owns it, and may therefore change it. */
  readonly mine: boolean;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}

function Row({ workspace, runs, flashed, busy, mine, onRemove, onRetry }: RowProps) {
  const { state, id } = workspace;
  const [open, setOpen] = useState(false);
  const panel = `runs-${workspace.id}`;
  // Marked while any of this workspace's runs changed. The count is a count; the flash is
  // what says "look here", because a run moving from running to waiting does not move it.
  const marked = runs.some((run) => flashed.has(run.id));

  return (
    <Fragment>
      <tr className={marked ? "changed" : undefined}>
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
        <td className="runs-cell">
          <RunBadge count={runs.length} open={open} marked={marked} panel={panel} onToggle={() => setOpen((was) => !was)} />
        </td>
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
      {open && (
        <tr className="runs-panel">
          <td colSpan={6}>
            <RunList id={panel} runs={runs} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

interface RunBadgeProps {
  readonly count: number;
  readonly open: boolean;
  readonly marked: boolean;
  readonly panel: string;
  readonly onToggle: () => void;
}

/**
 * The run count, and the control that opens the list.
 *
 * A button rather than a bare number, so the row is reachable and the state of the panel
 * is announced. With no runs there is nothing to open, so it is a plain number and not a
 * control that does nothing.
 */
function RunBadge({ count, open, marked, panel, onToggle }: RunBadgeProps) {
  if (count === 0) {
    return <span className="muted">(0)</span>;
  }
  return (
    <button
      type="button"
      className={marked ? "badge changed" : "badge"}
      aria-expanded={open}
      aria-controls={panel}
      onClick={onToggle}
    >
      ({count}) <span aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span>
    </button>
  );
}

interface RunListProps {
  readonly id: string;
  readonly runs: Run[];
}

/** The runs of one workspace, most recently changed first, which is the order they arrive. */
function RunList({ id, runs }: RunListProps) {
  if (runs.length === 0) {
    return <p className="empty">No runs yet.</p>;
  }
  return (
    <ul className="runs" id={id}>
      {runs.map((run) => (
        <li key={run.id}>
          <span className={run.state === "waiting" ? "run-state waiting" : "run-state"}>
            {RUN_SUMMARY[run.state]}
          </span>
          <span className="muted small">{formatTime(run.updatedAt)}</span>
          <code className="muted small">{run.id}</code>
        </li>
      ))}
    </ul>
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
