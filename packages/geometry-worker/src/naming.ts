/**
 * D2 topological naming (docs/design/D2-topological-naming.md).
 *
 * Every face/edge of every body carries a lineage-encoded string name,
 * recomputed from scratch each regeneration by walking OCCT history
 * (Generated/Modified/IsDeleted) plus per-operation seeds. References in the
 * document store names, never enumeration indices; resolution is a table
 * lookup that fails loudly ("reference lost") instead of ever guessing.
 *
 * Name grammar (doc §3.1): `featId/kind/tag` where tag encodes the origin —
 * `start`/`end` caps, `side(curveKey)` swept faces, `gen(parent)`,
 * `mod(parent)`, `inst(k,parent)` transform copies, `imp(j)` imports,
 * `new(j)` orphans — with `;s{k}of{n}` split marks when history maps one
 * input onto several outputs (centroid-ordered; guarded on resolve by the
 * exact-count rule).
 *
 * Probe-verified constraints (naming-probe.test.ts): history lists drain
 * destructively; `IsSame` does NOT survive BRepBuilderAPI_Transform but
 * explorer order does (transforms use explicit order mapping); ThickSolid
 * reports Generated(edge)→rim but nothing for offset faces (orphan path).
 */

import type { OpenCascadeInstance, ShapeHistory, TopoDsShape } from "./occt-types";
import { collectFaces, collectUniqueEdges } from "./topo";

export interface TopoNames {
  /** Face names aligned with `collectFaces` explorer order. */
  faceNames: string[];
  /** Edge names aligned with `collectUniqueEdges` order. */
  edgeNames: string[];
}

export interface NamingReport {
  orphanFaces: number;
  orphanEdges: number;
}

/** A subshape with an a-priori name: either an input from a parent body's
 * table, or a mint-time seed (cap face, swept side, profile edge). */
export interface NamedShape {
  shape: TopoDsShape;
  name: string;
}

const centroidCache = new WeakMap<TopoDsShape, [number, number, number]>();

/** Mass centroid of a face (surface) or edge (curve) — deterministic sort key. */
export function shapeCentroid(
  oc: OpenCascadeInstance,
  shape: TopoDsShape,
  kind: "face" | "edge",
): [number, number, number] {
  const hit = centroidCache.get(shape);
  if (hit) return hit;
  const props = new oc.GProp_GProps_1();
  if (kind === "face") oc.BRepGProp.SurfaceProperties_1(shape, props, false, false);
  else oc.BRepGProp.LinearProperties(shape, props, false, false);
  const c = props.CentreOfMass();
  const out: [number, number, number] = [c.X(), c.Y(), c.Z()];
  centroidCache.set(shape, out);
  return out;
}

const centroidLess = (a: [number, number, number], b: [number, number, number]): boolean => {
  const T = 1e-7;
  if (Math.abs(a[0] - b[0]) > T) return a[0] < b[0];
  if (Math.abs(a[1] - b[1]) > T) return a[1] < b[1];
  return a[2] < b[2];
};

function indexOfSame(haystack: TopoDsShape[], needle: TopoDsShape): number {
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i]!.IsSame(needle)) return i;
  }
  return -1;
}

/** Drains a TopTools_ListOfShape (destructive — consume-once per probe). */
function drain(list: {
  Size(): number;
  First_1(): TopoDsShape;
  RemoveFirst(): void;
}): TopoDsShape[] {
  const out: TopoDsShape[] = [];
  while (list.Size() > 0) {
    out.push(list.First_1());
    list.RemoveFirst();
  }
  return out;
}

interface SourceRec {
  srcName: string;
  via: "gen" | "mod";
}

/**
 * The generic naming pass (doc §3.3). Given the named subshapes of the
 * input state (parent bodies and/or freshly-minted seeds) and the builder's
 * history, produces the output body's name table:
 *
 *  1. seeds claim their subshapes outright (IsSame);
 *  2. untouched inputs pass their names through (IsSame);
 *  3. history: Modified/Generated of each named input maps onto outputs —
 *     1→1 gives `mod(src)`/`gen(src)`, 1→N adds centroid-ordered
 *     `;s{k}of{n}`, N→1 merges take the lexicographically first source;
 *  4. anything left is an orphan `new(j)` (centroid-ordered) and counted in
 *     the report so the feature can carry a warning.
 */
