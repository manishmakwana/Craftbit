/**
 * Kernel regression tests (spec §10.2) — run the real regeneration engine
 * against the real OCCT WASM kernel and assert exact volumes/counts.
 * Covers GP-1 (bracket) mechanics end to end, parameter edits (GP-4
 * mechanics), error recovery, and both fabrication exporters.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  type CraftbitDocument,
  type ExtrudeFeature,
  type FilletFeature,
  type SketchFeature,
} from "@craftbit/core";
import { loadOcctForNode } from "./loadOcctNode";
import {
  collectUniqueEdges,
  regenerateDocument,
  resolvePlane,
  type RegenState,
} from "../src/regen";
import { exportStl, exportStep } from "../src/exporters";
import { tessellateShape } from "../src/tessellate";
import type { OpenCascadeInstance } from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

function baseSketch(overrides?: Partial<SketchFeature>): SketchFeature {
  return {
    id: "sketch1",
    type: "sketch",
    name: "Sketch 1",
    suppressed: false,
    plane: { kind: "origin", plane: "XY" },
    profiles: [{ id: "r1", kind: "rect", x: "0", y: "0", width: "60", height: "40" }],
    ...overrides,
  };
}

function extrude(overrides?: Partial<ExtrudeFeature>): ExtrudeFeature {
  return {
    id: "extrude1",
    type: "extrude",
    name: "Extrude 1",
    suppressed: false,
    sketchId: "sketch1",
    profileIds: [],
    distance: "5",
    direction: "normal",
    operation: "new",
    ...overrides,
  };
}

function docWith(
  features: CraftbitDocument["features"],
  parameters: CraftbitDocument["parameters"] = [],
) {
  const doc = createEmptyDocument("test-doc", "Test");
  return { ...doc, features, parameters };
}

/** Finds the face index of `bodyId` whose plane matches the given normal+origin-dot. */
function findFace(
  state: RegenState,
  bodyId: string,
  normal: [number, number, number],
  originDot: number,
): number {
  const faceCount = 20;
  for (let i = 0; i < faceCount; i++) {
    try {
      const plane = resolvePlane(oc, { kind: "face", bodyId, faceIndex: i }, state);
      const dot =
        plane.normal[0] * normal[0] + plane.normal[1] * normal[1] + plane.normal[2] * normal[2];
      const posDot =
        plane.origin[0] * normal[0] + plane.origin[1] * normal[1] + plane.origin[2] * normal[2];
      if (dot > 0.999 && Math.abs(posDot - originDot) < 1e-6) return i;
    } catch {
      break;
    }
  }
  throw new Error("Face not found");
}

