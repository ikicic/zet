import maplibregl from "maplibre-gl";
import { Vehicle, RouteId, Shape } from "./Data";
import {
  MarkerAtlas,
  computeAtlasDimensions,
  getShapeHitDimensions,
  openAtlasDebugOverlay,
} from "./MarkerAtlas";
import { WebGLMarkerRenderer } from "./WebGLMarkerRenderer";
import { TrajectoryLayer } from "./TrajectoryLayer";
import { getMapDpr } from "./url";

export interface VehicleLayerOptions {
  onVehicleClick: (vehicle: Vehicle) => void;
  onNothingClick: () => void;
  measureInitialAtlasBuild?: boolean;
}

interface RenderedVehicle {
  vehicle: Vehicle;
  x: number;
  y: number;
  shapeHalfW: number;
  shapeHalfH: number;
}

interface LastState {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  width: number;
  height: number;
  vehicles: Vehicle[];
  filterSelection: Set<RouteId>;
  highlightedRouteId: RouteId | null;
  selectedShape: Shape | null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1: number, g1: number, b1: number;
  if (h >= 0 && h < 60) {
    [r1, g1, b1] = [c, x, 0];
  } else if (h >= 60 && h < 120) {
    [r1, g1, b1] = [x, c, 0];
  } else if (h >= 120 && h < 180) {
    [r1, g1, b1] = [0, c, x];
  } else if (h >= 180 && h < 240) {
    [r1, g1, b1] = [0, x, c];
  } else if (h >= 240 && h < 300) {
    [r1, g1, b1] = [x, 0, c];
  } else {
    [r1, g1, b1] = [c, 0, x];
  }

  return [r1 + m, g1 + m, b1 + m];
}

const TRAM_COLOR = hslToRgb(207, 0.9, 0.54);
const HIGHLIGHTED_TRAM_COLOR = hslToRgb(7, 0.898, 0.539);
const BUS_COLOR = hslToRgb(212, 0.8, 0.42);
const HIGHLIGHTED_BUS_COLOR = hslToRgb(12, 0.804, 0.42);

export class VehicleLayer {
  private _atlas: MarkerAtlas | null = null;
  private atlasDpr = 0;
  private markerLayer: WebGLMarkerRenderer;
  private trajectoryLayer: TrajectoryLayer;
  private map: maplibregl.Map;
  private options: VehicleLayerOptions;
  private measureInitialAtlasBuild: boolean;

  private vehicles: Vehicle[] = [];
  private filterSelection: Set<RouteId> = new Set();
  private highlightedRouteId: RouteId | null = null;
  private selectedShape: Shape | null = null;
  private debugLabels: string[] = [];

  private lastRendered: RenderedVehicle[] = [];
  private lastState: LastState | null = null;
  private _initialAtlasBuildMs: number | null = null;
  private readonly onResize = () => this.ensureAtlas();

  get initialAtlasBuildMs(): number | null {
    return this._initialAtlasBuildMs;
  }

  get atlas(): MarkerAtlas {
    if (!this._atlas) {
      throw new Error("Marker atlas not initialized");
    }
    return this._atlas;
  }

