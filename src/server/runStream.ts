// The run log, read on behalf of every open browser tab.
//
// One reader per owner, and not one per tab: the control plane's store takes one writer,
// so reads queue behind writes, and per-tab reads would multiply that queue by the number
// of tabs a person happens to have open. A tab subscribes to this and gets what has
// changed; it does not call the control plane at all.
//
// The reader stops when the last tab goes away. A page nobody is looking at costs one
// interval per open connection and nothing when none is open.

import type { Run, RunUpdate } from "../shared/types.ts";

/** How often the log is re-read while at least one tab is subscribed. */
const DEFAULT_INTERVAL_MS = 2000;

type Listener = (update: RunUpdate) => void;

export class RunStream {
  readonly #read: () => Promise<Run[]>;
  readonly #onError: (err: unknown) => void;
  readonly #intervalMs: number;
  readonly #listeners = new Set<Listener>();

  #timer: ReturnType<typeof setInterval> | undefined;
  #runs: Run[] = [];

  /**
   * Whether the last read is a baseline.
   *
   * The first read after the last tab leaves is a baseline and not a change: the browser
   * has no rows to flash yet, and marking every run as changed on open would make the very
   * first paint flash the whole table.
   */
  #primed = false;

  /** True while a read is in flight, so a slow control plane cannot pile up requests. */
  #reading = false;

  constructor(read: () => Promise<Run[]>, onError: (err: unknown) => void, intervalMs = DEFAULT_INTERVAL_MS) {
    this.#read = read;
    this.#onError = onError;
    this.#intervalMs = intervalMs;
  }

  /** How many listeners are attached. The caller uses this to drop an idle stream. */
  get size(): number {
    return this.#listeners.size;
  }

  /**
   * Attaches a listener and returns the function that detaches it.
   *
   * The listener is called immediately with what is known, which is nothing on the first
   * ever subscribe. It does not wait a full interval to learn that.
   */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener({ runs: this.#runs, changed: [] });
    this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop();
      }
    };
  }

  #start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
    // A stream with no tab attached must not hold the process open. unref is a node
    // method and absent in a browser bundle, hence the optional call.
    this.#timer.unref?.();
    void this.#tick();
  }

  #stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // Dropped as well as unprimed, so the next tab opens on an empty table and then fills,
    // rather than flashing rows that changed while nobody was watching.
    this.#runs = [];
    this.#primed = false;
  }

  async #tick(): Promise<void> {
    if (this.#reading) {
      return;
    }
    this.#reading = true;
    try {
      const runs = await this.#read();
      const changed = this.#primed ? changedIDs(this.#runs, runs) : [];
      this.#primed = true;
      if (changed.length === 0 && runs.length === this.#runs.length) {
        return;
      }
      this.#runs = runs;
      const update: RunUpdate = { runs, changed };
      for (const listener of this.#listeners) {
        listener(update);
      }
    } catch (err) {
      // The stream keeps its last known list. A control plane that is down must not empty
      // the table, because "unreachable" and "no runs" are different facts.
      this.#onError(err);
    } finally {
      this.#reading = false;
    }
  }
}

/**
 * The ids of the runs that are new, or whose state or timestamp moved.
 *
 * `lastSequence` is the record's own notion of order, so it catches a transition whose
 * timestamp is identical to the one before it. A run that disappeared is not named: the
 * list is replaced wholesale and the row goes with it.
 */
function changedIDs(before: Run[], after: Run[]): string[] {
  const known = new Map(before.map((run) => [run.id, run]));
  const changed: string[] = [];
  for (const run of after) {
    const previous = known.get(run.id);
    if (
      previous === undefined ||
      previous.state !== run.state ||
      previous.updatedAt !== run.updatedAt ||
      previous.lastSequence !== run.lastSequence
    ) {
      changed.push(run.id);
    }
  }
  return changed;
}
