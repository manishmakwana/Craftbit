/**
 * D2 topological-naming regression tests (docs/design/D2-topological-naming.md §6).
 *
 * The bug class these exist to kill: a reference that *resolves successfully
 * on the wrong face* after an upstream edit. Every case asserts resolved
 * geometry (centroids/volumes), not just "resolved".
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { CraftbitDocument, Feature } from "@craftbit/core";
import { loadOcctForNode } from "./loadOcctNode";
import {
  collectFaces,
  collectUniqueEdges,
  regenerateDocument,
  upgradeDocumentRefs,
  type RegenState,
} from "../src/regen";
import { resolveName } from "../src/naming";
import type { OpenCascadeInstance, TopoDsShape } from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

function doc(features: Feature[]): CraftbitDocument {
  return {
    formatVersion: 2,
    id: "t",
    name: "t",
    units: "mm",
    parameters: [],
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

function centroidOf(shape: TopoDsShape, kind: "face" | "edge"): [number, number, number] {
  const props = new oc.GProp_GProps_1();
  if (kind === "face") oc.BRepGProp.SurfaceProperties_1(shape, props, false, false);
  else oc.BRepGProp.LinearProperties(shape, props, false, false);
  const c = props.CentreOfMass();
  return [c.X(), c.Y(), c.Z()];
}

/** Finds the topological name of the face/edge whose centroid is `at`. */
function nameAt(
  state: RegenState,
  bodyId: string,
  kind: "face" | "edge",
  at: [number, number, number],
  tol = 1e-6,
): string {
  const body = state.bodies.find((b) => b.id === bodyId)!;
  const shapes: TopoDsShape[] =
    kind === "face" ? collectFaces(oc, body.shape) : collectUniqueEdges(oc, body.shape);
  for (let i = 0; i < shapes.length; i++) {
    const c = centroidOf(shapes[i]!, kind);
    if (Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) < tol) {
      return (kind === "face" ? body.names.faceNames : body.names.edgeNames)[i]!;
    }
  }
  throw new Error(`No ${kind} at (${at.join(", ")})`);
}

/** Resolves a name in the final state and returns the subshape's centroid. */
function resolvedCentroid(
  state: RegenState,
  bodyId: string,
  kind: "face" | "edge",
  name: string,
): [number, number, number] {
  const body = state.bodies.find((b) => b.id === bodyId)!;
  const r = resolveName(body.names, kind, name);
  if (!r.ok) throw new Error(`did not resolve: ${r.reason}`);
  const shapes: TopoDsShape[] =
    kind === "face" ? collectFaces(oc, body.shape) : collectUniqueEdges(oc, body.shape);
  return centroidOf(shapes[r.index]!, kind);
}

