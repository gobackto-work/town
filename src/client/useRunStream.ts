import { useEffect, useRef, useState } from "react";
import type { Run, RunUpdate } from "../shared/types.ts";

/** How long a row stays marked after its run changed. */
const FLASH_MS = 2000;

/** Whether the stream is connected. A person needs to know when the table is stale. */
export type StreamStatus = "connecting" | "live" | "offline";

export interface RunsController {
  runs: Run[];
  status: StreamStatus;
  /** The runs that changed in the most recent message, cleared after FLASH_MS. */
  flashed: ReadonlySet<string>;
}

/**
 * Owns the run log, from the server's stream.
 *
 * One connection to the BFF and no polling in the browser. The server decides what
 * changed, so this holds no timer and cannot freeze the way a gated interval does: a run
 * that starts while the page is open arrives on its own.
 *
 * EventSource reconnects by itself, so `onerror` changes the label and does not tear
 * anything down. The status is the point: without it, a table that has quietly stopped
 * updating looks exactly like a table with nothing happening in it.
 */
export function useRunStream(): RunsController {
  const [runs, setRuns] = useState<Run[]>([]);
  // Computed once and not set from the effect body: a browser without EventSource is
  // offline before anything has been attempted.
  const [status, setStatus] = useState<StreamStatus>(() =>
    typeof EventSource === "undefined" ? "offline" : "connecting",
  );
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(new Set());
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return undefined;
    }
    const source = new EventSource("/api/stream");

    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus(source.readyState === EventSource.CONNECTING ? "connecting" : "offline");

    const onRuns = (event: MessageEvent<string>) => {
      const update = JSON.parse(event.data) as RunUpdate;
      setRuns(update.runs);
      setStatus("live");
      if (update.changed.length === 0) {
        return;
      }
      setFlashed(new Set(update.changed));
      if (flash.current !== undefined) {
        clearTimeout(flash.current);
      }
      flash.current = setTimeout(() => setFlashed(new Set()), FLASH_MS);
    };
    source.addEventListener("runs", onRuns);

    return () => {
      source.close();
      if (flash.current !== undefined) {
        clearTimeout(flash.current);
      }
    };
  }, []);

  return { runs, status, flashed };
}
