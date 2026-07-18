/**
 * The regeneration engine (spec §4.3, session-scoped subset): executes the
 * document's features in timeline order against OCCT, producing bodies, and
 * reports per-feature status instead of throwing — a broken fillet must not
 * take down the whole model.
 *
 * Geometry is built directly in world coordinates: a sketch's 2D point (x,y)
 * maps to `origin + x·xdir + y·ydir` of its resolved plane, so no shape-level
 * transforms are needed.
 *
 * References resolve through D2 topological names (naming.ts,
 * docs/design/D2-topological-naming.md): every face/edge carries a
 * lineage-encoded name recomputed each regen from OCCT history; document
 * refs store names and resolution fails loudly instead of guessing. Legacy
 * v1 index refs are honored only during the one-time upgrade regen.
 */

import {
  ExprError,
  arcMidpoint,
  evaluateExpression,
  evaluateParameters,
  extractLoops,
  resolveSketchConstraints,
  sampleLoopPolygon,
  solveSketch,
  type BooleanFeature,
  type ChamferFeature,
  type CircularPatternFeature,
  type CraftbitDocument,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
  type ImportStepFeature,
  type LinearPatternFeature,
  type LoopSegment,
  type MirrorFeature,
  type MoveFeature,
  type PlaneRef,
  type RevolveFeature,
  type ShellFeature,
  type SketchEntity,
  type SketchFeature,
  type SketchProfile,
  type TopoRef,
} from "@craftbit/core";
import type {
  GpDir,
  GpPnt,
  OpenCascadeInstance,
  SweepMaker,
  TopoDsEdge,
  TopoDsFace,
  TopoDsShape,
  TopoDsWire,
} from "./occt-types";
import { collectFaces, collectUniqueEdges } from "./topo";
import {
  describeResolveFailure,
  nameByOrder,
  nameByOrdinal,
  nameFromHistory,
  namedInputs,
  resolveName,
  type NamedShape,
  type NamingReport,
  type TopoNames,
} from "./naming";

export { collectFaces, collectUniqueEdges };

export interface FeatureStatus {
  level: "ok" | "warning" | "error";
  message?: string;
}

export interface ResolvedPlane {
  origin: [number, number, number];
  normal: [number, number, number];
  xdir: [number, number, number];
  ydir: [number, number, number];
}

export type EvaluatedProfile =
  | { id: string; kind: "rect"; x: number; y: number; width: number; height: number }
  | { id: string; kind: "circle"; cx: number; cy: number; radius: number }
  | { id: string; kind: "polygon"; points: { x: number; y: number }[] }
  /** Closed loop from constraint-sketcher entities (D3): true lines/arcs. */
  | { id: string; kind: "loop"; segments: LoopSegment[] };

export interface SketchSolveInfo {
  converged: boolean;
  /** Remaining degrees of freedom; 0 = fully constrained. */
  dof: number;
}

export interface EvaluatedSketch {
  featureId: string;
  plane: ResolvedPlane;
  profiles: EvaluatedProfile[];
  /** Solved constraint-sketcher entities (D3); empty for profile-only sketches. */
  entities: SketchEntity[];
  /** Solver diagnostics; null when the sketch has no entities. */
  solve: SketchSolveInfo | null;
}

export interface RegenBody {
  id: string;
  shape: TopoDsShape;
  volume: number;
  /** D2 name tables, explorer-order aligned with collectFaces/collectUniqueEdges. */
  names: TopoNames;
}

export interface RegenState {
  bodies: RegenBody[];
  sketches: EvaluatedSketch[];
  statuses: Record<string, FeatureStatus>;
  parameterValues: Record<string, number>;
  parameterError?: string;
  /** Set during the one-time v1→v2 upgrade regen: legacy index refs are
   * rewritten to names on this document as they resolve (doc §2.4). */
  upgradeTarget?: CraftbitDocument;
}

/** Downgrades a feature's status to warning (never masks an error). */
function addWarning(state: RegenState, featureId: string, message: string): void {
  const current = state.statuses[featureId];
  if (current?.level === "error") return;
  const combined = current?.message ? `${current.message}; ${message}` : message;
  state.statuses[featureId] = { level: "warning", message: combined };
}

/** Post-op warning when history left unnamed FACES behind (a real lineage
 * gap — e.g. shell's offset faces, per the Phase-0 probe). Orphan edges are
 * routine byproducts (fresh fillet/chamfer boundaries) and stay silent —
 * their names are still stable while topology count is stable. */
function warnOrphans(state: RegenState, featureId: string, report: NamingReport): void {
  if (report.orphanFaces > 0) {
    addWarning(
      state,
      featureId,
      `${report.orphanFaces} face(s) without history lineage (orphan names)`,
    );
  }
}

/** Split-mark refs are valid but fragile (D2 §2.3) — regen flags them. */
function warnSplitRefs(state: RegenState, featureId: string, refs: readonly TopoRef[]): void {
  if (refs.some((r) => r.name?.includes(";s"))) {
    addWarning(
      state,
      featureId,
      "references a split face/edge — may need reattachment after upstream edits",
    );
  }
}

const V = (v: [number, number, number], s: number): [number, number, number] => [
  v[0] * s,
  v[1] * s,
  v[2] * s,
];
const ADD = (
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function regenerateDocument(
  oc: OpenCascadeInstance,
  doc: CraftbitDocument,
  options: { upgrade?: boolean } = {},
): RegenState {
  const state: RegenState = {
    bodies: [],
    sketches: [],
    statuses: {},
    parameterValues: {},
  };
  if (options.upgrade) state.upgradeTarget = doc;

  let paramEnv: (name: string) => number;
  try {
    const values = evaluateParameters(
      doc.parameters.map((p) => ({ name: p.name, expression: p.expression })),
    );
    state.parameterValues = Object.fromEntries(values);
    paramEnv = (name) => {
      const v = values.get(name);
      if (v === undefined) throw new ExprError("unknown-name", `Unknown parameter "${name}"`);
      return v;
    };
  } catch (e) {
    state.parameterError = e instanceof Error ? e.message : String(e);
    paramEnv = () => {
      throw new ExprError("unknown-name", state.parameterError!);
    };
  }

  for (const feature of doc.features) {
    if (feature.suppressed) {
      state.statuses[feature.id] = { level: "ok", message: "Suppressed" };
      continue;
    }
    try {
      executeFeature(oc, feature, state, paramEnv);
      state.statuses[feature.id] ??= { level: "ok" };
    } catch (e) {
      state.statuses[feature.id] = {
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return state;
}

function executeFeature(
  oc: OpenCascadeInstance,
  feature: Feature,
  state: RegenState,
  env: (name: string) => number,
): void {
  switch (feature.type) {
    case "sketch":
      executeSketch(oc, feature, state, env);
      break;
    case "extrude":
      executeExtrude(oc, feature, state, env);
      break;
    case "revolve":
      executeRevolve(oc, feature, state, env);
      break;
    case "fillet":
      executeFillet(oc, feature, state, env);
      break;
    case "chamfer":
      executeChamfer(oc, feature, state, env);
      break;
    case "shell":
      executeShell(oc, feature, state, env);
      break;
    case "mirror":
      executeMirror(oc, feature, state);
      break;
    case "linearPattern":
      executeLinearPattern(oc, feature, state, env);
      break;
    case "circularPattern":
      executeCircularPattern(oc, feature, state, env);
      break;
    case "boolean":
      executeBoolean(oc, feature, state);
      break;
    case "move":
      executeMove(oc, feature, state, env);
      break;
    case "importStep":
      executeImportStep(oc, feature, state);
      break;
  }
}

// ---------------------------------------------------------------- sketches

const ORIGIN_PLANES: Record<string, ResolvedPlane> = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0], ydir: [0, 1, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0], ydir: [0, 0, 1] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0], ydir: [0, 0, 1] },
};

