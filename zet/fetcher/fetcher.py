#!/usr/bin/env python3

from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import HTTPRedirectHandler, Request, build_opener
import argparse
import csv
import datetime
import gzip
import io
import json
import logging
import os
import re
import signal
import sqlite3
import time
import zipfile

from google.transit import gtfs_realtime_pb2
from google.protobuf.json_format import MessageToDict

from zet.utils.pushover import RateLimitedNotifier
from zet.utils.websocket_server import WebSocketServer

# TODO: Remove code duplication between realtime and static snapshot
# downloads. The problem is that downloading the static snapshot may take a
# couple of seconds. Ideally, we do not want to unnecessarily block
# downloading the realtime snapshot.

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_SNAPSHOT_COUNT = 10000
MIN_UNCHANGED_DELAY = 1.5
MAX_UNCHANGED_DELAY = 10.0
UNCHANGED_BACKOFF_FACTOR = 1.01
MAX_RETRY_AFTER_DELAY = 30.0


def retry_after_delay(value: str | None) -> float | None:
    """Parse Retry-After and clamp it between MIN_UNCHANGED_DELAY and
    MAX_RETRY_AFTER_DELAY."""
    if value is None:
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():
        retry_after = int(value)
    else:
        try:
            retry_at = parsedate_to_datetime(value)
            retry_after = retry_at.timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            return None
    # Leave a one-second margin around the retry deadline. This controls request
    # eligibility; it does not guarantee that a new snapshot has been published.
    return max(MIN_UNCHANGED_DELAY,
               min(retry_after + 1, MAX_RETRY_AFTER_DELAY))

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


@dataclass(frozen=True)
class CachedHttpResponse:
    response_url: str
    etag: str
    data: bytes


class _ConditionalRedirectHandler(HTTPRedirectHandler):
    def __init__(self, cached: CachedHttpResponse | None):
        self.cached = cached

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if (redirected is not None and self.cached is not None
                and redirected.full_url == self.cached.response_url):
            redirected.add_unredirected_header('If-None-Match', self.cached.etag)
        return redirected


def _open_url(request: Request, cached: CachedHttpResponse | None):
    return build_opener(_ConditionalRedirectHandler(cached)).open(request, timeout=30)


def fetch_url(url: str, *, cache: dict[str, CachedHttpResponse] | None = None) -> bytes:
    """Keep one response per configured URL; scope its validator to the final URL."""
    cached = cache.get(url) if cache is not None else None
    request = Request(url)
    if cached is not None and url == cached.response_url:
        # Validators belong to a resource, not to other URLs it redirects to.
        request.add_unredirected_header('If-None-Match', cached.etag)
    try:
        response = _open_url(request, cached)
    except HTTPError as error:
        with error:
            response_url = error.geturl()
            if (error.code != 304 or cached is None
                    or response_url != cached.response_url):
                raise
            # A 304 has no payload. Reuse the exact previous bytes so snapshot
            # storage and polling treat this as an ordinary unchanged response.
            if cache is not None:
                cache[url] = CachedHttpResponse(
                    response_url, error.headers.get('ETag', cached.etag), cached.data)
            return cached.data
    with response:
        data = response.read()
        if cache is not None:
            etag = response.headers.get('ETag')
            if etag:
                cache[url] = CachedHttpResponse(response.geturl(), etag, data)
            else:
                # A new response without a validator supersedes the old ETag.
                cache.pop(url, None)
        return data


