// Runs in the browser launched by test-graphics.cjs, using the actual renderers.
module.exports = async function markerTests() {
  const { WebGLMarkerRenderer, MarkerAtlas, VehicleLayer } =
    window.markerModules;
  const passed = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const capture = (gl) => {
    const pixels = new Uint8Array(gl.canvas.width * gl.canvas.height * 4);
    gl.readPixels(
      0,
      0,
      gl.canvas.width,
      gl.canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    check(gl.getError() === gl.NO_ERROR, "Renderer produced a WebGL error");
    return pixels;
  };
  const compare = (actual, expected, message) => {
    let maxDifference = 0;
    for (let i = 0; i < actual.length; i++) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(actual[i] - expected[i]),
      );
    }
    check(
      maxDifference <= 4,
      `${message}: maximum pixel difference ${maxDifference}`,
    );
  };
  function context(type, options = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 160;
    const gl = canvas.getContext(type, {
      antialias: false,
      preserveDrawingBuffer: true,
    });
    check(gl, `${type} context unavailable`);
    const getExtension = gl.getExtension.bind(gl);
    gl.getExtension = (name) => {
      if (
        options.noExtensions &&
        ["ANGLE_instanced_arrays", "OES_vertex_array_object"].includes(name)
      )
        return null;
      return getExtension(name);
    };
    if (options.maxTextureSize) {
      const getParameter = gl.getParameter.bind(gl);
      gl.getParameter = (name) =>
        name === gl.MAX_TEXTURE_SIZE
          ? options.maxTextureSize
          : getParameter(name);
    }
    if (options.noHighp) {
      const getPrecision = gl.getShaderPrecisionFormat.bind(gl);
      gl.getShaderPrecisionFormat = (stage, precision) =>
        stage === gl.FRAGMENT_SHADER && precision === gl.HIGH_FLOAT
          ? { precision: 0, rangeMin: 0, rangeMax: 0 }
          : getPrecision(stage, precision);
    }
    return gl;
  }

  const snapshots = [];
  for (const type of ["webgl2", "webgl"]) {
    const gl = context(type, { noExtensions: true });
    const renderer = new WebGLMarkerRenderer();
    try {
      renderer.onAdd({}, gl);
      const atlas = new MarkerAtlas(512, 1024, 1);
      renderer.setAtlas(atlas);
      let instancedDraws = 0,
        ordinaryDraws = 0,
        uploadedBytes = 0;
      if (type === "webgl2") {
        const draw = gl.drawArraysInstanced.bind(gl);
        gl.drawArraysInstanced = (...args) => {
          instancedDraws++;
          draw(...args);
        };
      }
      const draw = gl.drawArrays.bind(gl);
      gl.drawArrays = (...args) => {
        ordinaryDraws++;
        draw(...args);
      };
      const bufferData = gl.bufferData.bind(gl);
      gl.bufferData = (target, data, usage) => {
        if (usage === gl.DYNAMIC_DRAW) uploadedBytes = data.byteLength;
        bufferData(target, data, usage);
      };
      const drawVehicles = (label) => {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.beginFrame(8);
        for (const [i, angle] of [12, 168, 192, 348].entries()) {
          const highlighted = i >= 2;
          if (i === 2) renderer.finishUnselectedMarkers();
          const x = 45 + (i % 2) * 55,
            y = 45 + Math.floor(i / 2) * 55;
          renderer.addInstance(
            x,
            y,
            atlas.getShape(label.length, angle, highlighted),
            [0.1, 0.3, 0.5, 0.7],
          );
          renderer.addInstance(
            x,
            y,
            atlas.getOrCreateLabel(label),
            [1, 1, 1, 1],
          );
        }
        renderer.render(gl, {});
        return capture(gl);
      };
      const initial = drawVehicles("6");
      check(
        initial.some((value) => value > 100),
        "Vehicles/labels were not drawn",
      );
      check(
        type === "webgl2"
          ? instancedDraws === 2 && ordinaryDraws === 0
          : ordinaryDraws === 2 && instancedDraws === 0,
        "Unexpected drawing path",
      );
      if (type === "webgl2")
        check(
          uploadedBytes === (8 * 14 + 16) * 4,
          "WebGL2 no longer uploads compact instances",
        );
      let subUploads = 0;
      const subImage = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = (...args) => {
        subUploads++;
        subImage(...args);
      };
      const updated = drawVehicles("42");
      check(subUploads === 1, "New label did not use incremental atlas upload");
      check(
        updated.some((value, i) => value !== initial[i]),
        "New label did not change the image",
      );
      snapshots.push({ initial, updated });
      passed.push(
        `${type}: vehicles, labels, mirrors, highlighting and incremental uploads`,
      );
    } finally {
      renderer.onRemove();
      gl.getExtension("WEBGL_lose_context").loseContext();
    }
  }
  compare(
    snapshots[1].initial,
    snapshots[0].initial,
    "WebGL1 differs from WebGL2",
  );
  compare(
    snapshots[1].updated,
    snapshots[0].updated,
    "Incremental WebGL1 upload differs from WebGL2",
  );
  passed.push("WebGL1 pixels match the native WebGL2 renderer");

  const gl = context("webgl", {
    noExtensions: true,
    noHighp: true,
    maxTextureSize: 128,
  });
  const renderer = new WebGLMarkerRenderer();
  try {
    renderer.onAdd({}, gl);
    const atlas = new MarkerAtlas(512, 1024, 1);
    let uploadSize;
    const texImage = gl.texImage2D.bind(gl);
    gl.texImage2D = (...args) => {
      const canvas = args[5];
      uploadSize = [canvas.width, canvas.height];
      texImage(...args);
    };
    renderer.setAtlas(atlas, 2);
    renderer.beginFrame(2);
    renderer.addInstance(
      80,
      80,
      atlas.getShape(1, null, false),
      [0.1, 0.3, 0.5, 1],
    );
    renderer.addInstance(80, 80, atlas.getOrCreateLabel("6"), [1, 1, 1, 1]);
    renderer.finishUnselectedMarkers();
    renderer.render(gl, {});
    check(Math.max(...uploadSize) <= 128, "Atlas exceeds device texture limit");
    check(
      capture(gl).some((value) => value > 100),
      "Mediump fallback failed to render",
    );
    passed.push(
      "WebGL1 works without highp or instancing, with a small texture limit",
    );
  } finally {
    renderer.onRemove();
    gl.getExtension("WEBGL_lose_context").loseContext();
  }

  // Exercise the real VehicleLayer, including CPU hit testing and DPR handling.
  const displayDpr = Object.getOwnPropertyDescriptor(
    window,
    "devicePixelRatio",
  );
  for (const scenario of [
    { name: "full resolution", options: {}, limit: Infinity },
    {
      name: "limited texture size",
      options: { maxTextureSize: 512 },
      limit: 512,
    },
    {
      name: "limited shader precision",
      options: { noHighp: true },
      limit: 1024,
    },
  ]) {
    const gl1 = context("webgl", { noExtensions: true, ...scenario.options });
    let layer;
    try {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: 2,
      });
      const layers = new Map(),
        handlers = new Map();
      const map = {
        getCanvas: () => gl1.canvas,
        getCenter: () => ({ lng: 0, lat: 0 }),
        getZoom: () => 12,
        getBearing: () => 0,
        getPitch: () => 0,
        project: ([x, y]) => ({ x, y }),
        addLayer: (item) => {
          layers.set(item.id, item);
          item.onAdd(map, gl1);
        },
        getLayer: (id) => layers.get(id),
        removeLayer: (id) => {
          layers.get(id).onRemove();
          layers.delete(id);
        },
        on: (event, fn) => handlers.set(event, fn),
        off: (event) => handlers.delete(event),
        triggerRepaint: () => {},
      };
      let clicked;
      layer = new VehicleLayer(map, {
        onVehicleClick: (vehicle) => {
          clicked = vehicle.routeId;
        },
        onNothingClick: () => {
          clicked = null;
        },
      });
      check(
        !layers.has("vehicle-trajectories"),
        "WebGL2-only layer was added to WebGL1",
      );
      if (scenario.limit === Infinity) {
        check(
          layer.atlas.dpr === 2,
          "Capable WebGL1 device lost full display resolution",
        );
      } else {
        check(
          layers.get("vehicle-markers").maximumAtlasSize === scenario.limit,
          "Fallback ignored the texture or shader precision limit",
        );
        check(
          Math.max(layer.atlas.canvas.width, layer.atlas.canvas.height) <=
            scenario.limit,
          "Fallback atlas exceeds its device limit",
        );
        if (scenario.options.maxTextureSize) {
          check(layer.atlas.dpr < 2, "Oversized atlas was not reduced");
        }
      }
      const vehicles = [
        {
          routeId: 6,
          lon: [25],
          lat: [25],
          timestamp: [0],
          directionDegrees: 0,
        },
        {
          routeId: 7,
          lon: [60],
          lat: [60],
          timestamp: [0],
          directionDegrees: 180,
        },
      ];
      const render = () => {
        gl1.clear(gl1.COLOR_BUFFER_BIT);
        layers.get("vehicle-markers").render(gl1, {});
        return capture(gl1);
      };
      layer.setData(vehicles, new Set([7]), null, null);
      render();
      handlers.get("click")({ point: { x: 25, y: 25 } });
      check(clicked === null, "Filtered vehicle remains clickable");
      handlers.get("click")({ point: { x: 60, y: 60 } });
      check(clicked === 7, "Visible vehicle cannot be selected");
      layer.setData(vehicles, new Set([7]), 6, null);
      const pixels = render();
      handlers.get("click")({ point: { x: 25, y: 25 } });
      check(clicked === 6, "Highlighted vehicle not selectable");
      const alphaAt = (x, y) => pixels[((160 - 1 - y) * 160 + x) * 4 + 3];
      check(
        alphaAt(50, 50) > 0 && alphaAt(120, 120) > 0,
        "DPR-scaled marker locations are wrong",
      );
      passed.push(
        `WebGL1 VehicleLayer preserves filtering, selection, highlights and DPR (${scenario.name})`,
      );
    } finally {
      layer?.destroy();
      if (displayDpr)
        Object.defineProperty(window, "devicePixelRatio", displayDpr);
      else delete window.devicePixelRatio;
      gl1.getExtension("WEBGL_lose_context").loseContext();
    }
  }

  const measureText = CanvasRenderingContext2D.prototype.measureText;
  try {
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      return { width: measureText.call(this, text).width };
    };
    const atlas = new MarkerAtlas(512, 1024, 1);
    const label = atlas.getOrCreateLabel("123");
    check(
      [label.x, label.y, label.w, label.h, label.cx, label.cy].every(
        Number.isFinite,
      ),
      "Missing text metrics produced invalid label geometry",
    );
    const pixels = atlas.canvas
      .getContext("2d")
      .getImageData(label.x, label.y, label.w, label.h).data;
    check(
      pixels.some((value, i) => i % 4 === 3 && value > 100),
      "Legacy text metrics produced an empty label",
    );
    passed.push("Labels work without modern Canvas text metrics");
  } finally {
    CanvasRenderingContext2D.prototype.measureText = measureText;
  }

  // Verify automatic fallback and custom-layer state integration in both contexts.
  for (const type of ["webgl2", "webgl"]) {
    const getContext = HTMLCanvasElement.prototype.getContext;
    const container = document.createElement("div");
    container.style.cssText =
      "width:160px;height:160px;position:absolute;top:0";
    document.body.appendChild(container);
    let map, vehicles;
    try {
      HTMLCanvasElement.prototype.getContext = function (contextType, ...args) {
        return contextType === "webgl2" && type === "webgl"
          ? null
          : getContext.call(this, contextType, ...args);
      };
      map = new window.maplibregl.Map({
        container,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#101010" },
            },
          ],
        },
        center: [15.98, 45.81],
        zoom: 12,
        canvasContextAttributes: {
          antialias: false,
          preserveDrawingBuffer: true,
        },
      });
      HTMLCanvasElement.prototype.getContext = getContext;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("MapLibre fallback did not load")),
          5000,
        );
        map.once("load", () => {
          clearTimeout(timeout);
          resolve();
        });
        map.once("error", (event) => {
          clearTimeout(timeout);
          reject(event.error);
        });
      });
      vehicles = new VehicleLayer(map, {
        onVehicleClick() {},
        onNothingClick() {},
      });
      vehicles.setData(
        [
          {
            routeId: 6,
            lon: [15.98],
            lat: [45.81],
            timestamp: [0],
            directionDegrees: 0,
          },
        ],
        new Set(),
        null,
        null,
      );
      await new Promise((resolve) => map.once("render", resolve));
      const context = map.getCanvas().getContext(type);
      check(
        context &&
          Boolean(map.getLayer("vehicle-trajectories")) === (type === "webgl2"),
        `MapLibre did not choose the ${type} layers`,
      );
      const pixels = capture(context);
      check(
        pixels.some((value, index) => index % 4 !== 3 && value > 100),
        "MapLibre fallback vehicle is invisible",
      );
      passed.push(`MapLibre ${type} integration displays vehicles and labels`);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      vehicles?.destroy();
      map?.remove();
      container.remove();
    }
  }
  return passed;
};