export function resolvePlane(
  oc: OpenCascadeInstance,
  ref: PlaneRef,
  state: RegenState,
): ResolvedPlane {
  if (ref.kind === "origin") return ORIGIN_PLANES[ref.plane]!;

  const body = state.bodies.find((b) => b.id === ref.bodyId);
  if (!body) throw new Error(`Sketch plane references missing body ${ref.bodyId}`);
  const faces = collectFaces(oc, body.shape);
  const index = resolveTopoRef(state, body, ref as AnyRef, "face", (name) =>
    upgradeRef(ref as AnyRef, name),
  );
  const face = faces[index]!;

  const surf = new oc.BRepAdaptor_Surface_2(face, true);
  if (surf.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
    throw new Error("Selected face is not planar");
  }
  const pln = surf.Plane();
  const loc = pln.Location();
  let n = pln.Axis().Direction();
  if (face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value) {
    n = n.Reversed();
  }
  const xd = pln.Position().XDirection();
  const nv: [number, number, number] = [n.X(), n.Y(), n.Z()];
  const xv: [number, number, number] = [xd.X(), xd.Y(), xd.Z()];
  // ydir = normal × xdir
  const yv: [number, number, number] = [
    nv[1] * xv[2] - nv[2] * xv[1],
    nv[2] * xv[0] - nv[0] * xv[2],
    nv[0] * xv[1] - nv[1] * xv[0],
  ];
  return { origin: [loc.X(), loc.Y(), loc.Z()], normal: nv, xdir: xv, ydir: yv };
}

function evaluateProfile(profile: SketchProfile, env: (name: string) => number): EvaluatedProfile {
  switch (profile.kind) {
    case "rect": {
      const width = evaluateExpression(profile.width, env);
      const height = evaluateExpression(profile.height, env);
      if (width <= 0 || height <= 0) throw new Error("Rectangle width/height must be > 0");
      return {
        id: profile.id,
        kind: "rect",
        x: evaluateExpression(profile.x, env),
        y: evaluateExpression(profile.y, env),
        width,
        height,
      };
    }
    case "circle": {
      const radius = evaluateExpression(profile.radius, env);
      if (radius <= 0) throw new Error("Circle radius must be > 0");
      return {
        id: profile.id,
        kind: "circle",
        cx: evaluateExpression(profile.cx, env),
        cy: evaluateExpression(profile.cy, env),
        radius,
      };
    }
    case "polygon": {
      if (profile.points.length < 3) throw new Error("Polygon needs at least 3 points");
      return { id: profile.id, kind: "polygon", points: profile.points };
    }
  }
}

function executeSketch(
  oc: OpenCascadeInstance,
  feature: SketchFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const plane = resolvePlane(oc, feature.plane, state);
  if (feature.plane.kind === "face" && feature.plane.name?.includes(";s")) {
    addWarning(
      state,
      feature.id,
      "sketch plane references a split face — may need reattachment after upstream edits",
    );
  }
  const profiles = feature.profiles.map((p) => evaluateProfile(p, env));

  // Constraint-sketcher entities (D3): re-solve at every regeneration so
  // dimension expressions drive the geometry; stored coordinates are only
  // the initial guess. Closed line/arc loops and standalone circles become
  // profiles alongside the legacy ones.
  let entities: SketchEntity[] = [];
  let solve: SketchSolveInfo | null = null;
  if (feature.entities && feature.entities.length > 0) {
    const constraints = resolveSketchConstraints(feature.constraints ?? [], (expr) =>
      evaluateExpression(expr, env),
    );
    const result = solveSketch(feature.entities, constraints);
    entities = result.entities;
    solve = { converged: result.converged, dof: result.dof };
    if (!result.converged) {
      state.sketches.push({ featureId: feature.id, plane, profiles, entities, solve });
      throw new Error("Sketch constraints did not converge (conflicting or over-constrained)");
    }
    const pointById = new Map(
      entities.filter((e) => e.kind === "point").map((e) => [e.id, e as { x: number; y: number }]),
    );
    for (const e of entities) {
      if (e.kind === "circle") {
        const c = pointById.get(e.center);
        if (c && e.radius > 1e-9) {
          profiles.push({ id: e.id, kind: "circle", cx: c.x, cy: c.y, radius: e.radius });
        }
      }
    }
    for (const loop of extractLoops(entities, constraints)) {
      profiles.push({ id: loop.id, kind: "loop", segments: loop.segments });
    }
  }

  state.sketches.push({ featureId: feature.id, plane, profiles, entities, solve });
}

// ---------------------------------------------------------------- extrude

