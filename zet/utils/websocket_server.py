import asyncio
import logging
import threading

import websockets

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Data = str | bytes

class WebSocketServer:
    def __init__(self, port: int):
        self.ws_port: int = port
        self.ws_server: websockets.Server | None = None
        self.clients: set[websockets.ServerConnection] = set()
        self.clients_lock = threading.Lock()

        # Start WebSocket server in a separate thread
        self.ws_thread = threading.Thread(target=self.start_ws_server, daemon=True)
        self.ws_thread.start()

        self.data_lock = threading.Lock()
        self.current_data: Data | None = None
        self.loop = None  # Store the event loop reference

    # WebSocket server methods
    def start_ws_server(self):
        """Start the WebSocket server in the current thread."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self.loop = loop  # Save the loop reference for later use

        async def start_server_coroutine():
            # Serve only to localhost.
            self.ws_server = await websockets.serve(
                self._handle_client, 'localhost', self.ws_port)
            logger.info(f"WebSocket server started on port {self.ws_port}")

        loop.run_until_complete(start_server_coroutine())
        loop.run_forever()

    def close(self):
        """Close the WebSocket server."""
        logger.info("Closing WebSocket server...")
        if self.ws_server:
            self.ws_server.close()
            self.ws_server = None

        if self.ws_thread.is_alive():
            self.ws_thread.join(timeout=5)

    def update_data(self, data: Data):
        """Update the current data in a thread-safe manner."""
        with self.data_lock:
            self.current_data = data

        self._notify_clients()

    async def _handle_client(
            self, websocket: websockets.ServerConnection):
        """Handle a client connection."""
        try:
            with self.clients_lock:
                self.clients.add(websocket)
            logger.info(f"Client connected. Total clients: {len(self.clients)}")

            with self.data_lock:
                if self.current_data:
                    await self._send_message_to_client(websocket, self.current_data)

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

    def _notify_clients(self):
        """Notify all connected clients about a new snapshot."""
        with self.clients_lock:
            if not self.clients:
                return

        with self.data_lock:
            if not self.current_data:
                return
            data = self.current_data

        # Use the stored event loop reference instead of trying to get the
        # current one
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._notify_all_clients_async(data), self.loop)

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
