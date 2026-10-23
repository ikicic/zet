import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
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
import "./Map.css";
import mapStyleUrl from "../BUILD/style.json?url";
import { createAppUpdater } from "./AppUpdates";
import { MapUnavailable } from "./MapUnavailable";
import {
  diagnoseMapFailure,
  MAP_CONTEXT_ATTRIBUTES,
  MapFailure,
} from "./GraphicsDiagnostics";
import { VehicleLayer } from "./VehicleLayer";
import { findSelectedVehicle } from "./VehicleDetails";
import { VehicleDelayTooltip } from "./VehicleDelayTooltip";
import { getFeedAge } from "./VehicleDelay";
import { StaleDataIndicator } from "./StaleDataIndicator";
import { getMapCanvasDpr, getUrl, getHttpUrl } from "./url";
import { PerfOverlay } from "./PerfOverlay";
import {
  deserializeSeenNewsVersion,
  hasUnseenNews,
  isNewsSnapshot,
  isNewsStatus,
  NewsControl,
  NewsOverlay,
  NewsSnapshot,
  NewsStatus,
  NEWS_SEEN_VERSION_KEY,
  removeLegacyNewsStorage,
} from "./News";
import { useLocalStorage } from "./useLocalStorage";
import { useAsyncData } from "./useAsyncData";
import { fetchJson, isRetryableFetchError } from "./fetchJson";

const URL_PARAMS = new URLSearchParams(window.location.search);
const PERFORMANCE_MODE = URL_PARAMS.get("perf") === "1";
const STRESS_MODE = __DEV__ && URL_PARAMS.get("stress") === "1";
const LOCATION_TRACKING_ENABLED_KEY = "zet-location-tracking-enabled";

