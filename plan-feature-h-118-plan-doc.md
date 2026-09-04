## Context

`h workflow run plan --local` produces a plan only in the run ledger's structured block. Downstream repos keep plans as documents (`docs/plans/<name>.md` with Status/Established headers). A driver currently copies the plan out by hand. The fix: a conditional 4th step `persist` is emitted only when `plan.persist: true` in values. The plan step cannot write files (it runs under `permissionMode: plan`), so a separate step does the write.

---

## Files to change

| File | What changes |
|---|---|
| `cli/charts/workflows/values.yaml` | Add `persist: false` and `planName: ""` to the `plan:` block |
| `cli/charts/workflows/templates/plan.tmpl.yaml` | New `h.contract.plan-persist` contract; conditional persist step; planName param slot; merged `outputs:`; updated header comment |
| `cli/h/tests/test_render.py` | Add `test_plan_persist_publish_golden`; extend `test_plan_stops_at_the_plan_and_declares_it` |
| `cli/h/tests/__snapshots__/test_render.ambr` | Add ONE new snapshot block (`test_plan_persist_publish_golden`) only |

---

## `values.yaml` changes

In the `plan:` block (after line 246), add:

```yaml
  # When true the run ends with a `persist` step that writes the plan as a document in the
  # target repo's plan convention and commits it; the fire-time `planName` param names the doc.
  # Off by default so the template stays the pure planning half.
  persist: false
  # Default name for the plan document when persist is true. Empty = no doc written.
  planName: ""
```

---

## `plan.tmpl.yaml` changes

**1. New named contract** (before or after `h.contract.plan` define block):
```
{{- define "h.contract.plan-persist" -}}
type: object
required:
  - planPath
properties:
  planPath:
    type: string
    description: >-
      repo-relative path of the plan document written and committed; empty string when
      planName was empty and nothing was written
{{- end }}
```

**2. Header comment** — add to `Fire-time params:`: `planName` (used when persist is true, empty = skip). Add to `Template config`: `plan.persist`, `plan.planName`.

**3. New variables** (after line 68, after `$contract` assignment):
```
{{- $persistContract := include "h.contract.plan-persist" . | fromYaml }}
{{- $persist := $p.persist | default false }}
{{- $planNameRef := ternary (include "h.token" "params.planName") ($p.planName | default "") $publish }}
```

**4. `params:` block** — when `$persist` is true, add `planName: {{ $p.planName | default "" | quote }}` after the existing params.

**5. Conditional `persist` step** — appended after the `plan` step, before `outputs:`:
Key: **no `permissionMode`** on this step.

**6. `outputs:` block** — conditionally include `planPath` property when `$persist` is true; `plan` stays required unconditionally.

---

## `test_render.py` changes

**New golden test:**
```python
def test_plan_persist_publish_golden(snapshot) -> None:
    rendered = helm.render_workflow(
        "plan", values={"publish": "true", "plan.persist": "true"}, include_local=False
    )
    assert rendered == snapshot
```

**Extended structural test** — replace `test_plan_stops_at_the_plan_and_declares_it` to assert:
- persist=false → steps `["worktree", "setup", "plan"]` (all existing assertions unchanged)
- persist=true → steps `["worktree", "setup", "plan", "persist"]`; persist step has `"permissionMode" not in persist_step["input"]`

---

## Snapshot strategy (trap prevention)

Run these three commands in order and record output in `demonstrations`:

1. **Before any change**: `pytest cli/h/tests/test_render.py -k plan_publish_golden` → must pass, 0 snapshots written
2. **After template change, no `--snapshot-update`**: same command → must still pass (proves default render unchanged)
3. **Bless only the new test**: `pytest cli/h/tests/test_render.py --snapshot-update -k plan_persist_publish_golden` → 1 snapshot written

Any diff to the existing `test_plan_publish_golden` block in `.ambr` is a reject.

---

## Demonstrations required by spec

**(a)** Render with `plan.persist=true` before extending the structural test; confirm existing step-list assertion `["worktree", "setup", "plan"]` fails.

**(b)** Temporarily add `permissionMode: plan` to the persist step; confirm `assert "permissionMode" not in persist_step["input"]` fails; revert.
