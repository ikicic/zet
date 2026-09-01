const http = require("http");
const { WebSocketServer } = require("ws");

const HOST = "127.0.0.1";
const PORT = 5000;
const INTERVAL_MS = Number(process.env.STRESS_INTERVAL_MS ?? 2000);
const MAX_VEHICLES = Number(process.env.STRESS_MAX_VEHICLES ?? 220);
const FIRST_ROUTE_ID = 300;

let vehicleCount = 0;
let timestamp = Math.floor(Date.now() / 1000);
const clients = new Set();

function makeState(count) {
  const routeIds = [];
  const shapeIds = [];
  const timestamps = [];
  const compressedLats = [];
  const compressedLons = [];
  const directionDegrees = [];

  for (let i = 0; i < count; i++) {
    routeIds.push(FIRST_ROUTE_ID + i);
    shapeIds.push("");
    timestamps.push(0);

    const row = Math.floor(i / 10);
    const col = i % 10;
    const lat = 45.785 + row * 0.003;
    const lon = 15.958 + col * 0.005;
    compressedLats.push([Math.round((lat - 45.815) * 1e6)]);
    compressedLons.push([Math.round((lon - 15.9819) * 1e6)]);
    directionDegrees.push((i * 24) % 360);
  }

  return JSON.stringify({
    vehicles: {
      routeIds,
      shapeIds,
      timestamps,
      compressedLats,
      compressedLons,
      directionDegrees,
    },
    timestamp,
    activeStaticKey: null,
  });
}

function broadcastState() {
  const message = makeState(vehicleCount);
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

const server = http.createServer((_request, response) => {
  response.writeHead(204);
  response.end();
});
const webSockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws-v4") {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket);
  });
});

webSockets.on("connection", (webSocket) => {
  clients.add(webSocket);
  webSocket.send(makeState(vehicleCount));
  webSocket.on("close", () => clients.delete(webSocket));
});

setInterval(() => {
  if (clients.size === 0 || vehicleCount >= MAX_VEHICLES) return;
  vehicleCount++;
  timestamp++;
  broadcastState();
  console.log(`Added route ${FIRST_ROUTE_ID + vehicleCount - 1}`);
}, INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log(
    `Stress server on ws://${HOST}:${PORT}/ws-v4; ` +
      `adding a route every ${INTERVAL_MS} ms`,
  );
});
