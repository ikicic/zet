import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from zet.webserver import webserver
from zet.webserver.frontend_release import RELEASE_CACHE_SECONDS, release_message


class FrontendReleaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'version.json'
        self.environment = patch.dict('os.environ', {'ZET_FRONTEND_RELEASE_FILE': str(self.path)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.clock_patch = patch('zet.webserver.frontend_release.time.monotonic', return_value=1000.0)
        self.clock = self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.server = webserver.GtfsServer('ws://unused')
        self.server_patch = patch.object(webserver, 'gtfs_server', self.server)
        self.server_patch.start()
        self.addCleanup(self.server_patch.stop)

    def write(self, **overrides):
        value = {'version': 'a' * 20, **overrides}
        self.path.write_text(json.dumps(value))

    def connect(self, query=''):
        class WebSocket:
            def __init__(self):
                self.sent = []

            def send(self, message):
                self.sent.append(json.loads(message))

            def receive(self):
                raise RuntimeError('disconnect')

        ws = WebSocket()
        with webserver.app.test_request_context('/ws-v4' + query):
            webserver.app.view_functions['websocket_v4'].__wrapped__(ws)
        self.assertFalse(self.server.ws_clients)
        return ws.sent

    @patch('zet.webserver.frontend_release.open', wraps=open, create=True)
    def test_release_is_opt_in_and_cached_until_expiry(self, read):
        self.write()
        self.assertEqual(self.connect(), [])
        self.assertEqual(self.connect('?appUpdates=0'), [])
        read.assert_not_called()
        self.assertEqual(self.connect('?appUpdates=1'), [
            {'type': 'app-version', 'version': 'a' * 20}])
        self.write(version='b' * 20)
        self.clock.return_value += RELEASE_CACHE_SECONDS - 0.1
        self.assertEqual(self.connect('?appUpdates=1')[0]['version'], 'a' * 20)
        self.assertEqual(read.call_count, 1)
        self.clock.return_value = 1000.0 + RELEASE_CACHE_SECONDS
        self.assertEqual(self.connect('?appUpdates=1')[0]['version'], 'b' * 20)
        self.assertEqual(read.call_count, 2)
        self.write(version='c' * 20)
        self.clock.return_value += RELEASE_CACHE_SECONDS
        self.assertEqual(self.connect('?appUpdates=1'), [
            {'type': 'app-version', 'version': 'c' * 20}])

    def test_bad_or_missing_release_keeps_vehicle_delivery_working(self):
        self.assertIsNone(release_message())
        latest = Mock()
        latest.for_version.return_value = '{"vehicles":{}}'
        self.server.latest_message = latest
        for contents in ['{broken', 'null', '[]', '{}', '\ufffd']:
            self.path.write_text(contents)
            self.clock.return_value += RELEASE_CACHE_SECONDS
            with self.assertLogs('zet.webserver.frontend_release', level='WARNING'):
                self.assertEqual(self.connect('?appUpdates=1'), [{'vehicles': {}}])
        for overrides in [
            {'version': 'invalid'}, {'version': 123}, {'version': None},
        ]:
            self.write(**overrides)
            self.clock.return_value += RELEASE_CACHE_SECONDS
            with self.assertLogs('zet.webserver.frontend_release', level='WARNING'):
                self.assertIsNone(release_message())

    @patch('zet.webserver.frontend_release.open', wraps=open, create=True)
    def test_missing_and_invalid_files_are_cached(self, read):
        self.assertIsNone(release_message())
        self.write()
        self.assertIsNone(release_message())
        self.assertEqual(read.call_count, 1)
        self.clock.return_value += RELEASE_CACHE_SECONDS
        self.assertIsNotNone(release_message())
        self.path.write_text('{broken')
        self.clock.return_value += RELEASE_CACHE_SECONDS
        with self.assertLogs('zet.webserver.frontend_release', level='WARNING') as logs:
            self.assertIsNone(release_message())
            self.assertIsNone(release_message())
        self.assertEqual(len(logs.output), 1)
        self.assertEqual(read.call_count, 3)
        self.write(version='b' * 20)
        self.assertIsNone(release_message())
        self.clock.return_value += RELEASE_CACHE_SECONDS
        self.assertEqual(json.loads(release_message())['version'], 'b' * 20)
        self.assertEqual(read.call_count, 4)

    @patch('zet.webserver.frontend_release.open', wraps=open, create=True)
    def test_concurrent_connections_share_one_read_per_cache_period(self, read):
        self.write()
        for period in range(2):
            with ThreadPoolExecutor(max_workers=8) as pool:
                messages = list(pool.map(lambda _: release_message(), range(32)))
            self.assertTrue(all(message == messages[0] for message in messages))
            self.assertEqual(json.loads(messages[0])['version'], 'a' * 20)
            self.assertEqual(read.call_count, period + 1)
            self.clock.return_value += RELEASE_CACHE_SECONDS

    def test_release_precedes_initial_vehicle_data(self):
        self.write()
        latest = Mock()
        latest.for_version.return_value = '{"vehicles":{}}'
        self.server.latest_message = latest
        messages = self.connect('?appUpdates=1')
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]['type'], 'app-version')
        self.assertEqual(messages[1], {'vehicles': {}})
        latest.for_version.assert_called_once_with(4)
