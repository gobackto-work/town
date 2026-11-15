import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../shared/errors.ts";
import { ControlPlaneClient } from "./pestilence.ts";

const url = process.env.PLATFORM_CONTRACT_URL;

test("reads a scarab report from the real pestilence API", { skip: url === undefined }, async () => {
  assert.ok(url);
  const tokenFile = process.env.PLATFORM_CONTRACT_OWNER_TOKEN_FILE;
  const otherTokenFile = process.env.PLATFORM_CONTRACT_OTHER_TOKEN_FILE;
  assert.ok(tokenFile);
  assert.ok(otherTokenFile);
  const token = readFileSync(tokenFile, "utf8");
  const otherToken = readFileSync(otherTokenFile, "utf8");
  const runs = await new ControlPlaneClient(url, token).runs();
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.ok(run);
  assert.equal(run.id, process.env.PLATFORM_CONTRACT_RUN_ID);
  assert.equal(run.workspaceId, process.env.PLATFORM_CONTRACT_WORKSPACE_ID);
  assert.equal(run.state, "waiting");
  assert.equal(run.mode, "interactive");
  assert.ok(Number.isFinite(Date.parse(run.startedAt)));
  assert.ok(Number.isFinite(Date.parse(run.updatedAt)));
  assert.equal(run.endedAt, undefined);
  assert.ok(Number.isSafeInteger(run.lastSequence) && run.lastSequence > 0);
  assert.deepEqual(await new ControlPlaneClient(url, otherToken).runs(), []);
  await assert.rejects(new ControlPlaneClient(url, "invalid").runs(), (error: unknown) =>
    error instanceof ApiError && error.status === 401,
  );
});
