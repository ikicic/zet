import type maplibregl from "maplibre-gl";
import type { Stops } from "./Data";

const OUTER_RADIUS = 5;
const INNER_RADIUS = 3.5;
// Match the route renderer's antialiasing width, in physical pixels.
const ANTIALIAS_WIDTH = 1.5;
// Same Samsung Xclipse workaround as the vehicle instance buffer.
const BUFFER_PADDING_FLOATS = 16;

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

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
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

/** One static square, instanced at each stop; the shader draws both colors. */
export class StopRenderer {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private centerBuffer: WebGLBuffer;
  private centers = new Float32Array(0);
  private uViewport: WebGLUniformLocation | null;
  private uExtent: WebGLUniformLocation | null;
  private uRadii: WebGLUniformLocation | null;

  constructor(private gl: WebGL2RenderingContext) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
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

    this.vao = gl.createVertexArray()!;
    this.quadBuffer = gl.createBuffer()!;
    this.centerBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
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
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(map: maplibregl.Map, stops: Stops, dpr: number) {
    if (stops.lats.length === 0) return;
    const { gl } = this;
    const used = stops.lats.length * 2;
    if (this.centers.length < used + BUFFER_PADDING_FLOATS) {
      this.centers = new Float32Array(used + BUFFER_PADDING_FLOATS);
    }
    for (let i = 0; i < stops.lats.length; ++i) {
      const point = map.project([stops.lons[i], stops.lats[i]]);
      this.centers[i * 2] = point.x * dpr;
      this.centers[i * 2 + 1] = point.y * dpr;
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
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stops.lats.length);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  destroy() {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteBuffer(this.centerBuffer);
    this.gl.deleteProgram(this.program);
  }
}