function getLocationTrackingEnabled(): boolean {
  try {
    return window.localStorage.getItem(LOCATION_TRACKING_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function setLocationTrackingEnabled(enabled: boolean) {
  try {
    if (enabled) {
      window.localStorage.setItem(LOCATION_TRACKING_ENABLED_KEY, "1");
    } else {
      window.localStorage.removeItem(LOCATION_TRACKING_ENABLED_KEY);
    }
  } catch {
    // Location tracking remains usable when local storage is unavailable.
  }
}

interface LoadedSmallStaticData {
  key: string;
  data: SmallStaticData;
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
  const url = getHttpUrl(`static/big/v1/${key}`);
  const compressedData = await fetchJson<CompressedBigStaticData>(url);
  return decompressBigStaticData(compressedData);
}

async function fetchSmallStaticData(key: string) {
  const url = getHttpUrl(`static/small/v0/${key}`);
  const response = await fetch(url);
  const compressedData: CompressedSmallStaticData = await response.json();
  return decompressSmallStaticData(compressedData);
}

export function Map() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapLoadedRef = useRef<boolean>(false);
  const [mapFailure, setMapFailure] = useState<MapFailure | null>(null);
  const [showInfo, setShowInfo] = useState<boolean>(false);
  const [showFilter, setShowFilter] = useState<boolean>(false);
  const selectedVehicleRef = useRef<Vehicle | null>(null);

  const [filterState, setFilterState] = useFilterState("zet-filter-state", {
    selection: new Set(),
    enabled: false,
  });
  const filterStateRef = useRef<FilterState>(filterState);
  const filterHidesAllVehiclesRef = useRef<boolean>(false);

  const vehicleLayerRef = useRef<VehicleLayer | null>(null);
  const vehicleDelayTooltipRef = useRef<VehicleDelayTooltip | null>(null);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [activeStaticKey, setActiveStaticKey] = useState<string | null>(null);
  const [loadedSmallStaticData, setLoadedSmallStaticData] =
    useState<LoadedSmallStaticData | null>(null);
  const { data: bigStaticData, error: bigStaticError } = useAsyncData(
    selectedShapeId ? activeStaticKey : null,
    fetchBigStaticData,
    { shouldRetry: isRetryableFetchError },
  );
  const selectedShape = selectedShapeId
    ? (bigStaticData?.shapes[selectedShapeId] ?? null)
    : null;
  const selectedShapeRef = useRef<Shape | null>(null);
  const realTimeData = useRef<RealTimeState | null>(null);
  const highlightedVehicleCriterion = useRef<HighlightedVehicleCriterion>(
    new HighlightedVehicleCriterion(),
  );
  const filterControlRef = useRef<FilterControl | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<number | null>(null);
  const [initialAtlasBuildMs, setInitialAtlasBuildMs] = useState<number | null>(
    null,
  );
  const [mapCanvasDpr, setMapCanvasDpr] = useState<number | null>(null);
  const [perfMap, setPerfMap] = useState<maplibregl.Map | null>(null);
  const [news, setNews] = useState<NewsSnapshot | null>(null);
  const [newsStatus, setNewsStatus] = useState<NewsStatus | null>(null);
  const [seenNewsVersion, setSeenNewsVersion] = useLocalStorage<string | null>(
    NEWS_SEEN_VERSION_KEY,
    null,
    {
      deserialize: deserializeSeenNewsVersion,
    },
  );
  const [newsOverlayState, setNewsOverlayState] = useState<
    "hidden" | "error" | "empty" | "ready"
  >("hidden");
  const newsRef = useRef<NewsSnapshot | null>(news);
  const newsStatusRef = useRef<NewsStatus | null>(newsStatus);
  const seenNewsVersionRef = useRef(seenNewsVersion);
  const newsControlRef = useRef<NewsControl | null>(null);
  const newsFetchRef = useRef<Promise<void> | null>(null);

  const loadNews = () => {
    if (
      newsRef.current != null &&
      newsRef.current.version === newsStatusRef.current?.version
    ) {
      return;
    }
    if (newsFetchRef.current != null) return;

    const fetchNews = async () => {
      try {
        const response = await fetch(getHttpUrl("news?schema=2"), {
          cache: "no-cache",
        });
        if (response.status === 204) {
          newsRef.current = null;
          setNews(null);
          setNewsOverlayState("empty");
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot: unknown = await response.json();
        if (!isNewsSnapshot(snapshot)) {
          throw new Error("Invalid news snapshot");
        }
        newsRef.current = snapshot;
        setNews(snapshot);
        setNewsOverlayState("ready");
        seenNewsVersionRef.current = snapshot.version;
        setSeenNewsVersion(snapshot.version);
      } catch (error) {
        console.error("Could not load news:", error);
        setNewsOverlayState("error");
      } finally {
        newsControlRef.current?.setLoading(false);
        newsFetchRef.current = null;
      }
    };
    newsFetchRef.current = fetchNews();
  };

  const openNews = () => {
    if (newsRef.current?.version === newsStatusRef.current?.version) {
      setNewsOverlayState("ready");
      return;
    }
    newsControlRef.current?.setLoading(true);
    loadNews();
  };
  const closeNews = useCallback(() => {
    setNewsOverlayState("hidden");
  }, []);

  useEffect(() => {
    removeLegacyNewsStorage();
  }, []);

  const updateVehicleDelays = () => {
    const state = realTimeData.current;
    if (!state) return;
    const feedAge = getFeedAge(state.timestamp);
    vehicleLayerRef.current?.setFeedAge(feedAge);
    vehicleDelayTooltipRef.current?.setVehicle(
      findSelectedVehicle(state.vehicles, selectedVehicleRef.current),
      feedAge,
    );
  };

  useEffect(() => {
    const timer = setInterval(updateVehicleDelays, 5000);
    return () => clearInterval(timer);
  }, []);

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

    const previousVehicle = selectedVehicleRef.current;
    const selectedVehicle = findSelectedVehicle(
      realTimeData.current.vehicles,
      previousVehicle,
    );
    // Keep the last identity through feed gaps; only the current match is shown.
    if (selectedVehicle) selectedVehicleRef.current = selectedVehicle;
    updateVehicleDelays();
    if (
      previousVehicle &&
      selectedVehicle &&
      (previousVehicle.routeId !== selectedVehicle.routeId ||
        previousVehicle.shapeId !== selectedVehicle.shapeId)
    ) {
      highlightedVehicleCriterion.current.setSelectedRouteId(
        selectedVehicle.routeId,
      );
      if (previousVehicle.shapeId !== selectedVehicle.shapeId) {
        selectedShapeRef.current = null;
        setSelectedShapeId(selectedVehicle.shapeId);
      }
    }
    const highlightedRouteId =
      highlightedVehicleCriterion.current.getSelectedRouteId();
    const visibleVehicles = realTimeData.current.vehicles.filter(
      (vehicle) =>
        vehicle.routeId === highlightedRouteId ||
        activeSelection.size === 0 ||
        activeSelection.has(vehicle.routeId),
    );

    if (vehicleLayerRef.current) {
      vehicleLayerRef.current.setData(
        realTimeData.current.vehicles,
        activeSelection,
        highlightedRouteId,
        selectedShapeRef.current,
        selectedVehicle,
      );
    }

    // Warn only when filtering hides available vehicles.
    // An empty feed is normal.
    filterHidesAllVehiclesRef.current =
      realTimeData.current.vehicles.length > 0 && visibleVehicles.length === 0;

    if (filterControlRef.current != null) {
      filterControlRef.current.updateState(
        filterStateRef.current,
        filterHidesAllVehiclesRef.current,
      );
    }

    const collisionSource = mapRef.current.getSource(
      "collision-proxy",
    ) as maplibregl.GeoJSONSource;
    if (collisionSource) {
      collisionSource.setData({
        type: "FeatureCollection",
        features: visibleVehicles.map((v) => ({
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

    let isUnmounted = false;
    let stressAnimationFrame: number | null = null;
    const shouldRestoreLocationTracking = getLocationTrackingEnabled();
    const geolocationPermission = shouldRestoreLocationTracking
      ? navigator.permissions
          ?.query({ name: "geolocation" })
          .catch(() => undefined)
      : undefined;

    const center: [number, number] = [15.9819, 45.815];
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: mapContainer.current,
        style: mapStyleUrl,
        canvasContextAttributes: {
          ...MAP_CONTEXT_ATTRIBUTES,
          // Prefer WebGL2; MapLibre falls back to WebGL1 when it is unavailable.
          contextType:
            __DEV__ && URL_PARAMS.get("webgl") === "1" ? "webgl" : undefined,
        },
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
      });
    } catch (error) {
      console.error("Map initialization failed", error);
      const failure = diagnoseMapFailure(
        error,
        [mapContainer.current.clientWidth, mapContainer.current.clientHeight],
        maplibregl.getVersion(),
      );
      mapContainer.current.replaceChildren();
      setMapFailure(failure);
      return;
    }
    mapRef.current = map;
    setMapFailure(null);
    if (STRESS_MODE) {
      const animationStart = performance.now();
      const animateMap = (now: number) => {
        const phase = ((now - animationStart) / 8000) * Math.PI * 2;
        map.jumpTo({
          center: [
            center[0] + 0.004 * Math.sin(phase),
            center[1] + 0.002 * Math.cos(phase),
          ],
        });
        stressAnimationFrame = requestAnimationFrame(animateMap);
      };
      stressAnimationFrame = requestAnimationFrame(animateMap);
    }
    if (PERFORMANCE_MODE) {
      setPerfMap(map);
    }
    const updateMapCanvasDpr = () => setMapCanvasDpr(getMapCanvasDpr(map));
    map.touchZoomRotate.disableRotation();
    if (PERFORMANCE_MODE) {
      map.on("resize", updateMapCanvasDpr);
    }

    const geolocateControl = new maplibregl.GeolocateControl({
      fitBoundsOptions: {
        maxZoom: 13,
      },
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    });
    map.addControl(geolocateControl);
    let lostLocationFocus = false;
    geolocateControl.on("trackuserlocationstart", () => {
      setLocationTrackingEnabled(true);
    });
    geolocateControl.on("trackuserlocationend", () => {
      queueMicrotask(() => {
        if (!lostLocationFocus) {
          setLocationTrackingEnabled(false);
        }
        lostLocationFocus = false;
      });
    });
    geolocateControl.on("userlocationlostfocus", () => {
      lostLocationFocus = true;
    });
    let restoreAttempts = 0;
    const restoreLocationTracking = () => {
      if (isUnmounted) {
        return;
      }

      const restored = geolocateControl.trigger();
      if (!restored && restoreAttempts++ < 60) {
        requestAnimationFrame(restoreLocationTracking);
      }
    };
    void geolocationPermission?.then((permission) => {
      if (!isUnmounted && permission?.state === "granted") {
        restoreLocationTracking();
      }
    });

    map.addControl(new InfoControl(() => setShowInfo(true)));
    const newsControl = new NewsControl(openNews);
    newsControlRef.current = newsControl;
    map.addControl(newsControl, "top-right");
    newsControl.setBadge(
      hasUnseenNews(newsStatusRef.current, seenNewsVersionRef.current),
    );
    if (__DEV__) {
      map.addControl(
        {
          onAdd() {
            const container = document.createElement("div");
            container.className = "maplibregl-ctrl maplibregl-ctrl-group";

            const button = document.createElement("button");
            button.type = "button";
            button.className = "maplibregl-ctrl-icon";
            button.textContent = "A";
            button.title = "Open marker atlas";
            button.setAttribute("aria-label", button.title);
            button.addEventListener("click", () =>
              vehicleLayerRef.current?.openAtlasDebugOverlay(),
            );
            container.appendChild(button);
            return container;
          },
          onRemove() {},
        },
        "top-right",
      );
      map.addControl(
        {
          onAdd() {
            const container = document.createElement("div");
            container.className = "maplibregl-ctrl maplibregl-ctrl-group";

            const button = document.createElement("button");
            button.type = "button";
            button.className = "maplibregl-ctrl-icon";
            button.textContent = "L";
            button.title = "Add dynamic atlas test labels";
            button.setAttribute("aria-label", button.title);
            button.addEventListener("click", () =>
              vehicleLayerRef.current?.addDebugLabels(),
            );
            container.appendChild(button);
            return container;
          },
          onRemove() {},
        },
        "top-right",
      );
    }
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
      if (isUnmounted) {
        return;
      }
      try {
        if (PERFORMANCE_MODE) {
          updateMapCanvasDpr();
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

        vehicleDelayTooltipRef.current = new VehicleDelayTooltip(map);
        const vehicleLayer = new VehicleLayer(map, {
          onVehicleClick: (vehicle) => {
            selectedVehicleRef.current = vehicle;
            setSelectedShapeId(vehicle.shapeId);
            highlightedVehicleCriterion.current.setSelectedRouteId(
              vehicle.routeId,
            );
            // Highlight immediately; the selected shape is fetched separately.
            redraw();
          },
          onNothingClick: () => {
            selectedVehicleRef.current = null;
            setSelectedShapeId(null);
            highlightedVehicleCriterion.current.setSelectedRouteId(null);
            selectedShapeRef.current = null;
            redraw();
          },
          measureInitialAtlasBuild: PERFORMANCE_MODE,
        });
        vehicleLayerRef.current = vehicleLayer;
        if (PERFORMANCE_MODE) {
          setInitialAtlasBuildMs(vehicleLayer.initialAtlasBuildMs);
        }

        mapLoadedRef.current = true;

        // If we already have vehicle data from WebSocket, display it now
        if (realTimeData.current) {
          redraw();
        }
      } catch (error) {
        console.error("Map layer initialization failed", error);
        const size = [
          map.getContainer().clientWidth,
          map.getContainer().clientHeight,
        ];
        // MapLibre may still be dispatching its load event. Tear down afterward.
        queueMicrotask(() => {
          if (isUnmounted) return;
          cleanup();
          setMapFailure(
            diagnoseMapFailure(
              error,
              size,
              maplibregl.getVersion(),
              "map-layers",
            ),
          );
        });
      }
    });

    // Cleanup
    const cleanup = () => {
      if (isUnmounted) return;
      isUnmounted = true;
      if (stressAnimationFrame !== null) {
        cancelAnimationFrame(stressAnimationFrame);
      }
      if (vehicleLayerRef.current) {
        vehicleLayerRef.current.destroy();
        vehicleLayerRef.current = null;
      }
      vehicleDelayTooltipRef.current?.setVehicle(null);
      vehicleDelayTooltipRef.current = null;
      if (PERFORMANCE_MODE) {
        map.off("resize", updateMapCanvasDpr);
      }
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
      newsControlRef.current = null;
    };
    return cleanup;
  }, []);

  useEffect(() => {
    selectedShapeRef.current = selectedShape;
    redraw();
  }, [selectedShape]);

  useEffect(() => {
    if (bigStaticError !== null) {
      console.error("Could not load route and stops:", bigStaticError);
    }
  }, [bigStaticError]);

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
  // Version announcements must still work if the map cannot initialize.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let isMounted = true; // Flag to track if component is still mounted
    let appUpdater = __DEV__
      ? null
      : createAppUpdater((url) => window.location.replace(url.href));

    const connectWebSocket = () => {
      if (!isMounted) {
        return;
      }

      const url = new URL(getUrl("ws", "wss", "ws-v4"));
      if (appUpdater) url.searchParams.set("appUpdates", "1");
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("WebSocket connection established");
        reconnectAttempts = 0; // Reset attempts on successful connection
      });

      ws.addEventListener("message", (event) => {
        if (!isMounted) return;
        const data = JSON.parse(event.data);
        if (data.type === "app-version") {
          void appUpdater?.handleVersion(data);
          return;
        }
        if (!mapRef.current) return;
        if (isNewsStatus(data)) {
          if (seenNewsVersionRef.current === null) {
            seenNewsVersionRef.current = data.version;
            setSeenNewsVersion(data.version);
          }
          newsStatusRef.current = data;
          setNewsStatus(data);
          return;
        }
        const stateData = data as CompressedRealTimeState;
        const state: RealTimeState = decompressRealTimeState(stateData);
        realTimeData.current = state;
        setLastUpdateTime(state.timestamp * 1000);
        // Try to display data - redraw() will check if map is ready
        redraw();
        setActiveStaticKey(state.activeStaticKey);
      });

      ws.addEventListener("close", () => {
        appUpdater?.dispose();
        appUpdater = null; // Reconnecting must not refresh an ongoing visit.
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
      appUpdater?.dispose();
      ws?.close();
    };
  }, []);

  useEffect(() => {
    newsRef.current = news;
    newsStatusRef.current = newsStatus;
    seenNewsVersionRef.current = seenNewsVersion;
    newsControlRef.current?.setBadge(
      hasUnseenNews(newsStatus, seenNewsVersion),
    );
  }, [newsStatus, seenNewsVersion]);

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
        filterHidesAllVehiclesRef.current,
      );
    }
  }, [filterState]);

  if (mapFailure) {
    return <MapUnavailable failure={mapFailure} />;
  }

  return (
    <>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
        <StaleDataIndicator lastUpdateTime={lastUpdateTime} />
        {PERFORMANCE_MODE && (
          <PerfOverlay
            map={perfMap}
            initialAtlasBuildMs={initialAtlasBuildMs}
            mapCanvasDpr={mapCanvasDpr}
          />
        )}
      </div>
      {showInfo && <InfoOverlay onClose={() => setShowInfo(false)} />}
      {newsOverlayState !== "hidden" && (
        <NewsOverlay
          snapshot={news}
          state={newsOverlayState}
          onClose={closeNews}
        />
      )}
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