def try_fetch_url(url: str, *, cache: dict[str, CachedHttpResponse] | None = None) -> bytes | None:
    """Fetch the URL and return the binary content."""
    requested_at = datetime.datetime.now().astimezone().isoformat(timespec='milliseconds')
    try:
        return fetch_url(url, cache=cache)
    except Exception as e:
        logger.error(f"{requested_at}: Error fetching URL {url}: {e}")
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
        old_static_data: list[bytes] = [],
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
        self._http_cache: dict[str, CachedHttpResponse] = {}
        self.notifier = RateLimitedNotifier()

        self._last_static_fetch: datetime.datetime | None = None

        # Set up signal handler for graceful shutdown
        signal.signal(signal.SIGINT, self.handle_sigint)

        # Create database
        self.db_conn, self.db_cursor, self.db_path = self.setup_database(db_dir)

        # First send the static data, then the realtime data.
        self.ws_server = WebSocketSnapshotServer(
            ws_port, kinds_order=["static-snapshot", "realtime-snapshot"])

        for static_data in old_static_data:
            self.store_static_snapshot(static_data)

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

        try:
            self.db_cursor.execute(
                "INSERT INTO snapshots (fetched_at, snapshot_at, gzipped_data) VALUES (?, ?, ?)",
                (fetched_at.timestamp(), data.snapshot_at, gzipped_data)
            )
            self.db_conn.commit()
        except sqlite3.Error as e:
            logger.error(f"Failed to INSERT realtime snapshot: {e}")
            self.notifier.try_send(
                "Fetcher DB Error",
                f"Failed to INSERT realtime snapshot: {e}")
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

        try:
            self.db_cursor.execute(
                "INSERT INTO static_snapshots (fetched_at, gzipped_data, calendar_date) VALUES (?, ?, ?)",
                (fetched_at.timestamp(), gzipped_data, data.calendar_date)
            )
            self.db_conn.commit()
        except sqlite3.Error as e:
            logger.error(f"Failed to INSERT static snapshot: {e}")
            self.notifier.try_send(
                "Fetcher DB Error",
                f"Failed to INSERT static snapshot: {e}")

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
        self.close_database()
        self.db_conn, self.db_cursor, self.db_path = self.setup_database(self.dir)
        self.new_snapshots_count = 0

    def close_database(self):
        if self.db_conn:
            self.db_conn.close()
            self.db_conn = None
            logger.info(f"Database connection closed: {self.db_path}")

    def close(self):
        """Close resources owned by the fetcher."""
        self.close_database()
        if self.ws_server:
            self.ws_server.close()

    def handle_sigint(self, sig, frame):
        """Handle Ctrl-C."""
        logger.info("Shutting down the fetcher...")
        self.running = False

    def run(self):
        """Main loop to fetch and store snapshots."""
        logger.info(f"Starting to fetch {self.realtime_url} and "
                    f"{self.static_url}. Press Ctrl-C to stop.")

        long_delay = max(1, self.realtime_dt - 1)
        unchanged_delay = MIN_UNCHANGED_DELAY
        current_delay = unchanged_delay

        try:
            while self.running:
                retry_delay = None
                requested_at = datetime.datetime.now().astimezone().isoformat(
                    timespec='milliseconds')
                try:
                    data = fetch_url(self.realtime_url, cache=self._http_cache)
                except HTTPError as e:
                    retry_delay = retry_after_delay(e.headers.get('Retry-After'))
                    logger.error(f"{requested_at}: Error fetching GTFS: {e}")
                    e.close()
                    data = None
                except Exception as e:
                    logger.error(f"{requested_at}: Error fetching GTFS: {e}")
                    data = None
                if not self.running:
                    break

                if data is not None:
                    new_snapshot = self.store_realtime_snapshot(data)
                    if new_snapshot:
                        current_delay = long_delay
                        unchanged_delay = MIN_UNCHANGED_DELAY
                    else:
                        current_delay = unchanged_delay
                        unchanged_delay = min(
                            unchanged_delay * UNCHANGED_BACKOFF_FACTOR,
                            MAX_UNCHANGED_DELAY)

                    if not self.running:
                        break

                    if self.maybe_fetch_static():
                        # Downloading the static data may take a few seconds,
                        # so we don't wait before reloading the realtime data.
                        current_delay = 0
                else:
                    if retry_delay is not None:
                        current_delay = retry_delay
                        logger.info(f"Retry-After: waiting {current_delay}s")
                    else:
                        # Without a valid Retry-After, use exponential backoff.
                        current_delay = max(
                            MIN_UNCHANGED_DELAY, min(current_delay * 2, 20))
                        logger.error("No data fetched. Skipping snapshot.")

                self.sleep(current_delay)
        finally:
            self.close()

    def maybe_fetch_static(self) -> bool:
        """Check if the static data is outdated and fetch it if needed.

        Returns True if the static data was fetched, False otherwise.
        """
        if not self.running:
            return False

        now = datetime.datetime.now()
        should_fetch = (self._last_static_fetch is None or
                        now - self._last_static_fetch >
                        datetime.timedelta(seconds=self.static_dt))
        if not should_fetch:
            return False

        self._last_static_fetch = now
        data = try_fetch_url(self.static_url, cache=self._http_cache)
        if self.running and data is not None:
            self.store_static_snapshot(data)
            return True
        return False

    def sleep(self, delay: float):
        """Sleep for the given delay, but check self.running periodically."""
        for _ in range(int(delay)):
            if not self.running:
                break
            time.sleep(1)

        if self.running and delay % 1 > 0:
            time.sleep(delay % 1)


def fetch_old_static_data(list_url: str, regex: str, count: int):
    """Since the latest static data may represent future dates, we must also
    download the previous ones to capture the static data for the current
    date."""
    if not list_url or not regex or not count:
        return []

    regex_re = re.compile(regex.encode('ascii'))
    logger.info(f"Fetching the list of static data from {list_url}")
    data = fetch_url(list_url)
    matches = regex_re.findall(data)
    if not matches:
        raise ValueError(f"No matches found for: {regex}")

    urls = sorted([match.decode('ascii') for match in matches])
    snapshots = []
    for url in urls[-count:]:
        url = urljoin(list_url, url)
        logger.info(f"Fetching {url}")
        snapshots.append(fetch_url(url))
    return snapshots


@dataclass
class CmdlineArgs:
    realtime_url: str
    latest_static_url: str
    old_static_list_url: str
    old_static_url_regex: str
    old_static_count: int
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
    add('--latest-static-url', type=str,
        default="https://www.zet.hr/gtfs-scheduled/latest",
        help="URL to fetch latest static GTFS data")
    add('--old-static-list-url', type=str,
        default="https://www.zet.hr/gtfs2",
        help="URL to that contains the list of static GTFS data URLs")
    add('--old-static-url-regex', type=str,
        default=r'href="(/gtfs-scheduled/scheduled-000-[0-9]+\.zip)"',
        help="Regex to extract the static GTFS data URL from the static-list-url")
    add('--old-static-count', type=int, default=2,
        help="Number of static URLs to download")
    add('--realtime-dt', type=float, default=10,
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
        realtime_url=args.realtime_url,
        latest_static_url=args.latest_static_url,
        old_static_list_url=args.old_static_list_url,
        old_static_url_regex=args.old_static_url_regex,
        old_static_count=args.old_static_count,
        realtime_dt=args.realtime_dt,
        static_dt=args.static_dt,
        dir=args.dir,
        ws_port=args.ws_port)

    old_static_data = fetch_old_static_data(
            args.old_static_list_url,
            args.old_static_url_regex,
            args.old_static_count)

    fetcher = Fetcher(args.realtime_url, args.latest_static_url,
                      args.realtime_dt, args.static_dt,
                      args.dir, args.ws_port,
                      old_static_data=old_static_data)
    fetcher.run()


if __name__ == "__main__":
    main()
