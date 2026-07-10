import { describe, expect, it } from "vitest";
import { applyCommand, emptyHistory, pushApplied, redo, undo, type Command } from "./commands";
import {
  createEmptyDocument,
  deserializeDocument,
  serializeDocument,
  type CraftbitDocument,
  type SketchFeature,
} from "./document";

function sketch(id: string): SketchFeature {
  return {
    id,
    type: "sketch",
    name: `Sketch ${id}`,
    suppressed: false,
    plane: { kind: "origin", plane: "XY" },
    profiles: [{ id: `${id}-r`, kind: "rect", x: "0", y: "0", width: "60", height: "40" }],
  };
}

describe("applyCommand", () => {
  it("addFeature/removeFeature invert each other", () => {
    const doc0 = createEmptyDocument("d", "Test");
    const add = applyCommand(doc0, { kind: "addFeature", feature: sketch("s1") });
    expect(add.doc.features).toHaveLength(1);
    const remove = applyCommand(add.doc, add.inverse);
    expect(remove.doc.features).toHaveLength(0);
  });

  it("updateFeature preserves order and inverts", () => {
    const doc0 = createEmptyDocument("d", "Test");
    let doc = applyCommand(doc0, { kind: "addFeature", feature: sketch("s1") }).doc;
    doc = applyCommand(doc, { kind: "addFeature", feature: sketch("s2") }).doc;
    const next = { ...sketch("s1"), name: "Renamed" };
    const upd = applyCommand(doc, { kind: "updateFeature", featureId: "s1", next });
    expect(upd.doc.features[0]!.name).toBe("Renamed");
    expect(upd.doc.features[1]!.id).toBe("s2");
    const undone = applyCommand(upd.doc, upd.inverse);
    expect(undone.doc.features[0]!.name).toBe("Sketch s1");
  });
});

describe("undo/redo random walk", () => {
  it("N random commands then N undos returns to start; N redos returns to end", () => {
    for (let seed = 0; seed < 20; seed++) {
      let rng = seed * 2654435761 + 1;
      const rand = () => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng / 0x7fffffff;
      };

      let doc: CraftbitDocument = createEmptyDocument("d", "Walk");
      let history = emptyHistory();
      let counter = 0;

      for (let step = 0; step < 30; step++) {
        const commands: Command[] = [];
        commands.push({ kind: "addFeature", feature: sketch(`s${counter++}`) });
        if (doc.features.length > 0) {
          const target = doc.features[Math.floor(rand() * doc.features.length)]!;
          commands.push({ kind: "removeFeature", featureId: target.id });
          commands.push({
            kind: "updateFeature",
            featureId: target.id,
            next: { ...target, name: `n${counter}` },
          });
        }
        commands.push({
          kind: "addParameter",
          parameter: { id: `p${counter}`, name: `p${counter}`, expression: "1" },
        });
        const command = commands[Math.floor(rand() * commands.length)]!;
        const applied = applyCommand(doc, command);
        doc = applied.doc;
        history = pushApplied(history, applied.inverse);
      }

      const endState = serializeDocument(doc);
      const startState = serializeDocument(createEmptyDocument("d", "Walk"));

      let state = { doc, history };
      while (state.history.undoStack.length > 0) {
        state = undo(state.doc, state.history)!;
      }
      expect(serializeDocument(state.doc)).toBe(startState);

      while (state.history.redoStack.length > 0) {
        state = redo(state.doc, state.history)!;
      }
      expect(serializeDocument(state.doc)).toBe(endState);
    }
  });
});

describe("serialization round trip", () => {
  it("serialize → deserialize is identity", () => {
    let doc = createEmptyDocument("d", "RT");
    doc = applyCommand(doc, { kind: "addFeature", feature: sketch("s1") }).doc;
    doc = applyCommand(doc, {
      kind: "addParameter",
      parameter: { id: "p1", name: "thickness", expression: "3" },
    }).doc;
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
  });

  it("rejects malformed documents", () => {
    expect(() => deserializeDocument("{}")).toThrow();
    expect(() => deserializeDocument(`{"formatVersion": 99}`)).toThrow();
  });
});