function pointInPolygon(pts: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Loop profiles use a sampled polygon (true arcs → chords) for the 2D
 * area/containment tests only; wire building keeps exact arcs. */
function loopPolygon(p: Extract<EvaluatedProfile, { kind: "loop" }>): { x: number; y: number }[] {
  return sampleLoopPolygon({ id: p.id, segments: p.segments });
}

/** 2D point-in-profile test used for hole nesting. */
function profileContains(p: EvaluatedProfile, x: number, y: number): boolean {
  switch (p.kind) {
    case "rect":
      return x > p.x && x < p.x + p.width && y > p.y && y < p.y + p.height;
    case "circle":
      return (x - p.cx) ** 2 + (y - p.cy) ** 2 < p.radius ** 2;
    case "polygon":
      return pointInPolygon(p.points, x, y);
    case "loop":
      return pointInPolygon(loopPolygon(p), x, y);
  }
}

function polygonCentroid(points: { x: number; y: number }[]): { x: number; y: number } {
  // Centroid works for convex-ish shapes; adequate here.
  let sx = 0;
  let sy = 0;
  for (const pt of points) {
    sx += pt.x;
    sy += pt.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

function profileInnerPoint(p: EvaluatedProfile): { x: number; y: number } {
  switch (p.kind) {
    case "rect":
      return { x: p.x + p.width / 2, y: p.y + p.height / 2 };
    case "circle":
      return { x: p.cx, y: p.cy };
    case "polygon":
      return polygonCentroid(p.points);
    case "loop":
      return polygonCentroid(loopPolygon(p));
  }
}

function signedArea(points: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j]!.x - points[i]!.x) * (points[j]!.y + points[i]!.y);
  }
  return sum / 2;
}

interface PlaneMapper {
  point(x: number, y: number): GpPnt;
  normalDir(): GpDir;
  xDir(): GpDir;
}

function planeMapper(oc: OpenCascadeInstance, plane: ResolvedPlane): PlaneMapper {
  return {
    point: (x, y) => {
      const w = ADD(plane.origin, ADD(V(plane.xdir, x), V(plane.ydir, y)));
      return new oc.gp_Pnt_3(w[0], w[1], w[2]);
    },
    normalDir: () => new oc.gp_Dir_4(plane.normal[0], plane.normal[1], plane.normal[2]),
    xDir: () => new oc.gp_Dir_4(plane.xdir[0], plane.xdir[1], plane.xdir[2]),
  };
}

/** A profile-wire edge tagged with its D2 curve key and world endpoints. */
interface KeyedEdge {
  edge: TopoDsEdge;
  /** curveKey `sketchFeatId:profileId:segKey` (doc §3.1); segKey is the D3
   * entity UUID for loop segments, a positional index otherwise. */
  key: string;
  /** World endpoints; null for closed curves (full circles). */
  a: [number, number, number] | null;
  b: [number, number, number] | null;
}

interface KeyedWire {
  wire: TopoDsWire;
  edges: KeyedEdge[];
}

/** A profile face whose boundary edges (outer + holes) carry curve keys. */
interface KeyedFace {
  face: TopoDsFace;
  edges: KeyedEdge[];
}

function worldOf(plane: ResolvedPlane, x: number, y: number): [number, number, number] {
  return ADD(plane.origin, ADD(V(plane.xdir, x), V(plane.ydir, y)));
}

/**
 * BRepBuilderAPI_MakeWire rebuilds edges after the first on shared vertices,
 * so the edge objects we constructed are not the wire's actual edges (their
 * TShapes differ — IsSame and Generated() would both miss). Re-anchor each
 * keyed edge onto the wire's real edge instance by centroid match (exact
 * same geometry ⇒ identical centroids; 1e-6 tolerance).
 */
function reanchorKeyedEdges(oc: OpenCascadeInstance, wire: TopoDsWire, edges: KeyedEdge[]): void {
  const wireEdges: TopoDsEdge[] = collectUniqueEdges(oc, wire);
  for (const ke of edges) {
    const want = shapeCentroidOf(oc, ke.edge);
    let best: { edge: TopoDsEdge; d: number } | null = null;
    for (const we of wireEdges) {
      const c = shapeCentroidOf(oc, we);
      const d = Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2]);
      if (!best || d < best.d) best = { edge: we, d };
    }
    if (best && best.d < 1e-6) ke.edge = best.edge;
  }
}

/** Builds a profile wire keeping each edge's curve key (doc §3.1 curveKey). */
function keyedProfileWire(
  oc: OpenCascadeInstance,
  sketchId: string,
  profile: EvaluatedProfile,
  plane: ResolvedPlane,
  map: PlaneMapper,
): KeyedWire {
  const keyOf = (seg: string | number) => `${sketchId}:${profile.id}:${seg}`;

  if (profile.kind === "circle") {
    const ax = new oc.gp_Ax2_2(map.point(profile.cx, profile.cy), map.normalDir(), map.xDir());
    const edge = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, profile.radius)).Edge();
    return {
      wire: new oc.BRepBuilderAPI_MakeWire_2(edge).Wire(),
      edges: [{ edge, key: keyOf(0), a: null, b: null }],
    };
  }

  if (profile.kind === "loop") {
    // Ensure CCW traversal so faces orient consistently with the other kinds.
    const ccw = signedArea(loopPolygon(profile)) >= 0;
    const segments = ccw
      ? profile.segments
      : [...profile.segments].reverse().map((s) => {
          if (s.kind === "line") return { ...s, a: s.b, b: s.a };
          return { ...s, a: s.b, b: s.a, ccw: !s.ccw };
        });
    const maker = new oc.BRepBuilderAPI_MakeWire_1();
    const edges: KeyedEdge[] = [];
    segments.forEach((seg, i) => {
      if (Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) < 1e-9) return;
      let edge: TopoDsEdge;
      if (seg.kind === "line") {
        edge = new oc.BRepBuilderAPI_MakeEdge_3(
          map.point(seg.a.x, seg.a.y),
          map.point(seg.b.x, seg.b.y),
        ).Edge();
      } else {
        const mid = arcMidpoint(seg);
        const mk = new oc.GC_MakeArcOfCircle_4(
          map.point(seg.a.x, seg.a.y),
          map.point(mid.x, mid.y),
          map.point(seg.b.x, seg.b.y),
        );
        if (!mk.IsDone()) throw new Error("Arc construction failed");
        edge = new oc.BRepBuilderAPI_MakeEdge_24(
          new oc.Handle_Geom_Curve_2(mk.Value().get()),
        ).Edge();
      }
      maker.Add_1(edge);
      edges.push({
        edge,
        key: keyOf(seg.entityId ?? i),
        a: worldOf(plane, seg.a.x, seg.a.y),
        b: worldOf(plane, seg.b.x, seg.b.y),
      });
    });
    const wire = maker.Wire();
    reanchorKeyedEdges(oc, wire, edges);
    return { wire, edges };
  }

  let pts2d: { x: number; y: number }[];
  if (profile.kind === "rect") {
    pts2d = [
      { x: profile.x, y: profile.y },
      { x: profile.x + profile.width, y: profile.y },
      { x: profile.x + profile.width, y: profile.y + profile.height },
      { x: profile.x, y: profile.y + profile.height },
    ];
  } else {
    pts2d = [...profile.points];
    if (signedArea(pts2d) < 0) pts2d.reverse(); // ensure CCW so faces orient consistently
  }
  const maker = new oc.BRepBuilderAPI_MakeWire_1();
  const edges: KeyedEdge[] = [];
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i]!;
    const b = pts2d[(i + 1) % pts2d.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    const edge = new oc.BRepBuilderAPI_MakeEdge_3(map.point(a.x, a.y), map.point(b.x, b.y)).Edge();
    maker.Add_1(edge);
    edges.push({ edge, key: keyOf(i), a: worldOf(plane, a.x, a.y), b: worldOf(plane, b.x, b.y) });
  }
  const wire = maker.Wire();
  reanchorKeyedEdges(oc, wire, edges);
  return { wire, edges };
}

