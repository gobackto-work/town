# town

The management UI for the Pi agent platform: a Hono BFF and a React front end, in one
deployment.

## What it is, and what it is not

town is where a person creates and destroys their workspaces. It is also, by design,
**the platform's identity holder** — it runs the OIDC flow, holds the session cookie,
and forwards the IdP's access token to the control plane for verification. pestilence
has no login flow, no session store and no public hostname, so this is not a
preference; it is the only place a browser redirect can land.

The browser never talks to pestilence. It cannot: pestilence is cluster-internal, and
the BFF is where identity is attached.

Two components, one image:

| | |
|---|---|
| `src/server/` | the BFF. Serves the API under `/api`, and the built client as static assets. Run directly by node, with no build step — node strips the types. |
| `src/client/` | the React app. Bundled by vite into `dist/client`, which the BFF serves. |
| `src/shared/` | the types and error class both sides use, so they cannot disagree. |

## Authentication

GitHub OAuth, limited to members of one organisation. No local accounts, no allowlist of
logins, no bypass.

**GitHub is OAuth 2.0 and not OpenID Connect** — it issues no ID token, so nothing
pestilence could verify for itself. So town is the identity provider *to* pestilence: it
signs a short-lived Ed25519 assertion per request, and pestilence verifies it locally.
That keeps the control plane's egress closed and the GitHub token inside town.

The full reasoning, the deployment steps, and the operational notes are in
[`docs/auth.md`](docs/auth.md). The short version:

- `ownerId` is `github#<numeric id>`, never the username — GitHub logins are renameable
  and the freed name is claimable, so keying on it would hand workspaces to whoever takes
  the old name.
- Membership of `GITHUB_ORG` is the entire authorization rule, and a *pending* invitation
  is refused: invited is not joined.
- town **refuses to start** without authentication configured. A town that cannot
  identify anyone is an unauthenticated provisioning API; not starting is a better
  failure than either a guessable secret or an open one.

town is reachable at `https://town.gobackto.work` through a Traefik Ingress, with the
namespace's default-deny ingress lifted only for Traefik.

## Status

Working, and verified against the live cluster:

- list, create, delete and retry, from the browser through to the cluster
- polling while a workspace is in flight
- `/healthz` (liveness, does not check dependencies) and `/readyz` (readiness, does)
- errors from the control plane keep their status and code, and are not confused with
  the control plane being unreachable
- **GitHub sign-in, org-gated**, with a signed session cookie and a per-request assertion
  for pestilence
- 110 tests: 78 server, 32 client

Not built yet:

- **audit logging** — nothing records who did what, and now there is a "who". Most of this
  belongs in pestilence, since that is where the API and the records are; town's share is
  recording who signed in.

## The workspace edge

`https://<slug>.gobackto.work` is a separate gate from signing in, and it is a **one-time
handshake** rather than a per-request cost: the first visit bounces through town, which mints
a hostname-bound grant, and the workspace then holds its own cookie.
[`docs/auth.md`](docs/auth.md) has the whole flow and why it has to work that way.

The parts worth knowing without reading it:

- **town's session cookie cannot reach a workspace.** It is host-only on purpose — widening it
  would let any tenant shadow any other tenant's session, because workspaces are sibling
  subdomains serving tenant-controlled content.
- **The gate is identity, not location.** There is no IP allowlist; a workspace is reachable
  from anywhere by a signed-in member.
- **Two independent gates, both live.** `forwardauth` asks town who the requester is, and
  the bridge verifies `X-Scarab-Assertion` against the key pestilence publishes. Traefik
  serves a router *without* a middleware whose name does not resolve, and the bridge warns at
  startup if the assertion key is missing, so a misconfiguration is visible rather than
  silent. The middleware name is still the first thing to check if a workspace is ever
  unexpectedly reachable.
- **Any member may open any workspace**, and only the owner may delete or retry one. There is
  no read-only view: opening a workspace reaches its agent, its files, and the model credential
  on its volume, so anyone who can open it can spend against its owner's key.

### The two test halves run differently, on purpose

The server is executed by node with no transform, so its tests run the same way — which
is what keeps `erasableSyntaxOnly` honest. A test that passed under a transpiler while
the server failed to start would be worse than no test.

The client is bundled by vite, so its tests go through a transform (`tsx`), exactly as
production transforms it. This is not a preference: **node cannot run `.tsx` at all** —
it strips types but does not transform JSX.

## Layout

```
src/
  server/
    index.ts        entry point: config, keys, sessions, listen
    app.ts          the HTTP surface
    auth.ts         sign-in, sign-out, and the gate in front of the API
    github.ts       the GitHub client: code exchange, user, org membership
    session.ts      the signed session cookie
    assertion.ts    the Ed25519 assertion pestilence verifies
    pestilence.ts   the control plane client, and the ControlPlane interface
    errors.ts       errors from things town talks to
    config.ts       environment; refuses to start without auth configured
  client/
    main.tsx        mount
    App.tsx         session gate: loading, sign-in, or the workspaces
    SignIn.tsx
    Workspaces.tsx  the signed-in view
    WorkspaceTable.tsx
    useSession.ts   who is signed in
    useWorkspaces.ts  list state, actions, polling
    api.ts          the browser's client for town's own API
  shared/
    types.ts        the wire types, mirroring pestilence's workspaceDTO
    identity.ts     the owner id format, and why it is not the login
    errors.ts       ApiError
```

## Running it

```sh
npm ci
npm run build          # builds the client into dist/client
npm start              # serves API + assets on :8080
```

In development, run `npm start` and `npm run dev` together: vite serves the client on
:5173 and proxies `/api` to the BFF.

Configuration. The first four are required and town will not start without them; the rest
have defaults.

| Variable | Default |
|---|---|
| `GITHUB_CLIENT_ID` | — required |
| `GITHUB_CLIENT_SECRET` | — required |
| `GITHUB_ORG` | — required |
| `SESSION_SECRET` | — required, ≥32 chars |
| `PORT` | `8080` |
| `PESTILENCE_URL` | `http://control-plane.pestilence.svc.cluster.local:8080` |
| `TOWN_URL` | `https://town.gobackto.work` |
| `STATIC_DIR` | `dist/client` |
| `SESSION_TTL_SECONDS` | `43200` |
| `ASSERTION_KEY_FILE` | `/var/run/town/assertion-key.pem` |
| `ASSERTION_AUDIENCE` | `pestilence-api` |
| `ASSERTION_TTL_SECONDS` | `120` |

## The gate

```sh
hack/verify.sh
```

19 checks: tool versions, both typecheck projects, both test halves, eslint (with
complexity thresholds and the React hooks rules), knip, jscpd, `npm audit`, hadolint,
shellcheck, gitleaks.

The four rules it follows, and why each exists, are in the header of `hack/verify.sh`.
The short version: it is stateless, a missing tool is a failure rather than a warning,
findings get fixed rather than suppressed, and none of it proves the server talks to
the control plane — running it does.
