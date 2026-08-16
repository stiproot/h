"""The fabric URL default is stated twice — hold the two in step.

The CLI's `EVENTS_URL` is authoritative and is stamped into the runner's environment on every
spawn, so in practice the runner never falls back. But it HAS a fallback (a bare `node
dist/bin.js` driven by hand, or a future caller that forgets), and a fallback pointing somewhere
else would send registry reads to a server nobody is running — which reads as an EMPTY registry,
not as an error.

The sibling of test_local_protocol_sync and test_local_agents_sync: the same "two languages, one
constant" problem, pinned the same way.
"""

import re
from pathlib import Path

from h_cli.config import EVENTS_URL

BIN_TS = Path(__file__).resolve().parents[3] / "packages/js/local-runtime/src/bin.ts"


def test_runner_fallback_matches_the_cli_default() -> None:
    source = BIN_TS.read_text()
    match = re.search(r'process\.env\.NATS_URL \?\? "([^"]+)"', source)
    assert match, "bin.ts no longer reads NATS_URL with a literal fallback — update this test"
    assert match.group(1) == EVENTS_URL, (
        f"bin.ts falls back to {match.group(1)!r} but the CLI default is {EVENTS_URL!r}; "
        "a runner pointed at a different server finds an empty registry rather than an error"
    )
