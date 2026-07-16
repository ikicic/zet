import maplibregl from "maplibre-gl";
import { RouteId, Vehicle, Shape } from "./Data";
import { getMapDpr } from "./url";

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

type Point = [number, number];
type Vector = Point;

interface JoinTriangle {
  center: Point;
  a: Point;
  b: Point;
  distanceA: number;
  distanceB: number;
  distanceC: number;
}

interface Segment {
  a: Point;
  b: Point;
  d: Vector;
  n: Vector;
}

interface SegmentCap {
  left: Point;
  right: Point;
}

interface Join {
  outerTriangle: JoinTriangle | null;
  innerTriangle: JoinTriangle | null;
  prevEndLeft: Point;
  prevEndRight: Point;
  nextStartLeft: Point;
  nextStartRight: Point;
}

function add(p: Point, v: Vector): Point {
  return [p[0] + v[0], p[1] + v[1]];
}

function vec(from: Point, to: Point): Vector {
  return [to[0] - from[0], to[1] - from[1]];
}

function scale(v: Vector, s: number): Vector {
  return [v[0] * s, v[1] * s];
}

function length(v: Vector): number {
  return Math.hypot(v[0], v[1]);
}

function lengthSq(v: Vector): number {
  return v[0] * v[0] + v[1] * v[1];
}

function pointsEqual(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function offset(p: Point, n: Vector, extent: number, side: 1 | -1): Point {
  return add(p, scale(n, side * extent));
}

function cross2d(a: Vector, b: Vector): number {
  return a[0] * b[1] - a[1] * b[0];
}

function segmentCap(p: Point, n: Vector, extent: number): SegmentCap {
  return {
    left: offset(p, n, extent, 1),
    right: offset(p, n, extent, -1),
  };
}

function wedgeTriangle(
  center: Point,
  a: Point,
  b: Point,
  edgeDistance: number,
): JoinTriangle {
  return {
    center,
    a,
    b,
    distanceA: 0,
    distanceB: edgeDistance,
    distanceC: edgeDistance,
  };
}

function createShader(gl: GL, type: number, source: string): WebGLShader {
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
    FRAGMENT_SHADER_SOURCE,
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

function dedupeTrailPoints(points: Point[], minDist: number): Point[] {
  if (points.length <= 1) {
    return points;
  }

  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; ++i) {
    if (length(vec(out[out.length - 1], points[i])) >= minDist) {
      out.push(points[i]);
    }
  }

  const last = points[points.length - 1];
  if (out.length === 1 || length(vec(out[out.length - 1], last)) >= minDist) {
    out.push(last);
  } else {
    out[out.length - 1] = last;
  }
  return out;
}

function buildSegments(points: Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; ++i) {
    const delta = vec(points[i], points[i + 1]);
    const len = length(delta);
    if (len < 1e-10) {
      continue;
    }
    const d = scale(delta, 1 / len);
    segments.push({
      a: points[i],
      b: points[i + 1],
      d,
      n: [-d[1], d[0]],
    });
  }
  return segments;
}

function pushVertex(vertices: number[], point: Point, distance: number) {
  vertices.push(point[0], point[1], distance);
}

function pushTriangle(
  vertices: number[],
  a: Point,
  b: Point,
  c: Point,
  distanceA: number,
  distanceB: number,
  distanceC: number,
) {
  pushVertex(vertices, a, distanceA);
  pushVertex(vertices, b, distanceB);
  pushVertex(vertices, c, distanceC);
}

function emitQuad(
  vertices: number[],
  start: SegmentCap,
  end: SegmentCap,
  extent: number,
) {
  pushTriangle(
    vertices,
    start.left,
    start.right,
    end.left,
    -extent,
    extent,
    -extent,
  );
  pushTriangle(
    vertices,
    end.left,
    start.right,
    end.right,
    -extent,
    extent,
    extent,
  );
}

function emitJoinTriangle(vertices: number[], tri: JoinTriangle) {
  pushTriangle(
    vertices,
    tri.center,
    tri.a,
    tri.b,
    tri.distanceA,
    tri.distanceB,
    tri.distanceC,
  );
}

function innerBevelJoin(
  p: Point,
  prev: Segment,
  next: Segment,
  extent: number,
  side: 1 | -1,
): {
  prevCorner: Point;
  nextCorner: Point;
  innerTriangle: JoinTriangle | null;
} {
  const prevCorner = offset(p, prev.n, extent, side);
  const nextCorner = offset(p, next.n, extent, side);
  if (lengthSq(vec(prevCorner, nextCorner)) < 1e-8) {
    return { prevCorner, nextCorner, innerTriangle: null };
  }

  return {
    prevCorner,
    nextCorner,
    innerTriangle: wedgeTriangle(p, prevCorner, nextCorner, -side * extent),
  };
}

