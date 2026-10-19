from dataclasses import replace
import unittest
from unittest.mock import patch

from zet.webserver.webserver import (
    ParsedFeed, ParsedVehicle, RealtimeState, StaticData, StaticDataSnapshot,
)


class RealtimeVehicleIdentityTest(unittest.TestCase):
    def setUp(self):
        clock = patch("zet.webserver.webserver.time.monotonic", return_value=1000)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        self.state = RealtimeState(vehicles={}, timestamp=0, active_static_key=None)
        self.snapshot = StaticDataSnapshot(
            key='static',
            static_data=StaticData(
                trip_to_shape_id={'trip-a': 'shape-a', 'trip-b': 'shape-b'},
                trip_to_block_id={'trip-a': '1102', 'trip-b': '1208'},
                shapes={}, route_ids=[11, 12], calendar_dates=set(),
            ),
            formatted_json_big='', formatted_json_small='',
        )
        self.vehicle = ParsedVehicle(
            vehicle_id='102204', trip_id='trip-a', route_id=11,
            timestamp=100, lat=45.79617, lon=15.93780,
        )

    def update(self, *vehicles, feed_timestamp=None):
        if feed_timestamp is None:
            feed_timestamp = max(v.timestamp for v in vehicles)
        self.state.update(ParsedFeed(
            vehicles=list(vehicles), timestamp=feed_timestamp,
        ), self.snapshot)
        return self.state.to_json_v1()['vehicles']

    def active_vehicles(self):
        return {v.vehicle_id: v for v in self.state.vehicles.values()
                if v.no_update_counter == 0}

    def test_shared_trip_keeps_both_vehicles_and_independent_trails(self):
        a = self.vehicle
        b = replace(a, vehicle_id='102278', lat=45.82228, lon=16.02804)
        payload = self.update(a, b)
        self.assertCountEqual(payload['vehicleIds'], ['102204', '102278'])
        self.assertEqual(payload['tripIds'], ['trip-a', 'trip-a'])
        self.assertEqual(payload['blockIds'], ['1102', '1102'])
        self.assertEqual(payload['directionDegrees'], [None, None])
        self.assertTrue(all(len(lat) == 1 for lat in payload['compressedLats']))

        moved_a = replace(a, timestamp=110, lat=a.lat + 0.0005)
        moved_b = replace(b, timestamp=110, lon=b.lon + 0.0005)
        self.update(moved_b, moved_a)  # Feed order must not determine identity.
        active = self.active_vehicles()
        self.assertEqual(active[a.vehicle_id].lat, [a.lat, moved_a.lat])
        self.assertEqual(active[a.vehicle_id].lon, [a.lon, moved_a.lon])
        self.assertEqual(active[b.vehicle_id].lat, [b.lat, moved_b.lat])
        self.assertEqual(active[b.vehicle_id].lon, [b.lon, moved_b.lon])
        self.assertIsNotNone(active[a.vehicle_id].direction_radians)
        self.assertIsNotNone(active[b.vehicle_id].direction_radians)

    def test_trip_change_resets_trail_direction_route_and_shape(self):
        a = self.vehicle
        self.update(a)
        self.update(replace(a, timestamp=110, lat=a.lat + 0.001))
        self.assertIsNotNone(self.active_vehicles()[a.vehicle_id].direction_radians)

        next_trip = replace(a, trip_id='trip-b', route_id=12,
                            timestamp=120, lat=a.lat + 0.002)
        payload = self.update(next_trip)
        self.assertEqual(payload['vehicleIds'], [a.vehicle_id])
        self.assertEqual(payload['routeIds'], [12])
        self.assertEqual(payload['shapeIds'], ['shape-b'])
        self.assertEqual(payload['tripIds'], ['trip-b'])
        self.assertEqual(payload['blockIds'], ['1208'])
        self.assertEqual(payload['directionDegrees'], [None])
        self.assertEqual(self.active_vehicles()[a.vehicle_id].lat, [next_trip.lat])
        self.assertEqual(len(self.state.to_json_v0()), 1)

        moved = replace(next_trip, timestamp=130, lon=next_trip.lon + 0.001)
        self.update(moved)
        self.assertEqual(self.active_vehicles()[a.vehicle_id].lon,
                         [next_trip.lon, moved.lon])

    def test_missing_vehicle_id_retains_per_trip_history(self):
        anonymous = replace(self.vehicle, vehicle_id=None)
        other = replace(anonymous, trip_id='trip-b', route_id=12)
        self.update(anonymous, other)
        moved = replace(anonymous, timestamp=110, lat=anonymous.lat + 0.001)
        payload = self.update(moved)
        self.assertEqual(payload['vehicleIds'], [None])
        self.assertEqual(payload['tripIds'], ['trip-a'])
        self.assertEqual(self.active_vehicles()[None].lat,
                         [anonymous.lat, moved.lat])

    def test_report_delay_is_measured_when_a_report_arrives(self):
        a = self.vehicle
        self.update(replace(a, timestamp=95), feed_timestamp=100)
        payload = self.update(a, feed_timestamp=108)
        self.assertEqual(payload['reportDelays'], [8])

        # Repeated reports stay fresh even after a long stop.
        for feed_time in range(110, 700, 10):
            payload = self.update(a, feed_timestamp=feed_time)
            self.assertEqual(payload['reportDelays'], [8])
        delayed = replace(a, timestamp=150, lat=a.lat + 0.001)
        payload = self.update(delayed, feed_timestamp=700)
        self.assertEqual(payload['reportDelays'], [550])
        self.assertEqual(self.update(delayed, feed_timestamp=704)['reportDelays'],
                         [550])

        recovered = replace(delayed, timestamp=705, lat=a.lat + 0.002)
        payload = self.update(recovered, feed_timestamp=710)
        self.assertEqual(payload['reportDelays'], [5])

    def test_startup_uses_position_age_then_holds_it_during_a_stop(self):
        self.assertEqual(self.update(self.vehicle, feed_timestamp=700)
                         ['reportDelays'], [600])
        self.assertEqual(self.update(self.vehicle, feed_timestamp=710)
                         ['reportDelays'], [600])
        self.assertEqual(self.update(replace(self.vehicle, timestamp=715),
                                     feed_timestamp=720)['reportDelays'], [5])

    def test_gap_uses_position_age_even_when_the_timestamp_is_unchanged(self):
        for missing_vehicle in (False, True):
            for timestamp in (100, 105):
                with self.subTest(missing_vehicle=missing_vehicle, timestamp=timestamp):
                    self.state = RealtimeState({}, 0, None)
                    self.update(self.vehicle, feed_timestamp=100)
                    if missing_vehicle:
                        self.update(feed_timestamp=105)
                        feed_time = 110
                    else:
                        feed_time = 700
                    report = replace(self.vehicle, timestamp=timestamp)
                    self.assertEqual(self.update(report, feed_timestamp=feed_time)
                                     ['reportDelays'], [feed_time - timestamp])
                    self.assertEqual(self.update(report, feed_timestamp=feed_time + 5)
                                     ['reportDelays'], [feed_time - timestamp])
                    self.assertEqual(self.update(replace(report, timestamp=feed_time + 6),
                                                 feed_timestamp=feed_time + 10)
                                     ['reportDelays'], [4])

    def test_reception_gap_is_detected_with_buffered_or_identical_feed_times(self):
        for feed_time in (100, 110):
            with self.subTest(feed_time=feed_time):
                self.state = RealtimeState({}, 0, None)
                self.clock.return_value = 1000
                buffered = replace(self.vehicle, timestamp=80)
                self.update(buffered, feed_timestamp=90)
                self.assertEqual(self.update(buffered, feed_timestamp=100)
                                 ['reportDelays'], [10])
                self.clock.return_value = 1300
                self.assertEqual(self.update(buffered, feed_timestamp=feed_time)
                                 ['reportDelays'], [feed_time - 80])
                self.clock.return_value = 1305
                self.assertEqual(self.update(buffered, feed_timestamp=feed_time + 5)
                                 ['reportDelays'], [feed_time - 80])

    def test_reception_gap_resets_unchanged_vehicle_estimate(self):
        self.update(self.vehicle, feed_timestamp=100)
        self.update(replace(self.vehicle, timestamp=105), feed_timestamp=700)
        self.update(replace(self.vehicle, timestamp=690), feed_timestamp=710)
        self.clock.return_value += 300
        self.assertEqual(self.update(replace(self.vehicle, timestamp=690),
                                     feed_timestamp=720)['reportDelays'], [30])

    def test_bad_vehicle_timestamps_recover(self):
        for bad_timestamp, expected in ((0, None), (90, 20), (86500, None)):
            with self.subTest(bad_timestamp=bad_timestamp):
                self.state = RealtimeState({}, 0, None)
                self.update(self.vehicle, feed_timestamp=100)
                bad = replace(self.vehicle, timestamp=bad_timestamp)
                self.assertEqual(self.update(bad, feed_timestamp=110)
                                 ['reportDelays'], [expected])
                normal = replace(self.vehicle, timestamp=115)
                self.assertEqual(self.update(normal, feed_timestamp=120)
                                 ['reportDelays'], [5])

    def test_older_feed_resets_observation_history(self):
        self.update(self.vehicle, feed_timestamp=108)
        self.update(replace(self.vehicle, timestamp=110), feed_timestamp=115)
        payload = self.update(replace(self.vehicle, timestamp=90), feed_timestamp=100)
        self.assertEqual(payload['reportDelays'], [10])
        self.assertEqual(len(self.active_vehicles()[self.vehicle.vehicle_id].lat), 1)

    def test_trip_change_and_expiry_reset_delay(self):
        self.update(self.vehicle, feed_timestamp=100)
        moved = replace(self.vehicle, timestamp=105)
        self.assertEqual(self.update(moved, feed_timestamp=110)['reportDelays'], [5])
        next_trip = replace(moved, trip_id='trip-b')
        self.assertEqual(self.update(next_trip, feed_timestamp=115)['reportDelays'],
                         [10])
        for t in range(120, 270, 5):
            self.update(feed_timestamp=t)
        self.assertEqual(self.update(moved, feed_timestamp=270)['reportDelays'],
                         [165])


if __name__ == '__main__':
    unittest.main()
