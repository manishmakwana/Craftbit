/**
 * Fusion 360-style ViewCube (spec D7): a small cube rendered in a corner
 * inset that mirrors the main camera orientation. Clicking a face/edge/
 * corner reorients the camera; dragging orbits it. This module is kept
 * framework- and SceneManager-free so its zone/orientation math is
 * unit-testable without WebGL.
 */

import * as THREE from "three";

/** How many of the 3 local axes are "pulled" toward a face — 1/2/3 → face/edge/corner. */
export type ZoneKind = "face" | "edge" | "corner";

export interface CubeZone {
  kind: ZoneKind;
  /** Unit view direction: camera looks from `target + dir * distance` toward `target`. */
  dir: THREE.Vector3;
}

/** Face labels for the 6 pure-face zones, keyed by their direction (Fusion mapping, Z-up world). */
export const FACE_LABELS: Record<string, string> = {
  "0,0,1": "TOP",
  "0,0,-1": "BOTTOM",
  "0,-1,0": "FRONT",
  "0,1,0": "BACK",
  "1,0,0": "RIGHT",
  "-1,0,0": "LEFT",
};

/** Half-extent of the cube geometry used for hit classification. */
export const CUBE_HALF_EXTENT = 0.7;
/** Fraction of the half-extent beyond which an axis counts as "pulled" toward that face. */
export const ZONE_THRESHOLD_RATIO = 0.6;

/** Vertical FOV (degrees) of the small camera used to render the cube inset. */
export const CUBE_CAMERA_FOV_DEG = 30;
/**
 * Distance from the cube camera to the cube center. Must clear the cube's
 * circumscribed sphere (corner-to-center = CUBE_HALF_EXTENT * sqrt(3)) with
 * margin at CUBE_CAMERA_FOV_DEG, or a corner-on view overflows the frustum
 * and gets hard-clipped by the inset's scissor rect. At FOV 30 / distance 6
 * the visible half-height is ~1.61 vs. the cube's ~1.21 corner radius (33%
 * margin) — distance 3 (the previous value) gave only 0.75, well short.
 */
export const CUBE_CAMERA_DISTANCE = 6;

/**
 * Classifies a local-space hit point on the cube into a face/edge/corner
 * zone. Returns null only if the point is at the exact center (degenerate;
 * cannot happen for a real surface hit).
 */
export function classifyHit(localPoint: THREE.Vector3): CubeZone | null {
  const t = CUBE_HALF_EXTENT * ZONE_THRESHOLD_RATIO;
  const sx = Math.abs(localPoint.x) > t ? Math.sign(localPoint.x) : 0;
  const sy = Math.abs(localPoint.y) > t ? Math.sign(localPoint.y) : 0;
  const sz = Math.abs(localPoint.z) > t ? Math.sign(localPoint.z) : 0;
  const axes = Math.abs(sx) + Math.abs(sy) + Math.abs(sz);
  if (axes === 0) return null;
  const dir = new THREE.Vector3(sx, sy, sz).normalize();
  const kind: ZoneKind = axes === 1 ? "face" : axes === 2 ? "edge" : "corner";
  return { kind, dir };
}

/**
 * Up-vector rule for a given view direction in Z-up world space (D7 §2.4).
 * TOP/BOTTOM use +/-Y as up (so BACK reads away from the viewer, matching
 * Fusion's convention); every other view keeps world +Z as up.
 */
export function upForDir(dir: THREE.Vector3): THREE.Vector3 {
  if (dir.z > 0.99) return new THREE.Vector3(0, 1, 0);
  if (dir.z < -0.99) return new THREE.Vector3(0, -1, 0);
  return new THREE.Vector3(0, 0, 1);
}

/**
 * Picks a rotation axis for interpolating between two view directions.
 * When the directions are (near-)antipodal the great-circle path is
 * undefined, so we deliberately route the flip through the current up
 * vector rather than an arbitrary/unstable axis.
 */
export function axisForTransition(
  fromDir: THREE.Vector3,
  toDir: THREE.Vector3,
  fallbackUp: THREE.Vector3,
): THREE.Vector3 {
  const cross = new THREE.Vector3().crossVectors(fromDir, toDir);
  if (cross.lengthSq() > 1e-6) return cross.normalize();
  // Antipodal (or identical): swing over the top using `fallbackUp`.
  const axis = new THREE.Vector3().crossVectors(fromDir, fallbackUp);
  if (axis.lengthSq() > 1e-6) return axis.normalize();
  // fallbackUp is also parallel to fromDir (shouldn't happen with our rules) — pick any orthogonal axis.
  return new THREE.Vector3(1, 0, 0).cross(fromDir).lengthSq() > 1e-6
    ? new THREE.Vector3(1, 0, 0).cross(fromDir).normalize()
    : new THREE.Vector3(0, 1, 0);
}

