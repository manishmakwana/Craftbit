/**
 * The Craftbit parametric document (spec §6, session-scoped subset).
 *
 * Numbers are stored in millimeters and degrees (spec §6.1). Every dimension
 * field is an expression string (spec §7.9) evaluated against the parameter
 * table at regeneration time.
 *
 * Sketches carry two coexisting models: quick profiles (rect/circle/polygon
 * with expression-driven dimensions) and the constraint sketcher of §7.6/§6.3
 * (design gate D3) — entities + constraints solved at regeneration (see
 * sketchSolver.ts and docs/design/D3-constraint-sketcher.md).
 */

import type { SketchEntity } from "./sketchSolver";

/**
 * v2 (design gate D2): geometry references store lineage-encoded topological
 * names ({ bodyId, name }) instead of enumeration indices. v1 documents are
 * accepted by the loader and upgraded once via the worker's upgrade regen
 * (index → name capture), then persist as v2.
 */
export const CRAFTBIT_FORMAT_VERSION = 2 as const;
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1, 2];

export type Expr = string;

export type OriginPlaneName = "XY" | "XZ" | "YZ";

/**
 * A stable reference to a face or edge of a body: `name` is a D2
 * lineage-encoded topological name minted by the geometry worker
 * (opaque to the app — stored, compared, never parsed outside the worker).
 */
export interface TopoRef {
  bodyId: string;
  name: string;
}

export type PlaneRef =
  | { kind: "origin"; plane: OriginPlaneName }
  | {
      /** A planar face of an existing body, by topological name. Legacy v1
       * documents carry `faceIndex` instead until the upgrade regen runs. */
      kind: "face";
      bodyId: string;
      name: string;
    };

export interface SketchProfileRect {
  id: string;
  kind: "rect";
  /** Corner position in sketch coords (mm expressions). */
  x: Expr;
  y: Expr;
  width: Expr;
  height: Expr;
}

export interface SketchProfileCircle {
  id: string;
  kind: "circle";
  cx: Expr;
  cy: Expr;
  radius: Expr;
}

export interface SketchProfilePolygon {
  id: string;
  kind: "polygon";
  /** Closed loop; last point connects back to first. Plain numbers (mm) —
   * drawn freehand, not dimension-driven. */
  points: { x: number; y: number }[];
}

export type SketchProfile = SketchProfileRect | SketchProfileCircle | SketchProfilePolygon;

/**
 * Constraint-sketcher additions (design gate D3). Entities are geometric
 * primitives with plain-number coordinates (last solved/drawn state, used as
 * the next solve's initial guess); constraints relate them declaratively and
 * dimensional constraint values are expressions. See
 * docs/design/D3-constraint-sketcher.md and sketchSolver.ts (which owns the
 * entity type definitions — coordinates there are already plain numbers, so
 * document and solver share them).
 */
/**
 * On-canvas placement of a dimension's line/label: an offset (sketch-local mm)
 * from the geometry the dimension is computed against. Display-only — the
 * solver ignores it. Set when the user places or drags a dimension.
 */
export interface DimPlacement {
  ox: number;
  oy: number;
}

export type SketchConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "horizontal"; line: string }
  | { id: string; kind: "vertical"; line: string }
  | { id: string; kind: "parallel"; a: string; b: string }
  | { id: string; kind: "perpendicular"; a: string; b: string }
  | { id: string; kind: "equalLength"; a: string; b: string }
  | { id: string; kind: "equalRadius"; a: string; b: string }
  | { id: string; kind: "distance"; a: string; b: string; value: Expr; place?: DimPlacement }
  | {
      /** Perpendicular distance between two (parallel) lines. */
      id: string;
      kind: "lineDistance";
      a: string;
      b: string;
      value: Expr;
      place?: DimPlacement;
    }
  | { id: string; kind: "radius"; entity: string; value: Expr; place?: DimPlacement }
  | { id: string; kind: "diameter"; entity: string; value: Expr; place?: DimPlacement }
  | {
      id: string;
      kind: "angle";
      a: string;
      b: string;
      /** degrees */ value: Expr;
      place?: DimPlacement;
    }
  | { id: string; kind: "tangent"; line: string; circle: string }
  | { id: string; kind: "fixed"; point: string };

