import type { ContextProbe, MapFailure } from "./GraphicsDiagnostics";

const MAX_PREFILLED_LENGTH = 19_000;
const PREFIX = `Pozdrav,

karta se ne može prikazati na mojem uređaju.
Molim vas za podršku za moj uređaj i preglednik.


Tehnički podaci:
`;

// Bound structured values too: MapLibre sometimes puts JSON in Error.message.
function shorten(value: unknown, limit: number): unknown {
  let nodes = Math.min(64, limit);
  const visit = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 4) return "[omitted]";
    if (typeof item === "string") {
      return item.length <= limit ? item : item.slice(0, limit) + "…";
    }
    if (Array.isArray(item))
      return item
        .slice(0, Math.min(8, limit))
        .map((entry) => visit(entry, depth + 1));
    if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>;
      const keys = [
        ...new Set(["message", "statusMessage", ...Object.keys(object)]),
      ]
        .filter(
          (key) =>
            Object.prototype.hasOwnProperty.call(object, key) &&
            key.length <= limit,
        )
        .slice(0, Math.min(8, limit));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys) result[key] = visit(object[key], depth + 1);
      return result;
    }
    return item;
  };
  return visit(value, 0);
}

export function formatMapFailureMessage(failure: MapFailure): string {
  const budget = MAX_PREFILLED_LENGTH - PREFIX.length;
  try {
    const full = JSON.stringify(failure, null, 2);
    if (full.length <= budget) return PREFIX + full;
  } catch {
    // Excessively deep structured errors can exceed JSON.stringify's stack.
  }

  const diagnostics = failure.diagnostics;
  let limit = 1024;
  let json: string;
  do {
    const errorSummary = (error: MapFailure["error"] | undefined) =>
      error && {
        name: shorten(error.name, limit),
        message: shorten(error.message, limit),
      };
    const probeSummary = (probe: ContextProbe | undefined) =>
      probe && {
        contextCreated: probe.contextCreated,
        render: probe.render,
        contextLost: probe.contextLost,
        error: errorSummary(probe.error),
        creationErrors: shorten(probe.creationErrors, limit),
        details: shorten(probe.details, limit),
      };
    const versionSummary = (
      version: NonNullable<MapFailure["diagnostics"]>["webgl1"],
    ) => ({
      map: probeSummary(version.map),
      relaxed: probeSummary(version.relaxed),
    });
    json = JSON.stringify(
      {
        truncated: true,
        error: errorSummary(failure.error),
        diagnostics: diagnostics && {
          failureStage: shorten(diagnostics.failureStage, limit),
          webgl1: versionSummary(diagnostics.webgl1),
          webgl2: versionSummary(diagnostics.webgl2),
          maplibreVersion: shorten(diagnostics.maplibreVersion, limit),
          frontendBundle: shorten(diagnostics.frontendBundle, limit),
          environment: shorten(diagnostics.environment, limit),
        },
        diagnosticsError: errorSummary(failure.diagnosticsError),
      },
      null,
      2,
    );
    limit = Math.floor(limit / 2);
    // Measure after JSON escaping and indentation. Never slice serialized JSON.
  } while (json.length > budget);
  return PREFIX + json;
}
