/**
 * Executes one Copilot tool call against the live document. Each tool builds a
 * Feature (or parameter) and dispatches the same command the UI uses, then
 * waits for the next regeneration so it can report the real result (body
 * volume, or a loud error) straight back to the model. Because everything goes
 * through dispatch, the model's work is normal, undoable timeline history.
 */

import {
  newId,
  type CraftbitDocument,
  type Feature,
  type Parameter,
  type SketchProfile,
} from "@craftbit/core";
import type { RegenResult } from "@craftbit/geometry-worker";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";

export interface ToolResult {
  text: string;
  ok: boolean;
}

/** Resolves when the geometry store lands a regen result newer than `after`,
 * or after a timeout (so a hung kernel can't wedge the agent loop). */
function waitForRegen(after: number, timeoutMs = 15000): Promise<RegenResult | null> {
  const store = useGeometryStore;
  if ((store.getState().result?.generation ?? -1) > after && !store.getState().regenerating) {
    return Promise.resolve(store.getState().result);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(store.getState().result);
    }, timeoutMs);
    const unsub = store.subscribe((s) => {
      if ((s.result?.generation ?? -1) > after && !s.regenerating) {
        clearTimeout(timer);
        unsub();
        resolve(s.result);
      }
    });
  });
}

const str = (v: unknown, fallback = "0"): string =>
  v === undefined || v === null ? fallback : String(v);

function toProfiles(raw: unknown): SketchProfile[] {
  if (!Array.isArray(raw)) throw new Error("profiles must be an array");
  return raw.map((p: Record<string, unknown>): SketchProfile => {
    const id = newId();
    if (p.kind === "rect") {
      return {
        id,
        kind: "rect",
        x: str(p.x),
        y: str(p.y),
        width: str(p.width, "10"),
        height: str(p.height, "10"),
      };
    }
    if (p.kind === "circle") {
      return { id, kind: "circle", cx: str(p.cx), cy: str(p.cy), radius: str(p.radius, "5") };
    }
    if (p.kind === "polygon") {
      const pts = Array.isArray(p.points) ? p.points : [];
      return {
        id,
        kind: "polygon",
        points: pts.map((pt: Record<string, unknown>) => ({
          x: Number(pt.x) || 0,
          y: Number(pt.y) || 0,
        })),
      };
    }
    throw new Error(`unknown profile kind "${String(p.kind)}"`);
  });
}

/** Appends a feature, waits for regen, and reports its status + any new body. */
async function commitFeature(feature: Feature, verb: string): Promise<ToolResult> {
  const gen = useGeometryStore.getState().result?.generation ?? -1;
  useDocumentStore.getState().dispatch({ kind: "addFeature", feature });
  const result = await waitForRegen(gen);
  const status = result?.statuses[feature.id];
  if (status?.level === "error") {
    return { text: `${verb} failed: ${status.message}`, ok: false };
  }
  const body = result?.bodies.find((b) => b.id === feature.id);
  const bodyInfo = body ? `, body ${feature.id} volume ${(body.volume / 1000).toFixed(2)} cm³` : "";
  const warn = status?.level === "warning" ? ` (warning: ${status.message})` : "";
  return { text: `${verb} ok — feature ${feature.id}${bodyInfo}${warn}`, ok: true };
}

