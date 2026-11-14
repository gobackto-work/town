import "./test-setup.ts"; // MUST be first: it installs the DOM react-dom needs.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Workspace } from "../shared/types.ts";
import { Workspaces } from "./Workspaces.tsx";

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

interface Call {
  method: string;
  path: string;
}

type Responder = (method: string, path: string) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function listOf(workspaces: Workspace[]): Response {
  return json({ workspaces });
}

/** Records what was asked for, and answers from the given responder. */
function stubApi(t: TestContext, respond: Responder): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = urlOf(input);
    calls.push({ method, path });
    return Promise.resolve(respond(method, path));
  });
  return calls;
}

/**
 * A stand-in for the browser's EventSource.
 *
 * The page no longer reads the run log with fetch, so a fetch stub cannot answer for it.
 * The tests drive this by hand: `open()` is the connection coming up, and `emit()` is the
 * server saying that something changed.
 */
/**
 * The stream the page most recently opened.
 *
 * A module binding and not a static on the class: a public static that has to be
 * reassigned cannot be readonly, and the class's other statics rightly are.
 */
const opened: { last: FakeEventSource | undefined } = { last: undefined };

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    opened.last = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const held = this.#listeners.get(type) ?? new Set();
    held.add(listener);
    this.#listeners.set(type, held);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Installs the fake for one test and removes it afterwards. */
function stubEventSource(t: TestContext): void {
  const globals = globalThis as Record<string, unknown>;
  // Assigned rather than mocked: EventSource does not exist in this DOM at all, and
  // mock.method refuses a property that is not already a function.
  const original = globals.EventSource;
  globals.EventSource = FakeEventSource;
  t.after(() => {
    opened.last = undefined;
    if (original === undefined) {
      delete globals.EventSource;
    } else {
      globals.EventSource = original;
    }
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function countOf(calls: Call[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

/**
 * The GETs of the workspace list.
 *
 * A test about the list means this and not every GET: the page also reads the run log on
 * mount, and counting both makes an assertion about one depend on the other.
 */
function listCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === "GET" && call.path === "/api/workspaces");
}

/** A promise a test can resolve by hand, to hold a request open. */
function deferred() {
  let settle: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

test("shows the workspaces the API returned", async (t) => {
  stubApi(t, () => listOf([workspace(), workspace({ id: "02DEF", slug: "rapid-crane-tnc4" })]));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  assert.ok(await screen.findByText("golden-vole-6w4q"));
  assert.ok(screen.getByText("rapid-crane-tnc4"));
});

test("shows the API's error rather than an empty table", async (t) => {
  // The distinction the whole error design exists for: "nothing is here" and "I could
  // not ask" must not look the same.
  stubApi(t, () => json({ error: { code: "control_plane_unreachable", message: "control plane unreachable" } }, 502));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  const banner = await screen.findByRole("alert");
  assert.match(banner.textContent ?? "", /control plane unreachable/);
  assert.match(banner.textContent ?? "", /control_plane_unreachable/);
});

test("New workspace posts, then re-reads the list", async (t) => {
  const calls = stubApi(t, (method) => (method === "POST" ? json(workspace(), 201) : listOf([workspace()])));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await screen.findByText("golden-vole-6w4q");

  fireEvent.click(screen.getByRole("button", { name: "New workspace" }));

  await waitFor(() => assert.equal(countOf(calls, "POST"), 1));
  await waitFor(() => assert.equal(listCalls(calls).length, 2));
  // The re-read comes AFTER the action: provisioning is not something the browser can
  // predict, so every action re-reads rather than applying its own guess.
  const posted = calls.findIndex((call) => call.method === "POST");
  assert.ok(listCalls(calls).some((call) => calls.indexOf(call) > posted));
});

test("Delete deletes the workspace it belongs to, then re-reads the list", async (t) => {
  const calls = stubApi(t, (method) => (method === "DELETE" ? json(workspace({ state: "DELETING" })) : listOf([workspace()])));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await screen.findByText("golden-vole-6w4q");

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await waitFor(() => assert.equal(countOf(calls, "DELETE"), 1));
  assert.equal(calls.find((call) => call.method === "DELETE")?.path, "/api/workspaces/01ABC");
  await waitFor(() => assert.equal(listCalls(calls).length, 2));
});

test("a failed action reports the error instead of leaving the button enabled", async (t) => {
  stubApi(t, (_method, path) =>
    path === "/api/workspaces/01ABC" ? json({ error: { code: "not_found", message: "no such workspace" } }, 404) : listOf([workspace()]),
  );
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await screen.findByText("golden-vole-6w4q");

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  const banner = await screen.findByRole("alert");
  assert.match(banner.textContent ?? "", /no such workspace/);
  // The button comes back, so the operator can try again rather than being stuck.
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"), false));
});

test("actions are disabled while a request is outstanding", async (t) => {
  const pending = deferred();
  stubApi(t, (method) => (method === "POST" ? pending.promise : listOf([])));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Delete" }), null));

  fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "New workspace" }).hasAttribute("disabled"), true));

  pending.resolve(json(workspace(), 201));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "New workspace" }).hasAttribute("disabled"), false));
});

