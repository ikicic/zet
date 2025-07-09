from dataclasses import dataclass
from typing import Optional
import argparse
import asyncio
import datetime
import gzip
import json
import logging
import math
import threading
import time

from flask import Flask
from flask_sock import Sock
from google.protobuf.json_format import MessageToDict
from google.transit import gtfs_realtime_pb2
import simple_websocket
import websockets

import zet.math.latlon as latlon

MAX_TRAJECTORY_LENGTH = 30
TRAJECTORY_OUTPUT_LENGTH = 6
DIRECTION_THRESHOLD_METERS = 20

app = Flask(__name__, static_folder='../static')
sock = Sock(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class StaticReferenceSystem:
    coord_num_digits: int
    ref_lat: float
    ref_lon: float


@dataclass
class ReferenceSystem:
    static: StaticReferenceSystem
    ref_timestamp: int


STATIC_REFERENCE_SYSTEM = StaticReferenceSystem(
    coord_num_digits=6,
    ref_lat=45.815,
    ref_lon=15.9819,
)

@dataclass
class ParsedVehicle:
    route_id: int
    trip_id: str
    timestamp: int
    lat: float
    lon: float


@dataclass
class ParsedFeed:
    vehicles: list[ParsedVehicle]
    timestamp: int

    @staticmethod
    def from_raw_feed(
        raw_feed: gtfs_realtime_pb2.FeedMessage,
    ) -> Optional['ParsedFeed']:
        feed = MessageToDict(raw_feed)
        if not isinstance(feed, dict):
            return None

        vehicles: list[ParsedVehicle]  = []
        for entity in feed.get('entity', []):
            if 'vehicle' in entity:
                vehicle = ParsedFeed._parse_vehicle(entity['vehicle'])
                if vehicle is not None:
                    vehicles.append(vehicle)

        timestamp = int(feed['header']['timestamp'])
        return ParsedFeed(vehicles=vehicles, timestamp=timestamp)

    @staticmethod
    def _parse_vehicle(vehicle: dict) -> ParsedVehicle | None:
        try:
            return ParsedVehicle(
                route_id=int(vehicle['trip']['routeId']),
                trip_id=vehicle['trip']['tripId'],
                timestamp=int(vehicle['timestamp']),
                lat=vehicle['position']['latitude'],
                lon=vehicle['position']['longitude'],
            )
        except (KeyError, ValueError) as e:
            logger.error(f"Error parsing vehicle: {e}")
            return None


@dataclass
class Vehicle:
    route_id: int
    timestamp: int
    lat: list[float]  # lat[0] is the newest position
    lon: list[float]  # lon[0] is the newest position
    direction_radians: float | None = None

    # How many times did the feed not contain the vehicle.
    no_update_counter: int = 0

    @staticmethod
    def from_parsed_vehicle(vehicle: ParsedVehicle) -> 'Vehicle':
        """Create a vehicle from a parsed vehicle.

        The update() method must be called to add the first position."""
        return Vehicle(
            route_id=vehicle.route_id,
            timestamp=vehicle.timestamp,
            lat=[],
            lon=[])

    def update(self, vehicle: ParsedVehicle):
        self.lat.insert(0, vehicle.lat)
        self.lon.insert(0, vehicle.lon)
        if len(self.lat) > MAX_TRAJECTORY_LENGTH:
            self.lat.pop()  # Remove the oldest position.
            self.lon.pop()
        self.timestamp = vehicle.timestamp
        self.no_update_counter = 0
        self.direction_radians = self.compute_direction(self.lat, self.lon)

    @staticmethod
    def compute_direction(lat: list[float], lon: list[float]) -> float | None:
        if len(lat) < 2:
            return None
        # Find the first sufficiently distant point relative to the current
        # position (lat[0], lon[0]) and compute the angle of that vector.
        for i in range(1, len(lat)):
            dist = latlon.haversine_distance_meters(
                lat[0], lon[0], lat[i], lon[i])
            if dist > DIRECTION_THRESHOLD_METERS:
                angle = latlon.arrow_angle(lat[i], lon[i], lat[0], lon[0])
                return angle
        return None

    def to_json_v0(self):
        # Note: in v0, trajectories were stored in the reverse order.
        if self.direction_radians is not None:
            deg = round(self.direction_radians * 180 / math.pi)
        else:
            deg = None
        return {
            'routeId': self.route_id,
            'timestamp': self.timestamp,
            'lat': self.lat[:TRAJECTORY_OUTPUT_LENGTH][::-1],
            'lon': self.lon[:TRAJECTORY_OUTPUT_LENGTH][::-1],
            'directionDegrees': deg,
        }

    @staticmethod
    def to_compressed_json(
        vehicles: list['Vehicle'],
        ref: ReferenceSystem
    ) -> dict:
        """Return a list of vehicles in a structure-of-arrays JSON format with
        compressed values."""

        factor = 10 ** ref.static.coord_num_digits
        def compress_coord(ref_value: float, values: list[float]) -> list[int]:
            out = []
            for v in values[:TRAJECTORY_OUTPUT_LENGTH]:
                out.append(int((v - ref_value) * factor + 0.5))
                ref_value = v
            return out

        static = ref.static
        return {
            'routeIds': [v.route_id for v in vehicles],
            'timestamps': [ref.ref_timestamp - v.timestamp for v in vehicles],
            'lats': [compress_coord(static.ref_lat, v.lat) for v in vehicles],
            'lons': [compress_coord(static.ref_lon, v.lon) for v in vehicles],
        }


@dataclass
class State:
    vehicles: dict[str, Vehicle]
    timestamp: int

    def update(self, feed: ParsedFeed):
        for vehicle in self.vehicles.values():
            vehicle.no_update_counter += 1

        for vehicle in feed.vehicles:
            v = self.vehicles.get(vehicle.trip_id)
            if v is None:
                v = Vehicle.from_parsed_vehicle(vehicle)
                self.vehicles[vehicle.trip_id] = v
            v.update(vehicle)

        # Remove vehicles not in last 30 feeds.
        self.vehicles = {
            k: v for k, v in self.vehicles.items()
            if v.no_update_counter < 30
        }

        self.timestamp = feed.timestamp

    def to_json_v0(self):
        # v0 contains only the vehicles.
        return [v.to_json_v0() for v in self.vehicles.values()
                if v.no_update_counter == 0]

    def to_json_v1(self):
        ref = ReferenceSystem(
            static=STATIC_REFERENCE_SYSTEM,
            ref_timestamp=self.timestamp,
        )
        vehicles = [v for v in self.vehicles.values()
                    if v.no_update_counter == 0]
        return {
            'vehicles': Vehicle.to_compressed_json(vehicles, ref),
            'timestamp': self.timestamp,
        }


@dataclass
class WsClient:
    ws: simple_websocket.ws.Server
    version: int

    def __hash__(self):
        return id(self)


@dataclass
class WsOutputMessageVariants:
    version0: str
    version1: str

    @staticmethod
    def from_state(state: State) -> 'WsOutputMessageVariants':
        return WsOutputMessageVariants(
            version0=compact_json(state.to_json_v0()),
            version1=compact_json(state.to_json_v1()),
        )

    def for_version(self, version: int) -> str:
        match version:
            case 0:
                return self.version0
            case 1:
                return self.version1
            case _:
                return self.version1


def compact_json(json_data: dict | list) -> str:
    """Compact JSON data by removing whitespace."""
    return json.dumps(json_data, separators=(',', ':'))


class GtfsServer:
    def __init__(self, fetcher_url: str):
        self.update_lock = threading.Lock()
        self.state = State(vehicles={}, timestamp=0)
        self.fetcher_url = fetcher_url

        # Note: in principle, we could use websocket_server, but it is not
        # compatible with flask. In the future, we may get rid of flask
        # altogether.
        self.ws_clients: set[WsClient] = set()
        self.ws_clients_lock = threading.Lock()
        self.latest_message: WsOutputMessageVariants | None = None

        self._send_time = 0

    def clear_vehicles(self):
        self.state = State(vehicles={}, timestamp=0)

    def process_feed(
        self,
        raw_feed: gtfs_realtime_pb2.FeedMessage
    ) -> tuple[ParsedFeed, WsOutputMessageVariants] | tuple[None, None]:
        try:
            feed = ParsedFeed.from_raw_feed(raw_feed)
        except Exception as e:
            logger.error(f"Error parsing feed: {e}")
            return None, None
        if feed is None:
            return None, None

        with self.update_lock:
            self.state.update(feed)
            message = WsOutputMessageVariants.from_state(self.state)
            self.latest_message = message
        return feed, message


    def update_feed_from_file(self, source):
        raw_feed = gtfs_realtime_pb2.FeedMessage()
        with open(source, "rb") as f:
            raw_feed.ParseFromString(f.read())
        self.process_feed(raw_feed)

    async def fetch_data_from_fetcher(self):
        def process_message(fetcher_message):
            data = json.loads(fetcher_message)
            kind = data.get('kind')
            if kind == 'static':
                logger.warning(f"Ignoring static data. Not yet implemented.")
                return
            if kind != 'realtime':
                logger.error(f"Unknown kind: {kind}")
                return

            raw_data = bytes.fromhex(data['gzipped_data'])
            raw_feed = gtfs_realtime_pb2.FeedMessage()
            raw_feed.ParseFromString(gzip.decompress(raw_data))
            feed, message = self.process_feed(raw_feed)
            if feed is None or message is None:
                return
            date = datetime.datetime.now()
            with self.ws_clients_lock:
                num_clients = len(self.ws_clients)
                send_time = self._send_time
            print(f"{date} New vehicles: {len(feed.vehicles)}  "
                f"Num clients: {num_clients}  "
                f"Send time: {send_time:.3f}s  "
                f"Message size: v0={len(message.version0)} "
                f"v1={len(message.version1)}")
            # Send updates to all connected clients
            self._notify_clients(message)

        backoff_time = 1       # Restart at first with a 1-second delay.
        max_backoff_time = 60  # Maximum delay of 60 seconds.
        while True:
            try:
                async with websockets.connect(
                        self.fetcher_url, max_size=50*1024*1024) as websocket:
                    # Reset backoff time on successful connection
                    backoff_time = 1
                    while True:
                        message = await websocket.recv()
                        process_message(message)
            except Exception as e:
                logger.error(f"Connection error: {e}. "
                             f"Reconnecting in {backoff_time} seconds...")
                await asyncio.sleep(backoff_time)
                # Exponential backoff
                backoff_time = min(max_backoff_time, backoff_time * 2)

    def update_feed_continuously(self):
        asyncio.run(self.fetch_data_from_fetcher())

    def _notify_clients(self, message: WsOutputMessageVariants):
        dead_clients = set()
        with self.ws_clients_lock:
            clients = list(self.ws_clients)
        start_time = time.time()
        for client in clients:
            try:
                client.ws.send(message.for_version(client.version))
            except Exception:
                dead_clients.add(client)
        with self.ws_clients_lock:
            self.ws_clients -= dead_clients
            self._send_time = time.time() - start_time

gtfs_server: GtfsServer | None = None


def handle_websocket(ws: simple_websocket.ws.Server, version: int):
    if gtfs_server is None:
        raise Exception("gtfs_server is not initialized")
    client = WsClient(ws=ws, version=version)
    with gtfs_server.ws_clients_lock:
        gtfs_server.ws_clients.add(client)
    logger.info("Client connected. Number of clients: %d",
                len(gtfs_server.ws_clients))
    try:
        if gtfs_server.latest_message:
            client.ws.send(gtfs_server.latest_message.for_version(version))
        while True:
            # Keep connection alive and wait for any client messages
            message = ws.receive()
            # Handle client messages here if needed
    except Exception:
        pass
    finally:
        with gtfs_server.ws_clients_lock:
            gtfs_server.ws_clients.remove(client)


@sock.route('/ws')
def websocket(ws: simple_websocket.ws.Server):
    handle_websocket(ws, version=0)


@sock.route('/ws-v1')
def websocket_v1(ws: simple_websocket.ws.Server):
    handle_websocket(ws, version=1)


def create_parser():
    parser = argparse.ArgumentParser(
        description='GTFS Realtime Coordinate Server')
    add = parser.add_argument
    add('--file', help='Path to the GTFS protobuf file')
    add('--url', help='URL to fetch the GTFS protobuf file',
        default='https://www.zet.hr/gtfs-rt-protobuf')
    add('--fetcher-url', type=str, default='ws://localhost:8765',
        help='URL of the fetcher server (default: ws://localhost:8765)')
    add('--port', type=int, default=5000,
        help='Port to run the server on (default: 5000)')
    add('--host', default='localhost',
        help='Host to run the server on (default: localhost)')
    return parser


def main():
    parser = create_parser()
    args = parser.parse_args()

    global gtfs_server
    gtfs_server = GtfsServer(fetcher_url=args.fetcher_url)

    # If using URL, start background thread for updates
    if args.url:
        update_thread = threading.Thread(
            target=gtfs_server.update_feed_continuously, daemon=True)
        update_thread.start()
    else:
        gtfs_server.update_feed_from_file(args.file)

    app.run(port=args.port, host=args.host)


if __name__ == '__main__':
    main()
