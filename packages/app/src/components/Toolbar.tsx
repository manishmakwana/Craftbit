import { useDocumentStore } from "../stores/documentStore";
import { useUiStore, type SketchTool } from "../stores/uiStore";

export function Toolbar() {
  const mode = useUiStore((s) => s.mode);
  return mode === "sketch" ? <SketchToolbar /> : <ModelToolbar />;
}

function ModelToolbar() {
  const openDialog = useUiStore((s) => s.openDialog);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const doc = useDocumentStore((s) => s.doc);
  const hasSketch = doc.features.some((f) => f.type === "sketch");

  return (
    <div className="toolbar">
      <button
        className="btn"
        data-testid="tool-new-sketch"
        onClick={() => openDialog({ kind: "planeChooser" })}
        title="Create a sketch on a plane or face (S)"
      >
        ✏ New Sketch
      </button>
      <button
        className="btn"
        data-testid="tool-extrude"
        disabled={!hasSketch}
        onClick={() => openDialog({ kind: "extrude" })}
        title="Extrude a sketch (E)"
      >
        ⬆ Extrude
      </button>
      <button
        className="btn"
        data-testid="tool-fillet"
        disabled={selectedEdges.length === 0}
        onClick={() => openDialog({ kind: "fillet" })}
        title="Fillet selected edges (F) — select edges in the viewport first"
      >
        ◠ Fillet
      </button>
      <span style={{ width: 12 }} />
      <button
        className="btn"
        data-testid="tool-parameters"
        onClick={() => openDialog({ kind: "parameters" })}
      >
        ƒx Parameters
      </button>
    </div>
  );
}

function SketchToolbar() {
  const tool = useUiStore((s) => s.sketchTool);
  const setTool = useUiStore((s) => s.setSketchTool);
  const exitSketch = useUiStore((s) => s.exitSketch);

  const tools: { id: SketchTool; label: string; testid: string }[] = [
    { id: "select", label: "☝ Select", testid: "sketch-tool-select" },
    { id: "rect", label: "▭ Rectangle", testid: "sketch-tool-rect" },
    { id: "circle", label: "◯ Circle", testid: "sketch-tool-circle" },
    { id: "polygon", label: "⬠ Polygon", testid: "sketch-tool-polygon" },
  ];

  return (
    <div className="toolbar">
      {tools.map((t) => (
        <button
          key={t.id}
          data-testid={t.testid}
          className={`btn ${tool === t.id ? "active" : ""}`}
          onClick={() => setTool(t.id)}
        >
          {t.label}
        </button>
      ))}
      <span className="spacer" style={{ flex: 1 }} />
      <button className="btn primary" data-testid="finish-sketch" onClick={exitSketch}>
        ✓ Finish Sketch
      </button>
    </div>
  );
}
