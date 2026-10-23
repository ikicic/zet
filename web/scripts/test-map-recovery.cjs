module.exports = async function recoveryTests() {
  const { load, React, createRoot } = window.recoveryModules;
  const { act, createElement } = React;
  const { formatMapFailureMessage } = load("./MapFailureMessage");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const parseReport = (message) =>
    JSON.parse(
      message.slice(
        message.indexOf("Tehnički podaci:\n") + "Tehnički podaci:\n".length,
      ),
    );
  const probe = (render) => ({
    contextCreated: true,
    render,
    requestedAttributes: {},
    creationErrors: [],
  });
  const normal = {
    error: {
      name: "Error",
      message: { message: "shader failed", statusMessage: "driver error" },
    },
    diagnostics: {
      failureStage: "map-layers",
      webgl1: { map: probe("passed") },
      webgl2: { map: probe("failed") },
      environment: { userAgent: "test" },
      maplibreVersion: "test",
      frontendBundle: "bundle.test.js",
    },
  };
  check(
    JSON.stringify(parseReport(formatMapFailureMessage(normal))) ===
      JSON.stringify(normal),
    "Small report was changed",
  );
  const hugeText = '"\\\n😀'.repeat(20000);
  let nested = { message: "deep failure" };
  for (let i = 0; i < 12000; i++) nested = { child: nested };
  for (const message of [
    hugeText,
    { message: "shader failed", details: hugeText },
    nested,
    Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        "detail" + i,
        hugeText.slice(0, 200),
      ]),
    ),
  ]) {
    const failure = {
      ...normal,
      error: { name: "Error", message, stack: [hugeText] },
      diagnostics: {
        ...normal.diagnostics,
        environment: { userAgent: hugeText },
        webgl2: {
          map: {
            ...probe("failed"),
            error: { name: "Error", message },
            details: { large: message },
          },
          relaxed: {
            ...probe("not-run"),
            contextCreated: false,
            creationErrors: [hugeText],
          },
        },
      },
    };
    const text = formatMapFailureMessage(failure);
    check(
      text.length <= 19000 && (text + "x".repeat(1000)).length <= 20000,
      "Report did not leave 1000 characters for the user",
    );
    const report = parseReport(text);
    check(
      report.truncated && report.error.name === "Error",
      "Missing truncation marker or original error",
    );
    check(
      report.diagnostics.webgl1.map.render === "passed" &&
        report.diagnostics.webgl2.map.render === "failed" &&
        report.diagnostics.webgl2.relaxed.contextCreated === false,
      "Probe outcomes were lost",
    );
    if (message.message === "shader failed")
      check(
        report.error.message.message === "shader failed",
        "Structured original failure was lost",
      );
  }
  passed.push(
    "Oversized/deep/escaped diagnostic reports stay valid JSON under 19000 characters and retain probe outcomes",
  );

  const original = {
    Map: window.maplibregl.Map,
    WebSocket: window.WebSocket,
    fetch: window.fetch,
    random: Math.random,
  };
  const vehicleModule = load("./VehicleLayer");
  const originalVehicleLayer = vehicleModule.VehicleLayer;
  const marker = load("./WebGLMarkerRenderer").WebGLMarkerRenderer;
  const originalOnAdd = marker.prototype.onAdd;
  const meta = document.createElement("meta");
  meta.name = "app-version";
  meta.content = "a".repeat(20);
  document.head.append(meta);
  const container = document.createElement("div");
  container.style.cssText = "width:500px;height:400px";
  document.body.append(container);
  let root,
    socket,
    layer,
    callbacks,
    map,
    pageFetches = 0;
  const sockets = [];
  const staticData = {
    shapes: {
      ids: ["a", "b"],
      compressedLats: [
        [0, 100],
        [100, 100],
      ],
      compressedLons: [
        [0, 100],
        [100, 100],
      ],
      stopIndexDeltas: [[0], [0]],
    },
    stops: { latDeltas: [0], lonDeltas: [0] },
  };
  window.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      sockets.push(this);
      socket = this;
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || [])
        fn({ data: JSON.stringify(data) });
    }
    close() {
      this.emit("close");
    }
  };
  window.fetch = async (url, options = {}) => {
    if (options.cache === "reload") {
      pageFetches++;
      // Keep the test in this document while verifying an attempted recovery.
      return {
        ok: true,
        text: async () =>
          '<meta name="app-version" content="not-yet-deployed">',
      };
    }
    const data = String(url).includes("/big/")
      ? staticData
      : { routes: { ids: [2, 3] } };
    return {
      ok: true,
      json: async () => data,
      text: async () => JSON.stringify(data),
    };
  };
  Math.random = () => 0.05;
  const component = load("./Map").Map;
  const waitFor = async (condition, description) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out: " + description);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  };
  const mount = async () => {
    root = createRoot(container);
    await act(async () => root.render(createElement(component)));
  };
  const unmount = async () => {
    if (root) {
      await act(async () => root.unmount());
      root = null;
    }
  };
  const realMap = () => {
    window.maplibregl.Map = class extends original.Map {
      constructor(options) {
        super({ ...options, style: { version: 8, sources: {}, layers: [] } });
        map = this;
      }
    };
  };
  try {
    for (const failureStage of ["map-constructor", "map-layers"]) {
      if (failureStage === "map-constructor")
        window.maplibregl.Map = class {
          constructor() {
            throw new Error("Injected constructor failure");
          }
        };
      else {
        realMap();
        marker.prototype.onAdd = () => {
          throw new Error("Injected renderer failure");
        };
      }
      await mount();
      await waitFor(
        () => container.querySelector("textarea"),
        "failure feedback",
      );
      const report = parseReport(container.querySelector("textarea").value);
      check(
        report.diagnostics.failureStage === failureStage,
        "Failure stage was misreported",
      );
      check(
        report.error.message.includes("Injected"),
        "Original initialization failure was lost",
      );
      check(
        !container.querySelector("button.feedback-submit").disabled,
        "Generated report cannot be submitted",
      );
      check(
        new URL(socket.url).searchParams.get("appUpdates") === "1",
        "Map failure prevented the update connection",
      );
      const before = pageFetches;
      await act(async () =>
        socket.emit("message", {
          type: "app-version",
          version: "b".repeat(20),
        }),
      );
      check(
        pageFetches === before + 1,
        "Untouched failure feedback prevented update recovery",
      );
      await unmount();
      marker.prototype.onAdd = originalOnAdd;
    }
    passed.push(
      "Constructor and custom-renderer failures show submittable diagnostics and still receive startup updates",
    );

    realMap();
    vehicleModule.VehicleLayer = class extends originalVehicleLayer {
      constructor(map, options) {
        super(map, options);
        layer = this;
        callbacks = options;
      }
    };
    await mount();
    await act(async () =>
      socket.emit("message", { type: "app-version", version: meta.content }),
    );
    await waitFor(() => layer, "vehicle layer");
    const feed = (present, trip = "first", route = 2, shape = "a") => ({
      timestamp: Date.now() / 1000,
      activeStaticKey: "recovery-test",
      vehicles: {
        vehicleIds: present ? ["102202"] : [],
        tripIds: present ? [trip] : [],
        blockIds: present ? ["206"] : [],
        routeIds: present ? [route] : [],
        shapeIds: present ? [shape] : [],
        timestamps: present ? [0] : [],
        compressedLats: present ? [[0]] : [],
        compressedLons: present ? [[0]] : [],
        directionDegrees: present ? [null] : [],
      },
    });
    const pageHeight = document.documentElement.scrollHeight;
    await act(async () =>
      container.querySelector('button[title="Filtar"]').click(),
    );
    check(
      container
        .querySelector(".overlay")
        .textContent.includes("Podaci o linijama još nisu dostupni."),
      "Filter without feed data did not show its unavailable message in a dialog",
    );
    check(
      getComputedStyle(container.querySelector(".overlay")).position ===
        "fixed" && document.documentElement.scrollHeight === pageHeight,
      "Opening the filter without feed data added page overflow",
    );
    await act(async () =>
      container.querySelector(".overlay-close-button").click(),
    );
    check(
      !container.querySelector(".overlay"),
      "Unavailable filter dialog could not close",
    );
    await act(async () =>
      container.querySelector('button[title="Filtar"]').click(),
    );
    await act(async () => socket.emit("message", feed(true)));
    await waitFor(
      () => container.querySelectorAll(".filter-checkbox").length === 2,
      "filter routes arriving while the dialog is open",
    );
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    check(
      !container.querySelector(".overlay"),
      "Loaded filter dialog could not close with Escape",
    );
    await act(async () => callbacks.onVehicleClick(layer.vehicles[0]));
    await waitFor(() => layer.selectedShape?.id === "a", "selected shape");
    check(
      layer.selectedVehicle === layer.vehicles[0],
      "Clicked vehicle was not passed to the renderer",
    );
    await act(async () => socket.emit("message", feed(false)));
    check(
      layer.selectedVehicle === null,
      "Feed gap retained a stale selected marker",
    );
    check(layer.highlightedRouteId === 2, "Feed gap lost route highlight");
    check(
      !container.querySelector(".filter-ctrl .no-markers"),
      "Empty feed incorrectly triggered the filter warning",
    );
    await act(async () => socket.emit("message", feed(true, "second", 3, "b")));
    await waitFor(
      () => layer.selectedShape?.id === "b",
      "returned vehicle shape",
    );
    check(
      layer.highlightedRouteId === 3 &&
        layer.selectedVehicle === layer.vehicles[0],
      "Selection did not recover across gap and route/trip change",
    );
    await act(async () => socket.emit("message", feed(false)));
    await act(async () => callbacks.onNothingClick());
    await act(async () => socket.emit("message", feed(true)));
    check(
      layer.highlightedRouteId === null && layer.selectedVehicle === null,
      "Explicit deselection was forgotten",
    );
    // The map must age without receiving another WebSocket message.
    const now = Date.now;
    const outageStart = now();
    try {
      Date.now = () => outageStart;
      const healthyFeed = feed(true);
      healthyFeed.vehicles.reportDelays = [8];
      await act(async () => socket.emit("message", healthyFeed));
      await act(async () => callbacks.onVehicleClick(layer.vehicles[0]));
      check(layer.feedAge === 0, "Healthy feed already aged");
      Date.now = () => outageStart + 120000;
      await act(
        async () => new Promise((resolve) => setTimeout(resolve, 5100)),
      );
      check(
        layer.feedAge === 90,
        "No-message outage did not age marker colors through the timer",
      );
      check(
        container
          .querySelector(".vehicle-delay-tooltip")
          .textContent.includes("2 min 8 s"),
        "Tooltip did not age alongside marker colors without messages",
      );
      const recoveredFeed = feed(true);
      recoveredFeed.vehicles.reportDelays = [8];
      await act(async () => socket.emit("message", recoveredFeed));
      check(
        layer.feedAge === 0 &&
          !container.querySelector(".vehicle-delay-tooltip"),
        "Fresh feed did not recover marker colors and tooltip",
      );
    } finally {
      Date.now = now;
    }
    passed.push(
      "Vehicle colors and delay tooltip age without messages and recover with a fresh feed",
    );
    // Ordinary MapLibre errors must not replace a working map with diagnostics.
    await act(async () =>
      map.fire("error", { error: new Error("Tile unavailable") }),
    );
    check(
      !container.querySelector(".map-unavailable"),
      "Tile failure triggered the fatal error screen",
    );
    passed.push(
      "Real map selection recovers after a feed gap, follows the new route/shape and respects explicit deselection",
    );
    await unmount();
    return passed;
  } finally {
    await unmount();
    window.maplibregl.Map = original.Map;
    window.WebSocket = original.WebSocket;
    window.fetch = original.fetch;
    Math.random = original.random;
    marker.prototype.onAdd = originalOnAdd;
    vehicleModule.VehicleLayer = originalVehicleLayer;
    meta.remove();
    container.remove();
  }
};
