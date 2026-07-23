/** Shared topology exploration helpers (used by regen, naming, tessellate). */

import type { OpenCascadeInstance, TopoDsEdge, TopoDsFace, TopoDsShape } from "./occt-types";

export function collectFaces(oc: OpenCascadeInstance, shape: TopoDsShape): TopoDsFace[] {
  const faces: TopoDsFace[] = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  while (exp.More()) {
    faces.push(oc.TopoDS.Face_1(exp.Current()));
    exp.Next();
  }
  return faces;
}

export function collectUniqueEdges(oc: OpenCascadeInstance, shape: TopoDsShape): TopoDsEdge[] {
  const edges: TopoDsEdge[] = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  while (exp.More()) {
    const e = exp.Current();
    if (!edges.some((u) => u.IsSame(e))) edges.push(oc.TopoDS.Edge_1(e));
    exp.Next();
  }
  return edges;
}
