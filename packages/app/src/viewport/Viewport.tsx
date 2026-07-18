import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  evaluateExpression,
  newId,
  resolveSketchConstraints,
  solveSketch,
  type SketchEntity,
  type SketchFeature,
  type SketchProfile,
} from "@craftbit/core";
import type { EvaluatedSketch } from "@craftbit/geometry-worker";
import {
  CUBE_PAD_PX,
  CUBE_SIZE_PX,
  SceneManager,
  entityWorldPoint,
  type PickResult,
} from "./sceneManager";
import { SketchDimensions } from "./SketchDimensions";
import { pickSketchEntity } from "./sketchPick";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

const fmtNum = (n: number) => String(Math.round(n * 100) / 100);
/** Drag distance (CSS px) below which a cube pointerdown/up pair counts as a click, not an orbit. */
const CUBE_CLICK_SLOP = 4;

interface DrawState {
  tool: "rect" | "circle" | "polygon";
  anchor: { x: number; y: number };
  current: { x: number; y: number };
  polygonPoints: { x: number; y: number }[];
}

/** In-progress line-tool chain: last placed point carries forward. */
interface LineChainState {
  firstPointId: string;
  lastPointId: string;
  cursor: { x: number; y: number } | null;
}

/** In-progress point drag (Select tool): live-solved locally, committed on release. */
interface EntityDragState {
  pointId: string;
  /** Solved entity state from the latest move (committed on pointer-up). */
  solved: SketchEntity[] | null;
  moved: boolean;
}

interface CubeDragState {
  lastX: number;
  lastY: number;
  totalMove: number;
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const lineChainRef = useRef<LineChainState | null>(null);
  const entityDragRef = useRef<EntityDragState | null>(null);
  /** Set when pointer-down consumed the click on a curve entity, so the
   * pointer-up profile-pick fallback must not clear that selection. */
  const entityClickRef = useRef(false);
  const cubeDragRef = useRef<CubeDragState | null>(null);
  const [hover, setHover] = useState<PickResult | null>(null);
  // Hovered sketch entity id in Select tool — gives visual feedback on what's
  // clickable before the user commits to a click (D3 discoverability).
  const [hoverEntityId, setHoverEntityId] = useState<string | null>(null);
  // Manager also held in state so overlays re-render once it exists.
  const [manager, setManager] = useState<SceneManager | null>(null);
  const [cubeVisible, setCubeVisible] = useState(true);
  const [cubeHovering, setCubeHovering] = useState(false);

  const result = useGeometryStore((s) => s.result);
  const kernelReady = useGeometryStore((s) => s.kernelReady);
  const mode = useUiStore((s) => s.mode);
  const activeSketchId = useUiStore((s) => s.activeSketchId);
  const sketchTool = useUiStore((s) => s.sketchTool);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const selectedProfileId = useUiStore((s) => s.selectedProfileId);
  const selectedEntityIds = useUiStore((s) => s.selectedEntityIds);

  const activeSketch: EvaluatedSketch | undefined = result?.sketches.find(
    (s) => s.featureId === activeSketchId,
  );