/** Exported so callers can apply the identical easing curve to companion
 * values (e.g. camera target/distance) that animate alongside direction/up. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export interface OrientationFrame {
  dir: THREE.Vector3;
  up: THREE.Vector3;
}

/**
 * Builds an interpolator for an eased camera-direction + up-vector
 * transition. `progress` is 0..1 linear time; returns the eased frame.
 * Rotates `fromDir` toward `toDir` around a fixed axis chosen up front
 * (stable throughout the animation, unlike re-deriving it every frame).
 *
 * Up vectors are lerped directly except in the one case that breaks that:
 * the TOP<->BOTTOM flip, where fromUp/toUp are antiparallel and their
 * midpoint lerp is the zero vector. In our up-vector rule set (`upForDir`)
 * that only happens together with fromDir/toDir also being antipodal, so
 * `axis` (already perpendicular to fromUp, chosen via the fallback branch
 * of `axisForTransition`) doubles as a valid rotation axis for up too, and
 * the same 180-degree sweep takes fromUp to toUp exactly.
 */
export function makeOrientationInterpolator(
  fromDir: THREE.Vector3,
  toDir: THREE.Vector3,
  fromUp: THREE.Vector3,
  toUp: THREE.Vector3,
): (progress: number) => OrientationFrame {
  const axis = axisForTransition(fromDir, toDir, fromUp);
  const fullAngle = fromDir.angleTo(toDir);
  const upsAntiparallel = fromUp.dot(toUp) < -0.999;
  return (progress: number): OrientationFrame => {
    const p = easeInOutCubic(Math.min(1, Math.max(0, progress)));
    const q = new THREE.Quaternion().setFromAxisAngle(axis, fullAngle * p);
    const dir = fromDir.clone().applyQuaternion(q).normalize();
    const up = upsAntiparallel
      ? fromUp.clone().applyQuaternion(q).normalize()
      : fromUp.clone().lerp(toUp, p).normalize();
    return { dir, up };
  };
}

/** Lightens (positive `lDelta`) or darkens (negative) a CSS color by HSL lightness offset. */
function shade(color: string, lDelta: number): string {
  const c = new THREE.Color(color);
  c.offsetHSL(0, 0, lDelta);
  return c.getStyle();
}

/** Generates a label texture for one cube face on an offscreen canvas. A soft
 * diagonal gradient (rather than a flat fill) gives the face a subtle sheen,
 * closer to Fusion 360's cube than a flat color swatch. */
function makeFaceTexture(
  label: string,
  colors: { bg: string; text: string; border: string },
): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, shade(colors.bg, 0.06));
  grad.addColorStop(1, shade(colors.bg, -0.04));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  ctx.fillStyle = colors.text;
  ctx.font = "600 32px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Order matching THREE.BoxGeometry's material index convention: +x -x +y -y +z -z. */
const BOX_FACE_DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

type Axis = 0 | 1 | 2;

/** One rectangular patch lying flush on a single cube face, in that face's
 * own (u, v) coordinates (the two axes other than its normal). */
export interface HighlightRect {
  axis: Axis;
  sign: 1 | -1;
  uAxis: Axis;
  vAxis: Axis;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/**
 * Decomposes a zone into 1–3 face-local rectangles (one per contributing
 * face) whose union is exactly the zone's hit-test region from
 * `classifyHit`, so the hover highlight is WYSIWYG with what's clickable:
 * a face zone lights a centered square on its one face; an edge zone lights
 * a strip on each of its two faces, flush against their shared edge; a
 * corner zone lights a small square in the corner of each of its three
 * faces. (The previous implementation placed a single oversized plane at
 * `zone.dir * distance`, which for edge/corner zones is a point *inside*
 * the cube, not on any face — hence the floating, misaligned patch.)
 */
export function highlightRectsForZone(zone: CubeZone): HighlightRect[] {
  const h = CUBE_HALF_EXTENT;
  const t = h * ZONE_THRESHOLD_RATIO;
  const signOf = (c: number): -1 | 0 | 1 => (Math.abs(c) < 1e-6 ? 0 : c > 0 ? 1 : -1);
  const comps: [-1 | 0 | 1, -1 | 0 | 1, -1 | 0 | 1] = [
    signOf(zone.dir.x),
    signOf(zone.dir.y),
    signOf(zone.dir.z),
  ];
  // Non-pulled axes span the central band [-t, t]; pulled axes span the
  // outer band between the threshold and the cube edge, on the pulled side.
  const range = (compSign: -1 | 0 | 1): [number, number] => {
    if (compSign === 0) return [-t, t];
    const a = compSign * t;
    const b = compSign * h;
    return a < b ? [a, b] : [b, a];
  };
  const rects: HighlightRect[] = [];
  for (const axis of [0, 1, 2] as const) {
    const sign = comps[axis];
    if (sign === 0) continue;
    const [uAxis, vAxis] = ([0, 1, 2] as const).filter((a) => a !== axis) as [Axis, Axis];
    const [uMin, uMax] = range(comps[uAxis]);
    const [vMin, vMax] = range(comps[vAxis]);
    rects.push({ axis, sign, uAxis, vAxis, uMin, uMax, vMin, vMax });
  }
  return rects;
}

function axisVector(axis: Axis, sign = 1): THREE.Vector3 {
  const v = new THREE.Vector3();
  v.setComponent(axis, sign);
  return v;
}

export interface CubeColors {
  bg: string;
  text: string;
  border: string;
  wireframe: string;
  hover: string;
}

export interface ViewCubeScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh;
  setHover(zone: CubeZone | null): void;
  dispose(): void;
}

