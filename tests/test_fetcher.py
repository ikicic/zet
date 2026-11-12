import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from zet.fetcher.fetcher import Fetcher, MIN_UNCHANGED_DELAY, retry_after_delay


class FetcherPollingTest(unittest.TestCase):
    def run_fetcher(self, snapshot_results: list[bool]) -> list[float]:
        fetcher = Fetcher.__new__(Fetcher)
        fetcher.realtime_url = 'https://example.invalid/realtime'
        fetcher.static_url = 'https://example.invalid/static'
        fetcher.realtime_dt = 10
        fetcher.running = True
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
        fetcher._last_static_fetch = None
        fetcher.store_static_snapshot = Mock()
        with patch('zet.fetcher.fetcher.fetch_url',
                   side_effect=OSError('offline')) as fetch:
            self.assertFalse(fetcher.maybe_fetch_static())
            self.assertFalse(fetcher.maybe_fetch_static())
        fetch.assert_called_once_with(fetcher.static_url)
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
        fetcher.store_realtime_snapshot = Mock()
        fetcher.maybe_fetch_static = Mock()
        fetcher.sleep = Mock()
        fetcher.close = Mock()

        def interrupt_during_fetch(url: str) -> bytes:
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
