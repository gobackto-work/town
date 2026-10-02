import "./test-setup.ts"; // MUST be first: it installs the DOM react-dom needs.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App.tsx";

afterEach(cleanup);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stub(t: TestContext, respond: (path: string) => Response): void {
  t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    return Promise.resolve(respond(urlOf(input)));
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

const USER = { ownerId: "github#583231", login: "octocat", name: "The Octocat" };

test("shows a sign-in link when the API says nobody is signed in", async (t) => {
  stub(t, () => json({ error: { code: "unauthorized", message: "sign in with GitHub" } }, 401));
  render(<App />);

  const link = await screen.findByRole("link", { name: /sign in with github/i });
  assert.equal(link.getAttribute("href"), "/auth/login");
});

test("a 401 is not dressed up as an error", async (t) => {
  // Being signed out is an answer, not a failure. An error banner here would tell people
  // something is broken when nothing is.
  stub(t, () => json({ error: { code: "unauthorized", message: "sign in with GitHub" } }, 401));
  render(<App />);
  await screen.findByRole("link", { name: /sign in with github/i });
  assert.equal(screen.queryByRole("alert"), null);
});

test("shows the workspaces once someone is signed in", async (t) => {
  stub(t, (path) =>
    path === "/api/me"
      ? json({ user: USER })
      : json({
          workspaces: [
            {
              id: "01ABC",
              slug: "golden-vole-6w4q",
              ownerId: USER.ownerId,
              namespace: "ws-golden-vole-6w4q",
              hostname: "golden-vole-6w4q.gobackto.work",
              url: "https://golden-vole-6w4q.gobackto.work",
              state: "RUNNING",
              createdAt: "2026-09-27T05:00:00Z",
              lastActiveAt: "2026-09-27T05:00:00Z",
              deletedAt: null,
              lastError: "",
              limits: { cpu: "500m", memory: "768Mi", storage: "20Gi", maxAgents: 3 },
            },
          ],
        }),
  );
  render(<App />);

  assert.ok(await screen.findByText("golden-vole-6w4q"));
  assert.ok(screen.getByText("The Octocat"));
  assert.equal(screen.queryByRole("link", { name: /sign in/i }), null);
});

test("an API failure is reported as itself, not as being signed out", async (t) => {
  stub(t, () => json({ error: { code: "upstream_error", message: "control plane is unreachable" } }, 502));
  render(<App />);

  const banner = await screen.findByRole("alert");
  assert.match(banner.textContent ?? "", /control plane is unreachable/);
});
