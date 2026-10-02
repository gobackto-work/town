#!/usr/bin/env bash
#
# Create the town runtime secrets: the GitHub OAuth client secret and the session
# signing secret.
#
# Neither belongs in a chart. The client secret is issued by GitHub and cannot be
# generated; the session secret is generated here and must never be rotated by a
# Helm upgrade, because rotating it signs every user out.
#
# SAFE BY DEFAULT. An existing secret is left alone. Use --rotate to replace it.
#
# Usage
#   ./create-secrets.sh                        prompt for the client secret
#   GITHUB_CLIENT_SECRET=... ./create-secrets.sh
#   ./create-secrets.sh --rotate               replace both values
#
# Environment
#   TOWN_NAMESPACE         default: town
#   SECRET_NAME            default: town-secrets
#   GITHUB_CLIENT_SECRET   the OAuth app's client secret
#
# Requirements: kubectl, openssl, and a kubeconfig that reaches the cluster.

set -euo pipefail

TOWN_NAMESPACE="${TOWN_NAMESPACE:-town}"
SECRET_NAME="${SECRET_NAME:-town-secrets}"

usage() {
	sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
}

rotate=0
for arg in "$@"; do
	case "$arg" in
	--rotate) rotate=1 ;;
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

for tool in kubectl openssl; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done
kubectl cluster-info >/dev/null 2>&1 || die "kubectl cannot reach a cluster"
kubectl get namespace "$TOWN_NAMESPACE" >/dev/null 2>&1 ||
	die "namespace $TOWN_NAMESPACE does not exist; install the town chart first"

if kubectl -n "$TOWN_NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1 && [ "$rotate" != "1" ]; then
	printf '==> Secret/%s already exists in %s; nothing to do\n' "$SECRET_NAME" "$TOWN_NAMESPACE"
	printf '    use --rotate to replace it (this signs every user out)\n'
	exit 0
fi

client_secret="${GITHUB_CLIENT_SECRET:-}"
if [ -z "$client_secret" ]; then
	if [ -t 0 ]; then
		# -s so the secret is not echoed, and not left in the shell history.
		printf 'GitHub OAuth client secret: '
		read -rs client_secret
		printf '\n'
	else
		die "GITHUB_CLIENT_SECRET is not set and stdin is not a terminal"
	fi
fi
[ -n "$client_secret" ] || die "the client secret is empty"

session_secret="$(openssl rand -base64 48)"

printf '==> writing Secret/%s in %s\n' "$SECRET_NAME" "$TOWN_NAMESPACE"
kubectl -n "$TOWN_NAMESPACE" create secret generic "$SECRET_NAME" \
	--from-literal="GITHUB_CLIENT_SECRET=$client_secret" \
	--from-literal="SESSION_SECRET=$session_secret" \
	--dry-run=client -o yaml | kubectl apply -f -

cat <<DONE

==> installed Secret/$SECRET_NAME

    GITHUB_CLIENT_SECRET  from the OAuth app
    SESSION_SECRET        generated, 48 random bytes, base64

==> restart town to read them:

    kubectl -n $TOWN_NAMESPACE rollout restart deploy/town

==> the session secret signs every session cookie. Replacing it signs every user out,
    and is why a Helm upgrade must never regenerate it.
DONE
