import { useState } from "react";
import type { EdgeFailureCode, Identity } from "../shared/types.ts";
import { takeQueryCode } from "./queryMessage.ts";
import { WorkspaceTable } from "./WorkspaceTable.tsx";
import { useWorkspaces } from "./useWorkspaces.ts";

/**
 * Why the workspace edge turned the browser away.
 *
 * `forbidden` and `not_found` are told apart even though pestilence answers the same 404
 * for "no such workspace" and "not running yet": from here, "that is not yours" and
 * "there is nothing to open yet" are different things to say to a person.
 */
const EDGE_ERRORS: Record<EdgeFailureCode, string> = {
  forbidden: "That workspace belongs to somebody else.",
  not_found: "That workspace is not running, so there is nothing to open yet.",
  malformed: "That link was not a workspace address.",
};

function edgeError(): string | null {
  // Read ONCE and remove it from the URL. Left in place, one failure re-renders on every
  // reload forever, and the person reporting it is describing a bug that was fixed.
  const code = takeQueryCode("edge_error");
  return code === null ? null : (EDGE_ERRORS[code as EdgeFailureCode] ?? "That workspace could not be opened.");
}

interface WorkspacesProps {
  readonly user: Identity;
}

export function Workspaces({ user }: WorkspacesProps) {
  const { workspaces, error, busy, refresh, create, remove, retry } = useWorkspaces();
  const refused = edgeError();

  // DELETED is a RECORD, not a resource: the namespace and the broker are long gone, and
  // the row is history. Records are never removed from the store, so without this the list
  // accumulates every workspace ever created -- including the ones from before
  // authentication existed, which now belong to nobody and can never be actioned.
  const [showDeleted, setShowDeleted] = useState(false);
  const deleted = workspaces.filter((w) => w.state === "DELETED");
  const visible = showDeleted ? workspaces : workspaces.filter((w) => w.state !== "DELETED");

  return (
    <>
      <header className="bar">
        <div>
          <h1>town</h1>
          <p className="sub">Pi agent workspaces</p>
        </div>
        <div className="who">
          <span className="muted">{user.name ?? user.login}</span>
          <form action="/auth/logout" method="post">
            <button type="submit" className="secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {refused !== null && (
        <p className="banner" role="alert">
          {refused}
        </p>
      )}

      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      <div className="toolbar">
        <button type="button" onClick={create} disabled={busy}>
          New workspace
        </button>
        <button type="button" className="secondary" onClick={refresh} disabled={busy}>
          Refresh
        </button>
        {deleted.length > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            Show {deleted.length} deleted
          </label>
        )}
      </div>

      <WorkspaceTable
        workspaces={visible}
        busy={busy}
        ownerId={user.ownerId}
        onRemove={remove}
        onRetry={retry}
      />
    </>
  );
}