function profileArea(p: EvaluatedProfile): number {
  switch (p.kind) {
    case "rect":
      return p.width * p.height;
    case "circle":
      return Math.PI * p.radius ** 2;
    case "polygon":
      return Math.abs(signedArea(p.points));
    case "loop":
      return Math.abs(signedArea(loopPolygon(p)));
  }
}

/**
 * Groups evaluated profiles into outers with nested holes (even-odd depth).
 * Containment is tested with the candidate's inner point, but only against
 * strictly larger profiles — otherwise a rect whose centroid falls inside its
 * own hole would be misclassified as contained by it.
 */
export function groupProfiles(profiles: EvaluatedProfile[]): {
  outer: EvaluatedProfile;
  holes: EvaluatedProfile[];
}[] {
  const contains = (o: EvaluatedProfile, p: EvaluatedProfile): boolean => {
    if (o === p || profileArea(o) <= profileArea(p)) return false;
    const pt = profileInnerPoint(p);
    return profileContains(o, pt.x, pt.y);
  };
  const depth = (p: EvaluatedProfile): number => profiles.filter((o) => contains(o, p)).length;
  const outers = profiles.filter((p) => depth(p) % 2 === 0);
  return outers.map((outer) => ({
    outer,
    holes: profiles.filter((p) => depth(p) % 2 === 1 && contains(outer, p)),
  }));
}

function buildKeyedFaces(
  oc: OpenCascadeInstance,
  sketch: EvaluatedSketch,
  profileIds: string[],
): KeyedFace[] {
  const selected =
    profileIds.length === 0
      ? sketch.profiles
      : sketch.profiles.filter((p) => profileIds.includes(p.id));
  if (selected.length === 0) throw new Error("No profiles selected for extrude");
  const map = planeMapper(oc, sketch.plane);
  return groupProfiles(selected).map(({ outer, holes }) => {
    const outerWire = keyedProfileWire(oc, sketch.featureId, outer, sketch.plane, map);
    const fm = new oc.BRepBuilderAPI_MakeFace_15(outerWire.wire, true);
    const edges = [...outerWire.edges];
    for (const hole of holes) {
      const holeWire = keyedProfileWire(oc, sketch.featureId, hole, sketch.plane, map);
      fm.Add(oc.TopoDS.Wire_1(holeWire.wire.Reversed()));
      edges.push(...holeWire.edges);
    }
    return { face: fm.Face(), edges };
  });
}

function shapeVolume(oc: OpenCascadeInstance, shape: TopoDsShape): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  return props.Mass();
}

function intersects(oc: OpenCascadeInstance, a: TopoDsShape, b: TopoDsShape): boolean {
  const common = new oc.BRepAlgoAPI_Common_3(a, b);
  common.Build();
  if (!common.IsDone()) return false;
  return Math.abs(shapeVolume(oc, common.Shape())) > 1e-9;
}

// ------------------------------------------------------ named sweeps (D2)

/** A tool body carrying its own D2 name table. */
interface NamedTool {
  shape: TopoDsShape;
  names: TopoNames;
  report: NamingReport;
}

const zeroReport = (): NamingReport => ({ orphanFaces: 0, orphanEdges: 0 });

/**
 * Names one swept solid (prism/revolve of one keyed profile face) per doc
 * §3.4: caps from FirstShape/LastShape → `start`/`end`, side faces from
 * Generated(profileEdge) → `side(curveKey)`, start-cap edges via IsSame with
 * the profile wire → `cap(start,key)`. For prisms, end-cap and lateral edges
 * are derived from the sweep vector (exact arithmetic on the known profile
 * endpoints — mint-time construction, not resolve-time guessing), keeping
 * every box edge stably named so fillet refs survive dimension edits.
 */
