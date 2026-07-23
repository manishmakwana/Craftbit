/**
 * On-canvas dimensions for the active sketch (spec §7.6 UI, Fusion-style):
 *
 * - Quick-profile dims (rect W/H, circle R) render as simple clickable labels.
 * - Constraint-sketcher dims (distance/lineDistance/radius/diameter/angle, D3)
 *   render as full drafting graphics — witness lines, dimension line/arc,
 *   arrowheads and an editable value label — via `dimGeometry`, drawn on an SVG
 *   overlay in screen space. The label is draggable to reposition the dimension
 *   (stored as `place` on the constraint); clicking it opens an inline editor.
 * - The Dimension tool's live preview (uiStore.dimDraft) renders through the
 *   same `dimGeometry`, so preview and committed look identical.
 *
 * Editing a value keeps the dimension a driving constraint: the solver re-runs
 * and the geometry follows.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  evaluateExpression,
  type DimPlacement,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
} from "@craftbit/core";
import type { EvaluatedSketch } from "@craftbit/geometry-worker";
import type { SceneManager } from "./sceneManager";
import { dimGeometry, type DimGeometry, type DimSpec, type Pt } from "./dimGeometry";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

// ------- quick-profile labels (unchanged behavior: simple editable labels) ---

interface ProfileLabel {
  key: string;
  profileId: string;
  field: string;
  prefix: string;
  testId: string;
  expression: string;
  value: number;
  x: number;
  y: number;
}

function profileLabels(sketch: EvaluatedSketch, feature: SketchFeature): ProfileLabel[] {
  const labels: ProfileLabel[] = [];
  for (const evaluated of sketch.profiles) {
    const raw = feature.profiles.find((p) => p.id === evaluated.id);
    if (!raw) continue;
    if (evaluated.kind === "rect" && raw.kind === "rect") {
      labels.push({
        key: `${evaluated.id}-width`,
        profileId: evaluated.id,
        field: "width",
        prefix: "W",
        testId: "W",
        expression: raw.width,
        value: evaluated.width,
        x: evaluated.x + evaluated.width / 2,
        y: evaluated.y,
      });
      labels.push({
        key: `${evaluated.id}-height`,
        profileId: evaluated.id,
        field: "height",
        prefix: "H",
        testId: "H",
        expression: raw.height,
        value: evaluated.height,
        x: evaluated.x,
        y: evaluated.y + evaluated.height / 2,
      });
    } else if (evaluated.kind === "circle" && raw.kind === "circle") {
      labels.push({
        key: `${evaluated.id}-radius`,
        profileId: evaluated.id,
        field: "radius",
        prefix: "R",
        testId: "R",
        expression: raw.radius,
        value: evaluated.radius,
        x: evaluated.cx + evaluated.radius * 0.7071,
        y: evaluated.cy + evaluated.radius * 0.7071,
      });
    }
  }
  return labels;
}

// ---- constraint dims: spec + display prefix -------------------------------

interface ConstraintDim {
  constraintId: string;
  spec: DimSpec;
  /** Raw expression the user edits. */
  expression: string;
  prefix: string;
  testId: string;
  allowNonPositive: boolean;
  /** radius/diameter constraints can toggle between the two. */
  radial: boolean;
}

