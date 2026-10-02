# town

The management interface for a self-hosted platform that gives people temporary workspaces for Pi coding agents.

Sign in with an approved GitHub organisation account to create, inspect, retry, and delete workspaces. Each workspace runs at its own address.

## How it fits together

- **town** provides sign-in and the web interface.
- **pestilence** manages workspace lifecycles and cluster access.
- **scarab** runs the agent and provides its workspace tools.

The browser talks to town. Town verifies the user and passes their identity to pestilence; the browser never talks directly to the control plane.

## Running locally

```sh
npm ci
npm run build
npm start
```

Set the required GitHub OAuth, organisation, and session settings first. See [Authentication](docs/auth.md) for configuration and the sign-in flow.

## Deploying

```sh
helm install town oci://ghcr.io/gobackto-work/charts/town --version 1.0.0
```

The chart references pre-existing secrets. See [Cluster setup](cluster-setup-scripts/README.md) for the assertion key pair and the runtime secrets.

## Project status

Workspace management and organisation-restricted sign-in are implemented. Audit logging is still to come.
