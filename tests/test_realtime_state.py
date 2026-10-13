from dataclasses import replace
import unittest

from zet.webserver.webserver import (
    ParsedFeed, ParsedVehicle, RealtimeState, StaticData, StaticDataSnapshot,
)


class RealtimeVehicleIdentityTest(unittest.TestCase):
    def setUp(self):
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

    def update(self, *vehicles):
        self.state.update(ParsedFeed(
            vehicles=list(vehicles), timestamp=max(v.timestamp for v in vehicles),
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


if __name__ == '__main__':
    unittest.main()
