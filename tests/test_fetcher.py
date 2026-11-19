import io
import tempfile
import unittest
from email.message import Message
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import HTTPHandler, build_opener
from urllib.response import addinfourl

from google.transit import gtfs_realtime_pb2

from zet.fetcher.fetcher import CachedHttpResponse, Fetcher, MIN_UNCHANGED_DELAY, fetch_url, retry_after_delay


def http_response(body, etag=None, url='https://example.invalid/feed'):
    response = io.BytesIO(body)
    response.geturl = lambda: url
    response.headers = Message()
    if etag is not None:
        response.headers['ETag'] = etag
    return response


class ConditionalRequestTest(unittest.TestCase):
    def test_rotating_redirect_targets_retain_only_current_archive(self):
        latest = 'http://example.invalid/latest'
        target = ''
        payload = b''
        validators = []

        class FixtureHTTPHandler(HTTPHandler):
            def http_open(self, request):
                headers = Message()
                if request.full_url == latest:
                    headers['Location'] = target
                    code, body = 302, b''
                else:
                    validators.append(request.get_header('If-none-match'))
                    headers['ETag'] = '"1"'
                    code, body = 200, payload
                response = addinfourl(io.BytesIO(body), headers, request.full_url, code)
                response.msg = 'fixture'
                return response

        cache = {}
        with patch('zet.fetcher.fetcher.build_opener', side_effect=lambda *handlers:
                   build_opener(*handlers, FixtureHTTPHandler())):
            # Twenty 1 MiB archives, then return to a previously visited target.
            for index in [*range(20), 0]:
                target = f'http://example.invalid/archive-{index}.zip'
                payload = bytes([index]) * (1024 * 1024)
                self.assertEqual(fetch_url(latest, cache=cache), payload)
                self.assertEqual(cache, {latest: CachedHttpResponse(target, '"1"', payload)})
                self.assertEqual(sum(len(entry.data) for entry in cache.values()), 1024 * 1024)
        self.assertEqual(validators, [None] * 21)

    def test_new_target_without_etag_discards_previous_archive(self):
        latest = 'https://example.invalid/latest'
        cache = {latest: CachedHttpResponse('https://example.invalid/old.zip', '"1"', b'old')}
        with patch('zet.fetcher.fetcher._open_url', return_value=http_response(
                b'new', url='https://example.invalid/new.zip')):
            self.assertEqual(fetch_url(latest, cache=cache), b'new')
        self.assertEqual(cache, {})

    def test_304_for_other_target_cannot_reuse_current_archive(self):
        latest = 'https://example.invalid/latest'
        cached = CachedHttpResponse('https://example.invalid/old.zip', '"1"', b'old')
        cache = {latest: cached}
        error = HTTPError('https://example.invalid/new.zip', 304,
                          'Not Modified', {'ETag': '"1"'}, io.BytesIO())
        with patch('zet.fetcher.fetcher._open_url', side_effect=error):
            with self.assertRaises(HTTPError):
                fetch_url(latest, cache=cache)
        self.assertEqual(cache, {latest: cached})
        self.assertTrue(error.closed)

    def test_redirect_target_change_with_same_etag_fetches_new_bytes(self):
        # Exercise urllib's actual redirect and 304 processing without sockets.
        for redirect_code in (301, 302, 303, 307, 308):
            with self.subTest(redirect_code=redirect_code):
                base = 'http://example.invalid'
                latest, hop = base + '/latest', base + '/hop'
                old, new = base + '/old.zip', 'http://other.invalid/new.zip'
                target = old
                seen = []

                class FixtureHTTPHandler(HTTPHandler):
                    def http_open(self, request):
                        url = request.full_url
                        validator = request.get_header('If-none-match')
                        seen.append((url, validator))
                        headers = Message()
                        if url in (latest, hop):
                            headers['Location'] = '/hop' if url == latest else target
                            code, body = redirect_code, b''
                        else:
                            headers['ETag'] = '"1"'
                            code = 304 if validator == '"1"' else 200
                            body = b'' if code == 304 else (b'old ZIP' if url == old else b'new ZIP')
                        response = addinfourl(io.BytesIO(body), headers, url, code)
                        response.msg = 'fixture'
                        return response

                cache = {}
                with patch('zet.fetcher.fetcher.build_opener', side_effect=lambda *handlers:
                           build_opener(*handlers, FixtureHTTPHandler())):
                    self.assertEqual(fetch_url(latest, cache=cache), b'old ZIP')
                    self.assertEqual(fetch_url(latest, cache=cache), b'old ZIP')
                    target = new
                    self.assertEqual(fetch_url(latest, cache=cache), b'new ZIP')
                    self.assertEqual(fetch_url(latest, cache=cache), b'new ZIP')
                self.assertEqual(seen, [
                    (latest, None), (hop, None), (old, None),
                    (latest, None), (hop, None), (old, '"1"'),
                    (latest, None), (hop, None), (new, None),
                    (latest, None), (hop, None), (new, '"1"'),
                ])
                self.assertEqual(cache, {latest: CachedHttpResponse(new, '"1"', b'new ZIP')})

    def test_previously_cached_resource_redirects_without_leaking_validator(self):
        original, destination = 'http://example.invalid/feed', 'http://example.invalid/new'
        seen = []

        class FixtureHTTPHandler(HTTPHandler):
            def http_open(self, request):
                seen.append((request.full_url, request.get_header('If-none-match')))
                headers = Message()
                if request.full_url == original:
                    headers['Location'] = destination
                    code, body = 302, b''
                else:
                    headers['ETag'] = '"1"'
                    code, body = 200, b'new'
                response = addinfourl(io.BytesIO(body), headers, request.full_url, code)
                response.msg = 'fixture'
                return response

        cache = {original: CachedHttpResponse(original, '"1"', b'old')}
        with patch('zet.fetcher.fetcher.build_opener', side_effect=lambda *handlers:
                   build_opener(*handlers, FixtureHTTPHandler())):
            self.assertEqual(fetch_url(original, cache=cache), b'new')
        self.assertEqual(seen, [(original, '"1"'), (destination, None)])

    def test_revalidates_exact_etag_and_replaces_changed_response(self):
        cache = {}
        url = 'https://example.invalid/feed'
        etag = 'W/"original"'
        unchanged = HTTPError(url, 304, 'Not Modified', {}, io.BytesIO())
        with patch('zet.fetcher.fetcher._open_url', side_effect=[
                http_response(b'first', etag), unchanged,
                http_response(b'second', '"changed"')]) as open_url:
            self.assertEqual(fetch_url(url, cache=cache), b'first')
            self.assertEqual(fetch_url(url, cache=cache), b'first')
            self.assertEqual(fetch_url(url, cache=cache), b'second')
        self.assertEqual([call.args[0].get_header('If-none-match')
                          for call in open_url.call_args_list], [None, etag, etag])
        self.assertEqual(cache[url], CachedHttpResponse(url, '"changed"', b'second'))
        self.assertTrue(unchanged.closed)

    def test_urls_are_independent_and_missing_etag_clears_validator(self):
        cache = {}
        with patch('zet.fetcher.fetcher._open_url', side_effect=[
                http_response(b'a', '"a"', 'https://a.invalid'),
                http_response(b'b', '"b"', 'https://b.invalid'),
                http_response(b'new-a', url='https://a.invalid'),
                http_response(b'newer-a', url='https://a.invalid')]) as open_url:
            for url in ['https://a.invalid', 'https://b.invalid',
                        'https://a.invalid', 'https://a.invalid']:
                fetch_url(url, cache=cache)
        self.assertEqual([call.args[0].get_header('If-none-match')
                          for call in open_url.call_args_list], [None, None, '"a"', None])
        self.assertEqual(cache, {'https://b.invalid': CachedHttpResponse('https://b.invalid', '"b"', b'b')})

    def test_304_without_cached_bytes_is_an_error(self):
        error = HTTPError('https://example.invalid', 304, 'Not Modified', {}, io.BytesIO())
        with patch('zet.fetcher.fetcher._open_url', side_effect=error):
            with self.assertRaises(HTTPError):
                fetch_url('https://example.invalid', cache={})
        self.assertTrue(error.closed)

    def test_429_preserves_cache_and_retry_after(self):
        url = 'https://example.invalid'
        cache = {url: CachedHttpResponse(url, '"old"', b'old')}
        error = HTTPError(url, 429, 'Limited', {'Retry-After': '8'}, io.BytesIO())
        with patch('zet.fetcher.fetcher._open_url', side_effect=error):
            with self.assertRaises(HTTPError) as caught:
                fetch_url(url, cache=cache)
        self.assertEqual(caught.exception.headers['Retry-After'], '8')
        self.assertEqual(cache[url], CachedHttpResponse(url, '"old"', b'old'))
        self.assertTrue(error.closed)

    def test_304_keeps_duplicate_database_rows_and_short_polling_delay(self):
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.header.gtfs_realtime_version = '1.0'
        feed.header.timestamp = 1794517550
        body = feed.SerializeToString()
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/feed'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.current_realtime_snapshot = None
        fetcher.new_snapshots_count = 0
        fetcher.ws_server = Mock()
        fetcher.maybe_fetch_static = Mock(return_value=False)
        fetcher.close = Mock()
        delays = []

        def record_sleep(delay):
            delays.append(delay)
            if len(delays) == 2:
                fetcher.running = False

        fetcher.sleep = record_sleep
        with tempfile.TemporaryDirectory() as directory:
            fetcher.db_conn, fetcher.db_cursor, fetcher.db_path = Fetcher.setup_database(directory)
            try:
                unchanged = HTTPError(fetcher.realtime_url, 304, 'Not Modified', {}, io.BytesIO())
                with patch('zet.fetcher.fetcher._open_url', side_effect=[http_response(body, '"v1"'), unchanged]):
                    fetcher.run()
                rows = fetcher.db_cursor.execute(
                    'SELECT snapshot_at, length(gzipped_data) FROM snapshots ORDER BY id').fetchall()
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[0][0], rows[1][0])
                self.assertGreater(rows[0][1], 0)
                self.assertEqual(rows[1][1], 0)
                self.assertEqual(delays, [9, MIN_UNCHANGED_DELAY])
                fetcher.ws_server.update_realtime_snapshot.assert_called_once()
            finally:
                fetcher.db_conn.close()


