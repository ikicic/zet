// Instanced vehicle marker renderer as a MapLibre custom layer.
// Draws sprites from a MarkerAtlas texture on the map's WebGL canvas.

import maplibregl from "maplibre-gl";
import { MarkerAtlas, AtlasEntry } from "./MarkerAtlas";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

function isWebGL2(gl: GL): gl is WebGL2RenderingContext {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    gl instanceof WebGL2RenderingContext
  );
}

/**
 * Canvas uploads can be premultiplied by WebGL, but typed-array uploads
 * cannot. The atlas uses premultiplied-alpha blending, so dirty ImageData
 * rectangles must be converted before texSubImage2D.
 */
function premultiplyImageData(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 255) continue;
    if (alpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    data[i] = Math.round((data[i] * alpha) / 255);
    data[i + 1] = Math.round((data[i + 1] * alpha) / 255);
    data[i + 2] = Math.round((data[i + 2] * alpha) / 255);
  }
}

// --- Shaders (GLSL ES 3.0 for WebGL2) ---

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_quadCorner;
layout(location = 1) in vec2 a_screenPos;
layout(location = 2) in vec4 a_atlasRegion;
layout(location = 3) in vec2 a_centerOffset;
layout(location = 4) in vec2 a_flip;
layout(location = 5) in vec4 a_color;

uniform vec2 u_canvasSize;
uniform vec2 u_atlasSize;

out vec2 v_texCoord;
out vec4 v_color;

