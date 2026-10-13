// Runs in the browser from make test, checking identity and selection.
module.exports = async function vehicleDetailsTests() {
  const { findSelectedVehicle, decompressRealTimeState } =
    window.vehicleDetailsModules;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const payload = {
    vehicles: {
      routeIds: [2, 2],
      shapeIds: ["shape", "shape"],
      vehicleIds: ["102202", "00395"],
      tripIds: ["trip-a", "trip-b"],
      blockIds: ["206", "006"],
      timestamps: [0, 0],
      compressedLats: [[0], [100]],
      compressedLons: [[0], [100]],
      directionDegrees: [null, null],
    },
    timestamp: 1,
    activeStaticKey: "test",
  };
  const fleet = decompressRealTimeState(payload).vehicles;
  check(
    fleet[0].vehicleId === "102202" && fleet[0].blockId === "206",
    "Full identifiers lost during decoding",
  );
  check(
    fleet[1].vehicleId === "00395" && fleet[1].blockId === "006",
    "Leading zeros lost during decoding",
  );
  const updated = {
    ...fleet[0],
    tripId: "next-trip",
    blockId: "207",
    lon: [15.99],
  };
  check(
    findSelectedVehicle([fleet[1], updated], fleet[0]) === updated,
    "Selection did not survive reordered vehicles and a change of trip",
  );
  check(
    findSelectedVehicle([fleet[1]], fleet[0]) === null,
    "Selection jumped to another vehicle on the same route",
  );
  const anonymous = { ...fleet[0], vehicleId: null };
  const anonymousUpdate = { ...anonymous, blockId: "208" };
  check(
    findSelectedVehicle([anonymousUpdate], anonymous) === anonymousUpdate,
    "Missing vehicle identifier prevented tracking by trip",
  );
  const stale = { ...fleet[0], timestamp: 10 };
  check(
    findSelectedVehicle([stale, updated], fleet[0]) === updated,
    "Older trip displaced the current vehicle position",
  );
  const missingDetails = decompressRealTimeState({
    ...payload,
    vehicles: {
      ...payload.vehicles,
      vehicleIds: [null, null],
      blockIds: [null, null],
    },
  }).vehicles[0];
  check(
    missingDetails.vehicleId === null &&
      missingDetails.blockId === null &&
      missingDetails.tripId === "trip-a",
    "Unavailable feed identifiers were not preserved",
  );

  const passed = [
    "Vehicle identifiers preserve full values, null entries and selection across updates",
  ];
  return passed;
};
