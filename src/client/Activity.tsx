import type { Run, Workspace } from "../shared/types.ts";

/**
 * What a run's state means to a person, rather than to the record.
 *
 * A total map and not a switch. A switch with no default renders a blank cell for a state
 * nobody thought about; a map makes that state a compile error instead.
 */
const SUMMARY: Record<Run["state"], string> = {
  running: "working",
  waiting: "waiting for you",
  succeeded: "finished",
  failed: "failed",
  cancelled: "stopped",
  budget_exhausted: "hit its limit",
};

interface ActivityProps {
  readonly runs: Run[];
  /** Every workspace, so a run in a deleted one still shows a name. */
  readonly workspaces: Workspace[];
  readonly onRefresh: () => void;
}

/**
 * The signed-in owner's recent runs.
 *
 * "Waiting for you" is the state worth looking at: it is the one a notification will carry,
 * because it means an agent has stopped and cannot continue without a person. Everything else
 * is history.
 */
export function Activity({ runs, workspaces, onRefresh }: ActivityProps) {
  const slugOf = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.slug]),
  );

  return (
    <section className="activity">
      <div className="toolbar">
        <h2>Recent activity</h2>
        <button type="button" className="secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="empty">No runs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">State</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                {/* The record carries a workspace id and not a slug, because it does not
                    duplicate the registry. The join belongs here. */}
                <td>{slugOf.get(run.workspaceId) ?? run.workspaceId}</td>
                <td
                  className={
                    run.state === "waiting" ? "state waiting" : "state"
                  }
                >
                  {SUMMARY[run.state]}
                </td>
                <td className="muted small">{when(run.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * A UTC timestamp to the minute.
 *
 * Deliberately not localised and not relative. A fixed format is one thing to reason about in
 * a test and in a log, and how a browser would prefer to render a time is not this record's
 * business.
 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return at.toISOString().slice(0, 16).replace("T", " ");
}
