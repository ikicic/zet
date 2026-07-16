import type maplibregl from "maplibre-gl";

export function getMapDpr(): number {
  return window.devicePixelRatio || 1;
}

export function getMapCanvasDpr(
  map: maplibregl.Map | null | undefined,
): number {
  if (!map) {
    return window.devicePixelRatio || 1;
  }
  const cssWidth = map.getContainer()?.clientWidth ?? 0;
  if (cssWidth > 0) {
    return map.getCanvas().width / cssWidth;
  }
  return window.devicePixelRatio || 1;
}

export function getUrl(schema: string, secureSchema: string, path: string) {
  if (window.location.protocol === "https:") {
    return `${secureSchema}://${window.location.host}/${path}`;
  }
  // Dev server proxies API/WebSocket routes on the same host:port.
  if (__DEV__) {
    return `${schema}://${window.location.host}/${path}`;
  }
  return `${schema}://${window.location.hostname}:5000/${path}`;
}

export function getHttpUrl(path: string) {
  return getUrl("http", "https", path);
}
