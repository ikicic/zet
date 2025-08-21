from dataclasses import dataclass
from typing import Optional, Union
import argparse
import asyncio
import csv
import datetime
import gzip
import io
import json
import logging
import math
import os
import threading
import time
import zipfile

from flask import Flask
from flask_cors import CORS
from flask_sock import Sock
from google.protobuf.json_format import MessageToDict
from google.transit import gtfs_realtime_pb2
import simple_websocket
import websockets

import zet.math.latlon as latlon

MAX_TRAJECTORY_LENGTH = 30
TRAJECTORY_OUTPUT_LENGTH = 6
DIRECTION_THRESHOLD_METERS = 20

TripId = str
ShapeId = str

app = Flask(__name__, static_folder='../static')
if os.environ.get('ZET_DEV') == '1':
    CORS(app, origins=['http://localhost:3000'])
sock = Sock(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# TODO: Take last two-three static messages into account.

@dataclass
class StaticReferenceSystem:
    coord_num_digits: int
    ref_lat: float
    ref_lon: float

    def _compress_coord(self, ref_value: float, values: list[float]) -> list[int]:
        factor = 10 ** self.coord_num_digits
        out = []
        for v in values:
            out.append(int((v - ref_value) * factor + 0.5))
            ref_value = v
        return out

    def compress_lats(self, lat: list[float]) -> list[int]:
        return self._compress_coord(self.ref_lat, lat)

    def compress_lons(self, lon: list[float]) -> list[int]:
        return self._compress_coord(self.ref_lon, lon)


@dataclass
class ReferenceSystem:
    static: StaticReferenceSystem
    ref_timestamp: int

    def compress_timestamps(self, timestamps: list[int]) -> list[int]:
        return [self.ref_timestamp - t for t in timestamps]


STATIC_REFERENCE_SYSTEM = StaticReferenceSystem(
    coord_num_digits=6,
    ref_lat=45.815,
    ref_lon=15.9819,
)

@dataclass
class ParsedVehicle:
    route_id: int
    trip_id: TripId
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
    shape_id: ShapeId | None
    timestamp: int
    lat: list[float]  # lat[0] is the newest position
    lon: list[float]  # lon[0] is the newest position
    direction_radians: float | None = None

    # How many times did the feed not contain the vehicle.
    no_update_counter: int = 0

    @staticmethod
    def from_parsed_vehicle(
        vehicle: ParsedVehicle,
        static_data: Union['StaticData', None],
    ) -> 'Vehicle':
        """Create a vehicle from a parsed vehicle.

        The update() method must be called to add the first position."""
        if static_data:
            shape_id = static_data.trip_to_shape_id.get(vehicle.trip_id)
        else:
            shape_id = None
        return Vehicle(
            route_id=vehicle.route_id,
            shape_id=shape_id,
            timestamp=vehicle.timestamp,
            lat=[],
            lon=[])

    def update(self,
               vehicle: ParsedVehicle,
               static_data: Union['StaticData', None]):
        self.lat.append(vehicle.lat)
        self.lon.append(vehicle.lon)
        if len(self.lat) > MAX_TRAJECTORY_LENGTH:
            self.lat.pop(0)  # Remove the oldest position.
            self.lon.pop(0)
        self.timestamp = vehicle.timestamp
        self.no_update_counter = 0
        self.direction_radians = self.compute_direction(self.lat, self.lon)

        # If for any reason the static data for a given vehicle arrives after
        # the realtime data, update the shape_id.
        if static_data:
            shape_id = static_data.trip_to_shape_id.get(vehicle.trip_id)
            if shape_id is not None:
                self.shape_id = shape_id

    @staticmethod
    def compute_direction(lat: list[float], lon: list[float]) -> float | None:
        if len(lat) < 2:
            return None
        # Find the first sufficiently distant point relative to the current
        # position (lat[-1], lon[-1]) and compute the angle of that vector.
        for i in reversed(range(len(lat) - 1)):
            dist = latlon.haversine_distance_meters(
                lat[-1], lon[-1], lat[i], lon[i])
            if dist > DIRECTION_THRESHOLD_METERS:
                angle = latlon.arrow_angle(lat[i], lon[i], lat[-1], lon[-1])
                return angle
        return None

    def to_json_v0(self):
        if self.direction_radians is not None:
            deg = round(self.direction_radians * 180 / math.pi)
        else:
            deg = None
        return {
            'routeId': self.route_id,
            'timestamp': self.timestamp,
            'lat': self.lat[-TRAJECTORY_OUTPUT_LENGTH:],
            'lon': self.lon[-TRAJECTORY_OUTPUT_LENGTH:],
            'directionDegrees': deg,
        }

    @staticmethod
    def to_compressed_json(
        vehicles: list['Vehicle'],
        ref: ReferenceSystem
    ) -> dict:
        """Return a list of vehicles in a structure-of-arrays JSON format with
        compressed values."""

        static = ref.static
        L = TRAJECTORY_OUTPUT_LENGTH
        compressed_lats = [static.compress_lats(v.lat[-L:]) for v in vehicles]
        compressed_lons = [static.compress_lons(v.lon[-L:]) for v in vehicles]
        degrees = [
            round(v.direction_radians * 180 / math.pi)
            if v.direction_radians is not None else None
            for v in vehicles]
        return {
            'routeIds': [v.route_id for v in vehicles],
            'shapeIds': [v.shape_id for v in vehicles],
            'timestamps': ref.compress_timestamps([v.timestamp for v in vehicles]),
            'compressedLats': compressed_lats,
            'compressedLons': compressed_lons,
            'directionDegrees': degrees,
        }


@dataclass
class RealtimeState:
    vehicles: dict[TripId, Vehicle]
    timestamp: int
    latest_static_key: str | None

    def update(
        self,
        feed: ParsedFeed,
        latest_static_data: Union['StaticDataSnapshot', None],
    ):
        for vehicle in self.vehicles.values():
            vehicle.no_update_counter += 1

        static_data = (
            latest_static_data.static_data if latest_static_data else None)
        for vehicle in feed.vehicles:
            v = self.vehicles.get(vehicle.trip_id)
            if v is None:
                v = Vehicle.from_parsed_vehicle(vehicle, static_data)
                self.vehicles[vehicle.trip_id] = v
            v.update(vehicle, static_data)

        # Remove vehicles not in last 30 feeds.
        self.vehicles = {
            k: v for k, v in self.vehicles.items()
            if v.no_update_counter < 30
        }

        self.timestamp = feed.timestamp
        self.latest_static_key = (
            latest_static_data.key if latest_static_data else None)

    def to_json_v0(self):
        # The old v0 protocol contains only the vehicles.
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
            'latestStaticKey': self.latest_static_key,
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
    def from_realtime_state(state: RealtimeState) -> 'WsOutputMessageVariants':
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


@dataclass
class GtfsShape:
    id: ShapeId
    lats: list[float]
    lons: list[float]

    @staticmethod
    def to_compressed_json(
        shapes: list['GtfsShape'], ref: StaticReferenceSystem
    ) -> dict:
        return {
            'ids': [shape.id for shape in shapes],
            'compressedLats': [
                ref.compress_lats(shape.lats) for shape in shapes],
            'compressedLons': [ref.compress_lons(shape.lons) for shape in shapes],
        }


@dataclass
class StaticData:
    trip_to_shape_id: dict[TripId, ShapeId]
    shapes: dict[ShapeId, GtfsShape]

    @staticmethod
    def from_gzipped_data(gzipped_data: bytes) -> 'StaticData':
        trip_to_shape_id: dict[str, str] = {}

        # The shape points in the shapes.txt do not necessarily have to come
        # in the correct order. The order is specified by the 'shape_pt_sequence'
        # column.
        unsorted_shapes: dict[str, list[tuple[float, float, int]]] = {}

        raw_data = gzip.decompress(gzipped_data)
        with zipfile.ZipFile(io.BytesIO(raw_data)) as zip_file:
            with zip_file.open('trips.txt') as file:
                csv_lines = file.read().decode('utf-8').splitlines()
                reader = csv.DictReader(csv_lines)
                for row in reader:
                    trip_id = str(row['trip_id'])
                    shape_id = str(row['shape_id'])
                    trip_to_shape_id[trip_id] = shape_id
            with zip_file.open('shapes.txt') as file:
                csv_lines = file.read().decode('utf-8').splitlines()
                reader = csv.DictReader(csv_lines)
                for row in reader:
                    shape_id = str(row['shape_id'])
                    lat = float(row['shape_pt_lat'])
                    lon = float(row['shape_pt_lon'])
                    sequence = int(row['shape_pt_sequence'])
                    unsorted_shapes.setdefault(shape_id, []).append(
                        (lat, lon, sequence))

        shapes: dict[str, GtfsShape] = {}
        for shape_id, shape_points in unsorted_shapes.items():
            shape_points.sort(key=lambda x: x[2])
            shapes[shape_id] = GtfsShape(
                id=shape_id,
                lats=[x[0] for x in shape_points],
                lons=[x[1] for x in shape_points],
            )

        return StaticData(trip_to_shape_id=trip_to_shape_id, shapes=shapes)

    def to_json(self, ref: StaticReferenceSystem) -> dict:
        # No need to export the trip_id to the client.
        return {
            'shapes': GtfsShape.to_compressed_json(
                list(self.shapes.values()), ref),
        }


@dataclass
class StaticDataSnapshot:
    key: str
    static_data: StaticData
    formatted_json: str


def compact_json(json_data: dict | list) -> str:
    """Compact JSON data by removing whitespace."""
    return json.dumps(json_data, separators=(',', ':'))


class GtfsServer:
    MAX_RECENT_STATIC_SNAPSHOTS = 3

    def __init__(self, fetcher_url: str):
        self.update_lock = threading.Lock()
        self.realtime_state = RealtimeState(
            vehicles={}, timestamp=0, latest_static_key=None)
        self.fetcher_url = fetcher_url

        # Note: in principle, we could use websocket_server, but it is not
        # compatible with flask. In the future, we may get rid of flask
        # altogether.
        self.ws_clients: set[WsClient] = set()
        self.ws_clients_lock = threading.Lock()
        self.latest_message: WsOutputMessageVariants | None = None

        self._send_time = 0
        self.recent_static_snapshots: list[StaticDataSnapshot] = []

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
            if self.recent_static_snapshots:
                latest_static_data = self.recent_static_snapshots[-1]
            else:
                latest_static_data = None
            self.realtime_state.update(feed, latest_static_data)
            message = WsOutputMessageVariants.from_realtime_state(
                self.realtime_state)
            self.latest_message = message
        return feed, message

    def update_feed_from_file(self, source):
        raw_feed = gtfs_realtime_pb2.FeedMessage()
        with open(source, "rb") as f:
            raw_feed.ParseFromString(f.read())
        self.process_feed(raw_feed)

    def _process_realtime_data(self, data: dict):
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

    def _process_static_data(self, data: dict):
        try:
            key = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M')
            static_data = StaticData.from_gzipped_data(
                bytes.fromhex(data['gzipped_data']))
            json_data = static_data.to_json(STATIC_REFERENCE_SYSTEM)
            snapshot = StaticDataSnapshot(
                key=key,
                static_data=static_data,
                formatted_json=compact_json(json_data),
            )
            with self.update_lock:
                self.recent_static_snapshots.append(snapshot)
                while (len(self.recent_static_snapshots) >
                       self.MAX_RECENT_STATIC_SNAPSHOTS):
                    self.recent_static_snapshots.pop(0)
        except Exception as e:
            logger.error(f"Error processing static data: {e}")

    async def fetch_data_from_fetcher(self):
        def process_message(fetcher_message):
            data = json.loads(fetcher_message)
            kind = data.get('kind')
            try:
                match kind:
                    case 'realtime':
                        self._process_realtime_data(data)
                    case 'static':
                        self._process_static_data(data)
                    case _:
                        logger.error(f"Unknown kind: {kind}")
            except Exception as e:
                logger.error(f"Error processing {kind} message: {e}")


        backoff_time = 1
        max_backoff_time = 4
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
                backoff_time = min(max_backoff_time, backoff_time + 1)

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

    def handle_static_data_request(self, key: str) -> tuple[str, int]:
        for snapshot in self.recent_static_snapshots:
            if snapshot.key == key:
                return snapshot.formatted_json, 200
        return "Static data not found", 404


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


@app.route('/static/<key>')
def static_data(key: str):
    if gtfs_server is None:
        raise Exception("gtfs_server is not initialized")
    json_data, status = gtfs_server.handle_static_data_request(key)
    cache_control = 'public, max-age=31536000' if status == 200 else 'no-cache'
    return json_data, status, {'Cache-Control': cache_control}


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
