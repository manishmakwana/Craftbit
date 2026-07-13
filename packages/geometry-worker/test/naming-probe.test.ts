/**
 * D2 Phase-0 binding probe (docs/design/D2-topological-naming.md §6.3).
 *
 * Runs against the real opencascade.js 1.1.1 WASM build and answers the D2
 * design doc's open questions: do the history APIs
 * (`Generated`/`Modified`/`IsDeleted`, `FirstShape`/`LastShape`) exist with
 * usable signatures, and how complete is per-operation history coverage?
 *
 * Hard requirements (test failures block D2 implementation):
 *   - boolean Cut: Modified / Generated / IsDeleted usable, lists iterable
 *   - MakePrism: FirstShape / LastShape / Generated(profileEdge)
 *   - MakeFillet: Generated(edge) → fillet face
 *   - Transform: explorer face order preserved (the `move` identity-map rule)
 *
 * Soft findings (recorded in the printed report, never fail the build):
 *   - MakeRevol cap-face history for partial/full revolutions
 *   - MakeThickSolid (shell) history coverage
 *   - which TopTools_ListOfShape iteration mechanism the build supports
 */

import { beforeAll, describe, expect, it } from "vitest";
import { loadOcctForNode } from "./loadOcctNode";
import { collectFaces, collectUniqueEdges } from "../src/regen";
import type {
  OpenCascadeInstance,
  TopoDsEdge,
  TopoDsFace,
  TopoDsShape,
} from "../src/occt-types";

let oc: OpenCascadeInstance;
beforeAll(async () => {
  oc = await loadOcctForNode();
}, 120_000);

const findings: string[] = [];
function record(line: string): void {
  findings.push(line);
}

/** Structural view of the history methods we're probing for. */
interface HistoryCapable {
  Generated?: (s: TopoDsShape) => unknown;
  Modified?: (s: TopoDsShape) => unknown;
  IsDeleted?: (s: TopoDsShape) => boolean;
  FirstShape?: () => TopoDsShape;
  LastShape?: () => TopoDsShape;
}

/** Structural view of NCollection list methods that may or may not be bound. */
interface ListLike {
  Size?: () => number;
  First_1?: () => TopoDsShape;
  First_2?: () => TopoDsShape;
  RemoveFirst?: () => void;
}

let listMechanism: string | null = null;

/** Drains a TopTools_ListOfShape into a JS array, feature-detecting the API. */
function listToArray(list: unknown): TopoDsShape[] {
  const l = list as ListLike;
  if (typeof l.Size !== "function") {
    throw new Error("history list has no Size() — cannot iterate");
  }
  const first = typeof l.First_1 === "function" ? l.First_1 : l.First_2;
  if (typeof first === "function" && typeof l.RemoveFirst === "function") {
    listMechanism ??= "Size()+First+RemoveFirst destructive drain";
    const out: TopoDsShape[] = [];
    while (l.Size!() > 0) {
      out.push(first.call(l));
      l.RemoveFirst!();
    }
    return out;
  }
  throw new Error("history list exposes Size() but no First/RemoveFirst — need another iterator");
}

function makeBox(dx: number, dy: number, dz: number): TopoDsShape {
  return new oc.BRepPrimAPI_MakeBox_1(dx, dy, dz).Shape();
}

function translated(shape: TopoDsShape, x: number, y: number, z: number): TopoDsShape {
  const trsf = new oc.gp_Trsf_1();
  trsf.SetTranslation_1(new oc.gp_Vec_4(x, y, z));
  return new oc.BRepBuilderAPI_Transform_2(shape, trsf, false).Shape();
}

function faceCentroid(face: TopoDsFace): [number, number, number] {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const c = props.CentreOfMass();
  return [c.X(), c.Y(), c.Z()];
}

function findFaceAt(shape: TopoDsShape, at: [number, number, number], tol = 1e-6): TopoDsFace {
  for (const f of collectFaces(oc, shape)) {
    const c = faceCentroid(f);
    if (
      Math.abs(c[0] - at[0]) < tol &&
      Math.abs(c[1] - at[1]) < tol &&
      Math.abs(c[2] - at[2]) < tol
    ) {
      return f;
    }
  }
  throw new Error(`No face with centroid (${at.join(", ")})`);
}

function containsSame(haystack: TopoDsShape[], needle: TopoDsShape): boolean {
  return haystack.some((s) => s.IsSame(needle));
}

function rectFace(pts: [number, number, number][]): {
  face: TopoDsFace;
  edges: TopoDsEdge[];
} {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const edges: TopoDsEdge[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const edge = new oc.BRepBuilderAPI_MakeEdge_3(
      new oc.gp_Pnt_3(a[0], a[1], a[2]),
      new oc.gp_Pnt_3(b[0], b[1], b[2]),
    ).Edge();
    edges.push(edge);
    wireMaker.Add_1(edge);
  }
  return { face: new oc.BRepBuilderAPI_MakeFace_15(wireMaker.Wire(), true).Face(), edges };
}