export function nameFromHistory(opts: {
  oc: OpenCascadeInstance;
  featureId: string;
  newShape: TopoDsShape;
  /** Named inputs from the previous state (both parents for booleans). */
  oldFaces: NamedShape[];
  oldEdges: NamedShape[];
  /** Builders whose history covers this step (consulted in order). */
  histories: ShapeHistory[];
  /** Mint-time names for brand-new subshapes (caps, swept sides…). */
  faceSeeds?: NamedShape[];
  edgeSeeds?: NamedShape[];
}): { names: TopoNames; report: NamingReport } {
  const { oc, featureId, newShape } = opts;
  const newFaces = collectFaces(oc, newShape);
  const newEdges = collectUniqueEdges(oc, newShape);
  const faceNames = new Array<string | null>(newFaces.length).fill(null);
  const edgeNames = new Array<string | null>(newEdges.length).fill(null);

  const claim = (kind: "face" | "edge", index: number, name: string): void => {
    const table = kind === "face" ? faceNames : edgeNames;
    if (table[index] === null) table[index] = name;
  };

  // 1. Seeds claim outright.
  for (const seed of opts.faceSeeds ?? []) {
    const i = indexOfSame(newFaces, seed.shape);
    if (i >= 0) claim("face", i, seed.name);
  }
  for (const seed of opts.edgeSeeds ?? []) {
    const i = indexOfSame(newEdges, seed.shape);
    if (i >= 0) claim("edge", i, seed.name);
  }

  // 2. Passthrough for untouched inputs.
  for (const old of opts.oldFaces) {
    const i = indexOfSame(newFaces, old.shape);
    if (i >= 0) claim("face", i, old.name);
  }
  for (const old of opts.oldEdges) {
    const i = indexOfSame(newEdges, old.shape);
    if (i >= 0) claim("edge", i, old.name);
  }

  // 3. History mapping. Sources accumulate per output subshape; an output of
  //    Modified/Generated may be a face or an edge (e.g. boolean section
  //    edges are Generated from faces), so each output is looked up in both
  //    tables. History lists are consume-once, so each (builder, input) pair
  //    is queried exactly once.
  const faceSources = new Map<number, SourceRec[]>();
  const edgeSources = new Map<number, SourceRec[]>();
  const recordOutput = (out: TopoDsShape, rec: SourceRec): void => {
    if (out.IsNull()) return;
    const fi = indexOfSame(newFaces, out);
    if (fi >= 0) {
      if (faceNames[fi] === null) {
        const list = faceSources.get(fi) ?? [];
        list.push(rec);
        faceSources.set(fi, list);
      }
      return;
    }
    const ei = indexOfSame(newEdges, out);
    if (ei >= 0 && edgeNames[ei] === null) {
      const list = edgeSources.get(ei) ?? [];
      list.push(rec);
      edgeSources.set(ei, list);
    }
  };

  const allInputs = [...opts.oldFaces, ...opts.oldEdges];
  for (const history of opts.histories) {
    for (const input of allInputs) {
      try {
        for (const out of drain(history.Modified(input.shape))) {
          recordOutput(out, { srcName: input.name, via: "mod" });
        }
        for (const out of drain(history.Generated(input.shape))) {
          recordOutput(out, { srcName: input.name, via: "gen" });
        }
      } catch {
        // A builder that rejects this subshape kind contributes nothing —
        // orphan path covers its outputs (doc §4 "binding gap" row).
      }
    }
  }

  // Assign from sources. Group single-source outputs by (src, via) to detect
  // 1→N splits; multi-source outputs (merge seams) take the lexicographically
  // first source with `mod`.
  const assignFromSources = (
    kind: "face" | "edge",
    sources: Map<number, SourceRec[]>,
    shapes: TopoDsShape[],
  ): void => {
    const table = kind === "face" ? faceNames : edgeNames;
    const groups = new Map<string, number[]>(); // "via|src" -> output indices
    for (const [index, recs] of sources) {
      if (table[index] !== null) continue;
      const uniq = [...new Map(recs.map((r) => [`${r.via}|${r.srcName}`, r])).values()];
      if (uniq.length === 1) {
        const key = `${uniq[0]!.via}|${uniq[0]!.srcName}`;
        const list = groups.get(key) ?? [];
        list.push(index);
        groups.set(key, list);
      } else {
        const first = uniq.map((r) => r.srcName).sort()[0]!;
        table[index] = `${featureId}/${kind}/mod(${first})`;
      }
    }
    for (const [key, indices] of groups) {
      const sep = key.indexOf("|");
      const via = key.slice(0, sep);
      const src = key.slice(sep + 1);
      if (indices.length === 1) {
        table[indices[0]!] = `${featureId}/${kind}/${via}(${src})`;
      } else {
        const sorted = [...indices].sort((a, b) =>
          centroidLess(shapeCentroid(oc, shapes[a]!, kind), shapeCentroid(oc, shapes[b]!, kind))
            ? -1
            : 1,
        );
        sorted.forEach((index, k) => {
          table[index] = `${featureId}/${kind}/${via}(${src});s${k}of${sorted.length}`;
        });
      }
    }
  };
  assignFromSources("face", faceSources, newFaces);
  assignFromSources("edge", edgeSources, newEdges);

  // 4. Orphans, centroid-ordered for determinism.
  const fillOrphans = (
    kind: "face" | "edge",
    table: (string | null)[],
    shapes: TopoDsShape[],
  ): number => {
    const orphans = table
      .map((name, index) => ({ name, index }))
      .filter((x) => x.name === null)
      .map((x) => x.index)
      .sort((a, b) =>
        centroidLess(shapeCentroid(oc, shapes[a]!, kind), shapeCentroid(oc, shapes[b]!, kind))
          ? -1
          : 1,
      );
    orphans.forEach((index, j) => {
      table[index] = `${featureId}/${kind}/new(${j})`;
    });
    return orphans.length;
  };
  const orphanFaces = fillOrphans("face", faceNames, newFaces);
  const orphanEdges = fillOrphans("edge", edgeNames, newEdges);

  return {
    names: { faceNames: faceNames as string[], edgeNames: edgeNames as string[] },
    report: { orphanFaces, orphanEdges },
  };
}

