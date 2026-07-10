import { useState } from "react";
import { newId, type ExtrudeFeature, type ExtrudeOp } from "@craftbit/core";
import { useDocumentStore } from "../../stores/documentStore";
import { useUiStore } from "../../stores/uiStore";
import { ExpressionInput } from "../ExpressionInput";

export function ExtrudeDialog({ featureId }: { featureId?: string }) {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const { openDialog, showToast } = useUiStore.getState();

  const existing =
    featureId !== undefined
      ? (doc.features.find((f) => f.id === featureId) as ExtrudeFeature | undefined)
      : undefined;

  const sketches = doc.features.filter((f) => f.type === "sketch");
  const lastSketch = sketches[sketches.length - 1];
  const hasBodies = doc.features.some((f) => f.type === "extrude" && f.operation === "new");

  const [sketchId, setSketchId] = useState(existing?.sketchId ?? lastSketch?.id ?? "");
  const [distance, setDistance] = useState(existing?.distance ?? "5");
  const [direction, setDirection] = useState<ExtrudeFeature["direction"]>(
    existing?.direction ?? "normal",
  );
  const [operation, setOperation] = useState<ExtrudeOp>(
    existing?.operation ?? (hasBodies ? "cut" : "new"),
  );

  const ok = () => {
    if (!sketchId) {
      showToast("Pick a sketch to extrude", true);
      return;
    }
    if (existing) {
      dispatch({
        kind: "updateFeature",
        featureId: existing.id,
        next: { ...existing, sketchId, distance, direction, operation },
      });
    } else {
      const count = doc.features.filter((f) => f.type === "extrude").length;
      dispatch({
        kind: "addFeature",
        feature: {
          id: newId(),
          type: "extrude",
          name: `Extrude ${count + 1}`,
          suppressed: false,
          sketchId,
          profileIds: [],
          distance,
          direction,
          operation,
        },
      });
    }
    openDialog(null);
  };

  return (
    <div className="dialog-card" data-testid="extrude-dialog">
      <h2>⬆ Extrude</h2>
      <div className="field">
        <label>Sketch</label>
        <select
          value={sketchId}
          onChange={(e) => setSketchId(e.target.value)}
          data-testid="extrude-sketch"
        >
          {sketches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <ExpressionInput
        label="Distance (mm or expression)"
        value={distance}
        onCommit={setDistance}
        autoFocus
        testid="extrude-distance"
      />
      <div className="field">
        <label>Direction</label>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as ExtrudeFeature["direction"])}
          data-testid="extrude-direction"
        >
          <option value="normal">Along normal</option>
          <option value="reversed">Reversed</option>
          <option value="symmetric">Symmetric</option>
        </select>
      </div>
      <div className="field">
        <label>Operation</label>
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as ExtrudeOp)}
          data-testid="extrude-operation"
        >
          <option value="new">New body</option>
          <option value="join">Join</option>
          <option value="cut">Cut</option>
        </select>
      </div>
      <div className="dialog-footer">
        <button className="btn" onClick={() => openDialog(null)}>
          Cancel
        </button>
        <button className="btn primary" onClick={ok} data-testid="extrude-ok">
          OK
        </button>
      </div>
    </div>
  );
}
