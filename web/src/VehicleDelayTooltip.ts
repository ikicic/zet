import * as maplibregl from "maplibre-gl";
import { Vehicle } from "./Data";
import { formatDuration } from "./formatDuration";
import {
  getEffectiveVehicleDelay,
  STALE_FADE_START_SECONDS,
} from "./VehicleDelay";
import { getShapeHitDimensions } from "./MarkerAtlas";
import "./VehicleDelayTooltip.css";

/** A small popup above the selected vehicle showing how delayed its data is. */
export class VehicleDelayTooltip {
  private map: maplibregl.Map;
  private popup: maplibregl.Popup | null = null;

  constructor(map: maplibregl.Map) {
    this.map = map;
  }

  /** Show the delay only once the marker starts fading to gray. */
  setVehicle(vehicle: Vehicle | null, feedAge = 0) {
    const delay = vehicle ? getEffectiveVehicleDelay(vehicle, feedAge) : 0;
    if (
      !vehicle ||
      (!vehicle.hasInvalidTimestamp && delay <= STALE_FADE_START_SECONDS)
    ) {
      this.popup?.remove();
      this.popup = null;
      return;
    }
    const { ry } = getShapeHitDimensions(vehicle.routeId.toString().length);
    if (!this.popup) {
      this.popup = new maplibregl.Popup({
        anchor: "bottom",
        closeButton: false,
        closeOnClick: false,
        className: "vehicle-delay-tooltip",
        maxWidth: "none",
      });
    }
    this.popup
      .setOffset(ry + 4)
      .setLngLat([
        vehicle.lon[vehicle.lon.length - 1],
        vehicle.lat[vehicle.lat.length - 1],
      ])
      .setText(
        vehicle.hasInvalidTimestamp
          ? "Neispravno vrijeme podataka"
          : `Podaci kasne: ${vehicle.reportDelay == null ? "najmanje " : ""}${formatDuration(Math.round(delay))}`,
      );
    if (!this.popup.isOpen()) this.popup.addTo(this.map);
  }
}
