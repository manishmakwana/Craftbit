import { describe, expect, it } from "vitest";
import {
  type SketchEntity,
  type SolvedConstraint,
  arcMidpoint,
  extractLoops,
  sampleLoopPolygon,
  solveSketch,
} from "./sketchSolver";

const pt = (id: string, x: number, y: number): SketchEntity => ({ id, kind: "point", x, y });
const ln = (id: string, p1: string, p2: string): SketchEntity => ({ id, kind: "line", p1, p2 });

/** A roughly-drawn 4-line closed chain sharing corner points a,b,c,d. */
function roughQuad(): SketchEntity[] {
  return [
    pt("a", 0.3, -0.2),
    pt("b", 57, 2.1),
    pt("c", 61, 38),
    pt("d", -1.5, 41),
    ln("l1", "a", "b"),
    ln("l2", "b", "c"),
    ln("l3", "c", "d"),
    ln("l4", "d", "a"),
  ];
}

function quadConstraints(): SolvedConstraint[] {
  return [
    { id: "c1", kind: "fixed", point: "a" },
    { id: "c2", kind: "horizontal", line: "l1" },
    { id: "c3", kind: "horizontal", line: "l3" },
    { id: "c4", kind: "vertical", line: "l2" },
    { id: "c5", kind: "vertical", line: "l4" },
    { id: "c6", kind: "distance", a: "a", b: "b", value: 60 },
    { id: "c7", kind: "distance", a: "b", b: "c", value: 40 },
  ];
}

const solvedPoint = (r: { entities: SketchEntity[] }, id: string) => {
  const e = r.entities.find((x) => x.id === id);
  if (!e || e.kind !== "point") throw new Error("missing point " + id);
  return e;
};

