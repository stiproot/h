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

ZELLIJ_SESSION      ?= h
DEV_LAYOUT          ?= .zellij/dev.kdl
H_BUILDS_H_LAYOUT   ?= .zellij/h-builds-h.kdl
H_BUILDS_H_SESSION  ?= h-builds-h

# Headless host-mode launcher (up-local/wait-local/down-local) — MODE selects the service set.
MODE                ?= dev

WORKSPACE_DIR  ?= $(abspath $(CURDIR)/../h-workspace)
# Pre-cloned target repo dir under the workspace root (see cli/scripts/clone.sh)
TARGET_REPO_DIR ?= repo

# k3d cluster backing the Tilt path (see the k3d section below). The registry is REQUIRED:
# Tilt detects it via the standard local-registry-hosting ConfigMap and pushes there instead of
# trying to push to Docker Hub.
K3D_CLUSTER       ?= h
K3D_REGISTRY      ?= h-registry
K3D_REGISTRY_PORT ?= 5111

# ── Default target ────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

# ── Help ──────────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ── Local infra (Docker Compose) ────────────────────────────────────────────────
#
# Starts the shared infrastructure (placement, scheduler, redis, zipkin, logging)
# used by the local dev flow that runs agents via the `dapr` CLI run scripts.
# The local override fixes the scheduler's broadcast address so host-side daprd
# processes can reach it on macOS (see docker-compose.local.yml).

.PHONY: infra-up
infra-up: ## Start local infra via Docker Compose (placement, scheduler, redis, logging)
	# The scheduler's ./dapr-etcd bind mount: docker creates a missing bind dir ROOT-owned and the
	# nonroot scheduler then fatals (mkdir /data/...: permission denied — bit us 2026-07-25 after a
	# from-scratch reset). Pre-create it world-writable so a reset can never brick the scheduler.
	mkdir -p dapr-etcd && chmod 0777 dapr-etcd 2>/dev/null || true
	cli/scripts/compose.sh --profile infra -f docker-compose.yml -f docker-compose.local.yml up --build -d

.PHONY: infra-down
infra-down: ## Stop local infra and remove volumes
	cli/scripts/compose.sh --profile infra -f docker-compose.yml -f docker-compose.local.yml down -v

.PHONY: agent-bases
agent-bases: ## Build the shared agent base images (the process-identity model) — run before `docker compose build`
	docker build -f docker/agent-base-bun.Dockerfile -t h-agent-base-bun .
	docker build -f docker/agent-base-py.Dockerfile -t h-agent-base-py .

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
	uv run --package langgraph-agent pytest apps/langgraph-agent/tests
	# The LLM-invoked tool surface (write_file / read_skill) takes a MODEL-supplied path, so its
	# workspace-containment tests are not optional — these two apps had ZERO tests before.
	uv run --package dapr-agent pytest apps/dapr-agent/tests
	uv run --package dapr-claude-loop-agent pytest apps/dapr-claude-loop-agent/tests

# -----------------------------------------------------------------------------
# Lint — hygiene AND architecture. `lint-js` runs tsc + oxfmt/oxlint and, on the
# hex services, the dependency-cruiser boundary rules (.dependency-cruiser.cjs).
# `lint-py` runs ruff repo-wide and, on the hex agents, the import-linter boundary
# contracts (the [tool.importlinter] blocks). Both enforce the same hexagonal invariants:
# a pure domain, adapters that never import each other. The flat namespace packages
# need `src` on the path so `domain`/`infrastructure`/`presentation` resolve as roots.
# -----------------------------------------------------------------------------

.PHONY: lint lint-js lint-py
lint: lint-js lint-py ## Run all linters + architecture checks (JS + Python)

lint-js: ## Lint JS/TS (turbo → tsc + oxfmt/oxlint + dependency-cruiser hex rules)
	bun run lint

lint-py: ## Lint all Python (repo-wide ruff hygiene + import-linter hex contracts)
	# ruff resolves each file's nearest [tool.ruff] config, so one pass covers the whole
	# tree — including the workspace-excluded claude-managed-agent.
	uv run ruff check apps packages/py cli/h
	cd apps/workflow-agent && PYTHONPATH=src uv run lint-imports
	cd apps/langgraph-agent && PYTHONPATH=src uv run lint-imports
	# claude-managed-agent is the workspace-excluded standalone member (own uv.lock),
	# so its contracts run in its own env — architecture is enforced everywhere it applies.
	cd apps/claude-managed-agent && PYTHONPATH=src uv run lint-imports

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
# Prerequisites for `tilt-up` — `make k3d-up` does 1 for you on Linux:
#   1. A Kubernetes cluster (Rancher Desktop on macOS, or `make k3d-up`)
#   2. `make dapr-install` completed
#   3. `cli/scripts/gen-k8s-secrets.sh` run (creates k8s/secrets/app-secrets.yaml)
#
# From nothing to a running stack:
#   make k3d-up && make dapr-install && cli/scripts/gen-k8s-secrets.sh && make tilt-up

.PHONY: tilt-up tilt-down tilt-trigger
tilt-up: ## Start the Tilt dev stack (opens Tilt UI at http://localhost:10350)
	tilt up

tilt-down: ## Stop the Tilt dev stack and remove its Kubernetes resources
	tilt down

tilt-trigger: ## Force-rebuild and redeploy one service (usage: make tilt-trigger SERVICE=workflow)
	tilt trigger $(SERVICE)

