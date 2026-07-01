import { useEffect, useState } from "react";
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

export function PerfOverlay() {
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);

  useEffect(() => {
    let animationFrame = 0;
    let lastFrameTime = performance.now();
    let sampleStart = lastFrameTime;
    let frames = 0;
    let totalFrameMs = 0;
    let worstFrameMs = 0;
    let longFrames = 0;

    const measure = (time: number) => {
      const frameMs = time - lastFrameTime;
      lastFrameTime = time;
      frames += 1;
      totalFrameMs += frameMs;
      worstFrameMs = Math.max(worstFrameMs, frameMs);
      if (frameMs > 50) {
        longFrames += 1;
      }

      const elapsed = time - sampleStart;
      if (elapsed >= 1000) {
        setStats({
          fps: (frames * 1000) / elapsed,
          avgFrameMs: totalFrameMs / frames,
          worstFrameMs,
          longFrames,
        });
        sampleStart = time;
        frames = 0;
        totalFrameMs = 0;
        worstFrameMs = 0;
        longFrames = 0;
      }

      animationFrame = requestAnimationFrame(measure);
    };

    animationFrame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

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
    </div>
  );
}
