import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackUrl, loadConfig } from "./config.ts";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_ORG: "gobackto-work",
  SESSION_SECRET: "s".repeat(40),
};

test("refuses to start without authentication configured", () => {
  // The load-bearing property: a town that cannot identify anyone is an unauthenticated
  // workspace-provisioning API, and the surest way never to deploy one is to make it
  // impossible to start.
  assert.throws(() => loadConfig({}), /refuses to start without authentication/);
});

test("names every missing variable at once, not one per attempt", () => {
  assert.throws(() => loadConfig({}), /GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ORG, SESSION_SECRET/);
});

test("treats an empty variable as missing", () => {
  // An unset value in a manifest frequently arrives as an empty string.
  assert.throws(() => loadConfig({ ...REQUIRED_ENV, SESSION_SECRET: "" }), /SESSION_SECRET/);
});

test("defaults everything that is not authentication", () => {
  const config = loadConfig(REQUIRED_ENV);
  assert.equal(config.port, 8080);
  assert.equal(config.staticDir, "dist/client");
  assert.equal(config.publicUrl, "https://town.gobackto.work");
  assert.match(config.controlPlaneUrl, /^http/);
  assert.equal(config.sessionTtlSeconds, 12 * 60 * 60);
  assert.equal(config.assertion.audience, "pestilence-api");
  assert.equal(config.assertion.ttlSeconds, 120);
  assert.equal(config.assertion.keyFile, "/var/run/town/assertion-key.pem");
});

test("org names are normalised, because GitHub's are case-insensitive", () => {
  // Comparing two casings of the same org is a bug waiting to happen.
  assert.equal(loadConfig({ ...REQUIRED_ENV, GITHUB_ORG: "GoBackTo-Work" }).github.org, "gobackto-work");
});

test("a trailing slash on the public URL does not double up in the callback", () => {
  const config = loadConfig({ ...REQUIRED_ENV, TOWN_URL: "https://town.test/" });
  assert.equal(callbackUrl(config), "https://town.test/auth/callback");
});

test("the callback URL is what must be registered on the GitHub app", () => {
  assert.equal(callbackUrl(loadConfig(REQUIRED_ENV)), "https://town.gobackto.work/auth/callback");
});

test("PORT is honoured, and a blank one means the default rather than zero", () => {
  assert.equal(loadConfig({ ...REQUIRED_ENV, PORT: "3000" }).port, 3000);
  assert.equal(loadConfig({ ...REQUIRED_ENV, PORT: "" }).port, 8080);
});

test("an unparseable PORT stops the process instead of picking another port", () => {
  for (const bad of ["abc", "0", "-1", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ ...REQUIRED_ENV, PORT: bad }), /PORT must be an integer/);
  }
});

test("an unparseable TTL is refused rather than defaulted", () => {
  for (const bad of ["abc", "0", "-5"]) {
    assert.throws(() => loadConfig({ ...REQUIRED_ENV, SESSION_TTL_SECONDS: bad }), /SESSION_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...REQUIRED_ENV, ASSERTION_TTL_SECONDS: bad }), /ASSERTION_TTL_SECONDS/);
  }
});
