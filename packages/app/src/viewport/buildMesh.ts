import * as THREE from "three";
import type { TessellatedMesh } from "@craftbit/geometry-worker";

export function buildGeometryFromTessellation(mesh: TessellatedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  return geometry;
}
