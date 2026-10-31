import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run, RunUpdate } from "../shared/types.ts";
import { RunStream } from "./runStream.ts";

/** Fast enough that a test does not wait for a real interval. */
const TICK_MS = 5;

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "01RUN",
    workspaceId: "01ABC",
    state: "running",
    mode: "interactive",
    startedAt: "2026-10-05T01:00:00Z",
    updatedAt: "2026-10-05T01:00:00Z",
    lastSequence: 1,
    ...overrides,
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the stream");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("a new subscriber is answered immediately, and the first read is a baseline", async () => {
  const stream = new RunStream(() => Promise.resolve([run()]), () => {}, TICK_MS);
  const updates: RunUpdate[] = [];
  const stop = stream.subscribe((update) => updates.push(update));

  // Answered before any read: a tab must not wait a full interval to learn that the
  // server knows nothing yet.
  assert.deepEqual(updates[0], { runs: [], changed: [] });

  await until(() => updates.some((update) => update.runs.length === 1));
  // The first read fills the table. It is not a change, so nothing is marked: marking it
  // would flash every row the moment the page opens.
  assert.deepEqual(updates.at(-1)?.changed, []);
  stop();
});

test("a run that changes is reported by id", async () => {
  let current = [run()];
  const stream = new RunStream(() => Promise.resolve(current), () => {}, TICK_MS);
  const updates: RunUpdate[] = [];
  const stop = stream.subscribe((update) => updates.push(update));
  await until(() => updates.at(-1)?.runs.length === 1);

  current = [run({ state: "waiting", updatedAt: "2026-10-05T01:01:00Z", lastSequence: 2 })];
  await until(() => updates.some((update) => update.changed.includes("01RUN")));

  assert.equal(updates.at(-1)?.runs[0]?.state, "waiting");
  stop();
});

test("nothing is sent while nothing changes", async () => {
  const stream = new RunStream(() => Promise.resolve([run()]), () => {}, TICK_MS);
  const updates: RunUpdate[] = [];
  const stop = stream.subscribe((update) => updates.push(update));
  await until(() => updates.length > 0);
  const settled = updates.length;

  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 8));
  assert.equal(updates.length, settled);
  stop();
});

test("a run that disappears is reported even though no id changed", async () => {
  let current = [run()];
  const stream = new RunStream(() => Promise.resolve(current), () => {}, TICK_MS);
  const updates: RunUpdate[] = [];
  const stop = stream.subscribe((update) => updates.push(update));
  await until(() => updates.at(-1)?.runs.length === 1);

  current = [];
  await until(() => updates.at(-1)?.runs.length === 0);
  assert.ok(updates.at(-1)?.changed.length === 0);
  stop();
});

test("the last unsubscribe stops the reading", async () => {
  let reads = 0;
  const stream = new RunStream(
    () => {
      reads += 1;
      return Promise.resolve([run()]);
    },
    () => {},
    TICK_MS,
  );
  const stop = stream.subscribe(() => {});
  await until(() => reads > 0);
  stop();

  assert.equal(stream.size, 0);
  const settled = reads;
  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 8));
  // A page nobody is looking at must not keep reading, which is the whole reason the
  // stream is per owner and stopped on the last tab rather than left running.
  assert.equal(reads, settled);
});

test("a failed read keeps the last known list and does not empty the table", async () => {
  let fail = false;
  const errors: unknown[] = [];
  const stream = new RunStream(
    () => (fail ? Promise.reject(new Error("control plane is down")) : Promise.resolve([run()])),
    (err) => errors.push(err),
    TICK_MS,
  );
  const updates: RunUpdate[] = [];
  const stop = stream.subscribe((update) => updates.push(update));
  await until(() => updates.at(-1)?.runs.length === 1);

  fail = true;
  await until(() => errors.length > 0);
  assert.equal(updates.at(-1)?.runs.length, 1);
  stop();
});
