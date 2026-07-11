import { newId, type ImportStepFeature } from "@craftbit/core";
import { useDocumentStore } from "../stores/documentStore";
import { useUiStore, type DialogState, type SketchTool } from "../stores/uiStore";

export function Toolbar() {
  const mode = useUiStore((s) => s.mode);
  return mode === "sketch" ? <SketchToolbar /> : <ModelToolbar />;
}

function importStepFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const feature: ImportStepFeature = {
      id: newId(),
      type: "importStep",
      name: file.name.replace(/\.(step|stp)$/i, ""),
      suppressed: false,
      fileName: file.name,
      dataB64: btoa(bin),
    };
    useDocumentStore.getState().dispatch({ kind: "addFeature", feature });
    useUiStore.getState().showToast(`Importing ${file.name}…`);
  };
  input.click();
}

function ModelToolbar() {
  const openDialog = useUiStore((s) => s.openDialog);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const doc = useDocumentStore((s) => s.doc);
  const hasSketch = doc.features.some((f) => f.type === "sketch");
  const hasBody = doc.features.some(
    (f) =>
      (f.type === "extrude" && f.operation === "new") ||
      f.type === "importStep" ||
      (f.type === "revolve" && f.operation === "new"),
  );

  const btn = (
    testid: string,
    label: string,
    dialog: DialogState,
    opts?: { disabled?: boolean; title?: string },
  ) => (
    <button
      className="btn"
      data-testid={testid}
      disabled={opts?.disabled}
      title={opts?.title ?? label}
      onClick={() => openDialog(dialog)}
    >
      {label}
    </button>
  );

  return (
    <div className="toolbar">
      {btn(
        "tool-new-sketch",
        "✏ Sketch",
        { kind: "planeChooser" },
        { title: "Create a sketch (S)" },
      )}
      {btn(
        "tool-extrude",
        "⬆ Extrude",
        { kind: "extrude" },
        { disabled: !hasSketch, title: "Extrude a sketch (E)" },
      )}
      {btn("tool-revolve", "⟳ Revolve", { kind: "revolve" }, { disabled: !hasSketch })}
      <span style={{ width: 8 }} />
      {btn(
        "tool-fillet",
        "◠ Fillet",
        { kind: "fillet" },
        { disabled: selectedEdges.length === 0, title: "Fillet selected edges" },
      )}
      {btn(
        "tool-chamfer",
        "◣ Chamfer",
        { kind: "chamfer" },
        { disabled: selectedEdges.length === 0, title: "Chamfer selected edges" },
      )}
      {btn(
        "tool-shell",
        "▢ Shell",
        { kind: "shell" },
        {
          disabled: selectedFaces.length === 0,
          title: "Hollow the body, opening the selected faces",
        },
      )}
      <span style={{ width: 8 }} />
      {btn("tool-mirror", "⇋ Mirror", { kind: "mirror" }, { disabled: !hasBody })}
      {btn("tool-linear-pattern", "⠿ Pattern", { kind: "linearPattern" }, { disabled: !hasBody })}
      {btn(
        "tool-circular-pattern",
        "⊚ Circular",
        { kind: "circularPattern" },
        { disabled: !hasBody },
      )}
      {btn("tool-boolean", "⊛ Combine", { kind: "boolean" }, { disabled: !hasBody })}
      {btn(
        "tool-move",
        "✥ Move",
        { kind: "move" },
        { disabled: !hasBody, title: "Move/rotate a body (assembly positioning)" },
      )}
      <span style={{ width: 8 }} />
      <button
        className="btn"
        data-testid="tool-import-step"
        onClick={importStepFile}
        title="Import a STEP file as a new body"
      >
        ⇪ Import STEP
      </button>
      <span className="spacer" style={{ flex: 1 }} />
      {btn("tool-parameters", "ƒx Parameters", { kind: "parameters" })}
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