describe("solveSketch", () => {
  it("solves a rough quad into an exact 60x40 rectangle", () => {
    const result = solveSketch(roughQuad(), quadConstraints());
    expect(result.converged).toBe(true);
    const a = solvedPoint(result, "a");
    const b = solvedPoint(result, "b");
    const c = solvedPoint(result, "c");
    const d = solvedPoint(result, "d");
    // Fixed corner stays put.
    expect(a.x).toBeCloseTo(0.3, 6);
    expect(a.y).toBeCloseTo(-0.2, 6);
    // Exact rectangle around it.
    expect(Math.abs(b.x - a.x)).toBeCloseTo(60, 5);
    expect(b.y).toBeCloseTo(a.y, 5);
    expect(Math.abs(c.y - b.y)).toBeCloseTo(40, 5);
    expect(c.x).toBeCloseTo(b.x, 5);
    expect(d.x).toBeCloseTo(a.x, 5);
    expect(d.y).toBeCloseTo(c.y, 5);
  });

  it("reports 0 DOF for the fully constrained quad and >0 when a dimension is removed", () => {
    const full = solveSketch(roughQuad(), quadConstraints());
    expect(full.dof).toBe(0);

    const missingOneDim = quadConstraints().filter((c) => c.id !== "c7");
    const partial = solveSketch(roughQuad(), missingOneDim);
    expect(partial.converged).toBe(true);
    expect(partial.dof).toBe(1);
  });

  it("keeps constraints satisfied while dragging (soft target loses to hard constraints)", () => {
    // Solve to a rectangle first, then drag corner c away diagonally.
    const first = solveSketch(roughQuad(), quadConstraints());
    const dragged = solveSketch(first.entities, quadConstraints(), {
      pointId: "c",
      x: 100,
      y: 90,
    });
    expect(dragged.converged).toBe(true);
    const a = solvedPoint(dragged, "a");
    const b = solvedPoint(dragged, "b");
    const c = solvedPoint(dragged, "c");
    // Distances are hard constraints — still exactly 60 and 40.
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(60, 4);
    expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeCloseTo(40, 4);
  });

  it("drags a free point of an under-constrained sketch to the target", () => {
    const entities = [pt("a", 0, 0), pt("b", 10, 0), ln("l1", "a", "b")];
    const constraints: SolvedConstraint[] = [{ id: "f", kind: "fixed", point: "a" }];
    const result = solveSketch(entities, constraints, { pointId: "b", x: 25, y: 5 });
    const b = solvedPoint(result, "b");
    expect(b.x).toBeCloseTo(25, 3);
    expect(b.y).toBeCloseTo(5, 3);
  });

  it("solves radius and tangent: line tangent to a dimensioned circle", () => {
    const entities: SketchEntity[] = [
      pt("p1", -20, 9), // horizontal-ish line above the circle
      pt("p2", 20, 11),
      ln("l1", "p1", "p2"),
      pt("cc", 0, 0),
      { id: "circ", kind: "circle", center: "cc", radius: 8 },
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "cc" },
      { id: "k2", kind: "radius", entity: "circ", value: 10 },
      { id: "k3", kind: "horizontal", line: "l1" },
      { id: "k4", kind: "tangent", line: "l1", circle: "circ" },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const circ = result.entities.find((e) => e.id === "circ");
    expect(circ?.kind === "circle" && circ.radius).toBeCloseTo(10, 5);
    const p1 = solvedPoint(result, "p1");
    const p2 = solvedPoint(result, "p2");
    expect(p2.y).toBeCloseTo(p1.y, 5);
    // Horizontal tangent line to a radius-10 circle at origin sits at |y| = 10.
    expect(Math.abs(p1.y)).toBeCloseTo(10, 4);
  });

  it("solves an angle constraint to the exact angle", () => {
    const entities: SketchEntity[] = [
      pt("o", 0, 0),
      pt("x", 30, 0),
      pt("q", 25, 12),
      ln("base", "o", "x"),
      ln("ray", "o", "q"),
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "o" },
      { id: "k2", kind: "fixed", point: "x" },
      { id: "k3", kind: "angle", a: "base", b: "ray", value: 45 },
      { id: "k4", kind: "distance", a: "o", b: "q", value: 20 },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const q = solvedPoint(result, "q");
    expect(q.x).toBeCloseTo(20 * Math.cos(Math.PI / 4), 4);
    expect(q.y).toBeCloseTo(20 * Math.sin(Math.PI / 4), 4);
  });

  it("diameter constraint drives a circle to half the given value in radius", () => {
    const entities: SketchEntity[] = [
      pt("cc", 0, 0),
      { id: "circ", kind: "circle", center: "cc", radius: 3 },
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "cc" },
      { id: "k2", kind: "diameter", entity: "circ", value: 16 },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const circ = result.entities.find((e) => e.id === "circ");
    expect(circ?.kind === "circle" && circ.radius).toBeCloseTo(8, 5);
  });

  it("lineDistance sets the perpendicular gap between two parallel lines", () => {
    const entities: SketchEntity[] = [
      pt("a", 0, 0),
      pt("b", 40, 0),
      pt("c", 3, 9), // second line roughly parallel, ~9 above
      pt("d", 44, 11),
      ln("l1", "a", "b"),
      ln("l2", "c", "d"),
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "a" },
      { id: "k2", kind: "fixed", point: "b" },
      { id: "k3", kind: "horizontal", line: "l2" },
      { id: "k4", kind: "lineDistance", a: "l1", b: "l2", value: 15 },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const c = solvedPoint(result, "c");
    const d = solvedPoint(result, "d");
    // Both endpoints of the horizontal second line sit 15 above the base line.
    expect(Math.abs(c.y)).toBeCloseTo(15, 4);
    expect(Math.abs(d.y)).toBeCloseTo(15, 4);
  });

  it("equalLength makes two lines the same length", () => {
    const entities: SketchEntity[] = [
      pt("a", 0, 0),
      pt("b", 50, 0),
      pt("c", 0, 20),
      pt("d", 27, 20),
      ln("l1", "a", "b"),
      ln("l2", "c", "d"),
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "a" },
      { id: "k2", kind: "fixed", point: "b" },
      { id: "k3", kind: "fixed", point: "c" },
      { id: "k4", kind: "horizontal", line: "l2" },
      { id: "k5", kind: "equalLength", a: "l1", b: "l2" },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const c = solvedPoint(result, "c");
    const d = solvedPoint(result, "d");
    expect(Math.hypot(d.x - c.x, d.y - c.y)).toBeCloseTo(50, 5);
  });

  it("least change: editing one angle on an under-constrained quad stays near the drawn shape", () => {
    // Parallelogram with only a fixed corner, top-edge width, and one angle —
    // heavily under-constrained (like a freehand sketch). Without a
    // least-change bias the solver flings the free corners to a far valid
    // configuration (bounding box exploding to ~600 tall); the anchor keeps
    // the solution near the drawn geometry.
    const quad = (): SketchEntity[] => [
      pt("A", 0, 0),
      pt("B", 160, 0),
      pt("C", 190, -90),
      pt("D", 30, -90),
      ln("AB", "A", "B"),
      ln("BC", "B", "C"),
      ln("CD", "C", "D"),
      ln("DA", "D", "A"),
    ];
    const base: SolvedConstraint[] = [
      { id: "f", kind: "fixed", point: "A" },
      { id: "w", kind: "distance", a: "A", b: "B", value: 160 },
    ];
    const height = (r: { entities: SketchEntity[] }) => {
      const ys = r.entities.flatMap((e) => (e.kind === "point" ? [e.y] : []));
      return Math.max(...ys) - Math.min(...ys);
    };
    const s0 = solveSketch(quad(), [
      ...base,
      { id: "a", kind: "angle", a: "AB", b: "BC", value: -108 },
    ]);
    expect(s0.converged).toBe(true);
    // Drawn height is 90; a runaway solve reaches many hundreds.
    expect(height(s0)).toBeLessThan(200);

    // Now change the angle — the shape must adjust, not explode.
    const s1 = solveSketch(s0.entities, [
      ...base,
      { id: "a", kind: "angle", a: "AB", b: "BC", value: -150 },
    ]);
    expect(s1.converged).toBe(true);
    expect(height(s1)).toBeLessThan(200);
    // The anchored corners stay put; the constraint is still satisfied.
    expect(solvedPoint(s1, "A")).toMatchObject({ x: 0, y: 0 });
    expect(solvedPoint(s1, "B").x).toBeCloseTo(160, 0);
  });

  it("reports non-convergence for contradictory constraints", () => {
    const entities = [pt("a", 0, 0), pt("b", 10, 0), ln("l1", "a", "b")];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "a" },
      { id: "k2", kind: "distance", a: "a", b: "b", value: 10 },
      { id: "k3", kind: "distance", a: "a", b: "b", value: 20 }, // contradiction
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(false);
  });

  it("solves arcs: implicit radius residuals keep endpoints on the circle", () => {
    const entities: SketchEntity[] = [
      pt("c", 0, 0),
      pt("s", 9, 1), // roughly on a radius-10 arc
      pt("e", -1, 10.5),
      { id: "arc1", kind: "arc", center: "c", start: "s", end: "e", ccw: true },
    ];
    const constraints: SolvedConstraint[] = [
      { id: "k1", kind: "fixed", point: "c" },
      { id: "k2", kind: "radius", entity: "arc1", value: 10 },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const s = solvedPoint(result, "s");
    const e = solvedPoint(result, "e");
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(10, 5);
    expect(Math.hypot(e.x, e.y)).toBeCloseTo(10, 5);
  });
});

