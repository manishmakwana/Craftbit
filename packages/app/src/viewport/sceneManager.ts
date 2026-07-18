/**
 * Imperative Three.js scene management for the viewport. React owns the
 * lifecycle; this class owns the render loop, scene graph, picking, and the
 * sketch-plane math. Kept framework-free for testability.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SketchEntity } from "@craftbit/core";
import type { BodyResult, EvaluatedSketch, RegenResult } from "@craftbit/geometry-worker";
import {
  type CubeZone,
  type OrientationFrame,
  CUBE_CAMERA_DISTANCE,
  buildViewCubeScene,
  classifyHit,
  easeInOutCubic,
  makeOrientationInterpolator,
  upForDir,
} from "./viewCube";

export interface PickResult {
  kind: "face" | "edge";
  bodyId: string;
  index: number;
}

/** CSS-pixel size/inset of the ViewCube square, anchored to the top-right corner. */
export const CUBE_SIZE_PX = 96;
export const CUBE_PAD_PX = 12;
/** Below this container width the cube is hidden — it would occlude too much on small screens. */
export const CUBE_HIDE_BELOW_WIDTH = 480;

interface PendingOrientation {
  interp: (progress: number) => OrientationFrame;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromDistance: number;
  toDistance: number;
  startTime: number;
  duration: number;
  finalDir: THREE.Vector3;
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
  private width = 1;
  private height = 1;

  private container: HTMLElement;
  private viewCube: ReturnType<typeof buildViewCubeScene>;
  private defaultDir: THREE.Vector3;
  private defaultTarget: THREE.Vector3;
  private pendingOrientation: PendingOrientation | null = null;
  private dampingBeforeOrientation = true;
  private controlsEnabledBeforeOrientation = true;

  constructor(container: HTMLElement) {
    this.container = container;
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

    this.defaultTarget = this.controls.target.clone();
    this.defaultDir = this.camera.position.clone().sub(this.controls.target).normalize();

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

    // Fixed light palette (not app-theme tokens): Fusion's ViewCube reads the
    // same way regardless of app theme, and a light cube stays legible
    // against the dark viewport background in a way a dark-on-dark cube
    // wasn't.
    this.viewCube = buildViewCubeScene({
      bg: "#e3e5ea",
      text: "#31343c",
      border: "#a7adb8",
      wireframe: "#7d8292",
      hover: "#3b82f6",
    });

    const loop = () => {
      if (this.disposed) return;
      this.stepOrientation();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.renderCubeInset();
      this.frameId = requestAnimationFrame(loop);
    };
    loop();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  // ------------------------------------------------------------ ViewCube

  isViewCubeVisible(): boolean {
    return this.width >= CUBE_HIDE_BELOW_WIDTH;
  }

  /** CSS-pixel rect of the cube square, relative to the container. Null when hidden. */
  getViewCubeRect(): { left: number; top: number; width: number; height: number } | null {
    if (!this.isViewCubeVisible()) return null;
    return {
      left: this.width - CUBE_SIZE_PX - CUBE_PAD_PX,
      top: CUBE_PAD_PX,
      width: CUBE_SIZE_PX,
      height: CUBE_SIZE_PX,
    };
  }

  private cubeLocalNdc(containerX: number, containerY: number): { x: number; y: number } | null {
    const rect = this.getViewCubeRect();
    if (!rect) return null;
    const lx = containerX - rect.left;
    const ly = containerY - rect.top;
    if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) return null;
    return { x: (lx / rect.width) * 2 - 1, y: -(ly / rect.height) * 2 + 1 };
  }

