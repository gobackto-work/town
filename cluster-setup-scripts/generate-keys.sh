#!/usr/bin/env bash
#
# Generate the Ed25519 assertion key pair, and install both halves.
#
#   town        holds the PRIVATE key and signs a short-lived assertion per request
#   pestilence  holds the PUBLIC key and verifies it locally
#
# The pair is asymmetric so the private half exists in exactly one place, and so
# pestilence's copy can live in a ConfigMap rather than a Secret.
#
# SAFE BY DEFAULT. If the pair already exists the script reports that and stops.
# Replacing it rejects every assertion in flight until both Deployments restart,
# so rotation is opt-in with --rotate.
#
# Usage
#   ./generate-keys.sh              create the pair if it is absent
#   ./generate-keys.sh --rotate     replace an existing pair
#   ./generate-keys.sh --dry-run    generate and validate, store nothing
#
# Environment
#   TOWN_NAMESPACE        default: town
#   PESTILENCE_NAMESPACE  default: pestilence
#   SECRET_NAME           default: town-assertion-key
#   CONFIGMAP_NAME        default: town-assertion-pubkey
#
# Requirements: openssl, kubectl, and a kubeconfig that reaches the cluster.

set -euo pipefail

TOWN_NAMESPACE="${TOWN_NAMESPACE:-town}"
PESTILENCE_NAMESPACE="${PESTILENCE_NAMESPACE:-pestilence}"
SECRET_NAME="${SECRET_NAME:-town-assertion-key}"
CONFIGMAP_NAME="${CONFIGMAP_NAME:-town-assertion-pubkey}"

usage() {
	sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
}

rotate=0
dry_run=0
for arg in "$@"; do
	case "$arg" in
	--rotate) rotate=1 ;;
	--dry-run) dry_run=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'unknown argument: %s\n\n' "$arg" >&2
		usage >&2
		exit 2
		;;
	esac
done

die() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

# Prerequisites. Fail with the reason, not with a kubectl stack trace.
for tool in openssl kubectl base64; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done
kubectl cluster-info >/dev/null 2>&1 || die "kubectl cannot reach a cluster"
for ns in "$TOWN_NAMESPACE" "$PESTILENCE_NAMESPACE"; do
	kubectl get namespace "$ns" >/dev/null 2>&1 ||
		die "namespace $ns does not exist; install the charts first"
done

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

have_secret="$(kubectl -n "$TOWN_NAMESPACE" get secret "$SECRET_NAME" --ignore-not-found -o name)"
have_configmap="$(kubectl -n "$PESTILENCE_NAMESPACE" get configmap "$CONFIGMAP_NAME" --ignore-not-found -o name)"

mode=generate
if [ -n "$have_secret" ] && [ -n "$have_configmap" ] && [ "$rotate" != "1" ]; then
	printf '==> the key pair already exists; nothing to do\n'
	printf '      Secret/%s in %s\n' "$SECRET_NAME" "$TOWN_NAMESPACE"
	printf '      ConfigMap/%s in %s\n' "$CONFIGMAP_NAME" "$PESTILENCE_NAMESPACE"
	printf '    use --rotate to replace both halves\n'
	exit 0
fi

if [ -n "$have_secret" ] && [ -z "$have_configmap" ] && [ "$rotate" != "1" ]; then
	# A half-installed pair. The public key is derivable from the private one, so
	# repair it rather than rotate a working key.
	mode=repair
	printf '==> the private key exists but the public key does not; deriving the public half\n'
	kubectl -n "$TOWN_NAMESPACE" get secret "$SECRET_NAME" \
		-o jsonpath='{.data.assertion-key\.pem}' | base64 -d >"$work/assertion-key.pem"
	openssl pkey -in "$work/assertion-key.pem" -pubout -out "$work/assertion-key.pub" 2>/dev/null ||
		die "the stored private key could not be read as an Ed25519 PKCS#8 key"
else
	printf '==> generating an Ed25519 key pair\n'
	openssl genpkey -algorithm ed25519 -out "$work/assertion-key.pem" 2>/dev/null
	openssl pkey -in "$work/assertion-key.pem" -pubout -out "$work/assertion-key.pub" 2>/dev/null
	chmod 600 "$work/assertion-key.pem"
fi

dry_args=()
if [ "$dry_run" = "1" ]; then
	dry_args=(--dry-run=server)
	printf '==> dry run: validating against the API server and storing nothing\n'
fi

# `create --dry-run=client | apply` rather than a bare apply, so a re-run replaces
# the object instead of failing on "already exists".
if [ "$mode" = "generate" ]; then
	kubectl -n "$TOWN_NAMESPACE" create secret generic "$SECRET_NAME" \
		--from-file="assertion-key.pem=$work/assertion-key.pem" \
		--dry-run=client -o yaml | kubectl apply -f - ${dry_args[@]+"${dry_args[@]}"}
fi
kubectl -n "$PESTILENCE_NAMESPACE" create configmap "$CONFIGMAP_NAME" \
	--from-file="assertion-key.pub=$work/assertion-key.pub" \
	--dry-run=client -o yaml | kubectl apply -f - ${dry_args[@]+"${dry_args[@]}"}

if [ "$dry_run" = "1" ]; then
	printf '\n==> dry run complete; nothing was stored\n'
	exit 0
fi

cat <<DONE

==> installed

    Secret/$SECRET_NAME in $TOWN_NAMESPACE               (private)
    ConfigMap/$CONFIGMAP_NAME in $PESTILENCE_NAMESPACE   (public)

==> restart both, or neither will read the new key:

    kubectl -n $TOWN_NAMESPACE rollout restart deploy/town
    kubectl -n $PESTILENCE_NAMESPACE rollout restart deploy/control-plane

==> the local copies are gone: the key exists only in the cluster, so it is backed
    up with the cluster and not with git.
DONE

if [ "$mode" = "generate" ] && { [ -n "$have_secret" ] || [ -n "$have_configmap" ]; }; then
	cat <<'DONE'

==> WARNING: an existing half was replaced. Both halves are now new, and they are a
    pair. Any assertion signed with the old key is rejected until both Deployments
    have restarted.
DONE
fi
