import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CUBE_HALF_EXTENT,
  ZONE_THRESHOLD_RATIO,
  axisForTransition,
  classifyHit,
  makeOrientationInterpolator,
  upForDir,
} from "./viewCube";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const t = CUBE_HALF_EXTENT * ZONE_THRESHOLD_RATIO;

describe("classifyHit", () => {
  it("classifies the 6 pure faces", () => {
    expect(classifyHit(v(CUBE_HALF_EXTENT, 0, 0))?.kind).toBe("face");
    expect(classifyHit(v(CUBE_HALF_EXTENT, 0, 0))?.dir.toArray()).toEqual([1, 0, 0]);
    expect(classifyHit(v(-CUBE_HALF_EXTENT, 0, 0))?.dir.toArray()).toEqual([-1, 0, 0]);
    expect(classifyHit(v(0, CUBE_HALF_EXTENT, 0))?.dir.toArray()).toEqual([0, 1, 0]);
    expect(classifyHit(v(0, -CUBE_HALF_EXTENT, 0))?.dir.toArray()).toEqual([0, -1, 0]);
    expect(classifyHit(v(0, 0, CUBE_HALF_EXTENT))?.dir.toArray()).toEqual([0, 0, 1]);
    expect(classifyHit(v(0, 0, -CUBE_HALF_EXTENT))?.dir.toArray()).toEqual([0, 0, -1]);
  });

  it("classifies the 12 edges (two axes pulled)", () => {
    const hit = classifyHit(v(CUBE_HALF_EXTENT, CUBE_HALF_EXTENT, 0));
    expect(hit?.kind).toBe("edge");
    expect(hit?.dir.x).toBeCloseTo(1 / Math.sqrt(2));
    expect(hit?.dir.y).toBeCloseTo(1 / Math.sqrt(2));
    expect(hit?.dir.z).toBe(0);
  });

  it("classifies the 8 corners (three axes pulled)", () => {
    const hit = classifyHit(v(CUBE_HALF_EXTENT, CUBE_HALF_EXTENT, CUBE_HALF_EXTENT));
    expect(hit?.kind).toBe("corner");
    const expected = 1 / Math.sqrt(3);
    expect(hit?.dir.x).toBeCloseTo(expected);
    expect(hit?.dir.y).toBeCloseTo(expected);
    expect(hit?.dir.z).toBeCloseTo(expected);
  });

  it("treats points near center (below threshold on all axes) as no zone", () => {
    expect(classifyHit(v(0, 0, 0))).toBeNull();
    expect(classifyHit(v(t * 0.5, t * 0.5, t * 0.5))).toBeNull();
  });

  it("is decisive right at the threshold boundary", () => {
    // Just above threshold on one axis only -> a face.
    expect(classifyHit(v(t + 0.001, 0, 0))?.kind).toBe("face");
    // Just below threshold -> no pull on that axis.
    expect(classifyHit(v(t - 0.001, 0, 0))).toBeNull();
  });

  it("covers all 26 zones without gaps or overlap", () => {
    const seen = new Set<string>();
    for (const sx of [-1, 0, 1]) {
      for (const sy of [-1, 0, 1]) {
        for (const sz of [-1, 0, 1]) {
          if (sx === 0 && sy === 0 && sz === 0) continue;
          const point = v(sx * CUBE_HALF_EXTENT, sy * CUBE_HALF_EXTENT, sz * CUBE_HALF_EXTENT);
          const hit = classifyHit(point);
          expect(hit).not.toBeNull();
          const axes = Math.abs(sx) + Math.abs(sy) + Math.abs(sz);
          const expectedKind = axes === 1 ? "face" : axes === 2 ? "edge" : "corner";
          expect(hit!.kind).toBe(expectedKind);
          seen.add(`${hit!.dir.x.toFixed(3)},${hit!.dir.y.toFixed(3)},${hit!.dir.z.toFixed(3)}`);
        }
      }
    }
    expect(seen.size).toBe(26);
  });
});

describe("upForDir", () => {
  it("uses +Y for TOP and -Y for BOTTOM", () => {
    expect(upForDir(v(0, 0, 1)).toArray()).toEqual([0, 1, 0]);
    expect(upForDir(v(0, 0, -1)).toArray()).toEqual([0, -1, 0]);
  });

  it("uses world +Z for every other direction", () => {
    expect(upForDir(v(0, -1, 0)).toArray()).toEqual([0, 0, 1]);
    expect(upForDir(v(1, 0, 0)).toArray()).toEqual([0, 0, 1]);
    expect(upForDir(v(1, 1, 1).normalize()).toArray()).toEqual([0, 0, 1]);
  });
});

describe("axisForTransition", () => {
  it("picks the geometric cross-product axis for a normal transition", () => {
    const axis = axisForTransition(v(1, 0, 0), v(0, 1, 0), v(0, 0, 1));
    expect(axis.toArray()).toEqual([0, 0, 1]);
  });

  it("routes 180-degree flips over the current up vector instead of failing", () => {
    const from = v(0, -1, 0);
    const to = v(0, 1, 0);
    const up = v(0, 0, 1);
    const axis = axisForTransition(from, to, up);
    // Cross(from, up) should be well-defined and orthogonal to `from`.
    expect(axis.length()).toBeCloseTo(1);
    expect(axis.dot(from)).toBeCloseTo(0);
  });

  it("never returns a zero-length axis even in the fully-degenerate case", () => {
    const from = v(0, 0, 1);
    const axis = axisForTransition(from, v(0, 0, -1), v(0, 0, 1));
    expect(axis.length()).toBeCloseTo(1);
  });
});

describe("makeOrientationInterpolator", () => {
  it("starts at fromDir/fromUp and ends at toDir/toUp", () => {
    const interp = makeOrientationInterpolator(v(0, -1, 0), v(1, 0, 0), v(0, 0, 1), v(0, 0, 1));
    const start = interp(0);
    expect(start.dir.x).toBeCloseTo(0);
    expect(start.dir.y).toBeCloseTo(-1);
    const end = interp(1);
    expect(end.dir.x).toBeCloseTo(1);
    expect(end.dir.y).toBeCloseTo(0, 5);
  });

  it("stays a unit vector throughout the transition", () => {
    const interp = makeOrientationInterpolator(v(0, 0, 1), v(0, 0, -1), v(0, 1, 0), v(0, -1, 0));
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = interp(p);
      expect(frame.dir.length()).toBeCloseTo(1);
      expect(frame.up.length()).toBeCloseTo(1);
    }
  });

  it("clamps progress outside [0, 1]", () => {
    const interp = makeOrientationInterpolator(v(1, 0, 0), v(0, 1, 0), v(0, 0, 1), v(0, 0, 1));
    expect(interp(-1).dir.toArray()).toEqual(interp(0).dir.toArray());
    expect(interp(2).dir.toArray()).toEqual(interp(1).dir.toArray());
  });
});
