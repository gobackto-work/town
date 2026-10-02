#!/usr/bin/env bash
#
# Build the town image and load it into the k0s node's containerd.
#
# Pipeline: buildah (WSL) -> docker-archive -> scp -> k0s ctr images import. The same
# pipeline scarab and pestilence use, so there is one way to get an image onto this node
# rather than three.
#
# Unlike those two there is no cross-compile step here: the image is node, and the
# whole build happens inside the Dockerfile (npm ci, vite build, then a production-only
# reinstall).
#
# Requirements
#   - buildah inside WSL. Rootless is fine.
#   - an ssh alias for the node that works non-interactively.
#   - NOPASSWD for the k0s ctr image commands, because the k0s containerd socket is
#     root-only (srw-rw---- root:root). See /etc/sudoers.d/k0s-ctr-images.
#
# Usage
#   hack/load-image.sh                 # build + load
#   TAG=v2 hack/load-image.sh
#   SKIP_BUILD=1 hack/load-image.sh    # load an existing archive

set -euo pipefail

TAG="${TAG:-dev}"
NODE="${NODE:-k0s-node}"
NAME="town"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# git-bash paths (/c/Users/...) are /mnt/c/Users/... inside WSL.
WSL_ROOT="$(printf '%s' "$REPO_ROOT" | sed 's|^/\([a-zA-Z]\)/|/mnt/\1/|')"

ARCHIVE="$REPO_ROOT/image/dist/$NAME-$TAG.tar"
WSL_ARCHIVE="$WSL_ROOT/image/dist/$NAME-$TAG.tar"

mkdir -p "$REPO_ROOT/image/dist"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
	echo "==> buildah bud $NAME:$TAG"
	# The build context is the repository root, so .dockerignore is what keeps
	# node_modules -- tens of thousands of files on a 9p mount -- out of it.
	wsl.exe -e bash -lc "set -e
		cd '$WSL_ROOT'
		buildah bud -t '$NAME:$TAG' -f Dockerfile .
		rm -f '$WSL_ARCHIVE'
		buildah push '$NAME:$TAG' docker-archive:'$WSL_ARCHIVE':'$NAME:$TAG'"
fi

echo "==> scp archive to $NODE:/tmp/"
scp -o BatchMode=yes "$ARCHIVE" "$NODE:/tmp/$NAME-$TAG.tar"

echo "==> k0s ctr images import $NAME:$TAG"
ssh -o BatchMode=yes "$NODE" "sudo -n k0s ctr images import /tmp/$NAME-$TAG.tar"

echo "==> images on $NODE"
ssh -o BatchMode=yes "$NODE" "sudo -n k0s ctr images ls | grep -i '$NAME' || true"

echo "==> loaded. Reference 'localhost/$NAME:$TAG' with imagePullPolicy: IfNotPresent."
echo "==> NOTE: the running pod keeps the OLD image until restarted:"
echo "         kubectl -n town rollout restart deploy/town"
