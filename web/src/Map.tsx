import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  BigStaticData,
  CompressedBigStaticData,
  Vehicle,
  CompressedRealTimeState,
  decompressRealTimeState,
  RealTimeState,
  decompressBigStaticData,
  SmallStaticData,
  decompressSmallStaticData,
  CompressedSmallStaticData,
  RouteId,
  Shape,
} from "./Data";
import {
  FilterControl,
  FilterOverlay,
  useFilterState,
  FilterState,
} from "./Filter";
import { InfoControl, InfoOverlay } from "./Info";
import { MarkerManager } from "./Markers";
import "./Map.css";
import { VehicleLayer } from "./VehicleLayer";

interface LoadedBigStaticData {
  key: string;
  data: BigStaticData;
}

interface LoadedSmallStaticData {
  key: string;
  data: SmallStaticData;
}

function getUrl(schema: string, secureSchema: string, path: string) {
  return window.location.protocol === "https:"
    ? `${secureSchema}://${window.location.host}/${path}`
    : `${schema}://${window.location.hostname}:5000/${path}`;
}

class HighlightedVehicleCriterion {
  private routeId: RouteId | null = null;

  setSelectedRouteId(routeId: RouteId | null) {
    this.routeId = routeId;
  }

  getSelectedRouteId(): RouteId | null {
    return this.routeId;
  }

  isHighlighted(vehicle: Vehicle): boolean {
    return this.routeId != null && vehicle.routeId === this.routeId;
  }
}

async function fetchBigStaticData(key: string) {
  const url = getUrl("http", "https", `static/${key}`);
  const response = await fetch(url);
  const compressedData: CompressedBigStaticData = await response.json();
  return decompressBigStaticData(compressedData);
}

async function fetchSmallStaticData(key: string) {
  const url = getUrl("http", "https", `static/small/v0/${key}`);
  const response = await fetch(url);
  const compressedData: CompressedSmallStaticData = await response.json();
  return decompressSmallStaticData(compressedData);
}

async function getSelectedShape(
  selectedShapeId: string | null,
  loadedBigStaticData: LoadedBigStaticData | null,
  activeStaticKey: string | null,
  setLoadedBigStaticData: (data: LoadedBigStaticData) => void
): Promise<Shape | null> {
  if (selectedShapeId == null || activeStaticKey == null) {
    return null;
  }
  let bigStaticData: BigStaticData;
  if (
    loadedBigStaticData == null ||
    loadedBigStaticData.key !== activeStaticKey
  ) {
    bigStaticData = await fetchBigStaticData(activeStaticKey);
    setLoadedBigStaticData({ key: activeStaticKey, data: bigStaticData });
  } else {
    bigStaticData = loadedBigStaticData.data;
  }
  return bigStaticData.shapes[selectedShapeId] || null;
}

