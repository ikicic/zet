import type { Vehicle } from "./Data";

export const STALE_FADE_START_SECONDS = 75;
export const STALE_FADE_END_SECONDS = 90;

/** Seconds since the latest feed was produced, including time without messages. */
export function getFeedAge(
  feedTimestamp: number,
  now = Date.now() / 1000,
): number {
  return Math.max(0, now - feedTimestamp);
}

/** Report delay is relative to feed time, so feed age is added exactly once. */
export function getEffectiveVehicleDelay(
  vehicle: Vehicle,
  feedAge: number,
): number {
  return Math.max(0, vehicle.reportDelay ?? 0) + Math.max(0, feedAge);
}
