type GL = WebGLRenderingContext | WebGL2RenderingContext;
type ContextType = "webgl" | "webgl2";

// Keep the real map and the diagnostic probes on the same context settings.
export const MAP_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  depth: true,
  stencil: true,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false,
  powerPreference: "high-performance",
  desynchronized: false,
};

function parseErrorMessage(message: string) {
  // MapLibre encodes context creation details as JSON in Error.message.
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // Ordinary error messages remain text.
  }
  return message.slice(0, 3000);
}

export function describeError(error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  let stack = error instanceof Error ? error.stack : undefined;
  const header = `${name}: ${message}`;
  // V8 repeats the entire message (including its JSON) before the stack frames.
  // Firefox can start directly with frames; preserve those as well.
  if (stack?.startsWith(header)) stack = stack.slice(header.length);
  return {
    name,
    message: parseErrorMessage(message),
    stack: stack
      ?.slice(0, 4000)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

export interface ContextProbe {
  requestedAttributes: WebGLContextAttributes;
  contextCreated: boolean;
  creationErrors: string[];
  render: "not-run" | "passed" | "failed";
  error?: ReturnType<typeof describeError>;
  contextLost?: boolean;
  details?: Record<string, unknown>;
}

// Optional/blocked diagnostic APIs must not turn a successful render into a failure.
function readDetails(gl: GL, type: ContextType) {
  const details: Record<string, unknown> = {};
  const errors: Record<string, unknown> = {};
  const read = (key: string, get: () => unknown) => {
    try {
      details[key] = get();
    } catch (error) {
      errors[key] = describeError(error).message;
    }
  };
  for (const name of [
    "VERSION",
    "SHADING_LANGUAGE_VERSION",
    "VENDOR",
    "RENDERER",
    "MAX_TEXTURE_SIZE",
    "MAX_CUBE_MAP_TEXTURE_SIZE",
    "MAX_RENDERBUFFER_SIZE",
    "MAX_VIEWPORT_DIMS",
    "MAX_VERTEX_ATTRIBS",
    "MAX_TEXTURE_IMAGE_UNITS",
    "MAX_VERTEX_TEXTURE_IMAGE_UNITS",
    "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
    "MAX_VERTEX_UNIFORM_VECTORS",
    "MAX_FRAGMENT_UNIFORM_VECTORS",
    "MAX_VARYING_VECTORS",
    "ALIASED_LINE_WIDTH_RANGE",
    "ALIASED_POINT_SIZE_RANGE",
  ] as const) {
    read(name, () => {
      const value = gl.getParameter(gl[name]);
      return ArrayBuffer.isView(value)
        ? Array.from(value as Int32Array | Float32Array)
        : value;
    });
  }
  read("actualAttributes", () => gl.getContextAttributes());
  read("drawingBuffer", () => [gl.drawingBufferWidth, gl.drawingBufferHeight]);
  read("extensions", () => gl.getSupportedExtensions()?.sort() ?? null);
  read("unmaskedRenderer", () => {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? {
          vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
        }
      : null;
  });
  for (const stage of ["VERTEX_SHADER", "FRAGMENT_SHADER"] as const) {
    for (const precision of ["HIGH_FLOAT", "MEDIUM_FLOAT"] as const) {
      read(`${stage}.${precision}`, () => {
        const format = gl.getShaderPrecisionFormat(gl[stage], gl[precision]);
        return format
          ? {
              rangeMin: format.rangeMin,
              rangeMax: format.rangeMax,
              precision: format.precision,
            }
          : null;
      });
    }
  }
  for (const extension of [
    "ANGLE_instanced_arrays",
    "OES_vertex_array_object",
    "OES_element_index_uint",
    "OES_standard_derivatives",
    "WEBGL_depth_texture",
  ]) {
    read(extension, () =>
      type === "webgl2" ? "core" : !!gl.getExtension(extension),
    );
  }
  if (Object.keys(errors).length) details.queryErrors = errors;
  return details;
}

// Exercise compilation, linking, vertex buffers, texture upload/sampling, drawing
// and readback. A context object alone does not establish that rendering works.
// This is a small baseline test, not a test of every application shader/driver path.
function testRendering(gl: GL, type: ContextType) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  try {
    const webgl2 = type === "webgl2";
    const vertex = `${webgl2 ? "#version 300 es\n" : ""}
      ${webgl2 ? "in" : "attribute"} vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
    const fragment = `${webgl2 ? "#version 300 es\n" : ""}
      precision mediump float;
      uniform sampler2D image;
      ${webgl2 ? "out vec4 color;" : ""}
      void main() {
        ${webgl2 ? "color = texture" : "gl_FragColor = texture2D"}(image, vec2(0.5));
      }`;
    for (const [stage, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(stage);
      if (!shader) throw new Error("Shader allocation failed");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(
          `${stage === gl.VERTEX_SHADER ? "Vertex" : "Fragment"} shader: ${gl.getShaderInfoLog(shader)}`,
        );
      }
    }
    program = gl.createProgram();
    if (!program) throw new Error("Program allocation failed");
    shaders.forEach((shader) => gl.attachShader(program!, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!buffer || !texture)
      throw new Error("Buffer/texture allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([64, 128, 192, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(program, "image"), 0);
    gl.viewport(0, 0, 4, 4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const error = gl.getError();
    if (gl.isContextLost() || error !== gl.NO_ERROR) {
      throw new Error(
        `Rendering failed: contextLost=${gl.isContextLost()}, glError=${error}`,
      );
    }
    if (pixel.some((v, i) => Math.abs(v - [64, 128, 192, 255][i]) > 2)) {
      throw new Error(`Unexpected rendered pixel: ${Array.from(pixel)}`);
    }
  } finally {
    shaders.forEach((shader) => gl.deleteShader(shader));
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (texture) gl.deleteTexture(texture);
  }
}

export function probeContext(
  type: ContextType,
  attributes: WebGLContextAttributes,
): ContextProbe {
  const result: ContextProbe = {
    requestedAttributes: { ...attributes },
    contextCreated: false,
    creationErrors: [],
    render: "not-run",
  };
  let gl: GL | null = null;
  try {
    // Never reuse a canvas between versions or attribute sets: its context type
    // and attributes are fixed by the first successful getContext call.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    canvas.addEventListener("webglcontextcreationerror", (event) => {
      result.creationErrors.push(
        (event as WebGLContextEvent).statusMessage.slice(0, 2000),
      );
    });
    gl = canvas.getContext(type, attributes) as GL | null;
    if (!gl) return result;
    result.contextCreated = true;
    result.render = "failed";
    testRendering(gl, type);
    result.render = "passed";
  } catch (error) {
    result.error = describeError(error);
  } finally {
    if (gl) {
      try {
        result.contextLost = gl.isContextLost();
        result.details = readDetails(gl, type);
      } catch (error) {
        result.details = { queryError: describeError(error) };
      } finally {
        // Probes run sequentially; do not retain GPU contexts on struggling devices.
        try {
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
          /* optional */
        }
      }
    }
  }
  return result;
}

function probeVersion(type: ContextType) {
  const map = probeContext(type, MAP_CONTEXT_ATTRIBUTES);
  // A relaxed probe distinguishes map settings from general context availability.
  const relaxed = !map.contextCreated
    ? probeContext(type, {
        alpha: true,
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: "default",
        failIfMajorPerformanceCaveat: false,
      })
    : undefined;
  return { map, relaxed };
}

export function collectGraphicsDiagnostics(
  mapSize: number[],
  maplibreVersion: string,
  failureStage = "map-constructor",
) {
  const device = navigator as Navigator & { deviceMemory?: number };
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    failureStage,
    maplibreVersion,
    // The content hash identifies the deployed frontend, without URL query data.
    frontendBundle: Array.from(document.scripts)
      .map((script) => script.src.split("?")[0].split("/").pop())
      .find((name) => name?.startsWith("bundle.")),
    environment: {
      userAgent: device.userAgent,
      platform: device.platform,
      hardwareConcurrency: device.hardwareConcurrency,
      deviceMemoryGiB: device.deviceMemory ?? null,
      devicePixelRatio: window.devicePixelRatio,
      mapCssSize: mapSize,
      screen: [window.screen.width, window.screen.height],
      secureContext: window.isSecureContext,
      apis: {
        WebGLRenderingContext: typeof WebGLRenderingContext !== "undefined",
        WebGL2RenderingContext: typeof WebGL2RenderingContext !== "undefined",
        ResizeObserver: typeof ResizeObserver !== "undefined",
        Worker: typeof Worker !== "undefined",
      },
    },
    webgl2: probeVersion("webgl2"),
    webgl1: probeVersion("webgl"),
  };
}

export type GraphicsDiagnostics = ReturnType<typeof collectGraphicsDiagnostics>;

export interface MapFailure {
  error: ReturnType<typeof describeError>;
  diagnostics?: GraphicsDiagnostics;
  diagnosticsError?: ReturnType<typeof describeError>;
}

export function diagnoseMapFailure(
  error: unknown,
  mapSize: number[],
  maplibreVersion: string,
  failureStage = "map-constructor",
): MapFailure {
  const failure: MapFailure = { error: describeError(error) };
  try {
    failure.diagnostics = collectGraphicsDiagnostics(
      mapSize,
      maplibreVersion,
      failureStage,
    );
  } catch (diagnosticsError) {
    failure.diagnosticsError = describeError(diagnosticsError);
  }
  return failure;
}
