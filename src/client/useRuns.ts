import { useCallback, useEffect, useState } from "react";
import type { Run } from "../shared/types.ts";
import { api, messageOf } from "./api.ts";
import { usePolling } from "./usePolling.ts";

/** How often to re-read while a run is still going. */
const POLL_MS = 2000;

/**
 * The states a run can still leave.
 *
 * A run that is waiting for a person is not finished, so it keeps the view polling: the person
 * may answer, and the view should follow that without being reloaded by hand.
 */
const UNFINISHED: readonly Run["state"][] = ["running", "waiting"];

export interface RunsController {
  runs: Run[];
  error: string | null;
  refresh: () => void;
}

/**
 * Owns the run log.
 *
 * On request, and reading costs nothing on the control plane's side, so this can be called as
 * often as someone likes. It re-reads while a run is still going and stops as soon as nothing
 * is, which is what makes the view move on its own without a stream.
 *
 * This reads the LOG and not the event queue. The queue has a cursor, and the lowest cursor is
 * also what the record uses to decide what it may discard, so a view reading the queue would
 * stop the record pruning for every user who ever opened it.
 */
export function useRuns(): RunsController {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await api.runs());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  // react-hooks/set-state-in-effect cannot see through `load`: the setState happens in a
  // promise continuation, not synchronously in the effect body, so there is no cascading
  // render to avoid. The same exception useWorkspaces takes, for the same reason.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  usePolling(
    runs.some((run) => UNFINISHED.includes(run.state)),
    load,
    POLL_MS,
  );

  return { runs, error, refresh: () => void load() };
}
