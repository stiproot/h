import json
from dataclasses import asdict
from pathlib import Path

from domain.models import GraphConfig


class PresetStore:
    """Stores named graph configs as JSON files under <base_dir>/presets/."""

    def __init__(self, base_dir: Path) -> None:
        self._dir = base_dir / "presets"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        if not key or "/" in key or "\\" in key or ".." in key:
            raise ValueError(f"Invalid preset key: {key!r}")
        return self._dir / f"{key}.json"

    def save(self, key: str, graph: GraphConfig) -> None:
        self._path(key).write_text(json.dumps(asdict(graph)))

    def get(self, key: str) -> GraphConfig | None:
        path = self._path(key)
        if not path.exists():
            return None
        return GraphConfig(**json.loads(path.read_text()))
