import maplibregl from "maplibre-gl";
import { Vehicle, RouteId, Shape } from "./Data";
import { MarkerManager, MarkerProperties, Marker } from "./Markers";

export interface VehicleLayerOptions {
  onVehicleClick: (vehicle: Vehicle) => void;
  onNothingClick: () => void;
}

interface RenderedMarker {
  vehicle: Vehicle;
  x: number;
  y: number;
  marker: Marker;
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

export class VehicleLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: maplibregl.Map;
  private markerManager: MarkerManager;

  private vehicles: Vehicle[] = [];
  private filterSelection: Set<RouteId> = new Set();
  private highlightedRouteId: RouteId | null = null;
  private selectedShape: Shape | null = null;

  private options: VehicleLayerOptions;

  // For click handling.
  private lastRenderedMarkers: Array<RenderedMarker> = [];

  // For skipping renders if nothing has changed, since Maplibre may call render
  // multiple times to handle fade in/out animation.
  private lastState: LastState | null = null;

  constructor(
    map: maplibregl.Map,
    markerManager: MarkerManager,
    options: VehicleLayerOptions
  ) {
    this.map = map;
    this.markerManager = markerManager;
    this.options = options;

    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none"; // Clicks are handled via map listener
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";

    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.handleResize = this.handleResize.bind(this);
    this.render = this.render.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);

    map.on("resize", this.handleResize);
    map.on("render", this.render);
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);

    this.handleResize();
  }

  public destroy() {
    this.map.off("resize", this.handleResize);
    this.map.off("render", this.render);
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMouseMove);
    this.canvas.remove();
  }

  public setData(
    vehicles: Vehicle[],
    filterSelection: Set<RouteId>,
    highlightedRouteId: RouteId | null,
    selectedShape: Shape | null
  ) {
    this.vehicles = vehicles;
    this.filterSelection = filterSelection;
    this.highlightedRouteId = highlightedRouteId;
    this.selectedShape = selectedShape;
    this.render();
  }

  private handleResize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.map.getContainer().getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.render();
  }

  private handleClick(e: maplibregl.MapMouseEvent) {
    const mouseX = e.point.x;
    const mouseY = e.point.y;

    // Search from top to bottom (last rendered is on top)
    for (let i = this.lastRenderedMarkers.length - 1; i >= 0; i--) {
      const entry = this.lastRenderedMarkers[i];
      const dx = mouseX - entry.x;
      const dy = mouseY - entry.y;

      if (entry.marker.shape.isWithinShape(dx, dy)) {
        this.options.onVehicleClick(entry.vehicle);
        return;
      }
    }
    this.options.onNothingClick();
  }

  private handleMouseMove(e: maplibregl.MapMouseEvent) {
    const mouseX = e.point.x;
    const mouseY = e.point.y;

    for (let i = this.lastRenderedMarkers.length - 1; i >= 0; i--) {
      const entry = this.lastRenderedMarkers[i];
      if (
        entry.marker.shape.isWithinShape(mouseX - entry.x, mouseY - entry.y)
      ) {
        this.map.getCanvas().style.cursor = "pointer";
        return;
      }
    }
    this.map.getCanvas().style.cursor = "";
  }

  private render() {
    if (!this.ctx || !this.map) return;

    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Skip render if nothing has changed (camera or data)
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

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastRenderedMarkers = [];

    const unselectedVehicles: Vehicle[] = [];
    const highlightedVehicles: Vehicle[] = [];
    const visibleVehicles: Vehicle[] = [];
    for (const vehicle of this.vehicles) {
      const highlighted =
        this.highlightedRouteId !== null &&
        vehicle.routeId === this.highlightedRouteId;
      const hidden =
        this.filterSelection.size > 0 &&
        !this.filterSelection.has(vehicle.routeId);

      if (hidden && !highlighted) continue;

      visibleVehicles.push(vehicle);
      if (highlighted) {
        highlightedVehicles.push(vehicle);
      } else {
        unselectedVehicles.push(vehicle);
      }
    }

    // Sort by label (smaller number is on top)
    unselectedVehicles.sort((a, b) => b.routeId - a.routeId);
    highlightedVehicles.sort((a, b) => b.routeId - a.routeId);

    // 0. Draw trajectories
    this.drawTrajectories(visibleVehicles);

    // 1. Draw unselected vehicles
    for (const vehicle of unselectedVehicles) {
      this.drawVehicle(vehicle, false);
    }

    // 2. Draw selected route line
    if (this.selectedShape) {
      this.drawSelectedShape();
    }

    // 3. Draw highlighted vehicles
    for (const vehicle of highlightedVehicles) {
      this.drawVehicle(vehicle, true);
    }
  }

  private drawTrajectories(vehicles: Vehicle[]) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = "#ff6464";
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const vehicle of vehicles) {
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < vehicle.lon.length; i++) {
        const pixel = this.map.project([vehicle.lon[i], vehicle.lat[i]]);
        if (first) {
          ctx.moveTo(pixel.x * dpr, pixel.y * dpr);
          first = false;
        } else {
          ctx.lineTo(pixel.x * dpr, pixel.y * dpr);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSelectedShape() {
    if (!this.selectedShape) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const shape = this.selectedShape;

    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    let first = true;
    for (let i = 0; i < shape.lons.length; i++) {
      const pixel = this.map.project([shape.lons[i], shape.lats[i]]);
      if (first) {
        ctx.moveTo(pixel.x * dpr, pixel.y * dpr);
        first = false;
      } else {
        ctx.lineTo(pixel.x * dpr, pixel.y * dpr);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawVehicle(vehicle: Vehicle, highlighted: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const lon = vehicle.lon[vehicle.lon.length - 1];
    const lat = vehicle.lat[vehicle.lat.length - 1];

    const pixel = this.map.project([lon, lat]);

    // Basic culling: skip if significantly outside the viewport
    if (
      pixel.x < -100 ||
      pixel.x > this.canvas.width / dpr + 100 ||
      pixel.y < -100 ||
      pixel.y > this.canvas.height / dpr + 100
    ) {
      return;
    }

    // Round the angle just like in the original code for better caching
    let deg = null;
    if (vehicle.directionDegrees != null) {
      deg = Math.round(vehicle.directionDegrees / 12) * 12;
    }

    const markerProperties: MarkerProperties = {
      label: vehicle.routeId.toString(),
      directionDegrees: deg,
      highlighted: highlighted,
    };

    const marker = this.markerManager.getOrCreate(markerProperties);

    const sprite = marker.canvas;
    const sw = sprite.width;
    const sh = sprite.height;

    // Draw centered on the projected point
    this.ctx.drawImage(
      sprite,
      pixel.x * dpr - sw / 2,
      pixel.y * dpr - sh / 2,
      sw,
      sh
    );

    this.lastRenderedMarkers.push({
      vehicle,
      x: pixel.x,
      y: pixel.y,
      marker,
    });
  }
}
