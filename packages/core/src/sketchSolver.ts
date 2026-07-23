/**
 * 2D geometric constraint solver for the sketcher (design gate D3).
 *
 * Entities (points, lines, circles, arcs) are related by declarative
 * constraints; solving adjusts the free coordinates until every constraint's
 * residual vanishes. The numerical core is Levenberg–Marquardt over the full
 * parameter vector with a forward-difference Jacobian — at hobbyist sketch
 * scale (tens of entities) this converges in milliseconds, which is why we
 * run it synchronously in both the worker (regeneration) and the UI thread
 * (drag preview). The constraint model is kept structurally compatible with
 * PlaneGCS so a WASM solver could be swapped in later without touching
 * documents (see docs/design/D3-constraint-sketcher.md §1).
 *
 * All values are plain numbers (mm / radians internally); dimensional
 * constraint expressions are evaluated by the caller before solving.
 */

export interface SketchPointEnt {
  id: string;
  kind: "point";
  x: number;
  y: number;
}

export interface SketchLineEnt {
  id: string;
  kind: "line";
  p1: string;
  p2: string;
}

export interface SketchCircleEnt {
  id: string;
  kind: "circle";
  center: string;
  radius: number;
}

export interface SketchArcEnt {
  id: string;
  kind: "arc";
  center: string;
  start: string;
  end: string;
  /** Counter-clockwise from start to end in sketch coords. */
  ccw: boolean;
}

export type SketchEntity = SketchPointEnt | SketchLineEnt | SketchCircleEnt | SketchArcEnt;

/** Dimensional constraint values arrive pre-evaluated (numbers, mm/degrees). */
export type SolvedConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "horizontal"; line: string }
  | { id: string; kind: "vertical"; line: string }
  | { id: string; kind: "parallel"; a: string; b: string }
  | { id: string; kind: "perpendicular"; a: string; b: string }
  | { id: string; kind: "equalLength"; a: string; b: string }
  | { id: string; kind: "equalRadius"; a: string; b: string }
  | { id: string; kind: "distance"; a: string; b: string; value: number }
  | { id: string; kind: "lineDistance"; a: string; b: string; value: number }
  | { id: string; kind: "radius"; entity: string; value: number }
  | { id: string; kind: "diameter"; entity: string; value: number }
  | { id: string; kind: "angle"; a: string; b: string; /** degrees */ value: number }
  | { id: string; kind: "tangent"; line: string; circle: string }
  | { id: string; kind: "fixed"; point: string };

export interface SolveResult {
  entities: SketchEntity[];
  converged: boolean;
  /** Estimated remaining degrees of freedom (0 = fully constrained). */
  dof: number;
  /** Largest constraint residual after solving (mm-scale). */
  maxResidual: number;
}

export interface DragTarget {
  pointId: string;
  x: number;
  y: number;
}

const CONVERGENCE_TOL = 1e-8;
const MAX_ITERATIONS = 200;
const FD_STEP = 1e-6;
const DRAG_WEIGHT = 0.05;

interface ParamIndex {
  /** pointId -> index of x in params (y is +1). */
  points: Map<string, number>;
  /** circle/arc id -> index of radius param. */
  radii: Map<string, number>;
  count: number;
}

interface System {
  index: ParamIndex;
  residuals: ((p: Float64Array) => number)[];
  init: Float64Array;
}