describe("regeneration engine (real kernel)", () => {
  it("extrudes a rectangle sketch into a 60x40x5 body", () => {
    const state = regenerateDocument(oc, docWith([baseSketch(), extrude()]));
    expect(state.statuses["sketch1"]!.level).toBe("ok");
    expect(state.statuses["extrude1"]!.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(12000, 3);
    expect(collectUniqueEdges(oc, state.bodies[0]!.shape)).toHaveLength(12);
  });

  it("cuts holes via a sketch on the top face (GP-1 mechanics)", () => {
    // First pass to discover the top face index (what the UI's face pick does).
    const state1 = regenerateDocument(oc, docWith([baseSketch(), extrude()]));
    const topFace = findFace(state1, "extrude1", [0, 0, 1], 5);

    // Sketch coords are plane-local, and a face plane's origin sits wherever
    // OCCT parameterized the surface (the face center here, NOT the corner).
    // Convert desired world positions → plane coords, as the UI does on click.
    const plane = resolvePlane(
      oc,
      { kind: "face", bodyId: "extrude1", faceIndex: topFace },
      state1,
    );
    const toLocal = (w: [number, number, number]): { x: number; y: number } => {
      const d = [w[0] - plane.origin[0], w[1] - plane.origin[1], w[2] - plane.origin[2]];
      return {
        x: d[0]! * plane.xdir[0] + d[1]! * plane.xdir[1] + d[2]! * plane.xdir[2],
        y: d[0]! * plane.ydir[0] + d[1]! * plane.ydir[1] + d[2]! * plane.ydir[2],
      };
    };
    const c1 = toLocal([15, 20, 5]);
    const c2 = toLocal([45, 20, 5]);

    const holeSketch: SketchFeature = {
      id: "sketch2",
      type: "sketch",
      name: "Holes",
      suppressed: false,
      plane: { kind: "face", bodyId: "extrude1", faceIndex: topFace },
      profiles: [
        { id: "c1", kind: "circle", cx: String(c1.x), cy: String(c1.y), radius: "4" },
        { id: "c2", kind: "circle", cx: String(c2.x), cy: String(c2.y), radius: "4" },
      ],
    };
    const cut = extrude({
      id: "extrude2",
      sketchId: "sketch2",
      distance: "10",
      direction: "reversed",
      operation: "cut",
    });

    const state = regenerateDocument(oc, docWith([baseSketch(), extrude(), holeSketch, cut]));
    expect(state.statuses["extrude2"]!.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    const expected = 12000 - 2 * Math.PI * 16 * 5;
    expect(state.bodies[0]!.volume).toBeCloseTo(expected, 1);
  });

  it("fillets edges and reduces volume by the exact corner residue", () => {
    const fillet: FilletFeature = {
      id: "fillet1",
      type: "fillet",
      name: "Fillet 1",
      suppressed: false,
      radius: "3",
      // Vertical edges of the 60x40x5 slab — indices found by geometry below.
      edges: [],
    };
    const state1 = regenerateDocument(oc, docWith([baseSketch(), extrude()]));
    const edges = collectUniqueEdges(oc, state1.bodies[0]!.shape);
    const verticalIndices: number[] = [];
    edges.forEach((edge, i) => {
      const curve = new oc.BRepAdaptor_Curve_2(edge);
      const p1 = curve.Value(curve.FirstParameter());
      const p2 = curve.Value(curve.LastParameter());
      if (
        Math.abs(p1.X() - p2.X()) < 1e-9 &&
        Math.abs(p1.Y() - p2.Y()) < 1e-9 &&
        Math.abs(p1.Z() - p2.Z()) > 1e-9
      ) {
        verticalIndices.push(i);
      }
    });
    expect(verticalIndices).toHaveLength(4);
    fillet.edges = verticalIndices.map((edgeIndex) => ({ bodyId: "extrude1", edgeIndex }));

    const state = regenerateDocument(oc, docWith([baseSketch(), extrude(), fillet]));
    expect(state.statuses["fillet1"]!.level).toBe("ok");
    // Each filleted vertical corner removes (r² - πr²/4) × height.
    const expected = 12000 - 4 * (9 - (Math.PI * 9) / 4) * 5;
    expect(state.bodies[0]!.volume).toBeCloseTo(expected, 1);
  });

  it("re-evaluates parameters (GP-4 mechanics): width 60 → 80", () => {
    const paramSketch = baseSketch({
      profiles: [{ id: "r1", kind: "rect", x: "0", y: "0", width: "width", height: "40" }],
    });
    const doc60 = docWith(
      [paramSketch, extrude()],
      [{ id: "p1", name: "width", expression: "60" }],
    );
    const doc80 = docWith(
      [paramSketch, extrude()],
      [{ id: "p1", name: "width", expression: "80" }],
    );
    expect(regenerateDocument(oc, doc60).bodies[0]!.volume).toBeCloseTo(12000, 3);
    expect(regenerateDocument(oc, doc80).bodies[0]!.volume).toBeCloseTo(16000, 3);
  });

  it("supports symmetric extrude", () => {
    const state = regenerateDocument(
      oc,
      docWith([baseSketch(), extrude({ direction: "symmetric", distance: "10" })]),
    );
    expect(state.bodies[0]!.volume).toBeCloseTo(24000, 3);
    // Symmetric about the plane: mesh bounds should span z ∈ [-5, +5].
    const mesh = tessellateShape(oc, state.bodies[0]!.shape);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      minZ = Math.min(minZ, mesh.positions[i]!);
      maxZ = Math.max(maxZ, mesh.positions[i]!);
    }
    expect(minZ).toBeCloseTo(-5, 3);
    expect(maxZ).toBeCloseTo(5, 3);
  });

  it("treats a nested profile as a hole", () => {
    const sketch = baseSketch({
      profiles: [
        { id: "r1", kind: "rect", x: "0", y: "0", width: "60", height: "40" },
        { id: "c1", kind: "circle", cx: "30", cy: "20", radius: "5" },
      ],
    });
    const state = regenerateDocument(oc, docWith([sketch, extrude()]));
    expect(state.bodies[0]!.volume).toBeCloseTo((2400 - Math.PI * 25) * 5, 1);
  });

  it("reports a failed fillet as a feature error and keeps the body", () => {
    const fillet: FilletFeature = {
      id: "fillet1",
      type: "fillet",
      name: "Fillet 1",
      suppressed: false,
      radius: "500", // absurd radius — must fail
      edges: [{ bodyId: "extrude1", edgeIndex: 0 }],
    };
    const state = regenerateDocument(oc, docWith([baseSketch(), extrude(), fillet]));
    expect(state.statuses["fillet1"]!.level).toBe("error");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(12000, 3);
  });

  it("reports parameter cycles without crashing regeneration", () => {
    const doc = docWith(
      [baseSketch(), extrude()],
      [
        { id: "p1", name: "a", expression: "b + 1" },
        { id: "p2", name: "b", expression: "a + 1" },
      ],
    );
    const state = regenerateDocument(oc, doc);
    expect(state.parameterError).toMatch(/cycle/i);
  });
});

describe("fabrication exporters (real kernel)", () => {
  it("exports a watertight binary STL with exact bounds (spec §7.13.1)", () => {
    const state = regenerateDocument(oc, docWith([baseSketch(), extrude()]));
    const { bytes, validation } = exportStl(oc, [state.bodies[0]!.shape]);
    expect(validation.watertight).toBe(true);
    expect(validation.openEdgeCount).toBe(0);
    expect(validation.boundsMm.min[0]).toBeCloseTo(0, 3);
    expect(validation.boundsMm.max[0]).toBeCloseTo(60, 3);
    expect(validation.boundsMm.max[1]).toBeCloseTo(40, 3);
    expect(validation.boundsMm.max[2]).toBeCloseTo(5, 3);
    // Binary STL structure: 80-byte header + count + 50 bytes/triangle.
    const count = new DataView(bytes.buffer).getUint32(80, true);
    expect(count).toBe(validation.triangleCount);
    expect(bytes.length).toBe(84 + count * 50);
  });

  it("exports STEP that starts with the ISO-10303-21 header (spec §7.13.4)", () => {
    const state = regenerateDocument(oc, docWith([baseSketch(), extrude()]));
    const bytes = exportStep(oc, [state.bodies[0]!.shape]);
    const head = new TextDecoder().decode(bytes.slice(0, 13));
    expect(head).toBe("ISO-10303-21;");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