/** Named views of a body's current subshapes, as inputs to the next pass. */
export function namedInputs(
  oc: OpenCascadeInstance,
  shape: TopoDsShape,
  names: TopoNames,
): { faces: NamedShape[]; edges: NamedShape[] } {
  const faces = collectFaces(oc, shape).map((f, i) => ({
    shape: f as TopoDsShape,
    name: names.faceNames[i] ?? `?/face/new(${i})`,
  }));
  const edges = collectUniqueEdges(oc, shape).map((e, i) => ({
    shape: e as TopoDsShape,
    name: names.edgeNames[i] ?? `?/edge/new(${i})`,
  }));
  return { faces, edges };
}

/**
 * Explicit order mapping for transforms (move/mirror/pattern instances):
 * `IsSame` does not survive BRepBuilderAPI_Transform, but explorer order
 * does (probe-verified), so the new table is the old one mapped elementwise.
 */
export function nameByOrder(
  oldNames: TopoNames,
  mapName: (old: string, kind: "face" | "edge") => string,
): TopoNames {
  return {
    faceNames: oldNames.faceNames.map((n) => mapName(n, "face")),
    edgeNames: oldNames.edgeNames.map((n) => mapName(n, "edge")),
  };
}

/** Fresh table for a shape with no history at all (STEP import). */
export function nameByOrdinal(
  oc: OpenCascadeInstance,
  featureId: string,
  shape: TopoDsShape,
  origin: string,
): TopoNames {
  return {
    faceNames: collectFaces(oc, shape).map((_f, j) => `${featureId}/face/${origin}(${j})`),
    edgeNames: collectUniqueEdges(oc, shape).map((_e, j) => `${featureId}/edge/${origin}(${j})`),
  };
}

export type ResolveFailure = "unknown-name" | "split-count-changed";

/**
 * Name → current index. Fails loudly; the split-count guard reports the more
 * specific reason when a `;s{k}of{n}` name's prefix survives with a
 * different sibling count (doc §3.5).
 */
export function resolveName(
  names: TopoNames,
  kind: "face" | "edge",
  name: string,
): { ok: true; index: number } | { ok: false; reason: ResolveFailure } {
  const table = kind === "face" ? names.faceNames : names.edgeNames;
  const index = table.indexOf(name);
  if (index >= 0) return { ok: true, index };
  const splitAt = name.lastIndexOf(";s");
  if (splitAt > 0) {
    const prefix = name.slice(0, splitAt);
    if (table.some((n) => n.startsWith(`${prefix};s`))) {
      return { ok: false, reason: "split-count-changed" };
    }
  }
  return { ok: false, reason: "unknown-name" };
}

/** Human-readable resolution failure for feature status messages. */
export function describeResolveFailure(reason: ResolveFailure, kind: "face" | "edge"): string {
  return reason === "split-count-changed"
    ? `Referenced ${kind} was split differently by an upstream edit — re-pick it`
    : `Referenced ${kind} no longer exists after an upstream edit — re-pick it`;
}