void main() {
  vec2 spritePos = a_screenPos - a_centerOffset + a_quadCorner * a_atlasRegion.zw;
  vec2 clipPos = (spritePos / u_canvasSize) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;
  gl_Position = vec4(clipPos, 0.0, 1.0);
  vec2 texCorner = mix(a_quadCorner, 1.0 - a_quadCorner, a_flip);
  vec2 uvMin = a_atlasRegion.xy / u_atlasSize;
  vec2 uvMax = (a_atlasRegion.xy + a_atlasRegion.zw) / u_atlasSize;
  vec2 halfTexel = 0.5 / u_atlasSize;
  v_texCoord = mix(uvMin + halfTexel, uvMax - halfTexel, texCorner);
  v_color = a_color;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_texCoord;
in vec4 v_color;
uniform sampler2D u_atlas;
out vec4 fragColor;

void main() {
  vec4 texColor = texture(u_atlas, v_texCoord);
  fragColor = texColor * v_color;
}
`;

// Per instance: screenX, screenY, atlasX, atlasY, atlasW, atlasH, cx, cy,
//               flipX, flipY, r, g, b, a = 14 floats.
const FLOATS_PER_INSTANCE = 14;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

function compileShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function createProgram(gl: GL): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export class WebGLMarkerRenderer implements maplibregl.CustomLayerInterface {
  id = "vehicle-markers";
  type = "custom" as const;
  renderingMode = "2d" as const;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private atlasTexture: WebGLTexture | null = null;

  private uCanvasSize: WebGLUniformLocation | null = null;
  private uAtlasSize: WebGLUniformLocation | null = null;
  private uAtlas: WebGLUniformLocation | null = null;

  private uploadedW = 0;
  private uploadedH = 0;

  private atlas: MarkerAtlas | null = null;
  private instanceData = new Float32Array(1024 * FLOATS_PER_INSTANCE);
  private instanceCount = 0;
  private unselectedInstanceCount = 0;
  private frameBuilder: (() => void) | null = null;
  private betweenMarkerGroups: ((gl: WebGL2RenderingContext) => void) | null =
    null;

  /** Called at the start of each custom-layer render, before drawing. */
  setFrameBuilder(fn: () => void) {
    this.frameBuilder = fn;
  }

  /** Draws after unselected markers and before highlighted markers. */
  setBetweenMarkerGroups(fn: (gl: WebGL2RenderingContext) => void) {
    this.betweenMarkerGroups = fn;
  }

  /** Atlas reference used for texture uploads during render. */
  setAtlas(atlas: MarkerAtlas) {
    this.atlas = atlas;
    this.uploadedW = 0;
    this.uploadedH = 0;
  }

  /** Begin a new frame. Reserves capacity for up to `maxInstances`. */
  beginFrame(maxInstances: number) {
    const needed = maxInstances * FLOATS_PER_INSTANCE;
    if (this.instanceData.length < needed) {
      this.instanceData = new Float32Array(
        Math.max(needed, this.instanceData.length * 2),
      );
    }
    this.instanceCount = 0;
    this.unselectedInstanceCount = 0;
  }

  /** Finish adding the unselected-marker group for this frame. */
  finishUnselectedMarkers() {
    this.unselectedInstanceCount = this.instanceCount;
  }

  addInstance(
    screenX: number,
    screenY: number,
    entry: AtlasEntry,
    color: [number, number, number, number],
  ) {
    const off = this.instanceCount * FLOATS_PER_INSTANCE;
    const d = this.instanceData;
    d[off] = screenX;
    d[off + 1] = screenY;
    d[off + 2] = entry.x;
    d[off + 3] = entry.y;
    d[off + 4] = entry.w;
    d[off + 5] = entry.h;
    d[off + 6] = entry.cx;
    d[off + 7] = entry.cy;
    d[off + 8] = entry.flipX ? 1 : 0;
    d[off + 9] = entry.flipY ? 1 : 0;
    d[off + 10] = color[0];
    d[off + 11] = color[1];
    d[off + 12] = color[2];
    d[off + 13] = color[3];
    this.instanceCount++;
  }

  onAdd(_map: maplibregl.Map, gl: GL) {
    if (!isWebGL2(gl)) {
      throw new Error("WebGLMarkerRenderer requires WebGL2");
    }
    this.gl = gl;

    if (__DEV__) {
      console.log("WebGLMarkerRenderer: custom layer on MapLibre canvas");
    }

    const program = createProgram(gl);
    this.program = program;

    this.uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
    this.uAtlasSize = gl.getUniformLocation(program, "u_atlasSize");
    this.uAtlas = gl.getUniformLocation(program, "u_atlas");

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.instanceBuffer = gl.createBuffer();
    this.atlasTexture = gl.createTexture();

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 8);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 24);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 32);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 40);

    gl.vertexAttribDivisor(1, 1);
    gl.vertexAttribDivisor(2, 1);
    gl.vertexAttribDivisor(3, 1);
    gl.vertexAttribDivisor(4, 1);
    gl.vertexAttribDivisor(5, 1);

    gl.bindVertexArray(null);
  }

  onRemove() {
    const gl = this.gl;
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
      if (this.atlasTexture) gl.deleteTexture(this.atlasTexture);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this.atlasTexture = null;
  }

  render(gl: GL, _options: maplibregl.CustomRenderMethodInput) {
    if (
      !isWebGL2(gl) ||
      !this.program ||
      !this.vao ||
      !this.instanceBuffer ||
      !this.atlas
    ) {
      return;
    }

    // Project vehicles and fill the instance buffer using the current transform.
    this.frameBuilder?.();

    this.uploadAtlas(gl, this.atlas);

    const count = this.instanceCount;
    if (count === 0) {
      this.betweenMarkerGroups?.(gl);
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.instanceData.subarray(0, count * FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW,
    );

    const canvas = gl.canvas as HTMLCanvasElement;
    gl.useProgram(this.program);
    gl.uniform2f(this.uCanvasSize, canvas.width, canvas.height);
    gl.uniform2f(
      this.uAtlasSize,
      this.atlas.canvas.width,
      this.atlas.canvas.height,
    );
    gl.uniform1i(this.uAtlas, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    this.drawInstances(gl, 0, this.unselectedInstanceCount);
    this.betweenMarkerGroups?.(gl);

    // The trajectory renderer changes the current program and buffer state.
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    this.drawInstances(
      gl,
      this.unselectedInstanceCount,
      count - this.unselectedInstanceCount,
    );

    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.disableVertexAttribArray(3);
    gl.disableVertexAttribArray(4);
    gl.disableVertexAttribArray(5);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private drawInstances(
    gl: WebGL2RenderingContext,
    start: number,
    count: number,
  ) {
    if (count === 0 || !this.vao || !this.instanceBuffer) return;

    const instanceOffset = start * BYTES_PER_INSTANCE;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.vertexAttribPointer(
      1,
      2,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      instanceOffset,
    );
    gl.vertexAttribPointer(
      2,
      4,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      instanceOffset + 8,
    );
    gl.vertexAttribPointer(
      3,
      2,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      instanceOffset + 24,
    );
    gl.vertexAttribPointer(
      4,
      2,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      instanceOffset + 32,
    );
    gl.vertexAttribPointer(
      5,
      4,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      instanceOffset + 40,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  private uploadAtlas(gl: WebGL2RenderingContext, atlas: MarkerAtlas) {
    if (!this.atlasTexture) return;

    const dirty = atlas.consumeDirtyRect();
    if (!dirty) return;

    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);

    const dimsChanged =
      this.uploadedW !== atlas.canvas.width ||
      this.uploadedH !== atlas.canvas.height;

    if (dimsChanged) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        atlas.canvas,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.uploadedW = atlas.canvas.width;
      this.uploadedH = atlas.canvas.height;
      return;
    }

    // Incremental upload via ImageData. texSubImage2D from a canvas with
    // UNPACK_SKIP_* is unreliable on mobile GPUs (streaky/thickened shadows).
    const pad = 1;
    const x = Math.max(0, dirty.x - pad);
    const y = Math.max(0, dirty.y - pad);
    const w = Math.min(atlas.canvas.width - x, dirty.w + 2 * pad);
    const h = Math.min(atlas.canvas.height - y, dirty.h + 2 * pad);
    const imageData = atlas.readPixels(x, y, w, h);
    premultiplyImageData(imageData.data);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      w,
      h,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      imageData.data,
    );
  }
}
