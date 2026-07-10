/**
 * Minimal typings for the subset of the OpenCascade.js (OCCT) WASM API used by
 * this package. opencascade.js ships no .d.ts; these are hand-written against
 * the actual embind surface (verified against a running instance, not
 * guessed) and should grow only as new OCCT calls are introduced.
 */

export interface GpPnt {
  X(): number;
  Y(): number;
  Z(): number;
  Transformed(trsf: GpTrsf): GpPnt;
}

export interface GpTrsf {
  readonly __gpTrsfBrand: never;
}

export interface TopLocLocation {
  Transformation(): GpTrsf;
}

export interface PolyTriangle {
  Value(cornerIndex: 1 | 2 | 3): number;
}

export interface PolyTriangulationHandle {
  IsNull(): boolean;
  get(): PolyTriangulation;
}

export interface PolyTriangulation {
  NbNodes(): number;
  NbTriangles(): number;
  Node(index: number): GpPnt;
  Triangle(index: number): PolyTriangle;
}

export interface TopAbsOrientation {
  value: number;
}

export interface TopAbsShapeEnumValue {
  value: number;
}

export interface TopoDsShape {
  ShapeType(): TopAbsShapeEnumValue;
}

export interface TopoDsFace extends TopoDsShape {
  Orientation_1(): TopAbsOrientation;
}

export interface TopExpExplorer {
  More(): boolean;
  Next(): void;
  Current(): TopoDsShape;
}

export interface BRepPrimApiMakeBox {
  Shape(): TopoDsShape;
}

export interface GPropGProps {
  Mass(): number;
}

export interface OpenCascadeInstance {
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => BRepPrimApiMakeBox;
  BRepMesh_IncrementalMesh_2: new (
    shape: TopoDsShape,
    linearDeflection: number,
    isRelative: boolean,
    angularDeflection: number,
    isInParallel: boolean,
  ) => unknown;
  TopExp_Explorer_2: new (
    shape: TopoDsShape,
    toFind: TopAbsShapeEnumValue,
    toAvoid: TopAbsShapeEnumValue,
  ) => TopExpExplorer;
  TopAbs_ShapeEnum: {
    TopAbs_FACE: TopAbsShapeEnumValue;
    TopAbs_SHAPE: TopAbsShapeEnumValue;
  };
  TopAbs_Orientation: {
    TopAbs_FORWARD: TopAbsOrientation;
    TopAbs_REVERSED: TopAbsOrientation;
  };
  TopoDS: {
    Face_1(shape: TopoDsShape): TopoDsFace;
  };
  TopLoc_Location_1: new () => TopLocLocation;
  BRep_Tool: {
    Triangulation(face: TopoDsFace, location: TopLocLocation): PolyTriangulationHandle;
  };
  GProp_GProps_1: new () => GPropGProps;
  BRepGProp: {
    VolumeProperties_1(
      shape: TopoDsShape,
      props: GPropGProps,
      onlyClosed: boolean,
      skipShared: boolean,
      useTriangulation: boolean,
    ): void;
  };
}
