// Texture atlas for vehicle marker shapes and route labels.
// Shapes are pre-rendered immediately (all combinations of label length,
// direction, and highlight state are known upfront). Labels are added dynamically
// as new routes appear.
//
// Sprites are tightly cropped (transparent padding removed) and packed
// left-to-right in rows (strip packing).
//
// The atlas is a single canvas that can be uploaded to a WebGL texture.

// --- Math helpers ---

function normalizeAngle(angle: number): number {
  while (angle < -Math.PI) angle += 2 * Math.PI;
  while (angle > Math.PI) angle -= 2 * Math.PI;
  return angle;
}

function ellipseRadiusAtAngle(theta: number, a: number, b: number): number {
  return (a * b) / Math.hypot(a * Math.sin(theta), b * Math.cos(theta));
}

function calculateSimplifiedTeardropRadiusAtAngle(
  theta: number,
  a: number,
  b: number,
  phi: number,
  deltaPhi: number,
  arrowExtensionHeight: number,
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

// --- Atlas types ---

export interface AtlasEntry {
  /** Top-left position in the atlas (pixels). */
  x: number;
  y: number;
  /** Sprite dimensions in the atlas (pixels), after tight cropping. */
  w: number;
  h: number;
  /** Center offset within the sprite (pixels from top-left of entry).
   *  When drawing, align this point with the vehicle's screen position.
   *  For flipped entries this is already the mirrored anchor
   *  (`w - base.cx` / `h - base.cy`), so the shader doesn't need to know
   *  about the flip for geometry — only for texture sampling. */
  cx: number;
  cy: number;
  /** When true, the shader samples the atlas region with the corresponding
   *  axis mirrored. All variants of one base shape share the base's
   *  (x, y, w, h) — only the texture sampling differs. */
  flipX: boolean;
  flipY: boolean;
}

// --- Configuration ---

/** Direction quantization step in degrees; must divide 360 evenly. */
const DIRECTION_STEP = 12;
const LABEL_LENGTHS = [1, 2, 3];

interface ShapeVariant {
  /** Direction this variant represents (null = directionless ellipse). */
  deg: number | null;
  /** Flips applied to the base sprite to draw this direction. */
  flipX: boolean;
  flipY: boolean;
}

interface BaseShape {
  /** Direction whose sprite is actually rendered into the atlas. */
  base: number | null;
  /** Every direction (including `base` itself) that draws from this sprite,
   *  possibly with horizontal/vertical flips. */
  variants: ShapeVariant[];
}

/**
 * Compute the table of base shapes to render. We don't render every
 * direction separately: directions related by horizontal/vertical
 * mirroring share a single rendered sprite, and the mirroring is applied
 * at draw time via flipX/flipY in the instance data.
 *
 * For step S, every base direction lies in [0°, 90°]: iterating that
 * range in S-degree increments visits each base exactly once. Each base
 * yields up to 4 mirror variants — the direction itself, its horizontal
 * flip (360 − base), its vertical flip (180 − base), and the 180°
 * rotation (base + 180) — collapsing to 2 at the fixed points 0°
 * (horizontal flip is a no-op) and 90° (vertical flip is a no-op).
 */
function computeBaseShapes(step: number): BaseShape[] {
  if (180 % step !== 0) {
    throw new Error(`DIRECTION_STEP must divide 180, got ${step}`);
  }

  const shapes: BaseShape[] = [
    // The directionless shape (an ellipse) is its own variant.
    { base: null, variants: [{ deg: null, flipX: false, flipY: false }] },
  ];

  for (let baseDeg = 0; baseDeg <= 90; baseDeg += step) {
    const variants: ShapeVariant[] = [];
    const addIfNew = (deg: number, flipX: boolean, flipY: boolean) => {
      const d = deg % 360;
      if (variants.some((v) => v.deg === d)) return;
      variants.push({ deg: d, flipX, flipY });
    };
    addIfNew(baseDeg, false, false);
    addIfNew(360 - baseDeg, true, false);
    addIfNew(180 - baseDeg, false, true);
    addIfNew(baseDeg + 180, true, true);
    shapes.push({ base: baseDeg, variants });
  }

  return shapes;
}

const BASE_SHAPES: BaseShape[] = computeBaseShapes(DIRECTION_STEP);

/** Padding between sprites in the atlas to prevent texture bleed. */
const PACK_PAD = 1;

/** Expected number of unique route labels (~150 in practice, mostly 3-digit). */
const EXPECTED_LABEL_COUNT = 150;

// --- Label slot pre-measurement ---

interface LabelSlotSize {
  tightW: number;
  tightH: number;
  cx: number;
  cy: number;
  fontSize: number;
  shadowBlur: number;
}

function computeLabelSlotSize(dpr: number): LabelSlotSize {
  const fontSize = 13 * dpr;
  const shadowBlur = 2 * dpr;

  const tmpCanvas = document.createElement("canvas");
  const tmpCtx = tmpCanvas.getContext("2d")!;
  tmpCtx.font = `bold ${fontSize}px Arial`;
  tmpCtx.textAlign = "center";
  tmpCtx.textBaseline = "middle";
  const metrics = tmpCtx.measureText("999");

  const textWidth = metrics.width;
  const textHeight =
    metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;

  const fullW = Math.ceil(textWidth + 2 * shadowBlur + 4 + 2);
  const fullH = Math.ceil(textHeight + 2 * shadowBlur + 4);

  const cxCenter = fullW / 2;
  const cyCenter = fullH / 2;
  const labelShadowPad = shadowBlur * 1.3;

  const left = Math.max(
    0,
    Math.floor(cxCenter - metrics.actualBoundingBoxLeft - labelShadowPad),
  );
  const right = Math.max(
    0,
    fullW -
      Math.ceil(cxCenter + metrics.actualBoundingBoxRight + labelShadowPad),
  );
  const top = Math.max(
    0,
    Math.floor(cyCenter - metrics.actualBoundingBoxAscent - labelShadowPad),
  );
  const bottom = Math.max(
    0,
    fullH -
      Math.ceil(cyCenter + metrics.actualBoundingBoxDescent + labelShadowPad),
  );

  return {
    tightW: fullW - left - right,
    tightH: fullH - top - bottom,
    cx: fullW / 2 - left,
    cy: fullH / 2 - top,
    fontSize,
    shadowBlur,
  };
}

// --- Shape geometry constants (CSS pixels, before DPR scaling) ---

/** Ellipse width = SHAPE_BASE_WIDTH + label.length * SHAPE_PER_CHAR_WIDTH. */
const SHAPE_BASE_WIDTH = 19;
const SHAPE_PER_CHAR_WIDTH = 5.5;
const SHAPE_HEIGHT = 28;

/** Ellipse semi-axes used for hit testing, in CSS pixels. */
export function getShapeHitDimensions(labelLength: number): {
  rx: number;
  ry: number;
} {
  return {
    rx: (SHAPE_BASE_WIDTH + labelLength * SHAPE_PER_CHAR_WIDTH) / 2,
    ry: SHAPE_HEIGHT / 2,
  };
}

// --- Shape geometry helpers (used by both MarkerAtlas and computeAtlasDimensions) ---

function computeShapeSizes(labelLength: number, dpr: number) {
  const SHADOW_BLUR = 3 * dpr;
  const MARGIN = 1 * dpr;
  const ARROW_EXTENSION = 6 * dpr;
  const ew = Math.ceil(
    (SHAPE_BASE_WIDTH + labelLength * SHAPE_PER_CHAR_WIDTH) * dpr,
  );
  const eh = Math.ceil(SHAPE_HEIGHT * dpr);

  const baseW = Math.ceil(ew + 2 * MARGIN + 2 * SHADOW_BLUR);
  const baseH = Math.ceil(eh + 2 * MARGIN + 2 * SHADOW_BLUR);
  return {
    ew,
    eh,
    ehw: ew / 2,
    ehh: eh / 2,
    SHADOW_BLUR,
    MARGIN,
    ARROW_EXTENSION,
    nullW: baseW,
    nullH: baseH,
    dirW: Math.ceil(baseW + 2 * ARROW_EXTENSION),
    dirH: Math.ceil(baseH + 2 * ARROW_EXTENSION),
  };
}

function computeShapeAnalyticalBounds(
  sizes: ReturnType<typeof computeShapeSizes>,
  fullW: number,
  fullH: number,
  directionDeg: number | null,
  dpr: number,
): TightBounds {
  const { ehw, ehh, SHADOW_BLUR, ARROW_EXTENSION } = sizes;
  const cx = fullW / 2;
  const cy = fullH / 2;
  const strokePad = 0.25 * dpr;
  const pad = strokePad + SHADOW_BLUR * 1.3;

  let minX: number, maxX: number, minY: number, maxY: number;
  if (directionDeg === null) {
    minX = cx - ehw;
    maxX = cx + ehw;
    minY = cy - ehh;
    maxY = cy + ehh;
  } else {
    const phi = (directionDeg - 90) * (Math.PI / 180);
    const deltaPhi = (50 * Math.PI) / 180;
    const NUM_SAMPLES = 90;
    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;
    for (let i = 0; i <= NUM_SAMPLES; i++) {
      const theta = phi + (i / NUM_SAMPLES) * 2 * Math.PI;
      const r = calculateSimplifiedTeardropRadiusAtAngle(
        theta,
        ehw,
        ehh,
        phi,
        deltaPhi,
        ARROW_EXTENSION,
      );
      const px = cx + r * Math.cos(theta);
      const py = cy + r * Math.sin(theta);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }

  return {
    left: Math.max(0, Math.floor(minX - pad)),
    right: Math.max(0, fullW - Math.ceil(maxX + pad)),
    top: Math.max(0, Math.floor(minY - pad)),
    bottom: Math.max(0, fullH - Math.ceil(maxY + pad)),
  };
}

/**
 * Compute atlas dimensions for a given DPR. The height is sized to hold
 * every base shape sprite plus ~EXPECTED_LABEL_COUNT lazily-added labels,
 * with a 15% margin for strip-packing overhead.
 */
export function computeAtlasDimensions(dpr: number): {
  width: number;
  height: number;
  shapeArea: number;
  labelArea: number;
  totalArea: number;
} {
  const width = dpr > 3 ? 2048 : dpr > 1 ? 1024 : 512;

  // Shape area: compute exact tight size for each base sprite, summed
  // across (label length x highlight) combinations.
  let shapeArea = 0;
  for (const labelLength of LABEL_LENGTHS) {
    const sizes = computeShapeSizes(labelLength, dpr);
    const fullW = sizes.dirW;
    const fullH = sizes.dirH;

    for (const shape of BASE_SHAPES) {
      const bounds = computeShapeAnalyticalBounds(
        sizes,
        fullW,
        fullH,
        shape.base,
        dpr,
      );
      const tightW = fullW - bounds.left - bounds.right;
      const tightH = fullH - bounds.top - bounds.bottom;
      // x2 for highlighted + non-highlighted.
      shapeArea += 2 * (tightW + PACK_PAD) * (tightH + PACK_PAD);
    }
  }

  const labelSlot = computeLabelSlotSize(dpr);
  const labelArea =
    EXPECTED_LABEL_COUNT *
    (labelSlot.tightW + PACK_PAD) *
    (labelSlot.tightH + PACK_PAD);
  const totalArea = (shapeArea + labelArea) * 1.15;
  const height = Math.ceil(totalArea / width);

  return { width, height, shapeArea, labelArea, totalArea };
}

/** Degenerate zero-sized atlas entry, used when a sprite crops to nothing. */
const EMPTY_ENTRY: AtlasEntry = {
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  cx: 0,
  cy: 0,
  flipX: false,
  flipY: false,
};

// --- Tight bounding box ---

interface TightBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Paint a high-contrast transparency backdrop for atlas debugging only. */
function drawDebugBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const size = 16;
  ctx.fillStyle = "#f4f4f4";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#b8b8b8";
  for (let y = 0; y < height; y += size) {
    for (let x = (y / size) % 2 === 0 ? 0 : size; x < width; x += size * 2) {
      ctx.fillRect(x, y, size, size);
    }
  }
}

// --- MarkerAtlas ---

export class MarkerAtlas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly dpr: number;

  // Strip packing state.
  private packX = 0;
  private packY = 0;
  private rowMaxHeight = 0;

  // Leftover rectangles from completed rows (available for smaller sprites).
  private leftovers: Array<{ x: number; y: number; w: number; h: number }> = [];

  // Sprites placed in the current row, for computing vertical gaps on wrap.
  private currentRowSprites: Array<{ x: number; w: number; h: number }> = [];

  private shapes = new Map<string, AtlasEntry>();
  private labels = new Map<string, AtlasEntry>();

  // Pre-allocated label slots (positions computed at construction time).
  private labelSlot: LabelSlotSize;
  private labelSlotPositions: Array<[number, number]> = [];
  private nextLabelSlot = 0;

  /** Bounding box (in atlas pixels) of all changes since the last
   *  `consumeDirtyRect()` call, or `null` if the atlas hasn't changed.
   *  Coordinates are min-inclusive, max-exclusive. */
  private _dirty: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null = null;

  constructor(atlasWidth: number, atlasHeight: number, dpr: number) {
    this.dpr = dpr;
    this.canvas = document.createElement("canvas");
    this.canvas.width = atlasWidth;
    this.canvas.height = atlasHeight;
    this.ctx = this.canvas.getContext("2d")!;

    // Pre-measure label slot size from "999" + leeway.
    this.labelSlot = computeLabelSlotSize(dpr);

    this.renderAllShapes();

    // Labels are dynamic, but their slots are allocated after the icons so
    // they use any leftover space before extending the atlas.
    for (let i = 0; i < EXPECTED_LABEL_COUNT; i++) {
      this.labelSlotPositions.push(
        this.allocate(this.labelSlot.tightW, this.labelSlot.tightH),
      );
    }

    // Force a full upload on the first consumer call.
    this.markDirtyAll();
  }

  // --- Dirty-rect tracking ---

  private markDirty(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const maxX = x + w;
    const maxY = y + h;
    if (this._dirty === null) {
      this._dirty = { minX: x, minY: y, maxX, maxY };
    } else {
      if (x < this._dirty.minX) this._dirty.minX = x;
      if (y < this._dirty.minY) this._dirty.minY = y;
      if (maxX > this._dirty.maxX) this._dirty.maxX = maxX;
      if (maxY > this._dirty.maxY) this._dirty.maxY = maxY;
    }
  }

  private markDirtyAll(): void {
    this._dirty = {
      minX: 0,
      minY: 0,
      maxX: this.canvas.width,
      maxY: this.canvas.height,
    };
  }

  /** Returns the bounding rect of all changes since the last call (and
   *  clears the dirty state), or `null` if the atlas hasn't changed. */
  consumeDirtyRect(): { x: number; y: number; w: number; h: number } | null {
    if (this._dirty === null) return null;
    const { minX, minY, maxX, maxY } = this._dirty;
    this._dirty = null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // --- Strip packing ---

  /** Try to find a leftover rectangle that fits the sprite. Returns its index or -1. */
  private findLeftover(w: number, h: number): number {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < this.leftovers.length; i++) {
      const r = this.leftovers[i];
      if (r.w >= w && r.h >= h) {
        const area = r.w * r.h;
        if (area < bestArea) {
          bestArea = area;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }

  /**
   * Allocate a position in the atlas for a sprite of the given tight
   * dimensions, updating the strip-packer state. Does no drawing.
   */
  private allocate(tightW: number, tightH: number): [number, number] {
    const paddedW = tightW + PACK_PAD;
    const paddedH = tightH + PACK_PAD;

    // Try to fit into a leftover rectangle first.
    const leftoverIdx = this.findLeftover(paddedW, paddedH);
    if (leftoverIdx >= 0) {
      const rect = this.leftovers[leftoverIdx];
      const px = rect.x;
      const py = rect.y;

      // Split remaining space into two leftover rectangles.
      // Choose the cut direction that maximizes the larger leftover's area.
      this.leftovers.splice(leftoverIdx, 1);
      const remainW = rect.w - paddedW;
      const remainH = rect.h - paddedH;

      if (remainW > 0 || remainH > 0) {
        const areaA = Math.max(remainW * rect.h, paddedW * remainH);
        const areaB = Math.max(remainW * paddedH, rect.w * remainH);

        if (areaA >= areaB) {
          if (remainW > 0) {
            this.leftovers.push({
              x: px + paddedW,
              y: py,
              w: remainW,
              h: rect.h,
            });
          }
          if (remainH > 0) {
            this.leftovers.push({
              x: px,
              y: py + paddedH,
              w: paddedW,
              h: remainH,
            });
          }
        } else {
          if (remainW > 0) {
            this.leftovers.push({
              x: px + paddedW,
              y: py,
              w: remainW,
              h: paddedH,
            });
          }
          if (remainH > 0) {
            this.leftovers.push({
              x: px,
              y: py + paddedH,
              w: rect.w,
              h: remainH,
            });
          }
        }
      }

      return [px, py];
    }

    // Wrap to next row if needed.
    if (this.packX + paddedW > this.canvas.width) {
      this.finalizeRow();
    }

    // Grow the canvas if this sprite would overflow the bottom. The initial
    // canvas height is a heuristic upper bound.
    if (this.packY + paddedH > this.canvas.height) {
      this.growCanvasHeight(this.packY + paddedH + 64);
    }

    const px = this.packX;
    const py = this.packY;
    this.currentRowSprites.push({ x: this.packX, w: paddedW, h: paddedH });
    this.packX += paddedW;
    this.rowMaxHeight = Math.max(this.rowMaxHeight, paddedH);
    return [px, py];
  }

  /**
   * Preserve the current atlas contents while growing the canvas height.
   * Costs one getImageData/putImageData roundtrip; called at most a handful
   * of times per atlas build.
   */
  private growCanvasHeight(minHeight: number) {
    if (minHeight <= this.canvas.height) return;
    const oldW = this.canvas.width;
    const oldH = this.canvas.height;
    const preserved = this.ctx.getImageData(0, 0, oldW, oldH);
    this.canvas.height = minHeight;
    this.ctx.putImageData(preserved, 0, 0);
    // Canvas dimensions changed: the texture must be reallocated, so the
    // entire atlas needs reuploading.
    this.markDirtyAll();
  }

  /**
   * Allocate a spot using precomputed tight bounds. Each icon is rasterized
   * into an isolated scratch canvas, then copied into the atlas. This keeps
   * Canvas 2D shadow rendering from leaking between packed sprites.
   */
  private placeSprite(
    fullW: number,
    fullH: number,
    bounds: TightBounds,
    draw: (ctx: CanvasRenderingContext2D, cx: number, cy: number) => void,
  ): AtlasEntry {
    const tightW = Math.max(0, fullW - bounds.left - bounds.right);
    const tightH = Math.max(0, fullH - bounds.top - bounds.bottom);
    if (tightW <= 0 || tightH <= 0) {
      return EMPTY_ENTRY;
    }

    const [px, py] = this.allocate(tightW, tightH);

    // Canvas shadows are clipped at a canvas edge. Keep extra transparent
    // space around the full sprite so the blur kernel is fully rasterized
    // before we crop its tight bounds into the atlas.
    const scratchPadding = Math.ceil(12 * this.dpr);
    const scratch = document.createElement("canvas");
    scratch.width = fullW + 2 * scratchPadding;
    scratch.height = fullH + 2 * scratchPadding;
    const scratchCtx = scratch.getContext("2d")!;
    draw(scratchCtx, scratchPadding + fullW / 2, scratchPadding + fullH / 2);

    this.ctx.drawImage(
      scratch,
      scratchPadding + bounds.left,
      scratchPadding + bounds.top,
      tightW,
      tightH,
      px,
      py,
      tightW,
      tightH,
    );
    this.markDirty(px, py, tightW, tightH);

    return {
      x: px,
      y: py,
      w: tightW,
      h: tightH,
      cx: fullW / 2 - bounds.left,
      cy: fullH / 2 - bounds.top,
      flipX: false,
      flipY: false,
    };
  }

  /** Finalize the current row: emit leftovers for the right edge and vertical gaps. */
  private finalizeRow() {
    if (this.rowMaxHeight === 0) return;

    // Right-edge leftover.
    const remainW = this.canvas.width - this.packX;
    if (remainW > 0) {
      this.leftovers.push({
        x: this.packX,
        y: this.packY,
        w: remainW,
        h: this.rowMaxHeight,
      });
    }

    // Vertical gap leftovers: find contiguous runs of sprites shorter than
    // rowMaxHeight and emit merged rectangles for the gaps below them.
    const sprites = this.currentRowSprites;
    const maxH = this.rowMaxHeight;
    let runStart = -1;
    let runMaxH = 0;

    for (let i = 0; i <= sprites.length; i++) {
      const isShort = i < sprites.length && sprites[i].h < maxH;
      if (isShort) {
        if (runStart < 0) runStart = i;
        runMaxH = Math.max(runMaxH, sprites[i].h);
      } else {
        if (runStart >= 0) {
          // Emit leftover for this run.
          const x = sprites[runStart].x;
          const w = sprites[i - 1].x + sprites[i - 1].w - x;
          const gapH = maxH - runMaxH;
          if (gapH > 0 && w > 0) {
            this.leftovers.push({
              x,
              y: this.packY + runMaxH,
              w,
              h: gapH,
            });
          }
          runStart = -1;
          runMaxH = 0;
        }
      }
    }

    this.packX = 0;
    this.packY += this.rowMaxHeight;
    this.rowMaxHeight = 0;
    this.currentRowSprites = [];
  }

  // --- Shape key ---

  private static shapeKey(
    labelLength: number,
    deg: number | null,
    highlighted: boolean,
  ): string {
    return `s-${labelLength}-${deg}-${highlighted ? 1 : 0}`;
  }

  // --- Pre-render all shapes ---

  private renderAllShapes() {
    // Collect every (label length, base shape, highlight) triplet we'll
    // render, compute its tight bounds analytically, and sort by tight
    // height so the strip-packer places the tallest rows first.
    type ShapeItem = {
      shapeIdx: number;
      labelLength: number;
      highlighted: boolean;
      fullW: number;
      fullH: number;
      bounds: TightBounds;
      draw: (ctx: CanvasRenderingContext2D, cx: number, cy: number) => void;
    };
    const pending: ShapeItem[] = [];
    for (const labelLength of LABEL_LENGTHS) {
      const sizes = computeShapeSizes(labelLength, this.dpr);
      const fullW = sizes.dirW;
      const fullH = sizes.dirH;

      for (let shapeIdx = 0; shapeIdx < BASE_SHAPES.length; shapeIdx++) {
        const baseDeg = BASE_SHAPES[shapeIdx].base;
        const bounds = computeShapeAnalyticalBounds(
          sizes,
          fullW,
          fullH,
          baseDeg,
          this.dpr,
        );
        for (const highlighted of [false, true]) {
          pending.push({
            shapeIdx,
            labelLength,
            highlighted,
            fullW,
            fullH,
            bounds,
            draw: (ctx, cx, cy) =>
              this.drawShapeOnCtx(ctx, cx, cy, sizes, baseDeg),
          });
        }
      }
    }

    pending.sort((a, b) => {
      const ah = a.fullH - a.bounds.top - a.bounds.bottom;
      const bh = b.fullH - b.bounds.top - b.bounds.bottom;
      return bh - ah;
    });

    // Render each base sprite, then register entries for every variant
    // (the base itself plus its mirror images) by reusing the base's
    // (x, y, w, h) and setting flipX/flipY flags. Variants cost nothing
    // extra in atlas memory.
    for (const item of pending) {
      const baseEntry = this.placeSprite(
        item.fullW,
        item.fullH,
        item.bounds,
        item.draw,
      );
      const shape = BASE_SHAPES[item.shapeIdx];
      for (const variant of shape.variants) {
        const key = MarkerAtlas.shapeKey(
          item.labelLength,
          variant.deg,
          item.highlighted,
        );
        this.shapes.set(key, {
          x: baseEntry.x,
          y: baseEntry.y,
          w: baseEntry.w,
          h: baseEntry.h,
          cx: variant.flipX ? baseEntry.w - baseEntry.cx : baseEntry.cx,
          cy: variant.flipY ? baseEntry.h - baseEntry.cy : baseEntry.cy,
          flipX: variant.flipX,
          flipY: variant.flipY,
        });
      }
    }
  }

  // --- Draw a single shape sprite on a given context ---

  private drawShapeOnCtx(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sizes: ReturnType<typeof computeShapeSizes>,
    directionDeg: number | null,
  ) {
    const { ehw, ehh, SHADOW_BLUR, ARROW_EXTENSION } = sizes;
    const dpr = this.dpr;

    // IMPORTANT: Render shapes in WHITE fill with BLACK border.
    // The shader will tint the white parts, but black stays black (0 * color = 0).
    // This allows dynamic coloring while keeping borders black.
    const fillColor = "#FFFFFF"; // Always white - will be tinted by shader
    const strokeColor = "#000000"; // Always black - stays black after tint

    ctx.save();

    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = SHADOW_BLUR;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath();

    if (directionDeg != null) {
      const phi = (directionDeg - 90) * (Math.PI / 180);
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
          ARROW_EXTENSION,
        );
        const px = cx + r * Math.cos(theta);
        const py = cy + r * Math.sin(theta);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.ellipse(cx, cy, ehw, ehh, 0, 0, Math.PI * 2);
    }

    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // --- Public API ---

  /** Read a rectangle of atlas pixels for GPU upload. */
  readPixels(x: number, y: number, w: number, h: number): ImageData {
    return this.ctx.getImageData(x, y, w, h);
  }

  /** Get the atlas entry for a shape sprite. Direction is rounded internally. */
  getShape(
    labelLength: number,
    directionDeg: number | null,
    highlighted: boolean,
  ): AtlasEntry {
    let roundedDeg: number | null = null;
    if (directionDeg != null) {
      roundedDeg =
        (((Math.round(directionDeg / DIRECTION_STEP) * DIRECTION_STEP) % 360) +
          360) %
        360;
    }
    const key = MarkerAtlas.shapeKey(labelLength, roundedDeg, highlighted);
    const entry = this.shapes.get(key);
    if (!entry) {
      throw new Error(`Shape not found: ${key}`);
    }
    return entry;
  }

  /** Get or create the atlas entry for a route label. */
  getOrCreateLabel(label: string): AtlasEntry {
    const existing = this.labels.get(label);
    if (existing) return existing;

    const slot = this.labelSlot;
    let px: number, py: number;

    if (this.nextLabelSlot < this.labelSlotPositions.length) {
      [px, py] = this.labelSlotPositions[this.nextLabelSlot++];
    } else {
      // Overflow: allocate dynamically (shouldn't happen in normal use).
      [px, py] = this.allocate(slot.tightW, slot.tightH);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, slot.tightW, slot.tightH);
    ctx.clip();
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `bold ${slot.fontSize}px Arial`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = slot.shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(label, px + slot.cx, py + slot.cy);
    ctx.restore();
    this.markDirty(px, py, slot.tightW, slot.tightH);

    const entry: AtlasEntry = {
      x: px,
      y: py,
      w: slot.tightW,
      h: slot.tightH,
      cx: slot.cx,
      cy: slot.cy,
      flipX: false,
      flipY: false,
    };
    this.labels.set(label, entry);
    return entry;
  }
}

// --- In-app debug view ---

/** Open a live atlas inspector over the map without leaving the application. */
export function openAtlasDebugOverlay(atlas: MarkerAtlas) {
  if (!__DEV__) return;

  document
    .getElementById("atlas-debug-overlay")
    ?.dispatchEvent(new Event("atlas-debug-close"));

  const overlay = document.createElement("div");
  overlay.id = "atlas-debug-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;" +
    "justify-content:center;padding:16px;background:rgba(0,0,0,.65);";

  const panel = document.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;box-sizing:border-box;" +
    "width:calc(100vw - 32px);max-width:calc(100vw - 32px);" +
    "height:calc(100vh - 32px);min-height:0;padding:16px;overflow:hidden;" +
    "background:#111;color:#fff;border:1px solid #666;border-radius:4px;" +
    "font-family:monospace;";
  overlay.appendChild(panel);

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:16px;" +
    "margin-bottom:12px;";
  panel.appendChild(header);

  const heading = document.createElement("strong");
  heading.textContent = `Live atlas (${atlas.canvas.width}x${atlas.canvas.height})`;
  header.appendChild(heading);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.style.cssText = "padding:6px 10px;cursor:pointer;";
  header.appendChild(closeButton);

  const viewport = document.createElement("div");
  viewport.style.cssText =
    "flex:1 1 auto;min-width:0;min-height:0;overflow:auto;border:1px solid #555;";
  panel.appendChild(viewport);

  const liveCanvas = document.createElement("canvas");
  liveCanvas.width = atlas.canvas.width;
  liveCanvas.height = atlas.canvas.height;
  liveCanvas.style.cssText =
    `display:block;width:${atlas.canvas.width / atlas.dpr}px;` +
    `height:${atlas.canvas.height / atlas.dpr}px;`;
  viewport.appendChild(liveCanvas);

  const liveCtx = liveCanvas.getContext("2d")!;
  const refresh = () => {
    drawDebugBackdrop(liveCtx, liveCanvas.width, liveCanvas.height);
    liveCtx.drawImage(atlas.canvas, 0, 0);
  };
  refresh();
  const interval = setInterval(refresh, 1000);
  const close = () => {
    clearInterval(interval);
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  closeButton.addEventListener("click", close);
  overlay.addEventListener("atlas-debug-close", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.appendChild(overlay);
  closeButton.focus();
}
