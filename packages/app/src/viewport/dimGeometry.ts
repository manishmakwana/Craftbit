/**
 * Pure geometry for on-canvas dimensions (Fusion-style drafting). Produces the
 * witness lines, dimension line/arc, arrowhead anchors and label position for a
 * dimension — in sketch-local coordinates — from the solved sketch entities.
 *
 * The same function feeds both the live preview while placing a dimension and
 * the committed dimension render, so the two look identical. Screen projection,
 * arrowhead sizing and hit-testing live in the React overlay; this module is
 * unit-testable without a DOM.
 */

import type { DimPlacement, SketchEntity } from "@craftbit/core";

export type DimSpec =
  | { kind: "distance"; a: string; b: string; place?: DimPlacement }
  | { kind: "lineDistance"; a: string; b: string; place?: DimPlacement }
  | { kind: "angle"; a: string; b: string; place?: DimPlacement }
  | { kind: "radius"; entity: string; place?: DimPlacement }
  | { kind: "diameter"; entity: string; place?: DimPlacement };

export interface Pt {
  x: number;
  y: number;
}

export interface DimGeometry {
  /** Measured value: mm for linear/radial, degrees for angle. For angles this
   * is the (positive) angle of the sector the label sits in — interior or
   * exterior depending on placement. */
  value: number;
  unit: "mm" | "deg";
  /** Angle dims only: the signed inter-line angle (deg) the solver targets —
   * independent of which sector the label is placed in. */
  signedAngle?: number;
  /** Witness/extension lines from the geometry out to the dimension line. */
  witness: [Pt, Pt][];
  /** Straight dimension-line segments (linear/radial dims). */
  lines: [Pt, Pt][];
  /** Circular dimension line (angle dims): center + radius + start/end angle (rad). */
  arc: { c: Pt; r: number; a0: number; a1: number } | null;
  /** Arrowhead anchors: tip position + unit direction the arrow points. */
  arrows: { at: Pt; dir: Pt }[];
  /** Where the value label sits. */
  label: Pt;
  /** Reference point placement is measured from (for computing `place` from a cursor). */
  ref: Pt;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const norm = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;

export type EntityMap = Map<string, SketchEntity>;

function pointOf(map: EntityMap, id: string): Pt | null {
  const e = map.get(id);
  return e && e.kind === "point" ? { x: e.x, y: e.y } : null;
}

function lineEnds(map: EntityMap, id: string): [Pt, Pt] | null {
  const e = map.get(id);
  if (!e || e.kind !== "line") return null;
  const p1 = pointOf(map, e.p1);
  const p2 = pointOf(map, e.p2);
  return p1 && p2 ? [p1, p2] : null;
}

function radiusOf(map: EntityMap, id: string): { c: Pt; r: number } | null {
  const e = map.get(id);
  if (!e) return null;
  if (e.kind === "circle") {
    const c = pointOf(map, e.center);
    return c ? { c, r: e.radius } : null;
  }
  if (e.kind === "arc") {
    const c = pointOf(map, e.center);
    const s = pointOf(map, e.start);
    return c && s ? { c, r: len(sub(s, c)) } : null;
  }
  return null;
}

/** Perpendicular (rotate +90°). */
const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });

/** Linear dimension between two points, offset by `place` (perpendicular component honored). */
function linear(a: Pt, b: Pt, place: DimPlacement | undefined): DimGeometry {
  const mid = scale(add(a, b), 0.5);
  const dir = norm(sub(b, a));
  const n = perp(dir);
  // Offset the dimension line by the perpendicular component of `place`
  // (dragging along the segment shouldn't move the line, matching CAD tools).
  const off = place ? dot({ x: place.ox, y: place.oy }, n) : 8;
  const shift = scale(n, off);
  const a2 = add(a, shift);
  const b2 = add(b, shift);
  return {
    value: len(sub(b, a)),
    unit: "mm",
    witness: [
      [a, a2],
      [b, b2],
    ],
    lines: [[a2, b2]],
    arc: null,
    arrows: [
      { at: a2, dir: dir },
      { at: b2, dir: scale(dir, -1) },
    ],
    label: add(mid, shift),
    ref: mid,
  };
}

/** Perpendicular distance between two (parallel) lines, dimensioned at `place`. */
function betweenLines(a: [Pt, Pt], b: [Pt, Pt], place: DimPlacement | undefined): DimGeometry {
  const dir = norm(sub(a[1], a[0]));
  const n = perp(dir);
  // Project b's first endpoint onto a's normal to get the gap.
  const gap = dot(sub(b[0], a[0]), n);
  // A point on each line closest to the label anchor.
  const anchor = place
    ? { x: a[0].x + place.ox, y: a[0].y + place.oy }
    : scale(add(a[0], b[0]), 0.5);
  const tA = dot(sub(anchor, a[0]), dir);
  const pA = add(a[0], scale(dir, tA));
  const pB = add(pA, scale(n, gap));
  const mid = scale(add(pA, pB), 0.5);
  return {
    value: Math.abs(gap),
    unit: "mm",
    witness: [],
    lines: [[pA, pB]],
    arc: null,
    arrows: [
      { at: pA, dir: gap >= 0 ? n : scale(n, -1) },
      { at: pB, dir: gap >= 0 ? scale(n, -1) : n },
    ],
    label: mid,
    ref: mid,
  };
}

