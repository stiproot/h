#!/bin/bash
# Shared helpers for chart-rendered workflows (helm template → workflow definition). Sourced, not executed.
#
# The charts under cli/charts/ are the template source. Rendered output is YAML — the canonical
# artifact. JSON is a *final processing step*, applied only at the wire boundary (workflow-svc and
# workflow-mcp's run_workflow speak JSON today) via yaml_to_json; nothing upstream of that step
# should assume JSON.

CHARTS_DIR="${CHARTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../charts" && pwd)}"

# render_workflow <family> [helm-value-args...]
# Renders one workflow family's template (cli/charts/workflows/templates/<family>.yaml) with the
# given helm value args (--set / --set-file / --values). Merges the gitignored org-specific
# overrides (values.local.yaml) when present. Emits the workflow definition as YAML on stdout,
# stripped of helm's document separator and "# Source:" comment.
render_workflow() {
  local family="$1"; shift
  command -v helm >/dev/null || { echo "render_workflow: helm is required (https://helm.sh)" >&2; return 1; }
  local chart="${CHARTS_DIR}/workflows"
  local -a extra=()
  [[ -f "${chart}/values.local.yaml" ]] && extra+=(--values "${chart}/values.local.yaml")
  helm template "$family" "$chart" -s "templates/${family}.yaml" "${extra[@]}" "$@" \
    | sed '/^---$/d; /^# Source: /d'
}

# yaml_to_json
# Final processing step: YAML on stdin → compact JSON on stdout. Exists only because today's
# consumers speak JSON on the wire; a YAML-speaking consumer would simply skip it.
yaml_to_json() {
  python3 -c 'import sys, json, yaml; json.dump(yaml.safe_load(sys.stdin), sys.stdout, ensure_ascii=False)'
}
