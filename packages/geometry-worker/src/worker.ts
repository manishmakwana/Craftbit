/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { deserializeDocument, type CraftbitDocument } from "@craftbit/core";
import { loadOcct } from "./occLoader";
import {
  regenerateDocument,
  upgradeDocumentRefs,
  type EvaluatedSketch,
  type FeatureStatus,
} from "./regen";
import { tessellateShape, type TessellatedMesh } from "./tessellate";
import { exportStep, exportStl, type StlValidation } from "./exporters";

export interface BodyResult {
  id: string;
  volume: number;
  faceCount: number;
  edgeCount: number;
  mesh: TessellatedMesh;
  /** D2 topological names, index-aligned with the tessellation's face ids. */
  faceNames: string[];
  /** D2 topological names, index-aligned with the tessellation's edge indices. */
  edgeNames: string[];
}

export interface RegenResult {
  generation: number;
  bodies: BodyResult[];
  sketches: EvaluatedSketch[];
  statuses: Record<string, FeatureStatus>;
  parameterValues: Record<string, number>;
  parameterError?: string;
}

export interface StlExportResult {
  bytes: Uint8Array;
  validation: StlValidation;
}

export interface GeometryWorkerApi {
  ready(): Promise<void>;
  /**
   * Full-document regeneration. `generation` is echoed back so the client can
   * discard stale responses that were superseded by newer edits (D1 §open-q-1).
   */
  regenerate(docJson: string, generation: number): Promise<RegenResult>;
  /** One-time v1→v2 upgrade: legacy index refs rewritten to D2 names. */
  upgradeDocument(docJson: string): Promise<{ doc: CraftbitDocument; failures: string[] }>;
  exportStl(docJson: string, bodyIds: string[]): Promise<StlExportResult>;
  exportStep(docJson: string, bodyIds: string[]): Promise<Uint8Array>;
}

function regenShapes(docJson: string) {
  return loadOcct().then((oc) => {
    const doc = deserializeDocument(docJson);
    const state = regenerateDocument(oc, doc);
    return { oc, state };
  });
}

const api: GeometryWorkerApi = {
  async ready() {
    await loadOcct();
  },

  async regenerate(docJson, generation) {
    const { oc, state } = await regenShapes(docJson);
    const bodies: BodyResult[] = state.bodies.map((body) => {
      const mesh = tessellateShape(oc, body.shape);
      const faceIds = mesh.faceIds;
      const faceCount = faceIds.length > 0 ? Math.max(...Array.from(faceIds)) + 1 : 0;
      return {
        id: body.id,
        volume: body.volume,
        faceCount,
        edgeCount: mesh.edgeRanges.length / 3,
        mesh,
        faceNames: body.names.faceNames,
        edgeNames: body.names.edgeNames,
      };
    });

    const result: RegenResult = {
      generation,
      bodies,
      sketches: state.sketches,
      statuses: state.statuses,
      parameterValues: state.parameterValues,
      parameterError: state.parameterError,
    };
    const transfers: ArrayBuffer[] = [];
    for (const b of bodies) {
      transfers.push(
        b.mesh.positions.buffer as ArrayBuffer,
        b.mesh.normals.buffer as ArrayBuffer,
        b.mesh.faceIds.buffer as ArrayBuffer,
        b.mesh.edgePositions.buffer as ArrayBuffer,
        b.mesh.edgeRanges.buffer as ArrayBuffer,
      );
    }
    return Comlink.transfer(result, transfers) as unknown as RegenResult;
  },

  async upgradeDocument(docJson) {
    const oc = await loadOcct();
    const doc = deserializeDocument(docJson);
    return upgradeDocumentRefs(oc, doc);
  },

  async exportStl(docJson, bodyIds) {
    const { oc, state } = await regenShapes(docJson);
    const shapes = state.bodies
      .filter((b) => bodyIds.length === 0 || bodyIds.includes(b.id))
      .map((b) => b.shape);
    if (shapes.length === 0) throw new Error("No bodies to export");
    const result = exportStl(oc, shapes);
    return Comlink.transfer(result, [result.bytes.buffer]) as unknown as StlExportResult;
  },

  async exportStep(docJson, bodyIds) {
    const { oc, state } = await regenShapes(docJson);
    const shapes = state.bodies
      .filter((b) => bodyIds.length === 0 || bodyIds.includes(b.id))
      .map((b) => b.shape);
    if (shapes.length === 0) throw new Error("No bodies to export");
    const bytes = exportStep(oc, shapes);
    return Comlink.transfer(bytes, [bytes.buffer]) as unknown as Uint8Array;
  },
};

Comlink.expose(api);