const num = (name: string): Parameter["name"] => name;

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const doc: CraftbitDocument = useDocumentStore.getState().doc;
  try {
    switch (name) {
      case "create_parameter": {
        const pName = num(String(input.name ?? "").trim());
        if (!pName) return { text: "parameter name required", ok: false };
        const parameter: Parameter = {
          id: newId(),
          name: pName,
          expression: str(input.expression, "0"),
        };
        useDocumentStore.getState().dispatch({ kind: "addParameter", parameter });
        return { text: `parameter ${pName} = ${parameter.expression} created`, ok: true };
      }
      case "create_sketch": {
        const id = newId();
        const feature: Feature = {
          id,
          type: "sketch",
          name: str(
            input.name,
            `Sketch ${doc.features.filter((f) => f.type === "sketch").length + 1}`,
          ),
          suppressed: false,
          plane: { kind: "origin", plane: (input.plane as "XY" | "XZ" | "YZ") ?? "XY" },
          profiles: toProfiles(input.profiles),
        };
        useDocumentStore.getState().dispatch({ kind: "addFeature", feature });
        const gen = useGeometryStore.getState().result?.generation ?? -1;
        await waitForRegen(gen);
        return {
          text: `sketch ${id} created on ${feature.plane.kind === "origin" ? feature.plane.plane : "face"} with ${feature.profiles.length} profile(s)`,
          ok: true,
        };
      }
      case "extrude": {
        return commitFeature(
          {
            id: newId(),
            type: "extrude",
            name: str(input.name, "Extrude"),
            suppressed: false,
            sketchId: String(input.sketchId ?? ""),
            profileIds: [],
            distance: str(input.distance, "5"),
            direction: (input.direction as "normal" | "reversed" | "symmetric") ?? "normal",
            operation: (input.operation as "new" | "join" | "cut") ?? "new",
          },
          "extrude",
        );
      }
      case "revolve": {
        return commitFeature(
          {
            id: newId(),
            type: "revolve",
            name: str(input.name, "Revolve"),
            suppressed: false,
            sketchId: String(input.sketchId ?? ""),
            profileIds: [],
            axis: (input.axis as "x" | "y") ?? "x",
            angle: str(input.angle, "360"),
            operation: (input.operation as "new" | "join" | "cut") ?? "new",
          },
          "revolve",
        );
      }
      case "move": {
        return commitFeature(
          {
            id: newId(),
            type: "move",
            name: str(input.name, "Move"),
            suppressed: false,
            bodyId: String(input.bodyId ?? ""),
            tx: str(input.tx),
            ty: str(input.ty),
            tz: str(input.tz),
            rotAxis: (input.rotAxis as "x" | "y" | "z") ?? "z",
            rotAngle: str(input.rotAngle),
          },
          "move",
        );
      }
      case "mirror": {
        return commitFeature(
          {
            id: newId(),
            type: "mirror",
            name: str(input.name, "Mirror"),
            suppressed: false,
            bodyId: String(input.bodyId ?? ""),
            plane: (input.plane as "XY" | "XZ" | "YZ") ?? "YZ",
            merge: input.merge === true,
          },
          "mirror",
        );
      }
      case "linear_pattern": {
        return commitFeature(
          {
            id: newId(),
            type: "linearPattern",
            name: str(input.name, "Pattern"),
            suppressed: false,
            bodyId: String(input.bodyId ?? ""),
            direction: (input.direction as "x" | "y" | "z") ?? "x",
            spacing: str(input.spacing, "10"),
            count: str(input.count, "2"),
          },
          "linear pattern",
        );
      }
      case "circular_pattern": {
        return commitFeature(
          {
            id: newId(),
            type: "circularPattern",
            name: str(input.name, "Circular"),
            suppressed: false,
            bodyId: String(input.bodyId ?? ""),
            axis: (input.axis as "x" | "y" | "z") ?? "z",
            count: str(input.count, "4"),
          },
          "circular pattern",
        );
      }
      case "boolean_combine": {
        return commitFeature(
          {
            id: newId(),
            type: "boolean",
            name: str(input.name, "Combine"),
            suppressed: false,
            targetBodyId: String(input.targetBodyId ?? ""),
            toolBodyId: String(input.toolBodyId ?? ""),
            op: (input.op as "join" | "cut" | "intersect") ?? "join",
          },
          "combine",
        );
      }
      case "delete_feature": {
        const featureId = String(input.featureId ?? "");
        if (!doc.features.some((f) => f.id === featureId)) {
          return { text: `no feature ${featureId} to delete`, ok: false };
        }
        useDocumentStore.getState().dispatch({ kind: "removeFeature", featureId });
        const gen = useGeometryStore.getState().result?.generation ?? -1;
        await waitForRegen(gen);
        return { text: `deleted feature ${featureId}`, ok: true };
      }
      default:
        return { text: `unknown tool "${name}"`, ok: false };
    }
  } catch (e) {
    return { text: `error: ${e instanceof Error ? e.message : String(e)}`, ok: false };
  }
}
