import type maplibregl from "maplibre-gl";
import type { Stops } from "./Data";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const OUTER_RADIUS = 5;
const INNER_RADIUS = 3.5;
// Match the route renderer's antialiasing width, in physical pixels.
const ANTIALIAS_WIDTH = 1.5;
// Same Samsung Xclipse workaround as the vehicle instance buffer.
const BUFFER_PADDING_FLOATS = 16;
const FALLBACK_CORNERS = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_center;
uniform vec2 u_viewport;
uniform float u_extent;
out vec2 v_offset;

void main() {
  v_offset = a_corner * u_extent;
  vec2 clip = (a_center + v_offset) / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_offset;
uniform vec2 u_radii;
out vec4 fragColor;

void main() {
  float distance = length(v_offset);
  float halfAA = ${ANTIALIAS_WIDTH * 0.5};
  float alpha = 1.0 - smoothstep(u_radii.x - halfAA, u_radii.x + halfAA, distance);
  float fill = 1.0 - smoothstep(u_radii.y - halfAA, u_radii.y + halfAA, distance);
  fragColor = vec4(vec3(fill * alpha), alpha);
}
`;

function compileShader(gl: GL, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Stop shader compilation failed: ${log}`);
  }
  return shader;
}

/** Instanced squares on WebGL2, expanded triangle batches on WebGL1. */
export class StopRenderer {
  private program: WebGLProgram;
  private gl2: WebGL2RenderingContext | null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private centerBuffer: WebGLBuffer;
  private centers = new Float32Array(0);
  private uViewport: WebGLUniformLocation | null;
  private uExtent: WebGLUniformLocation | null;
  private uRadii: WebGLUniformLocation | null;

  constructor(private gl: GL) {
    this.gl2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext
        ? gl
        : null;
    let vertexSource = VERTEX_SHADER;
    let fragmentSource = FRAGMENT_SHADER;
    if (!this.gl2) {
      const precision = gl.getShaderPrecisionFormat(
        gl.FRAGMENT_SHADER,
        gl.HIGH_FLOAT,
      )?.precision
        ? "highp"
        : "mediump";
      vertexSource = vertexSource
        .replace("#version 300 es", "")
        .replace(/layout\(location = \d\) in /g, "attribute ")
        .replace("out vec2", `varying ${precision} vec2`);
      fragmentSource = fragmentSource
        .replace("#version 300 es", "")
        .replace("precision highp float", `precision ${precision} float`)
        .replace("in vec2", `varying ${precision} vec2`)
        .replace("out vec4 fragColor;", "")
        .replace("fragColor =", "gl_FragColor =");
    }
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    if (!this.gl2) {
      gl.bindAttribLocation(this.program, 0, "a_corner");
      gl.bindAttribLocation(this.program, 1, "a_center");
    }
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(this.program);
      gl.deleteProgram(this.program);
      throw new Error(`Stop shader linking failed: ${log}`);
    }
    this.uViewport = gl.getUniformLocation(this.program, "u_viewport");
    this.uExtent = gl.getUniformLocation(this.program, "u_extent");
    this.uRadii = gl.getUniformLocation(this.program, "u_radii");

    this.centerBuffer = gl.createBuffer()!;
    if (!this.gl2) return;
    const gl2 = this.gl2;
    this.vao = gl2.createVertexArray()!;
    this.quadBuffer = gl.createBuffer()!;
    gl2.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl2.vertexAttribDivisor(1, 1);
    gl2.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(map: maplibregl.Map, stops: Stops, dpr: number) {
    if (stops.lats.length === 0) return;
    const { gl } = this;
    const used = stops.lats.length * (this.gl2 ? 2 : 24);
    if (this.centers.length < used + BUFFER_PADDING_FLOATS) {
      this.centers = new Float32Array(used + BUFFER_PADDING_FLOATS);
    }
    for (let i = 0; i < stops.lats.length; ++i) {
      const point = map.project([stops.lons[i], stops.lats[i]]);
      if (this.gl2) {
        this.centers[i * 2] = point.x * dpr;
        this.centers[i * 2 + 1] = point.y * dpr;
      } else {
        for (let corner = 0; corner < 6; ++corner) {
          const offset = i * 24 + corner * 4;
          this.centers[offset] = FALLBACK_CORNERS[corner * 2];
          this.centers[offset + 1] = FALLBACK_CORNERS[corner * 2 + 1];
          this.centers[offset + 2] = point.x * dpr;
          this.centers[offset + 3] = point.y * dpr;
        }
      }
    }
    this.centers.fill(0, used, used + BUFFER_PADDING_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.centers.subarray(0, used + BUFFER_PADDING_FLOATS),
      gl.DYNAMIC_DRAW,
    );
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(this.uExtent, OUTER_RADIUS * dpr + ANTIALIAS_WIDTH * 0.5);
    gl.uniform2f(this.uRadii, OUTER_RADIUS * dpr, INNER_RADIUS * dpr);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    if (this.gl2) {
      this.gl2.bindVertexArray(this.vao);
      this.gl2.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stops.lats.length);
      this.gl2.bindVertexArray(null);
    } else {
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLES, 0, stops.lats.length * 6);
      gl.disableVertexAttribArray(0);
      gl.disableVertexAttribArray(1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  destroy() {
    if (this.vao) this.gl2?.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteBuffer(this.centerBuffer);
    this.gl.deleteProgram(this.program);
  }
}
