import * as Comlink from "comlink";
import type { GeometryWorkerApi } from "./worker";

export type { TessellatedMesh } from "./tessellate";
export type { BodyResult, GeometryWorkerApi, RegenResult, StlExportResult } from "./worker";
export type { EvaluatedSketch, EvaluatedProfile, FeatureStatus, ResolvedPlane } from "./regen";
export type { StlValidation } from "./exporters";

export interface GeometryWorkerClient {
  api: Comlink.Remote<GeometryWorkerApi>;
  /** Terminates the underlying Worker thread. Call on component unmount. */
  terminate(): void;
}

export function createGeometryWorkerClient(): GeometryWorkerClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  const api = Comlink.wrap<GeometryWorkerApi>(worker);
  return {
    api,
    terminate: () => worker.terminate(),
  };
}
