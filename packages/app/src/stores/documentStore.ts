/**
 * The document store: source of truth for the parametric document. Every
 * mutation goes through dispatch(command) (spec §7.14); each dispatch pushes
 * the inverse for undo, triggers regeneration, and schedules an autosave.
 */

import { create } from "zustand";
import {
  applyCommand,
  createEmptyDocument,
  emptyHistory,
  newId,
  pushApplied,
  redo as redoOp,
  undo as undoOp,
  type Command,
  type CraftbitDocument,
  type History,
} from "@craftbit/core";
import { saveToAutosave } from "./persistence";
import { useGeometryStore } from "./geometryStore";

interface DocumentState {
  doc: CraftbitDocument;
  history: History;
  saved: boolean;
  dispatch(command: Command): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  replaceDocument(doc: CraftbitDocument): void;
  newDocument(): void;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutosave(doc: CraftbitDocument, onSaved: () => void) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveToAutosave(doc)
      .then(onSaved)
      .catch((e: unknown) => console.error("Autosave failed:", e));
  }, 400);
}

function afterChange(doc: CraftbitDocument, set: (partial: Partial<DocumentState>) => void) {
  useGeometryStore.getState().requestRegen(doc);
  scheduleAutosave(doc, () => set({ saved: true }));
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  doc: createEmptyDocument(newId(), "Untitled"),
  history: emptyHistory(),
  saved: true,

  dispatch(command) {
    const { doc, history } = get();
    const applied = applyCommand(doc, command);
    set({ doc: applied.doc, history: pushApplied(history, applied.inverse), saved: false });
    afterChange(applied.doc, set);
  },

  undo() {
    const { doc, history } = get();
    const result = undoOp(doc, history);
    if (!result) return;
    set({ doc: result.doc, history: result.history, saved: false });
    afterChange(result.doc, set);
  },

  redo() {
    const { doc, history } = get();
    const result = redoOp(doc, history);
    if (!result) return;
    set({ doc: result.doc, history: result.history, saved: false });
    afterChange(result.doc, set);
  },

  canUndo: () => get().history.undoStack.length > 0,
  canRedo: () => get().history.redoStack.length > 0,

  replaceDocument(doc) {
    set({ doc, history: emptyHistory(), saved: false });
    afterChange(doc, set);
  },

  newDocument() {
    const doc = createEmptyDocument(newId(), "Untitled");
    set({ doc, history: emptyHistory(), saved: false });
    afterChange(doc, set);
  },
}));
