"""Env-derived settings — defaults mirror the cli/scripts siblings, overridable the same way.

The CLI is installed editable as a uv workspace member, so file-relative resolution reaches the
repo checkout: this file lives at cli/h/src/h_cli/config.py, making parents[3] the cli/ dir.
"""

import os
from pathlib import Path

_CLI_DIR = Path(__file__).resolve().parents[3]

# Template source (strategy 2 — see cli/README.md) and the gitignored feature-spec home.
CHARTS_DIR = Path(os.getenv("H_CHARTS_DIR", str(_CLI_DIR / "charts")))
FEATURE_SPECS_DIR = Path(
    os.getenv("H_FEATURE_SPECS_DIR", str(_CLI_DIR / "scripts/payloads/domain/feature-requests"))
)

WORKFLOW_URL = os.getenv("WORKFLOW_URL", "http://localhost:8003")  # workflow-svc app
AGENT_URL = os.getenv("AGENT_URL", "http://localhost:8010")  # workflow-agent app
DAPR_HTTP_PORT = os.getenv("DAPR_HTTP_PORT", "3510")  # workflow-agent's Dapr sidecar
STATE_URL = f"http://localhost:{DAPR_HTTP_PORT}/v1.0/state/statestore"
