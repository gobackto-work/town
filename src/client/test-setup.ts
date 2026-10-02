// Installs a DOM before anything imports react-dom.
//
// This module MUST be the first import in a client test. ESM evaluates imports in
// source order, and react-dom reads globals when it is evaluated -- so importing a
// component first fails with "document is not defined", which is a confusing way to
// learn about import ordering.
//
// The client tests run through tsx, and the server tests do not. That asymmetry is
// deliberate and is the point: the server is executed by node with no transform, so
// its tests are too, and they keep the erasable-syntax guarantee honest. The client is
// bundled by vite, so its tests are transformed, exactly as production transforms it.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://town.test/" });

// defineProperty rather than assignment: several of these already exist on globalThis
// in current node (navigator, fetch), and one of them being read-only would otherwise
// fail the whole file.
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};

for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

// React warns on every state update unless it is told it is inside act(). Setting this
// is what makes testing-library's render synchronous rather than a source of noise.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
