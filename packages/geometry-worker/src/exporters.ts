/**
 * Fabrication exporters (spec §7.13). STL is written by hand from
 * export-quality tessellation — full control over the binary layout and
 * validation (OCCT's StlAPI_Writer also has a broken FS path in this
 * Emscripten build). STEP goes through OCCT's writer via the in-memory FS.
 */

import type { OpenCascadeInstance, TopoDsShape } from "./occt-types";
import { EXPORT_QUALITY, tessellateShape } from "./tessellate";

export interface StlValidation {
  triangleCount: number;
  /** Watertight = every edge (vertex-pair) is shared by exactly 2 triangles. */
  watertight: boolean;
  openEdgeCount: number;
  boundsMm: { min: [number, number, number]; max: [number, number, number] };
}

export interface StlResult {
  bytes: Uint8Array;
  validation: StlValidation;
}

/** Binary STL (little-endian, mm units — the de-facto slicer standard). */
export function exportStl(oc: OpenCascadeInstance, shapes: TopoDsShape[]): StlResult {
  const meshes = shapes.map((s) => tessellateShape(oc, s, EXPORT_QUALITY));
  const triangleCount = meshes.reduce((n, m) => n + m.triangleCount, 0);

  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  const header = "Craftbit binary STL (units: mm)";
  for (let i = 0; i < header.length && i < 80; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, triangleCount, true);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const edgeUse = new Map<string, number>();
  const vertexKey = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

  let offset = 84;
  for (const mesh of meshes) {
    for (let t = 0; t < mesh.triangleCount; t++) {
      const base = t * 9;
      view.setFloat32(offset + 0, mesh.normals[base]!, true);
      view.setFloat32(offset + 4, mesh.normals[base + 1]!, true);
      view.setFloat32(offset + 8, mesh.normals[base + 2]!, true);
      const keys: string[] = [];
      for (let v = 0; v < 3; v++) {
        const x = mesh.positions[base + v * 3]!;
        const y = mesh.positions[base + v * 3 + 1]!;
        const z = mesh.positions[base + v * 3 + 2]!;
        view.setFloat32(offset + 12 + v * 12, x, true);
        view.setFloat32(offset + 16 + v * 12, y, true);
        view.setFloat32(offset + 20 + v * 12, z, true);
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
        max[2] = Math.max(max[2], z);
        keys.push(vertexKey(x, y, z));
      }
      for (let v = 0; v < 3; v++) {
        const a = keys[v]!;
        const b = keys[(v + 1) % 3]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }

  let openEdgeCount = 0;
  for (const count of edgeUse.values()) {
    if (count !== 2) openEdgeCount++;
  }

  return {
    bytes,
    validation: {
      triangleCount,
      watertight: openEdgeCount === 0,
      openEdgeCount,
      boundsMm: { min, max },
    },
  };
}

function statusValue(s: number | { value: number }): number {
  return typeof s === "number" ? s : s.value;
}

/** STEP AP203/214 via OCCT writer + in-memory Emscripten FS. */
export function exportStep(oc: OpenCascadeInstance, shapes: TopoDsShape[]): Uint8Array {
  const writer = new oc.STEPControl_Writer_1();
  for (const shape of shapes) {
    const status = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    if (statusValue(status) !== 1) throw new Error("STEP transfer failed");
  }
  // This OCCT 7.4 Emscripten build (patched OSD_Path) rejects FS paths longer
  // than 10 characters — verified by bisection. Keep this path SHORT.
  const path = "/o.step";
  const wstat = writer.Write(path);
  if (statusValue(wstat) !== 1) throw new Error("STEP write failed");
  const bytes = oc.FS.readFile(path);
  oc.FS.unlink(path);
  return bytes;
}