export interface SketchFeature {
  id: string;
  type: "sketch";
  name: string;
  suppressed: boolean;
  plane: PlaneRef;
  profiles: SketchProfile[];
  /** Constraint-sketcher entities; absent in pre-D3 documents. */
  entities?: SketchEntity[];
  /** Constraints over `entities`; absent in pre-D3 documents. */
  constraints?: SketchConstraint[];
}

export type ExtrudeOp = "new" | "join" | "cut";

export interface ExtrudeFeature {
  id: string;
  type: "extrude";
  name: string;
  suppressed: boolean;
  sketchId: string;
  /** Profile ids used; empty = all profiles in the sketch. */
  profileIds: string[];
  distance: Expr;
  /** Extrude along +normal, -normal, or both symmetric. */
  direction: "normal" | "reversed" | "symmetric";
  operation: ExtrudeOp;
}

/** Legacy v1 index-based refs — accepted only by the one-time upgrade regen. */
export interface LegacyEdgeRef {
  bodyId: string;
  edgeIndex: number;
}
export interface LegacyFaceRef {
  bodyId: string;
  faceIndex: number;
}

export interface FilletFeature {
  id: string;
  type: "fillet";
  name: string;
  suppressed: boolean;
  edges: TopoRef[];
  radius: Expr;
}

export interface ChamferFeature {
  id: string;
  type: "chamfer";
  name: string;
  suppressed: boolean;
  edges: TopoRef[];
  distance: Expr;
}

export interface RevolveFeature {
  id: string;
  type: "revolve";
  name: string;
  suppressed: boolean;
  sketchId: string;
  profileIds: string[];
  /** Revolution axis: the sketch plane's local X or Y axis through its origin. */
  axis: "x" | "y";
  /** Angle in degrees (expression); 360 = full revolution. */
  angle: Expr;
  operation: ExtrudeOp;
}

export interface ShellFeature {
  id: string;
  type: "shell";
  name: string;
  suppressed: boolean;
  /** Faces to remove (open sides); all must belong to the same body. */
  faces: TopoRef[];
  thickness: Expr;
}

export interface MirrorFeature {
  id: string;
  type: "mirror";
  name: string;
  suppressed: boolean;
  bodyId: string;
  /** Mirror plane through the origin. */
  plane: OriginPlaneName;
  /** true: fuse the mirrored copy into the source body; false: new body. */
  merge: boolean;
}

export interface LinearPatternFeature {
  id: string;
  type: "linearPattern";
  name: string;
  suppressed: boolean;
  bodyId: string;
  direction: "x" | "y" | "z";
  spacing: Expr;
  count: Expr;
}

export interface CircularPatternFeature {
  id: string;
  type: "circularPattern";
  name: string;
  suppressed: boolean;
  bodyId: string;
  /** Rotation axis through the origin. */
  axis: "x" | "y" | "z";
  count: Expr;
}

export interface BooleanFeature {
  id: string;
  type: "boolean";
  name: string;
  suppressed: boolean;
  targetBodyId: string;
  toolBodyId: string;
  op: "join" | "cut" | "intersect";
}

/** Assembly positioning: translate/rotate a body (spec §7.7.12 Move/Copy). */
export interface MoveFeature {
  id: string;
  type: "move";
  name: string;
  suppressed: boolean;
  bodyId: string;
  tx: Expr;
  ty: Expr;
  tz: Expr;
  rotAxis: "x" | "y" | "z";
  /** Degrees (expression); rotation about the axis through the origin, applied before translation. */
  rotAngle: Expr;
}

/**
 * Assembly joint (spec §7.10, design gate D6): closed-form placement of one
 * body onto another via mate frames derived from a planar face or circular
 * edge on each side. Static positioning in v1; the type + limits determine
 * the drag DOFs when the M7 assembly UI ships.
 */
