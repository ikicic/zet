export type ShapeId = string;
export type RouteId = number;

export interface Shape {
  id: ShapeId;
  lats: number[];
  lons: number[];
}

export interface BigStaticData {
  shapes: { [key: ShapeId]: Shape };
}

export interface SmallStaticData {
  routeIds: RouteId[];
}

interface CompressedShapes {
  ids: ShapeId[];
  compressedLats: number[][];
  compressedLons: number[][];
}

interface CompressedRoutes {
  ids: RouteId[];
}

export interface CompressedBigStaticData {
  shapes: CompressedShapes;
}

export interface CompressedSmallStaticData {
  routes: CompressedRoutes;
}

export interface Vehicle {
  routeId: RouteId;
  shapeId: ShapeId;
  lat: number[];
  lon: number[];
  timestamp: number;
  directionDegrees: number | null;
}

export interface RealTimeState {
  vehicles: Vehicle[];
  timestamp: number;
  activeStaticKey: string;
}

export interface CompressedVehicles {
  routeIds: RouteId[];
  shapeIds: ShapeId[];
  timestamps: number[];
  compressedLats: number[][];
  compressedLons: number[][];
  directionDegrees: number[];
}

export interface CompressedRealTimeState {
  vehicles: CompressedVehicles;
  timestamp: number;
  activeStaticKey: string;
}

class StaticReferenceSystem {
  coord_num_digits: number;
  ref_lat: number;
  ref_lon: number;

  constructor(coord_num_digits: number, ref_lat: number, ref_lon: number) {
    this.coord_num_digits = coord_num_digits;
    this.ref_lat = ref_lat;
    this.ref_lon = ref_lon;
  }

  _decompress_coords(ref_value: number, coords: number[]): number[] {
    const out = [];
    const inv_scale = Math.pow(10, -this.coord_num_digits);
    for (const coord of coords) {
      const value = ref_value + coord * inv_scale;
      out.push(value);
      ref_value = value;
    }
    return out;
  }

  decompress_lats(lats: number[]): number[] {
    return this._decompress_coords(this.ref_lat, lats);
  }

  decompress_lons(lons: number[]): number[] {
    return this._decompress_coords(this.ref_lon, lons);
  }
}

const STATIC_REFERENCE_SYSTEM = new StaticReferenceSystem(6, 45.815, 15.9819);

function decompressVehicles(data: CompressedVehicles): Vehicle[] {
  const vehicles: Vehicle[] = [];
  for (let i = 0, n = data.routeIds.length; i < n; ++i) {
    vehicles.push({
      routeId: data.routeIds[i],
      shapeId: data.shapeIds[i],
      lat: STATIC_REFERENCE_SYSTEM.decompress_lats(data.compressedLats[i]),
      lon: STATIC_REFERENCE_SYSTEM.decompress_lons(data.compressedLons[i]),
      timestamp: data.timestamps[i],
      directionDegrees: data.directionDegrees[i],
    });
  }
  return vehicles;
}

export function decompressRealTimeState(
  data: CompressedRealTimeState
): RealTimeState {
  return {
    vehicles: decompressVehicles(data.vehicles),
    timestamp: data.timestamp,
    activeStaticKey: data.activeStaticKey,
  };
}

export function decompressBigStaticData(
  data: CompressedBigStaticData
): BigStaticData {
  const shapes: { [key: ShapeId]: Shape } = {};
  for (let i = 0, n = data.shapes.ids.length; i < n; ++i) {
    const shapeId = data.shapes.ids[i];
    shapes[shapeId] = {
      id: shapeId,
      lats: STATIC_REFERENCE_SYSTEM.decompress_lats(
        data.shapes.compressedLats[i]
      ),
      lons: STATIC_REFERENCE_SYSTEM.decompress_lons(
        data.shapes.compressedLons[i]
      ),
    };
  }
  return { shapes };
}

export function decompressSmallStaticData(
  data: CompressedSmallStaticData
): SmallStaticData {
  return {
    routeIds: data.routes.ids,
  };
}