describe("D2 Phase-0: OCCT history binding probe (real kernel)", () => {
  it("boolean Cut exposes usable Modified/Generated/IsDeleted [HARD]", () => {
    // Box A with a full-width slab tool cutting straight through the middle:
    // severs A into two lobes, so A's top face must report Modified → 2 faces.
    const boxA = makeBox(60, 40, 10);
    const topOfA = findFaceAt(boxA, [30, 20, 10]);
    const slab = translated(makeBox(60, 10, 40), 0, 15, -5);
    const slabWallY15 = findFaceAt(slab, [30, 15, 15]);

    const cut = new oc.BRepAlgoAPI_Cut_3(boxA, slab) as unknown as HistoryCapable & {
      Build(): void;
      IsDone(): boolean;
      Shape(): TopoDsShape;
    };
    cut.Build();
    expect(cut.IsDone()).toBe(true);
    const resultFaces = collectFaces(oc, cut.Shape());

    expect(typeof cut.Modified).toBe("function");
    expect(typeof cut.Generated).toBe("function");
    expect(typeof cut.IsDeleted).toBe("function");

    // 1 → N split: the severed top face.
    const topPieces = listToArray(cut.Modified!(topOfA));
    expect(topPieces).toHaveLength(2);
    for (const piece of topPieces) expect(containsSame(resultFaces, piece)).toBe(true);
    record(`Cut.Modified(splitFace) → ${topPieces.length} faces (1→N split works)`);

    // Tool-lineage premise (D2 §3.4 boolean row): a tool face maps to the
    // cavity wall it produced in the result.
    const wallPieces = listToArray(cut.Modified!(slabWallY15));
    expect(wallPieces.length).toBeGreaterThanOrEqual(1);
    for (const piece of wallPieces) expect(containsSame(resultFaces, piece)).toBe(true);
    record(`Cut.Modified(toolFace) → ${wallPieces.length} face(s) (tool lineage works)`);

    // IsDeleted: a tool that swallows an entire end face of the target.
    const boxB = makeBox(60, 40, 10);
    const endOfB = findFaceAt(boxB, [60, 20, 5]);
    const endBlock = translated(makeBox(20, 40, 10), 40, 0, 0);
    const cut2 = new oc.BRepAlgoAPI_Cut_3(boxB, endBlock) as unknown as HistoryCapable & {
      Build(): void;
      IsDone(): boolean;
    };
    cut2.Build();
    expect(cut2.IsDone()).toBe(true);
    expect(cut2.IsDeleted!(endOfB)).toBe(true);
    record("Cut.IsDeleted(consumedFace) → true");
    record(`List iteration mechanism: ${listMechanism ?? "none found"}`);
  });

  it("MakePrism exposes FirstShape/LastShape/Generated [HARD]", () => {
    const { face, edges } = rectFace([
      [0, 0, 0],
      [30, 0, 0],
      [30, 20, 0],
      [0, 20, 0],
    ]);
    const prism = new oc.BRepPrimAPI_MakePrism_1(
      face,
      new oc.gp_Vec_4(0, 0, 15),
      false,
      true,
    ) as unknown as HistoryCapable & { Shape(): TopoDsShape };
    const solidFaces = collectFaces(oc, prism.Shape());
    expect(solidFaces).toHaveLength(6);

    expect(typeof prism.FirstShape).toBe("function");
    expect(typeof prism.LastShape).toBe("function");
    const start = prism.FirstShape!();
    const end = prism.LastShape!();
    expect(faceCentroid(start as TopoDsFace)[2]).toBeCloseTo(0, 9);
    expect(faceCentroid(end as TopoDsFace)[2]).toBeCloseTo(15, 9);
    record("Prism FirstShape/LastShape → start/end cap faces at expected heights");

    // The profile edge from (0,0)→(30,0) must generate the y=0 side wall.
    const sides = listToArray(prism.Generated!(edges[0]!));
    expect(sides).toHaveLength(1);
    const c = faceCentroid(sides[0] as TopoDsFace);
    expect(c[0]).toBeCloseTo(15, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    expect(c[2]).toBeCloseTo(7.5, 6);
    record("Prism.Generated(profileEdge) → the swept side face");
  });

  it("MakeFillet exposes Generated(edge) [HARD]", () => {
    const box = makeBox(30, 30, 30);
    const edge = collectUniqueEdges(oc, box)[0]!;
    const fillet = new oc.BRepFilletAPI_MakeFillet(
      box,
      oc.ChFi3d_FilletShape.ChFi3d_Rational,
    ) as unknown as HistoryCapable & {
      Add_2(radius: number, edge: TopoDsEdge): void;
      Build(): void;
      IsDone(): boolean;
      Shape(): TopoDsShape;
    };
    fillet.Add_2(3, edge);
    fillet.Build();
    expect(fillet.IsDone()).toBe(true);
    const resultFaces = collectFaces(oc, fillet.Shape());
    expect(resultFaces).toHaveLength(7);

    expect(typeof fillet.Generated).toBe("function");
    const genFaces = listToArray(fillet.Generated!(edge)).filter((s) => !s.IsNull());
    expect(genFaces.length).toBeGreaterThanOrEqual(1);
    for (const f of genFaces) expect(containsSame(resultFaces, f)).toBe(true);
    record(`Fillet.Generated(edge) → ${genFaces.length} fillet face(s), all present in result`);
  });

  it("Transform preserves explorer face order — the `move` identity rule [HARD]", () => {
    const box = makeBox(25, 15, 10);
    const before = collectFaces(oc, box).map(faceCentroid);
    const moved = translated(box, 5, 7, 9);
    const after = collectFaces(oc, moved).map(faceCentroid);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]![0]).toBeCloseTo(before[i]![0] + 5, 9);
      expect(after[i]![1]).toBeCloseTo(before[i]![1] + 7, 9);
      expect(after[i]![2]).toBeCloseTo(before[i]![2] + 9, 9);
    }
    const sameCount = collectFaces(oc, box).filter((f, i) =>
      f.IsSame(collectFaces(oc, moved)[i]!),
    ).length;
    record(
      `Transform: explorer order preserved for all ${before.length} faces; ` +
        `IsSame across transform holds for ${sameCount}/${before.length} ` +
        `(explicit order-mapping ${sameCount === before.length ? "optional" : "required"})`,
    );
  });

  it("MakeRevol cap-face history [soft finding]", () => {
    const profile = (): { face: TopoDsFace; edges: TopoDsEdge[] } =>
      rectFace([
        [10, 0, 0],
        [20, 0, 0],
        [20, 0, 8],
        [10, 0, 8],
      ]);
    const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));

    try {
      const partial = new oc.BRepPrimAPI_MakeRevol_1(
        profile().face,
        axis,
        Math.PI / 2,
        false,
      ) as unknown as HistoryCapable & { Shape(): TopoDsShape };
      const hasCaps =
        typeof partial.FirstShape === "function" &&
        typeof partial.LastShape === "function" &&
        !partial.FirstShape().IsNull() &&
        !partial.LastShape().IsNull();
      record(`Revol(90°): FirstShape/LastShape usable → ${hasCaps}`);

      const p2 = profile();
      const revol2 = new oc.BRepPrimAPI_MakeRevol_1(
        p2.face,
        axis,
        Math.PI / 2,
        false,
      ) as unknown as HistoryCapable;
      const gen = listToArray(revol2.Generated!(p2.edges[0]!)).filter((s) => !s.IsNull());
      record(`Revol(90°).Generated(profileEdge) → ${gen.length} face(s)`);
    } catch (e) {
      record(`Revol(90°) history probe threw: ${String(e)} — orphan fallback per D2 §3.4`);
    }

    try {
      const full = new oc.BRepPrimAPI_MakeRevol_1(
        profile().face,
        axis,
        2 * Math.PI,
        false,
      ) as unknown as HistoryCapable;
      const fs = full.FirstShape!();
      record(`Revol(360°): FirstShape IsNull → ${fs.IsNull()} (expected: no caps)`);
    } catch (e) {
      record(`Revol(360°) FirstShape threw: ${String(e)}`);
    }
  });

  it("MakeThickSolid (shell) history coverage [soft finding]", () => {
    const box = makeBox(40, 40, 20);
    const top = findFaceAt(box, [20, 20, 20]);
    const bottom = findFaceAt(box, [20, 20, 0]);
    const closing = new oc.TopTools_ListOfShape_1();
    closing.Append_1(top);
    const thick = new oc.BRepOffsetAPI_MakeThickSolid_2(
      box,
      closing,
      -3,
      1e-6,
      oc.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      oc.GeomAbs_JoinType.GeomAbs_Arc,
      false,
    ) as unknown as HistoryCapable & { IsDone(): boolean; Shape(): TopoDsShape };
    expect(thick.IsDone()).toBe(true);

    try {
      const mod = listToArray(thick.Modified!(bottom)).filter((s) => !s.IsNull());
      record(`ThickSolid.Modified(keptFace) → ${mod.length} face(s)`);
    } catch (e) {
      record(`ThickSolid.Modified threw: ${String(e)} — orphan fallback per D2 §3.4`);
    }
    try {
      const topEdges: TopoDsShape[] = [];
      const exp = new oc.TopExp_Explorer_2(
        top,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      for (; exp.More(); exp.Next()) topEdges.push(exp.Current());
      const gen = listToArray(thick.Generated!(topEdges[0]!)).filter((s) => !s.IsNull());
      record(`ThickSolid.Generated(removedFaceEdge) → ${gen.length} rim shape(s)`);
    } catch (e) {
      record(`ThickSolid.Generated threw: ${String(e)} — orphan fallback per D2 §3.4`);
    }
  });

  it("prints the Phase-0 findings report", () => {
    console.info(
      ["", "=== D2 Phase-0 binding probe findings ===", ...findings.map((f) => `  • ${f}`)].join(
        "\n",
      ),
    );
    expect(findings.length).toBeGreaterThan(0);
  });
});
