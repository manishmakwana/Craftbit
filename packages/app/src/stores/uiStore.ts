/**
 * UI/session state: mode, active tool, selection, open dialog, toasts.
 * Never persisted into the document.
 */

import { create } from "zustand";

export type SketchTool = "select" | "rect" | "circle" | "polygon";

export interface FaceSel {
  bodyId: string;
  faceIndex: number;
}
export interface EdgeSel {
  bodyId: string;
  edgeIndex: number;
}

export type DialogState =
  | { kind: "extrude"; featureId?: string }
  | { kind: "revolve"; featureId?: string }
  | { kind: "fillet"; featureId?: string }
  | { kind: "chamfer"; featureId?: string }
  | { kind: "shell"; featureId?: string }
  | { kind: "mirror"; featureId?: string }
  | { kind: "linearPattern"; featureId?: string }
  | { kind: "circularPattern"; featureId?: string }
  | { kind: "boolean"; featureId?: string }
  | { kind: "move"; featureId?: string }
  | { kind: "parameters" }
  | { kind: "export" }
  | { kind: "planeChooser" }
  | null;

interface UiState {
  mode: "model" | "sketch";
  activeSketchId: string | null;
  sketchTool: SketchTool;
  selectedFaces: FaceSel[];
  selectedEdges: EdgeSel[];
  selectedFeatureId: string | null;
  selectedProfileId: string | null;
  dialog: DialogState;
  toast: { message: string; error: boolean } | null;
  hint: string;

  enterSketch(sketchId: string): void;
  exitSketch(): void;
  setSketchTool(tool: SketchTool): void;
  selectFace(sel: FaceSel | null, additive?: boolean): void;
  selectEdge(sel: EdgeSel | null, additive?: boolean): void;
  clearSelection(): void;
  setSelectedFeature(id: string | null): void;
  setSelectedProfile(id: string | null): void;
  openDialog(dialog: DialogState): void;
  showToast(message: string, error?: boolean): void;
  setHint(hint: string): void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiState>((set) => ({
  mode: "model",
  activeSketchId: null,
  sketchTool: "rect",
  selectedFaces: [],
  selectedEdges: [],
  selectedFeatureId: null,
  selectedProfileId: null,
  dialog: null,
  toast: null,
  hint: "Create a sketch to start",

  enterSketch(sketchId) {
    set({
      mode: "sketch",
      activeSketchId: sketchId,
      sketchTool: "rect",
      dialog: null,
      selectedFaces: [],
      selectedEdges: [],
      selectedProfileId: null,
      hint: "Drag to draw a rectangle · Esc to cancel tool",
    });
  },

  exitSketch() {
    set({
      mode: "model",
      activeSketchId: null,
      selectedProfileId: null,
      hint: "Select faces or edges, or create a feature",
    });
  },

  setSketchTool(tool) {
    const hints: Record<SketchTool, string> = {
      select: "Click a profile to edit its dimensions",
      rect: "Drag to draw a rectangle",
      circle: "Drag from center to draw a circle",
      polygon: "Click to add points · double-click to close",
    };
    set({ sketchTool: tool, hint: hints[tool] });
  },

  selectFace(sel, additive = false) {
    set((s) => {
      if (!sel) return { selectedFaces: [] };
      const exists = s.selectedFaces.some(
        (f) => f.bodyId === sel.bodyId && f.faceIndex === sel.faceIndex,
      );
      if (additive) {
        return {
          selectedFaces: exists
            ? s.selectedFaces.filter(
                (f) => !(f.bodyId === sel.bodyId && f.faceIndex === sel.faceIndex),
              )
            : [...s.selectedFaces, sel],
        };
      }
      return { selectedFaces: [sel], selectedEdges: [] };
    });
  },

  selectEdge(sel, additive = false) {
    set((s) => {
      if (!sel) return { selectedEdges: [] };
      const exists = s.selectedEdges.some(
        (e) => e.bodyId === sel.bodyId && e.edgeIndex === sel.edgeIndex,
      );
      if (additive) {
        return {
          selectedEdges: exists
            ? s.selectedEdges.filter(
                (e) => !(e.bodyId === sel.bodyId && e.edgeIndex === sel.edgeIndex),
              )
            : [...s.selectedEdges, sel],
        };
      }
      return { selectedEdges: [sel], selectedFaces: [] };
    });
  },

  clearSelection() {
    set({ selectedFaces: [], selectedEdges: [], selectedFeatureId: null, selectedProfileId: null });
  },

  setSelectedFeature(id) {
    set({ selectedFeatureId: id });
  },

  setSelectedProfile(id) {
    set({ selectedProfileId: id });
  },

  openDialog(dialog) {
    set({ dialog });
  },

  showToast(message, error = false) {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: { message, error } });
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },

  setHint(hint) {
    set({ hint });
  },
}));
