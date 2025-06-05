import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MarkerCache, Marker } from "./Markers";

interface Vehicle {
  id: string;
  routeId: number;
  lat: number[];
  lon: number[];
  timestamp: number;
  directionDegrees: number | null;
}

function updateMarkers(
  map: maplibregl.Map,
  vehicles: Vehicle[],
  markerCache: MarkerCache
) {
  const source = map.getSource("custom-markers") as maplibregl.GeoJSONSource;
  const features: GeoJSON.Feature[] = [];

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
    const marker: Marker = {
      label: vehicle.routeId.toString(),
      directionDegrees: deg,
    };

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coord,
      },
      properties: {
        icon: markerCache.getOrCreate(map, marker),
        zOrder: -vehicle.routeId,
      },
    });
  });

  source.setData({
    type: "FeatureCollection",
    features: features,
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
      id: vehicle.id,
      routeId: vehicle.routeId,
    },
  }));

  const source = map.getSource("trajectories") as maplibregl.GeoJSONSource;
  source.setData({
    type: "FeatureCollection",
    features: features,
  });
}

export function Map() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState<boolean>(false);
  const markerCache = useRef<MarkerCache>(new MarkerCache());

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

      map.addSource("custom-markers", emptyGeoJSON);
      map.addSource("trajectories", emptyGeoJSON);

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
        id: "custom-markers",
        type: "symbol",
        source: "custom-markers",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "symbol-sort-key": ["get", "zOrder"],
        },
      });
      // Hopefully this disabled symbol fade in/out.
      map.setPaintProperty("custom-markers", "icon-opacity", 1.0);

      setMapLoaded(true);
    });

    // Cleanup
    return () => {
      map.remove();
    };
  }, []);

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
      const url =
        window.location.protocol === "https:"
          ? `wss://${window.location.host}/ws`
          : `ws://${window.location.hostname}:5000/ws`;
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("WebSocket connection established");
        reconnectAttempts = 0; // Reset attempts on successful connection
      });

      ws.addEventListener("message", (event) => {
        const vehicles: Vehicle[] = JSON.parse(event.data);
        if (mapRef.current) {
          updateMarkers(mapRef.current, vehicles, markerCache.current);
          updateTrajectories(mapRef.current, vehicles);
        }
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

      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      setTimeout(() => {
        if (!isMounted) {
          return;
        }
        reconnectAttempts++;
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

  return <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />;
}
