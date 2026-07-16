import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import "./PerfOverlay.css";

interface PerfStats {
  fps: number;
  avgFrameMs: number;
  worstFrameMs: number;
  longFrames: number;
}

const INITIAL_STATS: PerfStats = {
  fps: 0,
  avgFrameMs: 0,
  worstFrameMs: 0,
  longFrames: 0,
};

function formatMs(value: number) {
  return `${value.toFixed(1)} ms`;
}

export function PerfOverlay({
  map,
  initialAtlasBuildMs,
  mapCanvasDpr,
}: {
  map: maplibregl.Map | null;
  initialAtlasBuildMs: number | null;
  mapCanvasDpr: number | null;
}) {
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);

  useEffect(() => {
    if (!map) return;

    let lastFrameTime: number | null = null;
    let sampleStart = performance.now();
    let frames = 0;
    let totalFrameMs = 0;
    let worstFrameMs = 0;
    let longFrames = 0;

    const measure = () => {
      const time = performance.now();
      if (lastFrameTime === null) {
        lastFrameTime = time;
        frames += 1;
        return;
      }

      const frameMs = time - lastFrameTime;
      lastFrameTime = time;
      frames += 1;
      totalFrameMs += frameMs;
      worstFrameMs = Math.max(worstFrameMs, frameMs);
      if (frameMs > 50) {
        longFrames += 1;
      }
    };

    map.on("render", measure);
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - sampleStart;
      setStats({
        fps: (frames * 1000) / elapsed,
        avgFrameMs: frames > 1 ? totalFrameMs / (frames - 1) : 0,
        worstFrameMs,
        longFrames,
      });
      sampleStart = now;
      frames = 0;
      totalFrameMs = 0;
      worstFrameMs = 0;
      longFrames = 0;
      lastFrameTime = null;
    }, 1000);

    return () => {
      map.off("render", measure);
      clearInterval(interval);
    };
  }, [map]);

  return (
    <div className="perf-overlay">
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">FPS</span>
        <span>{stats.fps.toFixed(1)}</span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">Avg</span>
        <span>{formatMs(stats.avgFrameMs)}</span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">Worst</span>
        <span>{formatMs(stats.worstFrameMs)}</span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">Long</span>
        <span>{stats.longFrames}/s</span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">Atlas</span>
        <span>
          {initialAtlasBuildMs === null ? "—" : formatMs(initialAtlasBuildMs)}
        </span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">DPR window</span>
        <span>{window.devicePixelRatio || 1}</span>
      </div>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">DPR map</span>
        <span>{mapCanvasDpr === null ? "—" : mapCanvasDpr}</span>
      </div>
    </div>
  );
}