# ── k3d cluster (the Tilt path's Kubernetes, Linux-friendly) ────────────────────
#
# Rancher Desktop supplies the cluster on macOS; on Linux this creates an equivalent one in
# Docker. The `--registry-create` is LOAD-BEARING, not a convenience: Tilt detects a
# cluster-attached registry through the standard local-registry-hosting ConfigMap and pushes
# images there. WITHOUT it Tilt falls back to pushing `h/workflow-svc` to Docker Hub and every
# build dies with `push access denied` — even though it correctly reports `Env: k3d`.
#
# kubectl/k3d/tilt are single static binaries; none needs root:
#   curl -sLo ~/.local/bin/kubectl "https://dl.k8s.io/release/$$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x ~/.local/bin/kubectl

.PHONY: k3d-up k3d-down
k3d-up: ## Create the k3d cluster + local registry that the Tilt path needs (idempotent)
	@if k3d cluster list $(K3D_CLUSTER) >/dev/null 2>&1; then \
	  echo "k3d cluster '$(K3D_CLUSTER)' already exists — starting it if stopped"; \
	  k3d cluster start $(K3D_CLUSTER) || true; \
	else \
	  k3d cluster create $(K3D_CLUSTER) --servers 1 --agents 0 \
	    --registry-create $(K3D_REGISTRY):0.0.0.0:$(K3D_REGISTRY_PORT) --wait --timeout 240s; \
	fi
	kubectl cluster-info

k3d-down: ## Delete the k3d cluster and its registry
	k3d cluster delete $(K3D_CLUSTER) || true

# ── Tear everything down ───────────────────────────────────────────────────────
#
# One entry point for "stop whatever I started", across all three modes — host-local services,
# Docker Compose infra, and the Tilt/k8s path. Every step tolerates the thing not being there,
# so it is safe to run from any state (that is the point: you should not have to remember which
# mode you were in). Use the granular targets when you want to keep part of the stack.

.PHONY: down
down: ## Tear down EVERYTHING (host-local services, compose infra, Tilt, k3d cluster)
	-$(MAKE) down-local MODE=dev
	-$(MAKE) down-local MODE=h-builds-h
	-tilt down 2>/dev/null || true
	-$(MAKE) k3d-down
	-$(MAKE) infra-down
	@echo ""
	@echo "==> all h services torn down."
	@echo "    Remaining by design: the shared workspace ($(WORKSPACE_DIR)) and the bun/turbo caches."
	@echo "    Worktrees cut by chains: make worktrees-purge"

# ── Local dev session (zellij) ──────────────────────────────────────────────────
#
# Launch every app service — one pane each, via the dapr CLI run scripts — in a
# single zellij session. Assumes `make infra-up` is already running (redis,
# placement, scheduler).
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

# ── h-builds-h supervised session (zellij) ─────────────────────────────────────────────────
#
# Like dev / dev-tab but uses the h-builds-h.kdl layout: all services run under
# cli/scripts/_supervise.sh, which restarts them automatically on exit with capped
# exponential backoff. claude-agent is the loop's executor (trust model — claude-coder retired).
# Use this layout for unattended cron-driven operation; use dev / dev-tab for interactive dev.

.PHONY: h-builds-h h-builds-h-tab
h-builds-h: ## Launch the supervised h-builds-h stack in a dedicated zellij session (plain terminal; needs infra-up)
	@if [ -n "$$ZELLIJ" ]; then \
	  echo "Already inside a zellij session — run 'make h-builds-h' from a plain terminal, or 'make h-builds-h-tab' to add it here."; \
	  exit 1; \
	fi
	@zellij delete-session $(H_BUILDS_H_SESSION) --force >/dev/null 2>&1 || true
	zellij --session $(H_BUILDS_H_SESSION) --layout $(H_BUILDS_H_LAYOUT)

h-builds-h-tab: ## Add the supervised h-builds-h stack as a new tab in the current zellij session (needs infra-up)
	zellij action new-tab --cwd "$(CURDIR)" --name $(H_BUILDS_H_SESSION) --layout $(H_BUILDS_H_LAYOUT)

# ── Headless host-mode launcher (no zellij/TTY) ────────────────────────────────
#
# The non-interactive sibling of dev/h-builds-h: an agent (or CI) can stand up the
# stack and know when it is ready, using detached, RETURNING commands. Reuses the
# same run scripts, stop_stale idempotency, and _supervise.sh restart logic — only
# the orchestration layer differs (detached process groups + log files, not zellij
# panes). MODE=dev (default) or MODE=h-builds-h. See docs/plans/impl/agent-local-mode-bringup.md.

.PHONY: up-local wait-local up-local-wait down-local
up-local: infra-up ## Start all host-mode services detached (MODE=dev|h-builds-h); returns immediately
	cli/scripts/up-local.sh $(MODE)

wait-local: ## Block until every host-mode service is listening, or timeout (MODE=dev|h-builds-h)
	cli/scripts/wait-local.sh $(MODE)

up-local-wait: up-local ## Start the stack detached, then block until it is ready (MODE=dev|h-builds-h)
	cli/scripts/wait-local.sh $(MODE)

down-local: ## Stop all host-mode services for MODE (leaves infra up; use infra-down for that)
	cli/scripts/down-local.sh $(MODE)
