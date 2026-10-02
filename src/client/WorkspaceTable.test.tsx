import "./test-setup.ts"; // MUST be first: it installs the DOM react-dom needs.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Workspace, WorkspaceState } from "../shared/types.ts";
import { WorkspaceTable } from "./WorkspaceTable.tsx";

afterEach(cleanup);

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "01ABC",
    slug: "golden-vole-6w4q",
    ownerId: "github#583231",
    namespace: "ws-golden-vole-6w4q",
    hostname: "golden-vole-6w4q.gobackto.work",
    url: "https://golden-vole-6w4q.gobackto.work",
    state: "RUNNING",
    createdAt: "2026-09-27T05:00:00Z",
    lastActiveAt: "2026-09-27T05:00:00Z",
    deletedAt: null,
    lastError: "",
    limits: { cpu: "500m", memory: "768Mi", storage: "20Gi", maxAgents: 3 },
    ...overrides,
  };
}

function renderTable(workspaces: Workspace[], busy = false, ownerId = "github#583231") {
  return render(
    <WorkspaceTable workspaces={workspaces} busy={busy} ownerId={ownerId} onRemove={() => {}} onRetry={() => {}} />,
  );
}

test("says so when there is nothing to show", () => {
  renderTable([]);
  assert.ok(screen.getByText("No workspaces yet."));
});

test("renders one row per workspace, plus a header", () => {
  renderTable([workspace(), workspace({ id: "02DEF", slug: "rapid-crane-tnc4" })]);
  assert.equal(screen.getAllByRole("row").length, 3);
  assert.ok(screen.getByText("golden-vole-6w4q"));
  assert.ok(screen.getByText("rapid-crane-tnc4"));
});

test("links a running workspace, through town rather than straight at the host", () => {
  // Through town because the workspace edge needs a grant, and town is the only party
  // that can mint one: it holds the session, and the workspace's subdomain never sees
  // that cookie. See src/server/edge.ts.
  renderTable([workspace()]);
  const link = screen.getByRole("link");
  assert.equal(link.getAttribute("href"), "/workspaces/open?host=golden-vole-6w4q.gobackto.work");
  // Opening the workspace should not hand the new page a handle on this one.
  assert.equal(link.getAttribute("rel"), "noreferrer");
});

test("does not link a workspace that is not serving", () => {
  // The rule this protects: a link to a workspace still provisioning is a link to a
  // connection error, and offering it teaches the operator to distrust the column.
  for (const state of ["PROVISIONING", "FAILED", "DELETING", "DELETED"] as const satisfies WorkspaceState[]) {
    renderTable([workspace({ state })]);
    assert.equal(screen.queryByRole("link"), null, `${state} should not be linked`);
    assert.ok(screen.getByText("golden-vole-6w4q.gobackto.work"), `${state} should still show the hostname`);
    cleanup();
  }
});

test("offers Delete while a workspace still exists", () => {
  for (const state of ["RUNNING", "PROVISIONING", "FAILED"] as const satisfies WorkspaceState[]) {
    renderTable([workspace({ state })]);
    assert.ok(screen.getByRole("button", { name: "Delete" }), `${state} should be deletable`);
    cleanup();
  }
});

test("does not offer Delete once deletion is under way or done", () => {
  for (const state of ["DELETING", "DELETED"] as const satisfies WorkspaceState[]) {
    renderTable([workspace({ state })]);
    assert.equal(screen.queryByRole("button", { name: "Delete" }), null, `${state} should not be deletable`);
    cleanup();
  }
});

test("offers Retry only for a workspace that failed", () => {
  for (const state of ["RUNNING", "PROVISIONING", "DELETED"] as const satisfies WorkspaceState[]) {
    renderTable([workspace({ state })]);
    assert.equal(screen.queryByRole("button", { name: "Retry" }), null, `${state} should not offer Retry`);
    cleanup();
  }
  renderTable([workspace({ state: "FAILED" })]);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("Delete reports the id it was clicked for", () => {
  const removed: string[] = [];
  render(
    <WorkspaceTable
      workspaces={[workspace()]}
      busy={false}
      ownerId="github#583231"
      onRemove={(id) => removed.push(id)}
      onRetry={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  assert.deepEqual(removed, ["01ABC"]);
});

test("Retry reports the id it was clicked for", () => {
  const retried: string[] = [];
  render(
    <WorkspaceTable
      workspaces={[workspace({ state: "FAILED" })]}
      busy={false}
      ownerId="github#583231"
      onRemove={() => {}}
      onRetry={(id) => retried.push(id)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.deepEqual(retried, ["01ABC"]);
});

test("a colleague's workspace is visible but not actionable", () => {
  // RUNNING, so there IS a link -- which proves the row is fully rendered and the
  // actions are absent because of ownership, not because the row is inert.
  renderTable([workspace({ ownerId: "github#999", state: "RUNNING" })], false, "github#583231");

  assert.ok(screen.getByRole("link"), "a colleague's workspace should still be openable");
  assert.equal(screen.queryByRole("button", { name: "Delete" }), null);
  assert.ok(screen.getByText(/colleague/), "and it should say why the actions are absent");
  cleanup();

  // FAILED too, where the tempting Retry would otherwise appear.
  renderTable([workspace({ ownerId: "github#999", state: "FAILED" })], false, "github#583231");
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
});

// The complement: on your own workspace the actions ARE there, so the test above is not
// passing merely because the buttons are never rendered.
test("your own workspace is actionable", () => {
  renderTable([workspace({ ownerId: "github#583231", state: "FAILED" })], false, "github#583231");
  assert.ok(screen.getByRole("button", { name: "Delete" }));
  assert.ok(screen.getByRole("button", { name: "Retry" }));
  assert.equal(screen.queryByText(/colleague/), null);
});

test("actions are disabled while a request is already in flight", () => {
  renderTable([workspace({ state: "FAILED" })], true);
  assert.equal(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"), true);
  assert.equal(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"), true);
});

test("surfaces the last error on the row, without putting it in the table", () => {
  renderTable([workspace({ state: "FAILED", lastError: "apply Namespace: forbidden" })]);
  // Present as a tooltip. The text is long and usually empty, so it does not get a
  // column of its own.
  assert.ok(screen.getByTitle("apply Namespace: forbidden"));
});

test("shows no error marker when nothing has gone wrong", () => {
  renderTable([workspace()]);
  assert.equal(screen.queryByTitle(/forbidden/), null);
});
