import maplibregl from "maplibre-gl";
import { RouteId, Vehicle } from "./Data";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const VERTEX_SHADER_SOURCE = `
precision highp float;

#define ANTIALIAS_WIDTH 1.5

attribute vec2 a_pos0;
attribute float a_distance;

uniform vec2 u_viewport;
uniform float u_width;

varying vec2 v_screen;
varying float v_distance;

void main() {
  v_screen = a_pos0;
  v_distance = a_distance;

  vec2 clip = a_pos0 / u_viewport * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision highp float;

#define ANTIALIAS_WIDTH 1.5

uniform vec4 u_color;
uniform float u_width;
varying vec2 v_screen;
varying float v_distance;

void main() {
  float distanceFromCenter = abs(v_distance);
  float radius = u_width * 0.5;
  float coverage = 1.0 - smoothstep(
    radius - ANTIALIAS_WIDTH * 0.5,
    radius + ANTIALIAS_WIDTH * 0.5,
    distanceFromCenter
  );
  float alpha = u_color.a * coverage;
  gl_FragColor = vec4(u_color.rgb * alpha, alpha);
}
`;

const FLOATS_PER_VERTEX = 3;
const ANTIALIAS_WIDTH = 1.5;

function createShader(
  gl: GL,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create trajectory shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(error);
  }
  return shader;
}

function createProgram(gl: GL): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    FRAGMENT_SHADER_SOURCE
  );
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create trajectory shader program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program) || "unknown program error";
    gl.deleteProgram(program);
    throw new Error(error);
  }
  return program;
}

interface ExtrudedPoint {
  left: [number, number];
  right: [number, number];
}

function normalize(dx: number, dy: number): [number, number] {
  const length = Math.hypot(dx, dy);
  if (length < 0.0001) {
    return [1, 0];
  }
  return [dx / length, dy / length];
}

function pushVertex(
  vertices: number[],
  point: [number, number],
  distance: number
) {
  vertices.push(point[0], point[1], distance);
}

function pushTriangle(
  vertices: number[],
  a: [number, number],
  b: [number, number],
  c: [number, number],
  distanceA: number,
  distanceB: number,
  distanceC: number
) {
  pushVertex(vertices, a, distanceA);
  pushVertex(vertices, b, distanceB);
  pushVertex(vertices, c, distanceC);
}

function pushPolyline(
  vertices: number[],
  points: Array<[number, number]>,
  dpr: number
) {
  if (points.length < 2) {
    return;
  }

  const radius = dpr;
  const extent = radius + 0.5 * ANTIALIAS_WIDTH;
  const extruded: ExtrudedPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    let normalX: number;
    let normalY: number;

    if (i === 0) {
      const [dx, dy] = normalize(
        points[1][0] - points[0][0],
        points[1][1] - points[0][1]
      );
      normalX = -dy;
      normalY = dx;
    } else if (i === points.length - 1) {
      const [dx, dy] = normalize(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1]
      );
      normalX = -dy;
      normalY = dx;
    } else {
      const [prevDx, prevDy] = normalize(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1]
      );
      const [nextDx, nextDy] = normalize(
        points[i + 1][0] - points[i][0],
        points[i + 1][1] - points[i][1]
      );
      const prevNormalX = -prevDy;
      const prevNormalY = prevDx;
      const nextNormalX = -nextDy;
      const nextNormalY = nextDx;
      [normalX, normalY] = normalize(
        prevNormalX + nextNormalX,
        prevNormalY + nextNormalY
      );
      const denom = normalX * nextNormalX + normalY * nextNormalY;
      const miterScale = Math.min(2.5, Math.max(1, 1 / Math.max(0.35, denom)));
      normalX *= miterScale;
      normalY *= miterScale;
    }

    const [x, y] = points[i];
    extruded.push({
      left: [x - normalX * extent, y - normalY * extent],
      right: [x + normalX * extent, y + normalY * extent],
    });
  }

  for (let i = 0; i < extruded.length - 1; i++) {
    const a = extruded[i];
    const b = extruded[i + 1];
    pushTriangle(vertices, a.left, a.right, b.left, -extent, extent, -extent);
    pushTriangle(vertices, b.left, a.right, b.right, -extent, extent, extent);
  }
}