class FetcherPollingTest(unittest.TestCase):
    def run_fetcher(self, snapshot_results: list[bool]) -> list[float]:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/realtime'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.store_realtime_snapshot = Mock(side_effect=snapshot_results)
        fetcher.maybe_fetch_static = Mock(return_value=False)
        fetcher.close = Mock()

        delays = []

        def record_sleep(delay: float) -> None:
            delays.append(delay)
            if len(delays) == len(snapshot_results):
                fetcher.running = False

        fetcher.sleep = record_sleep

        with patch('zet.fetcher.fetcher.fetch_url', return_value=b'data'):
            fetcher.run()

        return delays

    def test_retry_after_replaces_regular_delay_and_recovers(self) -> None:
        for header, expected in [('8', 9), ('60', 30), ('0', MIN_UNCHANGED_DELAY),
                                 ('invalid', 18), ('-1', 18), (None, 18)]:
            with self.subTest(header=header):
                fetcher = Fetcher.__new__(Fetcher)
                fetcher.realtime_url = 'https://example.invalid/realtime'
                fetcher.static_url = 'https://example.invalid/static'
                fetcher.realtime_dt = 10
                fetcher.running = True
                fetcher._http_cache = {}
                fetcher.store_realtime_snapshot = Mock(return_value=True)
                fetcher.maybe_fetch_static = Mock(return_value=False)
                fetcher.close = Mock()
                delays = []

                def record_sleep(delay: float) -> None:
                    delays.append(delay)
                    if len(delays) == 3:
                        fetcher.running = False

                fetcher.sleep = record_sleep
                headers = {} if header is None else {'Retry-After': header}
                error = HTTPError(fetcher.realtime_url, 429,
                                  'Too Many Requests', headers, None)
                with patch('zet.fetcher.fetcher.fetch_url',
                           side_effect=[b'data', error, b'new data']):
                    fetcher.run()

                self.assertEqual(delays, [9, expected, 9])
                self.assertEqual(fetcher.store_realtime_snapshot.call_count, 2)
                fetcher.close.assert_called_once_with()

    def test_failures_after_static_download_have_nonzero_backoff(self) -> None:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/realtime'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.store_realtime_snapshot = Mock(return_value=True)
        fetcher.maybe_fetch_static = Mock(return_value=True)
        fetcher.close = Mock()
        delays = []

        def record_sleep(delay: float) -> None:
            delays.append(delay)
            if len(delays) == 4:
                fetcher.running = False

        fetcher.sleep = record_sleep
        with patch('zet.fetcher.fetcher.fetch_url', side_effect=[
                b'data', OSError('offline'), OSError('offline'), b'recovered']):
            fetcher.maybe_fetch_static.side_effect = [True, False]
            fetcher.run()

        self.assertEqual(delays, [0, MIN_UNCHANGED_DELAY,
                                  2 * MIN_UNCHANGED_DELAY, 9])

    def test_failed_static_fetch_preserves_delay_and_is_not_retried_immediately(self) -> None:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.static_dt = 3600
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher._last_static_fetch = None
        fetcher.store_static_snapshot = Mock()
        with patch('zet.fetcher.fetcher.fetch_url',
                   side_effect=OSError('offline')) as fetch:
            self.assertFalse(fetcher.maybe_fetch_static())
            self.assertFalse(fetcher.maybe_fetch_static())
        fetch.assert_called_once_with(fetcher.static_url, cache=fetcher._http_cache)
        fetcher.store_static_snapshot.assert_not_called()

    def test_retry_after_http_date(self) -> None:
        with patch('zet.fetcher.fetcher.time.time', return_value=1794518094):
            self.assertEqual(retry_after_delay('Thu, 12 Nov 2026 21:15:02 GMT'), 9)
            self.assertEqual(retry_after_delay('Thu, 12 Nov 2026 21:16:00 GMT'), 30)
            self.assertEqual(retry_after_delay('Thu, 12 Nov 2026 21:14:00 GMT'),
                             MIN_UNCHANGED_DELAY)

    def test_ctrl_c_only_requests_shutdown(self) -> None:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.close = Mock()

        fetcher.handle_sigint(None, None)

        self.assertFalse(fetcher.running)
        fetcher.close.assert_not_called()

    def test_fetch_result_is_not_processed_after_ctrl_c(self) -> None:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/realtime'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.store_realtime_snapshot = Mock()
        fetcher.maybe_fetch_static = Mock()
        fetcher.sleep = Mock()
        fetcher.close = Mock()

        def interrupt_during_fetch(url: str, **kwargs) -> bytes:
            fetcher.running = False
            return b'data'

        with patch(
                'zet.fetcher.fetcher.fetch_url',
                side_effect=interrupt_during_fetch):
            fetcher.run()

        fetcher.store_realtime_snapshot.assert_not_called()
        fetcher.maybe_fetch_static.assert_not_called()
        fetcher.sleep.assert_not_called()
        fetcher.close.assert_called_once_with()

    def test_static_fetch_is_not_started_after_ctrl_c(self) -> None:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/realtime'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
        fetcher._http_cache = {}
        fetcher.maybe_fetch_static = Mock()
        fetcher.sleep = Mock()
        fetcher.close = Mock()

        def interrupt_while_storing(data: bytes) -> bool:
            fetcher.running = False
            return True

        fetcher.store_realtime_snapshot = Mock(
            side_effect=interrupt_while_storing)

        with patch('zet.fetcher.fetcher.fetch_url', return_value=b'data'):
            fetcher.run()

        fetcher.maybe_fetch_static.assert_not_called()
        fetcher.sleep.assert_not_called()
        fetcher.close.assert_called_once_with()

    def test_unchanged_snapshot_delay_grows_gradually(self) -> None:
        delays = self.run_fetcher([False, False, False])

        for i, delay in enumerate(delays):
            self.assertAlmostEqual(delay, MIN_UNCHANGED_DELAY * 1.01**i)

    def test_new_snapshot_resets_unchanged_delay(self) -> None:
        delays = self.run_fetcher([False, False, True, False])

        self.assertEqual(delays, [MIN_UNCHANGED_DELAY,
                                  MIN_UNCHANGED_DELAY * 1.01, 9,
                                  MIN_UNCHANGED_DELAY])

    def test_unchanged_snapshot_delay_is_capped_at_maximum(self) -> None:
        delays = self.run_fetcher([False] * 250)

        self.assertEqual(delays[-1], 10)
        self.assertTrue(all(delay <= 10 for delay in delays))


if __name__ == '__main__':
    unittest.main()
