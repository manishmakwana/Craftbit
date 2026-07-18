/**
 * On-canvas dimensions for the active sketch (spec §7.6 UI): clickable
 * labels positioned on the drawing itself — width/height/radius for legacy
 * profiles, and distance/radius/angle for constraint-sketcher dimensional
 * constraints (D3). Clicking a label opens an inline expression editor;
 * committing updates the feature and the geometry regenerates, so the
 * drawing follows the dimension immediately.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  evaluateExpression,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
} from "@craftbit/core";
import type { EvaluatedSketch } from "@craftbit/geometry-worker";
import type { SceneManager } from "./sceneManager";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

type DimTarget =
  | { type: "profile"; profileId: string; field: string }
  | { type: "constraint"; constraintId: string };

interface DimLabel {
  key: string;
  target: DimTarget;
  /** Short prefix shown before the value ("W", "H", "R", "D", "∠"). */
  prefix: string;
  /** Test-id suffix (ASCII-safe). */
  testId: string;
  /** Current raw expression (shown when editing). */
  expression: string;
  /** Evaluated value (mm, or degrees for angles). */
  value: number;
  /** Anchor position in sketch-local coords. */
  x: number;
  y: number;
  /** Values that may legally be ≤ 0 (angles). */
  allowNonPositive?: boolean;
}

function profileLabels(sketch: EvaluatedSketch, feature: SketchFeature): DimLabel[] {
  const labels: DimLabel[] = [];
  for (const evaluated of sketch.profiles) {
    const raw = feature.profiles.find((p) => p.id === evaluated.id);
    if (!raw) continue;
    if (evaluated.kind === "rect" && raw.kind === "rect") {
      labels.push({
        key: `${evaluated.id}-width`,
        target: { type: "profile", profileId: evaluated.id, field: "width" },
        prefix: "W",
        testId: "W",
        expression: raw.width,
        value: evaluated.width,
        x: evaluated.x + evaluated.width / 2,
        y: evaluated.y,
      });
      labels.push({
        key: `${evaluated.id}-height`,
        target: { type: "profile", profileId: evaluated.id, field: "height" },
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
        target: { type: "profile", profileId: evaluated.id, field: "radius" },
        prefix: "R",
        testId: "R",
        expression: raw.radius,
        value: evaluated.radius,
        x: evaluated.cx + evaluated.radius * 0.7071,
        y: evaluated.cy + evaluated.radius * 0.7071,
      });
    }
    // Polygons are freehand — no dimension labels.
  }
  return labels;
}

/** Labels for dimensional constraints, anchored on the solved geometry. */
function constraintLabels(entities: SketchEntity[], constraints: SketchConstraint[]): DimLabel[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const pointOf = (id: string): { x: number; y: number } | null => {
    const e = byId.get(id);
    return e && e.kind === "point" ? e : null;
  };
  const labels: DimLabel[] = [];
  for (const c of constraints) {
    if (c.kind === "distance") {
      const a = pointOf(c.a);
      const b = pointOf(c.b);
      if (!a || !b) continue;
      labels.push({
        key: c.id,
        target: { type: "constraint", constraintId: c.id },
        prefix: "D",
        testId: "D",
        expression: c.value,
        value: Math.hypot(a.x - b.x, a.y - b.y),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
    } else if (c.kind === "radius") {
      const ent = byId.get(c.entity);
      if (!ent || (ent.kind !== "circle" && ent.kind !== "arc")) continue;
      const center = pointOf(ent.kind === "circle" ? ent.center : ent.center);
      if (!center) continue;
      let radius = 0;
      let anchor = { x: center.x, y: center.y };
      if (ent.kind === "circle") {
        radius = ent.radius;
        anchor = { x: center.x + radius * 0.7071, y: center.y + radius * 0.7071 };
      } else {
        const s = pointOf(ent.start);
        if (!s) continue;
        radius = Math.hypot(s.x - center.x, s.y - center.y);
        anchor = {
          x: center.x + (s.x - center.x) / 2,
          y: center.y + (s.y - center.y) / 2,
        };
      }
      labels.push({
        key: c.id,
        target: { type: "constraint", constraintId: c.id },
        prefix: "R",
        testId: "CR",
        expression: c.value,
        value: radius,
        x: anchor.x,
        y: anchor.y,
      });
    } else if (c.kind === "angle") {
      const la = byId.get(c.a);
      const lb = byId.get(c.b);
      if (!la || la.kind !== "line" || !lb || lb.kind !== "line") continue;
      const mids: { x: number; y: number }[] = [];
      for (const l of [la, lb]) {
        const p1 = pointOf(l.p1);
        const p2 = pointOf(l.p2);
        if (p1 && p2) mids.push({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
      }
      if (mids.length !== 2) continue;
      const dir = (l: typeof la): { x: number; y: number } => {
        const p1 = pointOf(l.p1)!;
        const p2 = pointOf(l.p2)!;
        return { x: p2.x - p1.x, y: p2.y - p1.y };
      };
      const da = dir(la);
      const db = dir(lb);
      const deg =
        (Math.atan2(da.x * db.y - da.y * db.x, da.x * db.x + da.y * db.y) * 180) / Math.PI;
      labels.push({
        key: c.id,
        target: { type: "constraint", constraintId: c.id },
        prefix: "∠",
        testId: "A",
        expression: c.value,
        value: deg,
        x: (mids[0]!.x + mids[1]!.x) / 2,
        y: (mids[0]!.y + mids[1]!.y) / 2,
        allowNonPositive: true,
      });
    }
  }
  return labels;
}

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

  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  // Bumped on camera movement so labels track the view.
  const [, setViewTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => manager.onViewChange(() => setViewTick((t) => t + 1)), [manager]);
  useEffect(() => {
    inputRef.current?.select();
  }, [editing]);

  const feature = doc.features.find((f) => f.id === sketch.featureId);
  const labels = useMemo(() => {
    if (feature?.type !== "sketch") return [];
    return [
      ...profileLabels(sketch, feature),
      ...constraintLabels(
        sketch.entities.length > 0 ? sketch.entities : (feature.entities ?? []),
        feature.constraints ?? [],
      ),
    ];
  }, [sketch, feature]);

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

  const commit = (label: DimLabel) => {
    if (!validate(text, label.allowNonPositive ?? false)) {
      setInvalid(true);
      return;
    }
    let next: SketchFeature;
    if (label.target.type === "profile") {
      const { profileId, field } = label.target;
      next = {
        ...feature,
        profiles: feature.profiles.map((p) => (p.id === profileId ? { ...p, [field]: text } : p)),
      };
    } else {
      const { constraintId } = label.target;
      next = {
        ...feature,
        constraints: (feature.constraints ?? []).map((c) =>
          c.id === constraintId ? ({ ...c, value: text } as SketchConstraint) : c,
        ),
      };
    }
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
    setEditing(null);
    setInvalid(false);
  };

  const toWorld = (x: number, y: number): THREE.Vector3 => {
    const { origin, xdir, ydir } = sketch.plane;
    return new THREE.Vector3(
      origin[0] + xdir[0] * x + ydir[0] * y,
      origin[1] + xdir[1] * x + ydir[1] * y,
      origin[2] + xdir[2] * x + ydir[2] * y,
    );
  };

  return (
    <>
      {labels.map((label) => {
        const screen = manager.projectToScreen(toWorld(label.x, label.y));
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
                if (label.target.type === "profile") setSelectedProfile(label.target.profileId);
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
                  setInvalid(!validate(e.target.value, label.allowNonPositive ?? false));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(label);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(null);
                    setInvalid(false);
                  }
                }}
                onBlur={() => commit(label)}
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
