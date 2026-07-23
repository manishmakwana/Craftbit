/**
 * D6 joint regression tests (docs/design/D6-joints.md §8): every case asserts
 * exact closed-form poses (solid centroids / face-centroid sets) against the
 * real kernel, not just "no error".
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { CraftbitDocument, Feature, JointFeature, JointRef } from "@craftbit/core";
import { loadOcctForNode } from "./loadOcctNode";
import {
  collectFaces,
  collectUniqueEdges,
  regenerateDocument,
  type RegenState,
} from "../src/regen";
import type { OpenCascadeInstance, TopoDsShape } from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

function doc(
  features: Feature[],
  parameters: CraftbitDocument["parameters"] = [],
): CraftbitDocument {
  return {
    formatVersion: 2,
    id: "t",
    name: "t",
    units: "mm",
    parameters,
    features,
    bodyColors: {},
  };
}

const rectSketch = (id: string, w: number, h: number): Feature => ({
  id,
  type: "sketch",
  name: id,
  suppressed: false,
  plane: { kind: "origin", plane: "XY" },
  profiles: [{ id: `${id}-r`, kind: "rect", x: "0", y: "0", width: String(w), height: String(h) }],
});

const circleSketch = (id: string, cx: number, cy: number, r: number): Feature => ({
  id,
  type: "sketch",
  name: id,
  suppressed: false,
  plane: { kind: "origin", plane: "XY" },
  profiles: [{ id: `${id}-c`, kind: "circle", cx: String(cx), cy: String(cy), radius: String(r) }],
});

const extrude = (id: string, sketchId: string, dist: string): Feature => ({
  id,
  type: "extrude",
  name: id,
  suppressed: false,
  sketchId,
  profileIds: [],
  distance: dist,
  direction: "normal",
  operation: "new",
});

const joint = (
  id: string,
  movingRef: JointRef,
  targetRef: JointRef,
  over: Partial<JointFeature> = {},
): JointFeature => ({
  id,
  type: "joint",
  name: id,
  suppressed: false,
  jointType: "rigid",
  movingRef,
  targetRef,
  offset: "0",
  angle: "0",
  flip: false,
  ...over,
});

function faceCentroid(shape: TopoDsShape): [number, number, number] {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(shape, props, false, false);
  const c = props.CentreOfMass();
  return [c.X(), c.Y(), c.Z()];
}

function solidCentroid(state: RegenState, bodyId: string): [number, number, number] {
  const body = state.bodies.find((b) => b.id === bodyId)!;
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(body.shape, props, false, false, false);
  const c = props.CentreOfMass();
  return [c.X(), c.Y(), c.Z()];
}

/** Topological name of the face/edge whose centroid is `at` (picks like a user). */
function nameAt(
  state: RegenState,
  bodyId: string,
  kind: "face" | "edge",
  at: [number, number, number],
  tol = 1e-6,
): JointRef {
  const body = state.bodies.find((b) => b.id === bodyId)!;
  const shapes: TopoDsShape[] =
    kind === "face" ? collectFaces(oc, body.shape) : collectUniqueEdges(oc, body.shape);
  for (let i = 0; i < shapes.length; i++) {
    const props = new oc.GProp_GProps_1();
    if (kind === "face") oc.BRepGProp.SurfaceProperties_1(shapes[i]!, props, false, false);
    else oc.BRepGProp.LinearProperties(shapes[i]!, props, false, false);
    const c = props.CentreOfMass();
    if (Math.hypot(c.X() - at[0], c.Y() - at[1], c.Z() - at[2]) < tol) {
      const name = (kind === "face" ? body.names.faceNames : body.names.edgeNames)[i]!;
      return { bodyId, kind, name };
    }
  }
  throw new Error(`No ${kind} at (${at.join(", ")})`);
}

const near = (a: [number, number, number], b: [number, number, number], tol = 1e-7) => {
  expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(tol);
};

/** 60×40×5 plate (e1) + 10×20×6 block (e2), both at the origin. */
const plateAndBlock = (): Feature[] => [
  rectSketch("s1", 60, 40),
  extrude("e1", "s1", "5"),
  rectSketch("s2", 10, 20),
  extrude("e2", "s2", "6"),
];

/** Refs: block bottom face → plate top face. */
function blockOntoPlate(base: RegenState): { movingRef: JointRef; targetRef: JointRef } {
  return {
    movingRef: nameAt(base, "e2", "face", [5, 10, 0]),
    targetRef: nameAt(base, "e1", "face", [30, 20, 5]),
  };
}

