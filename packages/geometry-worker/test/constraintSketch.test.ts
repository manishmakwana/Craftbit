/**
 * Kernel regression tests for the constraint sketcher (design gate D3):
 * constraint-solved entity sketches regenerate into exact solids through the
 * real OCCT kernel — the solver's output drives wires/faces/prisms with
 * closed-form volume assertions.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  type CraftbitDocument,
  type ExtrudeFeature,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
} from "@craftbit/core";
import { loadOcctForNode } from "./loadOcctNode";
import { regenerateDocument } from "../src/regen";
import type { OpenCascadeInstance } from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

function doc(features: CraftbitDocument["features"]): CraftbitDocument {
  const d = createEmptyDocument("t", "t");
  d.features = features;
  return d;
}

function entitySketch(
  id: string,
  entities: SketchEntity[],
  constraints: SketchConstraint[],
): SketchFeature {
  return {
    id,
    type: "sketch",
    name: id,
    suppressed: false,
    plane: { kind: "origin", plane: "XY" },
    profiles: [],
    entities,
    constraints,
  };
}

function extrude(id: string, sketchId: string, distance: string): ExtrudeFeature {
  return {
    id,
    type: "extrude",
    name: id,
    suppressed: false,
    sketchId,
    profileIds: [],
    distance,
    direction: "normal",
    operation: "new",
  };
}

const pt = (id: string, x: number, y: number): SketchEntity => ({ id, kind: "point", x, y });
const ln = (id: string, p1: string, p2: string): SketchEntity => ({ id, kind: "line", p1, p2 });

describe("constraint sketcher (real kernel)", () => {
  it("solves a rough quad to exact 60x40 via constraints and extrudes to exact volume", () => {
    // Deliberately sloppy initial coordinates — the constraints do the work.
    const entities: SketchEntity[] = [
      pt("a", 0.4, -0.7),
      pt("b", 55, 1.9),
      pt("c", 62, 37),
      pt("d", -2, 42),
      ln("l1", "a", "b"),
      ln("l2", "b", "c"),
      ln("l3", "c", "d"),
      ln("l4", "d", "a"),
    ];
    const constraints: SketchConstraint[] = [
      { id: "k0", kind: "fixed", point: "a" },
      { id: "k1", kind: "horizontal", line: "l1" },
      { id: "k2", kind: "horizontal", line: "l3" },
      { id: "k3", kind: "vertical", line: "l2" },
      { id: "k4", kind: "vertical", line: "l4" },
      { id: "k5", kind: "distance", a: "a", b: "b", value: "60" },
      { id: "k6", kind: "distance", a: "b", b: "c", value: "40" },
    ];
    const state = regenerateDocument(
      oc,
      doc([entitySketch("s1", entities, constraints), extrude("e1", "s1", "5")]),
    );
    expect(state.statuses["s1"]?.level).toBe("ok");
    expect(state.statuses["e1"]?.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(60 * 40 * 5, 3);

    const sketch = state.sketches.find((s) => s.featureId === "s1")!;
    expect(sketch.solve).toEqual({ converged: true, dof: 0 });
    expect(sketch.profiles.some((p) => p.kind === "loop")).toBe(true);
  });

  it("parameter expressions drive constraint dimensions", () => {
    const d = doc([
      entitySketch(
        "s1",
        [
          pt("a", 0, 0),
          pt("b", 10, 0),
          pt("c", 10, 10),
          pt("d", 0, 10),
          ln("l1", "a", "b"),
          ln("l2", "b", "c"),
          ln("l3", "c", "d"),
          ln("l4", "d", "a"),
        ],
        [
          { id: "k0", kind: "fixed", point: "a" },
          { id: "k1", kind: "horizontal", line: "l1" },
          { id: "k2", kind: "horizontal", line: "l3" },
          { id: "k3", kind: "vertical", line: "l2" },
          { id: "k4", kind: "vertical", line: "l4" },
          { id: "k5", kind: "distance", a: "a", b: "b", value: "width" },
          { id: "k6", kind: "distance", a: "b", b: "c", value: "width / 2" },
        ],
      ),
      extrude("e1", "s1", "3"),
    ]);
    d.parameters = [{ id: "p1", name: "width", expression: "24" }];
    const state = regenerateDocument(oc, d);
    expect(state.statuses["e1"]?.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(24 * 12 * 3, 3);
  });

  it("extrudes a slot loop (lines + true arc caps) to exact volume", () => {
    // Slot: 40-long straight section, radius-10 semicircular caps.
    const entities: SketchEntity[] = [
      pt("a", 0, -10),
      pt("b", 40, -10),
      pt("c", 40, 10),
      pt("d", 0, 10),
      pt("cl", 0, 0),
      pt("cr", 40, 0),
      ln("bottom", "a", "b"),
      { id: "capR", kind: "arc", center: "cr", start: "b", end: "c", ccw: true },
      ln("top", "c", "d"),
      { id: "capL", kind: "arc", center: "cl", start: "d", end: "a", ccw: true },
    ];
    const constraints: SketchConstraint[] = [
      { id: "k0", kind: "fixed", point: "cl" },
      { id: "k1", kind: "fixed", point: "cr" },
      { id: "k2", kind: "radius", entity: "capL", value: "10" },
      { id: "k3", kind: "radius", entity: "capR", value: "10" },
      { id: "k4", kind: "horizontal", line: "top" },
      { id: "k5", kind: "horizontal", line: "bottom" },
    ];
    const state = regenerateDocument(
      oc,
      doc([entitySketch("s1", entities, constraints), extrude("e1", "s1", "5")]),
    );
    expect(state.statuses["s1"]?.level).toBe("ok");
    expect(state.statuses["e1"]?.level).toBe("ok");
    // Slot area = 40·20 rectangle + full circle r=10 (two semicircle caps).
    const expected = (40 * 20 + Math.PI * 100) * 5;
    expect(state.bodies[0]!.volume).toBeCloseTo(expected, 2);
  });

  it("circle entities become extrudable profiles and cut as holes inside loops", () => {
    // Constrained 30x30 plate with a dimensioned circle hole in the middle.
    const entities: SketchEntity[] = [
      pt("a", 0, 0),
      pt("b", 30, 0),
      pt("c", 30, 30),
      pt("d", 0, 30),
      pt("hc", 15, 15),
      ln("l1", "a", "b"),
      ln("l2", "b", "c"),
      ln("l3", "c", "d"),
      ln("l4", "d", "a"),
      { id: "hole", kind: "circle", center: "hc", radius: 5 },
    ];
    const constraints: SketchConstraint[] = [
      { id: "k0", kind: "fixed", point: "a" },
      { id: "k1", kind: "fixed", point: "b" },
      { id: "k2", kind: "fixed", point: "c" },
      { id: "k3", kind: "fixed", point: "d" },
      { id: "k4", kind: "fixed", point: "hc" },
      { id: "k5", kind: "radius", entity: "hole", value: "4" },
    ];
    const state = regenerateDocument(
      oc,
      doc([entitySketch("s1", entities, constraints), extrude("e1", "s1", "2")]),
    );
    expect(state.statuses["e1"]?.level).toBe("ok");
    // Hole radius solves to the dimensioned 4, not the drawn 5.
    const expected = (30 * 30 - Math.PI * 16) * 2;
    expect(state.bodies[0]!.volume).toBeCloseTo(expected, 2);
  });

  it("reports an error status for conflicting constraints instead of crashing", () => {
    const state = regenerateDocument(
      oc,
      doc([
        entitySketch(
          "s1",
          [pt("a", 0, 0), pt("b", 10, 0), ln("l1", "a", "b")],
          [
            { id: "k0", kind: "fixed", point: "a" },
            { id: "k1", kind: "distance", a: "a", b: "b", value: "10" },
            { id: "k2", kind: "distance", a: "a", b: "b", value: "20" },
          ],
        ),
      ]),
    );
    expect(state.statuses["s1"]?.level).toBe("error");
    expect(state.statuses["s1"]?.message).toMatch(/converge/i);
    // The sketch still reports its (unconverged) state for the UI to draw.
    const sketch = state.sketches.find((s) => s.featureId === "s1");
    expect(sketch?.solve?.converged).toBe(false);
  });

  it("open chains produce no profiles (drawing in progress is not an error)", () => {
    const state = regenerateDocument(
      oc,
      doc([
        entitySketch(
          "s1",
          [pt("a", 0, 0), pt("b", 10, 0), pt("c", 10, 10), ln("l1", "a", "b"), ln("l2", "b", "c")],
          [],
        ),
      ]),
    );
    expect(state.statuses["s1"]?.level).toBe("ok");
    const sketch = state.sketches.find((s) => s.featureId === "s1")!;
    expect(sketch.profiles).toHaveLength(0);
    expect(sketch.entities).toHaveLength(5);
  });
});