  constructor(map: maplibregl.Map, options: VehicleLayerOptions) {
    this.map = map;
    this.options = options;
    this.measureInitialAtlasBuild = options.measureInitialAtlasBuild === true;

    this.trajectoryLayer = new TrajectoryLayer();
    this.markerLayer = new WebGLMarkerRenderer();
    this.markerLayer.setFrameBuilder(() => this.buildMarkers());
    this.markerLayer.setBetweenMarkerGroups((gl) =>
      this.trajectoryLayer.renderSelectedShape(gl),
    );

    map.addLayer(this.trajectoryLayer);
    map.addLayer(this.markerLayer);

    this.ensureAtlas();
    map.on("resize", this.onResize);

    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);

    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);
  }

  destroy() {
    this.map.off("resize", this.onResize);
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMouseMove);
    if (this.map.getLayer(this.markerLayer.id)) {
      this.map.removeLayer(this.markerLayer.id);
    }
    if (this.map.getLayer(this.trajectoryLayer.id)) {
      this.map.removeLayer(this.trajectoryLayer.id);
    }
  }

  setData(
    vehicles: Vehicle[],
    filterSelection: Set<RouteId>,
    highlightedRouteId: RouteId | null,
    selectedShape: Shape | null,
  ) {
    this.vehicles = vehicles;
    this.filterSelection = filterSelection;
    this.highlightedRouteId = highlightedRouteId;
    this.selectedShape = selectedShape;

    this.trajectoryLayer.setData(
      vehicles,
      filterSelection,
      highlightedRouteId,
      selectedShape,
    );
    this.map.triggerRepaint();
  }

  openAtlasDebugOverlay() {
    if (this._atlas) {
      openAtlasDebugOverlay(this._atlas);
    }
  }

  /** Add synthetic labels to exercise incremental atlas uploads in development. */
  addDebugLabels() {
    if (!__DEV__) return;

    const start = this.debugLabels.length;
    for (let i = 0; i < 6; i++) {
      this.debugLabels.push(
        `X${((start + i) % 100).toString().padStart(2, "0")}`,
      );
    }
    this.lastState = null;
    this.map.triggerRepaint();
  }

  /** (Re)build the atlas when the map's pixel ratio is known or changes. */
  private ensureAtlas() {
    const dpr = getMapDpr();
    if (this._atlas && this.atlasDpr === dpr) {
      return;
    }

    const { width: atlasWidth, height: atlasHeight } =
      computeAtlasDimensions(dpr);
    const atlasStart = this.measureInitialAtlasBuild ? performance.now() : 0;
    this._atlas = new MarkerAtlas(atlasWidth, atlasHeight, dpr);
    if (this.measureInitialAtlasBuild && this._initialAtlasBuildMs === null) {
      this._initialAtlasBuildMs = performance.now() - atlasStart;
    }
    this.atlasDpr = dpr;
    this.markerLayer.setAtlas(this._atlas);
    this.lastState = null;
  }

  private getBaseColor(
    vehicle: Vehicle,
    isHighlighted: boolean,
  ): [number, number, number] {
    const isTram = vehicle.routeId.toString().length < 3;
    return isHighlighted
      ? isTram
        ? HIGHLIGHTED_TRAM_COLOR
        : HIGHLIGHTED_BUS_COLOR
      : isTram
        ? TRAM_COLOR
        : BUS_COLOR;
  }

  private getVehicleColor(
    vehicle: Vehicle,
    isHighlighted: boolean,
  ): [number, number, number, number] {
    const base = this.getBaseColor(vehicle, isHighlighted);
    return [base[0], base[1], base[2], 1.0];
  }

  /** Rebuild marker instances using the map transform for this frame. */
  private buildMarkers() {
    this.ensureAtlas();

    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    const canvas = this.map.getCanvas();
    const width = canvas.width;
    const height = canvas.height;

    if (
      this.lastState &&
      this.lastState.lng === center.lng &&
      this.lastState.lat === center.lat &&
      this.lastState.zoom === zoom &&
      this.lastState.bearing === bearing &&
      this.lastState.pitch === pitch &&
      this.lastState.width === width &&
      this.lastState.height === height &&
      this.lastState.vehicles === this.vehicles &&
      this.lastState.filterSelection === this.filterSelection &&
      this.lastState.highlightedRouteId === this.highlightedRouteId &&
      this.lastState.selectedShape === this.selectedShape
    ) {
      return;
    }

    this.lastState = {
      lng: center.lng,
      lat: center.lat,
      zoom,
      bearing,
      pitch,
      width,
      height,
      vehicles: this.vehicles,
      filterSelection: this.filterSelection,
      highlightedRouteId: this.highlightedRouteId,
      selectedShape: this.selectedShape,
    };

    const dpr = getMapDpr();
    const unselected: Vehicle[] = [];
    const highlighted: Vehicle[] = [];

    for (const vehicle of this.vehicles) {
      const isHighlighted =
        this.highlightedRouteId !== null &&
        vehicle.routeId === this.highlightedRouteId;
      const hidden =
        this.filterSelection.size > 0 &&
        !this.filterSelection.has(vehicle.routeId);
      if (hidden && !isHighlighted) continue;

      if (isHighlighted) {
        highlighted.push(vehicle);
      } else {
        unselected.push(vehicle);
      }
    }

    unselected.sort((a, b) => b.routeId - a.routeId);
    highlighted.sort((a, b) => b.routeId - a.routeId);

    this.markerLayer.beginFrame(
      2 * (unselected.length + highlighted.length + this.debugLabels.length),
    );
    this.lastRendered = [];

    const addVehicle = (vehicle: Vehicle, isHighlighted: boolean) => {
      const lon = vehicle.lon[vehicle.lon.length - 1];
      const lat = vehicle.lat[vehicle.lat.length - 1];
      const pixel = this.map.project([lon, lat]);

      if (
        pixel.x < -100 ||
        pixel.x > width / dpr + 100 ||
        pixel.y < -100 ||
        pixel.y > height / dpr + 100
      ) {
        return;
      }

      const label = vehicle.routeId.toString();
      const labelLength = label.length;
      const deg = vehicle.directionDegrees ?? null;

      const shapeEntry = this.atlas.getShape(labelLength, deg, isHighlighted);
      const labelEntry = this.atlas.getOrCreateLabel(label);

      const sx = pixel.x * dpr;
      const sy = pixel.y * dpr;
      const vehicleColor = this.getVehicleColor(vehicle, isHighlighted);

      // The icon is tinted, then the white route label is composited on top.
      this.markerLayer.addInstance(sx, sy, shapeEntry, vehicleColor);
      this.markerLayer.addInstance(sx, sy, labelEntry, [1, 1, 1, 1]);

      const { rx, ry } = getShapeHitDimensions(labelLength);
      this.lastRendered.push({
        vehicle,
        x: pixel.x,
        y: pixel.y,
        shapeHalfW: rx,
        shapeHalfH: ry,
      });
    };

    for (const vehicle of unselected) {
      addVehicle(vehicle, false);
    }
    this.markerLayer.finishUnselectedMarkers();
    for (const vehicle of highlighted) {
      addVehicle(vehicle, true);
    }

    for (let i = 0; i < this.debugLabels.length; i++) {
      const label = this.debugLabels[i];
      const x = width / dpr / 2 + (i % 3) * 64 - 64;
      const y = height / dpr / 2 + Math.floor(i / 3) * 52 - 26;
      const shapeEntry = this.atlas.getShape(3, null, false);
      const labelEntry = this.atlas.getOrCreateLabel(label);
      this.markerLayer.addInstance(x * dpr, y * dpr, shapeEntry, [
        ...BUS_COLOR,
        1,
      ]);
      this.markerLayer.addInstance(x * dpr, y * dpr, labelEntry, [1, 1, 1, 1]);
    }
  }

  private handleClick(e: maplibregl.MapMouseEvent) {
    const mouseX = e.point.x;
    const mouseY = e.point.y;

    for (let i = this.lastRendered.length - 1; i >= 0; i--) {
      const entry = this.lastRendered[i];
      const dx = mouseX - entry.x;
      const dy = mouseY - entry.y;
      const rx2 = entry.shapeHalfW * entry.shapeHalfW;
      const ry2 = entry.shapeHalfH * entry.shapeHalfH;
      if (dx * dx * ry2 + dy * dy * rx2 <= rx2 * ry2) {
        this.options.onVehicleClick(entry.vehicle);
        return;
      }
    }
    this.options.onNothingClick();
  }

  private handleMouseMove(e: maplibregl.MapMouseEvent) {
    const mouseX = e.point.x;
    const mouseY = e.point.y;

    for (let i = this.lastRendered.length - 1; i >= 0; i--) {
      const entry = this.lastRendered[i];
      const dx = mouseX - entry.x;
      const dy = mouseY - entry.y;
      const rx2 = entry.shapeHalfW * entry.shapeHalfW;
      const ry2 = entry.shapeHalfH * entry.shapeHalfH;
      if (dx * dx * ry2 + dy * dy * rx2 <= rx2 * ry2) {
        this.map.getCanvas().style.cursor = "pointer";
        return;
      }
    }
    this.map.getCanvas().style.cursor = "";
  }
}
