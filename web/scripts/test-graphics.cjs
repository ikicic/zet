// Real WebGL1/2 rendering via Chrome's software GPU, plus injected failure modes.
// CHROME_BIN can select a Chromium installation. No npm browser download needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const ts = require("typescript");
const markerTests = require("./test-markers.cjs");
const selectionTests = require("./test-selection.cjs");
const retryTests = require("./test-async-retries.cjs");
const vehicleDetailsTests = require("./test-vehicle-details.cjs");

const source = fs.readFileSync(
  path.join(__dirname, "../src/GraphicsDiagnostics.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});

async function browserTests() {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const test = (name, run) => {
    run();
    passed.push(name);
  };
  const api = window.diagnostics;
  test("JSON error messages are structured and not repeated in stack frames", () => {
    const details = {
      requestedAttributes: { contextType: "webgl2", stencil: true },
      statusMessage: "disabled by enterprise policy or commandline switch",
      type: "webglcontextcreationerror",
      message: "Failed to initialize WebGL",
    };
    for (const message of [
      JSON.stringify(details),
      JSON.stringify(details, null, 2),
    ]) {
      const error = new Error(message);
      error.stack = `Error: ${message}\n    at Map._setupPainter (map.js:1:2)\n    at new Map (map.js:3:4)`;
      const report = JSON.parse(JSON.stringify(api.describeError(error)));
      check(
        JSON.stringify(report.message) === JSON.stringify(details),
        "JSON details were not preserved as an object",
      );
      check(
        JSON.stringify(report.stack) ===
          JSON.stringify([
            "at Map._setupPainter (map.js:1:2)",
            "at new Map (map.js:3:4)",
          ]),
        "Stack includes duplicate error JSON or lost frames",
      );
    }
  });
  test("Ordinary and malformed JSON error messages remain readable", () => {
    for (const message of [
      "Shader compilation failed",
      '{"incomplete":',
      "null",
      "42",
    ]) {
      const error = new Error(message);
      error.stack = `Error: ${message}\n    at draw (map.js:1:2)`;
      const report = api.describeError(error);
      check(report.message === message, "Plain error message changed");
      check(report.stack[0] === "at draw (map.js:1:2)", "Stack frame lost");
    }
  });
  test("Firefox stack frames and errors without stacks are preserved", () => {
    const error = new Error('{"message":"Context failed"}');
    error.stack =
      "setupPainter@https://example.org/map.js:1:2\nMap@https://example.org/map.js:3:4\n";
    const report = api.describeError(error);
    check(
      report.stack.length === 2 && report.stack[0].startsWith("setupPainter@"),
      "Firefox stack frame lost",
    );
    error.stack = undefined;
    check(
      api.describeError(error).stack === undefined,
      "Missing stack mishandled",
    );
    check(
      api.describeError("Failure").message === "Failure",
      "Thrown string mishandled",
    );
  });
  const original = HTMLCanvasElement.prototype.getContext;
  let released = 0;
  for (const proto of [
    WebGLRenderingContext.prototype,
    WebGL2RenderingContext.prototype,
  ]) {
    const getExtension = proto.getExtension;
    proto.getExtension = function (name) {
      const extension = getExtension.call(this, name);
      if (name === "WEBGL_lose_context" && extension) {
        return {
          loseContext() {
            released++;
            extension.loseContext();
          },
        };
      }
      return extension;
    };
  }
  function withContextOverride(override, run) {
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
      return override(this, type, attributes);
    };
    try {
      run();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  }
  const diagnose = () =>
    api.diagnoseMapFailure(
      new ReferenceError("ResizeObserver is not defined"),
      [800, 600],
      "test",
    );

  test("WebGL1 and WebGL2 compile, texture, draw and read back pixels", () => {
    const canvases = new Set();
    withContextOverride(
      (canvas, type, attributes) => {
        check(!canvases.has(canvas), "A canvas was reused across probes");
        canvases.add(canvas);
        return original.call(canvas, type, attributes);
      },
      () => {
        const report = diagnose();
        check(!report.diagnosticsError, JSON.stringify(report));
        check(
          report.diagnostics.webgl1.map.render === "passed",
          JSON.stringify(report),
        );
        check(
          report.diagnostics.webgl2.map.render === "passed",
          JSON.stringify(report),
        );
        check(
          report.error.message === "ResizeObserver is not defined",
          "Original error was lost",
        );
        check(
          canvases.size === 2,
          "Expected one independent canvas per version",
        );
        check(
          JSON.stringify(report, null, 2).length < 19000,
          "Report must leave room for the user's message within the 20,000-character limit",
        );
        check(
          report.diagnostics.webgl2.map.details.MAX_TEXTURE_SIZE > 0,
          "Missing GPU limits",
        );
        check(
          Array.isArray(
            report.diagnostics.webgl1.map.details.MAX_VIEWPORT_DIMS,
          ),
          "Typed array was not serialized",
        );
      },
    );
    check(released === 2, "Probe contexts were not released");
  });
  test("WebGL1-only device and context creation status message", () => {
    withContextOverride(
      (canvas, type, attributes) => {
        if (type === "webgl2") {
          const event = new Event("webglcontextcreationerror");
          Object.defineProperty(event, "statusMessage", {
            value: "WebGL2 disabled",
          });
          canvas.dispatchEvent(event);
          return null;
        }
        return original.call(canvas, type, attributes);
      },
      () => {
        const report = diagnose().diagnostics;
        check(
          !report.webgl2.map.contextCreated &&
            !report.webgl2.relaxed.contextCreated,
          "WebGL2 falsely detected",
        );
        check(
          report.webgl1.map.render === "passed",
          "WebGL1 not independently tested",
        );
        check(
          report.webgl2.map.creationErrors[0] === "WebGL2 disabled",
          "Missing creation failure detail",
        );
      },
    );
  });
  test("No WebGL support", () => {
    withContextOverride(
      () => null,
      () => {
        const report = diagnose().diagnostics;
        for (const version of [report.webgl1, report.webgl2]) {
          check(
            !version.map.contextCreated && !version.relaxed.contextCreated,
            "False support result",
          );
          check(
            version.map.render === "not-run",
            "Rendering reported without a context",
          );
        }
      },
    );
  });
  test("Context creation exceptions preserve error and allow the other version", () => {
    withContextOverride(
      (canvas, type, attributes) => {
        if (type === "webgl2") throw new Error("Policy blocked WebGL2");
        return original.call(canvas, type, attributes);
      },
      () => {
        const report = diagnose().diagnostics;
        check(
          report.webgl2.map.error.message === "Policy blocked WebGL2",
          "Exception was lost",
        );
        check(report.webgl1.map.render === "passed", "Other version skipped");
      },
    );
  });
  test("Map attributes fail but relaxed WebGL2 works", () => {
    withContextOverride(
      (canvas, type, attributes) => {
        if (type === "webgl2" && attributes.stencil) return null;
        return original.call(canvas, type, attributes);
      },
      () => {
        const report = diagnose().diagnostics;
        check(
          !report.webgl2.map.contextCreated,
          "Map settings unexpectedly succeeded",
        );
        check(
          report.webgl2.relaxed.render === "passed",
          "Relaxed settings not tested",
        );
      },
    );
  });
  test("Shader compiler failure is distinct from context creation", () => {
    const proto = WebGL2RenderingContext.prototype;
    const getShaderParameter = proto.getShaderParameter;
    proto.getShaderParameter = () => false;
    try {
      const probe = api.probeContext("webgl2", api.MAP_CONTEXT_ATTRIBUTES);
      check(
        probe.contextCreated && probe.render === "failed",
        "Shader failure misclassified",
      );
      check(probe.error.message.includes("shader:"), "Missing shader error");
    } finally {
      proto.getShaderParameter = getShaderParameter;
    }
  });
  test("Incorrect rendering fails readback validation", () => {
    const proto = WebGLRenderingContext.prototype;
    const readPixels = proto.readPixels;
    proto.readPixels = () => {};
    try {
      const probe = api.probeContext("webgl", api.MAP_CONTEXT_ATTRIBUTES);
      check(
        probe.render === "failed" && probe.error.message.includes("pixel"),
        "Bad pixel accepted",
      );
    } finally {
      proto.readPixels = readPixels;
    }
  });
  test("Unavailable optional GPU metadata does not fail working WebGL", () => {
    const proto = WebGL2RenderingContext.prototype;
    const getExtension = proto.getExtension;
    const getShaderPrecisionFormat = proto.getShaderPrecisionFormat;
    proto.getExtension = function (name) {
      return name === "WEBGL_debug_renderer_info"
        ? null
        : getExtension.call(this, name);
    };
    proto.getShaderPrecisionFormat = () => {
      throw new Error("Unavailable precision query");
    };
    try {
      const probe = api.probeContext("webgl2", api.MAP_CONTEXT_ATTRIBUTES);
      check(
        probe.render === "passed",
        "Optional query changed rendering result",
      );
      check(
        probe.details.unmaskedRenderer === null && probe.details.queryErrors,
        "Missing optional query status",
      );
    } finally {
      proto.getExtension = getExtension;
      proto.getShaderPrecisionFormat = getShaderPrecisionFormat;
    }
  });
  passed.push(...(await window.runMarkerTests()));
  passed.push(...(await window.runSelectionTests()));
  passed.push(...(await window.runRetryTests()));
  passed.push(...(await window.runVehicleDetailsTests()));
  document.getElementById("result").textContent = JSON.stringify({ passed });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zet-graphics-test-"));
  const markerModules = [
    "WebGLMarkerRenderer",
    "MarkerAtlas",
    "VehicleLayer",
    "TrajectoryLayer",
    "StopRenderer",
    "url",
    "useAsyncData",
    "fetchJson",
    "Data",
    "VehicleDetails",
  ]
    .map((name) => {
      const source = fs.readFileSync(
        path.join(
          __dirname,
          `../src/${name}.${name === "Data" ? "tsx" : "ts"}`,
        ),
        "utf8",
      );
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2017,
        },
      }).outputText;
      return `${JSON.stringify(`./${name}`)}: function(exports, require) { ${compiled} }`;
    })
    .join(",\n");
  const maplibre = fs.readFileSync(require.resolve("maplibre-gl"));
  const reactModules = [
    ["react", "react", "react.development.js"],
    ["react-dom", "react-dom", "react-dom.development.js"],
    ["react-dom/client", "react-dom", "react-dom-client.development.js"],
    ["scheduler", "scheduler", "scheduler.development.js"],
  ]
    .map(([name, pkg, file]) => {
      const source = fs.readFileSync(
        path.join(path.dirname(require.resolve(pkg)), "cjs", file),
        "utf8",
      );
      return `${JSON.stringify(name)}: function(exports, require) { const process = {env: {NODE_ENV: 'development'}}; ${source} }`;
    })
    .join(",\n");
  const maplibreCss = fs.readFileSync(
    require.resolve("maplibre-gl/dist/maplibre-gl.css"),
  );
  const mapCss = fs.readFileSync(path.join(__dirname, "../src/Map.css"));
  const html = `<!doctype html><link rel="stylesheet" href="/maplibre.css"><link rel="stylesheet" href="/map.css"><pre id="result">running</pre><script src="/maplibre.js"></script><script>
    window.__DEV__ = false;
    window.diagnostics = {};
    (function(exports) { ${outputText} })(window.diagnostics);
    const modules = { ${markerModules}, ${reactModules} }, cache = {};
    function load(name) {
      if (name === 'maplibre-gl') return window.maplibregl;
      if (!cache[name]) { cache[name] = {}; modules[name](cache[name], load); }
      return cache[name];
    }
    window.markerModules = {...load('./WebGLMarkerRenderer'), ...load('./MarkerAtlas'), ...load('./VehicleLayer')};
    window.runMarkerTests = ${markerTests.toString()};
    window.selectionModules = {React: load('react'), ...load('react-dom/client'), ...load('./useAsyncData'), ...load('./fetchJson'), ...load('./Data')};
    window.runSelectionTests = ${selectionTests.toString()};
    window.runRetryTests = ${retryTests.toString()};
    window.vehicleDetailsModules = {...load('./VehicleDetails'), ...load('./Data')};
    window.runVehicleDetailsTests = ${vehicleDetailsTests.toString()};
    (${browserTests.toString()})().catch(error => {
      const describe = error => error.stack + (error.errors ? '\\n' + error.errors.map(describe).join('\\n') : '');
      document.getElementById('result').textContent = JSON.stringify({error: describe(error)});
    }).finally(() => {
      fetch('/result', {method: 'POST', body: document.getElementById('result').textContent});
    });
    </script>`;
  let reportResult;
  const server = http.createServer((request, response) => {
    if (request.url === "/result" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.end("OK");
        reportResult(body);
      });
      return;
    }
    if (request.url === "/maplibre.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(maplibre);
      return;
    }
    if (request.url === "/maplibre.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(maplibreCss);
      return;
    }
    if (request.url === "/map.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(mapCss);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const child = spawn(process.env.CHROME_BIN || "google-chrome", [
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.address().port}`,
    ]);
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Use wall-clock time: virtual-time budgets can expire before asynchronous
    // MapLibre animation frames run. Chrome posts the result when tests finish.
    let timeout;
    const exited = new Promise((resolve) => child.once("close", resolve));
    const result = await new Promise((resolve, reject) => {
      reportResult = (body) => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      };
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Chrome exited (${code}): ${stderr}`)),
      );
      timeout = setTimeout(
        () => reject(new Error(`Graphics tests timed out: ${stderr}`)),
        60000,
      );
    }).finally(async () => {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await exited;
    });
    assert.ok(!result.error, result.error);
    console.log(result.passed.join("\n"));
    console.log(`${result.passed.length} graphics tests passed.`);
  } finally {
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