export function Map() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapLoadedRef = useRef<boolean>(false);
  const [showInfo, setShowInfo] = useState<boolean>(false);
  const [showFilter, setShowFilter] = useState<boolean>(false);

  const [filterState, setFilterState] = useFilterState("zet-filter-state", {
    selection: new Set(),
    enabled: false,
  });
  const filterStateRef = useRef<FilterState>(filterState);
  const anyMarkerVisibleRef = useRef<boolean>(true);

  const markerManager = useRef<MarkerManager>(new MarkerManager());
  const vehicleLayerRef = useRef<VehicleLayer | null>(null);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [activeStaticKey, setActiveStaticKey] = useState<string | null>(null);
  const [loadedBigStaticData, setLoadedBigStaticData] =
    useState<LoadedBigStaticData | null>(null);
  const [loadedSmallStaticData, setLoadedSmallStaticData] =
    useState<LoadedSmallStaticData | null>(null);
  const [selectedShape, setSelectedShape] = useState<Shape | null>(null);
  const selectedShapeRef = useRef<Shape | null>(null);
  const realTimeData = useRef<RealTimeState | null>(null);
  const highlightedVehicleCriterion = useRef<HighlightedVehicleCriterion>(
    new HighlightedVehicleCriterion()
  );
  const filterControlRef = useRef<FilterControl | null>(null);

  const redraw = () => {
    if (
      mapRef.current == null ||
      realTimeData.current == null ||
      filterControlRef.current == null ||
      !mapLoadedRef.current
    ) {
      return;
    }
    const activeSelection = filterStateRef.current.enabled
      ? filterStateRef.current.selection
      : new Set<RouteId>();

    const highlightedRouteId =
      highlightedVehicleCriterion.current.getSelectedRouteId();

    if (vehicleLayerRef.current) {
      vehicleLayerRef.current.setData(
        realTimeData.current.vehicles,
        activeSelection,
        highlightedRouteId,
        selectedShapeRef.current
      );
    }

    // Determine if any markers are visible for the filter control
    const anyVisible = realTimeData.current.vehicles.some((v) => {
      const highlighted = highlightedVehicleCriterion.current.isHighlighted(v);
      const hidden =
        activeSelection.size > 0 && !activeSelection.has(v.routeId);
      return !hidden || highlighted;
    });
    anyMarkerVisibleRef.current = anyVisible;

    if (filterControlRef.current != null) {
      filterControlRef.current.updateState(
        filterStateRef.current,
        anyMarkerVisibleRef.current
      );
    }

    const collisionSource = mapRef.current.getSource(
      "collision-proxy"
    ) as maplibregl.GeoJSONSource;
    if (collisionSource) {
      collisionSource.setData({
        type: "FeatureCollection",
        features: realTimeData.current.vehicles
          .filter((v) => {
            const highlighted =
              highlightedVehicleCriterion.current.isHighlighted(v);
            const hidden =
              activeSelection.size > 0 && !activeSelection.has(v.routeId);
            return !hidden || highlighted;
          })
          .map((v) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [v.lon[v.lon.length - 1], v.lat[v.lat.length - 1]],
            },
            properties: {},
          })),
      });
    }
  };

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
      new maplibregl.GeolocateControl({
        positionOptions: {
          enableHighAccuracy: true,
        },
        trackUserLocation: true,
      })
    );

    map.addControl(new InfoControl(() => setShowInfo(true)));
    filterControlRef.current = new FilterControl({
      onShowFilter: () => setShowFilter(true),
      onToggleFilter: (enabled: boolean) => {
        console.log("onToggleFilter", enabled);
        const newFilterState = { ...filterStateRef.current, enabled };
        setFilterState(newFilterState);
        filterStateRef.current = newFilterState;
        redraw();
      },
      initialState: filterStateRef.current,
    });
    map.addControl(filterControlRef.current, "bottom-right");

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

      // Create an empty icon for collision detection.
      const SIZE = 13 * window.devicePixelRatio;
      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, SIZE, SIZE);
      map.addImage("ghost-marker", ctx.getImageData(0, 0, SIZE, SIZE));

      // Add a ghost layer, containing one symbol for each vehicle, such that
      // maplibre hides area names benith vehicles. This way we declutter the
      // map a bit.
      map.addSource("collision-proxy", emptyGeoJSON);
      map.addLayer({
        id: "collision-proxy",
        type: "symbol",
        source: "collision-proxy",
        layout: {
          "icon-image": "ghost-marker",
          "icon-size": 1,
          // "Show" all vehicles even if they overlap, to hopefully speed up
          // the collision step.
          "icon-allow-overlap": true,
          "icon-ignore-placement": false, // Hide map labels benith this layer.
        },
        paint: {
          "icon-opacity": 0, // Do not render, just use for collision detection.
        },
      });

      vehicleLayerRef.current = new VehicleLayer(map, markerManager.current, {
        onVehicleClick: (vehicle) => {
          setSelectedShapeId(vehicle.shapeId);
          highlightedVehicleCriterion.current.setSelectedRouteId(
            vehicle.routeId
          );
          if (vehicle.shapeId == null) {
            redraw();
          }
          // Otherwise, the useEffect will handle fetching the shape and calling redraw
        },
        onNothingClick: () => {
          setSelectedShapeId(null);
          highlightedVehicleCriterion.current.setSelectedRouteId(null);
          selectedShapeRef.current = null;
          setSelectedShape(null);
          redraw();
        },
      });

      mapLoadedRef.current = true;

      // If we already have vehicle data from WebSocket, display it now
      if (realTimeData.current) {
        redraw();
      }
    });

    // Cleanup
    return () => {
      if (vehicleLayerRef.current) {
        vehicleLayerRef.current.destroy();
      }
      map.remove();
    };
  }, []);

  useEffect(() => {
    getSelectedShape(
      selectedShapeId,
      loadedBigStaticData,
      activeStaticKey,
      setLoadedBigStaticData
    ).then((shape) => {
      selectedShapeRef.current = shape;
      setSelectedShape(shape);
    });
  }, [selectedShapeId, activeStaticKey, loadedBigStaticData]);

  useEffect(() => {
    redraw();
  }, [selectedShape]);

  useEffect(() => {
    if (activeStaticKey == null) {
      return;
    }
    if (
      loadedSmallStaticData == null ||
      loadedSmallStaticData.key !== activeStaticKey
    ) {
      fetchSmallStaticData(activeStaticKey).then((data: SmallStaticData) => {
        setLoadedSmallStaticData({ key: activeStaticKey, data: data });
      });
    }
  }, [activeStaticKey, loadedSmallStaticData]);

  // WebSocket connection and updates with reconnection logic.
  // Start immediately, don't wait for map to load.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let isMounted = true; // Flag to track if component is still mounted

    const connectWebSocket = () => {
      if (!isMounted) {
        return;
      }

      // Manually change to the dev websocket server port in http.
      const url = getUrl("ws", "wss", "ws-v2");
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("WebSocket connection established");
        reconnectAttempts = 0; // Reset attempts on successful connection
      });

      ws.addEventListener("message", (event) => {
        const data: CompressedRealTimeState = JSON.parse(event.data);
        const state: RealTimeState = decompressRealTimeState(data);
        realTimeData.current = state;
        // Try to display data - redraw() will check if map is ready
        redraw();
        setActiveStaticKey(state.activeStaticKey);
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
  }, []);

  const onFilterSelectionChange = (newSelection: Set<RouteId>) => {
    const newFilterState = {
      selection: newSelection,
      enabled: filterStateRef.current.enabled || newSelection.size > 0,
    };
    setFilterState(newFilterState);
    filterStateRef.current = newFilterState;
    redraw();
  };

  useEffect(() => {
    if (filterControlRef.current != null) {
      filterControlRef.current.updateState(
        filterState,
        anyMarkerVisibleRef.current
      );
    }
  }, [filterState]);

  return (
    <>
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      {showInfo && <InfoOverlay onClose={() => setShowInfo(false)} />}
      {showFilter && (
        <FilterOverlay
          onClose={() => setShowFilter(false)}
          smallStaticData={loadedSmallStaticData?.data}
          selection={filterState.selection}
          onSelectionChange={onFilterSelectionChange}
        />
      )}
    </>
  );
}
