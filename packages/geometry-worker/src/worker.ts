/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { loadOcct } from "./occLoader";
import { tessellateShape, type TessellatedMesh } from "./tessellate";

export interface GeometryWorkerApi {
  ready(): Promise<void>;
  makeBox(dx: number, dy: number, dz: number): Promise<TessellatedMesh>;
}

const api: GeometryWorkerApi = {
  async ready() {
    await loadOcct();
  },

  async makeBox(dx, dy, dz) {
    const oc = await loadOcct();
    const shape = new oc.BRepPrimAPI_MakeBox_1(dx, dy, dz).Shape();
    const mesh = tessellateShape(oc, shape);
    return Comlink.transfer(mesh, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.faceIds.buffer,
    ]) as unknown as TessellatedMesh;
  },
};

Comlink.expose(api);
