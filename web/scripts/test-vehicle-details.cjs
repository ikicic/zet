// Runs in the browser from make test, checking identity and selection.
module.exports = async function vehicleDetailsTests() {
  const {
    findSelectedVehicle,
    decompressRealTimeState,
    VehicleDelayTooltip,
    formatDuration,
    getFeedAge,
    getEffectiveVehicleDelay,
  } = window.vehicleDetailsModules;
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
  const stale = { ...fleet[0], timestamp: fleet[0].timestamp - 10 };
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

  check(
    formatDuration(0) === "0 s" &&
      formatDuration(90061) === "1 d 1 h 1 min 1 s",
    "Duration formatting lost zero or multi-day values",
  );
  check(
    getFeedAge(100, 400) === 300 && getFeedAge(500, 400) === 0,
    "Feed age is wrong or negative for a future timestamp",
  );
  check(
    getEffectiveVehicleDelay({ ...fleet[0], reportDelay: 550 }, 300) === 850,
    "Effective delay did not add independent report and feed delays",
  );
  const container = document.createElement("div");
  container.style.cssText = "width: 300px; height: 300px";
  document.body.appendChild(container);
  const map = new window.maplibregl.Map({
    container,
    style: { version: 8, sources: {}, layers: [] },
    center: [15.98, 45.815],
    zoom: 12,
    attributionControl: false,
  });
  const tooltip = new VehicleDelayTooltip(map);
  try {
    for (const reportDelay of [null, 0, 8, 75]) {
      tooltip.setVehicle({ ...fleet[0], reportDelay });
      check(
        !container.querySelector(".vehicle-delay-tooltip"),
        "Tooltip appeared before marker fading starts",
      );
    }
    const invalidVehicle = decompressRealTimeState({
      ...payload,
      vehicles: { ...payload.vehicles, timestamps: [-86400, 0] },
    }).vehicles[0];
    tooltip.setVehicle(invalidVehicle);
    check(
      container
        .querySelector(".vehicle-delay-tooltip")
        .textContent.includes("Neispravno vrijeme podataka"),
      "Invalid time did not show an explanation instead of a fabricated delay",
    );
    const content = container.querySelector(
      ".vehicle-delay-tooltip .maplibregl-popup-content",
    );
    check(
      getComputedStyle(content).pointerEvents === "none",
      "Tooltip content intercepts map interaction",
    );
    tooltip.setVehicle(fleet[0]);
    check(
      !container.querySelector(".vehicle-delay-tooltip"),
      "Valid report did not clear invalid-time tooltip",
    );
    tooltip.setVehicle({ ...fleet[0], reportDelay: 60 }, 15.1);
    check(
      container.querySelectorAll(".vehicle-delay-tooltip").length === 1,
      "Tooltip did not appear when combined delay crossed the fade threshold",
    );
    tooltip.setVehicle({ ...fleet[0], reportDelay: 60 }, 15);
    check(
      !container.querySelector(".vehicle-delay-tooltip"),
      "Tooltip remained at the unfaded boundary",
    );
    tooltip.setVehicle({ ...fleet[0], reportDelay: 550 });
    check(
      container
        .querySelector(".vehicle-delay-tooltip")
        .textContent.includes("9 min 10 s"),
      "Measured delay tooltip missing",
    );
    tooltip.setVehicle({ ...updated, reportDelay: 5 }, 300);
    check(
      container
        .querySelector(".vehicle-delay-tooltip")
        .textContent.includes("5 min 5 s"),
      "Tooltip did not add feed delay",
    );
    tooltip.setVehicle({ ...updated, reportDelay: null }, 300);
    check(
      container
        .querySelector(".vehicle-delay-tooltip")
        .textContent.includes("najmanje 5 min"),
      "Unknown vehicle delay concealed a stale feed",
    );
    tooltip.setVehicle({ ...updated, reportDelay: 5 });
    check(
      !container.querySelector(".vehicle-delay-tooltip"),
      "Tooltip remained after delay recovered below the fade threshold",
    );
    tooltip.setVehicle({ ...updated, reportDelay: 80 });
    check(
      container.querySelectorAll(".vehicle-delay-tooltip").length === 1,
      "Tooltip did not reappear during a later delay",
    );
    tooltip.setVehicle(null);
    check(
      !container.querySelector(".vehicle-delay-tooltip"),
      "Deselection left a tooltip behind",
    );
    tooltip.setVehicle({ ...fleet[0], reportDelay: 0 });
    tooltip.setVehicle({ ...fleet[0], reportDelay: null });
    check(
      !container.querySelector(".vehicle-delay-tooltip"),
      "Fresh or unknown report delay displayed a tooltip",
    );
  } finally {
    tooltip.setVehicle(null);
    map.remove();
    container.remove();
  }

  const passed = [
    "Vehicle identifiers preserve full values, null entries and selection across updates",
  ];
  return passed;
};
