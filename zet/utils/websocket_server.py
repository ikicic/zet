import asyncio
import logging
import threading
from collections import OrderedDict

import websockets

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Data = str | bytes

class WebSocketServer:
    def __init__(self, port: int, kinds_order: list[str]):
        self.ws_port: int = port
        self.ws_server: websockets.Server | None = None
        self.clients: set[websockets.ServerConnection] = set()
        self.clients_lock = threading.Lock()

        self.data_lock = threading.Lock()
        self.data: OrderedDict[str, list[Data]] = OrderedDict(
            {kind: [] for kind in kinds_order})
        self.loop = None  # Store the event loop reference
        self.loop_lock = threading.Lock()
        self.loop_ready = threading.Event()
        self.stop_requested = threading.Event()

        # Start WebSocket server in a separate thread
        self.ws_thread = threading.Thread(target=self.start_ws_server, daemon=True)
        self.ws_thread.start()

    def start_ws_server(self):
        """Start the WebSocket server in the current thread."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self.loop_lock:
            self.loop = loop

        async def run_server_coroutine():
            # Serve only to localhost.
            self.ws_server = await websockets.serve(
                self._handle_client, 'localhost', self.ws_port,
                close_timeout=2)
            logger.info(f"WebSocket server started on port {self.ws_port}")
            self.loop_ready.set()

            try:
                while not self.stop_requested.is_set():
                    await asyncio.sleep(0.1)
            finally:
                self.ws_server.close()
                await self.ws_server.wait_closed()

        try:
            loop.run_until_complete(run_server_coroutine())
        finally:
            self.loop_ready.set()
            self.ws_server = None
            with self.loop_lock:
                self.loop = None
                pending_tasks = asyncio.all_tasks(loop)
                for task in pending_tasks:
                    task.cancel()
                if pending_tasks:
                    loop.run_until_complete(asyncio.gather(
                        *pending_tasks, return_exceptions=True))
                loop.close()

    def close(self):
        """Close the WebSocket server."""
        logger.info("Closing WebSocket server...")
        self.stop_requested.set()

        if self.ws_thread.is_alive():
            self.ws_thread.join(timeout=5)
            if self.ws_thread.is_alive():
                logger.warning("Timed out stopping WebSocket server thread")

    def update_data(self, key: str, data: Data, max_history: int):
        """Update the current data in a thread-safe manner.

        The key must be one of the keys in kinds_order.
        """
        with self.data_lock:
            if key not in self.data:
                raise ValueError(f"Key {key} not in data")
            self.data[key].append(data)
            if len(self.data[key]) > max_history:
                self.data[key].pop(0)

        self._notify_clients(key)

    async def _handle_client(
            self, websocket: websockets.ServerConnection):
        """Handle a client connection."""
        try:
            logger.info(f"Client connected. "
                        f"Total clients: {len(self.clients) + 1}")

            with self.data_lock:
                for data in self.data.values():
                    # Send all messages, in the order given in kinds_order,
                    # then in the order they were added.
                    for message in data:
                        await self._send_message_to_client(websocket, message)

            with self.clients_lock:
                self.clients.add(websocket)

            async for message in websocket:
                pass

        except websockets.exceptions.ConnectionClosed:
            logger.info("Client disconnected")
        finally:
            with self.clients_lock:
                self.clients.remove(websocket)
            logger.info(f"Client removed. Total clients: {len(self.clients)}")

    async def _send_message_to_client(
            self,
            websocket: websockets.ServerConnection,
            message: Data):
        """Send a message to a specific client."""
        try:
            await websocket.send(message)
        except Exception as e:
            logger.error(f"Error sending message to client: {e}")

    def _notify_clients(self, key: str):
        """Notify all connected clients about a new snapshot."""
        with self.clients_lock:
            if not self.clients:
                return

        with self.data_lock:
            if key not in self.data:
                return
            data = self.data[key]
            if not data:
                return
            data = data[-1]

        with self.loop_lock:
            loop = self.loop
            if self.stop_requested.is_set():
                return
            if loop is None or not loop.is_running():
                logger.warning(
                    f"Event loop not running, dropping notification for key: {key}")
                return

            notification = self._notify_all_clients_async(data)
            try:
                asyncio.run_coroutine_threadsafe(notification, loop)
            except RuntimeError as e:
                # Avoid leaking the coroutine if submission is rejected.
                notification.close()
                logger.warning(
                    f"Failed to submit notification for key {key}: {e}")

    async def _notify_all_clients_async(self, data: Data):
        """Async method to notify all clients."""
        with self.clients_lock:
            clients = list(self.clients)

        if not clients:
            return

        message = data
        tasks = [self._send_message_to_client(client, message)
                 for client in clients]
        await asyncio.gather(*tasks, return_exceptions=True)
