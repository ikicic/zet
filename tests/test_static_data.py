import datetime
import gzip
import io
import json
import unittest
import zipfile
from unittest.mock import patch

from google.transit import gtfs_realtime_pb2

from zet.webserver.webserver import GtfsServer, StaticData


def make_archive(route_id: int, date: str = '20260103') -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        files = {
            'trips.txt': 'trip_id,shape_id\ntrip,shape\n',
            'shapes.txt': (
                'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n'
                'shape,45.815,15.9819,1\n'),
            'calendar_dates.txt': f'date\n{date}\n',
            'routes.txt': f'route_id\n{route_id}\n',
        }
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def load_archive(server: GtfsServer, raw: bytes, mtime: int = 0) -> None:
    server._process_static_data({
        'gzipped_data': gzip.compress(raw, mtime=mtime).hex(),
    })


class StaticSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        # Construction starts no threads and makes no network requests.
        self.server = GtfsServer('ws://example.invalid')

    def test_selects_snapshot_for_feed_date_in_zagreb(self):
        for utc_time, local_date in (
            ('2026-01-02T23:30:00+00:00', '20260103'),
            ('2026-07-02T22:30:00+00:00', '20260703'),
        ):
            with self.subTest(utc_time=utc_time):
                server = GtfsServer('ws://example.invalid')
                load_archive(server, make_archive(6, local_date))
                expected_key = server.recent_static_snapshots[-1].key
                # A newer archive for a different date must not be selected.
                load_archive(server, make_archive(7, '20990101'))
                feed = gtfs_realtime_pb2.FeedMessage()
                feed.header.gtfs_realtime_version = '2.0'
                feed.header.timestamp = int(
                    datetime.datetime.fromisoformat(utc_time).timestamp())
                entity = feed.entity.add()
                entity.id = 'vehicle'
                entity.vehicle.trip.trip_id = 'trip'
                entity.vehicle.trip.route_id = '6'
                entity.vehicle.timestamp = feed.header.timestamp
                entity.vehicle.position.latitude = 45.815
                entity.vehicle.position.longitude = 15.9819
                _, message = server.process_feed(feed)
                self.assertIsNotNone(message)
                state = json.loads(message.version2)
                self.assertEqual(state['activeStaticKey'], expected_key)
                self.assertEqual(state['vehicles']['shapeIds'], ['shape'])

                feed.header.timestamp = int(datetime.datetime(
                    2000, 1, 1, tzinfo=datetime.timezone.utc).timestamp())
                server.process_feed(feed)
                self.assertIsNone(server.realtime_state.active_static_key)

    def test_same_zip_has_same_key_across_servers_and_gzip_headers(self):
        raw = make_archive(6)
        load_archive(self.server, raw, mtime=1)
        other = GtfsServer('ws://example.invalid')
        load_archive(other, raw, mtime=2)
        key = self.server.recent_static_snapshots[0].key
        self.assertRegex(key, r'^[0-9a-f]{32}$')
        self.assertEqual(key, other.recent_static_snapshots[0].key)

    def test_distinct_archives_are_served_under_distinct_keys(self):
        for route in (6, 7):
            load_archive(self.server, make_archive(route))
        first, second = self.server.recent_static_snapshots
        self.assertNotEqual(first.key, second.key)
        for snapshot, route in ((first, 6), (second, 7)):
            body, status = self.server.handle_small_static_data_request(snapshot.key)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['routes']['ids'], [route])
            body, status = self.server.handle_big_static_data_request(snapshot.key)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['shapes']['ids'], ['shape'])

    def test_duplicate_does_not_reparse_reorder_or_evict_snapshots(self):
        archives = [make_archive(route) for route in (6, 7, 8)]
        for raw in archives:
            load_archive(self.server, raw)
        before = list(self.server.recent_static_snapshots)
        with patch.object(StaticData, 'from_zip_data') as parse:
            load_archive(self.server, archives[0], mtime=2)
            parse.assert_not_called()
        self.assertEqual(self.server.recent_static_snapshots, before)
        load_archive(self.server, make_archive(9))
        self.assertEqual(len(self.server.recent_static_snapshots), 3)
        self.assertEqual(self.server.recent_static_snapshots[:2], before[1:])
        self.assertEqual(
            self.server.handle_small_static_data_request(before[0].key)[1], 404)


if __name__ == '__main__':
    unittest.main()