function buildSystem(
  entities: SketchEntity[],
  constraints: SolvedConstraint[],
  drag: DragTarget | null,
): System {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const point = (id: string): SketchPointEnt => {
    const e = byId.get(id);
    if (!e || e.kind !== "point")
      throw new Error(`Sketch constraint references missing point "${id}"`);
    return e;
  };
  const line = (id: string): SketchLineEnt => {
    const e = byId.get(id);
    if (!e || e.kind !== "line")
      throw new Error(`Sketch constraint references missing line "${id}"`);
    return e;
  };

  const fixedPoints = new Set(
    constraints.filter((c) => c.kind === "fixed").map((c) => (c as { point: string }).point),
  );

  const index: ParamIndex = { points: new Map(), radii: new Map(), count: 0 };
  const initValues: number[] = [];
  for (const e of entities) {
    if (e.kind === "point" && !fixedPoints.has(e.id)) {
      index.points.set(e.id, index.count);
      initValues.push(e.x, e.y);
      index.count += 2;
    } else if (e.kind === "circle") {
      index.radii.set(e.id, index.count);
      initValues.push(e.radius);
      index.count += 1;
    } else if (e.kind === "arc") {
      const c = point(e.center);
      const s = point(e.start);
      index.radii.set(e.id, index.count);
      initValues.push(Math.hypot(s.x - c.x, s.y - c.y));
      index.count += 1;
    }
  }

  // Coordinate accessors read from the parameter vector for free points and
  // from the stored entity for fixed ones.
  const px = (id: string) => {
    const at = index.points.get(id);
    return at === undefined ? (_p: Float64Array) => point(id).x : (p: Float64Array) => p[at]!;
  };
  const py = (id: string) => {
    const at = index.points.get(id);
    return at === undefined ? (_p: Float64Array) => point(id).y : (p: Float64Array) => p[at + 1]!;
  };
  const radiusOf = (id: string): ((p: Float64Array) => number) => {
    const at = index.radii.get(id);
    if (at === undefined)
      throw new Error(`Sketch constraint references missing circle/arc "${id}"`);
    return (p) => p[at]!;
  };

  const residuals: ((p: Float64Array) => number)[] = [];

  // Implicit arc shape residuals: both endpoints at radius distance from center.
  for (const e of entities) {
    if (e.kind !== "arc") continue;
    const cx = px(e.center);
    const cy = py(e.center);
    const r = radiusOf(e.id);
    for (const endId of [e.start, e.end]) {
      const ex = px(endId);
      const ey = py(endId);
      residuals.push((p) => Math.hypot(ex(p) - cx(p), ey(p) - cy(p)) - r(p));
    }
  }

  for (const c of constraints) {
    switch (c.kind) {
      case "fixed":
        break; // handled by parameter exclusion
      case "coincident": {
        const [ax, ay, bx, by] = [px(c.a), py(c.a), px(c.b), py(c.b)];
        residuals.push((p) => ax(p) - bx(p));
        residuals.push((p) => ay(p) - by(p));
        break;
      }
      case "horizontal": {
        const l = line(c.line);
        const [y1, y2] = [py(l.p1), py(l.p2)];
        residuals.push((p) => y2(p) - y1(p));
        break;
      }
      case "vertical": {
        const l = line(c.line);
        const [x1, x2] = [px(l.p1), px(l.p2)];
        residuals.push((p) => x2(p) - x1(p));
        break;
      }
      case "parallel":
      case "perpendicular": {
        const la = line(c.a);
        const lb = line(c.b);
        const [ax1, ay1, ax2, ay2] = [px(la.p1), py(la.p1), px(la.p2), py(la.p2)];
        const [bx1, by1, bx2, by2] = [px(lb.p1), py(lb.p1), px(lb.p2), py(lb.p2)];
        const isParallel = c.kind === "parallel";
        // Normalized by length product so residual stays mm-scale.
        residuals.push((p) => {
          const dax = ax2(p) - ax1(p);
          const day = ay2(p) - ay1(p);
          const dbx = bx2(p) - bx1(p);
          const dby = by2(p) - by1(p);
          const scale = Math.max(1e-9, Math.sqrt(Math.hypot(dax, day) * Math.hypot(dbx, dby)));
          return (isParallel ? dax * dby - day * dbx : dax * dbx + day * dby) / scale;
        });
        break;
      }
      case "equalLength": {
        const la = line(c.a);
        const lb = line(c.b);
        const [ax1, ay1, ax2, ay2] = [px(la.p1), py(la.p1), px(la.p2), py(la.p2)];
        const [bx1, by1, bx2, by2] = [px(lb.p1), py(lb.p1), px(lb.p2), py(lb.p2)];
        residuals.push(
          (p) =>
            Math.hypot(ax2(p) - ax1(p), ay2(p) - ay1(p)) -
            Math.hypot(bx2(p) - bx1(p), by2(p) - by1(p)),
        );
        break;
      }
      case "equalRadius": {
        const ra = radiusOf(c.a);
        const rb = radiusOf(c.b);
        residuals.push((p) => ra(p) - rb(p));
        break;
      }
      case "distance": {
        const [ax, ay, bx, by] = [px(c.a), py(c.a), px(c.b), py(c.b)];
        const v = c.value;
        residuals.push((p) => Math.hypot(ax(p) - bx(p), ay(p) - by(p)) - v);
        break;
      }
      case "lineDistance": {
        // Perpendicular distance from line b's first endpoint to the infinite
        // line a (the two lines are expected parallel — same form as tangent).
        const la = line(c.a);
        const lb = line(c.b);
        const [x1, y1, x2, y2] = [px(la.p1), py(la.p1), px(la.p2), py(la.p2)];
        const [bx, by] = [px(lb.p1), py(lb.p1)];
        const v = c.value;
        residuals.push((p) => {
          const dx = x2(p) - x1(p);
          const dy = y2(p) - y1(p);
          const len = Math.max(1e-9, Math.hypot(dx, dy));
          const dist = Math.abs(dy * (bx(p) - x1(p)) - dx * (by(p) - y1(p))) / len;
          return dist - v;
        });
        break;
      }
      case "radius": {
        const r = radiusOf(c.entity);
        const v = c.value;
        residuals.push((p) => r(p) - v);
        break;
      }
      case "diameter": {
        const r = radiusOf(c.entity);
        const v = c.value;
        residuals.push((p) => r(p) - v / 2);
        break;
      }
      case "angle": {
        const la = line(c.a);
        const lb = line(c.b);
        const [ax1, ay1, ax2, ay2] = [px(la.p1), py(la.p1), px(la.p2), py(la.p2)];
        const [bx1, by1, bx2, by2] = [px(lb.p1), py(lb.p1), px(lb.p2), py(lb.p2)];
        const target = (c.value * Math.PI) / 180;
        residuals.push((p) => {
          const dax = ax2(p) - ax1(p);
          const day = ay2(p) - ay1(p);
          const dbx = bx2(p) - bx1(p);
          const dby = by2(p) - by1(p);
          const cross = dax * dby - day * dbx;
          const dot = dax * dbx + day * dby;
          return Math.atan2(cross, dot) - target;
        });
        break;
      }
      case "tangent": {
        const l = line(c.line);
        const [x1, y1, x2, y2] = [px(l.p1), py(l.p1), px(l.p2), py(l.p2)];
        const ent = byId.get(c.circle);
        if (!ent || (ent.kind !== "circle" && ent.kind !== "arc")) {
          throw new Error(`Tangent constraint references missing circle/arc "${c.circle}"`);
        }
        const [cx, cy] = [px(ent.center), py(ent.center)];
        const r = radiusOf(c.circle);
        residuals.push((p) => {
          const dx = x2(p) - x1(p);
          const dy = y2(p) - y1(p);
          const len = Math.max(1e-9, Math.hypot(dx, dy));
          // Signed distance from center to the infinite line, minus radius.
          const dist = Math.abs(dy * (cx(p) - x1(p)) - dx * (cy(p) - y1(p))) / len;
          return dist - r(p);
        });
        break;
      }
    }
  }

  if (drag) {
    const at = index.points.get(drag.pointId);
    if (at !== undefined) {
      residuals.push((p) => DRAG_WEIGHT * (p[at]! - drag.x));
      residuals.push((p) => DRAG_WEIGHT * (p[at + 1]! - drag.y));
    }
  }

  return { index, residuals, init: Float64Array.from(initValues) };
}

