import { useState } from "react";
import { isValidParameterName, newId, referencedNames } from "@craftbit/core";
import { useDocumentStore } from "../../stores/documentStore";
import { useGeometryStore } from "../../stores/geometryStore";
import { useUiStore } from "../../stores/uiStore";

export function ParametersDialog() {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const result = useGeometryStore((s) => s.result);
  const values = result?.parameterValues ?? {};
  const paramError = result?.parameterError;
  const { openDialog, showToast } = useUiStore.getState();

  const [newName, setNewName] = useState("");
  const [newExpr, setNewExpr] = useState("");

  const referencedBy = (name: string): number => {
    let count = 0;
    for (const f of doc.features) {
      const exprs: string[] = [];
      if (f.type === "extrude") exprs.push(f.distance);
      if (f.type === "fillet") exprs.push(f.radius);
      if (f.type === "sketch") {
        for (const p of f.profiles) {
          if (p.kind === "rect") exprs.push(p.x, p.y, p.width, p.height);
          if (p.kind === "circle") exprs.push(p.cx, p.cy, p.radius);
        }
      }
      if (exprs.some((e) => referencedNames(e).includes(name))) count++;
    }
    for (const p of doc.parameters) {
      if (referencedNames(p.expression).includes(name)) count++;
    }
    return count;
  };

  const add = () => {
    if (!isValidParameterName(newName)) {
      showToast("Names must look like: thickness, hole_d, W2", true);
      return;
    }
    if (doc.parameters.some((p) => p.name === newName)) {
      showToast(`"${newName}" already exists`, true);
      return;
    }
    dispatch({
      kind: "addParameter",
      parameter: { id: newId(), name: newName, expression: newExpr || "0" },
    });
    setNewName("");
    setNewExpr("");
  };

  return (
    <div className="dialog-card" style={{ width: 360 }} data-testid="parameters-dialog">
      <h2>ƒx Parameters</h2>
      {paramError && (
        <div className="error-text" style={{ marginBottom: 8 }}>
          {paramError}
        </div>
      )}
      <table className="param-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Expression</th>
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {doc.parameters.map((p) => (
            <tr key={p.id}>
              <td style={{ fontWeight: 600 }}>{p.name}</td>
              <td>
                <input
                  defaultValue={p.expression}
                  data-testid={`param-expr-${p.name}`}
                  onBlur={(e) => {
                    if (e.target.value !== p.expression) {
                      dispatch({
                        kind: "updateParameter",
                        parameterId: p.id,
                        next: { ...p, expression: e.target.value },
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </td>
              <td className="value-cell">
                {values[p.name] !== undefined
                  ? `${(Math.round(values[p.name]! * 1e4) / 1e4).toString()} mm`
                  : "—"}
              </td>
              <td>
                <button
                  className="btn danger-text"
                  style={{ height: 22, padding: "0 6px" }}
                  onClick={() => {
                    const uses = referencedBy(p.name);
                    if (uses > 0) {
                      showToast(`Cannot delete: "${p.name}" is used in ${uses} place(s)`, true);
                      return;
                    }
                    dispatch({ kind: "removeParameter", parameterId: p.id });
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input
                placeholder="name"
                value={newName}
                data-testid="param-new-name"
                onChange={(e) => setNewName(e.target.value)}
              />
            </td>
            <td>
              <input
                placeholder="e.g. 2 * thickness"
                value={newExpr}
                data-testid="param-new-expr"
                onChange={(e) => setNewExpr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
            </td>
            <td colSpan={2}>
              <button className="btn" onClick={add} data-testid="param-add">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="dialog-footer">
        <button className="btn primary" onClick={() => openDialog(null)}>
          Done
        </button>
      </div>
    </div>
  );
}
