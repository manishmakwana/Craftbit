/**
 * Screen-space picking for constraint-sketcher entities (D3 §6): project
 * entity geometry through the caller-supplied world→screen projector and
 * pick by pixel distance — points first (8 px), then curves (6 px). More
 * predictable than 3D raycaster thresholds at glancing camera angles, and
 * pure so it unit-tests without WebGL.
 */

import type { SketchEntity } from "@craftbit/core";

export interface ScreenProjector {
  (x: number, y: number): { x: number; y: number; inFront: boolean };
}

const POINT_RADIUS_PX = 8;
const CURVE_RADIUS_PX = 6;

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface EntityPick {
  entityId: string;
  kind: SketchEntity["kind"];
}

export function pickSketchEntity(
  entities: readonly SketchEntity[],
  project: ScreenProjector,
  screenX: number,
  screenY: number,
): EntityPick | null {
  const points = new Map(
    entities
      .filter((e): e is Extract<SketchEntity, { kind: "point" }> => e.kind === "point")
      .map((e) => [e.id, e]),
  );
  const screenOf = (id: string): { x: number; y: number } | null => {
    const p = points.get(id);
    if (!p) return null;
    const s = project(p.x, p.y);
    return s.inFront ? s : null;
  };

  // Points win within their radius (they're the drag handles).
  let bestPoint: { id: string; d: number } | null = null;
  for (const e of entities) {
    if (e.kind !== "point") continue;
    const s = project(e.x, e.y);
    if (!s.inFront) continue;
    const d = Math.hypot(s.x - screenX, s.y - screenY);
    if (d <= POINT_RADIUS_PX && (!bestPoint || d < bestPoint.d)) bestPoint = { id: e.id, d };
  }
  if (bestPoint) return { entityId: bestPoint.id, kind: "point" };

  let bestCurve: { id: string; kind: SketchEntity["kind"]; d: number } | null = null;
  const consider = (id: string, kind: SketchEntity["kind"], d: number) => {
    if (d <= CURVE_RADIUS_PX && (!bestCurve || d < bestCurve.d)) bestCurve = { id, kind, d };
  };

  for (const e of entities) {
    if (e.kind === "line") {
      const a = screenOf(e.p1);
      const b = screenOf(e.p2);
      if (!a || !b) continue;
      consider(e.id, "line", distToSegment(screenX, screenY, a.x, a.y, b.x, b.y));
    } else if (e.kind === "circle") {
      const c = points.get(e.center);
      if (!c) continue;
      // Sample the circle in sketch space and measure against chords.
      let prev: { x: number; y: number } | null = null;
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const s = project(c.x + Math.cos(a) * e.radius, c.y + Math.sin(a) * e.radius);
        if (!s.inFront) {
          prev = null;
          continue;
        }
        if (prev)
          consider(e.id, "circle", distToSegment(screenX, screenY, prev.x, prev.y, s.x, s.y));
        prev = s;
      }
    } else if (e.kind === "arc") {
      const c = points.get(e.center);
      const st = points.get(e.start);
      const en = points.get(e.end);
      if (!c || !st || !en) continue;
      const r = Math.hypot(st.x - c.x, st.y - c.y);
      const a0 = Math.atan2(st.y - c.y, st.x - c.x);
      let a1 = Math.atan2(en.y - c.y, en.x - c.x);
      if (e.ccw && a1 <= a0) a1 += 2 * Math.PI;
      if (!e.ccw && a1 >= a0) a1 -= 2 * Math.PI;
      let prev: { x: number; y: number } | null = null;
      const steps = 32;
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const s = project(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
        if (!s.inFront) {
          prev = null;
          continue;
        }
        if (prev) consider(e.id, "arc", distToSegment(screenX, screenY, prev.x, prev.y, s.x, s.y));
        prev = s;
      }
    }
  }
  if (bestCurve !== null) {
    const found = bestCurve as { id: string; kind: SketchEntity["kind"] };
    return { entityId: found.id, kind: found.kind };
  }
  return null;
}
