import datetime
import gzip
import io
from itertools import accumulate
import json
import unittest
import zipfile
from unittest.mock import patch

from google.transit import gtfs_realtime_pb2

from zet.webserver.webserver import GtfsServer, StaticData, STATIC_REFERENCE_SYSTEM


def make_archive(route_id: int, date: str = '20260103',
                 overrides: dict[str, str] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        files = {
            'trips.txt': 'trip_id,shape_id\ntrip,shape\n',
            'shapes.txt': (
                'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n'
                'shape,45.815,15.9819,1\n'),
            'calendar_dates.txt': f'date\n{date}\n',
            'routes.txt': f'route_id\n{route_id}\n',
            'stops.txt': ('stop_id,stop_lat,stop_lon\n'
                          'a,45.815,15.9819\nb,45.816,15.9829\n'),
            'stop_times.txt': ('trip_id,stop_id,stop_sequence\n'
                               'trip,b,20\ntrip,a,10\n'),
        }
        files.update(overrides or {})
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def load_archive(server: GtfsServer, raw: bytes, mtime: int = 0) -> None:
    server._process_static_data({
        'gzipped_data': gzip.compress(raw, mtime=mtime).hex(),
    })


class CoordinateCompressionTest(unittest.TestCase):
    def test_negative_steps_and_return_to_origin(self):
        self.assertEqual(STATIC_REFERENCE_SYSTEM.compress_lats(
            [45.815, 45.814990, 45.814980, 45.815]), [0, -10, -10, 20])
        self.assertEqual(STATIC_REFERENCE_SYSTEM.compress_lons(
            [15.9819, 15.981890, 15.981880, 15.9819]), [0, -10, -10, 20])

    def test_rounding_error_does_not_accumulate(self):
        for step in (-0.0000004, 0.0000004):
            values = [45.815 + i * step for i in range(2000)]
            offsets = accumulate(STATIC_REFERENCE_SYSTEM.compress_lats(values))
            for original, offset in zip(values, offsets):
                decoded = 45.815 + offset * 1e-6
                self.assertLessEqual(abs(decoded - original), 0.5001e-6)
        self.assertEqual(STATIC_REFERENCE_SYSTEM.compress_lats([]), [])


class StaticSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        # Construction starts no threads and makes no network requests.
        self.server = GtfsServer('ws://example.invalid')

    def test_vehicle_details_reach_realtime_payload_and_refresh_with_static_data(self):
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.header.gtfs_realtime_version = '2.0'
        feed.header.timestamp = int(datetime.datetime(
            2026, 1, 3, 12, tzinfo=datetime.timezone.utc).timestamp())
        for trip_id, vehicle_id in [('trip', '102202'), ('other', '00395')]:
            entity = feed.entity.add()
            entity.id = f'entity-{vehicle_id}'
            entity.vehicle.vehicle.id = vehicle_id
            entity.vehicle.trip.trip_id = trip_id
            entity.vehicle.trip.route_id = '6'
            entity.vehicle.timestamp = feed.header.timestamp
            entity.vehicle.position.latitude = 45.815
            entity.vehicle.position.longitude = 15.9819

        def vehicles():
            _, message = self.server.process_feed(feed)
            return json.loads(message.version2)['vehicles']

        initial = vehicles()
        self.assertEqual(initial['vehicleIds'], ['102202', '00395'])
        self.assertEqual(initial['tripIds'], ['trip', 'other'])
        self.assertEqual(initial['blockIds'], [None, None])

        # Two trips share a shape, but their blocks are distinct. The trip IDs
        # deliberately contain no block information to prevent guessed parsing.
        load_archive(self.server, make_archive(6, overrides={
            'trips.txt': ('trip_id,shape_id,block_id\n'
                          'trip,shape,206\nother,shape,006\n'),
        }))
        feed.header.timestamp += 1
        enriched = vehicles()
        self.assertEqual(enriched['blockIds'], ['206', '006'])
        self.assertEqual(enriched['vehicleIds'], ['102202', '00395'])
        self.assertEqual(enriched['shapeIds'], ['shape', 'shape'])

        # Missing optional fields must not hide vehicles or retain stale values.
        load_archive(self.server, make_archive(6))
        feed.entity[0].vehicle.ClearField('vehicle')
        feed.header.timestamp += 1
        missing = vehicles()
        self.assertEqual(dict(zip(missing['tripIds'], missing['vehicleIds'])),
                         {'trip': None, 'other': '00395'})
        self.assertEqual(missing['blockIds'], [None, None])

    def test_blank_block_id_is_unavailable(self):
        data = StaticData.from_zip_data(make_archive(6, overrides={
            'trips.txt': 'trip_id,shape_id,block_id\ntrip,shape,\n',
        }))
        self.assertEqual(data.trip_to_block_id, {})

    def test_stops_are_ordered_and_shared_between_shapes(self):
        data = StaticData.from_zip_data(make_archive(6, overrides={
            'trips.txt': ('trip_id,shape_id\ntrip,shape\n'
                          'return,reverse\nrepeat,shape\nunknown,\n'),
            'shapes.txt': ('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n'
                           'shape,45.815,15.9819,1\n'
                           'reverse,45.816,15.9829,1\n'),
            'stop_times.txt': ('trip_id,stop_id,stop_sequence\n'
                               'trip,b,20\ntrip,a,10\n'
                               'return,a,2\nreturn,b,1\n'
                               'repeat,a,1\nrepeat,b,2\nunknown,a,1\n'),
        }))
        payload = data.big_to_json(STATIC_REFERENCE_SYSTEM)
        self.assertNotIn('ids', payload['stops'])
        self.assertEqual(payload['stops']['latDeltas'], [0, 1000])
        self.assertEqual(payload['stops']['lonDeltas'], [0, 1000])
        self.assertEqual(payload['shapes']['ids'], ['shape', 'reverse'])
        self.assertEqual(payload['shapes']['stopIndexDeltas'], [[0, 1], [1, -1]])
        self.assertNotIn('', data.shape_stop_ids)

    def test_ambiguous_shape_keeps_geometry_but_omits_stops(self):
        with self.assertLogs('zet.webserver.webserver', level='WARNING'):
            data = StaticData.from_zip_data(make_archive(6, overrides={
                'trips.txt': 'trip_id,shape_id\ntrip,shape\nother,shape\n',
                'stop_times.txt': ('trip_id,stop_id,stop_sequence\n'
                                   'trip,a,1\ntrip,b,2\nother,b,1\n'),
            }))
        payload = data.big_to_json(STATIC_REFERENCE_SYSTEM)
        self.assertEqual(payload['shapes']['ids'], ['shape'])
        self.assertEqual(payload['shapes']['stopIndexDeltas'], [[]])

    def test_interleaved_trips_restart_without_partial_patterns(self):
        with self.assertLogs('zet.webserver.webserver', level='INFO') as logs:
            data = StaticData.from_zip_data(make_archive(6, overrides={
                'trips.txt': 'trip_id,shape_id\ntrip,shape\nother,shape\n',
                # Columns and rows are intentionally out of order. Both trips
                # eventually resolve to a,b despite different partial blocks.
                'stop_times.txt': ('stop_id,stop_sequence,trip_id\n'
                                   'b,2,trip\na,1,other\na,1,trip\nb,2,other\n'),
            }))
        self.assertTrue(any('Interleaved' in line for line in logs.output))
        self.assertEqual(data.shape_stop_ids, {'shape': ['a', 'b']})

    def test_blank_rows_are_ignored_in_both_parsing_paths(self):
        for rows in (
            'trip,a,1\n\ntrip,b,2\nother,a,1\n\nother,b,2\n',
            'trip,a,1\n\nother,a,1\ntrip,b,2\n\nother,b,2\n',
        ):
            with self.subTest(rows=rows):
                data = StaticData.from_zip_data(make_archive(6, overrides={
                    'trips.txt': 'trip_id,shape_id\ntrip,shape\nother,shape\n',
                    'stop_times.txt': '\ntrip_id,stop_id,stop_sequence\n\n' + rows + '\n',
                }))
                self.assertEqual(data.shape_stop_ids, {'shape': ['a', 'b']})

    def test_interleaved_trips_still_detect_ambiguous_shapes(self):
        with self.assertLogs('zet.webserver.webserver', level='WARNING'):
            data = StaticData.from_zip_data(make_archive(6, overrides={
                'trips.txt': 'trip_id,shape_id\ntrip,shape\nother,shape\n',
                'stop_times.txt': ('trip_id,stop_id,stop_sequence\n'
                                   'trip,a,1\nother,b,1\ntrip,b,2\n'),
            }))
        self.assertEqual(data.shape_stop_ids, {})

    def test_stop_deltas_preserve_first_appearance_repeats_and_rounding(self):
        data = StaticData.from_zip_data(make_archive(6, overrides={
            'stops.txt': ('stop_id,stop_lat,stop_lon\n'
                          'a,45.8149994,15.9819006\n'
                          'z,45.8160004,15.9808996\n'
                          'm,45.8155004,15.9814004\n'),
            'stop_times.txt': ('trip_id,stop_id,stop_sequence\n'
                               'trip,z,1\ntrip,a,2\ntrip,m,3\ntrip,z,4\n'),
        }))
        payload = data.big_to_json(STATIC_REFERENCE_SYSTEM)
        # Table order is z, a, m, not alphabetical; the return to z is -2.
        self.assertEqual(payload['shapes']['stopIndexDeltas'], [[0, 1, 1, -2]])
        self.assertEqual(payload['stops']['latDeltas'], [1000, -1001, 501])
        self.assertEqual(payload['stops']['lonDeltas'], [-1000, 1001, -501])

    def test_missing_stop_coordinates_do_not_prevent_route_loading(self):
        data = StaticData.from_zip_data(make_archive(6, overrides={
            'stops.txt': 'stop_id,stop_lat,stop_lon\na,45.815,15.9819\nb,,\n',
        }))
        payload = data.big_to_json(STATIC_REFERENCE_SYSTEM)
        self.assertEqual(payload['stops']['latDeltas'], [0])
        self.assertEqual(payload['stops']['lonDeltas'], [0])
        self.assertEqual(payload['shapes']['stopIndexDeltas'], [[0]])

    def test_versioned_static_endpoint_includes_stops(self):
        import zet.webserver.webserver as webserver
        load_archive(self.server, make_archive(6))
        key = self.server.recent_static_snapshots[0].key
        with patch.object(webserver, 'gtfs_server', self.server):
            client = webserver.app.test_client()
            response = client.get(f'/static/big/v1/{key}')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(json.loads(response.data)['shapes']['stopIndexDeltas'], [[0, 1]])
            self.assertEqual(response.headers['Cache-Control'], 'public, max-age=5184000')
            self.assertEqual(client.get('/static/big/v1/missing').status_code, 404)

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
