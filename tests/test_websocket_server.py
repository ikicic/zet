import asyncio
import threading
import unittest
from unittest.mock import patch

from zet.utils.websocket_server import WebSocketServer


class FakeWebSocketServer:
    def __init__(self) -> None:
        self.closed = False
        self.waited_until_closed = False

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        self.waited_until_closed = True


class FakeClient:
    async def send(self, message: str | bytes) -> None:
        pass


class WebSocketServerShutdownTest(unittest.TestCase):
    def test_close_stops_server_thread(self) -> None:
        fake_server = FakeWebSocketServer()

        async def serve(*args, **kwargs):
            return fake_server

        with patch('zet.utils.websocket_server.websockets.serve', side_effect=serve):
            server = WebSocketServer(0, kinds_order=['test'])
            self.assertTrue(server.loop_ready.wait(timeout=2))

            server.close()

        self.assertFalse(server.ws_thread.is_alive())
        self.assertIsNone(server.loop)
        self.assertTrue(fake_server.closed)
        self.assertTrue(fake_server.waited_until_closed)

    def test_update_racing_with_close_does_not_submit_to_closed_loop(self) -> None:
        fake_server = FakeWebSocketServer()

        async def serve(*args, **kwargs):
            return fake_server

        submission_started = threading.Event()
        allow_submission = threading.Event()
        original_submit = asyncio.run_coroutine_threadsafe

        def blocking_submit(coroutine, loop):
            submission_started.set()
            allow_submission.wait(timeout=2)
            return original_submit(coroutine, loop)

        errors = []
        with patch('zet.utils.websocket_server.websockets.serve', side_effect=serve), \
                patch(
                    'zet.utils.websocket_server.asyncio.run_coroutine_threadsafe',
                    side_effect=blocking_submit):
            server = WebSocketServer(0, kinds_order=['test'])
            self.assertTrue(server.loop_ready.wait(timeout=2))
            with server.clients_lock:
                server.clients.add(FakeClient())

            def update() -> None:
                try:
                    server.update_data('test', 'message', max_history=1)
                except Exception as e:
                    errors.append(e)

            update_thread = threading.Thread(target=update)
            update_thread.start()
            self.assertTrue(submission_started.wait(timeout=2))

            close_thread = threading.Thread(target=server.close)
            close_thread.start()
            self.assertTrue(server.stop_requested.wait(timeout=2))
            allow_submission.set()

            update_thread.join(timeout=2)
            close_thread.join(timeout=2)

            self.assertFalse(update_thread.is_alive())
            self.assertFalse(close_thread.is_alive())
            self.assertEqual(errors, [])

            # Updates after teardown still update history, but aren't submitted.
            server.update_data('test', 'after close', max_history=1)


if __name__ == '__main__':
    unittest.main()
