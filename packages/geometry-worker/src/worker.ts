/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { deserializeDocument, type CraftbitDocument } from "@craftbit/core";
import { loadOcct } from "./occLoader";
import {
  collectFaces,
  collectUniqueEdges,
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

/** Geometry description of one face, for AI/selector reference resolution. */
export interface FaceInfo {
  /** D2 topological name — a durable TopoRef when paired with the body id. */
  name: string;
  centroid: [number, number, number];
  /** Outward normal (planar faces); [0,0,0] for non-planar. */
  normal: [number, number, number];
  area: number;
  planar: boolean;
  /** Plane frame (planar faces only) — matches resolvePlane, so profiles
   * expressed relative to the face centroid can be placed correctly. */
  origin?: [number, number, number];
  xdir?: [number, number, number];
  ydir?: [number, number, number];
}

export interface EdgeInfo {
  name: string;
  midpoint: [number, number, number];
  /** Unit direction (straight edges); chord direction otherwise. */
  dir: [number, number, number];
  length: number;
  straight: boolean;
}

export interface BodyAnalysis {
  id: string;
  faces: FaceInfo[];
  edges: EdgeInfo[];
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
  /** Per-body face/edge descriptors for reference resolution (AI selectors,
   * "the top face", "all vertical edges", face-relative sketches). */
  analyze(docJson: string): Promise<{ bodies: BodyAnalysis[] }>;
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

  async analyze(docJson) {
    const { oc, state } = await regenShapes(docJson);
    const cross = (
      a: [number, number, number],
      b: [number, number, number],
    ): [number, number, number] => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const bodies: BodyAnalysis[] = state.bodies.map((body) => {
      const faces: FaceInfo[] = collectFaces(oc, body.shape).map((face, i) => {
        const props = new oc.GProp_GProps_1();
        oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
        const c = props.CentreOfMass();
        const centroid: [number, number, number] = [c.X(), c.Y(), c.Z()];
        const surf = new oc.BRepAdaptor_Surface_2(face, true);
        const info: FaceInfo = {
          name: body.names.faceNames[i] ?? `face#${i}`,
          centroid,
          normal: [0, 0, 0],
          area: props.Mass(),
          planar: false,
        };
        if (surf.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
          const pln = surf.Plane();
          const loc = pln.Location();
          let n = pln.Axis().Direction();
          if (face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value) {
            n = n.Reversed();
          }
          const xd = pln.Position().XDirection();
          const nv: [number, number, number] = [n.X(), n.Y(), n.Z()];
          const xv: [number, number, number] = [xd.X(), xd.Y(), xd.Z()];
          info.planar = true;
          info.normal = nv;
          info.origin = [loc.X(), loc.Y(), loc.Z()];
          info.xdir = xv;
          info.ydir = cross(nv, xv);
        }
        return info;
      });

      const edges: EdgeInfo[] = collectUniqueEdges(oc, body.shape).map((edge, i) => {
        const props = new oc.GProp_GProps_1();
        oc.BRepGProp.LinearProperties(edge, props, false, false);
        const curve = new oc.BRepAdaptor_Curve_2(edge);
        const u0 = curve.FirstParameter();
        const u1 = curve.LastParameter();
        const p0 = curve.Value(u0);
        const p1 = curve.Value(u1);
        const mid = curve.Value((u0 + u1) / 2);
        const d: [number, number, number] = [p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        return {
          name: body.names.edgeNames[i] ?? `edge#${i}`,
          midpoint: [mid.X(), mid.Y(), mid.Z()],
          dir: [d[0] / len, d[1] / len, d[2] / len],
          length: props.Mass(),
          straight: curve.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value,
        };
      });

      return { id: body.id, faces, edges };
    });
    return { bodies };
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
