#!/usr/bin/env python3
"""Replay fetcher data from an SQLite database.

Replaces fetcher.py for offline/debug use. Reads snapshots from a database
created by fetcher.py and serves them over WebSocket, just like the real
fetcher does.
"""

import argparse
from dataclasses import dataclass
import json
import logging
import sqlite3
import time

from zet.utils.websocket_server import WebSocketServer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class CmdlineArgs:
    db: str
    ws_port: int
    dt: float
    loop: bool
    start: int


def load_snapshots(db_path: str):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    static_rows = cursor.execute(
        "SELECT fetched_at, gzipped_data FROM static_snapshots "
        "WHERE length(gzipped_data) > 0 ORDER BY id"
    ).fetchall()

    realtime_rows = cursor.execute(
        "SELECT fetched_at, gzipped_data FROM snapshots "
        "WHERE length(gzipped_data) > 0 ORDER BY id"
    ).fetchall()
    conn.close()

    return static_rows, realtime_rows


def replay(args: CmdlineArgs):
    static_rows, realtime_rows = load_snapshots(args.db)

    logger.info(f"Loaded {len(static_rows)} static and "
                f"{len(realtime_rows)} realtime snapshots from {args.db}")

    if not realtime_rows:
        logger.error("No realtime snapshots found in database.")
        return

    if args.start < 0 or args.start >= len(realtime_rows):
        logger.error(f"--start must be between 0 and "
                     f"{len(realtime_rows) - 1}, got {args.start}")
        return

    ws_server = WebSocketServer(
        args.ws_port, kinds_order=["static-snapshot", "realtime-snapshot"])

    # Send static snapshots immediately.
    for fetched_at, gzipped_data in static_rows:
        data = json.dumps({
            "kind": "static",
            "fetched_at": fetched_at,
            "gzipped_data": gzipped_data.hex(),
        })
        ws_server.update_data("static-snapshot", data, max_history=3)
        logger.info(f"Sent static snapshot (fetched_at={fetched_at})")

    # Replay realtime snapshots.
    idx = args.start
    while True:
        fetched_at, gzipped_data = realtime_rows[idx]
        data = json.dumps({
            "kind": "realtime",
            "fetched_at": fetched_at,
            "gzipped_data": gzipped_data.hex(),
        })
        ws_server.update_data("realtime-snapshot", data, max_history=10)
        logger.info(f"Sent realtime snapshot {idx + 1}/{len(realtime_rows)} "
                    f"(fetched_at={fetched_at})")

        idx += 1
        if idx >= len(realtime_rows):
            if args.loop:
                idx = args.start
                logger.info(f"Looping back to snapshot {args.start}.")
            else:
                logger.info("All snapshots sent. Waiting indefinitely "
                            "(Ctrl-C to stop).")
                while True:
                    time.sleep(60)

        time.sleep(args.dt)


def main():
    parser = argparse.ArgumentParser(
        description="Replay GTFS data from an SQLite database.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    add = parser.add_argument
    add("db", help="Path to the SQLite database file")
    add("--ws-port", type=int, default=8765,
        help="WebSocket server port")
    add("--dt", type=float, default=10,
        help="Delay between replayed snapshots in seconds")
    add("--loop", action="store_true",
        help="Loop back to the beginning after the last snapshot")
    add("--start", type=int, default=0,
        help="Index of the first realtime snapshot to replay (0-based)")
    replay(CmdlineArgs(**vars(parser.parse_args())))


if __name__ == "__main__":
    main()
