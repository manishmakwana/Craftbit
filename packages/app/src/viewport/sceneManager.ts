/**
 * Imperative Three.js scene management for the viewport. React owns the
 * lifecycle; this class owns the render loop, scene graph, picking, and the
 * sketch-plane math. Kept framework-free for testability.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { BodyResult, EvaluatedSketch, RegenResult } from "@craftbit/geometry-worker";

export interface PickResult {
  kind: "face" | "edge";
  bodyId: string;
  index: number;
}

interface BodyObjects {
  body: BodyResult;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  /** Maps each line segment (2 points) back to its edge index. */
  segmentEdgeIndex: Uint32Array;
}

const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ffffff";

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private bodies = new Map<string, BodyObjects>();
  private bodyGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private highlightGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private frameId = 0;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.scene.background = new THREE.Color(css("--vp-background"));
    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      50000,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -180, 120);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.domElement.classList.add("viewport-canvas");
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(30, 20, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x33343a, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(200, -250, 350);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-150, 200, -100);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x3f3f46, 0x26282e);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(20));

    this.scene.add(this.bodyGroup, this.sketchGroup, this.previewGroup, this.highlightGroup);

    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frameId = requestAnimationFrame(loop);
    };
    loop();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------ content

  setRegenResult(result: RegenResult, bodyColors: Record<string, string>): void {
    // Rebuild wholesale — models at this scale rebuild in well under a frame.
    this.bodyGroup.clear();
    this.bodies.clear();

    for (const body of result.bodies) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(body.mesh.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(body.mesh.normals, 3));
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(bodyColors[body.id] ?? css("--vp-body-default")),
        metalness: 0.1,
        roughness: 0.65,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { bodyId: body.id };

      // Edge polylines → line segments (pairs), tracking edge index per segment.
      const ranges = body.mesh.edgeRanges;
      const pts = body.mesh.edgePositions;
      const segPositions: number[] = [];
      const segEdgeIdx: number[] = [];
      for (let r = 0; r < ranges.length; r += 3) {
        const edgeIndex = ranges[r]!;
        const start = ranges[r + 1]!;
        const count = ranges[r + 2]!;
        for (let i = 0; i < count - 1; i++) {
          const a = (start + i) * 3;
          const b = (start + i + 1) * 3;
          segPositions.push(pts[a]!, pts[a + 1]!, pts[a + 2]!, pts[b]!, pts[b + 1]!, pts[b + 2]!);
          segEdgeIdx.push(edgeIndex);
        }
      }
      const edgeGeom = new THREE.BufferGeometry();
      edgeGeom.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(segPositions), 3),
      );
      const edges = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: new THREE.Color(css("--vp-edge")) }),
      );
      edges.userData = { bodyId: body.id };

      this.bodyGroup.add(mesh, edges);
      this.bodies.set(body.id, {
        body,
        mesh,
        edges,
        segmentEdgeIndex: Uint32Array.from(segEdgeIdx),
      });
    }
  }

  setSketches(sketches: EvaluatedSketch[], activeSketchId: string | null): void {
    this.sketchGroup.clear();
    for (const sketch of sketches) {
      const isActive = sketch.featureId === activeSketchId;
      const color = new THREE.Color(css(isActive ? "--vp-sketch" : "--vp-sketch-dim"));
      const material = new THREE.LineBasicMaterial({ color });
      for (const profile of sketch.profiles) {
        const pts = profilePoints3d(sketch, profile);
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.LineLoop(geom, material);
        line.userData = { sketchId: sketch.featureId, profileId: profile.id };
        this.sketchGroup.add(line);
      }
    }
  }

  setPreview(points: THREE.Vector3[] | null, closed: boolean): void {
    this.previewGroup.clear();
    if (!points || points.length < 2) return;
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: new THREE.Color(css("--vp-preview")) });
    this.previewGroup.add(
      closed ? new THREE.LineLoop(geom, material) : new THREE.Line(geom, material),
    );
  }

  // ------------------------------------------------------------ picking

  pick(ndcX: number, ndcY: number, mode: "model" | "sketch"): PickResult | null {
    if (mode !== "model") return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Line = { threshold: camDist * 0.008 };

    // Edges get priority within their threshold (spec §7.5 auto filter).
    const edgeObjects = [...this.bodies.values()].map((b) => b.edges);
    const edgeHits = this.raycaster.intersectObjects(edgeObjects, false);
    const meshObjects = [...this.bodies.values()].map((b) => b.mesh);
    const meshHits = this.raycaster.intersectObjects(meshObjects, false);

    const edgeHit = edgeHits[0];
    const meshHit = meshHits[0];
    if (edgeHit && (!meshHit || edgeHit.distance < meshHit.distance + camDist * 0.01)) {
      const bodyId = (edgeHit.object.userData as { bodyId: string }).bodyId;
      const entry = this.bodies.get(bodyId)!;
      const segIndex = Math.floor((edgeHit.index ?? 0) / 2);
      const edgeIndex = entry.segmentEdgeIndex[segIndex];
      if (edgeIndex !== undefined) return { kind: "edge", bodyId, index: edgeIndex };
    }
    if (meshHit && meshHit.faceIndex !== undefined && meshHit.faceIndex !== null) {
      const bodyId = (meshHit.object.userData as { bodyId: string }).bodyId;
      const entry = this.bodies.get(bodyId)!;
      const faceId = entry.body.mesh.faceIds[meshHit.faceIndex];
      if (faceId !== undefined) return { kind: "face", bodyId, index: faceId };
    }
    return null;
  }

  /** Ray→sketch-plane intersection, returned in plane-local 2D coords. */
  pickOnPlane(
    ndcX: number,
    ndcY: number,
    sketch: EvaluatedSketch,
  ): { x: number; y: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const n = new THREE.Vector3(...sketch.plane.normal);
    const o = new THREE.Vector3(...sketch.plane.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    const d = hit.sub(o);
    return {
      x: d.dot(new THREE.Vector3(...sketch.plane.xdir)),
      y: d.dot(new THREE.Vector3(...sketch.plane.ydir)),
    };
  }

  // ------------------------------------------------------------ highlights

  setHighlights(
    hover: PickResult | null,
    selectedFaces: { bodyId: string; faceIndex: number }[],
    selectedEdges: { bodyId: string; edgeIndex: number }[],
  ): void {
    this.highlightGroup.clear();
    const addFace = (bodyId: string, faceIndex: number, colorVar: string) => {
      const entry = this.bodies.get(bodyId);
      if (!entry) return;
      const { positions, faceIds, normals } = entry.body.mesh;
      const facePositions: number[] = [];
      const faceNormals: number[] = [];
      for (let t = 0; t < faceIds.length; t++) {
        if (faceIds[t] !== faceIndex) continue;
        for (let i = 0; i < 9; i++) {
          facePositions.push(positions[t * 9 + i]!);
          faceNormals.push(normals[t * 9 + i]!);
        }
      }
      if (facePositions.length === 0) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(facePositions), 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(faceNormals), 3));
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(css(colorVar)),
        transparent: true,
        opacity: 0.45,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.highlightGroup.add(new THREE.Mesh(geom, mat));
    };
    const addEdge = (bodyId: string, edgeIndex: number, colorVar: string) => {
      const entry = this.bodies.get(bodyId);
      if (!entry) return;
      const ranges = entry.body.mesh.edgeRanges;
      const pts = entry.body.mesh.edgePositions;
      for (let r = 0; r < ranges.length; r += 3) {
        if (ranges[r] !== edgeIndex) continue;
        const start = ranges[r + 1]!;
        const count = ranges[r + 2]!;
        const linePts: THREE.Vector3[] = [];
        for (let i = 0; i < count; i++) {
          const p = (start + i) * 3;
          linePts.push(new THREE.Vector3(pts[p]!, pts[p + 1]!, pts[p + 2]!));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(linePts);
        const mat = new THREE.LineBasicMaterial({
          color: new THREE.Color(css(colorVar)),
          linewidth: 2,
        });
        this.highlightGroup.add(new THREE.Line(geom, mat));
      }
    };

    for (const f of selectedFaces) addFace(f.bodyId, f.faceIndex, "--vp-selected");
    for (const e of selectedEdges) addEdge(e.bodyId, e.edgeIndex, "--vp-selected");
    if (hover) {
      if (hover.kind === "face") addFace(hover.bodyId, hover.index, "--vp-hover");
      else addEdge(hover.bodyId, hover.index, "--vp-hover");
    }
  }

  // ------------------------------------------------------------ camera

  lookAtPlane(sketch: EvaluatedSketch): void {
    const o = new THREE.Vector3(...sketch.plane.origin);
    const n = new THREE.Vector3(...sketch.plane.normal);
    const y = new THREE.Vector3(...sketch.plane.ydir);
    const dist = Math.max(120, this.camera.position.distanceTo(this.controls.target));
    this.controls.target.copy(o);
    this.camera.position.copy(o.clone().add(n.multiplyScalar(dist)));
    this.camera.up.copy(y);
    this.controls.update();
  }

  resetCameraUp(): void {
    this.camera.up.set(0, 0, 1);
    this.controls.update();
  }

  fitAll(): void {
    const box = new THREE.Box3();
    let has = false;
    for (const { mesh } of this.bodies.values()) {
      box.expandByObject(mesh);
      has = true;
    }
    if (!has) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 100;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(size * 1.6)));
    this.controls.update();
  }
}

export function profilePoints3d(
  sketch: EvaluatedSketch,
  profile: EvaluatedSketch["profiles"][number],
): THREE.Vector3[] {
  const o = new THREE.Vector3(...sketch.plane.origin);
  const xd = new THREE.Vector3(...sketch.plane.xdir);
  const yd = new THREE.Vector3(...sketch.plane.ydir);
  const at = (x: number, y: number) =>
    o.clone().add(xd.clone().multiplyScalar(x)).add(yd.clone().multiplyScalar(y));

  if (profile.kind === "rect") {
    return [
      at(profile.x, profile.y),
      at(profile.x + profile.width, profile.y),
      at(profile.x + profile.width, profile.y + profile.height),
      at(profile.x, profile.y + profile.height),
    ];
  }
  if (profile.kind === "circle") {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push(
        at(profile.cx + Math.cos(a) * profile.radius, profile.cy + Math.sin(a) * profile.radius),
      );
    }
    return pts;
  }
  return profile.points.map((p) => at(p.x, p.y));
}
