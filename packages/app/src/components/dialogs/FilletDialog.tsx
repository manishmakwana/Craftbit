import { useState } from "react";
import { newId, type FilletFeature } from "@craftbit/core";
import { useDocumentStore } from "../../stores/documentStore";
import { useUiStore } from "../../stores/uiStore";
import { ExpressionInput } from "../ExpressionInput";

export function FilletDialog({ featureId }: { featureId?: string }) {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const { openDialog, showToast, clearSelection } = useUiStore.getState();

  const existing =
    featureId !== undefined
      ? (doc.features.find((f) => f.id === featureId) as FilletFeature | undefined)
      : undefined;

  const [radius, setRadius] = useState(existing?.radius ?? "2");
  const edges =
    existing && selectedEdges.length === 0
      ? existing.edges
      : selectedEdges.map((e) => ({
          bodyId: e.bodyId,
          edgeIndex: e.edgeIndex,
        }));

  const ok = () => {
    if (edges.length === 0) {
      showToast("Select at least one edge in the viewport first", true);
      return;
    }
    if (existing) {
      dispatch({
        kind: "updateFeature",
        featureId: existing.id,
        next: { ...existing, radius, edges },
      });
    } else {
      const count = doc.features.filter((f) => f.type === "fillet").length;
      dispatch({
        kind: "addFeature",
        feature: {
          id: newId(),
          type: "fillet",
          name: `Fillet ${count + 1}`,
          suppressed: false,
          radius,
          edges,
        },
      });
    }
    clearSelection();
    openDialog(null);
  };

  return (
    <div className="dialog-card" data-testid="fillet-dialog">
      <h2>◠ Fillet</h2>
      <span className="selection-count" data-testid="fillet-edge-count">
        {edges.length} edge{edges.length === 1 ? "" : "s"} selected
      </span>
      <div className="dialog-hint">
        Shift-click edges in the viewport to add or remove them from the selection.
      </div>
      <ExpressionInput
        label="Radius (mm or expression)"
        value={radius}
        onCommit={setRadius}
        autoFocus
        testid="fillet-radius"
      />
      <div className="dialog-footer">
        <button className="btn" onClick={() => openDialog(null)}>
          Cancel
        </button>
        <button className="btn primary" onClick={ok} data-testid="fillet-ok">
          OK
        </button>
      </div>
    </div>
  );
}
