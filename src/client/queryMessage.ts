// Reading a message out of the URL, and then getting it out of the URL.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THE PARAMETER HAS TO BE REMOVED
// ────────────────────────────────────────────────────────────────────────────
//
// These messages arrive as query parameters on a redirect, and the page renders whatever
// it finds there. Nothing removed them, so the message was sticky in the worst possible
// way: a single failure left `?edge_error=forbidden` in the address bar, and EVERY
// subsequent reload re-rendered it.
//
// That produced a report of "my own workspaces are forbidden to me" against a system whose
// logs showed every attempt succeeding. The message was real; the failure it described had
// long since been fixed. A stale error is worse than no error, because it is believed.
//
// So the value is read once and stripped. A reload then shows the truth.

/** Reads a message code from the query string and removes it from the URL. */
export function takeQueryCode(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value === null) {
    return null;
  }

  // replaceState, not pushState: this is not a navigation, and a back button that
  // returned to the error would be worse than the error.
  url.searchParams.delete(name);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return value;
}
