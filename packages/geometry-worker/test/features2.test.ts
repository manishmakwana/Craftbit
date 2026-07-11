/**
 * Kernel regression tests for the second wave of modeling features:
 * revolve, chamfer, shell, mirror, patterns, boolean combine, move, and
 * STEP import — all against the real OCCT kernel with closed-form volume
 * assertions.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  type CraftbitDocument,
  type ExtrudeFeature,
  type Feature,
  type SketchFeature,
} from "@craftbit/core";
import { loadOcctForNode } from "./loadOcctNode";
import { collectUniqueEdges, regenerateDocument } from "../src/regen";
import { exportStep } from "../src/exporters";
import type { OpenCascadeInstance } from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

function sketchRect(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    type: "sketch",
    name: id,
    suppressed: false,
    plane: { kind: "origin", plane: "XY" },
    profiles: [
      {
        id: `${id}-r`,
        kind: "rect",
        x: String(x),
        y: String(y),
        width: String(w),
        height: String(h),
      },
    ],
  };
}

function extrude(
  id: string,
  sketchId: string,
  distance: string,
  operation: ExtrudeFeature["operation"] = "new",
): ExtrudeFeature {
  return {
    id,
    type: "extrude",
    name: id,
    suppressed: false,
    sketchId,
    profileIds: [],
    distance,
    direction: "normal",
    operation,
  };
}

function docWith(features: Feature[]): CraftbitDocument {
  return { ...createEmptyDocument("t", "T"), features };
}

describe("second-wave features (real kernel)", () => {
  it("revolve: full 360° ring from an offset rectangle", () => {
    // Rectangle x∈[10,20], y∈[0,30] on XY, revolved about sketch Y axis
    // → annular cylinder: π(20²−10²)·30 = 28274.33
    const sketch: SketchFeature = {
      id: "s1",
      type: "sketch",
      name: "s1",
      suppressed: false,
      plane: { kind: "origin", plane: "XY" },
      profiles: [{ id: "p", kind: "rect", x: "10", y: "0", width: "10", height: "30" }],
    };
    const state = regenerateDocument(
      oc,
      docWith([
        sketch,
        {
          id: "r1",
          type: "revolve",
          name: "r1",
          suppressed: false,
          sketchId: "s1",
          profileIds: [],
          axis: "y",
          angle: "360",
          operation: "new",
        },
      ]),
    );
    expect(state.statuses["r1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(Math.PI * (400 - 100) * 30, 0);
  });

  it("chamfer removes the exact triangular prism", () => {
    const state1 = regenerateDocument(
      oc,
      docWith([sketchRect("s1", 0, 0, 20, 20), extrude("e1", "s1", "10")]),
    );
    // Find a vertical edge (length 10) to chamfer 2mm: removes (2·2/2)·10 = 20
    const edges = collectUniqueEdges(oc, state1.bodies[0]!.shape);
    let vertical = -1;
    edges.forEach((edge, i) => {
      const c = new oc.BRepAdaptor_Curve_2(edge);
      const p1 = c.Value(c.FirstParameter());
      const p2 = c.Value(c.LastParameter());
      if (
        Math.abs(p1.X() - p2.X()) < 1e-9 &&
        Math.abs(p1.Y() - p2.Y()) < 1e-9 &&
        Math.abs(p1.Z() - p2.Z()) > 1e-9
      ) {
        if (vertical < 0) vertical = i;
      }
    });
    expect(vertical).toBeGreaterThanOrEqual(0);
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 0, 0, 20, 20),
        extrude("e1", "s1", "10"),
        {
          id: "c1",
          type: "chamfer",
          name: "c1",
          suppressed: false,
          edges: [{ bodyId: "e1", edgeIndex: vertical }],
          distance: "2",
        },
      ]),
    );
    expect(state.statuses["c1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(4000 - 20, 1);
  });

  it("shell hollows to exact wall thickness", () => {
    // 20×20×10 box, remove top face (z=10), 2mm walls → 4000 − 16·16·8 = 1952
    const state1 = regenerateDocument(
      oc,
      docWith([sketchRect("s1", 0, 0, 20, 20), extrude("e1", "s1", "10")]),
    );
    // Find the top face index (plane origin Z ≈ 10) — mirrors the UI's face pick.
    let topIndex = -1;
    const exp = new oc.TopExp_Explorer_2(
      state1.bodies[0]!.shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    let i = 0;
    while (exp.More()) {
      const f = oc.TopoDS.Face_1(exp.Current());
      const surf = new oc.BRepAdaptor_Surface_2(f, true);
      if (
        surf.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value &&
        Math.abs(surf.Plane().Location().Z() - 10) < 1e-7
      ) {
        topIndex = i;
        break;
      }
      i++;
      exp.Next();
    }
    expect(topIndex).toBeGreaterThanOrEqual(0);
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 0, 0, 20, 20),
        extrude("e1", "s1", "10"),
        {
          id: "sh1",
          type: "shell",
          name: "sh1",
          suppressed: false,
          faces: [{ bodyId: "e1", faceIndex: topIndex }],
          thickness: "2",
        },
      ]),
    );
    expect(state.statuses["sh1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(1952, 0);
  });

  it("mirror + merge doubles a body across YZ", () => {
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 5, 0, 10, 10),
        extrude("e1", "s1", "10"),
        {
          id: "m1",
          type: "mirror",
          name: "m1",
          suppressed: false,
          bodyId: "e1",
          plane: "YZ",
          merge: true,
        },
      ]),
    );
    expect(state.statuses["m1"]!.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(2000, 1);
  });

  it("linear pattern fuses N disjoint copies", () => {
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 0, 0, 10, 10),
        extrude("e1", "s1", "10"),
        {
          id: "p1",
          type: "linearPattern",
          name: "p1",
          suppressed: false,
          bodyId: "e1",
          direction: "x",
          spacing: "20",
          count: "3",
        },
      ]),
    );
    expect(state.statuses["p1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(3000, 1);
  });

  it("circular pattern about Z produces count copies", () => {
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 30, -5, 10, 10),
        extrude("e1", "s1", "10"),
        {
          id: "p1",
          type: "circularPattern",
          name: "p1",
          suppressed: false,
          bodyId: "e1",
          axis: "z",
          count: "4",
        },
      ]),
    );
    expect(state.statuses["p1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(4000, 1);
  });

  it("boolean combine consumes the tool body", () => {
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 0, 0, 20, 20),
        extrude("e1", "s1", "10"),
        sketchRect("s2", 5, 5, 10, 10),
        extrude("e2", "s2", "30"),
        {
          id: "b1",
          type: "boolean",
          name: "b1",
          suppressed: false,
          targetBodyId: "e1",
          toolBodyId: "e2",
          op: "cut",
        },
      ]),
    );
    // e2 is a separate body: sketchRect s2 extrudes as "new"... it intersects e1 —
    // engine "new" always creates a body regardless of intersection. Then cut
    // subtracts 10×10×10 from e1: 4000 − 1000 = 3000. Tool consumed → 1 body.
    expect(state.statuses["b1"]!.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(3000, 1);
  });

  it("move translates and rotates a body (assembly positioning)", () => {
    const state = regenerateDocument(
      oc,
      docWith([
        sketchRect("s1", 0, 0, 10, 10),
        extrude("e1", "s1", "10"),
        {
          id: "mv1",
          type: "move",
          name: "mv1",
          suppressed: false,
          bodyId: "e1",
          tx: "100",
          ty: "50",
          tz: "0",
          rotAxis: "z",
          rotAngle: "90",
        },
      ]),
    );
    expect(state.statuses["mv1"]!.level).toBe("ok");
    expect(state.bodies[0]!.volume).toBeCloseTo(1000, 1);
  });

  it("STEP import round-trips a body through the document model", () => {
    // Export a 60×40×5 slab, then import it via an importStep feature.
    const src = regenerateDocument(
      oc,
      docWith([sketchRect("s1", 0, 0, 60, 40), extrude("e1", "s1", "5")]),
    );
    const stepBytes = exportStep(oc, [src.bodies[0]!.shape]);
    let bin = "";
    for (let i = 0; i < stepBytes.length; i += 0x8000) {
      bin += String.fromCharCode(...stepBytes.subarray(i, i + 0x8000));
    }
    const state = regenerateDocument(
      oc,
      docWith([
        {
          id: "imp1",
          type: "importStep",
          name: "imp1",
          suppressed: false,
          fileName: "slab.step",
          dataB64: btoa(bin),
        },
      ]),
    );
    expect(state.statuses["imp1"]!.level).toBe("ok");
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]!.volume).toBeCloseTo(12000, 0);
  });
});
