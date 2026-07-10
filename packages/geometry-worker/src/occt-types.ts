/**
 * Minimal typings for the subset of the OpenCascade.js (OCCT 7.4) WASM API used
 * by this package. opencascade.js ships no .d.ts; these are hand-written against
 * the actual embind surface (every signature verified against a running
 * instance, not guessed) and grow only as new OCCT calls are introduced.
 */

export interface GpPnt {
  X(): number;
  Y(): number;
  Z(): number;
  Transformed(trsf: GpTrsf): GpPnt;
}

export interface GpDir {
  X(): number;
  Y(): number;
  Z(): number;
  Reversed(): GpDir;
}

export interface GpVec {
  readonly __gpVecBrand: never;
}

export interface GpAx1 {
  readonly __gpAx1Brand: never;
}

export interface GpAx2 {
  readonly __gpAx2Brand: never;
}

export interface GpCirc {
  readonly __gpCircBrand: never;
}

export interface GpPln {
  Location(): GpPnt;
  Axis(): { Direction(): GpDir };
  Position(): { XDirection(): GpDir; YDirection(): GpDir };
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
  IsSame(other: TopoDsShape): boolean;
  Reversed(): TopoDsShape;
  IsNull(): boolean;
}

export interface TopoDsFace extends TopoDsShape {
  Orientation_1(): TopAbsOrientation;
}

export interface TopoDsEdge extends TopoDsShape {
  readonly __edgeBrand: never;
}

export interface TopoDsWire extends TopoDsShape {
  readonly __wireBrand: never;
}

export interface TopExpExplorer {
  More(): boolean;
  Next(): void;
  Current(): TopoDsShape;
}

export interface ShapeMaker {
  Shape(): TopoDsShape;
}

export interface GPropGProps {
  Mass(): number;
  CentreOfMass(): GpPnt;
}

export interface BRepAlgoApiBoolean {
  Build(): void;
  IsDone(): boolean;
  Shape(): TopoDsShape;
}

export interface BRepFilletApiMakeFillet {
  Add_2(radius: number, edge: TopoDsEdge): void;
  Build(): void;
  IsDone(): boolean;
  Shape(): TopoDsShape;
}

export interface BRepAdaptorCurve {
  FirstParameter(): number;
  LastParameter(): number;
  Value(u: number): GpPnt;
}

export interface BRepAdaptorSurface {
  GetType(): { value: number };
  Plane(): GpPln;
}

export interface GCPntsTangentialDeflection {
  NbPoints(): number;
  Value(index: number): GpPnt;
  Parameter(index: number): number;
}

export interface EmscriptenFS {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  unlink(path: string): void;
}

export interface OpenCascadeInstance {
  // gp primitives
  gp_Pnt_3: new (x: number, y: number, z: number) => GpPnt;
  gp_Dir_4: new (x: number, y: number, z: number) => GpDir;
  gp_Vec_4: new (x: number, y: number, z: number) => GpVec;
  gp_Ax1_2: new (p: GpPnt, d: GpDir) => GpAx1;
  gp_Ax2_2: new (p: GpPnt, n: GpDir, vx: GpDir) => GpAx2;
  gp_Ax2_3: new (p: GpPnt, n: GpDir) => GpAx2;
  gp_Circ_2: new (ax2: GpAx2, radius: number) => GpCirc;

  // Topology builders
  BRepBuilderAPI_MakeEdge_3: new (p1: GpPnt, p2: GpPnt) => { Edge(): TopoDsEdge };
  BRepBuilderAPI_MakeEdge_8: new (circ: GpCirc) => { Edge(): TopoDsEdge };
  BRepBuilderAPI_MakeWire_1: new () => { Add_1(edge: TopoDsEdge): void; Wire(): TopoDsWire };
  BRepBuilderAPI_MakeWire_2: new (edge: TopoDsEdge) => { Wire(): TopoDsWire };
  BRepBuilderAPI_MakeFace_15: new (
    wire: TopoDsWire,
    onlyPlane: boolean,
  ) => { Add(wire: TopoDsWire): void; Face(): TopoDsFace };

