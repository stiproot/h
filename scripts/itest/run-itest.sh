#!/usr/bin/env bash
# scripts/itest/run-itest.sh — integration test harness for h feature worktrees.
#
# Usage:
#   scripts/itest/run-itest.sh [<worktree-path>]   run the full gate
#   scripts/itest/run-itest.sh --gc                 delete stale h-itest-* namespaces + prune images
#
# Exit-code taxonomy (the run-itest activity classifies on these):
#   0  — all smoke assertions passed
#   10 — assertion failure (workflow not COMPLETED, wf row wrong, watch not finalised)
#   11 — infra failure (cluster/build/push/deploy/pod-ready timeout)
#
# Evidence (pod logs, describe, timings, overlay) persists under:
#   .host-logs/itest/<id>/   BEFORE namespace deletion.
#
set -euo pipefail

# Initial REPO_ROOT from BASH_SOURCE — correct when running in-place; overridden below when the
# script is materialised to a temp dir and a worktree path is passed as $1.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K3D_REGISTRY="${K3D_REGISTRY:-localhost:5111}"
# In-cluster image reference — the registry container is named exactly `h-registry` (created by
# `make k3d-up --registry-create h-registry:0.0.0.0:5111`), and the k3d nodes' registries.yaml
# mirrors BOTH h-registry:5111 and h-registry:5000 to it. Use the :5111 form so the in-cluster
# name matches the host push address's port and stays greppable as one registry.
K3D_REGISTRY_CLUSTER="${K3D_REGISTRY_CLUSTER:-h-registry:5111}"
EVIDENCE_BASE="${REPO_ROOT}/.host-logs/itest"
# Allocate a free ephemeral port per run so concurrent gate runs don't collide on the port-forward.
WF_SVC_PORT_LOCAL=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")
WF_SVC_NAMESPACE_PORT=8000

# ── GC mode ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--gc" ]]; then
  echo "[itest-gc] deleting h-itest-* namespaces older than 2h..."
  kubectl get namespaces -o name 2>/dev/null \
    | grep "namespace/h-itest-" \
    | while read -r ns; do
        name="${ns#namespace/}"
        creation_ts=$(kubectl get namespace "$name" -o jsonpath='{.metadata.creationTimestamp}' \
          | xargs -I{} date -d "{}" +%s 2>/dev/null || echo 0)
        if (( creation_ts == 0 )); then continue; fi  # treat parse failure as "keep"
        age_s=$(( $(date +%s) - creation_ts ))
        if (( age_s > 7200 )); then
          echo "[itest-gc] deleting stale namespace: $name (${age_s}s old)"
          kubectl delete namespace "$name" --ignore-not-found || true
        fi
      done
  echo "[itest-gc] pruning gate images older than 7 days..."
  docker images --format "{{.Repository}}:{{.Tag}} {{.CreatedAt}}" \
    | grep "^${K3D_REGISTRY}/h/" \
    | while IFS=' ' read -r img_tag created_date created_time _tz; do
        img_ts=$(date -d "${created_date} ${created_time}" +%s 2>/dev/null || echo 0)
        cutoff=$(( $(date +%s) - 604800 ))
        if (( img_ts > 0 && img_ts < cutoff )); then
          echo "[itest-gc] removing old image: ${img_tag}"
          docker rmi "${img_tag}" || true
        fi
      done
  echo "[itest-gc] done."
  exit 0
fi

# ── Preamble GC (best-effort) ─────────────────────────────────────────────────
# Sweep stale namespaces and old images before deploying. Never blocks the gate — any failure
# is silently swallowed (kubectl / docker may be temporarily unavailable).
bash "${BASH_SOURCE[0]}" --gc 2>/dev/null || true

# ── Setup ─────────────────────────────────────────────────────────────────────
# Canonicalize WORKTREE to an absolute path, then re-derive REPO_ROOT and EVIDENCE_BASE from it.
# This ensures the harness works correctly when materialised to a temp dir and invoked with the
# real worktree path as $1 (the run-itest activity's D7 isolation pattern).
WORKTREE="$(cd "${1:-${REPO_ROOT}}" && pwd)"
REPO_ROOT="${WORKTREE}"
EVIDENCE_BASE="${REPO_ROOT}/.host-logs/itest"