  // --- lifecycle -----------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sceneManager = new SceneManager(container);
    managerRef.current = sceneManager;
    setManager(sceneManager);
    sceneManager.resize(container.clientWidth, container.clientHeight);
    setCubeVisible(sceneManager.isViewCubeVisible());
    const observer = new ResizeObserver(() => {
      sceneManager.resize(container.clientWidth, container.clientHeight);
      setCubeVisible(sceneManager.isViewCubeVisible());
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      sceneManager.dispose();
      managerRef.current = null;
      setManager(null);
    };
  }, []);

  // --- content sync --------------------------------------------------
  useEffect(() => {
    const sceneManager = managerRef.current;
    if (!sceneManager || !result) return;
    sceneManager.setRegenResult(result, useDocumentStore.getState().doc.bodyColors);
    sceneManager.setSketches(
      result.sketches,
      activeSketchId,
      selectedProfileId,
      selectedEntityIds,
      hoverEntityId,
    );
  }, [result, activeSketchId, selectedProfileId, selectedEntityIds, hoverEntityId]);

  useEffect(() => {
    managerRef.current?.setHighlights(hover, selectedFaces, selectedEdges);
  }, [hover, selectedFaces, selectedEdges]);

  // Stale hover would otherwise linger after switching tools/leaving Select.
  useEffect(() => {
    setHoverEntityId(null);
  }, [sketchTool, mode]);

  // Camera to sketch plane on entry; restore on exit.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    if (mode === "sketch" && activeSketch) {
      manager.lookAtPlane(activeSketch);
    } else if (mode === "model" && prevModeRef.current === "sketch") {
      manager.resetCameraUp();
    }
    prevModeRef.current = mode;
  }, [mode, activeSketch]);

  // --- pointer handling ----------------------------------------------
  const toNdc = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
  };

  // Container-relative CSS px, used by the ViewCube (which picks in its own
  // inset viewport rather than the main NDC space).
  const toLocal = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const inCubeRect = (
    local: { x: number; y: number },
    rect: { left: number; top: number; width: number; height: number } | null,
  ): boolean =>
    !!rect &&
    local.x >= rect.left &&
    local.y >= rect.top &&
    local.x <= rect.left + rect.width &&
    local.y <= rect.top + rect.height;

  const commitProfile = (profile: SketchProfile) => {
    const { doc, dispatch } = useDocumentStore.getState();
    const sketch = doc.features.find((f) => f.id === activeSketchId);
    if (!sketch || sketch.type !== "sketch") return;
    const next: SketchFeature = { ...sketch, profiles: [...sketch.profiles, profile] };
    dispatch({ kind: "updateFeature", featureId: sketch.id, next });
  };

  // --- constraint-sketcher helpers (D3) ------------------------------
  const activeFeature = (): SketchFeature | null => {
    const f = useDocumentStore.getState().doc.features.find((x) => x.id === activeSketchId);
    return f && f.type === "sketch" ? f : null;
  };

  /** Solved entities if a regen has landed, else the document's stored ones. */
  const currentEntities = (): SketchEntity[] => {
    if (activeSketch && activeSketch.entities.length > 0) return activeSketch.entities;
    return activeFeature()?.entities ?? [];
  };

  const entityProjector = (x: number, y: number) => {
    const m = managerRef.current!;
    return m.projectToScreen(entityWorldPoint(activeSketch!, x, y));
  };

  const paramEnv = (name: string): number => {
    const v = result?.parameterValues[name];
    if (v === undefined) throw new Error(`Unknown parameter "${name}"`);
    return v;
  };

  /** Adds a chain click: reuses a picked existing point or creates one, links
   * a line from the previous chain point, closes the loop when the chain's
   * first point is clicked again. One document update per click. */
  const lineToolClick = (local: { x: number; y: number }, screen: { x: number; y: number }) => {
    const feature = activeFeature();
    if (!feature) return;
    const entities = feature.entities ?? [];
    const solved = currentEntities();
    const picked = pickSketchEntity(solved, entityProjector, screen.x, screen.y);
    const snappedId = picked?.kind === "point" ? picked.entityId : null;

    const chain = lineChainRef.current;
    const nextEntities = [...entities];
    let targetId = snappedId;
    if (!targetId) {
      targetId = newId();
      nextEntities.push({
        id: targetId,
        kind: "point",
        x: Math.round(local.x * 100) / 100,
        y: Math.round(local.y * 100) / 100,
      });
    }

    if (chain) {
      if (targetId === chain.lastPointId) return; // double-click same point: ignore
      nextEntities.push({ id: newId(), kind: "line", p1: chain.lastPointId, p2: targetId });
      if (targetId === chain.firstPointId) {
        lineChainRef.current = null; // loop closed
        managerRef.current?.setPreview(null, false);
      } else {
        lineChainRef.current = { ...chain, lastPointId: targetId, cursor: null };
      }
    } else {
      lineChainRef.current = { firstPointId: targetId, lastPointId: targetId, cursor: null };
    }

    const next: SketchFeature = { ...feature, entities: nextEntities };
    useDocumentStore.getState().dispatch({ kind: "updateFeature", featureId: feature.id, next });
  };

  const updateLinePreview = () => {
    const chainNow = lineChainRef.current;
    const m = managerRef.current;
    if (!chainNow || !m || !activeSketch || !chainNow.cursor) return;
    const last = currentEntities().find((e) => e.id === chainNow.lastPointId);
    if (!last || last.kind !== "point") return;
    m.setPreview(
      [
        entityWorldPoint(activeSketch, last.x, last.y),
        entityWorldPoint(activeSketch, chainNow.cursor.x, chainNow.cursor.y),
      ],
      false,
    );
  };

  const updatePreview = () => {
    const manager = managerRef.current;
    const draw = drawRef.current;
    if (!manager || !activeSketch) return;
    if (!draw) {
      manager.setPreview(null, false);
      return;
    }
    const o = new THREE.Vector3(...activeSketch.plane.origin);
    const xd = new THREE.Vector3(...activeSketch.plane.xdir);
    const yd = new THREE.Vector3(...activeSketch.plane.ydir);
    const at = (x: number, y: number) =>
      o.clone().add(xd.clone().multiplyScalar(x)).add(yd.clone().multiplyScalar(y));

    if (draw.tool === "rect") {
      const { anchor: a, current: c } = draw;
      manager.setPreview([at(a.x, a.y), at(c.x, a.y), at(c.x, c.y), at(a.x, c.y)], true);
    } else if (draw.tool === "circle") {
      const r = Math.hypot(draw.current.x - draw.anchor.x, draw.current.y - draw.anchor.y);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 48; i++) {
        const ang = (i / 48) * Math.PI * 2;
        pts.push(at(draw.anchor.x + Math.cos(ang) * r, draw.anchor.y + Math.sin(ang) * r));
      }
      manager.setPreview(pts, true);
    } else {
      const pts = [...draw.polygonPoints, draw.current].map((p) => at(p.x, p.y));
      manager.setPreview(pts, false);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const manager = managerRef.current;
    if (!manager || e.button !== 0) return;
    // Any deliberate interaction with the viewport interrupts an in-flight
    // ViewCube animation (a cube click that starts its own animation calls
    // orientTo again afterward, which is fine).
    manager.cancelOrientation();

    // ViewCube intercepts before any sketch/model interaction, regardless of
    // current mode or tool — it's an always-on navigation affordance.
    const local = toLocal(e);
    if (inCubeRect(local, manager.getViewCubeRect())) {
      cubeDragRef.current = { lastX: local.x, lastY: local.y, totalMove: 0 };
      // orbitCubeBy positions the camera directly; leaving OrbitControls
      // enabled would let it independently process the same native pointer
      // events and apply its own (conflicting) rotation on top.
      manager.controls.enabled = false;
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }

    if (mode === "sketch" && activeSketch && sketchTool === "line") {
      const ndc = toNdc(e);
      const planePt = manager.pickOnPlane(ndc.x, ndc.y, activeSketch);
      if (!planePt) return;
      lineToolClick(planePt, toLocal(e));
      return;
    }

    // Select tool: entity picking (points are drag handles; curves select).
    if (mode === "sketch" && activeSketch && sketchTool === "select") {
      const screen = toLocal(e);
      const entities = currentEntities();
      if (entities.length > 0) {
        const picked = pickSketchEntity(entities, entityProjector, screen.x, screen.y);
        if (picked) {
          useUiStore.getState().selectEntity(picked.entityId, e.shiftKey);
          if (picked.kind === "point") {
            entityDragRef.current = { pointId: picked.entityId, solved: null, moved: false };
            manager.controls.enabled = false;
            (e.target as Element).setPointerCapture(e.pointerId);
          } else {
            entityClickRef.current = true;
          }
          return;
        }
      }
      return; // empty click: handled on pointer-up (clears selection / picks profiles)
    }

    if (mode === "sketch" && activeSketch && sketchTool !== "select" && sketchTool !== "line") {
      const ndc = toNdc(e);
      const local = manager.pickOnPlane(ndc.x, ndc.y, activeSketch);
      if (!local) return;
      if (sketchTool === "polygon") {
        const draw = drawRef.current;
        if (draw?.tool === "polygon") {
          draw.polygonPoints.push(local);
        } else {
          drawRef.current = {
            tool: "polygon",
            anchor: local,
            current: local,
            polygonPoints: [local],
          };
        }
        updatePreview();
      } else {
        drawRef.current = { tool: sketchTool, anchor: local, current: local, polygonPoints: [] };
        manager.controls.enabled = false;
        (e.target as Element).setPointerCapture(e.pointerId);
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const manager = managerRef.current;
    if (!manager) return;

    const cubeDrag = cubeDragRef.current;
    if (cubeDrag) {
      const local = toLocal(e);
      const dx = local.x - cubeDrag.lastX;
      const dy = local.y - cubeDrag.lastY;
      cubeDrag.lastX = local.x;
      cubeDrag.lastY = local.y;
      cubeDrag.totalMove += Math.hypot(dx, dy);
      manager.orbitCubeBy(dx, dy);
      return;
    }

    const local = toLocal(e);
    if (inCubeRect(local, manager.getViewCubeRect())) {
      manager.setViewCubeHover(local.x, local.y);
      setCubeHovering(true);
      return;
    }
    if (cubeHovering) {
      manager.setViewCubeHover(null, null);
      setCubeHovering(false);
    }

    const ndc = toNdc(e);

    if (mode === "sketch" && activeSketch) {
      // Live-solve while dragging a point (Select tool): local preview only;
      // the document updates once on release.
      const entityDrag = entityDragRef.current;
      if (entityDrag && result) {
        const planePt = manager.pickOnPlane(ndc.x, ndc.y, activeSketch);
        const feature = activeFeature();
        if (planePt && feature && feature.entities) {
          try {
            const constraints = resolveSketchConstraints(feature.constraints ?? [], (expr) =>
              evaluateExpression(expr, paramEnv),
            );
            const base = entityDrag.solved ?? currentEntities();
            const solved = solveSketch(base, constraints, {
              pointId: entityDrag.pointId,
              x: planePt.x,
              y: planePt.y,
            });
            entityDrag.solved = solved.entities;
            entityDrag.moved = true;
            const patched = result.sketches.map((s) =>
              s.featureId === activeSketchId ? { ...s, entities: solved.entities } : s,
            );
            manager.setSketches(patched, activeSketchId, selectedProfileId, selectedEntityIds);
          } catch {
            // Parameter errors surface via regen statuses; skip live preview.
          }
        }
        return;
      }

      // Line tool: rubber-band from the chain's last point to the cursor.
      if (sketchTool === "line" && lineChainRef.current) {
        const planePt = manager.pickOnPlane(ndc.x, ndc.y, activeSketch);
        if (planePt) {
          lineChainRef.current.cursor = planePt;
          updateLinePreview();
        }
        return;
      }

      // Select tool (idle, not dragging): hover feedback on entities so it's
      // clear what will be picked before committing to a click.
      if (sketchTool === "select") {
        const screen = toLocal(e);
        const entities = currentEntities();
        const picked =
          entities.length > 0
            ? pickSketchEntity(entities, entityProjector, screen.x, screen.y)
            : null;
        setHoverEntityId(picked?.entityId ?? null);
        return;
      }

      const draw = drawRef.current;
      if (draw) {
        const local = manager.pickOnPlane(ndc.x, ndc.y, activeSketch);
        if (local) {
          draw.current = local;
          updatePreview();
        }
      }
      return;
    }

    if (mode === "model") {
      setHover(manager.pick(ndc.x, ndc.y, "model"));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const manager = managerRef.current;
    const draw = drawRef.current;
    if (!manager) return;

    const cubeDrag = cubeDragRef.current;
    if (cubeDrag) {
      cubeDragRef.current = null;
      manager.controls.enabled = true;
      if (cubeDrag.totalMove < CUBE_CLICK_SLOP) {
        const local = toLocal(e);
        const zone = manager.pickViewCubeZone(local.x, local.y);
        if (zone) manager.orientTo(zone.dir);
      }
      return;
    }

    // Commit an entity drag: one document update per drag (one undo step).
    const entityDrag = entityDragRef.current;
    if (entityDrag) {
      entityDragRef.current = null;
      manager.controls.enabled = true;
      if (entityDrag.moved && entityDrag.solved) {
        const feature = activeFeature();
        if (feature) {
          const next: SketchFeature = { ...feature, entities: entityDrag.solved };
          useDocumentStore
            .getState()
            .dispatch({ kind: "updateFeature", featureId: feature.id, next });
        }
      }
      return;
    }

    if (mode === "sketch" && draw && draw.tool !== "polygon") {
      manager.controls.enabled = true;
      const { anchor: a, current: c } = draw;
      if (draw.tool === "rect") {
        const w = Math.abs(c.x - a.x);
        const h = Math.abs(c.y - a.y);
        if (w > 0.5 && h > 0.5) {
          commitProfile({
            id: newId(),
            kind: "rect",
            x: fmtNum(Math.min(a.x, c.x)),
            y: fmtNum(Math.min(a.y, c.y)),
            width: fmtNum(w),
            height: fmtNum(h),
          });
        }
      } else if (draw.tool === "circle") {
        const r = Math.hypot(c.x - a.x, c.y - a.y);
        if (r > 0.5) {
          commitProfile({
            id: newId(),
            kind: "circle",
            cx: fmtNum(a.x),
            cy: fmtNum(a.y),
            radius: fmtNum(r),
          });
        }
      }
      drawRef.current = null;
      manager.setPreview(null, false);
      return;
    }

    // Select tool in sketch mode: click a profile outline to select it and
    // reveal its dimension labels for editing. Entity clicks were consumed on
    // pointer-down (flagged via entityClickRef) — don't clear that selection.
    if (mode === "sketch" && sketchTool === "select" && activeSketchId && e.button === 0) {
      if (entityClickRef.current) {
        entityClickRef.current = false;
        return;
      }
      const ndc = toNdc(e);
      const picked = manager.pickSketchProfile(ndc.x, ndc.y, activeSketchId);
      useUiStore.getState().setSelectedProfile(picked?.profileId ?? null);
      if (!picked && !e.shiftKey) useUiStore.getState().selectEntity(null);
      return;
    }

    if (mode === "model" && e.button === 0) {
      const ndc = toNdc(e);
      const picked = manager.pick(ndc.x, ndc.y, "model");
      const ui = useUiStore.getState();
      if (!picked) {
        ui.clearSelection();
      } else if (picked.kind === "face") {
        ui.selectFace({ bodyId: picked.bodyId, faceIndex: picked.index }, e.shiftKey);
      } else {
        ui.selectEdge({ bodyId: picked.bodyId, edgeIndex: picked.index }, e.shiftKey);
      }
    }
  };

  const onPointerLeave = () => {
    // Only clears the hover highlight — an in-progress cube drag keeps
    // receiving events via pointer capture even once the cursor leaves.
    if (!cubeDragRef.current && cubeHovering) {
      managerRef.current?.setViewCubeHover(null, null);
      setCubeHovering(false);
    }
    if (hoverEntityId) setHoverEntityId(null);
  };

  const onDoubleClick = () => {
    const draw = drawRef.current;
    if (mode === "sketch" && draw?.tool === "polygon") {
      if (draw.polygonPoints.length >= 3) {
        commitProfile({
          id: newId(),
          kind: "polygon",
          points: draw.polygonPoints.map((p) => ({
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,
          })),
        });
      }
      drawRef.current = null;
      managerRef.current?.setPreview(null, false);
    }
  };

  // Cancel in-progress drawing on Esc (App dispatches a custom event).
  useEffect(() => {
    const cancel = () => {
      drawRef.current = null;
      lineChainRef.current = null;
      entityDragRef.current = null;
      if (managerRef.current) {
        managerRef.current.setPreview(null, false);
        managerRef.current.controls.enabled = true;
      }
    };
    window.addEventListener("craftbit:cancel-draw", cancel);
    return () => window.removeEventListener("craftbit:cancel-draw", cancel);
  }, []);

  // Fit-all on F (App dispatches).
  useEffect(() => {
    const fit = () => managerRef.current?.fitAll();
    window.addEventListener("craftbit:fit-all", fit);
    return () => window.removeEventListener("craftbit:fit-all", fit);
  }, []);

  return (
    <div
      className="viewport-root"
      ref={containerRef}
      style={cubeHovering || hoverEntityId ? { cursor: "pointer" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      data-testid="viewport"
    >
      {!kernelReady && (
        <div className="loading-overlay" data-testid="kernel-loading">
          <div>Loading OpenCascade kernel…</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-disabled)" }}>
            ~14 MB compressed, cached after first load
          </div>
        </div>
      )}
      {mode === "sketch" && manager && activeSketch && (
        <SketchDimensions manager={manager} sketch={activeSketch} />
      )}
      {cubeVisible && (
        <button
          type="button"
          className="viewcube-home-btn"
          style={{ top: CUBE_PAD_PX, right: CUBE_PAD_PX + CUBE_SIZE_PX + 8 }}
          title="Home view"
          data-testid="viewcube-home"
          onClick={() => managerRef.current?.homeView()}
        >
          ⌂
        </button>
      )}
    </div>
  );
}