/** Intersection of two infinite lines; null when parallel. */
function intersect(a: [Pt, Pt], b: [Pt, Pt]): Pt | null {
  const d1 = sub(a[1], a[0]);
  const d2 = sub(b[1], b[0]);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b[0].x - a[0].x) * d2.y - (b[0].y - a[0].y) * d2.x) / denom;
  return add(a[0], scale(d1, t));
}

function angleDim(a: [Pt, Pt], b: [Pt, Pt], place: DimPlacement | undefined): DimGeometry {
  const v = intersect(a, b) ?? scale(add(a[0], b[0]), 0.5);
  const da = norm(sub(a[1], a[0]));
  const db = norm(sub(b[1], b[0]));
  // The signed inter-line angle the solver drives (independent of placement).
  const signed = (Math.atan2(da.x * db.y - da.y * db.x, da.x * db.x + da.y * db.y) * 180) / Math.PI;
  // The two lines emit four rays from the vertex, splitting the plane into four
  // sectors. The cursor lands in one of them — the arc must span exactly that
  // sector (bounded by the two rays bracketing the cursor angle), so the
  // dimension reads the interior angle or its supplement depending on where
  // it's dropped. Default to the +da/+db bisector when unplaced.
  const TAU = 2 * Math.PI;
  const mod2 = (x: number) => ((x % TAU) + TAU) % TAU;
  const cur =
    place && len({ x: place.ox, y: place.oy }) > 1e-6 ? { x: place.ox, y: place.oy } : add(da, db);
  const tc = mod2(Math.atan2(cur.y, cur.x));
  const pa = Math.atan2(da.y, da.x);
  const pb = Math.atan2(db.y, db.x);
  const rays = [pa, pa + Math.PI, pb, pb + Math.PI].map(mod2).sort((x, y) => x - y);
  // Bracket the cursor angle: the sector [a0, a1] with a0 ≤ tc < a1 (cyclic).
  let a0 = rays[3]! - TAU;
  let a1 = rays[0]!;
  for (let i = 0; i < 4; i++) {
    const lo = rays[i]!;
    const hi = i < 3 ? rays[i + 1]! : rays[0]! + TAU;
    if (hi - lo > 1e-9 && tc >= lo && tc < hi) {
      a0 = lo;
      a1 = hi;
      break;
    }
  }
  const sweep = a1 - a0;
  const r = place ? Math.max(6, len({ x: place.ox, y: place.oy })) : 14;
  const mAng = a0 + sweep / 2;
  const arcMid = add(v, { x: Math.cos(mAng) * r, y: Math.sin(mAng) * r });
  const end0 = add(v, { x: Math.cos(a0) * r, y: Math.sin(a0) * r });
  const end1 = add(v, { x: Math.cos(a1) * r, y: Math.sin(a1) * r });
  // Arrow directions tangent to the arc at each end.
  const tan0 = { x: -Math.sin(a0), y: Math.cos(a0) };
  const tan1 = { x: -Math.sin(a1), y: Math.cos(a1) };
  const s = Math.sign(sweep) || 1;
  return {
    value: Math.abs((sweep * 180) / Math.PI),
    unit: "deg",
    signedAngle: signed,
    witness: [
      [v, end0],
      [v, end1],
    ],
    lines: [],
    arc: { c: v, r, a0, a1 },
    arrows: [
      { at: end0, dir: scale(tan0, s) },
      { at: end1, dir: scale(tan1, -s) },
    ],
    label: arcMid,
    ref: v,
  };
}

function radial(c: Pt, r: number, place: DimPlacement | undefined, diameter: boolean): DimGeometry {
  const dir =
    place && len({ x: place.ox, y: place.oy }) > 1e-6
      ? norm({ x: place.ox, y: place.oy })
      : { x: 0.7071, y: 0.7071 };
  const rim = add(c, scale(dir, r));
  if (diameter) {
    const rim2 = add(c, scale(dir, -r));
    return {
      value: 2 * r,
      unit: "mm",
      witness: [],
      lines: [[rim2, rim]],
      arc: null,
      arrows: [
        { at: rim, dir: scale(dir, -1) },
        { at: rim2, dir },
      ],
      label: add(c, scale(dir, r * 0.5)),
      ref: c,
    };
  }
  return {
    value: r,
    unit: "mm",
    witness: [],
    lines: [[c, rim]],
    arc: null,
    arrows: [{ at: rim, dir: scale(dir, -1) }],
    label: add(c, scale(dir, r * 0.6)),
    ref: c,
  };
}

/** Builds the drafting geometry for a dimension spec, or null if refs are missing. */
export function dimGeometry(spec: DimSpec, map: EntityMap): DimGeometry | null {
  switch (spec.kind) {
    case "distance": {
      const a = pointOf(map, spec.a);
      const b = pointOf(map, spec.b);
      return a && b ? linear(a, b, spec.place) : null;
    }
    case "lineDistance": {
      const a = lineEnds(map, spec.a);
      const b = lineEnds(map, spec.b);
      return a && b ? betweenLines(a, b, spec.place) : null;
    }
    case "angle": {
      const a = lineEnds(map, spec.a);
      const b = lineEnds(map, spec.b);
      return a && b ? angleDim(a, b, spec.place) : null;
    }
    case "radius":
    case "diameter": {
      const rc = radiusOf(map, spec.entity);
      return rc ? radial(rc.c, rc.r, spec.place, spec.kind === "diameter") : null;
    }
  }
}
