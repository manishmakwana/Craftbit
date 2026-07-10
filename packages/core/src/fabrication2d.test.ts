import { describe, expect, it } from "vitest";
import { sketchToDxf, sketchToSvg, type Evaluated2dProfile } from "./fabrication2d";

const panel: Evaluated2dProfile[] = [
  { id: "r", kind: "rect", x: 0, y: 0, width: 120, height: 60 },
  { id: "c", kind: "circle", cx: 60, cy: 30, radius: 5 },
];

describe("sketchToSvg", () => {
  it("emits exact physical mm dimensions (GP-2 / spec §7.13.3 AC2)", () => {
    const svg = sketchToSvg(panel);
    expect(svg).toContain(`width="120mm"`);
    expect(svg).toContain(`height="60mm"`);
    expect(svg).toContain(`viewBox="0 0 120 60"`);
  });

  it("keeps circles as true circles with correct placement", () => {
    const svg = sketchToSvg(panel);
    expect(svg).toContain(`<circle cx="60" cy="30" r="5"/>`);
  });

  it("uses the red 0.1mm cut-stroke convention", () => {
    const svg = sketchToSvg(panel);
    expect(svg).toContain(`stroke="#FF0000"`);
    expect(svg).toContain(`stroke-width="0.1"`);
    expect(svg).toContain(`fill="none"`);
  });

  it("flips Y so sketch up renders up", () => {
    const svg = sketchToSvg([
      { id: "r", kind: "rect", x: 0, y: 0, width: 10, height: 10 },
      { id: "c", kind: "circle", cx: 2, cy: 8, radius: 1 }, // top-left in sketch coords
    ]);
    // Sketch y=8 (near top) → SVG y = maxY - 8 = 2 (near top in SVG coords too)
    expect(svg).toContain(`<circle cx="2" cy="2" r="1"/>`);
  });
});

describe("sketchToDxf", () => {
  it("declares millimeter units and R12 entities", () => {
    const dxf = sketchToDxf(panel);
    expect(dxf).toContain("$INSUNITS");
    expect(dxf.split("\n")).toContain("CIRCLE");
    expect(dxf.split("\n")).toContain("POLYLINE");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });

  it("emits the circle as a true CIRCLE entity with exact radius", () => {
    const dxf = sketchToDxf(panel);
    const lines = dxf.split("\n");
    const ci = lines.indexOf("CIRCLE");
    const section = lines.slice(ci, ci + 12).join("\n");
    expect(section).toContain("40\n5"); // group 40 = radius
  });

  it("closes polylines (flag 70 = 1)", () => {
    const dxf = sketchToDxf(panel);
    const lines = dxf.split("\n");
    const pi = lines.indexOf("POLYLINE");
    expect(lines.slice(pi, pi + 8).join("\n")).toContain("70\n1");
  });
});
