/**
 * Dialogs for the second wave of modeling features. Each is a small form over
 * the shared field controls; they read the current selection (edges/faces)
 * where the feature needs one, and dispatch add/update commands.
 */

import { useState } from "react";
import {
  newId,
  type BooleanFeature,
  type ChamferFeature,
  type CircularPatternFeature,
  type Feature,
  type LinearPatternFeature,
  type MirrorFeature,
  type MoveFeature,
  type OriginPlaneName,
  type RevolveFeature,
  type ShellFeature,
} from "@craftbit/core";
import { useDocumentStore } from "../../stores/documentStore";
import { useGeometryStore } from "../../stores/geometryStore";
import { toEdgeRefs, toFaceRefs } from "../../stores/topoRefs";
import { useUiStore } from "../../stores/uiStore";
import { ExpressionInput } from "../ExpressionInput";

function useDialogBase<T extends Feature>(featureId: string | undefined) {
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const { openDialog, showToast, clearSelection } = useUiStore.getState();
  const existing =
    featureId !== undefined ? (doc.features.find((f) => f.id === featureId) as T) : undefined;
  const commit = (feature: T) => {
    if (existing) {
      dispatch({ kind: "updateFeature", featureId: existing.id, next: feature });
    } else {
      dispatch({ kind: "addFeature", feature });
    }
    clearSelection();
    openDialog(null);
  };
  return { doc, existing, commit, cancel: () => openDialog(null), showToast };
}

