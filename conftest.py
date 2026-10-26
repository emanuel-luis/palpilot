"""Root pytest hooks."""

from pathlib import Path

import pytest

_ROOT = Path(__file__).parent
_NEEDS_CONSOLE = "test_static_routes.py"


def pytest_runtest_setup(item):
    # The route tests serve the built console, which is not committed.
    if item.path.name == _NEEDS_CONSOLE and not (_ROOT / "coordinator" / "index.html").is_file():
        pytest.fail(
            "coordinator/index.html is missing: the built console is not committed. "
            "Build it first with `make build` (or `cd frontend && npm ci && npm run build`), "
            "or run `make test`, which builds it when absent.",
            pytrace=False,
        )
