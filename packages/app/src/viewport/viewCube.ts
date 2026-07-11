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

/** Generates a label texture for one cube face on an offscreen canvas. */
function makeFaceTexture(
  label: string,
  colors: { bg: string; text: string; border: string },
): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  ctx.fillStyle = colors.text;
  ctx.font = "600 34px Inter, system-ui, sans-serif";
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
  hoverPatch: THREE.Mesh;
  setHover(zone: CubeZone | null): void;
  dispose(): void;
}

/** Builds the small self-contained scene rendered in the corner inset. */
export function buildViewCubeScene(colors: CubeColors): ViewCubeScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);

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

  // Reused translucent patch for hover highlight, repositioned per zone.
  const hoverGeom = new THREE.PlaneGeometry(1, 1);
  const hoverMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colors.hover),
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const hoverPatch = new THREE.Mesh(hoverGeom, hoverMat);
  hoverPatch.visible = false;
  hoverPatch.renderOrder = 10;
  scene.add(hoverPatch);

  const setHover = (zone: CubeZone | null) => {
    if (!zone) {
      hoverPatch.visible = false;
      return;
    }
    hoverPatch.visible = true;
    // Patch size scales with zone kind: full face, edge strip, or corner nub.
    const extent = CUBE_HALF_EXTENT * 2 + 0.02;
    const faceScale =
      zone.kind === "face" ? extent : zone.kind === "edge" ? extent * 0.5 : extent * 0.32;
    hoverPatch.scale.set(faceScale, faceScale, 1);
    hoverPatch.position.copy(zone.dir).multiplyScalar(CUBE_HALF_EXTENT + 0.01);
    hoverPatch.lookAt(0, 0, 0);
  };

  return {
    scene,
    camera,
    mesh,
    hoverPatch,
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
