import { newId, type OriginPlaneName, type SketchFeature } from "@craftbit/core";
import { useDocumentStore } from "../../stores/documentStore";
import { useUiStore } from "../../stores/uiStore";

/** Small popover: pick XY/XZ/YZ, or the selected face, to start a sketch. */
export function PlaneChooserDialog() {
  const dispatch = useDocumentStore((s) => s.dispatch);
  const doc = useDocumentStore((s) => s.doc);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const { openDialog, enterSketch } = useUiStore.getState();

  const create = (plane: SketchFeature["plane"]) => {
    const sketchCount = doc.features.filter((f) => f.type === "sketch").length;
    const feature: SketchFeature = {
      id: newId(),
      type: "sketch",
      name: `Sketch ${sketchCount + 1}`,
      suppressed: false,
      plane,
      profiles: [],
    };
    dispatch({ kind: "addFeature", feature });
    openDialog(null);
    enterSketch(feature.id);
  };

  const face = selectedFaces[0];

  return (
    <div className="plane-chooser" data-testid="plane-chooser">
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}>Sketch on:</span>
      {(["XY", "XZ", "YZ"] as OriginPlaneName[]).map((p) => (
        <button
          key={p}
          className="btn"
          data-testid={`plane-${p}`}
          onClick={() => create({ kind: "origin", plane: p })}
        >
          {p} plane
        </button>
      ))}
      {face && (
        <button
          className="btn primary"
          data-testid="plane-face"
          onClick={() => create({ kind: "face", bodyId: face.bodyId, faceIndex: face.faceIndex })}
        >
          Selected face
        </button>
      )}
      <button className="btn" onClick={() => openDialog(null)}>
        ✕
      </button>
    </div>
  );
}