function nameSweep(opts: {
  oc: OpenCascadeInstance;
  featureId: string;
  builder: SweepMaker;
  shape: TopoDsShape;
  keyed: KeyedFace;
  sweepVec: [number, number, number] | null;
  mintCaps: boolean;
  capSuffix: string;
}): { names: TopoNames; report: NamingReport } {
  const { oc, featureId, builder, shape, keyed } = opts;
  const faceSeeds: NamedShape[] = [];
  const edgeSeeds: NamedShape[] = [];

  if (opts.mintCaps) {
    // Doc §7.3: never query caps at 360° — callers pass mintCaps=false there.
    const start = builder.FirstShape();
    const end = builder.LastShape();
    if (!start.IsNull()) {
      faceSeeds.push({ shape: start, name: `${featureId}/face/start${opts.capSuffix}` });
    }
    if (!end.IsNull()) {
      faceSeeds.push({ shape: end, name: `${featureId}/face/end${opts.capSuffix}` });
    }
  }

  for (const ke of keyed.edges) {
    // Consume-once history: Generated is queried exactly once per edge here.
    try {
      const drained: TopoDsShape[] = [];
      const list = builder.Generated(ke.edge);
      while (list.Size() > 0) {
        drained.push(list.First_1());
        list.RemoveFirst();
      }
      const real = drained.filter((s) => !s.IsNull());
      real.forEach((sideFace, i) => {
        const mark = real.length > 1 ? `;s${i}of${real.length}` : "";
        faceSeeds.push({ shape: sideFace, name: `${featureId}/face/side(${ke.key})${mark}` });
      });
    } catch {
      // No history for this edge — its side face takes the orphan path.
    }
    // The profile wire's own edges survive into the solid as start-cap edges.
    edgeSeeds.push({ shape: ke.edge, name: `${featureId}/edge/cap(start,${ke.key})` });
  }

  // Prism-only: derive end-cap and lateral edge names from the sweep vector.
  if (opts.sweepVec) {
    const vec = opts.sweepVec;
    const near = (p: [number, number, number], q: [number, number, number]) =>
      Math.abs(p[0] - q[0]) < 1e-4 && Math.abs(p[1] - q[1]) < 1e-4 && Math.abs(p[2] - q[2]) < 1e-4;
    for (const newEdge of collectUniqueEdges(oc, shape)) {
      const c = shapeCentroidOf(oc, newEdge);
      let claimed = false;
      for (const ke of keyed.edges) {
        const keCentroid = shapeCentroidOf(oc, ke.edge);
        if (near(c, ADD(keCentroid, vec))) {
          edgeSeeds.push({ shape: newEdge, name: `${featureId}/edge/cap(end,${ke.key})` });
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
      for (const ke of keyed.edges) {
        if (!ke.a) continue;
        if (near(c, ADD(ke.a, V(vec, 0.5)))) {
          edgeSeeds.push({ shape: newEdge, name: `${featureId}/edge/lat(${ke.key})` });
          break;
        }
      }
    }
  }

  return nameFromHistory({
    oc,
    featureId,
    newShape: shape,
    oldFaces: [],
    oldEdges: [],
    histories: [],
    faceSeeds,
    edgeSeeds,
  });
}

/** Edge/face centroid used by sweep edge derivation (thin wrapper, cached in naming.ts). */
function shapeCentroidOf(oc: OpenCascadeInstance, edge: TopoDsShape): [number, number, number] {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const c = props.CentreOfMass();
  return [c.X(), c.Y(), c.Z()];
}

/** Fuses named tools pairwise, carrying names through each fuse's history. */
function fuseNamedTools(oc: OpenCascadeInstance, featureId: string, tools: NamedTool[]): NamedTool {
  let acc = tools[0]!;
  for (let i = 1; i < tools.length; i++) {
    const next = tools[i]!;
    const fuse = new oc.BRepAlgoAPI_Fuse_3(acc.shape, next.shape);
    fuse.Build();
    if (!fuse.IsDone()) throw new Error("Boolean fuse failed");
    const shape = fuse.Shape();
    const accInputs = namedInputs(oc, acc.shape, acc.names);
    const nextInputs = namedInputs(oc, next.shape, next.names);
    const { names, report } = nameFromHistory({
      oc,
      featureId,
      newShape: shape,
      oldFaces: [...accInputs.faces, ...nextInputs.faces],
      oldEdges: [...accInputs.edges, ...nextInputs.edges],
      histories: [fuse],
    });
    acc = {
      shape,
      names,
      report: {
        orphanFaces: acc.report.orphanFaces + next.report.orphanFaces + report.orphanFaces,
        orphanEdges: acc.report.orphanEdges + next.report.orphanEdges + report.orphanEdges,
      },
    };
  }
  return acc;
}

/** Applies a named tool to the model per the feature's operation, carrying
 * name lineage from both parents through the boolean's history. */
function applyNamedTool(
  oc: OpenCascadeInstance,
  featureId: string,
  operation: ExtrudeFeature["operation"],
  tool: NamedTool,
  state: RegenState,
): void {
  const combine = (
    body: RegenBody,
    op: "fuse" | "cut",
  ): { shape: TopoDsShape; names: TopoNames; report: NamingReport } => {
    const builder =
      op === "fuse"
        ? new oc.BRepAlgoAPI_Fuse_3(body.shape, tool.shape)
        : new oc.BRepAlgoAPI_Cut_3(body.shape, tool.shape);
    builder.Build();
    if (!builder.IsDone()) throw new Error(op === "fuse" ? "Join failed" : "Cut failed");
    const shape = builder.Shape();
    const bodyInputs = namedInputs(oc, body.shape, body.names);
    const toolInputs = namedInputs(oc, tool.shape, tool.names);
    const { names, report } = nameFromHistory({
      oc,
      featureId,
      newShape: shape,
      oldFaces: [...bodyInputs.faces, ...toolInputs.faces],
      oldEdges: [...bodyInputs.edges, ...toolInputs.edges],
      histories: [builder],
    });
    return { shape, names, report };
  };

  switch (operation) {
    case "new": {
      state.bodies.push({
        id: featureId,
        shape: tool.shape,
        names: tool.names,
        volume: shapeVolume(oc, tool.shape),
      });
      warnOrphans(state, featureId, tool.report);
      break;
    }
    case "join": {
      const target = state.bodies.find((b) => intersects(oc, b.shape, tool.shape));
      if (!target) {
        // Nothing to join with — behave like a new body (Fusion does the same).
        state.bodies.push({
          id: featureId,
          shape: tool.shape,
          names: tool.names,
          volume: shapeVolume(oc, tool.shape),
        });
        warnOrphans(state, featureId, tool.report);
        break;
      }
      const merged = combine(target, "fuse");
      target.shape = merged.shape;
      target.names = merged.names;
      target.volume = shapeVolume(oc, target.shape);
      warnOrphans(state, featureId, merged.report);
      break;
    }
    case "cut": {
      if (state.bodies.length === 0) throw new Error("Nothing to cut — no bodies yet");
      let cutAny = false;
      for (const body of state.bodies) {
        if (!intersects(oc, body.shape, tool.shape)) continue;
        const cut = combine(body, "cut");
        body.shape = cut.shape;
        body.names = cut.names;
        body.volume = shapeVolume(oc, body.shape);
        warnOrphans(state, featureId, cut.report);
        cutAny = true;
      }
      if (!cutAny) throw new Error("Cut tool does not intersect any body");
      break;
    }
  }
}

function executeExtrude(
  oc: OpenCascadeInstance,
  feature: ExtrudeFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const sketch = state.sketches.find((s) => s.featureId === feature.sketchId);
  if (!sketch) throw new Error("Extrude references a missing or failed sketch");

  const distance = evaluateExpression(feature.distance, env);
  if (distance <= 0) throw new Error("Extrude distance must be > 0");

  const n = sketch.plane.normal;

  const makeTool = (vec: [number, number, number], shift: [number, number, number]): NamedTool => {
    // shift is applied by rebuilding the sketch plane origin — used for symmetric.
    const shifted: EvaluatedSketch = {
      ...sketch,
      plane: { ...sketch.plane, origin: ADD(sketch.plane.origin, shift) },
    };
    const keyedFaces = buildKeyedFaces(oc, shifted, feature.profileIds);
    const prisms = keyedFaces.map((keyed, k) => {
      const builder = new oc.BRepPrimAPI_MakePrism_1(
        keyed.face,
        new oc.gp_Vec_4(vec[0], vec[1], vec[2]),
        false,
        true,
      );
      const shape = builder.Shape();
      const capSuffix = keyedFaces.length > 1 ? `;s${k}of${keyedFaces.length}` : "";
      const { names, report } = nameSweep({
        oc,
        featureId: feature.id,
        builder,
        shape,
        keyed,
        sweepVec: vec,
        mintCaps: true,
        capSuffix,
      });
      return { shape, names, report };
    });
    return fuseNamedTools(oc, feature.id, prisms);
  };

  let tool: NamedTool;
  if (feature.direction === "normal") tool = makeTool(V(n, distance), [0, 0, 0]);
  else if (feature.direction === "reversed") tool = makeTool(V(n, -distance), [0, 0, 0]);
  else tool = makeTool(V(n, distance), V(n, -distance / 2));

  applyNamedTool(oc, feature.id, feature.operation, tool, state);
}

// ---------------------------------------------------------------- ref resolution (D2)

/** A ref as it may appear in a document: v2 name, or v1 legacy index. */
type AnyRef = { bodyId: string; name?: string; edgeIndex?: number; faceIndex?: number };

/**
 * Resolves a face/edge reference against a body's current name table.
 * v2 name refs go through the loud-failure name lookup; v1 legacy index refs
 * are honored only to bootstrap the upgrade regen, which rewrites them to
 * names via `rewrite` as they resolve (doc §2.4 — never guess, only capture).
 */
function resolveTopoRef(
  state: RegenState,
  body: RegenBody,
  ref: AnyRef,
  kind: "face" | "edge",
  rewrite: (name: string) => void,
): number {
  if (typeof ref.name === "string") {
    const result = resolveName(body.names, kind, ref.name);
    if (!result.ok) throw new Error(describeResolveFailure(result.reason, kind));
    return result.index;
  }
  const legacyIndex = kind === "face" ? ref.faceIndex : ref.edgeIndex;
  if (typeof legacyIndex !== "number") throw new Error(`Malformed ${kind} reference`);
  const table = kind === "face" ? body.names.faceNames : body.names.edgeNames;
  const name = table[legacyIndex];
  if (name === undefined) {
    throw new Error(`Referenced ${kind} #${legacyIndex} no longer exists — re-pick it`);
  }
  if (state.upgradeTarget) rewrite(name);
  return legacyIndex;
}

/** Rewrites one legacy ref object in the upgrade-target document in place. */
function upgradeRef(ref: AnyRef, name: string): void {
  ref.name = name;
  delete ref.edgeIndex;
  delete ref.faceIndex;
}

// ---------------------------------------------------------------- fillet

function executeFillet(
  oc: OpenCascadeInstance,
  feature: FilletFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const radius = evaluateExpression(feature.radius, env);
  if (radius <= 0) throw new Error("Fillet radius must be > 0");
  if (feature.edges.length === 0) throw new Error("Fillet has no edges selected");

  const byBody = new Map<string, AnyRef[]>();
  for (const ref of feature.edges) {
    const list = byBody.get(ref.bodyId) ?? [];
    list.push(ref);
    byBody.set(ref.bodyId, list);
  }

  for (const [bodyId, refs] of byBody) {
    const body = state.bodies.find((b) => b.id === bodyId);
    if (!body) throw new Error(`Fillet references missing body ${bodyId}`);
    const edges = collectUniqueEdges(oc, body.shape);
    const before = namedInputs(oc, body.shape, body.names);
    const fillet = new oc.BRepFilletAPI_MakeFillet(
      body.shape,
      oc.ChFi3d_FilletShape.ChFi3d_Rational,
    );
    for (const ref of refs) {
      const index = resolveTopoRef(state, body, ref, "edge", (name) => upgradeRef(ref, name));
      fillet.Add_2(radius, edges[index]!);
    }
    fillet.Build();
    if (!fillet.IsDone()) {
      throw new Error(`Fillet failed — radius ${radius} may exceed adjacent face size`);
    }
    const shape = fillet.Shape();
    const { names, report } = nameFromHistory({
      oc,
      featureId: feature.id,
      newShape: shape,
      oldFaces: before.faces,
      oldEdges: before.edges,
      histories: [fillet],
    });
    body.shape = shape;
    body.names = names;
    body.volume = shapeVolume(oc, body.shape);
    warnOrphans(state, feature.id, report);
  }
  warnSplitRefs(state, feature.id, feature.edges);
}

// ---------------------------------------------------------------- revolve

function executeRevolve(
  oc: OpenCascadeInstance,
  feature: RevolveFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const sketch = state.sketches.find((s) => s.featureId === feature.sketchId);
  if (!sketch) throw new Error("Revolve references a missing or failed sketch");

  const angleDeg = evaluateExpression(feature.angle, env);
  if (angleDeg <= 0 || angleDeg > 360) throw new Error("Revolve angle must be in (0, 360]");

  const keyedFaces = buildKeyedFaces(oc, sketch, feature.profileIds);
  const { origin, xdir, ydir } = sketch.plane;
  const axisDir = feature.axis === "x" ? xdir : ydir;
  const axis = new oc.gp_Ax1_2(
    new oc.gp_Pnt_3(origin[0], origin[1], origin[2]),
    new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2]),
  );

  const solids = keyedFaces.map((keyed, k) => {
    const builder = new oc.BRepPrimAPI_MakeRevol_1(
      keyed.face,
      axis,
      (angleDeg * Math.PI) / 180,
      true,
    );
    const shape = builder.Shape();
    const capSuffix = keyedFaces.length > 1 ? `;s${k}of${keyedFaces.length}` : "";
    const { names, report } = nameSweep({
      oc,
      featureId: feature.id,
      builder,
      shape,
      keyed,
      sweepVec: null,
      // Probe finding (doc §7.3): at 360° FirstShape returns a non-null shape
      // even though there are no caps — never mint start/end names there.
      mintCaps: angleDeg < 360,
      capSuffix,
    });
    return { shape, names, report };
  });
  const tool = fuseNamedTools(oc, feature.id, solids);
  applyNamedTool(oc, feature.id, feature.operation, tool, state);
}

