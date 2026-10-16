"""Eden Cloud's tests: the service, its backends and the runner, with fakes (no Docker, no
cloud, no model). Run: PYTHONPATH=cloud <venv python> -m pytest -q cloud/tests"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
for path in (HERE, HERE / "runner"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
