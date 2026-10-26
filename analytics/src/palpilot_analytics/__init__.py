"""Usage and cost analytics for palpilot. Layers: landing -> raw -> dbt -> marts."""

import os
from pathlib import Path

# Every layer lives under one directory (gitignored). The dbt profile reads the same variable.
DATA_DIR = Path(os.environ.get("ANALYTICS_DATA") or Path(__file__).resolve().parents[2] / "data")
