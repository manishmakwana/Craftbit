import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { newId, type SketchFeature, type SketchProfile } from "@craftbit/core";
import type { EvaluatedSketch } from "@craftbit/geometry-worker";
import { SceneManager, type PickResult } from "./sceneManager";
import { SketchDimensions } from "./SketchDimensions";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

const fmtNum = (n: number) => String(Math.round(n * 100) / 100);

interface DrawState {
  tool: "rect" | "circle" | "polygon";
  anchor: { x: number; y: number };
  current: { x: number; y: number };
  polygonPoints: { x: number; y: number }[];
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const [hover, setHover] = useState<PickResult | null>(null);
  // Manager also held in state so overlays re-render once it exists.
  const [manager, setManager] = useState<SceneManager | null>(null);

  const result = useGeometryStore((s) => s.result);
  const kernelReady = useGeometryStore((s) => s.kernelReady);
  const mode = useUiStore((s) => s.mode);
  const activeSketchId = useUiStore((s) => s.activeSketchId);
  const sketchTool = useUiStore((s) => s.sketchTool);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const selectedProfileId = useUiStore((s) => s.selectedProfileId);

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
    const observer = new ResizeObserver(() => {
      sceneManager.resize(container.clientWidth, container.clientHeight);
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
    sceneManager.setSketches(result.sketches, activeSketchId, selectedProfileId);
  }, [result, activeSketchId, selectedProfileId]);

  useEffect(() => {
    managerRef.current?.setHighlights(hover, selectedFaces, selectedEdges);
  }, [hover, selectedFaces, selectedEdges]);

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

  const commitProfile = (profile: SketchProfile) => {
    const { doc, dispatch } = useDocumentStore.getState();
    const sketch = doc.features.find((f) => f.id === activeSketchId);
    if (!sketch || sketch.type !== "sketch") return;
    const next: SketchFeature = { ...sketch, profiles: [...sketch.profiles, profile] };
    dispatch({ kind: "updateFeature", featureId: sketch.id, next });
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

    if (mode === "sketch" && activeSketch && sketchTool !== "select") {
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
    const ndc = toNdc(e);

    if (mode === "sketch" && activeSketch) {
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
    // reveal its dimension labels for editing.
    if (mode === "sketch" && sketchTool === "select" && activeSketchId && e.button === 0) {
      const ndc = toNdc(e);
      const picked = manager.pickSketchProfile(ndc.x, ndc.y, activeSketchId);
      useUiStore.getState().setSelectedProfile(picked?.profileId ?? null);
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
    </div>
  );
}
