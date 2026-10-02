#!/usr/bin/env bash
#
# Generate the Ed25519 key pair town signs assertions with, and install it.
#
#   town       holds the PRIVATE key and signs a short-lived assertion per request
#   pestilence holds the PUBLIC key and verifies it locally
#
# Asymmetric rather than a shared secret so the private half exists in exactly one
# place, and so pestilence's copy can live in a ConfigMap rather than a Secret.
#
# ────────────────────────────────────────────────────────────────────────────
# WHY THIS DOES THE INSTALL ITSELF
# ────────────────────────────────────────────────────────────────────────────
#
# A first version printed kubectl commands for the operator to run later, and
# deleted the temporary directory on exit -- so every command it suggested failed
# with "no such file or directory". Keeping the files would only have half-fixed
# it: they are written on the machine running this script, and kubectl runs on the
# node.
#
# So the whole job happens here: generate, copy to the node, apply, clean up. The
# key lives in the cluster and nowhere else.
#
# Usage
#   hack/generate-keys.sh              # generate and install
#   DRY_RUN=1 hack/generate-keys.sh    # generate, validate against the API server, store nothing
#   NODE=other hack/generate-keys.sh
#
# Requirements
#   - openssl, which every host here has
#   - an ssh alias for the node that works non-interactively
#   - kubectl and a kubeconfig on that node

set -euo pipefail

NODE="${NODE:-k0s-node}"
DRY_RUN="${DRY_RUN:-0}"

KEY_DIR="$(mktemp -d)"
REMOTE_DIR="/tmp/town-keys-$$"

# Both copies are removed whatever happens: neither the local files nor the copies
# on the node have any business outliving this script.
cleanup() {
	rm -rf "$KEY_DIR"
	ssh -o BatchMode=yes "$NODE" "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> generating an Ed25519 key pair"
openssl genpkey -algorithm ed25519 -out "$KEY_DIR/assertion-key.pem" 2>/dev/null
openssl pkey -in "$KEY_DIR/assertion-key.pem" -pubout -out "$KEY_DIR/assertion-key.pub" 2>/dev/null
chmod 600 "$KEY_DIR/assertion-key.pem"

echo "==> copying to $NODE:$REMOTE_DIR"
ssh -o BatchMode=yes "$NODE" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
scp -q -o BatchMode=yes "$KEY_DIR/assertion-key.pem" "$KEY_DIR/assertion-key.pub" "$NODE:$REMOTE_DIR/"

if [ "$DRY_RUN" = "1" ]; then
	echo "==> DRY RUN: validating against the API server and storing nothing"
fi

# The remote half is a script rather than a quoted one-liner: it has arrays and a
# pipe in it, and threading those through ssh quoting is how this goes wrong.
ssh -o BatchMode=yes "$NODE" bash -s -- "$REMOTE_DIR" "$DRY_RUN" <<'REMOTE'
set -euo pipefail
dir="$1"
dry_run="$2"

extra=()
if [ "$dry_run" = "1" ]; then
	extra=(--dry-run=server)
fi

# The private key, for town. `create --dry-run=client | apply` rather than a bare
# apply so that re-running replaces the pair instead of failing on "already exists".
kubectl -n town create secret generic town-assertion-key \
	--from-file="assertion-key.pem=$dir/assertion-key.pem" \
	--dry-run=client -o yaml | kubectl apply -f - "${extra[@]}"

# The public key, for pestilence. A ConfigMap because it is not sensitive.
kubectl -n pestilence create configmap town-assertion-pubkey \
	--from-file="assertion-key.pub=$dir/assertion-key.pub" \
	--dry-run=client -o yaml | kubectl apply -f - "${extra[@]}"
REMOTE

if [ "$DRY_RUN" = "1" ]; then
	echo
	echo "==> dry run complete; nothing was stored."
	exit 0
fi

cat <<'DONE'

==> installed

    Secret/town-assertion-key        in the town namespace       (private)
    ConfigMap/town-assertion-pubkey  in the pestilence namespace  (public)

==> restart both, or neither will pick up the new key:

    kubectl -n town rollout restart deploy/town
    kubectl -n pestilence rollout restart deploy/control-plane

==> the local copies are gone: the key now exists only in the cluster, so it is
    backed up with the cluster and not with git.

==> NOTE: re-running this replaces BOTH halves. Every assertion in flight is
    rejected until both deployments have restarted, and they are a pair -- replacing
    one without the other stops every request with a signature failure.
DONE
