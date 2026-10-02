// Cookie names, and the `__Host-` prefix.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THE PREFIX MATTERS HERE
// ────────────────────────────────────────────────────────────────────────────
//
// A tenant workspace is `https://<slug>.gobackto.work` -- a SIBLING subdomain of town's
// own hostname, serving content the tenant controls. A tenant can therefore set a cookie
// with `Domain=.gobackto.work`, which the browser will then send to town and to every
// other workspace.
//
// Without the prefix, that means a tenant can plant a cookie named `town_session` and
// shadow town's real one. The value is signed so it cannot be FORGED, but the browser
// sends both, and which one town reads is not something town controls -- so the effect is
// a cross-tenant denial of service: one tenant logs out every other user.
//
// Browsers enforce that a `__Host-` cookie is host-only, Secure, and Path=/. A cookie
// with a Domain attribute cannot use the prefix at all, so no tenant can create one with
// this name. That is what makes the prefix load-bearing rather than cosmetic.
//
// Over plain HTTP the browser rejects the prefix outright, which is why it is applied
// only when town is serving over TLS. In the cluster that is always; local development
// over http gets the bare name and the weaker guarantee, which is a deliberate trade
// rather than an oversight.

export const COOKIE_SESSION = "town_session";
export const COOKIE_STATE = "town_oauth_state";
export const COOKIE_EDGE = "town_edge";

/** The name to use, prefixed when the cookie can be Secure. */
export function cookieName(base: string, secure: boolean): string {
	return secure ? `__Host-${base}` : base;
}

/** True when town is served over TLS, which every cookie's attributes depend on. */
export function overTLS(publicUrl: string): boolean {
	return publicUrl.startsWith("https://");
}