describe("D6 joints (real kernel)", () => {
  it("J-RIGID: face-to-face mate lands the block centered on the plate top", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const { movingRef, targetRef } = blockOntoPlate(base);
    const state = regenerateDocument(
      oc,
      doc([...plateAndBlock(), joint("j1", movingRef, targetRef)]),
    );
    expect(state.statuses["j1"]!.level).not.toBe("error");
    // Block sits on top: z ∈ [5, 11], footprint centered at (30, 20).
    near(solidCentroid(state, "e2"), [30, 20, 8]);
    // Plate did not move (it is the grounded side).
    near(solidCentroid(state, "e1"), [30, 20, 2.5]);
    // Volumes unchanged by a rigid motion.
    expect(state.bodies.find((b) => b.id === "e2")!.volume).toBeCloseTo(10 * 20 * 6, 6);
  });

  it("J-OFFSET: expression offset lifts the block along the joint axis", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const { movingRef, targetRef } = blockOntoPlate(base);
    const state = regenerateDocument(
      oc,
      doc(
        [...plateAndBlock(), joint("j1", movingRef, targetRef, { offset: "gap" })],
        [{ id: "p1", name: "gap", expression: "7" }],
      ),
    );
    expect(state.statuses["j1"]!.level).not.toBe("error");
    // Mate plane lifted to z = 12 → block z ∈ [12, 18].
    near(solidCentroid(state, "e2"), [30, 20, 15]);
  });

  it("J-FLIP: flip mates the block below the target plane", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const { movingRef, targetRef } = blockOntoPlate(base);
    const state = regenerateDocument(
      oc,
      doc([...plateAndBlock(), joint("j1", movingRef, targetRef, { flip: true })]),
    );
    expect(state.statuses["j1"]!.level).not.toBe("error");
    // Moving z aligned with target z → block hangs below: z ∈ [-1, 5].
    near(solidCentroid(state, "e2"), [30, 20, 2]);
  });

  it("J-ANGLE: 90° rotates the block footprint about the joint axis", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const { movingRef, targetRef } = blockOntoPlate(base);
    const run = (angle: string) =>
      regenerateDocument(
        oc,
        doc([...plateAndBlock(), joint("j1", movingRef, targetRef, { angle })]),
      );
    const horizontalFaceOffsets = (state: RegenState): [number, number][] => {
      const body = state.bodies.find((b) => b.id === "e2")!;
      const center = solidCentroid(state, "e2");
      return collectFaces(oc, body.shape)
        .map(faceCentroid)
        .map((c): [number, number] => [c[0] - center[0], c[1] - center[1]])
        .filter(([dx, dy]) => Math.hypot(dx, dy) > 1e-7);
    };
    const at0 = run("0");
    const at90 = run("90");
    expect(at90.statuses["j1"]!.level).not.toBe("error");
    // Rotation about the vertical joint axis through the footprint center
    // keeps the centroid put…
    near(solidCentroid(at90, "e2"), [30, 20, 8]);
    near(solidCentroid(at0, "e2"), [30, 20, 8]);
    // …and maps every side-face offset (dx, dy) → (−dy, dx) exactly.
    const rotated = horizontalFaceOffsets(at0).map(([dx, dy]): [number, number] => [-dy, dx]);
    const got = horizontalFaceOffsets(at90);
    for (const [dx, dy] of rotated) {
      expect(got.some(([gx, gy]) => Math.hypot(gx - dx, gy - dy) < 1e-7)).toBe(true);
    }
  });

  it("J-REVOLUTE: circular-edge frames mate a pin into a hole axis", () => {
    // Disc r=10 h=5 at origin; pin r=4 h=8 at (50, 50).
    const parts: Feature[] = [
      circleSketch("s1", 0, 0, 10),
      extrude("e1", "s1", "5"),
      circleSketch("s2", 50, 50, 4),
      extrude("e2", "s2", "8"),
    ];
    const base = regenerateDocument(oc, doc(parts));
    // Moving: pin's bottom circular edge (center (50,50,0)); target: disc's
    // top circular edge (center (0,0,5)).
    const movingRef = nameAt(base, "e2", "edge", [50, 50, 0]);
    const targetRef = nameAt(base, "e1", "edge", [0, 0, 5]);
    const state = regenerateDocument(
      oc,
      doc([...parts, joint("j1", movingRef, targetRef, { jointType: "revolute" })]),
    );
    expect(state.statuses["j1"]!.level).not.toBe("error");
    // Pin's edge frame z is the circle axis (0,0,1); anti-aligned mate points
    // the pin downward through the disc: z ∈ [-3, 5] on the disc axis.
    near(solidCentroid(state, "e2"), [0, 0, 1]);
    near(solidCentroid(state, "e1"), [0, 0, 2.5]);
  });

  it("J-FAIL: a dangling ref errors loudly and leaves the body in place", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const { targetRef } = blockOntoPlate(base);
    const state = regenerateDocument(
      oc,
      doc([
        ...plateAndBlock(),
        joint("j1", { bodyId: "e2", kind: "face", name: "nonexistent/face/gen(x)" }, targetRef),
      ]),
    );
    expect(state.statuses["j1"]!.level).toBe("error");
    expect(state.statuses["j1"]!.message).toMatch(/re-pick/i);
    // Both bodies still exist, block untouched at its modeled position.
    near(solidCentroid(state, "e2"), [5, 10, 3]);
    // Upstream features unaffected.
    expect(state.statuses["e2"]!.level).not.toBe("error");
  });

  it("J-SAME: joining a body to itself is rejected", () => {
    const base = regenerateDocument(oc, doc(plateAndBlock()));
    const movingRef = nameAt(base, "e1", "face", [30, 20, 5]);
    const targetRef = nameAt(base, "e1", "face", [30, 20, 0]);
    const state = regenerateDocument(
      oc,
      doc([...plateAndBlock(), joint("j1", movingRef, targetRef)]),
    );
    expect(state.statuses["j1"]!.level).toBe("error");
    expect(state.statuses["j1"]!.message).toMatch(/different bodies/i);
  });
});