test("re-reads the list while a workspace is still in flight", async (t) => {
  // Real time rather than fake timers: the assertion is that the list is actually
  // re-fetched, not merely that an interval was scheduled. 2s is the poll interval and
  // the price of testing the behaviour instead of the implementation.
  const calls = stubApi(t, () => listOf([workspace({ state: "PROVISIONING" })]));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await screen.findByText("golden-vole-6w4q");
  assert.equal(listCalls(calls).length, 1);

  await waitFor(() => assert.ok(listCalls(calls).length >= 2), { timeout: 4000 });
  cleanup(); // stops the interval, so it does not outlive the test
});

test("deleted workspaces are records, not rows", async (t) => {
  // Records are never removed from the store, so without this the list accumulates every
  // workspace ever created -- including the ones from before authentication existed, which
  // belong to nobody and can never be actioned.
  stubApi(t, () =>
    listOf([
      workspace({ id: "01LIVE", slug: "live-one", state: "RUNNING" }),
      workspace({ id: "01GONE", slug: "gone-one", state: "DELETED" }),
    ]),
  );
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: null }} />);

  assert.ok(await screen.findByText("live-one"));
  assert.equal(screen.queryByText("gone-one"), null, "a deleted record should not take a row by default");

  // ...but it is still there, and reachable, rather than hidden outright.
  fireEvent.click(screen.getByRole("checkbox", { name: /show 1 deleted/i }));
  assert.ok(screen.getByText("gone-one"));
});

test("no toggle when nothing has been deleted", async (t) => {
  stubApi(t, () => listOf([workspace({ state: "RUNNING" })]));
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: null }} />);
  await screen.findByText("golden-vole-6w4q");
  assert.equal(screen.queryByRole("checkbox"), null);
});

test("shows the runs of a workspace in the table, and opens them in place", async (t) => {
  // The record carries a workspace id and not a slug, because it does not duplicate the
  // registry. Without the grouping the badge would count nothing and the list would have
  // nowhere to appear.
  stubApi(t, () => listOf([workspace({ id: "01ABC", slug: "golden-vole-6w4q" })]));
  stubEventSource(t);
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: "The Octocat" }} />);
  await screen.findByText("golden-vole-6w4q");

  const source = opened.last;
  assert.ok(source !== undefined, "the page opens a stream");
  act(() => {
    source.open();
    source.emit("runs", {
      runs: [
        {
          id: "01RUN",
          workspaceId: "01ABC",
          state: "waiting",
          mode: "interactive",
          startedAt: "2026-10-05T01:00:00Z",
          updatedAt: "2026-10-05T01:05:00Z",
          lastSequence: 4,
        },
      ],
      changed: [],
    });
  });

  // The badge is the count, and it is also the control that opens the list.
  const badge = await screen.findByRole("button", { name: /\(1\)/ });
  assert.equal(badge.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("waiting for you"), null, "collapsed by default");

  fireEvent.click(badge);
  assert.equal(badge.getAttribute("aria-expanded"), "true");
  // "waiting for you" rather than "waiting": the state is the record's word, and this is
  // a person reading it.
  assert.ok(await screen.findByText("waiting for you"));

  fireEvent.click(badge);
  await waitFor(() => assert.equal(screen.queryByText("waiting for you"), null));
});

test("marks the row while the stream reports a change", async (t) => {
  stubApi(t, () => listOf([workspace({ id: "01ABC" })]));
  stubEventSource(t);
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: null }} />);
  await screen.findByText("golden-vole-6w4q");

  const source = opened.last;
  assert.ok(source !== undefined);
  const at = "2026-10-05T01:05:00Z";
  const run = { id: "01RUN", workspaceId: "01ABC", state: "waiting" as const, mode: "interactive" as const, startedAt: at, updatedAt: at, lastSequence: 4 };
  act(() => {
    source.open();
    source.emit("runs", { runs: [run], changed: ["01RUN"] });
  });

  const badge = await screen.findByRole("button", { name: /\(1\)/ });
  await waitFor(() => assert.ok(badge.classList.contains("changed")));
  // The mark is temporary, so a table left open does not stay red for ever.
  await waitFor(() => assert.ok(!badge.classList.contains("changed")), { timeout: 4_000 });
});

test("says whether the stream is live", async (t) => {
  stubApi(t, () => listOf([workspace()]));
  stubEventSource(t);
  render(<Workspaces user={{ ownerId: "github#583231", login: "octocat", name: null }} />);
  await screen.findByText("golden-vole-6w4q");

  assert.ok(screen.getByText("connecting"));
  const source = opened.last;
  assert.ok(source !== undefined);
  act(() => {
    source.open();
  });
  assert.ok(await screen.findByText("live"));
});
