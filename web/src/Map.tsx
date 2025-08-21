import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MarkerManager, MarkerProperties } from "./Markers";
import {
  StaticData,
  CompressedStaticData,
  Vehicle,
  CompressedRealTimeState,
  decompressRealTimeState,
  RealTimeState,
  decompressStaticData,
} from "./Data";
import "./Map.css";
import { InfoControl, InfoOverlay } from "./Info";

interface LoadedStaticData {
  key: string;
  data: StaticData;
}

function getUrl(schema: string, secureSchema: string, path: string) {
  return window.location.protocol === "https:"
    ? `${secureSchema}://${window.location.host}/${path}`
    : `${schema}://${window.location.hostname}:5000/${path}`;
}

class HighlightedVehicleCriterion {
  private routeId: number | null = null;

  setSelectedRouteId(routeId: number | null) {
    this.routeId = routeId;
  }

  isHighlighted(vehicle: Vehicle): boolean {
    return this.routeId != null && vehicle.routeId === this.routeId;
  }
}

function updateMarkers(
  map: maplibregl.Map,
  vehicles: Vehicle[],
  markerManager: MarkerManager,
  highlightedVehicleCriterion: HighlightedVehicleCriterion
) {
  const source = map.getSource("vehicle-markers") as maplibregl.GeoJSONSource;
  const highlightedSource = map.getSource(
    "highlighted-vehicle-markers"
  ) as maplibregl.GeoJSONSource;
  const features: GeoJSON.Feature[] = [];
  const highlightedFeatures: GeoJSON.Feature[] = [];

  vehicles.forEach((vehicle) => {
    const coord: [number, number] = [
      vehicle.lon[vehicle.lon.length - 1],
      vehicle.lat[vehicle.lat.length - 1],
    ];

    // Round the angle, for memory AND performance reasons.
    let deg;
    if (vehicle.directionDegrees != null) {
      deg = Math.round(vehicle.directionDegrees / 12) * 12;
    } else {
      deg = null;
    }
    const markerProperties: MarkerProperties = {
      label: vehicle.routeId.toString(),
      directionDegrees: deg,
      highlighted: false,
    };

    const marker = markerManager.getOrCreate(map, markerProperties);
    const feature: GeoJSON.Feature = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coord,
      },
      properties: {
        markerKey: marker.key,
        shapeId: vehicle.shapeId,
        routeId: vehicle.routeId,
        zOrder: -vehicle.routeId,
      },
    };
    // Display the feature in both sources to avoid flickering.
    features.push(feature);
    if (highlightedVehicleCriterion.isHighlighted(vehicle)) {
      const highlightedMarkerProperties: MarkerProperties = {
        ...markerProperties,
        highlighted: true,
      };
      const highlightedMarker = markerManager.getOrCreate(
        map,
        highlightedMarkerProperties
      );
      const highlightedFeature: GeoJSON.Feature = {
        ...feature,
        properties: {
          ...feature.properties,
          markerKey: highlightedMarker.key,
        },
      };
      highlightedFeatures.push(highlightedFeature);
    }
  });

  source.setData({
    type: "FeatureCollection",
    features: features,
  });
  highlightedSource.setData({
    type: "FeatureCollection",
    features: highlightedFeatures,
  });
}

function updateTrajectories(map: maplibregl.Map, vehicles: Vehicle[]) {
  const features: GeoJSON.Feature[] = vehicles.map((vehicle) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: vehicle.lon.map((lon, index) => [lon, vehicle.lat[index]]),
    },
    properties: {
      routeId: vehicle.routeId,
    },
  }));

  const source = map.getSource("trajectories") as maplibregl.GeoJSONSource;
  source.setData({
    type: "FeatureCollection",
    features: features,
  });
}

async function fetchStaticData(key: string) {
  const url = getUrl("http", "https", `static/${key}`);
  const response = await fetch(url);
  const compressedStaticData: CompressedStaticData = await response.json();
  return decompressStaticData(compressedStaticData);
}

