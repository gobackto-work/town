import { useEffect } from "react";

/**
 * Calls load on an interval while something is still changing.
 *
 * Polling rather than a stream: the payloads are small, the changes take seconds, and a
 * websocket would be more moving parts than the problem has. Revisit if something can be in
 * flight for minutes, which would make a fixed interval the wrong shape.
 */
export function usePolling(
  active: boolean,
  load: () => Promise<void>,
  intervalMs: number,
): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [active, load, intervalMs]);
}
