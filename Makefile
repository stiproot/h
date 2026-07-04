# =============================================================================
# h Makefile
# =============================================================================
#
# Authoring conventions — read before adding a target:
#
#   1. .PHONY  Every target that does not produce a real file must appear in
#              a .PHONY declaration. Group the declaration with the targets it
#              covers so readers see it next to the relevant recipes.
#
#   2. Help    Add a ## description on the same line as the target name.
#              The `help` target scrapes these automatically.
#              Example:  my-target: ## What this target does
#
#   3. Variables  All tuneable values belong at the top of this file in
#              UPPER_SNAKE_CASE. Never hard-code a value inside a recipe that
#              a caller might want to override via the environment.
#              Use ?= so the caller can override: make dapr-install DAPR_VERSION=1.18.0
#
#   4. Idempotency  Prefer commands that are safe to re-run:
#                   - helm upgrade --install   (not helm install)
#                   - kubectl apply            (not kubectl create)
#                   - --ignore-not-found       on kubectl delete / helm uninstall
#
#   5. Fail fast  Chain dependent commands with && in multi-line recipes, or
#              use a sub-shell with set -e. Do not swallow errors silently.
#
#   6. Verbosity  Omit @ on commands whose output helps the user understand
#              what ran (helm, kubectl, tilt). Use @ only on pure echo/printf
#              formatting lines inside `help`.
#
# =============================================================================

# ── Variables ─────────────────────────────────────────────────────────────────

DAPR_VERSION   ?= 1.17.9
DAPR_NAMESPACE ?= dapr-system

ZELLIJ_SESSION ?= h
DEV_LAYOUT     ?= .zellij/dev.kdl

WORKSPACE_DIR  ?= $(abspath $(CURDIR)/../h-workspace)
# Pre-cloned target repo dir under the workspace root (see cli/scripts/clone.sh)
TARGET_REPO_DIR ?= repo

# ── Default target ────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

# ── Help ──────────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ── Local infra (Docker Compose) ────────────────────────────────────────────────
#
# Starts the shared infrastructure (placement, scheduler, redis, zipkin, logging)
# used by the local dev flow that runs agents via the `dapr` CLI run scripts.
# The local override fixes the scheduler's broadcast address so host-side daprd
# processes can reach it on macOS (see docker-compose.local.yml).

.PHONY: infra-up
infra-up: ## Start local infra via Docker Compose (placement, scheduler, redis, logging)
	docker compose --profile infra -f docker-compose.yml -f docker-compose.local.yml up --build -d

.PHONY: infra-down
infra-down: ## Stop local infra and remove volumes
	docker compose --profile infra -f docker-compose.yml -f docker-compose.local.yml down -v

# ── Tests ─────────────────────────────────────────────────────────────────────
#
# One command across both ecosystems. `test-js` runs vitest via Turborepo; `test-py`
# runs the pure-unit Python suite (agent-core). The h CLI's helm-gated golden tests are
# a separate category — run them with `uv run --package h-cli pytest cli/h`.

.PHONY: test test-js test-py
test: test-js test-py ## Run all unit tests (JS + Python)

test-js: ## Run the JS/TS unit tests (turbo → vitest)
	bun run test

test-py: ## Run the Python unit tests (pytest)
	uv run --package agent-core pytest packages/py/agent-core

