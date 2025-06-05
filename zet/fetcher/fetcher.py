#!/usr/bin/env python3

from dataclasses import dataclass
from urllib.request import urlopen
import argparse
import datetime
import gzip
import json
import logging
import os
import signal
import sqlite3
import time

from google.transit import gtfs_realtime_pb2
from google.protobuf.json_format import MessageToDict

from zet.utils.websocket_server import WebSocketServer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_SNAPSHOT_COUNT = 10000

@dataclass
class SnapshotData:
    raw_data: bytes
    gzipped_data: bytes
    snapshot_at: int
    fetched_at: datetime.datetime

    def is_valid(self) -> bool:
        return self.snapshot_at > 0


def process_gtfs(
    raw_data: bytes,
    fetched_at: datetime.datetime,
) -> SnapshotData:
    """Process the GTFS data and return a dictionary of tables."""
    timestamp = 0
    gzipped_data = gzip.compress(raw_data)
    try:
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(raw_data)
        feed_dict = MessageToDict(feed)
        timestamp = int(feed_dict['header']['timestamp'])
    except Exception as e:
        # Return as much data as possible.
        logger.error(f"Error parsing GTFS data: {e}")

    return SnapshotData(raw_data=raw_data, gzipped_data=gzipped_data,
                        snapshot_at=timestamp, fetched_at=fetched_at)


class WebSocketSnapshotServer(WebSocketServer):
    def update_snapshot(self, snapshot: SnapshotData):
        data = json.dumps({
            "fetched_at": snapshot.fetched_at.timestamp(),
            "gzipped_data": snapshot.gzipped_data.hex(),
        })
        super().update_data(data)


class Fetcher:
    def __init__(self, url: str, dt: float, db_dir: str, ws_port: int = 8765):
        self.url: str = url
        self.dt: float = dt
        self.dir: str = db_dir
        self.running: bool = True
        self.ws_port: int = ws_port
        self.current_snapshot: SnapshotData | None = None
        self.new_snapshots_count: int = 0

        # Set up signal handler for graceful shutdown
        signal.signal(signal.SIGINT, self.handle_sigint)

        # Create database
        self.db_conn, self.db_cursor = self.setup_database(db_dir)

        self.ws_server = WebSocketSnapshotServer(ws_port)

    @staticmethod
    def setup_database(db_dir: str):
        """Create a new SQLite database with a snapshots table."""
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        db_path = os.path.join(db_dir, f"snapshots_{timestamp}.sqlite3")
        logger.info(f"Creating database: {db_path}")

        db_conn = sqlite3.connect(db_path)
        db_cursor = db_conn.cursor()

        # Create snapshots table
        db_cursor.execute('''
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fetched_at REAL,
                snapshot_at REAL,  -- Only the int part is known.
                gzipped_data BLOB
            )
        ''')
        db_conn.commit()
        return db_conn, db_cursor

    def fetch_url(self):
        """Fetch the URL and return the binary content."""
        try:
            with urlopen(self.url) as response:
                return response.read()
        except Exception as e:
            logger.error(f"Error fetching URL: {e}")
            return None

    def store_snapshot(self, raw_data: bytes) -> bool:
        """Store a snapshot in the database and update the current snapshot.

        Returns True if the snapshot is new, False if it's the same as the
        previous snapshot.
        """
        fetched_at = datetime.datetime.now()

        same_snapshot = (self.current_snapshot is not None and
                        raw_data == self.current_snapshot.raw_data)

        if same_snapshot and self.current_snapshot is not None:
            data = self.current_snapshot
            gzipped_data = b''
        else:
            data = process_gtfs(raw_data, fetched_at)
            self.current_snapshot = data
            if data.is_valid():
                self.ws_server.update_snapshot(data)
            gzipped_data = data.gzipped_data

        self.db_cursor.execute(
            "INSERT INTO snapshots (fetched_at, snapshot_at, gzipped_data) VALUES (?, ?, ?)",
            (fetched_at.timestamp(), data.snapshot_at, gzipped_data)
        )
        self.db_conn.commit()
        if not same_snapshot:
            self.new_snapshots_count += 1
            if self.new_snapshots_count >= MAX_SNAPSHOT_COUNT:
                self.reopen_database()

        fetched_at_str = fetched_at.isoformat(sep=' ', timespec='milliseconds')
        snapshot_at_str = datetime.datetime.fromtimestamp(data.snapshot_at) \
            .isoformat(sep=' ')
        if same_snapshot:
            logger.info(f"Fetched {snapshot_at_str} at {fetched_at_str} "
                        f"(same as previous)")
        else:
            logger.info(f"Fetched {snapshot_at_str} at {fetched_at_str} "
                        f"len={len(raw_data)} "
                        f"(gzipped={len(data.gzipped_data)})")

        return not same_snapshot

    def reopen_database(self):
        """Close the current database and open a new one."""
        logger.info(f"Reopening a new database after {MAX_SNAPSHOT_COUNT} rows.")
        self.db_conn.close()
        self.db_conn, self.db_cursor = self.setup_database(self.dir)
        self.new_snapshots_count = 0

    def handle_sigint(self, sig, frame):
        """Handle Ctrl-C."""
        logger.info("Shutting down the fetcher...")
        self.running = False

        if self.ws_server:
            self.ws_server.close()

    def run(self):
        """Main loop to fetch and store snapshots."""
        logger.info(f"Starting to fetch {self.url} with adaptive timing. "
                    f"Press Ctrl-C to stop.")

        long_delay = max(1, self.dt - 1)
        short_delay = 1
        current_delay = short_delay

        while self.running:
            data = self.fetch_url()
            if data is not None:
                new_snapshot = self.store_snapshot(data)
                if new_snapshot:
                    current_delay = long_delay
                else:
                    current_delay = short_delay
            else:
                logger.error("No data fetched. Skipping snapshot.")
                # If fetching failed, use exponential backoff
                current_delay = min(current_delay * 2, 60)

            self.sleep(current_delay)

        if self.db_conn:
            self.db_conn.close()
            logger.info("Database connection closed.")

    def sleep(self, delay: float):
        """Sleep for the given delay, but check self.running periodically."""
        for _ in range(int(delay)):
            if not self.running:
                break
            time.sleep(1)

        if self.running and delay % 1 > 0:
            time.sleep(delay % 1)


@dataclass
class CmdlineArgs:
    url: str
    dt: float
    dir: str
    ws_port: int


def create_parser():
    parser = argparse.ArgumentParser(
            description="Fetch a URL at regular intervals and store snapshots.",
            formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    add = parser.add_argument
    add("--url", type=str, default="https://www.zet.hr/gtfs-rt-protobuf",
        help="URL to fetch")
    add("--dt", type=float, default=10,
        help="Time interval between fetches in seconds")
    add("--dir", type=str, default='.',
        help="Directory to store snapshots")
    add("--ws-port", type=int, default=8765,
        help="WebSocket server port")

    return parser


def main():
    parser = create_parser()
    args = parser.parse_args()
    args = CmdlineArgs(
        url=args.url, dt=args.dt, dir=args.dir, ws_port=args.ws_port)

    fetcher = Fetcher(args.url, args.dt, args.dir, args.ws_port)
    fetcher.run()


if __name__ == "__main__":
    main()
