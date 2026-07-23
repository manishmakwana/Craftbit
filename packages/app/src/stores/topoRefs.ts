/**
 * D2 bridge between transient pick selections (explorer indices, valid only
 * for the regen generation they were picked in) and durable document
 * references (topological names). Dialogs convert at commit time using the
 * name tables the worker ships with every regen result.
 */

import type { TopoRef } from "@craftbit/core";
import { useGeometryStore } from "./geometryStore";
import type { EdgeSel, FaceSel } from "./uiStore";

function nameFor(bodyId: string, kind: "face" | "edge", index: number): string | null {
  const body = useGeometryStore.getState().result?.bodies.find((b) => b.id === bodyId);
  const table = kind === "face" ? body?.faceNames : body?.edgeNames;
  return table?.[index] ?? null;
}

/** Converts mixed existing refs + fresh picks to TopoRefs; null when a pick
 * can't be named (stale regen result) — caller shows an error instead of
 * silently writing an unresolvable ref. */
export function toEdgeRefs(items: readonly (TopoRef | EdgeSel)[]): TopoRef[] | null {
  const out: TopoRef[] = [];
  for (const item of items) {
    if ("name" in item) {
      out.push(item);
      continue;
    }
    const name = nameFor(item.bodyId, "edge", item.edgeIndex);
    if (!name) return null;
    out.push({ bodyId: item.bodyId, name });
  }
  return out;
}

export function toFaceRefs(items: readonly (TopoRef | FaceSel)[]): TopoRef[] | null {
  const out: TopoRef[] = [];
  for (const item of items) {
    if ("name" in item) {
      out.push(item);
      continue;
    }
    const name = nameFor(item.bodyId, "face", item.faceIndex);
    if (!name) return null;
    out.push({ bodyId: item.bodyId, name });
  }
  return out;
}

export function faceSelToRef(sel: FaceSel): TopoRef | null {
  const name = nameFor(sel.bodyId, "face", sel.faceIndex);
  return name ? { bodyId: sel.bodyId, name } : null;
}
