import { formatLength, type SketchProfile } from "@craftbit/core";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";
import { ExpressionInput } from "./ExpressionInput";

const BODY_COLORS = ["#8ab4f8", "#6ee7b7", "#fda4af", "#fcd34d", "#c4b5fd", "#67e8f9"];

export function BrowserPanel() {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const result = useGeometryStore((s) => s.result);
  const mode = useUiStore((s) => s.mode);
  const activeSketchId = useUiStore((s) => s.activeSketchId);
  const selectedProfileId = useUiStore((s) => s.selectedProfileId);
  const setSelectedProfile = useUiStore((s) => s.setSelectedProfile);

  const activeSketch =
    mode === "sketch" ? doc.features.find((f) => f.id === activeSketchId) : undefined;

  if (activeSketch && activeSketch.type === "sketch") {
    // Sketch mode: show the active sketch's profiles with editable dimensions.
    const updateProfile = (profileId: string, patch: Partial<SketchProfile>) => {
      const next = {
        ...activeSketch,
        profiles: activeSketch.profiles.map((p) =>
          p.id === profileId ? ({ ...p, ...patch } as SketchProfile) : p,
        ),
      };
      dispatch({ kind: "updateFeature", featureId: activeSketch.id, next });
    };
    const deleteProfile = (profileId: string) => {
      const next = {
        ...activeSketch,
        profiles: activeSketch.profiles.filter((p) => p.id !== profileId),
      };
      dispatch({ kind: "updateFeature", featureId: activeSketch.id, next });
      setSelectedProfile(null);
    };

    return (
      <div className="browser-panel" data-testid="browser-panel">
        <div className="panel-section">
          <h3>Sketch profiles</h3>
          {activeSketch.profiles.length === 0 && (
            <div className="dialog-hint">
              Draw with the tools above. Dimensions become editable here.
            </div>
          )}
          {activeSketch.profiles.map((p) => (
            <div key={p.id}>
              <div
                className={`panel-item ${selectedProfileId === p.id ? "selected" : ""}`}
                onClick={() => setSelectedProfile(selectedProfileId === p.id ? null : p.id)}
              >
                <span>{p.kind === "rect" ? "▭" : p.kind === "circle" ? "◯" : "⬠"}</span>
                <span>{p.kind}</span>
                <span className="meta">
                  <button
                    className="btn danger-text"
                    style={{ height: 20, padding: "0 5px", fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteProfile(p.id);
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
              {selectedProfileId === p.id && p.kind === "rect" && (
                <div style={{ padding: "4px 8px" }}>
                  <ExpressionInput
                    label="Width"
                    value={p.width}
                    onCommit={(v) => updateProfile(p.id, { width: v })}
                  />
                  <ExpressionInput
                    label="Height"
                    value={p.height}
                    onCommit={(v) => updateProfile(p.id, { height: v })}
                  />
                  <ExpressionInput
                    label="X"
                    value={p.x}
                    onCommit={(v) => updateProfile(p.id, { x: v })}
                  />
                  <ExpressionInput
                    label="Y"
                    value={p.y}
                    onCommit={(v) => updateProfile(p.id, { y: v })}
                  />
                </div>
              )}
              {selectedProfileId === p.id && p.kind === "circle" && (
                <div style={{ padding: "4px 8px" }}>
                  <ExpressionInput
                    label="Radius"
                    value={p.radius}
                    onCommit={(v) => updateProfile(p.id, { radius: v })}
                  />
                  <ExpressionInput
                    label="Center X"
                    value={p.cx}
                    onCommit={(v) => updateProfile(p.id, { cx: v })}
                  />
                  <ExpressionInput
                    label="Center Y"
                    value={p.cy}
                    onCommit={(v) => updateProfile(p.id, { cy: v })}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-panel" data-testid="browser-panel">
      <div className="panel-section">
        <h3>Bodies</h3>
        {(result?.bodies ?? []).length === 0 && (
          <div className="dialog-hint">No bodies yet — sketch, then extrude.</div>
        )}
        {(result?.bodies ?? []).map((body) => {
          const creator = doc.features.find((f) => f.id === body.id);
          const color = doc.bodyColors[body.id] ?? "#8ab4f8";
          return (
            <div key={body.id} className="panel-item" data-testid="body-item">
              <span
                className="color-dot"
                style={{ background: color }}
                title="Click to cycle color"
                onClick={() => {
                  const next = BODY_COLORS[(BODY_COLORS.indexOf(color) + 1) % BODY_COLORS.length]!;
                  dispatch({ kind: "setBodyColor", bodyId: body.id, color: next });
                }}
              />
              <span>{creator?.name ?? "Body"}</span>
              <span className="meta">{(body.volume / 1000).toFixed(1)} cm³</span>
            </div>
          );
        })}
      </div>
      <div className="panel-section">
        <h3>Sketches</h3>
        {doc.features.filter((f) => f.type === "sketch").length === 0 && (
          <div className="dialog-hint">None yet.</div>
        )}
        {doc.features
          .filter((f) => f.type === "sketch")
          .map((f) => (
            <div
              key={f.id}
              className="panel-item"
              onDoubleClick={() => useUiStore.getState().enterSketch(f.id)}
              title="Double-click to edit"
            >
              <span>✏</span>
              <span>{f.name}</span>
              <span className="meta">{f.type === "sketch" ? f.profiles.length : 0} profiles</span>
            </div>
          ))}
      </div>
      <div className="panel-section">
        <h3>Parameters</h3>
        {doc.parameters.map((p) => (
          <div
            key={p.id}
            className="panel-item"
            onClick={() => useUiStore.getState().openDialog({ kind: "parameters" })}
          >
            <span>ƒ</span>
            <span>{p.name}</span>
            <span className="meta">
              {result?.parameterValues[p.name] !== undefined
                ? formatLength(result.parameterValues[p.name]!, doc.units)
                : p.expression}
            </span>
          </div>
        ))}
        {doc.parameters.length === 0 && <div className="dialog-hint">None yet.</div>}
      </div>
    </div>
  );
}
