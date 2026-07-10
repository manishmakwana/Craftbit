import type { OpenCascadeInstance, TopoDsShape } from "./occt-types";

/**
 * A flat (non-indexed) triangle-soup mesh: each triangle owns its own 3 vertices
 * so per-triangle flat shading normals are exact. Spec §4.3's richer tessellation
 * (shared vertices, edge polylines, stable face/edge-ID maps for picking) lands
 * in Milestone 1/2; M0 only needs "does a real OCCT shape render correctly".
 */
export interface TessellatedMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** One entry per triangle: index of the source face within the shape. */
  faceIds: Uint32Array;
  triangleCount: number;
}

const LINEAR_DEFLECTION = 0.1;
const ANGULAR_DEFLECTION = 0.5;

export function tessellateShape(oc: OpenCascadeInstance, shape: TopoDsShape): TessellatedMesh {
  new oc.BRepMesh_IncrementalMesh_2(shape, LINEAR_DEFLECTION, false, ANGULAR_DEFLECTION, false);

  const positions: number[] = [];
  const normals: number[] = [];
  const faceIds: number[] = [];

  const explorer = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  let faceIndex = 0;
  while (explorer.More()) {
    const face = oc.TopoDS.Face_1(explorer.Current());
    const isReversed = face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value;

    const location = new oc.TopLoc_Location_1();
    const triHandle = oc.BRep_Tool.Triangulation(face, location);

    if (!triHandle.IsNull()) {
      const triangulation = triHandle.get();
      const transform = location.Transformation();
      const nbNodes = triangulation.NbNodes();
      const nbTriangles = triangulation.NbTriangles();

      const nodeX = new Float64Array(nbNodes + 1);
      const nodeY = new Float64Array(nbNodes + 1);
      const nodeZ = new Float64Array(nbNodes + 1);
      for (let i = 1; i <= nbNodes; i++) {
        const p = triangulation.Node(i).Transformed(transform);
        nodeX[i] = p.X();
        nodeY[i] = p.Y();
        nodeZ[i] = p.Z();
      }

      for (let i = 1; i <= nbTriangles; i++) {
        const tri = triangulation.Triangle(i);
        const i0 = tri.Value(1);
        let i1 = tri.Value(2);
        let i2 = tri.Value(3);
        if (isReversed) {
          const tmp = i1;
          i1 = i2;
          i2 = tmp;
        }

        const p0 = [nodeX[i0]!, nodeY[i0]!, nodeZ[i0]!] as const;
        const p1 = [nodeX[i1]!, nodeY[i1]!, nodeZ[i1]!] as const;
        const p2 = [nodeX[i2]!, nodeY[i2]!, nodeZ[i2]!] as const;

        const ux = p1[0] - p0[0];
        const uy = p1[1] - p0[1];
        const uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0];
        const vy = p2[1] - p0[1];
        const vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;

        positions.push(...p0, ...p1, ...p2);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        faceIds.push(faceIndex);
      }
    }

    faceIndex++;
    explorer.Next();
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    faceIds: Uint32Array.from(faceIds),
    triangleCount: faceIds.length,
  };
}
