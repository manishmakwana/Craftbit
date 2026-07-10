import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

export function StatusBar() {
  const hint = useUiStore((s) => s.hint);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const regenerating = useGeometryStore((s) => s.regenerating);
  const lastError = useGeometryStore((s) => s.lastError);
  const units = useDocumentStore((s) => s.doc.units);

  const selText =
    selectedFaces.length > 0
      ? `${selectedFaces.length} face${selectedFaces.length > 1 ? "s" : ""}`
      : selectedEdges.length > 0
        ? `${selectedEdges.length} edge${selectedEdges.length > 1 ? "s" : ""}`
        : "";

  return (
    <div className="status-bar" data-testid="status-bar">
      <span>{lastError ? `⚠ ${lastError}` : hint}</span>
      <span className="right">
        {regenerating && <span className="busy">● computing…</span>}
        {selText && <span data-testid="selection-count">{selText}</span>}
        <span>{units}</span>
      </span>
    </div>
  );
}
