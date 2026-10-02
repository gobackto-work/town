# Authentication

Access is GitHub OAuth, limited to members of one organisation. There is no second path
in: no local accounts, no allowlist of logins, no bypass flag.

## Why GitHub, and why the design looks like this

**GitHub is OAuth 2.0, not OpenID Connect.** From GitHub's own documentation:

> GitHub does not currently implement OpenID Connect in its OAuth flows and does not
> issue ID tokens for users or apps.

There *is* a discovery document at `github.com/login/oauth/.well-known/openid-configuration`,
but GitHub says it is published only for MCP clients, is in public preview, and
"contain[s] incorrect information". A GitHub access token is an opaque `gho_…` string that
only GitHub can validate, so **nothing downstream can verify it offline.**

The original plan — town forwards the IdP's token and pestilence verifies it against a
JWKS — is therefore impossible. The options were:

| | |
|---|---|
| pestilence calls GitHub to validate each token | Opens the control plane's egress to the internet, makes the trusted plane's availability depend on GitHub, and hands it a `read:org` credential when all it needs is one opaque owner id |
| **town signs an assertion pestilence verifies locally** | **chosen** — no external dependency in the trusted plane, egress stays closed, and the GitHub token stops at town |
| town asserts an identity over the network with no signature | Rejected: the only gate would be a NetworkPolicy, which is not a cryptographic control |

So town is the identity provider *to* pestilence. It mints a short-lived Ed25519 JWT per
request; pestilence verifies the signature against town's public key.

Ed25519 rather than a shared secret so the private key exists in exactly one place, and
so pestilence's copy can live in a **ConfigMap** rather than a Secret — a public key is
not sensitive.

## The owner id is not the login

`ownerId` is `github#<numeric id>`, never the username. GitHub usernames are mutable and
the freed name is claimable:

> After changing your username, your old username becomes available for anyone else to
> claim.

Keying workspaces on the login would mean a rename loses you your workspaces, and whoever
takes the freed name **inherits them**. See `src/shared/identity.ts`.

This is a contract value: pestilence stores and compares the same string. Changing the
format re-owns nothing — existing workspaces keep the old value and stop matching, which
is deliberate.

## What has to be configured

town **refuses to start** without these. That is the point: a town that cannot identify
anyone is an unauthenticated workspace-provisioning API, and the surest way never to
deploy one is to make it impossible to start.

| Variable | Meaning |
|---|---|
| `GITHUB_CLIENT_ID` | from the OAuth App |
| `GITHUB_CLIENT_SECRET` | from the OAuth App — a Kubernetes Secret, never the image |
| `GITHUB_ORG` | the only authorization rule: membership of this org |
| `SESSION_SECRET` | ≥32 characters; signs the session cookie |

Optional, with defaults: `PORT`, `PESTILENCE_URL`, `STATIC_DIR`, `TOWN_URL`
(`https://town.gobackto.work`), `SESSION_TTL_SECONDS` (12h), `ASSERTION_KEY_FILE`
(`/var/run/town/assertion-key.pem`), `ASSERTION_AUDIENCE` (`pestilence-api`),
`ASSERTION_TTL_SECONDS` (120).

### The GitHub OAuth App

Register one (Settings → Developer settings → OAuth Apps) with:

- **Homepage URL**: `https://town.gobackto.work`
- **Authorization callback URL**: `https://town.gobackto.work/auth/callback`

The callback must match **exactly**, and a mismatch is the most common way this flow
fails — GitHub reports a `redirect_uri` error without naming the value it wanted. town
prints its callback URL at startup for exactly that reason.

Scope requested: **`read:org`** and nothing else. `allow_signup=false`, so the flow cannot
create an account — the org is invitation-based, so a new account could not be a member
anyway.

### Keys, secrets and the deployment

```sh
hack/generate-keys.sh > /tmp/town-keys.sh   # inspect before running
sh /tmp/town-keys.sh
```

That creates `Secret/town-assertion-key` in the `town` namespace (the private key) and
`ConfigMap/town-assertion-pubkey` in `pestilence` (the public key). They are a pair:
replacing one without the other stops every request. Neither is written to the repository.

The client secret and session secret go in the same namespace:

```sh
kubectl -n town create secret generic town-secrets \
  --from-literal=GITHUB_CLIENT_SECRET=... \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)"
```

Generate the session secret; do not invent one. It is the only thing standing between a
browser and a forged cookie.

## How a sign-in works

1. `GET /auth/login` plants a random nonce in a cookie and redirects to GitHub.
2. GitHub redirects back to `/auth/callback` with a code and the nonce.
3. The nonce must match the cookie. Without that check an attacker can hand a victim a
   callback URL carrying *the attacker's* code and silently sign the victim in as them.
4. town exchanges the code for an access token, reads `/user`, and checks membership with
   `GET /orgs/{org}/memberships/{login}`.
5. **`state` must be `active`.** `pending` means invited-but-not-accepted and is refused
   as its own case: an unaccepted invitation is not membership.
