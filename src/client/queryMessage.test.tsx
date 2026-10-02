import "./test-setup.ts"; // MUST be first: it installs the DOM react-dom needs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { takeQueryCode } from "./queryMessage.ts";

/** jsdom gives each test the same URL unless it is reset, so reset it explicitly. */
function at(url: string): void {
  window.history.replaceState(null, "", url);
}

test("reads the code and removes it from the URL", () => {
  at("/?edge_error=forbidden");
  assert.equal(takeQueryCode("edge_error"), "forbidden");
  // This is the whole point: left in place, one failure re-renders on every reload
  // forever, and the person reporting it describes a bug that was already fixed.
  assert.equal(window.location.search, "");
});

test("keeps unrelated parameters", () => {
  at("/?edge_error=forbidden&keep=1");
  assert.equal(takeQueryCode("edge_error"), "forbidden");
  assert.equal(window.location.search, "?keep=1");
});

test("a second read returns nothing, which is what makes a reload show the truth", () => {
  at("/?edge_error=forbidden");
  assert.equal(takeQueryCode("edge_error"), "forbidden");
  assert.equal(takeQueryCode("edge_error"), null);
});

test("returns null when the parameter is absent, without touching the URL", () => {
  at("/?something=else");
  assert.equal(takeQueryCode("edge_error"), null);
  assert.equal(window.location.search, "?something=else");
});

test("preserves the hash", () => {
  at("/?edge_error=malformed#section");
  assert.equal(takeQueryCode("edge_error"), "malformed");
  assert.equal(window.location.hash, "#section");
});
