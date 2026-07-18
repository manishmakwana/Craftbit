import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";
import type { Feature } from "@craftbit/core";

const ICONS: Record<Feature["type"], string> = {
  sketch: "✏",
  extrude: "⬆",
  revolve: "⟳",
  fillet: "◠",
  chamfer: "◣",
  shell: "▢",
  mirror: "⇋",
  linearPattern: "⠿",
  circularPattern: "⊚",
  boolean: "⊛",
  move: "✥",
  importStep: "⇪",
};

export function Timeline() {
  const doc = useDocumentStore((s) => s.doc);
  const result = useGeometryStore((s) => s.result);
  const statuses = result?.statuses ?? {};
  const selectedFeatureId = useUiStore((s) => s.selectedFeatureId);
  const { setSelectedFeature, enterSketch, openDialog, showToast } = useUiStore.getState();
  const dispatch = useDocumentStore((s) => s.dispatch);

  const onEdit = (feature: Feature) => {
    if (feature.type === "sketch") {
      enterSketch(feature.id);
    } else if (feature.type === "importStep") {
      showToast("Imported files can be deleted and re-imported, not edited");
    } else {
      openDialog({ kind: feature.type, featureId: feature.id });
    }
  };

  const onDelete = (feature: Feature) => {
    const dependents = doc.features.filter(
      (f) => f.type === "extrude" && feature.type === "sketch" && f.sketchId === feature.id,
    );
    const message =
      dependents.length > 0
        ? `Delete ${feature.name}? ${dependents.length} dependent feature(s) will fail until edited.`
        : `Delete ${feature.name}?`;
    if (confirm(message)) {
      dispatch({ kind: "removeFeature", featureId: feature.id });
      setSelectedFeature(null);
      showToast(`Deleted ${feature.name}`);
    }
  };

  return (
    <div className="timeline" data-testid="timeline">
      {doc.features.length === 0 && (
        <span className="timeline-empty">Features appear here — create a sketch to start</span>
      )}
      {doc.features.map((feature) => {
        const status = statuses[feature.id];
        const isError = status?.level === "error";
        const isWarning = status?.level === "warning";
        const isSelected = selectedFeatureId === feature.id;
        return (
          <div
            key={feature.id}
            className={`timeline-chip ${isSelected ? "selected" : ""} ${isError ? "error" : ""}`}
            data-testid={`chip-${feature.type}`}
            title={isError || isWarning ? status?.message : feature.name}
            onClick={() => setSelectedFeature(isSelected ? null : feature.id)}
            onDoubleClick={() => onEdit(feature)}
          >
            <span className="chip-icon">{ICONS[feature.type]}</span>
            <span>{feature.name}</span>
            {isError && <span className="error-badge">!</span>}
            {isWarning && (
              <span className="warning-badge" data-testid="warning-badge">
                ⚠
              </span>
            )}
            {isSelected && (
              <>
                <button
                  className="btn"
                  style={{ height: 22, padding: "0 6px" }}
                  onClick={() => onEdit(feature)}
                >
                  Edit
                </button>
                <button
                  className="btn danger-text"
                  style={{ height: 22, padding: "0 6px" }}
                  data-testid="delete-feature"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(feature);
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