  /** Raycasts the cube from a container-relative CSS point; null outside the cube rect. */
  pickViewCubeZone(containerX: number, containerY: number): CubeZone | null {
    const ndc = this.cubeLocalNdc(containerX, containerY);
    if (!ndc) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.viewCube.camera);
    const hit = this.raycaster.intersectObject(this.viewCube.mesh, false)[0];
    if (!hit) return null;
    return classifyHit(hit.point);
  }

  /** Updates the cube hover highlight from a container-relative CSS point. */
  setViewCubeHover(containerX: number | null, containerY: number | null): CubeZone | null {
    const zone =
      containerX === null || containerY === null
        ? null
        : this.pickViewCubeZone(containerX, containerY);
    this.viewCube.setHover(zone);
    return zone;
  }

  /** Orbits the main camera by a drag delta in CSS px, same convention as OrbitControls
   * but computed directly so cube drags work without depending on its internals. */
  orbitCubeBy(dxPx: number, dyPx: number): void {
    this.cancelOrientation();
    const up = this.camera.up.clone().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const quatInverse = quat.clone().invert();
    const offset = this.camera.position.clone().sub(this.controls.target).applyQuaternion(quat);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dxPx * 0.01;
    spherical.phi -= dyPx * 0.01;
    spherical.phi = Math.max(0.001, Math.min(Math.PI - 0.001, spherical.phi));
    const newOffset = new THREE.Vector3().setFromSpherical(spherical).applyQuaternion(quatInverse);
    this.camera.position.copy(this.controls.target.clone().add(newOffset));
    this.camera.lookAt(this.controls.target);
    this.camera.up.copy(up);
    this.controls.update();
  }

  /** Animates the camera to look along `dir` (unit vector, from target toward camera).
   * Target and distance stay fixed unless overridden (used by `homeView`). */
  orientTo(dir: THREE.Vector3, opts: { target?: THREE.Vector3; distance?: number } = {}): void {
    const toDir = dir.clone().normalize();
    const fromDir = this.camera.position.clone().sub(this.controls.target).normalize();
    const fromTarget = this.controls.target.clone();
    const toTarget = opts.target?.clone() ?? fromTarget.clone();
    const fromDistance = this.camera.position.distanceTo(this.controls.target);
    const toDistance = opts.distance ?? fromDistance;
    const fromUp = this.camera.up.clone().normalize();
    const toUp = upForDir(toDir);
    const interp = makeOrientationInterpolator(fromDir, toDir, fromUp, toUp);

    this.dampingBeforeOrientation = this.controls.enableDamping;
    this.controlsEnabledBeforeOrientation = this.controls.enabled;
    this.controls.enableDamping = false;
    // OrbitControls listens to the same native pointer events as our own
    // click/drag handling; left enabled, any residual internal rotation
    // state (e.g. damped momentum from the gesture that triggered this
    // animation) keeps nudging the camera on top of our own frame-by-frame
    // positioning, drifting it unpredictably once damping is re-enabled.
    this.controls.enabled = false;
    this.pendingOrientation = {
      interp,
      fromTarget,
      toTarget,
      fromDistance,
      toDistance,
      startTime: performance.now(),
      duration: 350,
      finalDir: toDir,
    };
  }

  /** Cancels any in-flight `orientTo` animation, leaving the camera where it currently is. */
  cancelOrientation(): void {
    if (!this.pendingOrientation) return;
    this.pendingOrientation = null;
    this.controls.enableDamping = this.dampingBeforeOrientation;
    this.controls.enabled = this.controlsEnabledBeforeOrientation;
  }

  /** Restores the default iso view, refit to whatever bodies currently exist. */
  homeView(): void {
    const box = this.bodiesBoundingBox();
    const target = box ? box.getCenter(new THREE.Vector3()) : this.defaultTarget.clone();
    const size = box ? box.getSize(new THREE.Vector3()).length() || 200 : 200;
    this.orientTo(this.defaultDir.clone(), { target, distance: size * 1.6 });
  }

  private stepOrientation(): void {
    const po = this.pendingOrientation;
    if (!po) return;
    const t = Math.min(1, (performance.now() - po.startTime) / po.duration);
    const frame = po.interp(t);
    const eased = easeInOutCubic(t);
    const target = po.fromTarget.clone().lerp(po.toTarget, eased);
    const distance = po.fromDistance + (po.toDistance - po.fromDistance) * eased;
    this.controls.target.copy(target);
    this.camera.position.copy(target.clone().add(frame.dir.clone().multiplyScalar(distance)));
    this.camera.up.copy(frame.up);
    if (t >= 1) {
      this.pendingOrientation = null;
      this.controls.enableDamping = this.dampingBeforeOrientation;
      this.controls.enabled = this.controlsEnabledBeforeOrientation;
      const d = po.finalDir;
      this.container.dataset.viewDir = `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)}`;
    }
  }

  private renderCubeInset(): void {
    if (!this.isViewCubeVisible()) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.viewCube.camera.position.copy(dir.multiplyScalar(CUBE_CAMERA_DISTANCE));
    this.viewCube.camera.up.copy(this.camera.up);
    this.viewCube.camera.lookAt(0, 0, 0);

    const rect = this.getViewCubeRect()!;
    const x = Math.round(rect.left);
    const y = Math.round(this.height - rect.top - rect.height);
    const size = Math.round(rect.width);

    // Scissor first, then clear only depth (scoped to that rect by the
    // scissor test) — rendering this pass with the default autoClearColor
    // would wipe the main scene's already-drawn pixels in that corner to
    // opaque black (the renderer has no alpha channel), painting a solid
    // box behind the cube instead of letting the model show through.
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, size, size);
    this.renderer.setScissor(x, y, size, size);
    this.renderer.clearDepth();
    this.renderer.autoClearColor = false;
    this.renderer.render(this.viewCube.scene, this.viewCube.camera);
    this.renderer.autoClearColor = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
  }

  /** Projects a world point to viewport CSS pixels. `inFront` is false when
   * the point is behind the camera (label should be hidden). */
  projectToScreen(world: THREE.Vector3): { x: number; y: number; inFront: boolean } {
    const v = world.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.width,
      y: ((1 - v.y) / 2) * this.height,
      inFront: v.z < 1,
    };
  }

  /** Subscribe to camera/orbit changes (for repositioning HTML overlays). */
  onViewChange(callback: () => void): () => void {
    const controls = this.controls as unknown as {
      addEventListener(type: string, cb: () => void): void;
      removeEventListener(type: string, cb: () => void): void;
    };
    controls.addEventListener("change", callback);
    return () => controls.removeEventListener("change", callback);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.controls.dispose();
    this.viewCube.dispose();
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

  setSketches(
    sketches: EvaluatedSketch[],
    activeSketchId: string | null,
    selectedProfileId: string | null = null,
    selectedEntityIds: readonly string[] = [],
    hoverEntityId: string | null = null,
  ): void {
    this.sketchGroup.clear();
    for (const sketch of sketches) {
      const isActive = sketch.featureId === activeSketchId;
      for (const profile of sketch.profiles) {
        // Loop profiles duplicate their member entities' geometry — entities
        // are drawn individually below, so skip the aggregate outline.
        if (profile.kind === "loop") continue;
        const isSelected = isActive && profile.id === selectedProfileId;
        const color = new THREE.Color(
          css(isSelected ? "--vp-selected" : isActive ? "--vp-sketch" : "--vp-sketch-dim"),
        );
        const material = new THREE.LineBasicMaterial({ color });
        const pts = profilePoints3d(sketch, profile);
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.LineLoop(geom, material);
        line.userData = { sketchId: sketch.featureId, profileId: profile.id };
        this.sketchGroup.add(line);
      }
      this.addSketchEntities(sketch, isActive, selectedEntityIds, hoverEntityId);
    }
  }

  /** Draws constraint-sketcher entities: lines/circles/arcs as curves, points as handles. */
  private addSketchEntities(
    sketch: EvaluatedSketch,
    isActive: boolean,
    selectedEntityIds: readonly string[],
    hoverEntityId: string | null,
  ): void {
    if (sketch.entities.length === 0) return;
    const points = new Map(
      sketch.entities
        .filter((e): e is Extract<SketchEntity, { kind: "point" }> => e.kind === "point")
        .map((e) => [e.id, e]),
    );
    const at = (x: number, y: number) => entityWorldPoint(sketch, x, y);
    const colorFor = (id: string) =>
      new THREE.Color(
        css(
          isActive && selectedEntityIds.includes(id)
            ? "--vp-selected"
            : isActive && id === hoverEntityId
              ? "--vp-hover"
              : isActive
                ? "--vp-sketch"
                : "--vp-sketch-dim",
        ),
      );

    for (const e of sketch.entities) {
      if (e.kind === "line") {
        const p1 = points.get(e.p1);
        const p2 = points.get(e.p2);
        if (!p1 || !p2) continue;
        const geom = new THREE.BufferGeometry().setFromPoints([at(p1.x, p1.y), at(p2.x, p2.y)]);
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: colorFor(e.id) }));
        line.userData = { sketchId: sketch.featureId, entityId: e.id };
        this.sketchGroup.add(line);
      } else if (e.kind === "circle") {
        const c = points.get(e.center);
        if (!c) continue;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          pts.push(at(c.x + Math.cos(a) * e.radius, c.y + Math.sin(a) * e.radius));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const loop = new THREE.LineLoop(
          geom,
          new THREE.LineBasicMaterial({ color: colorFor(e.id) }),
        );
        loop.userData = { sketchId: sketch.featureId, entityId: e.id };
        this.sketchGroup.add(loop);
      } else if (e.kind === "arc") {
        const c = points.get(e.center);
        const s = points.get(e.start);
        const en = points.get(e.end);
        if (!c || !s || !en) continue;
        const r = Math.hypot(s.x - c.x, s.y - c.y);
        const a0 = Math.atan2(s.y - c.y, s.x - c.x);
        let a1 = Math.atan2(en.y - c.y, en.x - c.x);
        if (e.ccw && a1 <= a0) a1 += 2 * Math.PI;
        if (!e.ccw && a1 >= a0) a1 -= 2 * Math.PI;
        const pts: THREE.Vector3[] = [];
        const steps = 48;
        for (let i = 0; i <= steps; i++) {
          const a = a0 + ((a1 - a0) * i) / steps;
          pts.push(at(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const arc = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: colorFor(e.id) }));
        arc.userData = { sketchId: sketch.featureId, entityId: e.id };
        this.sketchGroup.add(arc);
      }
    }

    // Point handles: screen-size squares, drawn on top of curves. Only shown
    // for the active sketch (handles on inactive sketches would be noise).
    if (isActive) {
      const positions: number[] = [];
      const colors: number[] = [];
      const normal = new THREE.Color(css("--vp-sketch-point"));
      const selected = new THREE.Color(css("--vp-selected"));
      const hovered = new THREE.Color(css("--vp-hover"));
      for (const e of sketch.entities) {
        if (e.kind !== "point") continue;
        const w = at(e.x, e.y);
        positions.push(w.x, w.y, w.z);
        const c = selectedEntityIds.includes(e.id)
          ? selected
          : e.id === hoverEntityId
            ? hovered
            : normal;
        colors.push(c.r, c.g, c.b);
      }
      if (positions.length > 0) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
        geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
        const mat = new THREE.PointsMaterial({
          size: 7,
          sizeAttenuation: false,
          vertexColors: true,
          depthTest: false,
        });
        const cloud = new THREE.Points(geom, mat);
        cloud.renderOrder = 5;
        cloud.userData = { sketchId: sketch.featureId, isPointCloud: true };
        this.sketchGroup.add(cloud);
      }
    }
  }

  /** Picks a profile of the active sketch by clicking near its outline. */
  pickSketchProfile(
    ndcX: number,
    ndcY: number,
    activeSketchId: string,
  ): { profileId: string } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Line = { threshold: camDist * 0.02 };
    const hits = this.raycaster.intersectObjects(this.sketchGroup.children, false);
    for (const hit of hits) {
      const data = hit.object.userData as { sketchId?: string; profileId?: string };
      if (data.sketchId === activeSketchId && data.profileId) {
        return { profileId: data.profileId };
      }
    }
    return null;
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

  private bodiesBoundingBox(): THREE.Box3 | null {
    const box = new THREE.Box3();
    let has = false;
    for (const { mesh } of this.bodies.values()) {
      box.expandByObject(mesh);
      has = true;
    }
    return has ? box : null;
  }

  fitAll(): void {
    const box = this.bodiesBoundingBox();
    if (!box) return;
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
  if (profile.kind === "loop") {
    // Loops are rendered per-entity in setSketches; this path is only a
    // fallback (e.g. selection outline) — sample coarse segment endpoints.
    return profile.segments.map((s) => at(s.a.x, s.a.y));
  }
  return profile.points.map((p) => at(p.x, p.y));
}

/** Maps a sketch-local 2D point to world coordinates via the sketch's plane frame. */
export function entityWorldPoint(sketch: EvaluatedSketch, x: number, y: number): THREE.Vector3 {
  const { origin, xdir, ydir } = sketch.plane;
  return new THREE.Vector3(
    origin[0] + xdir[0] * x + ydir[0] * y,
    origin[1] + xdir[1] * x + ydir[1] * y,
    origin[2] + xdir[2] * x + ydir[2] * y,
  );
}
