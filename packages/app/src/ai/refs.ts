/**
 * Turns the Copilot's high-level face/edge *selectors* ("the top face", "all
 * vertical edges", "the edges near [10,0,20]") into concrete D2 topological
 * references, using the geometry worker's `analyze` output (ai/execute.ts calls
 * this before appending fillet/chamfer/shell/face-sketch features). Selectors
 * are the AI's language for geometry it can't see; the worker's FaceInfo/
 * EdgeInfo carry the authoritative frame (matching resolvePlane), so face-
 * relative sketches land correctly.
 */

import type { BodyAnalysis, EdgeInfo, FaceInfo } from "@craftbit/geometry-worker";

export type FaceDir = "top" | "bottom" | "left" | "right" | "front" | "back";
export type EdgeWhich = "all" | "vertical" | "horizontal" | "top" | "bottom";

/** Outward-normal direction for each named face side (Z up). */
export const FACE_DIRS: Record<FaceDir, [number, number, number]> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  back: [0, 1, 0],
  front: [0, -1, 0],
};

export interface FaceSelector {
  bodyId: string;
  /** Which side of the body, by outward normal. */
  dir?: FaceDir;
  /** World point; picks the face whose centroid is nearest. Overrides dir. */
  near?: [number, number, number];
}

export interface EdgeSelector {
  bodyId: string;
  /** Edge group; defaults to "all". */
  which?: EdgeWhich;
  /** World point; picks the single nearest edge. Overrides which. */
  near?: [number, number, number];
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

const dist2 = (a: readonly number[], b: readonly number[]): number =>
  (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

/** Resolves a face selector to exactly one planar face, or throws. */
export function resolveFace(body: BodyAnalysis, sel: FaceSelector): FaceInfo {
  const planar = body.faces.filter((f) => f.planar);
  if (planar.length === 0) throw new Error(`body ${body.id} has no planar faces`);

  if (sel.near) {
    const near = sel.near;
    return [...planar].sort((a, b) => dist2(a.centroid, near) - dist2(b.centroid, near))[0]!;
  }

  if (sel.dir) {
    const d = FACE_DIRS[sel.dir];
    const facing = planar.filter((f) => dot(f.normal, d) > 0.9);
    if (facing.length === 0) throw new Error(`no ${sel.dir} face on body ${body.id}`);
    // Among parallel faces (e.g. both caps), take the one furthest along dir.
    return facing.sort((a, b) => dot(b.centroid, d) - dot(a.centroid, d))[0]!;
  }

  // No dir/near: the largest face is the most useful default.
  return [...planar].sort((a, b) => b.area - a.area)[0]!;
}

/** Resolves an edge selector to the matching edges (may be many), or throws
 * if nothing matches. */
export function resolveEdges(body: BodyAnalysis, sel: EdgeSelector): EdgeInfo[] {
  const edges = body.edges;
  if (edges.length === 0) throw new Error(`body ${body.id} has no edges`);

  if (sel.near) {
    const near = sel.near;
    return [[...edges].sort((a, b) => dist2(a.midpoint, near) - dist2(b.midpoint, near))[0]!];
  }

  const which = sel.which ?? "all";
  if (which === "all") return edges;

  const straight = edges.filter((e) => e.straight);
  if (which === "vertical") {
    return required(
      straight.filter((e) => Math.abs(e.dir[2]) > 0.9),
      "vertical edges",
    );
  }
  const horizontal = straight.filter((e) => Math.abs(e.dir[2]) < 0.1);
  if (which === "horizontal") return required(horizontal, "horizontal edges");

  // top/bottom: horizontal edges sitting at the highest/lowest Z band.
  const zs = horizontal.map((e) => e.midpoint[2]);
  if (zs.length === 0) throw new Error(`no ${which} edges on body ${body.id}`);
  const target = which === "top" ? Math.max(...zs) : Math.min(...zs);
  const range = Math.max(...zs) - Math.min(...zs);
  const tol = Math.max(0.01, range * 0.001);
  return required(
    horizontal.filter((e) => Math.abs(e.midpoint[2] - target) <= tol),
    `${which} edges`,
  );
}

function required<T>(items: T[], label: string): T[] {
  if (items.length === 0) throw new Error(`no ${label} found`);
  return items;
}

/** Face-local (u,v) of a world point on the face's plane — used to offset a
 * face-relative sketch so its (0,0) sits at the face centroid. */
export function toFaceLocal(
  face: FaceInfo,
  world: readonly [number, number, number],
): { u: number; v: number } {
  if (!face.origin || !face.xdir || !face.ydir) {
    throw new Error("face has no plane frame (non-planar)");
  }
  const rel: [number, number, number] = [
    world[0] - face.origin[0],
    world[1] - face.origin[1],
    world[2] - face.origin[2],
  ];
  return { u: dot(rel, face.xdir), v: dot(rel, face.ydir) };
}
