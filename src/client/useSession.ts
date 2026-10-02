import { useEffect, useState } from "react";
import type { Identity } from "../shared/types.ts";
import { api, isUnauthorized, messageOf } from "./api.ts";

export interface SessionState {
  user: Identity | null;
  /** True only until the first answer arrives, so the UI can avoid flashing a sign-in link. */
  loading: boolean;
  /** Set when the question could not be asked, as opposed to being answered "nobody". */
  error: string | null;
}

/**
 * Who is signed in, or nobody.
 *
 * A 401 is an answer, not a failure: it means "sign in", and the UI must not dress it up
 * as an error. Anything else -- the API down, the control plane unreachable -- is a
 * failure, and is surfaced as itself rather than being shown as "you are not signed in",
 * which would send people to re-authenticate to fix something that is not an
 * authentication problem.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ user: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((user) => {
        if (!cancelled) {
          setState({ user, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ user: null, loading: false, error: isUnauthorized(err) ? null : messageOf(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
