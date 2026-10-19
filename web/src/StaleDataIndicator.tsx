import { useState, useEffect, useRef } from "react";
import "./StaleDataIndicator.css";
import { formatDuration } from "./formatDuration";

const STALE_THRESHOLD_SECONDS = 30;
const CRITICAL_THRESHOLD_SECONDS = 180;

function formatElapsed(totalSeconds: number): string {
  return `Zadnji podaci: prije ${formatDuration(totalSeconds)}`;
}

interface StaleDataIndicatorProps {
  lastUpdateTime: number | null;
}

export function StaleDataIndicator({
  lastUpdateTime,
}: StaleDataIndicatorProps) {
  const [elapsed, setElapsed] = useState<number>(0);
  const [showMessage, setShowMessage] = useState(false);
  const [hovering, setHovering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const messageVisible = showMessage || hovering;

  useEffect(() => {
    const intervalMs = messageVisible ? 1000 : 5000;
    const interval = setInterval(() => {
      if (lastUpdateTime != null) {
        setElapsed(Math.floor((Date.now() - lastUpdateTime) / 1000));
      }
    }, intervalMs);

    if (lastUpdateTime != null) {
      setElapsed(Math.floor((Date.now() - lastUpdateTime) / 1000));
    }

    return () => clearInterval(interval);
  }, [lastUpdateTime, messageVisible]);

  useEffect(() => {
    if (!showMessage) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowMessage(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [showMessage]);

  if (lastUpdateTime == null || elapsed < STALE_THRESHOLD_SECONDS) {
    return null;
  }

  const colorClass =
    elapsed >= CRITICAL_THRESHOLD_SECONDS
      ? "stale-dot-red"
      : "stale-dot-orange";

  return (
    <div className="stale-indicator" ref={containerRef}>
      <div
        className={`stale-dot ${colorClass}`}
        onClick={() => setShowMessage((v) => !v)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      />
      {messageVisible && (
        <div className="stale-message">{formatElapsed(elapsed)}</div>
      )}
    </div>
  );
}