function evalResiduals(sys: System, p: Float64Array): Float64Array {
  const r = new Float64Array(sys.residuals.length);
  for (let i = 0; i < sys.residuals.length; i++) r[i] = sys.residuals[i]!(p);
  return r;
}

function jacobian(sys: System, p: Float64Array, r0: Float64Array): Float64Array[] {
  const rows: Float64Array[] = [];
  for (let i = 0; i < sys.residuals.length; i++) rows.push(new Float64Array(sys.index.count));
  const pw = Float64Array.from(p);
  for (let j = 0; j < sys.index.count; j++) {
    const saved = pw[j]!;
    pw[j] = saved + FD_STEP;
    for (let i = 0; i < sys.residuals.length; i++) {
      rows[i]![j] = (sys.residuals[i]!(pw) - r0[i]!) / FD_STEP;
    }
    pw[j] = saved;
  }
  return rows;
}

/** Solves (JᵀJ + λ·diag(JᵀJ))·dx = −Jᵀr by Gaussian elimination with partial pivoting. */
function solveNormalEquations(
  J: Float64Array[],
  r: Float64Array,
  lambda: number,
  n: number,
): Float64Array | null {
  const A: Float64Array[] = [];
  for (let i = 0; i < n; i++) A.push(new Float64Array(n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (const row of J) sum += row[i]! * row[j]!;
      A[i]![j] = sum;
      A[j]![i] = sum;
    }
  }
  for (let i = 0; i < n; i++) {
    A[i]![i] = A[i]![i]! * (1 + lambda) + lambda * 1e-8;
    let g = 0;
    for (let k = 0; k < J.length; k++) g += J[k]![i]! * r[k]!;
    A[i]![n] = -g;
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row]![col]!) > Math.abs(A[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(A[pivot]![col]!) < 1e-14) return null;
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    for (let row = col + 1; row < n; row++) {
      const f = A[row]![col]! / A[col]![col]!;
      for (let k = col; k <= n; k++) A[row]![k] = A[row]![k]! - f * A[col]![k]!;
    }
  }
  const dx = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = A[i]![n]!;
    for (let k = i + 1; k < n; k++) sum -= A[i]![k]! * dx[k]!;
    dx[i] = sum / A[i]![i]!;
  }
  return dx;
}