// ---------------------------------------------------------------- chamfer

function executeChamfer(
  oc: OpenCascadeInstance,
  feature: ChamferFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const distance = evaluateExpression(feature.distance, env);
  if (distance <= 0) throw new Error("Chamfer distance must be > 0");
  if (feature.edges.length === 0) throw new Error("Chamfer has no edges selected");

  const byBody = new Map<string, AnyRef[]>();
  for (const ref of feature.edges) {
    const list = byBody.get(ref.bodyId) ?? [];
    list.push(ref);
    byBody.set(ref.bodyId, list);
  }

  for (const [bodyId, refs] of byBody) {
    const body = state.bodies.find((b) => b.id === bodyId);
    if (!body) throw new Error(`Chamfer references missing body ${bodyId}`);
    const edges = collectUniqueEdges(oc, body.shape);
    const before = namedInputs(oc, body.shape, body.names);
    const chamfer = new oc.BRepFilletAPI_MakeChamfer(body.shape);
    for (const ref of refs) {
      const index = resolveTopoRef(state, body, ref, "edge", (name) => upgradeRef(ref, name));
      chamfer.Add_2(distance, edges[index]!);
    }
    chamfer.Build();
    if (!chamfer.IsDone()) {
      throw new Error(`Chamfer failed — distance ${distance} may exceed adjacent face size`);
    }
    const shape = chamfer.Shape();
    const { names, report } = nameFromHistory({
      oc,
      featureId: feature.id,
      newShape: shape,
      oldFaces: before.faces,
      oldEdges: before.edges,
      histories: [chamfer],
    });
    body.shape = shape;
    body.names = names;
    body.volume = shapeVolume(oc, body.shape);
    warnOrphans(state, feature.id, report);
  }
  warnSplitRefs(state, feature.id, feature.edges);
}