describe("extractLoops", () => {
  it("extracts one ordered loop from a closed 4-line chain and none from an open one", () => {
    const closed = extractLoops(
      [
        pt("a", 0, 0),
        pt("b", 60, 0),
        pt("c", 60, 40),
        pt("d", 0, 40),
        ln("l1", "a", "b"),
        ln("l2", "b", "c"),
        ln("l3", "c", "d"),
        ln("l4", "d", "a"),
      ],
      [],
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.segments).toHaveLength(4);
    expect(closed[0]!.id).toBe("loop:l1");
    // Sampled polygon area is the rectangle's.
    const poly = sampleLoopPolygon(closed[0]!);
    let area = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      area += (poly[j]!.x - poly[i]!.x) * (poly[j]!.y + poly[i]!.y);
    }
    expect(Math.abs(area / 2)).toBeCloseTo(2400, 6);

    const open = extractLoops(
      [pt("a", 0, 0), pt("b", 60, 0), pt("c", 60, 40), ln("l1", "a", "b"), ln("l2", "b", "c")],
      [],
    );
    expect(open).toHaveLength(0);
  });

  it("unifies endpoints via coincident constraints", () => {
    // Chain drawn as separate lines whose endpoints are constrained together.
    const loops = extractLoops(
      [
        pt("a1", 0, 0),
        pt("b1", 60, 0),
        pt("b2", 60, 0),
        pt("c1", 60, 40),
        pt("c2", 60, 40),
        pt("a2", 0, 0),
        ln("l1", "a1", "b1"),
        ln("l2", "b2", "c1"),
        ln("l3", "c2", "a2"),
      ],
      [
        { id: "k1", kind: "coincident", a: "b1", b: "b2" },
        { id: "k2", kind: "coincident", a: "c1", b: "c2" },
        { id: "k3", kind: "coincident", a: "a2", b: "a1" },
      ],
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]!.segments).toHaveLength(3);
  });

  it("extracts a slot loop with arcs and computes on-arc midpoints", () => {
    // Slot: two horizontal lines + two semicircular arc caps, radius 10.
    const loops = extractLoops(
      [
        pt("a", 0, -10),
        pt("b", 40, -10),
        pt("c", 40, 10),
        pt("d", 0, 10),
        pt("cl", 0, 0),
        pt("cr", 40, 0),
        ln("top", "d", "c"),
        ln("bottom", "a", "b"),
        { id: "capR", kind: "arc", center: "cr", start: "b", end: "c", ccw: true },
        { id: "capL", kind: "arc", center: "cl", start: "d", end: "a", ccw: true },
      ],
      [],
    );
    expect(loops).toHaveLength(1);
    const segs = loops[0]!.segments;
    expect(segs).toHaveLength(4);
    const arcs = segs.filter((s) => s.kind === "arc");
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) {
      expect(arc.kind === "arc" && arc.radius).toBeCloseTo(10, 6);
      if (arc.kind === "arc") {
        const mid = arcMidpoint(arc);
        // Midpoint is on the circle...
        expect(Math.hypot(mid.x - arc.center.x, mid.y - arc.center.y)).toBeCloseTo(10, 6);
        // ...and on the cap side (outside the slot's line span), i.e. |x - cx| = 10.
        expect(Math.abs(mid.x - arc.center.x)).toBeCloseTo(10, 4);
      }
    }
    // Sampled area: rectangle 40x20 + full circle of r=10 from the two caps.
    const poly = sampleLoopPolygon(loops[0]!, 256);
    let area = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      area += (poly[j]!.x - poly[i]!.x) * (poly[j]!.y + poly[i]!.y);
    }
    expect(Math.abs(area / 2)).toBeCloseTo(40 * 20 + Math.PI * 100, 0);
  });
});