async function updateSelectedShape(
  map: maplibregl.Map,
  selectedShapeId: string | null,
  loadedStaticData: LoadedStaticData | null,
  latestStaticKey: string,
  setLoadedStaticData: (data: LoadedStaticData) => void
) {
  const source = map.getSource("selected-shape") as maplibregl.GeoJSONSource;

  if (selectedShapeId == null) {
    source.setData({
      type: "FeatureCollection",
      features: [],
    });
    return null;
  }
  let staticData: StaticData;
  if (loadedStaticData == null || loadedStaticData.key !== latestStaticKey) {
    staticData = await fetchStaticData(latestStaticKey);
    setLoadedStaticData({ key: latestStaticKey, data: staticData });
  } else {
    staticData = loadedStaticData.data;
  }
  const shape = staticData.shapes[selectedShapeId];
  let features: GeoJSON.Feature[] = [];
  if (shape != null) {
    // Draw a polyline from the first shape point to the last shape point.
    features = [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: shape.lons.map((lon, index) => [lon, shape.lats[index]]),
        },
        properties: {},
      },
    ];
  }
  source.setData({ type: "FeatureCollection", features: features });
}

function isWithinMarker(
  map: maplibregl.Map,
  markerManager: MarkerManager,
  feature: GeoJSON.Feature,
  clickPoint: { x: number; y: number }
): boolean {
  const coordinates = (feature.geometry as GeoJSON.Point).coordinates;
  const markerPixel = map.project({
    lng: coordinates[0],
    lat: coordinates[1],
  });
  const dx = clickPoint.x - markerPixel.x;
  const dy = clickPoint.y - markerPixel.y;
  const markerKey = feature.properties?.markerKey;
  if (markerKey == null) {
    return false;
  }
  const markerShape = markerManager.getMarkerShape(markerKey);
  if (markerShape == null) {
    return false;
  }
  return markerShape.isWithinShape(dx, dy);
}

function findSelectedMarkerFeature(
  map: maplibregl.Map,
  markerManager: MarkerManager,
  features: GeoJSON.Feature[],
  clickPoint: { x: number; y: number }
): GeoJSON.Feature | null {
  // Select the feature with the highest zOrder.
  let topFeature: GeoJSON.Feature | null = null;
  let topZOrder: number | null = null;
  for (const feature of features) {
    if (topZOrder != null && feature.properties?.zOrder < topZOrder) {
      continue;
    }
    if (isWithinMarker(map, markerManager, feature, clickPoint)) {
      topFeature = feature;
      topZOrder = feature.properties?.zOrder;
    }
  }
  return topFeature;
}