// ---------------------------------------------------------------- shell

function executeShell(
  oc: OpenCascadeInstance,
  feature: ShellFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const thickness = evaluateExpression(feature.thickness, env);
  if (thickness <= 0) throw new Error("Shell thickness must be > 0");
  if (feature.faces.length === 0) throw new Error("Shell needs at least one face to remove");

  const bodyId = feature.faces[0]!.bodyId;
  if (!feature.faces.every((f) => f.bodyId === bodyId)) {
    throw new Error("All shell faces must belong to the same body");
  }
  const body = state.bodies.find((b) => b.id === bodyId);
  if (!body) throw new Error(`Shell references missing body ${bodyId}`);

  const faces = collectFaces(oc, body.shape);
  const before = namedInputs(oc, body.shape, body.names);
  const closing = new oc.TopTools_ListOfShape_1();
  for (const ref of feature.faces) {
    const index = resolveTopoRef(state, body, ref as AnyRef, "face", (name) =>
      upgradeRef(ref as AnyRef, name),
    );
    closing.Append_1(faces[index]!);
  }

  const thick = new oc.BRepOffsetAPI_MakeThickSolid_2(
    body.shape,
    closing,
    -thickness, // negative = walls grow inward from the outer surface
    1e-6,
    oc.BRepOffset_Mode.BRepOffset_Skin,
    false,
    false,
    oc.GeomAbs_JoinType.GeomAbs_Arc,
    false,
  );
  if (!thick.IsDone()) throw new Error("Shell failed — thickness may be too large");
  const shape = thick.Shape();
  // Probe finding: ThickSolid reports Generated(edge)→rim faces but nothing
  // for offset inner faces — those take the orphan path (doc §3.4 shell row).
  const { names, report } = nameFromHistory({
    oc,
    featureId: feature.id,
    newShape: shape,
    oldFaces: before.faces,
    oldEdges: before.edges,
    histories: [thick],
  });
  body.shape = shape;
  body.names = names;
  body.volume = shapeVolume(oc, body.shape);
  warnOrphans(state, feature.id, report);
  warnSplitRefs(state, feature.id, feature.faces);
}

// ---------------------------------------------------------------- transforms

const MIRROR_PLANES: Record<string, { n: [number, number, number] }> = {
  XY: { n: [0, 0, 1] },
  XZ: { n: [0, 1, 0] },
  YZ: { n: [1, 0, 0] },
};

const AXIS_DIRS: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

function executeMirror(oc: OpenCascadeInstance, feature: MirrorFeature, state: RegenState): void {
  const body = state.bodies.find((b) => b.id === feature.bodyId);
  if (!body) throw new Error(`Mirror references missing body ${feature.bodyId}`);
  const n = MIRROR_PLANES[feature.plane]!.n;
  const trsf = new oc.gp_Trsf_1();
  trsf.SetMirror_3(new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(n[0], n[1], n[2])));
  const mirrored = new oc.BRepBuilderAPI_Transform_2(body.shape, trsf, true).Shape();
  // Transforms preserve explorer order but not IsSame (probe) — explicit map.
  const mirroredNames = nameByOrder(
    body.names,
    (old, kind) => `${feature.id}/${kind}/inst(0,${old})`,
  );

  if (feature.merge) {
    const fuse = new oc.BRepAlgoAPI_Fuse_3(body.shape, mirrored);
    fuse.Build();
    if (!fuse.IsDone()) throw new Error("Mirror merge failed");
    const shape = fuse.Shape();
    const bodyInputs = namedInputs(oc, body.shape, body.names);
    const copyInputs = namedInputs(oc, mirrored, mirroredNames);
    const { names, report } = nameFromHistory({
      oc,
      featureId: feature.id,
      newShape: shape,
      oldFaces: [...bodyInputs.faces, ...copyInputs.faces],
      oldEdges: [...bodyInputs.edges, ...copyInputs.edges],
      histories: [fuse],
    });
    body.shape = shape;
    body.names = names;
    body.volume = shapeVolume(oc, body.shape);
    warnOrphans(state, feature.id, report);
  } else {
    state.bodies.push({
      id: feature.id,
      shape: mirrored,
      names: mirroredNames,
      volume: shapeVolume(oc, mirrored),
    });
  }
}

function executeLinearPattern(
  oc: OpenCascadeInstance,
  feature: LinearPatternFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const body = state.bodies.find((b) => b.id === feature.bodyId);
  if (!body) throw new Error(`Pattern references missing body ${feature.bodyId}`);
  const spacing = evaluateExpression(feature.spacing, env);
  const count = Math.round(evaluateExpression(feature.count, env));
  if (count < 2 || count > 100) throw new Error("Pattern count must be between 2 and 100");
  if (spacing === 0) throw new Error("Pattern spacing must be nonzero");

  const dir = AXIS_DIRS[feature.direction];
  const copies: NamedTool[] = [{ shape: body.shape, names: body.names, report: zeroReport() }];
  for (let i = 1; i < count; i++) {
    const trsf = new oc.gp_Trsf_1();
    trsf.SetTranslation_1(
      new oc.gp_Vec_4(dir[0] * spacing * i, dir[1] * spacing * i, dir[2] * spacing * i),
    );
    copies.push({
      shape: new oc.BRepBuilderAPI_Transform_2(body.shape, trsf, true).Shape(),
      names: nameByOrder(body.names, (old, kind) => `${feature.id}/${kind}/inst(${i},${old})`),
      report: zeroReport(),
    });
  }
  const fused = fuseNamedTools(oc, feature.id, copies);
  body.shape = fused.shape;
  body.names = fused.names;
  body.volume = shapeVolume(oc, body.shape);
  warnOrphans(state, feature.id, fused.report);
}

