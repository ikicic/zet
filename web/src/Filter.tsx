import { useEffect, useRef, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouteId, SmallStaticData } from "./Data";
import { Overlay } from "./Overlay";
import "./Filter.css";
import "./Switch.css";
import { useLocalStorage } from "./useLocalStorage";

const FILTER_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 20 20" style="fill: none; stroke: #333; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;">
<path d="M5 5h10l-3.5 5v5l-3 1v-6z"/>
</svg>
`;

export interface FilterState {
  selection: Set<RouteId>;
  enabled: boolean;
}

export function useFilterState(
  key: string,
  initialValue: FilterState,
): [FilterState, (filterState: FilterState) => void] {
  const [filterState, setFilterState] = useLocalStorage<FilterState>(
    key,
    initialValue,
    {
      serialize: (state) =>
        JSON.stringify({
          selection: Array.from(state.selection),
          enabled: state.enabled,
        }),
      deserialize: (json) => {
        const parsed = JSON.parse(json);
        return {
          selection: new Set(parsed.selection),
          enabled: parsed.enabled,
        };
      },
    },
  );
  return [filterState, setFilterState];
}

// No search over route names, just a bunch of checkboxes of route IDs.
interface FilterOverlayProps {
  onClose: () => void;
  smallStaticData?: SmallStaticData;
  selection: Set<RouteId>;
  onSelectionChange: (selection: Set<RouteId>) => void;
}

// Helper function to categorize routes
function isTram(routeId: RouteId) {
  // Trams have 1-2 letters, buses have 3 letters
  return routeId.toString().length <= 2;
}

function categorizeRoutes(routeIds: RouteId[]) {
  const trams: RouteId[] = [];
  const buses: RouteId[] = [];

  for (const routeId of routeIds) {
    if (isTram(routeId)) {
      trams.push(routeId);
    } else {
      buses.push(routeId);
    }
  }

  return { trams, buses };
}

// Helper function to get tri-state value
function getTriStateValue(
  selection: Set<RouteId>,
  subset: RouteId[],
): "unchecked" | "checked" | "partial" {
  let count = 0;
  for (const routeId of subset) {
    if (selection.has(Number(routeId))) {
      ++count;
    }
  }
  return count === 0
    ? "unchecked"
    : count === subset.length
      ? "checked"
      : "partial";
}

function VehicleCategory({
  category,
  selection,
  subset,
  onSelectionChange,
}: {
  category: string;
  selection: Set<RouteId>;
  subset: RouteId[];
  onSelectionChange: (selection: Set<RouteId>) => void;
}) {
  const triState = getTriStateValue(selection, subset);
  const checkboxRef = useRef<HTMLInputElement>(null);

  // Set indeterminate state after render
  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = triState === "partial";
    }
  }, [triState]);

  const handleToggle = useCallback(() => {
    const newSelection = new Set(selection);
    if (triState === "checked") {
      // Uncheck all routes in this category
      subset.forEach((routeId) => newSelection.delete(Number(routeId)));
    } else {
      // Check all routes in this category
      subset.forEach((routeId) => newSelection.add(Number(routeId)));
    }
    onSelectionChange(newSelection);
  }, [selection, subset, triState, onSelectionChange]);

  return (
    <div className="filter-category">
      <label className="filter-category-label">
        <input
          ref={checkboxRef}
          type="checkbox"
          className="filter-tri-checkbox"
          checked={triState === "checked"}
          onChange={handleToggle}
        />
        <span className="filter-category-text">{category}</span>
      </label>
    </div>
  );
}

export function FilterOverlay({
  onClose,
  smallStaticData,
  selection,
  onSelectionChange,
}: FilterOverlayProps) {
  if (smallStaticData == null) {
    return <div>(...)</div>;
  }

  const { trams, buses } = categorizeRoutes(smallStaticData.routeIds);

  const handleReset = useCallback(() => {
    onSelectionChange(new Set());
  }, [onSelectionChange]);

  return (
    <Overlay onClose={onClose} verticalPosition="bottom">
      <div className="filter-header">
        <VehicleCategory
          category="Tramvaji"
          selection={selection}
          subset={trams}
          onSelectionChange={onSelectionChange}
        />
        <VehicleCategory
          category="Autobusi"
          selection={selection}
          subset={buses}
          onSelectionChange={onSelectionChange}
        />
        <button
          className="filter-reset-button"
          onClick={handleReset}
          disabled={selection.size === 0}
        >
          Reset
        </button>
      </div>
      <div className="filter-list">
        {smallStaticData.routeIds.map((routeId) => (
          <div key={routeId} className="filter-route">
            <label className="filter-label">
              <input
                type="checkbox"
                className="filter-checkbox"
                checked={selection.has(routeId)}
                onChange={() => {
                  const newSelection = new Set(selection);
                  if (newSelection.has(routeId)) {
                    newSelection.delete(routeId);
                  } else {
                    newSelection.add(routeId);
                  }
                  onSelectionChange(newSelection);
                }}
              />
              <span
                className={`filter-route-id ${
                  isTram(routeId) ? "tram" : "bus"
                }`}
              >
                {routeId}
              </span>
            </label>
          </div>
        ))}
      </div>
    </Overlay>
  );
}

function FilterControlView({
  onShowFilter,
  onToggleFilter,
  selectionSize,
  anyMarkerVisible,
  checked,
}: {
  onShowFilter: () => void;
  onToggleFilter: (enabled: boolean) => void;
  selectionSize: number;
  anyMarkerVisible: boolean;
  checked: boolean;
}) {
  const visible = selectionSize > 0;

  return (
    <>
      {visible && (
        <input
          type="checkbox"
          className="switch"
          checked={checked}
          onChange={(e) => {
            const enabled = e.target.checked;
            onToggleFilter(enabled);
          }}
        />
      )}
      <div
        className={`maplibregl-ctrl-group${
          (anyMarkerVisible ? "" : " no-markers") +
          (selectionSize > 0 && checked ? " active" : "")
        }`}
      >
        <button
          className="maplibregl-ctrl-icon"
          title="Filtar"
          onClick={onShowFilter}
          dangerouslySetInnerHTML={{ __html: FILTER_ICON_SVG }}
        />
      </div>
    </>
  );
}

export class FilterControl {
  private onShowFilter: () => void;
  private onToggleFilter: (enabled: boolean) => void;
  private reactRoot: Root | null;
  private initialState: FilterState;

  constructor({
    onShowFilter,
    onToggleFilter,
    initialState,
  }: {
    onShowFilter: () => void;
    onToggleFilter: (enabled: boolean) => void;
    initialState: FilterState;
  }) {
    this.onShowFilter = onShowFilter;
    this.onToggleFilter = onToggleFilter;
    this.reactRoot = null;
    this.initialState = initialState;
  }

  onAdd() {
    const outerContainer = document.createElement("div");
    outerContainer.className = "maplibregl-ctrl filter-ctrl";
    this.reactRoot = createRoot(outerContainer);

    this.renderView(this.initialState, /* anyMarkerVisible */ 1);

    return outerContainer;
  }

  onRemove() {
    this.reactRoot?.unmount();
    this.reactRoot = null;
  }

  updateState(state: FilterState, anyMarkerVisible: boolean) {
    this.renderView(state, anyMarkerVisible);
  }

  private renderView(state: FilterState, anyMarkerVisible: boolean | number) {
    if (!this.reactRoot) {
      return;
    }
    this.reactRoot.render(
      <FilterControlView
        checked={state.enabled}
        selectionSize={state.selection.size}
        anyMarkerVisible={!!anyMarkerVisible}
        onToggleFilter={(enabled: boolean) => {
          this.onToggleFilter(enabled);
        }}
        onShowFilter={this.onShowFilter}
      />,
    );
  }
}
