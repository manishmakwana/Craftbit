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
 * KNOWN LIMITATION (documented; real fix is design gate D2, spec §12.1):
 * downstream references are (bodyId, face/edge index in current enumeration
 * order), not stable topological names. Editing an upstream feature can shift
 * indices; the referencing feature then errors or attaches differently.
 */

import {
  ExprError,
  evaluateExpression,
  evaluateParameters,
  type CraftbitDocument,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
  type PlaneRef,
  type SketchFeature,
  type SketchProfile,
} from "@craftbit/core";
import type {
  GpDir,
  GpPnt,
  OpenCascadeInstance,
  TopoDsEdge,
  TopoDsFace,
  TopoDsShape,
  TopoDsWire,
} from "./occt-types";

export interface FeatureStatus {
  level: "ok" | "error";
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
  | { id: string; kind: "polygon"; points: { x: number; y: number }[] };

export interface EvaluatedSketch {
  featureId: string;
  plane: ResolvedPlane;
  profiles: EvaluatedProfile[];
}

export interface RegenBody {
  id: string;
  shape: TopoDsShape;
  volume: number;
}

export interface RegenState {
  bodies: RegenBody[];
  sketches: EvaluatedSketch[];
  statuses: Record<string, FeatureStatus>;
  parameterValues: Record<string, number>;
  parameterError?: string;
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

export function regenerateDocument(oc: OpenCascadeInstance, doc: CraftbitDocument): RegenState {
  const state: RegenState = {
    bodies: [],
    sketches: [],
    statuses: {},
    parameterValues: {},
  };

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
    case "fillet":
      executeFillet(oc, feature, state, env);
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
  const face = faces[ref.faceIndex];
  if (!face) throw new Error(`Sketch plane references missing face #${ref.faceIndex}`);

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
  const profiles = feature.profiles.map((p) => evaluateProfile(p, env));
  state.sketches.push({ featureId: feature.id, plane, profiles });
}

// ---------------------------------------------------------------- extrude

/** 2D point-in-profile test used for hole nesting. */
function profileContains(p: EvaluatedProfile, x: number, y: number): boolean {
  switch (p.kind) {
    case "rect":
      return x > p.x && x < p.x + p.width && y > p.y && y < p.y + p.height;
    case "circle":
      return (x - p.cx) ** 2 + (y - p.cy) ** 2 < p.radius ** 2;
    case "polygon": {
      let inside = false;
      const pts = p.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!;
        const b = pts[j]!;
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
      return inside;
    }
  }
}

function profileInnerPoint(p: EvaluatedProfile): { x: number; y: number } {
  switch (p.kind) {
    case "rect":
      return { x: p.x + p.width / 2, y: p.y + p.height / 2 };
    case "circle":
      return { x: p.cx, y: p.cy };
    case "polygon": {
      // Centroid works for convex-ish freehand shapes; adequate here.
      let sx = 0;
      let sy = 0;
      for (const pt of p.points) {
        sx += pt.x;
        sy += pt.y;
      }
      return { x: sx / p.points.length, y: sy / p.points.length };
    }
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

function profileWire(
  oc: OpenCascadeInstance,
  profile: EvaluatedProfile,
  map: PlaneMapper,
): TopoDsWire {
  if (profile.kind === "circle") {
    const ax = new oc.gp_Ax2_2(map.point(profile.cx, profile.cy), map.normalDir(), map.xDir());
    const edge = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, profile.radius)).Edge();
    return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
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
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i]!;
    const b = pts2d[(i + 1) % pts2d.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    maker.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(map.point(a.x, a.y), map.point(b.x, b.y)).Edge());
  }
  return maker.Wire();
}

function profileArea(p: EvaluatedProfile): number {
  switch (p.kind) {
    case "rect":
      return p.width * p.height;
    case "circle":
      return Math.PI * p.radius ** 2;
    case "polygon":
      return Math.abs(signedArea(p.points));
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

function buildProfileFaces(
  oc: OpenCascadeInstance,
  sketch: EvaluatedSketch,
  profileIds: string[],
): TopoDsFace[] {
  const selected =
    profileIds.length === 0
      ? sketch.profiles
      : sketch.profiles.filter((p) => profileIds.includes(p.id));
  if (selected.length === 0) throw new Error("No profiles selected for extrude");
  const map = planeMapper(oc, sketch.plane);
  return groupProfiles(selected).map(({ outer, holes }) => {
    const fm = new oc.BRepBuilderAPI_MakeFace_15(profileWire(oc, outer, map), true);
    for (const hole of holes) {
      fm.Add(oc.TopoDS.Wire_1(profileWire(oc, hole, map).Reversed()));
    }
    return fm.Face();
  });
}

function shapeVolume(oc: OpenCascadeInstance, shape: TopoDsShape): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  return props.Mass();
}

function fuseAll(oc: OpenCascadeInstance, shapes: TopoDsShape[]): TopoDsShape {
  let acc = shapes[0]!;
  for (let i = 1; i < shapes.length; i++) {
    const fuse = new oc.BRepAlgoAPI_Fuse_3(acc, shapes[i]!);
    fuse.Build();
    if (!fuse.IsDone()) throw new Error("Boolean fuse failed");
    acc = fuse.Shape();
  }
  return acc;
}

function intersects(oc: OpenCascadeInstance, a: TopoDsShape, b: TopoDsShape): boolean {
  const common = new oc.BRepAlgoAPI_Common_3(a, b);
  common.Build();
  if (!common.IsDone()) return false;
  return Math.abs(shapeVolume(oc, common.Shape())) > 1e-9;
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

  const faces = buildProfileFaces(oc, sketch, feature.profileIds);
  const n = sketch.plane.normal;

  const makeTool = (
    vec: [number, number, number],
    shift: [number, number, number],
  ): TopoDsShape => {
    // shift is applied by rebuilding the sketch plane origin — used for symmetric.
    const shifted: EvaluatedSketch = {
      ...sketch,
      plane: { ...sketch.plane, origin: ADD(sketch.plane.origin, shift) },
    };
    const shiftedFaces =
      shift[0] === 0 && shift[1] === 0 && shift[2] === 0
        ? faces
        : buildProfileFaces(oc, shifted, feature.profileIds);
    const prisms = shiftedFaces.map((f) =>
      new oc.BRepPrimAPI_MakePrism_1(
        f,
        new oc.gp_Vec_4(vec[0], vec[1], vec[2]),
        false,
        true,
      ).Shape(),
    );
    return fuseAll(oc, prisms);
  };

  let tool: TopoDsShape;
  if (feature.direction === "normal") tool = makeTool(V(n, distance), [0, 0, 0]);
  else if (feature.direction === "reversed") tool = makeTool(V(n, -distance), [0, 0, 0]);
  else tool = makeTool(V(n, distance), V(n, -distance / 2));

  switch (feature.operation) {
    case "new": {
      state.bodies.push({ id: feature.id, shape: tool, volume: shapeVolume(oc, tool) });
      break;
    }
    case "join": {
      const target = state.bodies.find((b) => intersects(oc, b.shape, tool));
      if (!target) {
        // Nothing to join with — behave like a new body (Fusion does the same).
        state.bodies.push({ id: feature.id, shape: tool, volume: shapeVolume(oc, tool) });
        break;
      }
      const fuse = new oc.BRepAlgoAPI_Fuse_3(target.shape, tool);
      fuse.Build();
      if (!fuse.IsDone()) throw new Error("Join failed");
      target.shape = fuse.Shape();
      target.volume = shapeVolume(oc, target.shape);
      break;
    }
    case "cut": {
      if (state.bodies.length === 0) throw new Error("Nothing to cut — no bodies yet");
      let cutAny = false;
      for (const body of state.bodies) {
        if (!intersects(oc, body.shape, tool)) continue;
        const cut = new oc.BRepAlgoAPI_Cut_3(body.shape, tool);
        cut.Build();
        if (!cut.IsDone()) throw new Error("Cut failed");
        body.shape = cut.Shape();
        body.volume = shapeVolume(oc, body.shape);
        cutAny = true;
      }
      if (!cutAny) throw new Error("Cut tool does not intersect any body");
      break;
    }
  }
}

// ---------------------------------------------------------------- fillet

export function collectFaces(oc: OpenCascadeInstance, shape: TopoDsShape): TopoDsFace[] {
  const faces: TopoDsFace[] = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  while (exp.More()) {
    faces.push(oc.TopoDS.Face_1(exp.Current()));
    exp.Next();
  }
  return faces;
}

export function collectUniqueEdges(oc: OpenCascadeInstance, shape: TopoDsShape): TopoDsEdge[] {
  const edges: TopoDsEdge[] = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  while (exp.More()) {
    const e = exp.Current();
    if (!edges.some((u) => u.IsSame(e))) edges.push(oc.TopoDS.Edge_1(e));
    exp.Next();
  }
  return edges;
}

function executeFillet(
  oc: OpenCascadeInstance,
  feature: FilletFeature,
  state: RegenState,
  env: (name: string) => number,
): void {
  const radius = evaluateExpression(feature.radius, env);
  if (radius <= 0) throw new Error("Fillet radius must be > 0");
  if (feature.edges.length === 0) throw new Error("Fillet has no edges selected");

  const byBody = new Map<string, number[]>();
  for (const ref of feature.edges) {
    const list = byBody.get(ref.bodyId) ?? [];
    list.push(ref.edgeIndex);
    byBody.set(ref.bodyId, list);
  }

  for (const [bodyId, edgeIndices] of byBody) {
    const body = state.bodies.find((b) => b.id === bodyId);
    if (!body) throw new Error(`Fillet references missing body ${bodyId}`);
    const edges = collectUniqueEdges(oc, body.shape);
    const fillet = new oc.BRepFilletAPI_MakeFillet(
      body.shape,
      oc.ChFi3d_FilletShape.ChFi3d_Rational,
    );
    for (const index of edgeIndices) {
      const edge = edges[index];
      if (!edge) throw new Error(`Fillet references missing edge #${index}`);
      fillet.Add_2(radius, edge);
    }
    fillet.Build();
    if (!fillet.IsDone()) {
      throw new Error(`Fillet failed — radius ${radius} may exceed adjacent face size`);
    }
    body.shape = fillet.Shape();
    body.volume = shapeVolume(oc, body.shape);
  }
}