export function Map() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState<boolean>(false);
  const [showInfo, setShowInfo] = useState<boolean>(false);
  const markerManager = useRef<MarkerManager>(new MarkerManager());
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [latestStaticKey, setLatestStaticKey] = useState<string | null>(null);
  const [loadedStaticData, setLoadedStaticData] =
    useState<LoadedStaticData | null>(null);
  const realTimeData = useRef<RealTimeState | null>(null);
  const highlightedVehicleCriterion = useRef<HighlightedVehicleCriterion>(
    new HighlightedVehicleCriterion()
  );

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current) {
      return;
    }

    const center: [number, number] = [15.9819, 45.815];
    const map = (mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "/style.json",
      center: center,
      zoom: 12,
      minZoom: 9,
      maxZoom: 18,
      maxBounds: [
        [center[0] - 0.5, center[1] - 0.27],
        [center[0] + 0.5, center[1] + 0.22],
      ],
      dragRotate: false,
      pitchWithRotate: false,
      rollEnabled: false,
      boxZoom: false,
    }));
    map.touchZoomRotate.disableRotation();

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
      })
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: {
          enableHighAccuracy: true,
        },
        trackUserLocation: true,
      })
    );

    map.addControl(new InfoControl(() => setShowInfo(true)));

    // Initialize trajectory source and layer
    map.on("load", () => {
      if (!map) {
        return;
      }

      const emptyGeoJSON: maplibregl.GeoJSONSourceSpecification = {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      };

      map.addSource("vehicle-markers", emptyGeoJSON);
      map.addSource("highlighted-vehicle-markers", emptyGeoJSON);
      map.addSource("trajectories", emptyGeoJSON);
      map.addSource("selected-shape", emptyGeoJSON);

      map.addLayer({
        id: "trajectory-lines",
        type: "line",
        source: "trajectories",
        paint: {
          "line-color": "#ff6464",
          "line-opacity": 0.7,
          "line-width": 2,
        },
      });

      // Render markers as symbols with various dynamically created images.
      map.addLayer({
        id: "vehicle-markers",
        type: "symbol",
        source: "vehicle-markers",
        layout: {
          "icon-image": ["get", "markerKey"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "symbol-sort-key": ["get", "zOrder"],
        },
      });
      // Hopefully this disabled symbol fade in/out.
      map.setPaintProperty("vehicle-markers", "icon-opacity", 1.0);

      map.addLayer({
        id: "selected-shape",
        type: "line",
        source: "selected-shape",
        paint: {
          "line-color": "#000",
          "line-width": 3,
        },
      });

      // Highlighted vehicles on top of the other vehicles.
      map.addLayer({
        id: "highlighted-vehicle-markers",
        type: "symbol",
        source: "highlighted-vehicle-markers",
        layout: {
          "icon-image": ["get", "markerKey"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "symbol-sort-key": ["get", "zOrder"],
        },
      });

      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["highlighted-vehicle-markers", "vehicle-markers"],
        });
        const feature = findSelectedMarkerFeature(
          map,
          markerManager.current,
          features,
          e.point
        );
        if (feature != null) {
          setSelectedShapeId(feature.properties?.shapeId);
          highlightedVehicleCriterion.current.setSelectedRouteId(
            feature.properties?.routeId
          );
        } else {
          setSelectedShapeId(null);
          highlightedVehicleCriterion.current.setSelectedRouteId(null);
        }
        if (realTimeData.current != null) {
          updateMarkers(
            map,
            realTimeData.current.vehicles,
            markerManager.current,
            highlightedVehicleCriterion.current
          );
        }
      });

      // TODO: Precisely check whether the mouse cursor is over a marker.
      map.on("mouseenter", "vehicle-markers", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "vehicle-markers", () => {
        map.getCanvas().style.cursor = "";
      });

      setMapLoaded(true);
    });

    // Cleanup
    return () => {
      map.remove();
    };
  }, []);

  useEffect(() => {
    if (!mapLoaded || mapRef.current == null || latestStaticKey == null) {
      return;
    }
    updateSelectedShape(
      mapRef.current,
      selectedShapeId,
      loadedStaticData,
      latestStaticKey,
      setLoadedStaticData
    );
  }, [selectedShapeId, latestStaticKey, loadedStaticData]);

  // WebSocket connection and updates with reconnection logic
  useEffect(() => {
    if (!mapLoaded) {
      return; // Do not open the websocket yet.
    }
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let isMounted = true; // Flag to track if component is still mounted

    const connectWebSocket = () => {
      if (!isMounted) {
        return;
      }

      // Manually change to the dev websocket server port in http.
      const url = getUrl("ws", "wss", "ws-v1");
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("WebSocket connection established");
        reconnectAttempts = 0; // Reset attempts on successful connection
      });

      ws.addEventListener("message", (event) => {
        const data: CompressedRealTimeState = JSON.parse(event.data);
        const state: RealTimeState = decompressRealTimeState(data);
        realTimeData.current = state;
        if (mapRef.current) {
          updateMarkers(
            mapRef.current,
            state.vehicles,
            markerManager.current,
            highlightedVehicleCriterion.current
          );
          updateTrajectories(mapRef.current, state.vehicles);
        }
        setLatestStaticKey(state.latestStaticKey);
      });

      ws.addEventListener("close", () => {
        console.log("WebSocket connection closed");
        if (isMounted) {
          // Only reconnect if component is still mounted
          reconnectWithBackoff();
        }
      });

      ws.addEventListener("error", (error) => {
        console.error("WebSocket error:", error);
        ws?.close();
      });
    };

    const reconnectWithBackoff = () => {
      if (!isMounted) {
        return;
      }

      const delay = Math.min(1000 + 1000 * reconnectAttempts, 5000);
      setTimeout(() => {
        if (!isMounted) {
          return;
        }
        ++reconnectAttempts;
        console.log(`Reconnecting... Attempt #${reconnectAttempts}`);
        connectWebSocket();
      }, delay);
    };

    connectWebSocket();

    return () => {
      isMounted = false; // Do not reconnect anymore.
      ws?.close();
    };
  }, [mapLoaded]);

  return (
    <>
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      {showInfo && <InfoOverlay onClose={() => setShowInfo(false)} />}
    </>
  );
}