/** Max simultaneous highlight patches — a corner zone touches 3 faces. */
const HIGHLIGHT_POOL_SIZE = 3;
/** Nudges patches just off the cube surface to avoid z-fighting with the face texture. */
const HIGHLIGHT_SURFACE_OFFSET = 0.006;

/** Builds the small self-contained scene rendered in the corner inset. */
export function buildViewCubeScene(colors: CubeColors): ViewCubeScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CUBE_CAMERA_FOV_DEG, 1, 0.1, 20);

  const geometry = new THREE.BoxGeometry(
    CUBE_HALF_EXTENT * 2,
    CUBE_HALF_EXTENT * 2,
    CUBE_HALF_EXTENT * 2,
  );
  const materials = BOX_FACE_DIRS.map((dirArr) => {
    const dir = new THREE.Vector3(...dirArr);
    const label = FACE_LABELS[`${dir.x},${dir.y},${dir.z}`] ?? "";
    const texture = makeFaceTexture(label, colors);
    return new THREE.MeshBasicMaterial({ map: texture });
  });
  const mesh = new THREE.Mesh(geometry, materials);
  scene.add(mesh);

  const wireGeom = new THREE.EdgesGeometry(geometry);
  const wire = new THREE.LineSegments(
    wireGeom,
    new THREE.LineBasicMaterial({ color: new THREE.Color(colors.wireframe) }),
  );
  scene.add(wire);

  // A small pool of reused flush face-patches — one per contributing face —
  // rather than a single plane, so edge/corner highlights sit exactly on the
  // cube's surface instead of floating at a point inside it.
  const hoverGeom = new THREE.PlaneGeometry(1, 1);
  const hoverMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colors.hover),
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const hoverPatches: THREE.Mesh[] = [];
  for (let i = 0; i < HIGHLIGHT_POOL_SIZE; i++) {
    const patch = new THREE.Mesh(hoverGeom, hoverMat);
    patch.visible = false;
    patch.renderOrder = 10;
    scene.add(patch);
    hoverPatches.push(patch);
  }

  const setHover = (zone: CubeZone | null) => {
    const rects = zone ? highlightRectsForZone(zone) : [];
    for (let i = 0; i < hoverPatches.length; i++) {
      const patch = hoverPatches[i]!;
      const rect = rects[i];
      if (!rect) {
        patch.visible = false;
        continue;
      }
      patch.visible = true;
      const basis = new THREE.Matrix4().makeBasis(
        axisVector(rect.uAxis),
        axisVector(rect.vAxis),
        axisVector(rect.axis, rect.sign),
      );
      patch.quaternion.setFromRotationMatrix(basis);
      patch.scale.set(rect.uMax - rect.uMin, rect.vMax - rect.vMin, 1);
      const center = new THREE.Vector3();
      center.setComponent(rect.axis, rect.sign * (CUBE_HALF_EXTENT + HIGHLIGHT_SURFACE_OFFSET));
      center.setComponent(rect.uAxis, (rect.uMin + rect.uMax) / 2);
      center.setComponent(rect.vAxis, (rect.vMin + rect.vMax) / 2);
      patch.position.copy(center);
    }
  };

  return {
    scene,
    camera,
    mesh,
    setHover,
    dispose: () => {
      geometry.dispose();
      wireGeom.dispose();
      hoverGeom.dispose();
      hoverMat.dispose();
      for (const m of materials) {
        m.map?.dispose();
        m.dispose();
      }
    },
  };
}