.PHONY: worktrees-purge
worktrees-purge: ## Remove all git worktrees from the shared workspace (git worktree remove + prune)
	@if [ ! -d "$(WORKSPACE_DIR)/worktrees" ]; then \
	  echo "Nothing to purge — $(WORKSPACE_DIR)/worktrees does not exist."; exit 0; \
	fi; \
	for wt in "$(WORKSPACE_DIR)/worktrees/"/*/; do \
	  [ -d "$$wt" ] || continue; \
	  echo "Removing worktree: $$wt"; \
	  git -C "$(WORKSPACE_DIR)/$(TARGET_REPO_DIR)" worktree remove --force "$$wt" 2>/dev/null || rm -rf "$$wt"; \
	done; \
	git -C "$(WORKSPACE_DIR)/$(TARGET_REPO_DIR)" worktree prune; \
	echo "Done."

# ── Dapr ──────────────────────────────────────────────────────────────────────
#
# One-time cluster setup.  Run `make dapr-install` once after enabling
# Kubernetes in Rancher Desktop.  Run `make dapr-uninstall` to fully remove
# Dapr before tearing the cluster down.
#
# Both targets are idempotent and safe to re-run.

.PHONY: dapr-install dapr-uninstall
dapr-install: ## Install the Dapr control plane via Helm (idempotent)
	helm repo add dapr https://dapr.github.io/helm-charts/ --force-update
	helm upgrade --install dapr dapr/dapr \
	  --version $(DAPR_VERSION) \
	  --namespace $(DAPR_NAMESPACE) \
	  --create-namespace \
	  --wait

dapr-uninstall: ## Uninstall the Dapr control plane, its namespace, and all Dapr CRDs
	helm uninstall dapr --namespace $(DAPR_NAMESPACE) --ignore-not-found
	kubectl delete namespace $(DAPR_NAMESPACE) --ignore-not-found
	@for crd in $$(kubectl get crd -o name 2>/dev/null | grep '\.dapr\.io'); do \
	  kubectl delete $$crd --ignore-not-found; \
	done

# ── Kubernetes inspection ─────────────────────────────────────────────────────
#
# Read-only targets for checking cluster state.  These never mutate anything.

.PHONY: pods pods-dapr
pods: ## Show pods in the default namespace (Tilt-managed app stack)
	kubectl get pods -n default

pods-dapr: ## Show pods in the dapr-system namespace (Helm-managed control plane)
	kubectl get pods -n dapr-system

# ── Tilt ──────────────────────────────────────────────────────────────────────
#
# Daily start/stop for the dev stack.
#
# Prerequisites for `tilt-up`:
#   1. Kubernetes enabled in Rancher Desktop
#   2. `make dapr-install` completed
#   3. `cli/scripts/gen-k8s-secrets.sh` run (creates k8s/secrets/app-secrets.yaml)

.PHONY: tilt-up tilt-down tilt-trigger
tilt-up: ## Start the Tilt dev stack (opens Tilt UI at http://localhost:10350)
	tilt up

tilt-down: ## Stop the Tilt dev stack and remove its Kubernetes resources
	tilt down

tilt-trigger: ## Force-rebuild and redeploy one service (usage: make tilt-trigger SERVICE=workflow)
	tilt trigger $(SERVICE)

# ── Local dev session (zellij) ──────────────────────────────────────────────────
#
# Launch every app service — one pane each, via the dapr CLI run scripts — in a
# single zellij session. Assumes `make infra-up` is already running (redis,
# placement, scheduler). The layout omits dapr-claude-loop-agent, which shares
# internal gRPC port 50005 with dapr-agent.
#
# zellij refuses to start a session from inside another, so `dev` is for a plain
# terminal. Use `dev-tab` to add the stack to the session you are already in.

.PHONY: dev dev-tab
dev: ## Launch all services in a dedicated zellij session 'h' (plain terminal; needs infra-up)
	@if [ -n "$$ZELLIJ" ]; then \
	  echo "Already inside a zellij session — run 'make dev' from a plain terminal, or 'make dev-tab' to add it here."; \
	  exit 1; \
	fi
	@zellij delete-session $(ZELLIJ_SESSION) --force >/dev/null 2>&1 || true
	zellij --session $(ZELLIJ_SESSION) --layout $(DEV_LAYOUT)

dev-tab: ## Add the service stack as a new named tab in the current zellij session (needs infra-up)
	zellij action new-tab --cwd "$(CURDIR)" --name $(ZELLIJ_SESSION) --layout $(DEV_LAYOUT)
