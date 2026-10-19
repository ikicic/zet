import { Vehicle } from "./Data";

export function findSelectedVehicle(
  vehicles: Vehicle[],
  selected: Vehicle | null,
): Vehicle | null {
  if (!selected) return null;
  // Prefer the physical vehicle so selection survives a change of trip.
  // If several vehicles match, take the most recently reported one.
  let match: Vehicle | null = null;
  for (const vehicle of vehicles) {
    const matches = selected.vehicleId
      ? vehicle.vehicleId === selected.vehicleId
      : selected.tripId
        ? vehicle.tripId === selected.tripId
        : vehicle === selected;
    if (matches && (match === null || vehicle.timestamp > match.timestamp)) {
      match = vehicle;
    }
  }
  return match;
}
