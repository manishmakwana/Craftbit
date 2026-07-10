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

export interface FilletFeature {
  id: string;
  type: "fillet";
  name: string;
  suppressed: boolean;
  edges: EdgeRef[];
  radius: Expr;
  /** false = chamfer-style not supported yet; fillet only. */
}

export type Feature = SketchFeature | ExtrudeFeature | FilletFeature;

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
    if (f.type !== "sketch" && f.type !== "extrude" && f.type !== "fillet") {
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
