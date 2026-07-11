/**
 * The Craftbit parametric document (spec §6, session-scoped subset).
 *
 * Numbers are stored in millimeters and degrees (spec §6.1). Every dimension
 * field is an expression string (spec §7.9) evaluated against the parameter
 * table at regeneration time.
 *
 * DELTA FROM SPEC (documented, deliberate): the sketch model here is
 * profile-based (closed shapes with expression-driven dimensions) rather than
 * the full constraint-solver sketcher of §7.6/§6.3 — PlaneGCS integration is
 * design gate D3 and lands later. Profiles still deliver the golden-path
 * workflows (GP-1, GP-2) with honest parametric regeneration.
 */

export const CRAFTBIT_FORMAT_VERSION = 1 as const;

export type Expr = string;

export type OriginPlaneName = "XY" | "XZ" | "YZ";

export type PlaneRef =
  | { kind: "origin"; plane: OriginPlaneName }
  | {
      /** A planar face of an existing body, identified by body + face index
       * as of the regeneration state just before this sketch's feature. */
      kind: "face";
      bodyId: string;
      faceIndex: number;
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

export interface SketchFeature {
  id: string;
  type: "sketch";
  name: string;
  suppressed: boolean;
  plane: PlaneRef;
  profiles: SketchProfile[];
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

export interface EdgeRef {
  bodyId: string;
  edgeIndex: number;
}

export interface FaceRef {
  bodyId: string;
  faceIndex: number;
}

export interface FilletFeature {
  id: string;
  type: "fillet";
  name: string;
  suppressed: boolean;
  edges: EdgeRef[];
  radius: Expr;
}

export interface ChamferFeature {
  id: string;
  type: "chamfer";
  name: string;
  suppressed: boolean;
  edges: EdgeRef[];
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
  faces: FaceRef[];
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
  formatVersion: typeof CRAFTBIT_FORMAT_VERSION;
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

/** Structural validation on load — throws with a readable message. */
export function validateDocument(doc: unknown): CraftbitDocument {
  if (typeof doc !== "object" || doc === null) throw new Error("Document is not an object");
  const d = doc as Record<string, unknown>;
  if (d.formatVersion !== CRAFTBIT_FORMAT_VERSION) {
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
