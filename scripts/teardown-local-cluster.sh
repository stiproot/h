#!/usr/bin/env bash
set -euo pipefail

# Tear down local application resources from the Rancher Desktop cluster.
#
# Removes h, plus any extra application namespaces you name — and nothing else.
# The Kubernetes control plane and shared namespaces are left intact:
#   kube-system, kube-public, kube-node-lease, default (the namespace itself), and Traefik.
#
# h is torn down via its own tooling (tilt down + make dapr-uninstall) because
# it shares the `default` namespace and owns the Dapr control plane + CRDs — a blind
# namespace delete would be wrong. Extra namespaces are assumed to be owned outright
# by their stacks, so they are deleted whole (which also removes their PVCs — DATA IS
# PERMANENTLY LOST).
#
# Usage:
#   scripts/teardown-local-cluster.sh            # prompts for confirmation
#   scripts/teardown-local-cluster.sh --yes      # skip the prompt
#   scripts/teardown-local-cluster.sh --dry-run  # print what would run, change nothing
#
#   APP_NAMESPACES="stack-a stack-b" scripts/teardown-local-cluster.sh
#     space-separated extra namespaces to delete in full (default: none; also read from .env)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H_LAB_DIR="${H_LAB_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

[[ -f "${H_LAB_DIR}/.env" ]] && { set -a; source "${H_LAB_DIR}/.env"; set +a; }

EXPECTED_CONTEXT="${EXPECTED_CONTEXT:-rancher-desktop}"
# Extra app namespaces to delete whole, space-separated (org-specific — set in env/.env).
read -r -a NAMESPACES <<<"${APP_NAMESPACES:-}"

ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# run CMD, or just print it under --dry-run
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    "$@"
  fi
}

# --- Safety guard: never touch anything but the expected local cluster ---
ctx="$(kubectl config current-context 2>/dev/null || true)"
if [[ "$ctx" != "$EXPECTED_CONTEXT" ]]; then
  echo "Refusing to run: current kube-context is '${ctx:-<none>}', expected '${EXPECTED_CONTEXT}'." >&2
  echo "Switch context or set EXPECTED_CONTEXT to override." >&2
  exit 1
fi

cat <<EOF
Target cluster (context): ${ctx}

Will tear down APPLICATION resources only:
  • h    — tilt down + make dapr-uninstall (apps in 'default', dapr-system ns, Dapr CRDs)
EOF
for ns in "${NAMESPACES[@]:-}"; do
  [[ -n "$ns" ]] && echo "  • ${ns} — delete namespace '${ns}' in full, INCLUDING its PVCs"
done
cat <<EOF

Will LEAVE intact:
  • Control plane / shared: kube-system, kube-public, kube-node-lease, default (namespace), Traefik

PVC deletion is IRREVERSIBLE — on-disk data for the local-path volumes is removed.
EOF

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "(dry-run: no changes will be made)"
elif [[ $ASSUME_YES -ne 1 ]]; then
  echo
  read -r -p "Type 'yes' to proceed: " answer
  [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 1; }
fi

# --- 1. h: use the repo's own idempotent teardown ---
echo
echo "==> h"
if [[ -f "${H_LAB_DIR}/Tiltfile" ]] && command -v tilt >/dev/null 2>&1; then
  run bash -c "cd '${H_LAB_DIR}' && tilt down"
else
  echo "  (skip: no Tiltfile at ${H_LAB_DIR} or tilt not installed)"
fi
if [[ -f "${H_LAB_DIR}/Makefile" ]] && command -v helm >/dev/null 2>&1; then
  run bash -c "cd '${H_LAB_DIR}' && make dapr-uninstall"
else
  echo "  (skip dapr-uninstall: no Makefile or helm not installed)"
fi

# --- 2. extra app namespaces: delete in full (workloads + PVCs/data) ---
for ns in "${NAMESPACES[@]:-}"; do
  [[ -z "$ns" ]] && continue
  echo
  echo "==> namespace: ${ns}"
  if kubectl get namespace "$ns" >/dev/null 2>&1; then
    run kubectl delete namespace "$ns" --ignore-not-found --wait=true --timeout=180s
  else
    echo "  (already gone)"
  fi
done

# --- 3. Report ---
echo
echo "==> Remaining namespaces:"
kubectl get ns
echo
echo "==> Remaining non-system pods:"
kubectl get pods -A 2>/dev/null | grep -vE "^(kube-system|kube-public|kube-node-lease)\b" || true
echo
echo "Done."
