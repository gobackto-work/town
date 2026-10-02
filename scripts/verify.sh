#!/usr/bin/env bash
#
# The verification gate for town. Run it before claiming anything works.
#
# Mirrors scarab's gate in shape and in output, because two agents working in
# adjacent repositories should be able to read each other's failures.
#
# Four rules, learned the hard way in the other repositories:
#
#   1. STATELESS. No incremental state, no caches to warm first. The tree is shared
#      between agents, so a gate that depends on what ran before is not a gate.
#   2. FAIL LOUDLY ON A MISSING TOOL. A missing checker is a failure, not a warning.
#      A gate that silently skips a check reports success for work it never did.
#   3. FIX WHAT IT FINDS, or justify the exclusion by reading the hit. Suppressing a
#      finding to reach green is how the gate stops meaning anything.
#   4. NECESSARY, NOT SUFFICIENT. Everything here is pass/fail and static. None of it
#      proves the server talks to the control plane -- running it does that.
#
# Unlike pestilence there is no `-race` equivalent, because there is no cgo here. The
# whole gate runs on one host.
#
# Usage
#   scripts/verify.sh

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FAILED=0
PASSED=0
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { PASSED=$((PASSED + 1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() {
	FAILED=$((FAILED + 1))
	printf '  \033[31mFAIL\033[0m %s\n' "$*"
	if [ -s "$OUT" ]; then sed 's/^/       /' "$OUT" | head -25; fi
}

# check NAME CMD... — passes when CMD exits zero, output ignored.
check() {
	local name="$1"
	shift
	if "$@" >"$OUT" 2>&1; then ok "$name"; else bad "$name"; fi
}

# check_quiet NAME CMD... — passes when CMD exits zero AND prints nothing.
check_quiet() {
	local name="$1"
	shift
	if "$@" >"$OUT" 2>&1 && [ ! -s "$OUT" ]; then ok "$name"; else bad "$name"; fi
}

# require TOOL VERSION_ARGS EXPECTED — a missing or mismatched tool is a failure,
# because otherwise this is not the same gate for everyone who runs it.
require() {
	local tool="$1" got="$2" want="$3"
	if ! command -v "$tool" >/dev/null 2>&1; then
		bad "$tool not installed (want $want)"
		return 1
	fi
	case "$got" in
	*"$want"*)
		ok "$tool matched $want"
		return 0
		;;
	*)
		bad "$tool is $got, want $want"
		return 1
		;;
	esac
}

# The server is executed by node directly, with no build step, so node has to be able
# to strip TypeScript: that landed in 22.18. An older node does not fail to typecheck,
# it fails to start, which is a confusing way to learn this.
require_node() {
	local major minor
	major="$(node -p 'process.versions.node.split(".")[0]')"
	minor="$(node -p 'process.versions.node.split(".")[1]')"
	if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
		bad "node $(node --version) is too old; running .ts directly needs >= 22.18"
		return 1
	fi
	ok "node $(node --version)"
}

step "tool versions"
require_node
# The npm-provided tools are asserted by their exact pins in package.json, and every
# invocation below uses --no-install so a missing one fails rather than being fetched
# mid-gate. Their versions therefore cannot drift from the lockfile.
require hadolint "$(hadolint --version 2>&1)" "2.15.1"
require gitleaks "$(gitleaks version 2>&1)" "8.30.1"
require shellcheck "$(shellcheck --version 2>&1 | sed -n 's/^version: //p')" "0.11.0"
for tool in tsc eslint knip jscpd; do
	if [ -x "node_modules/.bin/$tool" ]; then
		ok "$tool $("node_modules/.bin/"$tool --version 2>&1 | head -1)"
	else
		bad "$tool is not installed; run npm ci"
	fi
done

step "types and tests"
check "tsc (client, and the shared types)" npx --no-install tsc --noEmit
check "tsc (server, without the DOM libs)" npx --no-install tsc -p src/server/tsconfig.json --noEmit
# The two halves run differently ON PURPOSE, and the asymmetry is the point: the server
# is executed by node with no transform, so its tests are too, which keeps the
# erasable-syntax guarantee honest. The client is bundled by vite, so its tests are
# transformed, exactly as production transforms it.
check "node --test (server, no transform)" npm run test:server
check "node --test (client, via tsx)" npm run test:client

step "lint, dead code and duplication"
check "eslint (complexity, sonarjs, hooks)" npx --no-install eslint .
check "knip (unused files, exports, deps)" npx --no-install knip --reporter compact
check "jscpd (duplication)" npx --no-install jscpd --config .jscpd.json .

step "supply chain"
# The JavaScript analogue of pestilence's govulncheck: a check against a live advisory
# database, so it can fail for reasons outside this repository's control. That is the
# point of it.
check "npm audit" npm audit --audit-level=moderate

step "image and scripts"
check "hadolint (Dockerfile)" hadolint Dockerfile
check "shellcheck (scripts and setup scripts)" shellcheck -s bash scripts/*.sh cluster-setup-scripts/*.sh

step "chart"
require helm "$(helm version --short 2>&1)" "v4"
check "helm lint" helm lint charts/town
# Default values reference pre-existing secrets, which is the path an existing cluster
# takes. The second call exercises the create-if-absent path a new cluster takes.
check "helm template (reference existing secrets)" helm template town charts/town
check "helm template (create secrets when absent)" helm template town charts/town \
	--set secrets.github.create=true --set secrets.github.clientSecret=x \
	--set assertion.create=true --set assertion.privateKey=x

step "secrets"
check "gitleaks (tree + git history)" gitleaks detect --source . --no-banner --redact

printf '\n'
if [ "$FAILED" -eq 0 ]; then
	printf '\033[1mverify.sh: %d passed, 0 failed\033[0m\n' "$PASSED"
	printf 'verified: %d checks, 0 failures\n' "$PASSED"
else
	printf '\033[1;31mverify.sh: %d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"
	exit 1
fi
