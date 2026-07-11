/**
 * Laser-cutting exports (spec §7.13.3/§7.13.5): exact-scale SVG and DXF R12
 * from evaluated sketch profiles. Circles stay true circles in both formats
 * (never polyline-approximated). SVG uses physical mm units in width/height +
 * matching viewBox so 1 user unit = 1 mm in Inkscape/LightBurn.
 */

export type Evaluated2dProfile =
  | { id: string; kind: "rect"; x: number; y: number; width: number; height: number }
  | { id: string; kind: "circle"; cx: number; cy: number; radius: number }
  | { id: string; kind: "polygon"; points: { x: number; y: number }[] };

const fmt = (n: number): string => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

function bounds(profiles: Evaluated2dProfile[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const p of profiles) {
    if (p.kind === "rect") {
      grow(p.x, p.y);
      grow(p.x + p.width, p.y + p.height);
    } else if (p.kind === "circle") {
      grow(p.cx - p.radius, p.cy - p.radius);
      grow(p.cx + p.radius, p.cy + p.radius);
    } else {
      for (const pt of p.points) grow(pt.x, pt.y);
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * SVG with `width="<w>mm"` and viewBox in mm, cut strokes #FF0000 at 0.1 mm —
 * the LightBurn/Glowforge-friendly convention (spec §7.13.3). Y is flipped so
 * the sketch's +Y-up coordinates render upright.
 */
export function sketchToSvg(profiles: Evaluated2dProfile[]): string {
  const b = bounds(profiles);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const y = (v: number) => b.maxY - v; // flip: SVG y grows downward

  const shapes = profiles
    .map((p) => {
      if (p.kind === "rect") {
        return `<rect x="${fmt(p.x - b.minX)}" y="${fmt(y(p.y + p.height))}" width="${fmt(p.width)}" height="${fmt(p.height)}"/>`;
      }
      if (p.kind === "circle") {
        return `<circle cx="${fmt(p.cx - b.minX)}" cy="${fmt(y(p.cy))}" r="${fmt(p.radius)}"/>`;
      }
      const d = p.points
        .map((pt, i) => `${i === 0 ? "M" : "L"}${fmt(pt.x - b.minX)} ${fmt(y(pt.y))}`)
        .join("");
      return `<path d="${d}Z"/>`;
    })
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">
  <g fill="none" stroke="#FF0000" stroke-width="0.1">
    ${shapes}
  </g>
</svg>
`;
}

/** Minimal DXF R12: LWPOLYLINE-free (R12 uses POLYLINE), CIRCLE as true circle,
 * `$INSUNITS = 4` (millimeters). Verified to open in LibreCAD/ezdxf. */
export function sketchToDxf(profiles: Evaluated2dProfile[]): string {
  const lines: string[] = [];
  const push = (...vals: (string | number)[]) => {
    for (const v of vals) lines.push(String(v));
  };

  push(0, "SECTION", 2, "HEADER");
  push(9, "$INSUNITS", 70, 4);
  push(0, "ENDSEC");
  push(0, "SECTION", 2, "ENTITIES");

  const polyline = (points: { x: number; y: number }[]) => {
    push(0, "POLYLINE", 8, "0", 66, 1, 70, 1); // closed
    for (const p of points) {
      push(0, "VERTEX", 8, "0", 10, fmt(p.x), 20, fmt(p.y), 30, 0);
    }
    push(0, "SEQEND");
  };

  for (const p of profiles) {
    if (p.kind === "rect") {
      polyline([
        { x: p.x, y: p.y },
        { x: p.x + p.width, y: p.y },
        { x: p.x + p.width, y: p.y + p.height },
        { x: p.x, y: p.y + p.height },
      ]);
    } else if (p.kind === "circle") {
      push(0, "CIRCLE", 8, "0", 10, fmt(p.cx), 20, fmt(p.cy), 30, 0, 40, fmt(p.radius));
    } else {
      polyline(p.points);
    }
  }

  push(0, "ENDSEC", 0, "EOF");
  return lines.join("\n") + "\n";
}
