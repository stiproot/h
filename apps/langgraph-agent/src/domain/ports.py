"""Domain ports — the interfaces the pure core defines and the adapters implement.

The inbound HTTP adapter (presentation) depends on this Protocol, not on the concrete
`infrastructure.PresetStore`, so the dependency arrow points *into* the domain. Protocols are
structural: the concrete store satisfies this without importing it, and `main.py` injects it
unchanged.
"""

from typing import Protocol

from domain.models import GraphConfig


class IPresetStore(Protocol):
    """Reads and persists named graph configs. Impl: infrastructure.PresetStore."""

    def get(self, key: str) -> GraphConfig | None: ...

    def save(self, key: str, graph: GraphConfig) -> None: ...