# Smoke definition: prefer a co-materialized trusted copy alongside this script (the
# run-itest activity materialises it from origin/main next to the harness for D7 isolation);
# fall back to the worktree copy for in-place developer runs.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/smoke-workflow.json" ]]; then
  SMOKE_DEF="${SCRIPT_DIR}/smoke-workflow.json"
else
  SMOKE_DEF="${REPO_ROOT}/scripts/itest/smoke-workflow.json"
fi

ID="$(date +%Y%m%d%H%M%S)-$$"
NS="h-itest-${ID}"
EVIDENCE_DIR="${EVIDENCE_BASE}/${ID}"
mkdir -p "${EVIDENCE_DIR}"

echo "[itest] id=${ID} ns=${NS} worktree=${WORKTREE}"
echo "[itest] evidence dir: ${EVIDENCE_DIR}"

# Content tag: git SHA + optional dirty suffix (worktree hash).
GIT_SHA="$(git -C "${WORKTREE}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
if git -C "${WORKTREE}" diff --quiet 2>/dev/null && git -C "${WORKTREE}" diff --cached --quiet 2>/dev/null; then
  TAG="${GIT_SHA}"
else
  DIRTY_HASH="$(git -C "${WORKTREE}" diff HEAD 2>/dev/null | sha256sum | cut -c1-8)"
  TAG="${GIT_SHA}-dirty-${DIRTY_HASH}"
fi
echo "[itest] content tag: ${TAG}"

WF_SVC_IMAGE="${K3D_REGISTRY}/h/workflow-svc:${TAG}"
STUB_IMAGE="${K3D_REGISTRY}/h/stub-agent:${TAG}"