6. The access token is dropped. It exists only long enough to learn who this is, so
   nothing downstream can leak it — it is deliberately not in the session cookie.

The session is a **signed, stateless** cookie (HS256, `HttpOnly`, `Secure`,
`SameSite=Lax`). Lax and not Strict because the callback arrives as a top-level navigation
from `github.com`, and Strict would withhold the cookie on exactly that request.

## Operational notes

- **Removing someone from the org takes effect at their next sign-in**, not immediately:
  membership is checked during login and the session then stands until it expires. With
  the default 12-hour TTL that is the window. Re-checking on every request would put
  GitHub in the path of every API call, which is the coupling this design exists to avoid.
  Shorten `SESSION_TTL_SECONDS` if the window matters more.
- **If the org has "OAuth App access restrictions" enabled**, members cannot authorise the
  app until an owner approves it. Check this before debugging anything else: the symptom
  is an authorisation failure on GitHub's side that town never sees.
- **town must be reachable from the browser** for the redirect to work, which means an
  Ingress. That is the point at which town stops being cluster-internal, and it is safe
  only because this authentication exists.
- **Losing the signing key** means pestilence rejects everything until the pair is
  regenerated. It is a Secret, so it is backed up with the cluster, not with git.

---

# The workspace edge

Signing in protects the management UI. It does **not** by itself protect
`https://<slug>.gobackto.work`, which is a different hostname served by that workspace's own
agent. That is a separate gate, and it is the more delicate one.

## Why town's session cookie cannot do it

The obvious design is for Traefik's ForwardAuth to send the original request to town, which
reads `town_session` and answers. **It cannot.** That cookie is host-only for
`town.gobackto.work`, so a browser requesting `<slug>.gobackto.work` never sends it — Traefik
arrives at town with no cookie and no way to say who the user is.

The obvious fix — widening the session cookie to `Domain=.gobackto.work` — is worse than it
looks. Tenant workspaces are **sibling** subdomains serving tenant-controlled content, so
widening hands every tenant a cookie they can shadow, and one tenant can then log out every
other tenant. It also makes a `__Host-` prefix impossible, and that prefix is the attribute
designed to prevent exactly this.

## What actually happens

The workspace edge gets its own credential, bound to one hostname:

```
1. browser -> <slug>.gobackto.work          no edge cookie
2. ForwardAuth -> town /authz              no cookie, no handoff
3. town 302s the BROWSER to its own hostname, where the session cookie IS sent
4. town /workspaces/open asks pestilence who may open that host, mints a 2-minute
   grant with aud = the hostname, and 302s back to the workspace with it in the query
5. ForwardAuth -> town /authz              handoff present: verified, exchanged for a
                                           HOST-SCOPED cookie, and 302d to the same URL
                                           with the handoff stripped
6. browser -> the workspace again, now carrying that cookie
7. ForwardAuth -> town /authz              cookie valid -> the request is admitted
```

**This is a one-time handshake per session, not a per-request cost.** After step 6 the
workspace has its own cookie (12h by default) and later visits go straight there.

It looks counterintuitive that visiting a workspace bounces you through town. The reason it
must is that **the gate runs before the page exists**: ForwardAuth decides whether the request
reaches the agent at all, so there is no page yet that could fetch credentials. A full-page
navigation is the only browser mechanism that happens first.

**Step 5 works with no route on the workspace host**, which is worth knowing because it was
verified rather than assumed: Traefik passes a 3xx from the auth server through to the browser
*together with its `Set-Cookie`*, and a cookie with no `Domain` attribute is scoped by the
browser to the host that was asked for. That is how town sets a cookie on a host it does not
serve.

## Two signature schemes, deliberately

| | |
|---|---|
| **Handoff and edge cookie** | Travel through the **browser**, so town mints and verifies them itself and HS256 (the session secret) is sufficient |
| **`X-Scarab-Assertion`** | Verified by a **third party** and never passes through the browser, so it is Ed25519 with the key town already uses for pestilence. `aud` is the workspace **hostname**, so a token minted for one workspace cannot be replayed at another's |

`X-Auth-User` is sent alongside and is **not** an authorization input — it is unsigned.
Traefik strips any client-supplied value before ForwardAuth runs, so it cannot be forged;
the bridge is contracted not to consume it.

## `__Host-` is not decoration

Every cookie town sets is `__Host-` prefixed when TLS is available. A tenant can set a
`Domain=.gobackto.work` cookie, so without the prefix it can shadow town's by name — and for
the OAuth nonce that is a path to the login-CSRF attack the nonce exists to prevent. Browsers
reject any `Domain` attribute on a `__Host-` cookie, so no tenant can create one.

## Where this can go wrong quietly

The middleware is referenced **by name** in the workspace Ingress. Traefik serves a router
*without* a middleware whose name does not resolve — it logs an error and carries on — so a
rename on either side produces a **fully open workspace endpoint with no functional symptom.**

Until the bridge verifies `X-Scarab-Assertion` for itself, ForwardAuth is the only gate on a
workspace endpoint. If a workspace is ever unexpectedly reachable, that name is the first
thing to check.
