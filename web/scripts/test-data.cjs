// Exercise the actual TypeScript decoder without a browser or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/Data.tsx"), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
});
const api = {};
new Function("exports", outputText)(api);

const lats = [45.815, 45.81499, 45.81498, 45.815];
const lons = [15.9819, 15.98189, 15.98188, 15.9819];
const deltas = [0, -10, -10, 20];
const decoded = api.decompressBigStaticData({
  shapes: {
    ids: ["route", "empty"],
    compressedLats: [deltas, []],
    compressedLons: [deltas, []],
  },
});
const realtime = api.decompressRealTimeState({
  vehicles: {
    routeIds: [6],
    shapeIds: ["route"],
    timestamps: [0],
    compressedLats: [deltas],
    compressedLons: [deltas],
    directionDegrees: [0],
  },
  timestamp: 1,
  activeStaticKey: "test",
});
function near(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-12));
}
near(decoded.shapes.route.lats, lats);
near(decoded.shapes.route.lons, lons);
near(realtime.vehicles[0].lat, lats);
near(realtime.vehicles[0].lon, lons);
assert.deepEqual(decoded.shapes.empty.lats, []);
console.log("Shape and vehicle delta decoding passed.");
