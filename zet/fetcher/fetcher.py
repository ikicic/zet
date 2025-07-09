#!/usr/bin/env python3

from dataclasses import dataclass
from urllib.request import urlopen
import argparse
import csv
import datetime
import gzip
import io
import json
import logging
import os
import signal
import sqlite3
import time
import zipfile

from google.transit import gtfs_realtime_pb2
from google.protobuf.json_format import MessageToDict

from zet.utils.websocket_server import WebSocketServer

# TODO: Remove code duplication between realtime and static snapshot
# downloads. The problem is that downloading the static snapshot may take a
# couple of seconds. Ideally, we do not want to unnecessarily block
# downloading the realtime snapshot.

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_SNAPSHOT_COUNT = 10000

@dataclass
class SnapshotData:
    raw_data: bytes
    gzipped_data: bytes
    fetched_at: datetime.datetime


@dataclass
class RealtimeSnapshotData(SnapshotData):
    INVALID_TIMESTAMP = 0
    snapshot_at: int

    def is_valid(self) -> bool:
        return self.snapshot_at > self.INVALID_TIMESTAMP


@dataclass
class StaticSnapshotData(SnapshotData):
    INVALID_DATE = datetime.date(1970, 1, 1)
    calendar_date: datetime.date

    def is_valid(self) -> bool:
        return self.calendar_date > self.INVALID_DATE


def process_gtfs_realtime(
    raw_data: bytes,
    fetched_at: datetime.datetime,
) -> RealtimeSnapshotData:
    """Read the timestamp from the GTFS realtime data."""
    timestamp = RealtimeSnapshotData.INVALID_TIMESTAMP
    gzipped_data = gzip.compress(raw_data)
    try:
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(raw_data)
        feed_dict = MessageToDict(feed)
        timestamp = int(feed_dict['header']['timestamp'])
    except Exception as e:
        # Return as much data as possible.
        logger.error(f"Error parsing GTFS data: {e}")

    return RealtimeSnapshotData(
        raw_data=raw_data, gzipped_data=gzipped_data,
        snapshot_at=timestamp, fetched_at=fetched_at)


def process_gtfs_static(
    raw_data: bytes,
    fetched_at: datetime.datetime,
) -> StaticSnapshotData:
    """Read the calendar date (from calendar.txt) from the GTFS static data."""
    calendar_date = StaticSnapshotData.INVALID_DATE
    try:
        with zipfile.ZipFile(io.BytesIO(raw_data)) as zip_file:
            with zip_file.open('calendar.txt') as file:
                csv_lines = file.read().decode('utf-8').splitlines()
        for row in csv.DictReader(csv_lines):
            # Parse the YYYYMMDD date.
            date = datetime.date(
                int(row['start_date'][:4]),
                int(row['start_date'][4:6]),
                int(row['start_date'][6:8]),
            )
            if calendar_date == StaticSnapshotData.INVALID_DATE:
                calendar_date = date
            else:
                calendar_date = min(calendar_date, date)
    except Exception as e:
        logger.error(f"Error processing GTFS static data: {e}")

    gzipped_data = gzip.compress(raw_data)
    return StaticSnapshotData(
        raw_data=raw_data, gzipped_data=gzipped_data,
        calendar_date=calendar_date, fetched_at=fetched_at)


class WebSocketSnapshotServer(WebSocketServer):
    def update_realtime_snapshot(self, snapshot: RealtimeSnapshotData):
        data = json.dumps({
            "kind": "realtime",
            "fetched_at": snapshot.fetched_at.timestamp(),
            "gzipped_data": snapshot.gzipped_data.hex(),
        })
        super().update_data("realtime-snapshot", data, max_history=10)

    def update_static_snapshot(self, snapshot: StaticSnapshotData):
        data = json.dumps({
            "kind": "static",
            "fetched_at": snapshot.fetched_at.timestamp(),
            "gzipped_data": snapshot.gzipped_data.hex(),
        })
        super().update_data("static-snapshot", data, max_history=3)


def fetch_url(url: str) -> bytes | None:
    """Fetch the URL and return the binary content."""
    try:
        with urlopen(url) as response:
            return response.read()
    except Exception as e:
        logger.error(f"Error fetching URL: {e}")
        return None