# ── Teardown trap ─────────────────────────────────────────────────────────────
teardown() {
  local exit_code=$?
  echo "[itest] teardown (exit=${exit_code})..."
  # Kill port-forward if running.
  if [[ -n "${PF_PID:-}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
  fi
  # Dump evidence before namespace deletion (pod logs are lost with the namespace).
  if kubectl get namespace "${NS}" >/dev/null 2>&1; then
    echo "[itest] capturing pod logs and describe to ${EVIDENCE_DIR}/"
    kubectl get pods -n "${NS}" -o wide >"${EVIDENCE_DIR}/pods.txt" 2>&1 || true
    kubectl get all -n "${NS}" >"${EVIDENCE_DIR}/all-resources.txt" 2>&1 || true
    while IFS= read -r pod; do
      kubectl logs -n "${NS}" "${pod}" --all-containers \
        >"${EVIDENCE_DIR}/logs-${pod}.txt" 2>&1 || true
      kubectl describe pod -n "${NS}" "${pod}" \
        >"${EVIDENCE_DIR}/describe-${pod}.txt" 2>&1 || true
    done < <(kubectl get pods -n "${NS}" -o name 2>/dev/null | sed 's|pod/||' || true)
    echo "[itest] deleting namespace ${NS}..."
    kubectl delete namespace "${NS}" --ignore-not-found --timeout=60s || true
  fi
  # Best-effort: prune gate images older than 7 days.
  docker images --format "{{.Repository}}:{{.Tag}} {{.CreatedAt}}" \
    | grep "^${K3D_REGISTRY}/h/" 2>/dev/null \
    | while IFS=' ' read -r img_tag created_date created_time _tz; do
        img_ts=$(date -d "${created_date} ${created_time}" +%s 2>/dev/null || echo 0)
        cutoff=$(( $(date +%s) - 604800 ))
        if (( img_ts > 0 && img_ts < cutoff )); then
          docker rmi "${img_tag}" 2>/dev/null || true
        fi
      done
  echo "[itest] teardown complete."
}
trap teardown EXIT

# ── 1. Verify cluster is reachable ───────────────────────────────────────────
echo "[itest] checking cluster..."
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "[itest] ERROR: cluster not reachable" >&2
  exit 11
fi

# ── 2. Build images from worktree ─────────────────────────────────────────────
echo "[itest] building workflow-svc image..."
if ! docker build \
    -f "${WORKTREE}/apps/workflow-svc/Dockerfile" \
    -t "${WF_SVC_IMAGE}" \
    --build-arg BUILDKIT_INLINE_CACHE=1 \
    "${WORKTREE}" 2>&1 | tee "${EVIDENCE_DIR}/build-workflow-svc.log"; then
  echo "[itest] ERROR: workflow-svc build failed" >&2
  exit 11
fi

echo "[itest] building stub-agent image..."
if ! docker build \
    -f "${WORKTREE}/apps/stub-agent/Dockerfile" \
    -t "${STUB_IMAGE}" \
    --build-arg BUILDKIT_INLINE_CACHE=1 \
    "${WORKTREE}" 2>&1 | tee "${EVIDENCE_DIR}/build-stub-agent.log"; then
  echo "[itest] ERROR: stub-agent build failed" >&2
  exit 11
fi

# ── 3. Push to k3d registry ──────────────────────────────────────────────────
echo "[itest] pushing images to ${K3D_REGISTRY}..."
if ! docker push "${WF_SVC_IMAGE}" 2>&1 | tee "${EVIDENCE_DIR}/push-workflow-svc.log"; then
  echo "[itest] ERROR: workflow-svc push failed" >&2
  exit 11
fi
if ! docker push "${STUB_IMAGE}" 2>&1 | tee "${EVIDENCE_DIR}/push-stub-agent.log"; then
  echo "[itest] ERROR: stub-agent push failed" >&2
  exit 11
fi

# ── 4. Generate per-run overlay ───────────────────────────────────────────────
OVERLAY_DIR="${EVIDENCE_DIR}/overlay"
mkdir -p "${OVERLAY_DIR}/patches"
# Copy the full k8s tree into the overlay dir so kustomize's LoadRestrictionsRootOnly is
# satisfied and the base kustomization's ../../infra / ../../dapr / ../../apps resource
# references resolve correctly from within the overlay root.
cp -r "${WORKTREE}/k8s" "${OVERLAY_DIR}/k8s"

cat >"${OVERLAY_DIR}/patches/cron-5s.yaml" <<'EOF'
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: workflow-cron-tick
spec:
  metadata:
    - name: schedule
      value: "@every 5s"
EOF

cat >"${OVERLAY_DIR}/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: ${NS}

resources:
  - ./k8s/itest/base

images:
  - name: h/workflow-svc
    newName: ${K3D_REGISTRY_CLUSTER}/h/workflow-svc
    newTag: "${TAG}"
  - name: h/stub-agent
    newName: ${K3D_REGISTRY_CLUSTER}/h/stub-agent
    newTag: "${TAG}"

patches:
  - path: patches/cron-5s.yaml
    target:
      kind: Component
      name: workflow-cron-tick
EOF

# ── 5. Deploy ephemeral namespace ─────────────────────────────────────────────
echo "[itest] creating namespace ${NS}..."
kubectl create namespace "${NS}" || { echo "[itest] ERROR: namespace create failed" >&2; exit 11; }

echo "[itest] deploying overlay..."
# Render with load restrictions relaxed: the checked-in base deliberately references the
# shared manifests by ../.. FILE paths (reference, don't duplicate), which kustomize's
# default LoadRestrictionsRootOnly forbids regardless of where the staged tree sits.
# `kubectl apply -k` exposes no flag for this, so render and apply as two steps.
if ! kubectl kustomize --load-restrictor LoadRestrictionsNone "${OVERLAY_DIR}" \
    >"${EVIDENCE_DIR}/rendered.yaml" 2>"${EVIDENCE_DIR}/apply.log"; then
  cat "${EVIDENCE_DIR}/apply.log" >&2
  echo "[itest] ERROR: kustomize render failed" >&2
  exit 11
fi
if ! kubectl apply -f "${EVIDENCE_DIR}/rendered.yaml" 2>&1 | tee -a "${EVIDENCE_DIR}/apply.log"; then
  echo "[itest] ERROR: kubectl apply failed" >&2
  exit 11
fi

echo "[itest] waiting for pods to be ready (120s)..."
# `kubectl wait --all` errors out instantly ("no matching resources found") when it races the
# Deployment controller and no pods exist yet — poll for pod existence first (3 deployments).
PODS_EXIST_DEADLINE=$(( $(date +%s) + 60 ))
while (( $(date +%s) < PODS_EXIST_DEADLINE )); do
  POD_COUNT=$(kubectl get pods -n "${NS}" --no-headers 2>/dev/null | wc -l)
  (( POD_COUNT >= 3 )) && break
  sleep 2
done
if (( POD_COUNT < 3 )); then
  echo "[itest] ERROR: pods never appeared (count=${POD_COUNT})" >&2
  exit 11
fi
if ! kubectl wait --for=condition=ready pod --all -n "${NS}" --timeout=120s 2>&1 | tee "${EVIDENCE_DIR}/wait.log"; then
  echo "[itest] ERROR: pods not ready within 120s" >&2
  exit 11
fi
kubectl get pods -n "${NS}" >"${EVIDENCE_DIR}/pods-ready.txt" 2>&1 || true

# ── 6. Port-forward workflow-svc ──────────────────────────────────────────────
echo "[itest] port-forwarding workflow-svc:${WF_SVC_NAMESPACE_PORT} → localhost:${WF_SVC_PORT_LOCAL}..."
kubectl port-forward -n "${NS}" svc/workflow-svc "${WF_SVC_PORT_LOCAL}:${WF_SVC_NAMESPACE_PORT}" &
PF_PID=$!
# Wait for the port-forward to establish.
for i in $(seq 1 15); do
  if curl -sf "http://localhost:${WF_SVC_PORT_LOCAL}/workflow/list" >/dev/null 2>&1; then
    echo "[itest] port-forward ready."
    break
  fi
  sleep 1
  if (( i == 15 )); then
    echo "[itest] ERROR: workflow-svc port-forward not ready after 15s" >&2
    exit 11
  fi
done

# ── 7. Fire smoke workflow ────────────────────────────────────────────────────
INSTANCE_ID="smoke-${ID}"
echo "[itest] firing smoke workflow (instanceId=${INSTANCE_ID}, smoke-def=${SMOKE_DEF})..."

SMOKE_BODY="$(cat "${SMOKE_DEF}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['instanceId'] = '${INSTANCE_ID}'
print(json.dumps(d))
")"

echo "${SMOKE_BODY}" >"${EVIDENCE_DIR}/smoke-request.json"

HTTP_STATUS=$(curl -s -w "%{http_code}" -o "${EVIDENCE_DIR}/smoke-response.json" \
  -X POST "http://localhost:${WF_SVC_PORT_LOCAL}/workflow/run" \
  -H "Content-Type: application/json" \
  -d "${SMOKE_BODY}" 2>&1 || echo "000")

if [[ "${HTTP_STATUS}" != "200" && "${HTTP_STATUS}" != "202" ]]; then
  echo "[itest] ERROR: workflow fire returned HTTP ${HTTP_STATUS}" >&2
  cat "${EVIDENCE_DIR}/smoke-response.json" >&2 || true
  exit 11
fi

# ── 8. Poll for COMPLETED ─────────────────────────────────────────────────────
echo "[itest] polling for workflow COMPLETED (60s)..."
DEADLINE=$(( $(date +%s) + 60 ))
STATUS=""
while (( $(date +%s) < DEADLINE )); do
  STATUS_RESP=$(curl -sf "http://localhost:${WF_SVC_PORT_LOCAL}/workflow/status/${INSTANCE_ID}" 2>/dev/null || echo '{}')
  STATUS=$(echo "${STATUS_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('runtimeStatus',''))" 2>/dev/null || echo "")
  echo "[itest] status=${STATUS}"
  if [[ "${STATUS}" == "COMPLETED" ]]; then
    break
  fi
  if [[ "${STATUS}" == "FAILED" || "${STATUS}" == "TERMINATED" ]]; then
    echo "[itest] ASSERTION FAIL: workflow reached terminal status ${STATUS}" >&2
    echo "${STATUS_RESP}" >"${EVIDENCE_DIR}/status-final.json"
    exit 10
  fi
  sleep 2
done
echo "${STATUS_RESP:-}" >"${EVIDENCE_DIR}/status-final.json"
if [[ "${STATUS}" != "COMPLETED" ]]; then
  echo "[itest] ASSERTION FAIL: workflow not COMPLETED after 60s (status=${STATUS})" >&2
  exit 10
fi
echo "[itest] workflow COMPLETED."

# ── 9. Assert wf: row ────────────────────────────────────────────────────────
echo "[itest] asserting wf: row..."
REDIS_POD=$(kubectl get pods -n "${NS}" -l app=redis -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -z "${REDIS_POD}" ]]; then
  echo "[itest] ASSERTION FAIL: redis pod not found" >&2
  exit 10
fi

WF_ROW_KEY="wf:h-itest:smoke:smoke"
# Dapr's Redis state store persists each key as a HASH ({data, version}), not a plain string —
# a GET returns WRONGTYPE. The row's JSON lives in the `data` field.
WF_ROW=$(kubectl exec -n "${NS}" "${REDIS_POD}" -- redis-cli HGET "${WF_ROW_KEY}" data 2>/dev/null || echo "")
echo "${WF_ROW}" >"${EVIDENCE_DIR}/wf-row.json"

if [[ -z "${WF_ROW}" ]]; then
  echo "[itest] ASSERTION FAIL: wf: row not found (key=${WF_ROW_KEY})" >&2
  exit 10
fi

WF_STATUS=$(echo "${WF_ROW}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
# WfRow.resolved is the goal-handshake field (boolean) written by write-wf-row from the
# structured output's `goal: "RESOLVED"` field — there is no top-level `structured` key.
GOAL=$(echo "${WF_ROW}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('RESOLVED' if d.get('resolved') else '')
" 2>/dev/null || echo "")

echo "[itest] wf:row status=${WF_STATUS} goal=${GOAL}"
if [[ "${WF_STATUS}" != "done" ]]; then
  echo "[itest] ASSERTION FAIL: wf: row status=${WF_STATUS}, expected done" >&2
  exit 10
fi
if [[ "${GOAL}" != "RESOLVED" ]]; then
  echo "[itest] ASSERTION FAIL: wf: row goal=${GOAL}, expected RESOLVED" >&2
  exit 10
fi
echo "[itest] wf: row asserted OK."

# ── 10. Assert watch row finalised ───────────────────────────────────────────
echo "[itest] polling for watch row finalized (30s)..."
WATCH_DEADLINE=$(( $(date +%s) + 30 ))
WATCH_OUTCOME=""
while (( $(date +%s) < WATCH_DEADLINE )); do
  WATCH_RESP=$(curl -sf "http://localhost:${WF_SVC_PORT_LOCAL}/watch/list" 2>/dev/null || echo '{"watches":[]}')
  WATCH_OUTCOME=$(echo "${WATCH_RESP}" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for w in (data.get('watches') or []):
    if w.get('instanceId') == '${INSTANCE_ID}':
        print(w.get('outcome',''))
        break
" 2>/dev/null || echo "")
  echo "[itest] watch outcome=${WATCH_OUTCOME}"
  if [[ -n "${WATCH_OUTCOME}" && "${WATCH_OUTCOME}" != "null" && "${WATCH_OUTCOME}" != "watching" ]]; then
    break
  fi
  sleep 3
done
echo "${WATCH_RESP:-}" >"${EVIDENCE_DIR}/watch-list.json"

if [[ -z "${WATCH_OUTCOME}" || "${WATCH_OUTCOME}" == "null" || "${WATCH_OUTCOME}" == "watching" ]]; then
  echo "[itest] ASSERTION FAIL: watch row not finalized after 30s (outcome=${WATCH_OUTCOME})" >&2
  exit 10
fi
echo "[itest] watch row finalized: outcome=${WATCH_OUTCOME}"

# ── Done ─────────────────────────────────────────────────────────────────────
END_TS=$(date +%s)
echo "[itest] ALL ASSERTIONS PASSED. Evidence: ${EVIDENCE_DIR}/"
echo "${TAG}" >"${EVIDENCE_DIR}/content-tag.txt"
echo "${ID}" >"${EVIDENCE_DIR}/run-id.txt"
exit 0