function computeJoin(prev: Segment, next: Segment, extent: number): Join {
  const p = prev.b;
  const turn = cross2d(prev.d, next.d);

  if (Math.abs(turn) < 1e-6) {
    const cap = segmentCap(p, prev.n, extent);
    return {
      outerTriangle: null,
      innerTriangle: null,
      prevEndLeft: cap.left,
      prevEndRight: cap.right,
      nextStartLeft: cap.left,
      nextStartRight: cap.right,
    };
  }

  const ccw = turn > 0;
  const outerSide: 1 | -1 = ccw ? 1 : -1;
  const innerSide: 1 | -1 = ccw ? -1 : 1;
  const inner = innerBevelJoin(p, prev, next, extent, innerSide);

  return {
    outerTriangle: wedgeTriangle(
      p,
      offset(p, prev.n, extent, outerSide),
      offset(p, next.n, extent, outerSide),
      -outerSide * extent,
    ),
    innerTriangle: inner.innerTriangle,
    prevEndLeft: ccw ? offset(p, prev.n, extent, 1) : inner.prevCorner,
    prevEndRight: ccw ? inner.prevCorner : offset(p, prev.n, extent, -1),
    nextStartLeft: ccw ? offset(p, next.n, extent, 1) : inner.nextCorner,
    nextStartRight: ccw ? inner.nextCorner : offset(p, next.n, extent, -1),
  };
}

function emitJoin(vertices: number[], join: Join) {
  if (join.outerTriangle) {
    emitJoinTriangle(vertices, join.outerTriangle);
  }
  if (join.innerTriangle) {
    emitJoinTriangle(vertices, join.innerTriangle);
  }
}

function pushPolyline(vertices: number[], points: Point[], dpr: number) {
  const minDist = 0.5 * dpr;
  const extent = dpr + 0.5 * ANTIALIAS_WIDTH;

  const segments = buildSegments(dedupeTrailPoints(points, minDist));
  if (segments.length === 0) {
    return;
  }

  for (let i = 0; i < segments.length; ++i) {
    const seg = segments[i];
    const atChainStart = i === 0 || !pointsEqual(seg.a, segments[i - 1].b);
    const atChainEnd =
      i === segments.length - 1 || !pointsEqual(seg.b, segments[i + 1].a);

    let start: SegmentCap;
    if (atChainStart) {
      start = segmentCap(seg.a, seg.n, extent);
    } else {
      const join = computeJoin(segments[i - 1], seg, extent);
      emitJoin(vertices, join);
      start = { left: join.nextStartLeft, right: join.nextStartRight };
    }

    let end: SegmentCap;
    if (atChainEnd) {
      end = segmentCap(seg.b, seg.n, extent);
    } else {
      const join = computeJoin(seg, segments[i + 1], extent);
      end = { left: join.prevEndLeft, right: join.prevEndRight };
    }

    emitQuad(vertices, start, end, extent);
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
  private selectedShape: Shape | null = null;

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
    highlightedRouteId: RouteId | null,
    selectedShape: Shape | null = null,
  ) {
    this.vehicles = vehicles;
    this.filterSelection = filterSelection;
    this.highlightedRouteId = highlightedRouteId;
    this.selectedShape = selectedShape;
    this.map?.triggerRepaint();
  }

  render(gl: GL, _options: maplibregl.CustomRenderMethodInput) {
    if (!this.program || !this.buffer || !this.map) {
      return;
    }
    this.rebuildBuffer();

    const dpr = getMapDpr();
    const canvas = gl.canvas as HTMLCanvasElement;
    const stride = FLOATS_PER_VERTEX * 4;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.enableVertexAttribArray(this.aPos0);
    gl.vertexAttribPointer(this.aPos0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aDistance);
    gl.vertexAttribPointer(this.aDistance, 1, gl.FLOAT, false, stride, 2 * 4);

    gl.uniform2f(this.uViewport, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    if (this.vertexCount > 0) {
      gl.uniform1f(this.uWidth, 2 * dpr);
      gl.uniform4f(this.uColor, 1, 100 / 255, 100 / 255, 0.7);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }

    gl.disableVertexAttribArray(this.aPos0);
    gl.disableVertexAttribArray(this.aDistance);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Draw the selected route between unselected and highlighted markers. */
  renderSelectedShape(gl: GL) {
    if (!this.program || !this.buffer || !this.map || !this.selectedShape) {
      return;
    }

    const dpr = getMapDpr();
    const vertices: number[] = [];
    const points: Point[] = [];
    for (let i = 0; i < this.selectedShape.lons.length; i++) {
      const point = this.map.project([
        this.selectedShape.lons[i],
        this.selectedShape.lats[i],
      ]);
      points.push([point.x * dpr, point.y * dpr]);
    }
    pushPolyline(vertices, points, dpr);

    const vertexCount = vertices.length / FLOATS_PER_VERTEX;
    if (vertexCount === 0) return;

    const canvas = gl.canvas as HTMLCanvasElement;
    const stride = FLOATS_PER_VERTEX * 4;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos0);
    gl.vertexAttribPointer(this.aPos0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aDistance);
    gl.vertexAttribPointer(this.aDistance, 1, gl.FLOAT, false, stride, 2 * 4);
    gl.uniform2f(this.uViewport, canvas.width, canvas.height);
    gl.uniform1f(this.uWidth, 3 * dpr);
    gl.uniform4f(this.uColor, 0, 0, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.disableVertexAttribArray(this.aPos0);
    gl.disableVertexAttribArray(this.aDistance);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private rebuildBuffer() {
    if (!this.gl || !this.buffer || !this.map) {
      return;
    }

    const dpr = getMapDpr();
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

      const points: Point[] = [];
      for (let i = 0; i < vehicle.lon.length; ++i) {
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
      this.gl.DYNAMIC_DRAW,
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }
}
