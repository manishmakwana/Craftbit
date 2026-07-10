import { useEffect } from "react";
import { Viewport } from "./viewport/Viewport";
import { TopBar } from "./components/TopBar";
import { Toolbar } from "./components/Toolbar";
import { BrowserPanel } from "./components/BrowserPanel";
import { Timeline } from "./components/Timeline";
import { StatusBar } from "./components/StatusBar";
import { PlaneChooserDialog } from "./components/dialogs/PlaneChooserDialog";
import { ExtrudeDialog } from "./components/dialogs/ExtrudeDialog";
import { FilletDialog } from "./components/dialogs/FilletDialog";
import { ParametersDialog } from "./components/dialogs/ParametersDialog";
import { ExportDialog } from "./components/dialogs/ExportDialog";
import { useDocumentStore } from "./stores/documentStore";
import { useGeometryStore } from "./stores/geometryStore";
import { useUiStore } from "./stores/uiStore";
import { loadFromAutosave } from "./stores/persistence";

export function App() {
  const dialog = useUiStore((s) => s.dialog);
  const toast = useUiStore((s) => s.toast);

  // Boot: start kernel load immediately, restore autosaved project.
  useEffect(() => {
    useGeometryStore.getState().init();
    loadFromAutosave().then((doc) => {
      if (doc) {
        useDocumentStore.getState().replaceDocument(doc);
      } else {
        useGeometryStore.getState().requestRegen(useDocumentStore.getState().doc);
      }
    });
  }, []);

  // Global keyboard shortcuts (spec §7.15) — inactive while typing in fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      const ui = useUiStore.getState();
      const docStore = useDocumentStore.getState();

      if ((e.ctrlKey || e.metaKey) && !typing) {
        if (e.key === "z" && !e.shiftKey) {
          e.preventDefault();
          docStore.undo();
          return;
        }
        if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
          e.preventDefault();
          docStore.redo();
          return;
        }
      }
      if (typing) return;

      switch (e.key) {
        case "Escape":
          window.dispatchEvent(new Event("craftbit:cancel-draw"));
          if (ui.dialog) ui.openDialog(null);
          else if (ui.mode === "sketch") ui.exitSketch();
          else ui.clearSelection();
          break;
        case "Delete":
        case "Backspace":
          if (ui.selectedFeatureId) {
            const feature = docStore.doc.features.find((f) => f.id === ui.selectedFeatureId);
            if (feature && confirm(`Delete ${feature.name}?`)) {
              docStore.dispatch({ kind: "removeFeature", featureId: feature.id });
              ui.setSelectedFeature(null);
            }
          }
          break;
        case "s":
          if (ui.mode === "model") ui.openDialog({ kind: "planeChooser" });
          break;
        case "e":
          if (ui.mode === "model") ui.openDialog({ kind: "extrude" });
          break;
        case "f":
          window.dispatchEvent(new Event("craftbit:fit-all"));
          break;
        case "r":
          if (ui.mode === "sketch") ui.setSketchTool("rect");
          break;
        case "c":
          if (ui.mode === "sketch") ui.setSketchTool("circle");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <TopBar />
      <Toolbar />
      <BrowserPanel />
      <div className="viewport-area">
        <Viewport />
        {dialog?.kind === "planeChooser" && <PlaneChooserDialog />}
        {dialog?.kind === "extrude" && <ExtrudeDialog featureId={dialog.featureId} />}
        {dialog?.kind === "fillet" && <FilletDialog featureId={dialog.featureId} />}
        {dialog?.kind === "parameters" && <ParametersDialog />}
        {dialog?.kind === "export" && <ExportDialog />}
        {toast && (
          <div className={`toast ${toast.error ? "error" : ""}`} data-testid="toast">
            {toast.message}
          </div>
        )}
        <StatusBar />
      </div>
      <Timeline />
    </div>
  );
}