class Fetcher:
    def __init__(
        self,
        realtime_url: str,
        static_url: str,
        realtime_dt: float,
        static_dt: float,
        db_dir: str,
        ws_port: int = 8765,
    ):
        self.realtime_url: str = realtime_url
        self.static_url: str = static_url
        self.realtime_dt: float = realtime_dt
        self.static_dt: float = static_dt
        self.dir: str = db_dir
        self.running: bool = True
        self.ws_port: int = ws_port
        self.new_snapshots_count: int = 0

        self.current_realtime_snapshot: RealtimeSnapshotData | None = None
        self.current_static_snapshot: StaticSnapshotData | None = None

        self._last_static_fetch: datetime.datetime | None = None

        # Set up signal handler for graceful shutdown
        signal.signal(signal.SIGINT, self.handle_sigint)

        # Create database
        self.db_conn, self.db_cursor, self.db_path = self.setup_database(db_dir)

        # First send the static data, then the realtime data.
        self.ws_server = WebSocketSnapshotServer(
            ws_port, kinds_order=["static-snapshot", "realtime-snapshot"])

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
        db_cursor.execute('''
            CREATE TABLE IF NOT EXISTS static_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fetched_at REAL,
                gzipped_data BLOB,
                calendar_date DATE
            )
        ''')
        db_conn.commit()
        return db_conn, db_cursor, db_path

    def store_realtime_snapshot(self, raw_data: bytes) -> bool:
        """Store a snapshot in the database and update the current snapshot.

        Returns True if the snapshot is new, False if it's the same as the
        previous snapshot.
        """
        fetched_at = datetime.datetime.now()

        same_snapshot = (self.current_realtime_snapshot is not None and
                        raw_data == self.current_realtime_snapshot.raw_data)

        if same_snapshot and self.current_realtime_snapshot is not None:
            data = self.current_realtime_snapshot
            gzipped_data = b''
        else:
            data = process_gtfs_realtime(raw_data, fetched_at)
            self.current_realtime_snapshot = data
            if data.is_valid():
                self.ws_server.update_realtime_snapshot(data)
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

    def store_static_snapshot(self, raw_data: bytes) -> bool:
        """Store a snapshot in the database and update the current snapshot.

        Returns True if the snapshot is new, False if it's the same as the
        previous snapshot.
        """
        fetched_at = datetime.datetime.now()

        same_snapshot = (self.current_static_snapshot is not None and
                        raw_data == self.current_static_snapshot.raw_data)

        if same_snapshot and self.current_static_snapshot is not None:
            data = self.current_static_snapshot
            gzipped_data = b''
        else:
            data = process_gtfs_static(raw_data, fetched_at)
            self.current_static_snapshot = data
            if data.is_valid():
                self.ws_server.update_static_snapshot(data)
            gzipped_data = data.gzipped_data

        self.db_cursor.execute(
            "INSERT INTO static_snapshots (fetched_at, gzipped_data, calendar_date) VALUES (?, ?, ?)",
            (fetched_at.timestamp(), gzipped_data, data.calendar_date)
        )
        self.db_conn.commit()

        fetched_at_str = fetched_at.isoformat(sep=' ', timespec='milliseconds')
        calendar_date_str = data.calendar_date.isoformat()
        if same_snapshot:
            logger.info(f"Fetched {calendar_date_str}+ static data at "
                        f"{fetched_at_str} (same as previous)")
        else:
            logger.info(f"Fetched {calendar_date_str}+ static data at "
                        f"{fetched_at_str} len={len(raw_data)} "
                        f"(gzipped={len(data.gzipped_data)})")
        return not same_snapshot

    def reopen_database(self):
        """Close the current database and open a new one."""
        logger.info(f"Reopening a new database after {MAX_SNAPSHOT_COUNT} rows.")
        self.db_conn.close()
        self.db_conn, self.db_cursor, self.db_path = self.setup_database(self.dir)
        self.new_snapshots_count = 0

    def handle_sigint(self, sig, frame):
        """Handle Ctrl-C."""
        logger.info("Shutting down the fetcher...")
        self.running = False

        if self.ws_server:
            self.ws_server.close()

    def run(self):
        """Main loop to fetch and store snapshots."""
        logger.info(f"Starting to fetch {self.realtime_url} and "
                    f"{self.static_url}. Press Ctrl-C to stop.")

        long_delay = max(1, self.realtime_dt - 1)
        short_delay = 1
        current_delay = short_delay

        while self.running:
            data = fetch_url(self.realtime_url)
            if data is not None:
                new_snapshot = self.store_realtime_snapshot(data)
                if new_snapshot:
                    current_delay = long_delay
                else:
                    current_delay = short_delay

                if self.maybe_fetch_static():
                    # Downloading the static data may take a few seconds,
                    # so we don't wait before reloading the realtime data.
                    current_delay = 0
            else:
                logger.error("No data fetched. Skipping snapshot.")
                # If fetching failed, use exponential backoff
                current_delay = min(current_delay * 2, 60)

            self.sleep(current_delay)

        if self.db_conn:
            self.db_conn.close()
            logger.info(f"Database connection closed: {self.db_path}")

    def maybe_fetch_static(self) -> bool:
        """Check if the static data is outdated and fetch it if needed.

        Returns True if the static data was fetched, False otherwise.
        """
        now = datetime.datetime.now()
        should_fetch = (self._last_static_fetch is None or
                        now - self._last_static_fetch >
                        datetime.timedelta(seconds=self.static_dt))
        if not should_fetch:
            return False

        self._last_static_fetch = now
        data = fetch_url(self.static_url)
        if data is not None:
            self.store_static_snapshot(data)
        return True

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
    realtime_url: str
    static_url: str
    realtime_dt: float
    static_dt: float
    dir: str
    ws_port: int


def create_parser():
    parser = argparse.ArgumentParser(
            description="Fetch a URL at regular intervals and store snapshots.",
            formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    add = parser.add_argument
    add("--realtime-url", type=str, default="https://www.zet.hr/gtfs-rt-protobuf",
        help="URL to fetch")
    add('--static-url', type=str,
        default="https://www.zet.hr/gtfs-scheduled/latest",
        help="URL to fetch static GTFS data")
    add("--realtime-dt", type=float, default=10,
        help="Time interval between realtime GTFS data fetches in seconds")
    add('--static-dt', type=float, default=3600,
        help="Time interval between static GTFS data fetches in seconds")
    add("--dir", type=str, default='.',
        help="Directory to store snapshots")
    add("--ws-port", type=int, default=8765,
        help="WebSocket server port")

    return parser


def main():
    parser = create_parser()
    args = parser.parse_args()
    args = CmdlineArgs(
        realtime_url=args.realtime_url, static_url=args.static_url,
        realtime_dt=args.realtime_dt, static_dt=args.static_dt,
        dir=args.dir, ws_port=args.ws_port)

    fetcher = Fetcher(args.realtime_url, args.static_url,
                      args.realtime_dt, args.static_dt,
                      args.dir, args.ws_port)
    fetcher.run()


if __name__ == "__main__":
    main()