describe("D2 naming invariants (real kernel)", () => {
  it("N-DET: regenerating the same document twice yields identical name tables", () => {
    const d = doc([
      rectSketch("s1", 60, 40),
      extrude("e1", "s1", "5"),
      {
        id: "s2",
        type: "sketch",
        name: "s2",
        suppressed: false,
        plane: { kind: "origin", plane: "XY" },
        profiles: [{ id: "s2-c", kind: "circle", cx: "20", cy: "20", radius: "6" }],
      },
      {
        id: "e2",
        type: "extrude",
        name: "e2",
        suppressed: false,
        sketchId: "s2",
        profileIds: [],
        distance: "5",
        direction: "normal",
        operation: "cut",
      },
    ]);
    const a = regenerateDocument(oc, d);
    const b = regenerateDocument(oc, d);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies[0]!.names.faceNames).toEqual(a.bodies[0]!.names.faceNames);
    expect(b.bodies[0]!.names.edgeNames).toEqual(a.bodies[0]!.names.edgeNames);
  });

  it("T-E2: editing the extrude distance keeps every face name (refs follow)", () => {
    const before = regenerateDocument(
      oc,
      doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5")]),
    );
    const after = regenerateDocument(oc, doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "8")]));
    expect(new Set(after.bodies[0]!.names.faceNames)).toEqual(
      new Set(before.bodies[0]!.names.faceNames),
    );
    // The top face's name denotes the moved top face, not a stale position.
    const topName = nameAt(before, "e1", "face", [30, 20, 5]);
    expect(resolvedCentroid(after, "e1", "face", topName)).toEqual([30, 20, 8]);
  });

  it("T-E7/T-P1: sketch-on-face survives an upstream topology change (the headline case)", () => {
    // Plate with a sketch on its top face cutting a pocket.
    const base = regenerateDocument(oc, doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5")]));
    const topName = nameAt(base, "e1", "face", [30, 20, 5]);

    const pocket: Feature[] = [
      {
        id: "s2",
        type: "sketch",
        name: "s2",
        suppressed: false,
        plane: { kind: "face", bodyId: "e1", name: topName },
        profiles: [{ id: "s2-c", kind: "circle", cx: "-10", cy: "5", radius: "4" }],
      },
      {
        id: "e2",
        type: "extrude",
        name: "e2",
        suppressed: false,
        sketchId: "s2",
        profileIds: [],
        distance: "5",
        direction: "reversed",
        operation: "cut",
      },
    ];
    const ok = regenerateDocument(
      oc,
      doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5"), ...pocket]),
    );
    expect(ok.statuses["e2"]!.level).not.toBe("error");
    expect(ok.bodies[0]!.volume).toBeCloseTo(60 * 40 * 5 - Math.PI * 16 * 5, 1);

    // Upstream edit that changes the base body's topology and face count:
    // add a through-hole to sketch1. Index-based refs would shift; the name
    // must still land on the top face.
    const editedSketch1: Feature = {
      id: "s1",
      type: "sketch",
      name: "s1",
      suppressed: false,
      plane: { kind: "origin", plane: "XY" },
      profiles: [
        { id: "s1-r", kind: "rect", x: "0", y: "0", width: "60", height: "40" },
        { id: "s1-h", kind: "circle", cx: "50", cy: "20", radius: "5" },
      ],
    };
    const edited = regenerateDocument(
      oc,
      doc([editedSketch1, extrude("e1", "s1", "5"), ...pocket]),
    );
    expect(edited.statuses["s2"]?.level).not.toBe("error");
    expect(edited.statuses["e2"]?.level).not.toBe("error");
    // Volume: plate minus through-hole minus pocket — both cuts landed.
    expect(edited.bodies[0]!.volume).toBeCloseTo(
      60 * 40 * 5 - Math.PI * 25 * 5 - Math.PI * 16 * 5,
      1,
    );
    // And the sketch plane really is the top face (z = 5, normal +Z).
    const s2 = edited.sketches.find((s) => s.featureId === "s2")!;
    expect(s2.plane.origin[2]).toBeCloseTo(5, 6);
    expect(s2.plane.normal[2]).toBeCloseTo(1, 6);
  });

  it("T-F2: fillet edge ref follows a dimension edit (exact volume both times)", () => {
    const base = regenerateDocument(oc, doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5")]));
    // A vertical corner edge at (0,0), z 0..5.
    const edgeName = nameAt(base, "e1", "edge", [0, 0, 2.5]);
    const fillet: Feature = {
      id: "f1",
      type: "fillet",
      name: "f1",
      suppressed: false,
      edges: [{ bodyId: "e1", name: edgeName }],
      radius: "3",
    };
    const notch = (h: number) => (9 - (Math.PI * 9) / 4) * h;

    const a = regenerateDocument(
      oc,
      doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5"), fillet]),
    );
    expect(a.statuses["f1"]!.level).not.toBe("error");
    expect(a.bodies[0]!.volume).toBeCloseTo(60 * 40 * 5 - notch(5), 2);

    // Taller plate: the same lineage name denotes the same (now longer) edge.
    const b = regenerateDocument(
      oc,
      doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "9"), fillet]),
    );
    expect(b.statuses["f1"]!.level).not.toBe("error");
    expect(b.bodies[0]!.volume).toBeCloseTo(60 * 40 * 9 - notch(9), 2);
  });

  it("fails loudly (no silent rebind) when the referenced geometry is gone", () => {
    const base = regenerateDocument(oc, doc([rectSketch("s1", 60, 40), extrude("e1", "s1", "5")]));
    const edgeName = nameAt(base, "e1", "edge", [0, 0, 2.5]);
    const fillet: Feature = {
      id: "f1",
      type: "fillet",
      name: "f1",
      suppressed: false,
      edges: [{ bodyId: "e1", name: edgeName }],
      radius: "2",
    };
    // Replace the rect with a circle profile: every rect-derived name dies.
    const circleSketch: Feature = {
      id: "s1",
      type: "sketch",
      name: "s1",
      suppressed: false,
      plane: { kind: "origin", plane: "XY" },
      profiles: [{ id: "s1-c", kind: "circle", cx: "30", cy: "20", radius: "15" }],
    };
    const state = regenerateDocument(oc, doc([circleSketch, extrude("e1", "s1", "5"), fillet]));
    expect(state.statuses["f1"]!.level).toBe("error");
    expect(state.statuses["f1"]!.message).toMatch(/no longer exists|re-pick/i);
    // The body itself still regenerated (regen continues past the failure).
    expect(state.bodies[0]!.volume).toBeCloseTo(Math.PI * 225 * 5, 1);
  });

  it("T-V1: move keeps every name verbatim; T-M1: pattern instances get inst(k) names", () => {
    const moved = regenerateDocument(
      oc,
      doc([
        rectSketch("s1", 20, 10),
        extrude("e1", "s1", "5"),
        {
          id: "m1",
          type: "move",
          name: "m1",
          suppressed: false,
          bodyId: "e1",
          tx: "7",
          ty: "11",
          tz: "13",
          rotAxis: "z",
          rotAngle: "0",
        },
      ]),
    );
    const plain = regenerateDocument(oc, doc([rectSketch("s1", 20, 10), extrude("e1", "s1", "5")]));
    expect(moved.bodies[0]!.names.faceNames).toEqual(plain.bodies[0]!.names.faceNames);
    expect(moved.bodies[0]!.names.edgeNames).toEqual(plain.bodies[0]!.names.edgeNames);

    const patterned = regenerateDocument(
      oc,
      doc([
        rectSketch("s1", 20, 10),
        extrude("e1", "s1", "5"),
        {
          id: "p1",
          type: "linearPattern",
          name: "p1",
          suppressed: false,
          bodyId: "e1",
          direction: "x",
          spacing: "30",
          count: "3",
        },
      ]),
    );
    const names = patterned.bodies[0]!.names.faceNames;
    expect(names.some((n) => n.includes("inst(1,"))).toBe(true);
    expect(names.some((n) => n.includes("inst(2,"))).toBe(true);
    // The original's names survive un-wrapped.
    expect(names.some((n) => n === "e1/face/start")).toBe(true);
  });

  it("split guard: a stale ;s{k}of{n} ref reports split-count-changed, not a guess", () => {
    // Slab cut clean through the middle severs the plate: top face 1 → 2.
    const severed = regenerateDocument(
      oc,
      doc([
        rectSketch("s1", 60, 40),
        extrude("e1", "s1", "5"),
        {
          id: "s2",
          type: "sketch",
          name: "s2",
          suppressed: false,
          plane: { kind: "origin", plane: "XY" },
          profiles: [{ id: "s2-r", kind: "rect", x: "25", y: "-5", width: "10", height: "50" }],
        },
        {
          id: "e2",
          type: "extrude",
          name: "e2",
          suppressed: false,
          sketchId: "s2",
          profileIds: [],
          distance: "10",
          direction: "normal",
          operation: "cut",
        },
      ]),
    );
    const body = severed.bodies[0]!;
    const splitNames = body.names.faceNames.filter((n) => n.includes(";s") && n.includes("of2"));
    expect(splitNames.length).toBeGreaterThanOrEqual(2);

    // A ref minted when the face split 3 ways must not bind to today's 2-way
    // split: the resolver reports the specific guard reason.
    const stale = splitNames[0]!.replace("of2", "of3");
    const r = resolveName(body.names, "face", stale);
    expect(r).toEqual({ ok: false, reason: "split-count-changed" });
  });

  it("N-MIG: v1 index refs upgrade to names that denote the same geometry", () => {
    const v1doc = {
      formatVersion: 1,
      id: "t",
      name: "t",
      units: "mm",
      parameters: [],
      bodyColors: {},
      features: [
        rectSketch("s1", 60, 40),
        extrude("e1", "s1", "5"),
        {
          id: "f1",
          type: "fillet",
          name: "f1",
          suppressed: false,
          edges: [{ bodyId: "e1", edgeIndex: 3 }],
          radius: "2",
        },
      ],
    } as unknown as CraftbitDocument;

    // What does index 3 denote pre-upgrade?
    const pre = regenerateDocument(oc, JSON.parse(JSON.stringify(v1doc)) as CraftbitDocument);
    expect(pre.statuses["f1"]!.level).not.toBe("error");
    const preVolume = pre.bodies[0]!.volume;

    const { doc: upgraded, failures } = upgradeDocumentRefs(
      oc,
      JSON.parse(JSON.stringify(v1doc)) as CraftbitDocument,
    );
    expect(failures).toEqual([]);
    expect(upgraded.formatVersion).toBe(2);
    const f1 = upgraded.features.find((f) => f.id === "f1")!;
    if (f1.type !== "fillet") throw new Error("f1 not a fillet");
    expect(typeof f1.edges[0]!.name).toBe("string");
    expect((f1.edges[0] as { edgeIndex?: number }).edgeIndex).toBeUndefined();

    // The upgraded doc regenerates to the identical solid.
    const post = regenerateDocument(oc, upgraded);
    expect(post.statuses["f1"]!.level).not.toBe("error");
    expect(post.bodies[0]!.volume).toBeCloseTo(preVolume, 6);
  });
});
