"""python -m eden_cloud: the API on EDEN_CLOUD_HOST:EDEN_CLOUD_PORT (127.0.0.1:8790), with the
settings the environment gives (config.py). Behind a TLS proxy in any real deployment."""

from __future__ import annotations

import logging
import os

import uvicorn

from .app import build
from .config import Settings


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    app = build(Settings.from_env())
    uvicorn.run(
        app,
        host=os.environ.get("EDEN_CLOUD_HOST", "127.0.0.1"),
        port=int(os.environ.get("EDEN_CLOUD_PORT", "8790")),
        proxy_headers=True,
        access_log=False,  # (paths only, but nothing about runs is logged by default)
    )


if __name__ == "__main__":
    main()