function constraintDims(constraints: SketchConstraint[]): ConstraintDim[] {
  const out: ConstraintDim[] = [];
  for (const c of constraints) {
    if (c.kind === "distance") {
      out.push({
        constraintId: c.id,
        spec: { kind: "distance", a: c.a, b: c.b, place: c.place },
        expression: c.value,
        prefix: "",
        testId: "D",
        allowNonPositive: false,
        radial: false,
      });
    } else if (c.kind === "lineDistance") {
      out.push({
        constraintId: c.id,
        spec: { kind: "lineDistance", a: c.a, b: c.b, place: c.place },
        expression: c.value,
        prefix: "",
        testId: "LD",
        allowNonPositive: false,
        radial: false,
      });
    } else if (c.kind === "radius") {
      out.push({
        constraintId: c.id,
        spec: { kind: "radius", entity: c.entity, place: c.place },
        expression: c.value,
        prefix: "R",
        testId: "CR",
        allowNonPositive: false,
        radial: true,
      });
    } else if (c.kind === "diameter") {
      out.push({
        constraintId: c.id,
        spec: { kind: "diameter", entity: c.entity, place: c.place },
        expression: c.value,
        prefix: "⌀",
        testId: "DIA",
        allowNonPositive: false,
        radial: true,
      });
    } else if (c.kind === "angle") {
      out.push({
        constraintId: c.id,
        spec: { kind: "angle", a: c.a, b: c.b, place: c.place },
        expression: c.value,
        prefix: "∠",
        testId: "A",
        allowNonPositive: true,
        radial: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export function SketchDimensions({
  manager,
  sketch,
}: {
  manager: SceneManager;
  sketch: EvaluatedSketch;
}) {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const result = useGeometryStore((s) => s.result);
  const setSelectedProfile = useUiStore((s) => s.setSelectedProfile);
  const dimDraft = useUiStore((s) => s.dimDraft);

  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [, setViewTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ephemeral placement while dragging a dimension's label (committed on release).
  const dragRef = useRef<{ constraintId: string; ref: Pt } | null>(null);
  const [dragPlace, setDragPlace] = useState<{ id: string; place: DimPlacement } | null>(null);

  useEffect(() => manager.onViewChange(() => setViewTick((t) => t + 1)), [manager]);
  useEffect(() => {
    inputRef.current?.select();
  }, [editing]);

  const feature = doc.features.find((f) => f.id === sketch.featureId);
  const entityMap = useMemo(() => {
    const entities: SketchEntity[] =
      sketch.entities.length > 0
        ? sketch.entities
        : feature?.type === "sketch"
          ? (feature.entities ?? [])
          : [];
    return new Map(entities.map((e) => [e.id, e]));
  }, [sketch, feature]);

  const pLabels = useMemo(
    () => (feature?.type === "sketch" ? profileLabels(sketch, feature) : []),
    [sketch, feature],
  );
  const cDims = useMemo(
    () => (feature?.type === "sketch" ? constraintDims(feature.constraints ?? []) : []),
    [feature],
  );

  if (feature?.type !== "sketch") return null;

  const paramValues = result?.parameterValues ?? {};
  const validate = (t: string, allowNonPositive: boolean): boolean => {
    try {
      const v = evaluateExpression(t, (name) => {
        const value = paramValues[name];
        if (value === undefined) throw new Error(`Unknown parameter "${name}"`);
        return value;
      });
      return allowNonPositive || v > 0;
    } catch {
      return false;
    }
  };

  const toWorld = (p: Pt): THREE.Vector3 => {
    const { origin, xdir, ydir } = sketch.plane;
    return new THREE.Vector3(
      origin[0] + xdir[0] * p.x + ydir[0] * p.y,
      origin[1] + xdir[1] * p.x + ydir[1] * p.y,
      origin[2] + xdir[2] * p.x + ydir[2] * p.y,
    );
  };
  const S = (p: Pt) => manager.projectToScreen(toWorld(p));

  const commitValue = (constraintId: string, allowNonPositive: boolean) => {
    if (!validate(text, allowNonPositive)) {
      setInvalid(true);
      return;
    }
    const next: SketchFeature = {
      ...feature,
      constraints: (feature.constraints ?? []).map((c) =>
        c.id === constraintId ? ({ ...c, value: text } as SketchConstraint) : c,
      ),
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
    setEditing(null);
    setInvalid(false);
  };

  const commitProfileValue = (profileId: string, field: string, allowNonPositive: boolean) => {
    if (!validate(text, allowNonPositive)) {
      setInvalid(true);
      return;
    }
    const next: SketchFeature = {
      ...feature,
      profiles: feature.profiles.map((p) => (p.id === profileId ? { ...p, [field]: text } : p)),
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
    setEditing(null);
    setInvalid(false);
  };

  const setPlace = (constraintId: string, place: DimPlacement) => {
    const next: SketchFeature = {
      ...feature,
      constraints: (feature.constraints ?? []).map((c) =>
        c.id === constraintId ? ({ ...c, place } as SketchConstraint) : c,
      ),
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
  };

  const toggleRadial = (constraintId: string) => {
    const next: SketchFeature = {
      ...feature,
      constraints: (feature.constraints ?? []).map((c) => {
        if (c.id !== constraintId) return c;
        if (c.kind === "radius") {
          return { ...c, kind: "diameter", value: fmt(evalOr(c.value) * 2) } as SketchConstraint;
        }
        if (c.kind === "diameter") {
          return { ...c, kind: "radius", value: fmt(evalOr(c.value) / 2) } as SketchConstraint;
        }
        return c;
      }),
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
  };
  const evalOr = (expr: string): number => {
    try {
      return evaluateExpression(expr, (n) => paramValues[n] ?? NaN);
    } catch {
      return NaN;
    }
  };
  const fmt = (n: number) => String(Math.round(n * 100) / 100);

  // --- SVG drafting (screen space) -----------------------------------------

  const ARROW_PX = 9;
  const arrowPath = (at: Pt, dirLocal: Pt): string | null => {
    const p0 = S(at);
    const p1 = S({ x: at.x + dirLocal.x * 0.5, y: at.y + dirLocal.y * 0.5 });
    if (!p0.inFront || !p1.inFront) return null;
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    // Two barbs at ±25° from the shaft, pointing back from the tip.
    const ang = (25 * Math.PI) / 180;
    const bx = -dx;
    const by = -dy;
    const rot = (a: number) => ({
      x: bx * Math.cos(a) - by * Math.sin(a),
      y: bx * Math.sin(a) + by * Math.cos(a),
    });
    const b1 = rot(ang);
    const b2 = rot(-ang);
    return `M ${p0.x + b1.x * ARROW_PX} ${p0.y + b1.y * ARROW_PX} L ${p0.x} ${p0.y} L ${
      p0.x + b2.x * ARROW_PX
    } ${p0.y + b2.y * ARROW_PX}`;
  };

  const renderGraphics = (g: DimGeometry, key: string, draft: boolean) => {
    const stroke = draft ? "var(--accent, #f0a020)" : "var(--dim, #5b9bd5)";
    const els: React.ReactNode[] = [];
    const seg = (a: Pt, b: Pt, i: number, dash?: boolean) => {
      const pa = S(a);
      const pb = S(b);
      if (!pa.inFront || !pb.inFront) return;
      els.push(
        <line
          key={`${key}-l${i}`}
          x1={pa.x}
          y1={pa.y}
          x2={pb.x}
          y2={pb.y}
          stroke={stroke}
          strokeWidth={1}
          strokeDasharray={dash ? "3 3" : undefined}
          opacity={dash ? 0.6 : 1}
        />,
      );
    };
    g.witness.forEach(([a, b], i) => seg(a, b, i, true));
    g.lines.forEach(([a, b], i) => seg(a, b, 100 + i));
    if (g.arc) {
      const steps = 24;
      const pts: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = g.arc.a0 + ((g.arc.a1 - g.arc.a0) * i) / steps;
        const p = S({ x: g.arc.c.x + Math.cos(a) * g.arc.r, y: g.arc.c.y + Math.sin(a) * g.arc.r });
        if (!p.inFront) return null;
        pts.push(`${p.x},${p.y}`);
      }
      els.push(
        <polyline
          key={`${key}-arc`}
          points={pts.join(" ")}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
        />,
      );
    }
    g.arrows.forEach((ar, i) => {
      const d = arrowPath(ar.at, ar.dir);
      if (d)
        els.push(<path key={`${key}-a${i}`} d={d} fill="none" stroke={stroke} strokeWidth={1.4} />);
    });
    return els;
  };

  // Committed dims → geometry (with any in-progress drag override).
  const rendered = cDims
    .map((cd) => {
      const spec =
        dragPlace && dragPlace.id === cd.constraintId
          ? { ...cd.spec, place: dragPlace.place }
          : cd.spec;
      const g = dimGeometry(spec as DimSpec, entityMap);
      return g ? { cd, g } : null;
    })
    .filter((x): x is { cd: ConstraintDim; g: DimGeometry } => x !== null);

  const draftGeom = dimDraft ? dimGeometry(dimDraft, entityMap) : null;

  return (
    <>
      <svg className="dim-svg" data-testid="dim-graphics">
        {rendered.map(({ cd, g }) => renderGraphics(g, cd.constraintId, false))}
        {draftGeom && renderGraphics(draftGeom, "draft", true)}
      </svg>

      {/* Constraint dimension value labels (editable, draggable). */}
      {rendered.map(({ cd, g }) => {
        const screen = S(g.label);
        if (!screen.inFront) return null;
        const isEditing = editing === cd.constraintId;
        const shown =
          g.unit === "deg"
            ? `${cd.prefix}${Math.round(g.value * 10) / 10}°`
            : `${cd.prefix ? cd.prefix + " " : ""}${Math.round(g.value * 100) / 100}`;
        return (
          <div
            key={cd.constraintId}
            className={`dim-label ${isEditing ? "editing" : ""} ${invalid && isEditing ? "invalid" : ""}`}
            style={{ left: screen.x, top: screen.y }}
            data-testid={`dim-${cd.testId}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (isEditing || e.button !== 0) return;
              // Begin a label drag to reposition the dimension.
              dragRef.current = { constraintId: cd.constraintId, ref: g.ref };
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current;
              if (!drag) return;
              const local = manager.screenToLocal(e.clientX, e.clientY, sketch);
              if (local) {
                setDragPlace({
                  id: drag.constraintId,
                  place: { ox: local.x - drag.ref.x, oy: local.y - drag.ref.y },
                });
              }
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              const drag = dragRef.current;
              dragRef.current = null;
              if (drag && dragPlace && dragPlace.id === drag.constraintId) {
                setPlace(drag.constraintId, dragPlace.place);
                setDragPlace(null);
              }
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (dragPlace) return; // was a drag, not a click
              if (!isEditing) {
                setEditing(cd.constraintId);
                setText(cd.expression);
                setInvalid(false);
              }
            }}
          >
            {isEditing ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input
                  ref={inputRef}
                  data-testid="dim-input"
                  value={text}
                  size={Math.max(4, text.length)}
                  onChange={(e) => {
                    setText(e.target.value);
                    setInvalid(!validate(e.target.value, cd.allowNonPositive));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitValue(cd.constraintId, cd.allowNonPositive);
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(null);
                      setInvalid(false);
                    }
                  }}
                  onBlur={() => commitValue(cd.constraintId, cd.allowNonPositive)}
                />
                {cd.radial && (
                  <button
                    className="dim-toggle"
                    data-testid="dim-toggle-radial"
                    title="Switch radius / diameter"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRadial(cd.constraintId);
                      setEditing(null);
                    }}
                  >
                    {cd.spec.kind === "radius" ? "⌀" : "R"}
                  </button>
                )}
              </span>
            ) : (
              <span>{shown}</span>
            )}
          </div>
        );
      })}

      {/* Draft value label (non-editable preview). */}
      {draftGeom &&
        (() => {
          const screen = S(draftGeom.label);
          if (!screen.inFront) return null;
          const shown =
            draftGeom.unit === "deg"
              ? `${Math.round(draftGeom.value * 10) / 10}°`
              : `${Math.round(draftGeom.value * 100) / 100}`;
          return (
            <div
              className="dim-label draft"
              style={{ left: screen.x, top: screen.y }}
              data-testid="dim-draft"
            >
              {shown}
            </div>
          );
        })()}

      {/* Quick-profile labels (rect/circle). */}
      {pLabels.map((label) => {
        const screen = S({ x: label.x, y: label.y });
        if (!screen.inFront) return null;
        const isEditing = editing === label.key;
        return (
          <div
            key={label.key}
            className={`dim-label ${isEditing ? "editing" : ""} ${invalid && isEditing ? "invalid" : ""}`}
            style={{ left: screen.x, top: screen.y }}
            data-testid={`dim-${label.testId}`}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!isEditing) {
                setSelectedProfile(label.profileId);
                setEditing(label.key);
                setText(label.expression);
                setInvalid(false);
              }
            }}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                data-testid="dim-input"
                value={text}
                size={Math.max(4, text.length)}
                onChange={(e) => {
                  setText(e.target.value);
                  setInvalid(!validate(e.target.value, false));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitProfileValue(label.profileId, label.field, false);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(null);
                    setInvalid(false);
                  }
                }}
                onBlur={() => commitProfileValue(label.profileId, label.field, false)}
              />
            ) : (
              <span>
                {label.prefix} {Math.round(label.value * 100) / 100}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