function BodySelect({
  label,
  value,
  onChange,
  exclude,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  exclude?: string;
}) {
  const result = useGeometryStore((s) => s.result);
  const doc = useDocumentStore((s) => s.doc);
  const bodies = (result?.bodies ?? []).filter((b) => b.id !== exclude);
  return (
    <div className="field">
      <label>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`body-select-${label}`}
      >
        <option value="">— pick a body —</option>
        {bodies.map((b) => (
          <option key={b.id} value={b.id}>
            {doc.features.find((f) => f.id === b.id)?.name ?? b.id.slice(0, 8)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Footer({
  onOk,
  onCancel,
  okTestid,
}: {
  onOk: () => void;
  onCancel: () => void;
  okTestid: string;
}) {
  return (
    <div className="dialog-footer">
      <button className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn primary" onClick={onOk} data-testid={okTestid}>
        OK
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- revolve

export function RevolveDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<RevolveFeature>(featureId);
  const sketches = doc.features.filter((f) => f.type === "sketch");
  const [sketchId, setSketchId] = useState(
    existing?.sketchId ?? sketches[sketches.length - 1]?.id ?? "",
  );
  const [axis, setAxis] = useState<"x" | "y">(existing?.axis ?? "x");
  const [angle, setAngle] = useState(existing?.angle ?? "360");
  const [operation, setOperation] = useState<RevolveFeature["operation"]>(
    existing?.operation ?? "new",
  );

  return (
    <div className="dialog-card" data-testid="revolve-dialog">
      <h2>⟳ Revolve</h2>
      <div className="field">
        <label>Sketch</label>
        <select value={sketchId} onChange={(e) => setSketchId(e.target.value)}>
          {sketches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Axis (sketch-local, through sketch origin)</label>
        <select value={axis} onChange={(e) => setAxis(e.target.value as "x" | "y")}>
          <option value="x">Sketch X axis</option>
          <option value="y">Sketch Y axis</option>
        </select>
      </div>
      <ExpressionInput
        label="Angle (degrees)"
        value={angle}
        onCommit={setAngle}
        testid="revolve-angle"
      />
      <div className="field">
        <label>Operation</label>
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as RevolveFeature["operation"])}
        >
          <option value="new">New body</option>
          <option value="join">Join</option>
          <option value="cut">Cut</option>
        </select>
      </div>
      <Footer
        okTestid="revolve-ok"
        onCancel={cancel}
        onOk={() => {
          if (!sketchId) return showToast("Pick a sketch", true);
          const count = doc.features.filter((f) => f.type === "revolve").length;
          commit({
            id: existing?.id ?? newId(),
            type: "revolve",
            name: existing?.name ?? `Revolve ${count + 1}`,
            suppressed: false,
            sketchId,
            profileIds: [],
            axis,
            angle,
            operation,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- chamfer

export function ChamferDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<ChamferFeature>(featureId);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const [distance, setDistance] = useState(existing?.distance ?? "1");
  const edges = existing && selectedEdges.length === 0 ? existing.edges : selectedEdges;

  return (
    <div className="dialog-card" data-testid="chamfer-dialog">
      <h2>◣ Chamfer</h2>
      <span className="selection-count">
        {edges.length} edge{edges.length === 1 ? "" : "s"} selected
      </span>
      <div className="dialog-hint">Shift-click edges in the viewport to add more.</div>
      <ExpressionInput
        label="Distance (mm)"
        value={distance}
        onCommit={setDistance}
        autoFocus
        testid="chamfer-distance"
      />
      <Footer
        okTestid="chamfer-ok"
        onCancel={cancel}
        onOk={() => {
          if (edges.length === 0) return showToast("Select at least one edge first", true);
          const refs = toEdgeRefs(edges);
          if (!refs) return showToast("Selection is stale — re-pick the edges", true);
          const count = doc.features.filter((f) => f.type === "chamfer").length;
          commit({
            id: existing?.id ?? newId(),
            type: "chamfer",
            name: existing?.name ?? `Chamfer ${count + 1}`,
            suppressed: false,
            edges: refs,
            distance,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- shell

export function ShellDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<ShellFeature>(featureId);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const [thickness, setThickness] = useState(existing?.thickness ?? "2");
  const faces = existing && selectedFaces.length === 0 ? existing.faces : selectedFaces;

  return (
    <div className="dialog-card" data-testid="shell-dialog">
      <h2>▢ Shell</h2>
      <span className="selection-count">
        {faces.length} face{faces.length === 1 ? "" : "s"} to open
      </span>
      <div className="dialog-hint">
        Select the face(s) to remove (the openings); walls of the given thickness remain.
      </div>
      <ExpressionInput
        label="Wall thickness (mm)"
        value={thickness}
        onCommit={setThickness}
        autoFocus
        testid="shell-thickness"
      />
      <Footer
        okTestid="shell-ok"
        onCancel={cancel}
        onOk={() => {
          if (faces.length === 0) return showToast("Select at least one face to open", true);
          const refs = toFaceRefs(faces);
          if (!refs) return showToast("Selection is stale — re-pick the faces", true);
          const count = doc.features.filter((f) => f.type === "shell").length;
          commit({
            id: existing?.id ?? newId(),
            type: "shell",
            name: existing?.name ?? `Shell ${count + 1}`,
            suppressed: false,
            faces: refs,
            thickness,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- mirror

export function MirrorDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<MirrorFeature>(featureId);
  const [bodyId, setBodyId] = useState(existing?.bodyId ?? "");
  const [plane, setPlane] = useState<OriginPlaneName>(existing?.plane ?? "YZ");
  const [merge, setMerge] = useState(existing?.merge ?? true);

  return (
    <div className="dialog-card" data-testid="mirror-dialog">
      <h2>⇋ Mirror</h2>
      <BodySelect label="Body" value={bodyId} onChange={setBodyId} />
      <div className="field">
        <label>Mirror plane (through origin)</label>
        <select value={plane} onChange={(e) => setPlane(e.target.value as OriginPlaneName)}>
          <option value="YZ">YZ plane (flip X)</option>
          <option value="XZ">XZ plane (flip Y)</option>
          <option value="XY">XY plane (flip Z)</option>
        </select>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />{" "}
          Merge with source body
        </label>
      </div>
      <Footer
        okTestid="mirror-ok"
        onCancel={cancel}
        onOk={() => {
          if (!bodyId) return showToast("Pick a body", true);
          const count = doc.features.filter((f) => f.type === "mirror").length;
          commit({
            id: existing?.id ?? newId(),
            type: "mirror",
            name: existing?.name ?? `Mirror ${count + 1}`,
            suppressed: false,
            bodyId,
            plane,
            merge,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- patterns

export function LinearPatternDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } =
    useDialogBase<LinearPatternFeature>(featureId);
  const [bodyId, setBodyId] = useState(existing?.bodyId ?? "");
  const [direction, setDirection] = useState<"x" | "y" | "z">(existing?.direction ?? "x");
  const [spacing, setSpacing] = useState(existing?.spacing ?? "20");
  const [count, setCount] = useState(existing?.count ?? "3");

  return (
    <div className="dialog-card" data-testid="linear-pattern-dialog">
      <h2>⠿ Linear Pattern</h2>
      <BodySelect label="Body" value={bodyId} onChange={setBodyId} />
      <div className="field">
        <label>Direction</label>
        <select value={direction} onChange={(e) => setDirection(e.target.value as "x" | "y" | "z")}>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </div>
      <ExpressionInput
        label="Spacing (mm)"
        value={spacing}
        onCommit={setSpacing}
        testid="pattern-spacing"
      />
      <ExpressionInput label="Count" value={count} onCommit={setCount} testid="pattern-count" />
      <Footer
        okTestid="linear-pattern-ok"
        onCancel={cancel}
        onOk={() => {
          if (!bodyId) return showToast("Pick a body", true);
          const n = doc.features.filter((f) => f.type === "linearPattern").length;
          commit({
            id: existing?.id ?? newId(),
            type: "linearPattern",
            name: existing?.name ?? `Pattern ${n + 1}`,
            suppressed: false,
            bodyId,
            direction,
            spacing,
            count,
          });
        }}
      />
    </div>
  );
}

export function CircularPatternDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } =
    useDialogBase<CircularPatternFeature>(featureId);
  const [bodyId, setBodyId] = useState(existing?.bodyId ?? "");
  const [axis, setAxis] = useState<"x" | "y" | "z">(existing?.axis ?? "z");
  const [count, setCount] = useState(existing?.count ?? "6");

  return (
    <div className="dialog-card" data-testid="circular-pattern-dialog">
      <h2>⊚ Circular Pattern</h2>
      <BodySelect label="Body" value={bodyId} onChange={setBodyId} />
      <div className="field">
        <label>Axis (through origin)</label>
        <select value={axis} onChange={(e) => setAxis(e.target.value as "x" | "y" | "z")}>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </div>
      <ExpressionInput
        label="Count (full circle)"
        value={count}
        onCommit={setCount}
        testid="circular-count"
      />
      <Footer
        okTestid="circular-pattern-ok"
        onCancel={cancel}
        onOk={() => {
          if (!bodyId) return showToast("Pick a body", true);
          const n = doc.features.filter((f) => f.type === "circularPattern").length;
          commit({
            id: existing?.id ?? newId(),
            type: "circularPattern",
            name: existing?.name ?? `Circular ${n + 1}`,
            suppressed: false,
            bodyId,
            axis,
            count,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- boolean

export function BooleanDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<BooleanFeature>(featureId);
  const [targetBodyId, setTarget] = useState(existing?.targetBodyId ?? "");
  const [toolBodyId, setTool] = useState(existing?.toolBodyId ?? "");
  const [op, setOp] = useState<BooleanFeature["op"]>(existing?.op ?? "join");

  return (
    <div className="dialog-card" data-testid="boolean-dialog">
      <h2>⊛ Combine</h2>
      <BodySelect label="Target" value={targetBodyId} onChange={setTarget} />
      <BodySelect
        label="Tool (consumed)"
        value={toolBodyId}
        onChange={setTool}
        exclude={targetBodyId}
      />
      <div className="field">
        <label>Operation</label>
        <select value={op} onChange={(e) => setOp(e.target.value as BooleanFeature["op"])}>
          <option value="join">Join</option>
          <option value="cut">Cut</option>
          <option value="intersect">Intersect</option>
        </select>
      </div>
      <Footer
        okTestid="boolean-ok"
        onCancel={cancel}
        onOk={() => {
          if (!targetBodyId || !toolBodyId) return showToast("Pick target and tool bodies", true);
          const n = doc.features.filter((f) => f.type === "boolean").length;
          commit({
            id: existing?.id ?? newId(),
            type: "boolean",
            name: existing?.name ?? `Combine ${n + 1}`,
            suppressed: false,
            targetBodyId,
            toolBodyId,
            op,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- move

export function MoveDialog({ featureId }: { featureId?: string }) {
  const { doc, existing, commit, cancel, showToast } = useDialogBase<MoveFeature>(featureId);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const [bodyId, setBodyId] = useState(existing?.bodyId ?? selectedFaces[0]?.bodyId ?? "");
  const [tx, setTx] = useState(existing?.tx ?? "0");
  const [ty, setTy] = useState(existing?.ty ?? "0");
  const [tz, setTz] = useState(existing?.tz ?? "0");
  const [rotAxis, setRotAxis] = useState<"x" | "y" | "z">(existing?.rotAxis ?? "z");
  const [rotAngle, setRotAngle] = useState(existing?.rotAngle ?? "0");

  return (
    <div className="dialog-card" data-testid="move-dialog">
      <h2>✥ Move / Rotate</h2>
      <div className="dialog-hint">Position parts relative to each other for assembly.</div>
      <BodySelect label="Body" value={bodyId} onChange={setBodyId} />
      <ExpressionInput label="Move X (mm)" value={tx} onCommit={setTx} testid="move-tx" />
      <ExpressionInput label="Move Y (mm)" value={ty} onCommit={setTy} testid="move-ty" />
      <ExpressionInput label="Move Z (mm)" value={tz} onCommit={setTz} testid="move-tz" />
      <div className="field">
        <label>Rotation axis (through origin)</label>
        <select value={rotAxis} onChange={(e) => setRotAxis(e.target.value as "x" | "y" | "z")}>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </div>
      <ExpressionInput
        label="Rotation angle (deg)"
        value={rotAngle}
        onCommit={setRotAngle}
        testid="move-angle"
      />
      <Footer
        okTestid="move-ok"
        onCancel={cancel}
        onOk={() => {
          if (!bodyId) return showToast("Pick a body", true);
          const n = doc.features.filter((f) => f.type === "move").length;
          commit({
            id: existing?.id ?? newId(),
            type: "move",
            name: existing?.name ?? `Move ${n + 1}`,
            suppressed: false,
            bodyId,
            tx,
            ty,
            tz,
            rotAxis,
            rotAngle,
          });
        }}
      />
    </div>
  );
}