function executeCircularPattern(
  oc: OpenCascadeInstance,
  feature: CircularPatternFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const body = state.bodies.find((b) => b.id === feature.bodyId);
  if (!body) throw new Error(`Pattern references missing body ${feature.bodyId}`);
  const count = Math.round(evaluateExpression(feature.count, env));
  if (count < 2 || count > 100) throw new Error("Pattern count must be between 2 and 100");

  const dir = AXIS_DIRS[feature.axis];
  const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(dir[0], dir[1], dir[2]));
  const copies: NamedTool[] = [{ shape: body.shape, names: body.names, report: zeroReport() }];
  for (let i = 1; i < count; i++) {
    const trsf = new oc.gp_Trsf_1();
    trsf.SetRotation_1(axis, (i * 2 * Math.PI) / count);
    copies.push({
      shape: new oc.BRepBuilderAPI_Transform_2(body.shape, trsf, true).Shape(),
      names: nameByOrder(body.names, (old, kind) => `${feature.id}/${kind}/inst(${i},${old})`),
      report: zeroReport(),
    });
  }
  const fused = fuseNamedTools(oc, feature.id, copies);
  body.shape = fused.shape;
  body.names = fused.names;
  body.volume = shapeVolume(oc, body.shape);
  warnOrphans(state, feature.id, fused.report);
}

function executeBoolean(oc: OpenCascadeInstance, feature: BooleanFeature, state: RegenState): void {
  const target = state.bodies.find((b) => b.id === feature.targetBodyId);
  const toolBody = state.bodies.find((b) => b.id === feature.toolBodyId);
  if (!target) throw new Error("Combine: target body not found");
  if (!toolBody) throw new Error("Combine: tool body not found");
  if (target === toolBody) throw new Error("Combine: target and tool must differ");

  const op =
    feature.op === "join"
      ? new oc.BRepAlgoAPI_Fuse_3(target.shape, toolBody.shape)
      : feature.op === "cut"
        ? new oc.BRepAlgoAPI_Cut_3(target.shape, toolBody.shape)
        : new oc.BRepAlgoAPI_Common_3(target.shape, toolBody.shape);
  op.Build();
  if (!op.IsDone()) throw new Error(`Combine ${feature.op} failed`);
  const shape = op.Shape();
  // Both parents' names feed the result — tool-body lineage survives into
  // the combined body (doc §3.4 boolean row).
  const targetInputs = namedInputs(oc, target.shape, target.names);
  const toolInputs = namedInputs(oc, toolBody.shape, toolBody.names);
  const { names, report } = nameFromHistory({
    oc,
    featureId: feature.id,
    newShape: shape,
    oldFaces: [...targetInputs.faces, ...toolInputs.faces],
    oldEdges: [...targetInputs.edges, ...toolInputs.edges],
    histories: [op],
  });
  target.shape = shape;
  target.names = names;
  target.volume = shapeVolume(oc, target.shape);
  warnOrphans(state, feature.id, report);
  // Tool body is consumed.
  state.bodies = state.bodies.filter((b) => b !== toolBody);
}

function executeMove(
  oc: OpenCascadeInstance,
  feature: MoveFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const body = state.bodies.find((b) => b.id === feature.bodyId);
  if (!body) throw new Error(`Move references missing body ${feature.bodyId}`);
  const tx = evaluateExpression(feature.tx, env);
  const ty = evaluateExpression(feature.ty, env);
  const tz = evaluateExpression(feature.tz, env);
  const angleDeg = evaluateExpression(feature.rotAngle, env);

  let shape = body.shape;
  if (angleDeg !== 0) {
    const dir = AXIS_DIRS[feature.rotAxis];
    const rot = new oc.gp_Trsf_1();
    rot.SetRotation_1(
      new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(dir[0], dir[1], dir[2])),
      (angleDeg * Math.PI) / 180,
    );
    shape = new oc.BRepBuilderAPI_Transform_2(shape, rot, false).Shape();
  }
  if (tx !== 0 || ty !== 0 || tz !== 0) {
    const tr = new oc.gp_Trsf_1();
    tr.SetTranslation_1(new oc.gp_Vec_4(tx, ty, tz));
    shape = new oc.BRepBuilderAPI_Transform_2(shape, tr, false).Shape();
  }
  body.shape = shape;
  // Transforms relocate without topology change: every name carries over
  // verbatim by explorer order (probe: order preserved, IsSame is not).
  body.volume = shapeVolume(oc, body.shape);
}

// ---------------------------------------------------------------- import

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function executeImportStep(
  oc: OpenCascadeInstance,
  feature: ImportStepFeature,
  state: RegenState,
): void {
  // NOTE: this OCCT build rejects FS paths > 10 chars (see exporters.ts).
  const path = "/i.step";
  oc.FS.writeFile(path, base64ToBytes(feature.dataB64));
  try {
    const reader = new oc.STEPControl_Reader_1();
    const stat = reader.ReadFile(path);
    const statVal = typeof stat === "number" ? stat : stat.value;
    if (statVal !== 1) throw new Error(`Could not read STEP file "${feature.fileName}"`);
    reader.TransferRoots();
    if (reader.NbShapes() === 0) throw new Error("STEP file contains no shapes");
    const shape = reader.OneShape();
    state.bodies.push({
      id: feature.id,
      shape,
      // No history exists for imports; names are exploration ordinals, which
      // are deterministic because the embedded STEP bytes are immutable.
      names: nameByOrdinal(oc, feature.id, shape, "imp"),
      volume: shapeVolume(oc, shape),
    });
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------- upgrade (v1 → v2)

/**
 * One-time document upgrade (doc §2.4): regenerate a v1 document with legacy
 * index semantics, capturing the topological name each index currently
 * denotes and rewriting the refs in place. Features whose legacy refs fail
 * to resolve stay un-migrated and carry an error status — never guessed.
 */
export function upgradeDocumentRefs(
  oc: OpenCascadeInstance,
  doc: CraftbitDocument,
): { doc: CraftbitDocument; failures: string[] } {
  const clone = JSON.parse(JSON.stringify(doc)) as CraftbitDocument;
  const state = regenerateDocument(oc, clone, { upgrade: true });
  clone.formatVersion = 2;
  const failures = Object.entries(state.statuses)
    .filter(([, s]) => s.level === "error")
    .map(([id]) => id);
  return { doc: clone, failures };
}