export class TrajectoryLayer implements maplibregl.CustomLayerInterface {
  id = "vehicle-trajectories";
  type = "custom" as const;
  renderingMode = "2d" as const;

  private map: maplibregl.Map | null = null;
  private gl: GL | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vertexCount = 0;

  private aPos0 = -1;
  private aDistance = -1;
  private uViewport: WebGLUniformLocation | null = null;
  private uWidth: WebGLUniformLocation | null = null;
  private uColor: WebGLUniformLocation | null = null;

  private vehicles: Vehicle[] = [];
  private filterSelection: Set<RouteId> = new Set();
  private highlightedRouteId: RouteId | null = null;

  onAdd(map: maplibregl.Map, gl: GL) {
    this.map = map;
    this.gl = gl;
    this.program = createProgram(gl);
    this.buffer = gl.createBuffer();

    this.aPos0 = gl.getAttribLocation(this.program, "a_pos0");
    this.aDistance = gl.getAttribLocation(this.program, "a_distance");
    this.uViewport = gl.getUniformLocation(this.program, "u_viewport");
    this.uWidth = gl.getUniformLocation(this.program, "u_width");
    this.uColor = gl.getUniformLocation(this.program, "u_color");

    this.rebuildBuffer();
  }

  onRemove() {
    if (this.gl) {
      if (this.buffer) {
        this.gl.deleteBuffer(this.buffer);
      }
      if (this.program) {
        this.gl.deleteProgram(this.program);
      }
    }
    this.map = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
  }

  setData(
    vehicles: Vehicle[],
    filterSelection: Set<RouteId>,
    highlightedRouteId: RouteId | null
  ) {
    this.vehicles = vehicles;
    this.filterSelection = filterSelection;
    this.highlightedRouteId = highlightedRouteId;
    this.map?.triggerRepaint();
  }

  render(gl: GL, _options: maplibregl.CustomRenderMethodInput) {
    if (!this.program || !this.buffer) {
      return;
    }
    this.rebuildBuffer();
    if (this.vertexCount === 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const canvas = gl.canvas as HTMLCanvasElement;
    const stride = FLOATS_PER_VERTEX * 4;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.enableVertexAttribArray(this.aPos0);
    gl.vertexAttribPointer(this.aPos0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aDistance);
    gl.vertexAttribPointer(this.aDistance, 1, gl.FLOAT, false, stride, 2 * 4);

    gl.uniform2f(this.uViewport, canvas.width, canvas.height);
    gl.uniform1f(this.uWidth, 2 * dpr);
    gl.uniform4f(this.uColor, 1, 100 / 255, 100 / 255, 0.7);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.aPos0);
    gl.disableVertexAttribArray(this.aDistance);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private rebuildBuffer() {
    if (!this.gl || !this.buffer || !this.map) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const vertices: number[] = [];
    for (const vehicle of this.vehicles) {
      const highlighted =
        this.highlightedRouteId !== null &&
        vehicle.routeId === this.highlightedRouteId;
      const hidden =
        this.filterSelection.size > 0 &&
        !this.filterSelection.has(vehicle.routeId);
      if (hidden && !highlighted) {
        continue;
      }

      const points: Array<[number, number]> = [];
      for (let i = 0; i < vehicle.lon.length; i++) {
        const point = this.map.project([vehicle.lon[i], vehicle.lat[i]]);
        points.push([point.x * dpr, point.y * dpr]);
      }
      pushPolyline(vertices, points, dpr);
    }

    this.vertexCount = vertices.length / FLOATS_PER_VERTEX;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(vertices),
      this.gl.DYNAMIC_DRAW
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }
}
