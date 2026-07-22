import unittest
from unittest.mock import Mock, patch

from zet.fetcher.fetcher import Fetcher


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

        with patch('zet.fetcher.fetcher.try_fetch_url', return_value=b'data'):
            fetcher.run()

        return delays

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
                'zet.fetcher.fetcher.try_fetch_url',
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

        with patch('zet.fetcher.fetcher.try_fetch_url', return_value=b'data'):
            fetcher.run()

        fetcher.maybe_fetch_static.assert_not_called()
        fetcher.sleep.assert_not_called()
        fetcher.close.assert_called_once_with()

    def test_unchanged_snapshot_delay_grows_gradually(self) -> None:
        delays = self.run_fetcher([False, False, False])

        self.assertEqual(delays, [1.0, 1.01, 1.0201])

    def test_new_snapshot_resets_unchanged_delay(self) -> None:
        delays = self.run_fetcher([False, False, True, False])

        self.assertEqual(delays, [1.0, 1.01, 9, 1.0])

    def test_unchanged_snapshot_delay_is_capped_at_maximum(self) -> None:
        delays = self.run_fetcher([False] * 250)

        self.assertEqual(delays[-1], 10)
        self.assertTrue(all(delay <= 10 for delay in delays))


if __name__ == '__main__':
    unittest.main()
