/**
 * On-canvas dimensions for the active sketch (spec §7.6 UI): each profile
 * shows clickable labels — width/height for rectangles, radius for circles —
 * positioned on the drawing itself. Clicking a label opens an inline
 * expression editor; committing updates the feature and the geometry
 * regenerates, so the drawing follows the dimension immediately.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { evaluateExpression, type SketchFeature } from "@craftbit/core";
import type { EvaluatedSketch } from "@craftbit/geometry-worker";
import type { SceneManager } from "./sceneManager";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore } from "../stores/uiStore";

interface DimLabel {
  profileId: string;
  /** Field on the profile this label edits (e.g. "width", "radius"). */
  field: string;
  /** Short prefix shown before the value ("W", "H", "R"). */
  prefix: string;
  /** Current raw expression (shown when editing). */
  expression: string;
  /** Evaluated value in mm (shown when idle). */
  value: number;
  /** Anchor position in sketch-local coords. */
  x: number;
  y: number;
}

function labelsFor(sketch: EvaluatedSketch, feature: SketchFeature): DimLabel[] {
  const labels: DimLabel[] = [];
  for (const evaluated of sketch.profiles) {
    const raw = feature.profiles.find((p) => p.id === evaluated.id);
    if (!raw) continue;
    if (evaluated.kind === "rect" && raw.kind === "rect") {
      labels.push({
        profileId: evaluated.id,
        field: "width",
        prefix: "W",
        expression: raw.width,
        value: evaluated.width,
        x: evaluated.x + evaluated.width / 2,
        y: evaluated.y,
      });
      labels.push({
        profileId: evaluated.id,
        field: "height",
        prefix: "H",
        expression: raw.height,
        value: evaluated.height,
        x: evaluated.x,
        y: evaluated.y + evaluated.height / 2,
      });
    } else if (evaluated.kind === "circle" && raw.kind === "circle") {
      labels.push({
        profileId: evaluated.id,
        field: "radius",
        prefix: "R",
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

  const [editing, setEditing] = useState<{ profileId: string; field: string } | null>(null);
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
  const labels = useMemo(
    () => (feature?.type === "sketch" ? labelsFor(sketch, feature) : []),
    [sketch, feature],
  );

  if (feature?.type !== "sketch") return null;

  const paramValues = result?.parameterValues ?? {};
  const validate = (t: string): boolean => {
    try {
      const v = evaluateExpression(t, (name) => {
        const value = paramValues[name];
        if (value === undefined) throw new Error(`Unknown parameter "${name}"`);
        return value;
      });
      return v > 0 || ["x", "y", "cx", "cy"].includes(editing?.field ?? "");
    } catch {
      return false;
    }
  };

  const commit = () => {
    if (!editing) return;
    if (!validate(text)) {
      setInvalid(true);
      return;
    }
    const next: SketchFeature = {
      ...feature,
      profiles: feature.profiles.map((p) =>
        p.id === editing.profileId ? { ...p, [editing.field]: text } : p,
      ),
    };
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
        const isEditing = editing?.profileId === label.profileId && editing.field === label.field;
        return (
          <div
            key={`${label.profileId}-${label.field}`}
            className={`dim-label ${isEditing ? "editing" : ""} ${invalid && isEditing ? "invalid" : ""}`}
            style={{ left: screen.x, top: screen.y }}
            data-testid={`dim-${label.prefix}`}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!isEditing) {
                setSelectedProfile(label.profileId);
                setEditing({ profileId: label.profileId, field: label.field });
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
                  setInvalid(!validate(e.target.value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(null);
                    setInvalid(false);
                  }
                }}
                onBlur={commit}
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
