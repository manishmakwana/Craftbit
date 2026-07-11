/**
 * Command pattern over the document (spec §7.14): every mutation is a Command
 * with enough data to invert it. The history stack gives unlimited in-session
 * undo/redo; commands are pure data so they serialize with the autosave journal.
 */

import type { CraftbitDocument, Feature, Parameter } from "./document";

export type Command =
  | { kind: "addFeature"; feature: Feature; index?: number }
  | { kind: "removeFeature"; featureId: string }
  | { kind: "updateFeature"; featureId: string; next: Feature; prev?: Feature }
  | { kind: "addParameter"; parameter: Parameter }
  | { kind: "removeParameter"; parameterId: string }
  | { kind: "updateParameter"; parameterId: string; next: Parameter; prev?: Parameter }
  | { kind: "renameDocument"; name: string; prevName?: string }
  | { kind: "setBodyColor"; bodyId: string; color: string; prevColor?: string };

export interface AppliedCommand {
  command: Command;
  inverse: Command;
}

/** Applies a command, returning the new document and the inverse command. */
export function applyCommand(
  doc: CraftbitDocument,
  command: Command,
): AppliedCommand & {
  doc: CraftbitDocument;
} {
  switch (command.kind) {
    case "addFeature": {
      const index = command.index ?? doc.features.length;
      const features = [...doc.features];
      features.splice(index, 0, command.feature);
      return {
        doc: { ...doc, features },
        command,
        inverse: { kind: "removeFeature", featureId: command.feature.id },
      };
    }
    case "removeFeature": {
      const index = doc.features.findIndex((f) => f.id === command.featureId);
      if (index < 0) throw new Error(`No feature ${command.featureId}`);
      const removed = doc.features[index]!;
      const features = doc.features.filter((f) => f.id !== command.featureId);
      return {
        doc: { ...doc, features },
        command,
        inverse: { kind: "addFeature", feature: removed, index },
      };
    }
    case "updateFeature": {
      const index = doc.features.findIndex((f) => f.id === command.featureId);
      if (index < 0) throw new Error(`No feature ${command.featureId}`);
      const prev = doc.features[index]!;
      const features = [...doc.features];
      features[index] = command.next;
      return {
        doc: { ...doc, features },
        command,
        inverse: { kind: "updateFeature", featureId: command.featureId, next: prev },
      };
    }
    case "addParameter": {
      return {
        doc: { ...doc, parameters: [...doc.parameters, command.parameter] },
        command,
        inverse: { kind: "removeParameter", parameterId: command.parameter.id },
      };
    }
    case "removeParameter": {
      const removed = doc.parameters.find((p) => p.id === command.parameterId);
      if (!removed) throw new Error(`No parameter ${command.parameterId}`);
      return {
        doc: { ...doc, parameters: doc.parameters.filter((p) => p.id !== command.parameterId) },
        command,
        inverse: { kind: "addParameter", parameter: removed },
      };
    }
    case "updateParameter": {
      const index = doc.parameters.findIndex((p) => p.id === command.parameterId);
      if (index < 0) throw new Error(`No parameter ${command.parameterId}`);
      const prev = doc.parameters[index]!;
      const parameters = [...doc.parameters];
      parameters[index] = command.next;
      return {
        doc: { ...doc, parameters },
        command,
        inverse: { kind: "updateParameter", parameterId: command.parameterId, next: prev },
      };
    }
    case "renameDocument": {
      return {
        doc: { ...doc, name: command.name },
        command,
        inverse: { kind: "renameDocument", name: doc.name },
      };
    }
    case "setBodyColor": {
      const prev = doc.bodyColors[command.bodyId];
      return {
        doc: { ...doc, bodyColors: { ...doc.bodyColors, [command.bodyId]: command.color } },
        command,
        inverse: {
          kind: "setBodyColor",
          bodyId: command.bodyId,
          color: prev ?? "#8ab4f8",
        },
      };
    }
  }
}

export interface History {
  undoStack: Command[];
  redoStack: Command[];
}

export function emptyHistory(): History {
  return { undoStack: [], redoStack: [] };
}

export function pushApplied(history: History, inverse: Command): History {
  return { undoStack: [...history.undoStack, inverse], redoStack: [] };
}

export function undo(
  doc: CraftbitDocument,
  history: History,
): { doc: CraftbitDocument; history: History } | null {
  const inverse = history.undoStack[history.undoStack.length - 1];
  if (!inverse) return null;
  const applied = applyCommand(doc, inverse);
  return {
    doc: applied.doc,
    history: {
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, applied.inverse],
    },
  };
}

export function redo(
  doc: CraftbitDocument,
  history: History,
): { doc: CraftbitDocument; history: History } | null {
  const command = history.redoStack[history.redoStack.length - 1];
  if (!command) return null;
  const applied = applyCommand(doc, command);
  return {
    doc: applied.doc,
    history: {
      undoStack: [...history.undoStack, applied.inverse],
      redoStack: history.redoStack.slice(0, -1),
    },
  };
}
