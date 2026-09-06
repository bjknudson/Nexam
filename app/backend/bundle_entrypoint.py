"""Entrypoint for the PyInstaller-frozen backend binary.

Run:
    nexam-backend --port 8000
"""

from __future__ import annotations

import argparse
import multiprocessing

import uvicorn

from app.backend.main import app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        loop="asyncio",
        http="h11",
        ws="none",
        log_level="info",
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
