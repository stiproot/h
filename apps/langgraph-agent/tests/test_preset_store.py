from pathlib import Path

import pytest

from domain.models import GraphConfig
from infrastructure.preset_store import PresetStore


@pytest.mark.parametrize("key", ["", "a/b", "a\\b", "..", "../x"])
def test_invalid_keys_are_rejected(tmp_path: Path, key: str) -> None:
    with pytest.raises(ValueError):
        PresetStore(tmp_path)._path(key)


def test_graph_config_round_trip_covers_every_field(tmp_path: Path) -> None:
    store = PresetStore(tmp_path)
    graph = GraphConfig(
        tools=["search", "read"],
        system_prompt="be precise",
        model="model-1",
        max_iterations=7,
    )
    store.save("complete", graph)
    assert store.get("complete") == graph


def test_missing_preset_returns_none(tmp_path: Path) -> None:
    assert PresetStore(tmp_path).get("missing") is None


def test_valid_key_writes_strictly_under_presets(tmp_path: Path) -> None:
    store = PresetStore(tmp_path)
    store.save("valid-key", GraphConfig())
    written = tmp_path / "presets" / "valid-key.json"
    assert written.is_file()
    assert written.resolve().is_relative_to((tmp_path / "presets").resolve())
