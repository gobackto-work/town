import { useCallback, useEffect, useState } from "react";
import { IN_FLIGHT_STATES, type Workspace } from "../shared/types.ts";
import { api, messageOf } from "./api.ts";

/** How often to re-read while something is still changing. */
const POLL_MS = 2000;

export interface WorkspacesController {
  workspaces: Workspace[];
  error: string | null;
  busy: boolean;
  refresh: () => void;
  create: () => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}

/**
 * Owns the workspace list and the actions that change it.
 *
 * Every action re-reads the list afterwards rather than applying its own optimistic
 * update. Provisioning is not something the browser can predict -- the control plane
 * decides the slug, then moves through states on its own schedule -- so a local guess
 * would be wrong more often than it was fast.
 */
export function useWorkspaces(): WorkspacesController {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setWorkspaces(await api.list());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  // react-hooks/set-state-in-effect cannot see through `load`: the setState happens in
  // a promise continuation, not synchronously in the effect body, so there is no
  // cascading render to avoid. Loading the list on mount is the pattern this app is
  // built on, and the alternative -- inventing a subscription to satisfy the rule --
  // would be worse code. The rule stays on everywhere else.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  usePolling(workspaces, load);

  // The error is set AFTER the re-read, not before. `load` clears any previous error
  // when it succeeds, so setting this first would let the refresh wipe the message the
  // operator needs -- a failed delete would look like nothing happened at all.
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      let failure: string | null = null;
      try {
        await action();
      } catch (err) {
        failure = messageOf(err);
      } finally {
        setBusy(false);
        await load();
      }
      setError(failure);
    },
    [load],
  );

  return {
    workspaces,
    error,
    busy,
    refresh: () => void load(),
    create: () => void act(() => api.create({})),
    remove: (id) => void act(() => api.remove(id)),
    retry: (id) => void act(() => api.retry(id)),
  };
}

/**
 * Re-reads the list while anything is still in flight.
 *
 * Polling rather than a stream: provisioning takes seconds, the list is small, and a
 * websocket would be more moving parts than the problem has. Revisit if a workspace
 * can be in flight for minutes, which would make the interval the wrong shape.
 */
function usePolling(workspaces: Workspace[], load: () => Promise<void>): void {
  const inFlight = workspaces.some((workspace) => IN_FLIGHT_STATES.includes(workspace.state));
  useEffect(() => {
    if (!inFlight) {
      return undefined;
    }
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);
}
