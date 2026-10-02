# Cluster setup

Scripts an operator runs once per cluster. They are not part of the Helm chart.

The chart cannot do two jobs that these scripts do:

- The assertion key pair must exist in two namespaces at once. Helm cannot derive
  the public key from the private key.
- The GitHub client secret is issued by GitHub. The session secret must not change
  when the chart is upgraded, because a change signs every user out.

## Order

1. Install the charts: `scarab`, then `pestilence`, then `town`. This creates the
   namespaces.
2. Run `./generate-keys.sh`.
3. Run `./create-secrets.sh`.

Both scripts are safe to run again. A script changes nothing when the object
already exists.

## Scripts

| Script | Creates | On a re-run |
|---|---|---|
| `generate-keys.sh` | `Secret/town-assertion-key` in `town`, `ConfigMap/town-assertion-pubkey` in `pestilence` | stops, unless `--rotate` |
| `create-secrets.sh` | `Secret/town-secrets` in `town` | stops, unless `--rotate` |

### generate-keys.sh

The assertion key pair is asymmetric, so the private half exists in one place.
`town` signs an assertion per request. `pestilence` verifies it against the public
half, which is not sensitive and lives in a ConfigMap.

The script repairs a half-installed pair. If the private key exists and the public
key does not, it derives the public key from the private key. It does not rotate a
working key.

`--rotate` replaces both halves. Every assertion in flight is rejected until both
Deployments restart. Use it only to recover a leaked key.

```sh
./generate-keys.sh              # create the pair if it is absent
./generate-keys.sh --rotate     # replace an existing pair
./generate-keys.sh --dry-run    # generate and validate, store nothing
```

After a rotation, restart both Deployments:

```sh
kubectl -n town rollout restart deploy/town
kubectl -n pestilence rollout restart deploy/control-plane
```

### create-secrets.sh

The script writes two values:

- `GITHUB_CLIENT_SECRET`, from the OAuth app. Supply it in the environment or at
  the prompt.
- `SESSION_SECRET`, generated. It signs the session cookie.

```sh
GITHUB_CLIENT_SECRET=... ./create-secrets.sh
./create-secrets.sh --rotate    # replaces both, and signs every user out
```

## Requirements

| Tool | Why |
|---|---|
| `openssl` | generates the Ed25519 key pair and the session secret |
| `kubectl` | reaches the cluster |
| `base64` | reads the private key back during a repair |

The scripts read the standard kubeconfig. They do not need ssh.

## Environment

Each script accepts overrides, so it can target a release that is not named
`town` or `pestilence`.

| Variable | Script | Default |
|---|---|---|
| `TOWN_NAMESPACE` | both | `town` |
| `PESTILENCE_NAMESPACE` | `generate-keys.sh` | `pestilence` |
| `SECRET_NAME` | both | `town-assertion-key`, `town-secrets` |
| `CONFIGMAP_NAME` | `generate-keys.sh` | `town-assertion-pubkey` |
| `GITHUB_CLIENT_SECRET` | `create-secrets.sh` | — |

## The chart can create these instead

Set `secrets.github.create=true` and `assertion.create=true` in the `town` chart to
create both objects during `helm install`. Use this path for a new cluster, and
supply `secrets.github.clientSecret` and `assertion.privateKey`.

The scripts are the better path for an existing cluster. They read the current
state, repair a half-installed pair, and never rotate a working key.