/** Numeric row-rank of the Jacobian (for the DOF estimate). */
function jacobianRank(J: Float64Array[], n: number): number {
  const rows = J.map((r) => Float64Array.from(r));
  let rank = 0;
  let col = 0;
  for (let r = 0; r < rows.length && col < n;) {
    let pivot = r;
    for (let i = r + 1; i < rows.length; i++) {
      if (Math.abs(rows[i]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = i;
    }
    if (Math.abs(rows[pivot]![col]!) < 1e-7) {
      col++;
      continue;
    }
    [rows[r], rows[pivot]] = [rows[pivot]!, rows[r]!];
    for (let i = r + 1; i < rows.length; i++) {
      const f = rows[i]![col]! / rows[r]![col]!;
      for (let k = col; k < n; k++) rows[i]![k] = rows[i]![k]! - f * rows[r]![k]!;
    }
    rank++;
    r++;
    col++;
  }
  return rank;
}

function maxAbs(r: Float64Array): number {
  let m = 0;
  for (const v of r) m = Math.max(m, Math.abs(v));
  return m;
}

/** One Levenberg–Marquardt descent from `start`; returns the improved parameter vector. */
function lmMinimize(sys: System, start: Float64Array): Float64Array {
  const n = sys.index.count;
  let p = Float64Array.from(start);
  let residualNow = evalResiduals(sys, p);
  let lambda = 1e-3;
  let cost = residualNow.reduce((s, v) => s + v * v, 0);
  for (let iter = 0; iter < MAX_ITERATIONS && maxAbs(residualNow) > CONVERGENCE_TOL; iter++) {
    const J = jacobian(sys, p, residualNow);
    const dx = solveNormalEquations(J, residualNow, lambda, n);
    if (!dx) break;
    const trial = Float64Array.from(p);
    for (let j = 0; j < n; j++) trial[j] = trial[j]! + dx[j]!;
    const trialResiduals = evalResiduals(sys, trial);
    const trialCost = trialResiduals.reduce((s, v) => s + v * v, 0);
    if (trialCost < cost) {
      p = trial;
      residualNow = trialResiduals;
      cost = trialCost;
      lambda = Math.max(1e-12, lambda / 10);
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }
  return p;
}

/**
 * Solves the sketch. Returns updated entities (original array untouched),
 * convergence status, and a degrees-of-freedom estimate. With no residuals
 * (no constraints, no arcs) this is an identity pass reporting the free DOF.
 *
 * Dragging runs two phases: first a solve with the soft cursor target mixed
 * in (pulls the geometry along whatever freedom the constraints leave), then
 * a hard-constraints-only polish from that solution — projecting back onto
 * the constraint manifold so hard residuals end at solver tolerance rather
 * than at the soft/hard cost balance point. On a fully constrained sketch
 * this makes dragging a clean no-op instead of a slight constraint violation.
 */
export function solveSketch(
  entities: SketchEntity[],
  constraints: SolvedConstraint[],
  drag: DragTarget | null = null,
): SolveResult {
  const hardSys = buildSystem(entities, constraints, null);
  const n = hardSys.index.count;
  let p: Float64Array = Float64Array.from(hardSys.init);

  if (n > 0) {
    if (drag) {
      const dragSys = buildSystem(entities, constraints, drag);
      p = lmMinimize(dragSys, p);
    }
    if (hardSys.residuals.length > 0) {
      p = lmMinimize(hardSys, p);
    }
  }

  const finalResiduals = evalResiduals(hardSys, p);
  const converged = hardSys.residuals.length === 0 || maxAbs(finalResiduals) < 1e-5;

  const rank =
    hardSys.residuals.length === 0 || n === 0
      ? 0
      : jacobianRank(jacobian(hardSys, p, finalResiduals), n);
  const dof = Math.max(0, n - rank);

  const solved = entities.map((e): SketchEntity => {
    if (e.kind === "point") {
      const at = hardSys.index.points.get(e.id);
      if (at === undefined) return { ...e };
      return { ...e, x: p[at]!, y: p[at + 1]! };
    }
    if (e.kind === "circle") {
      const at = hardSys.index.radii.get(e.id)!;
      return { ...e, radius: p[at]! };
    }
    return { ...e };
  });

  return {
    entities: solved,
    converged,
    dof,
    maxResidual: hardSys.residuals.length > 0 && n > 0 ? maxAbs(finalResiduals) : 0,
  };
}

/**
 * Resolves a document-level constraint list (dimensional values as expression
 * strings) into solver-ready numeric constraints. `evalNum` is the caller's
 * expression evaluator (regen env in the worker, last parameter values in the
 * UI) — kept as a callback so this module stays decoupled from the parser.
 */
export function resolveSketchConstraints(
  constraints: readonly (Omit<SolvedConstraint, "value"> & { value?: string | number })[],
  evalNum: (expr: string) => number,
): SolvedConstraint[] {
  return constraints.map((c) => {
    if ("value" in c && c.value !== undefined) {
      const value = typeof c.value === "number" ? c.value : evalNum(c.value);
      return { ...c, value } as SolvedConstraint;
    }
    return c as SolvedConstraint;
  });
}

// --------------------------------------------------------------- loops

export type LoopSegment =
  | {
      kind: "line";
      a: { x: number; y: number };
      b: { x: number; y: number };
      /** Source sketch entity id (stable UUID) — the D2 curve key for this segment. */
      entityId?: string;
    }
  | {
      kind: "arc";
      center: { x: number; y: number };
      /** Walk direction: from a to b. */
      a: { x: number; y: number };
      b: { x: number; y: number };
      radius: number;
      /** true when traversal a→b runs counter-clockwise. */
      ccw: boolean;
      /** Source sketch entity id (stable UUID) — the D2 curve key for this segment. */
      entityId?: string;
    };

export interface SketchLoop {
  /** Canonical id: "loop:" + smallest member entity id. */
  id: string;
  segments: LoopSegment[];
}

/**
 * Extracts closed loops from solved entities. Circles are loops by
 * themselves (handled by the caller as circle profiles). Lines/arcs form a
 * graph over endpoints (nodes unified by coincident constraints); each
 * connected component whose nodes all have degree exactly 2 walks to an
 * ordered loop. Open chains (drawing in progress) yield nothing.
 */
export function extractLoops(
  entities: SketchEntity[],
  constraints: SolvedConstraint[],
): SketchLoop[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const pointOf = (id: string): SketchPointEnt | null => {
    const e = byId.get(id);
    return e && e.kind === "point" ? e : null;
  };

  // Union-find over point ids, merging coincident-constrained pairs.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of constraints) {
    if (c.kind === "coincident") union(c.a, c.b);
  }

  interface EdgeRec {
    id: string;
    n1: string;
    n2: string;
    ent: SketchLineEnt | SketchArcEnt;
  }
  const edges: EdgeRec[] = [];
  for (const e of entities) {
    if (e.kind === "line") edges.push({ id: e.id, n1: find(e.p1), n2: find(e.p2), ent: e });
    else if (e.kind === "arc") edges.push({ id: e.id, n1: find(e.start), n2: find(e.end), ent: e });
  }

  const incident = new Map<string, EdgeRec[]>();
  for (const e of edges) {
    if (e.n1 === e.n2) continue; // degenerate
    for (const n of [e.n1, e.n2]) {
      if (!incident.has(n)) incident.set(n, []);
      incident.get(n)!.push(e);
    }
  }

  const used = new Set<string>();
  const loops: SketchLoop[] = [];

  for (const start of edges) {
    if (used.has(start.id) || start.n1 === start.n2) continue;
    // Walk while every node has exactly 2 incident edges.
    const chain: { edge: EdgeRec; fromNode: string }[] = [];
    let node = start.n1;
    let edge: EdgeRec | undefined = start;
    const localSeen = new Set<string>();
    let closed = false;
    while (edge && !localSeen.has(edge.id)) {
      localSeen.add(edge.id);
      chain.push({ edge, fromNode: node });
      const next: string = edge.n1 === node ? edge.n2 : edge.n1;
      if (next === start.n1 && chain.length >= 2) {
        closed = true;
        break;
      }
      const inc: EdgeRec[] = incident.get(next) ?? [];
      if (inc.length !== 2) break; // dangling or junction — not a simple loop
      const candidate: EdgeRec = inc[0]!.id === edge.id ? inc[1]! : inc[0]!;
      node = next;
      edge = candidate;
    }
    if (!closed || chain.length < 2) continue;

    for (const { edge: e } of chain) used.add(e.id);

    const coord = (nodeId: string): { x: number; y: number } => {
      // Any member of the merged set has the solved coordinate; take the root's
      // entity if present, else scan for a member point.
      const direct = pointOf(nodeId);
      if (direct) return { x: direct.x, y: direct.y };
      for (const ent of entities) {
        if (ent.kind === "point" && find(ent.id) === nodeId) return { x: ent.x, y: ent.y };
      }
      throw new Error(`Loop node "${nodeId}" has no point entity`);
    };

    const segments: LoopSegment[] = chain.map(({ edge: e, fromNode }) => {
      const aNode = fromNode;
      const bNode = e.n1 === fromNode ? e.n2 : e.n1;
      const a = coord(aNode);
      const b = coord(bNode);
      if (e.ent.kind === "line") return { kind: "line", a, b, entityId: e.ent.id };
      const centerPt = pointOf(e.ent.center) ?? coord(find(e.ent.center));
      const radius = Math.hypot(a.x - centerPt.x, a.y - centerPt.y);
      // Stored ccw is for start→end; walking end→start flips it.
      const forward = find(e.ent.start) === aNode;
      return {
        kind: "arc",
        center: { x: centerPt.x, y: centerPt.y },
        a,
        b,
        radius,
        ccw: forward ? e.ent.ccw : !e.ent.ccw,
        entityId: e.ent.id,
      };
    });

    const smallest = chain
      .map(({ edge: e }) => e.id)
      .sort()
      .at(0)!;
    loops.push({ id: `loop:${smallest}`, segments });
  }

  return loops;
}

/** Midpoint of an arc segment along its traversal direction (for 3-point arc construction and sampling). */
export function arcMidpoint(seg: Extract<LoopSegment, { kind: "arc" }>): { x: number; y: number } {
  const a0 = Math.atan2(seg.a.y - seg.center.y, seg.a.x - seg.center.x);
  let a1 = Math.atan2(seg.b.y - seg.center.y, seg.b.x - seg.center.x);
  if (seg.ccw && a1 <= a0) a1 += 2 * Math.PI;
  if (!seg.ccw && a1 >= a0) a1 -= 2 * Math.PI;
  const mid = (a0 + a1) / 2;
  return {
    x: seg.center.x + seg.radius * Math.cos(mid),
    y: seg.center.y + seg.radius * Math.sin(mid),
  };
}

/** Samples a loop into a polygon (arcs → `arcSteps` chords) for area/containment tests. */
export function sampleLoopPolygon(loop: SketchLoop, arcSteps = 32): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const seg of loop.segments) {
    if (seg.kind === "line") {
      pts.push(seg.a);
      continue;
    }
    const a0 = Math.atan2(seg.a.y - seg.center.y, seg.a.x - seg.center.x);
    let a1 = Math.atan2(seg.b.y - seg.center.y, seg.b.x - seg.center.x);
    if (seg.ccw && a1 <= a0) a1 += 2 * Math.PI;
    if (!seg.ccw && a1 >= a0) a1 -= 2 * Math.PI;
    for (let i = 0; i < arcSteps; i++) {
      const t = a0 + ((a1 - a0) * i) / arcSteps;
      pts.push({
        x: seg.center.x + seg.radius * Math.cos(t),
        y: seg.center.y + seg.radius * Math.sin(t),
      });
    }
  }
  return pts;
}