  // Primitives & sweeps
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => ShapeMaker;
  BRepPrimAPI_MakePrism_1: new (
    face: TopoDsShape,
    vec: GpVec,
    copy: boolean,
    canonize: boolean,
  ) => ShapeMaker;
  BRepPrimAPI_MakeRevol_1: new (
    face: TopoDsShape,
    axis: GpAx1,
    angleRad: number,
    copy: boolean,
  ) => ShapeMaker;

  // Booleans (OCCT 7.4: two-arg ctor, no-arg Build)
  BRepAlgoAPI_Cut_3: new (target: TopoDsShape, tool: TopoDsShape) => BRepAlgoApiBoolean;
  BRepAlgoAPI_Fuse_3: new (a: TopoDsShape, b: TopoDsShape) => BRepAlgoApiBoolean;
  BRepAlgoAPI_Common_3: new (a: TopoDsShape, b: TopoDsShape) => BRepAlgoApiBoolean;

  // Fillet
  BRepFilletAPI_MakeFillet: new (
    shape: TopoDsShape,
    filletShape: { value: number },
  ) => BRepFilletApiMakeFillet;
  ChFi3d_FilletShape: { ChFi3d_Rational: { value: number } };

  // Meshing & measurement
  BRepMesh_IncrementalMesh_2: new (
    shape: TopoDsShape,
    linearDeflection: number,
    isRelative: boolean,
    angularDeflection: number,
    isInParallel: boolean,
  ) => unknown;
  GProp_GProps_1: new () => GPropGProps;
  BRepGProp: {
    VolumeProperties_1(
      shape: TopoDsShape,
      props: GPropGProps,
      onlyClosed: boolean,
      skipShared: boolean,
      useTriangulation: boolean,
    ): void;
    SurfaceProperties_1(
      shape: TopoDsShape,
      props: GPropGProps,
      skipShared: boolean,
      useTriangulation: boolean,
    ): void;
  };

  // Exploration & adaptors
  TopExp_Explorer_2: new (
    shape: TopoDsShape,
    toFind: TopAbsShapeEnumValue,
    toAvoid: TopAbsShapeEnumValue,
  ) => TopExpExplorer;
  TopAbs_ShapeEnum: {
    TopAbs_FACE: TopAbsShapeEnumValue;
    TopAbs_EDGE: TopAbsShapeEnumValue;
    TopAbs_SHAPE: TopAbsShapeEnumValue;
  };
  TopAbs_Orientation: {
    TopAbs_FORWARD: TopAbsOrientation;
    TopAbs_REVERSED: TopAbsOrientation;
  };
  TopoDS: {
    Face_1(shape: TopoDsShape): TopoDsFace;
    Edge_1(shape: TopoDsShape): TopoDsEdge;
    Wire_1(shape: TopoDsShape): TopoDsWire;
  };
  TopLoc_Location_1: new () => TopLocLocation;
  BRep_Tool: {
    Triangulation(face: TopoDsFace, location: TopLocLocation): PolyTriangulationHandle;
  };
  BRepAdaptor_Curve_2: new (edge: TopoDsEdge) => BRepAdaptorCurve;
  BRepAdaptor_Surface_2: new (face: TopoDsFace, restriction: boolean) => BRepAdaptorSurface;
  GeomAbs_SurfaceType: { GeomAbs_Plane: { value: number } };
  GCPnts_TangentialDeflection_2: new (
    curve: BRepAdaptorCurve,
    angularDeflection: number,
    curvatureDeflection: number,
    minimumOfPoints: number,
    uTol: number,
    minLen: number,
  ) => GCPntsTangentialDeflection;

  // STEP export (status returns may be raw ints or {value} depending on embind enum handling)
  STEPControl_Writer_1: new () => {
    Transfer(
      shape: TopoDsShape,
      mode: { value: number },
      compgraph: boolean,
    ): number | { value: number };
    Write(path: string): number | { value: number };
  };
  STEPControl_StepModelType: { STEPControl_AsIs: { value: number } };

  FS: EmscriptenFS;
}
