// Runs in Chrome from make test, using synthetic route labels.
module.exports = function atlasTests() {
  const { MarkerAtlas, computeAtlasDimensions } = window.markerModules;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  for (const dpr of [1, 1.25, 2, 3.25, 4]) {
    const { width, height } = computeAtlasDimensions(dpr);
    const scratchSources = new Set();
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    let atlas;
    try {
      CanvasRenderingContext2D.prototype.drawImage = function (
        source,
        ...args
      ) {
        if (source instanceof HTMLCanvasElement) scratchSources.add(source);
        return drawImage.call(this, source, ...args);
      };
      atlas = new MarkerAtlas(width, height, dpr);
    } finally {
      CanvasRenderingContext2D.prototype.drawImage = drawImage;
    }
    check(scratchSources.size === 1, "Shapes did not share a scratch canvas");
    check(
      [...scratchSources].every((canvas) => !canvas.width && !canvas.height),
      "Scratch pixels were retained after atlas construction",
    );

    // Preserve every shape before adding labels to detect packing collisions.
    const sprites = new Map();
    const remember = (entry) => {
      check(
        entry.x >= 0 &&
          entry.y >= 0 &&
          entry.w > 0 &&
          entry.h > 0 &&
          entry.x + entry.w <= atlas.canvas.width &&
          entry.y + entry.h <= atlas.canvas.height,
        "Sprite lies outside the atlas",
      );
      const key = `${entry.x},${entry.y},${entry.w},${entry.h}`;
      if (!sprites.has(key)) {
        const pixels = atlas.readPixels(
          entry.x,
          entry.y,
          entry.w,
          entry.h,
        ).data;
        check(
          pixels.some((v, i) => i % 4 === 3 && v > 0),
          "Empty sprite",
        );
        sprites.set(key, { entry, pixels });
      }
    };
    for (const length of new Set(
      window.atlasRouteLabels.map((s) => s.length),
    )) {
      remember(atlas.getShape(length, null, false));
      remember(atlas.getShape(length, null, true));
      for (let angle = 0; angle < 360; angle += 12) {
        remember(atlas.getShape(length, angle, false));
        remember(atlas.getShape(length, angle, true));
      }
    }
    for (const label of window.atlasRouteLabels) {
      const entry = atlas.getOrCreateLabel(label);
      check(
        atlas.getOrCreateLabel(label) === entry,
        "Label was allocated twice",
      );
      remember(entry);
    }
    for (const { entry, pixels } of sprites.values()) {
      const current = atlas.readPixels(entry.x, entry.y, entry.w, entry.h).data;
      check(
        current.every((v, i) => v === pixels[i]),
        "Packing overwrote a sprite",
      );
    }
    check(
      atlas.canvas.width === width && atlas.canvas.height === height,
      "The synthetic route-label set forced an atlas resize",
    );
    passed.push(
      `DPR ${dpr}: all ${window.atlasRouteLabels.length} synthetic labels and directions fit without growth or overwriting sprites; one reusable scratch canvas`,
    );
    atlas.canvas.width = atlas.canvas.height = 0;
  }
  return passed;
};
