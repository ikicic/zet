// The marker image cache.

import maplibregl from "maplibre-gl";

type ImageKey = string;

export interface Marker {
  label: string;
  directionDegrees: number | null;
}

function markerToImageKey(marker: Marker): string {
  return `marker-${marker.label}-${marker.directionDegrees}`;
}

// Helper function to normalize an angle to the range [-PI, PI)
function normalizeAngle(angle: number): number {
  while (angle < -Math.PI) {
    angle += 2 * Math.PI;
  }
  while (angle > Math.PI) {
    angle -= 2 * Math.PI;
  }
  return angle;
}

function ellipseRadiusAtAngle(theta: number, a: number, b: number): number {
  // https://math.stackexchange.com/questions/432902/how-to-get-the-radius-of-an-ellipse-at-a-specific-angle-by-knowing-its-semi-majo
  return (a * b) / Math.hypot(a * Math.sin(theta), b * Math.cos(theta));
}

// Calculates the radius of the teardrop shape at a given angle theta
function calculateSimplifiedTeardropRadiusAtAngle(
  theta: number, // Current angle to calculate radius for (0 to 2PI)
  a: number,
  b: number,
  phi: number, // Direction of the teardrop tip (canvas angle, 0 to 2PI)
  deltaPhi: number, // Half angular width of the arrow's base in radians
  arrowExtensionHeight: number
): number {
  const ellipseRadius = ellipseRadiusAtAngle(theta, a, b);
  const deltaAngle = Math.abs(normalizeAngle(theta - phi));
  if (deltaAngle <= deltaPhi) {
    const alpha = 1 - deltaAngle / deltaPhi;
    const beta = alpha * alpha;
    const extraRadius = beta * arrowExtensionHeight;
    const ellipseTipRadius = ellipseRadiusAtAngle(phi, a, b);
    return (
      (1 - alpha) * ellipseRadius + alpha * (ellipseTipRadius + extraRadius)
    );
  } else {
    return ellipseRadius;
  }
}

function renderMarker(
  marker: Marker
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  const PIXEL_RATIO = window.devicePixelRatio;
  const SHADOW_BLUR = 3 * PIXEL_RATIO;
  const MARGIN = 1 * PIXEL_RATIO;
  const ARROW_EXTENSION = 6 * PIXEL_RATIO; // How far the tip extends

  const ew = (19 + marker.label.length * 5.5) * PIXEL_RATIO;
  const eh = 28 * PIXEL_RATIO;
  const ehw = ew / 2; // Half-width of the core ellipse body
  const ehh = eh / 2; // Half-height of the core ellipse body

  let totalWidth = ew + 2 * MARGIN + 2 * SHADOW_BLUR;
  let totalHeight = eh + 2 * MARGIN + 2 * SHADOW_BLUR;
  if (marker.directionDegrees != null) {
    totalWidth += ARROW_EXTENSION * 2;
    totalHeight += ARROW_EXTENSION * 2;
  }

  canvas.width = totalWidth;
  canvas.height = totalHeight;

  // Center of the drawing area on the canvas.
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const TRAM_COLOR = "hsl(207, 90%, 54%)";
  const BUS_COLOR = "hsl(212, 80%, 42%)";
  const isTram = marker.label.length < 3;
  const fillColor = isTram ? TRAM_COLOR : BUS_COLOR;

  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = SHADOW_BLUR;
  ctx.shadowOffsetX = 0 * PIXEL_RATIO;
  ctx.shadowOffsetY = 0 * PIXEL_RATIO;

  ctx.fillStyle = fillColor;
  ctx.lineWidth = 0.5 * PIXEL_RATIO;
  ctx.beginPath();

  if (marker.directionDegrees != null) {
    const deg = marker.directionDegrees;
    const phi = (deg - 90) * (Math.PI / 180);
    const deltaPhi = (50 * Math.PI) / 180;

    const NUM_SAMPLES = 90;
    for (let i = 0; i <= NUM_SAMPLES; i++) {
      const theta = phi + (i / NUM_SAMPLES) * 2 * Math.PI;
      const r = calculateSimplifiedTeardropRadiusAtAngle(
        theta,
        ehw,
        ehh,
        phi,
        deltaPhi,
        ARROW_EXTENSION
      );
      const px = cx + r * Math.cos(theta);
      const py = cy + r * Math.sin(theta);
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  } else {
    // No direction, draw a simple ellipse centered on cx, cy
    ctx.ellipse(cx, cy, ehw, ehh, 0, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  // The label
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold ${13 * PIXEL_RATIO}px Arial`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctx.shadowBlur = 2 * PIXEL_RATIO;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillText(marker.label, cx, cy);

  return [canvas, ctx];
}

export class MarkerCache {
  private cache: Map<string, ImageKey> = new Map();

  getOrCreate(map: maplibregl.Map, marker: Marker): ImageKey {
    const key = markerToImageKey(marker);
    const fromCache = this.cache.get(key);
    if (fromCache) {
      return fromCache;
    }
    const [canvas, ctx] = renderMarker(marker);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixelRatio = window.devicePixelRatio;
    map.addImage(key, imageData, { pixelRatio });
    this.cache.set(key, key);
    return key;
  }
}