export interface JointRef {
  bodyId: string;
  kind: "face" | "edge";
  /** D2 lineage-encoded topological name (same rules as TopoRef). */
  name: string;
}

export interface JointFeature {
  id: string;
  type: "joint";
  name: string;
  suppressed: boolean;
  jointType: "rigid" | "revolute" | "slider" | "cylindrical";
  /** The body that moves into place. */
  movingRef: JointRef;
  /** The stationary side; its body is not moved by this joint. */
  targetRef: JointRef;
  /** Offset along the joint z axis (mm expression). */
  offset: Expr;
  /** Rotation about the joint z axis (degrees expression). */
  angle: Expr;
  /** Align moving z with target z instead of the default anti-aligned mate. */
  flip: boolean;
  /** Motion limits for the drag solve; placement itself is exact. */
  limits?: { minOffset?: Expr; maxOffset?: Expr; minAngle?: Expr; maxAngle?: Expr };
}

/** Imported STEP solid, file bytes embedded in the document (base64). */
export interface ImportStepFeature {
  id: string;
  type: "importStep";
  name: string;
  suppressed: boolean;
  fileName: string;
  dataB64: string;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | MirrorFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | BooleanFeature
  | MoveFeature
  | JointFeature
  | ImportStepFeature;

export const FEATURE_TYPES: readonly Feature["type"][] = [
  "sketch",
  "extrude",
  "revolve",
  "fillet",
  "chamfer",
  "shell",
  "mirror",
  "linearPattern",
  "circularPattern",
  "boolean",
  "move",
  "joint",
  "importStep",
] as const;

export interface Parameter {
  id: string;
  name: string;
  expression: Expr;
  comment?: string;
}

export type DisplayUnit = "mm" | "cm" | "m" | "in";

export interface CraftbitDocument {
  /** 2 for current documents; 1 only transiently, until the upgrade regen. */
  formatVersion: number;
  id: string;
  name: string;
  units: DisplayUnit;
  parameters: Parameter[];
  features: Feature[];
  /** Per-body display colors keyed by body id (hex like "#8ab4f8"). */
  bodyColors: Record<string, string>;
}

export function createEmptyDocument(id: string, name: string): CraftbitDocument {
  return {
    formatVersion: CRAFTBIT_FORMAT_VERSION,
    id,
    name,
    units: "mm",
    parameters: [],
    features: [],
    bodyColors: {},
  };
}

/** Structural validation on load — throws with a readable message. v1
 * documents are accepted (the app upgrades them once via the worker). */
export function validateDocument(doc: unknown): CraftbitDocument {
  if (typeof doc !== "object" || doc === null) throw new Error("Document is not an object");
  const d = doc as Record<string, unknown>;
  if (!SUPPORTED_FORMAT_VERSIONS.includes(d.formatVersion as number)) {
    throw new Error(`Unsupported format version ${String(d.formatVersion)}`);
  }
  if (typeof d.id !== "string" || typeof d.name !== "string") {
    throw new Error("Document missing id/name");
  }
  if (!Array.isArray(d.parameters) || !Array.isArray(d.features)) {
    throw new Error("Document missing parameters/features arrays");
  }
  for (const f of d.features as { type?: string; id?: string }[]) {
    if (!f || typeof f.id !== "string") throw new Error("Feature missing id");
    if (!FEATURE_TYPES.includes(f.type as Feature["type"])) {
      throw new Error(`Unknown feature type "${String(f.type)}"`);
    }
  }
  return doc as CraftbitDocument;
}

export function serializeDocument(doc: CraftbitDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function deserializeDocument(json: string): CraftbitDocument {
  return validateDocument(JSON.parse(json));
}

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isValidParameterName(name: string): boolean {
  return PARAM_NAME_RE.test(name) && name !== "pi";
}

export function newId(): string {
  // uuid v4 via crypto where available; fallback for older test envs.
  // (core targets no DOM lib, so reach crypto via an untyped global lookup)
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
