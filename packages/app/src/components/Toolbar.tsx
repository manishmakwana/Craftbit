import {
  newId,
  type ImportStepFeature,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
} from "@craftbit/core";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { useUiStore, type DialogState, type SketchTool } from "../stores/uiStore";

export function Toolbar() {
  const mode = useUiStore((s) => s.mode);
  return mode === "sketch" ? <SketchToolbar /> : <ModelToolbar />;
}

function importStepFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const feature: ImportStepFeature = {
      id: newId(),
      type: "importStep",
      name: file.name.replace(/\.(step|stp)$/i, ""),
      suppressed: false,
      fileName: file.name,
      dataB64: btoa(bin),
    };
    useDocumentStore.getState().dispatch({ kind: "addFeature", feature });
    useUiStore.getState().showToast(`Importing ${file.name}…`);
  };
  input.click();
}

function ModelToolbar() {
  const openDialog = useUiStore((s) => s.openDialog);
  const selectedEdges = useUiStore((s) => s.selectedEdges);
  const selectedFaces = useUiStore((s) => s.selectedFaces);
  const doc = useDocumentStore((s) => s.doc);
  const hasSketch = doc.features.some((f) => f.type === "sketch");
  const hasBody = doc.features.some(
    (f) =>
      (f.type === "extrude" && f.operation === "new") ||
      f.type === "importStep" ||
      (f.type === "revolve" && f.operation === "new"),
  );

  const btn = (
    testid: string,
    label: string,
    dialog: DialogState,
    opts?: { disabled?: boolean; title?: string },
  ) => (
    <button
      className="btn"
      data-testid={testid}
      disabled={opts?.disabled}
      title={opts?.title ?? label}
      onClick={() => openDialog(dialog)}
    >
      {label}
    </button>
  );

  return (
    <div className="toolbar">
      {btn(
        "tool-new-sketch",
        "✏ Sketch",
        { kind: "planeChooser" },
        { title: "Create a sketch (S)" },
      )}
      {btn(
        "tool-extrude",
        "⬆ Extrude",
        { kind: "extrude" },
        { disabled: !hasSketch, title: "Extrude a sketch (E)" },
      )}
      {btn("tool-revolve", "⟳ Revolve", { kind: "revolve" }, { disabled: !hasSketch })}
      <span style={{ width: 8 }} />
      {btn(
        "tool-fillet",
        "◠ Fillet",
        { kind: "fillet" },
        { disabled: selectedEdges.length === 0, title: "Fillet selected edges" },
      )}
      {btn(
        "tool-chamfer",
        "◣ Chamfer",
        { kind: "chamfer" },
        { disabled: selectedEdges.length === 0, title: "Chamfer selected edges" },
      )}
      {btn(
        "tool-shell",
        "▢ Shell",
        { kind: "shell" },
        {
          disabled: selectedFaces.length === 0,
          title: "Hollow the body, opening the selected faces",
        },
      )}
      <span style={{ width: 8 }} />
      {btn("tool-mirror", "⇋ Mirror", { kind: "mirror" }, { disabled: !hasBody })}
      {btn("tool-linear-pattern", "⠿ Pattern", { kind: "linearPattern" }, { disabled: !hasBody })}
      {btn(
        "tool-circular-pattern",
        "⊚ Circular",
        { kind: "circularPattern" },
        { disabled: !hasBody },
      )}
      {btn("tool-boolean", "⊛ Combine", { kind: "boolean" }, { disabled: !hasBody })}
      {btn(
        "tool-move",
        "✥ Move",
        { kind: "move" },
        { disabled: !hasBody, title: "Move/rotate a body (assembly positioning)" },
      )}
      {btn(
        "tool-joint",
        "⚯ Joint",
        { kind: "joint" },
        { disabled: !hasBody, title: "Joint: mate two bodies via faces or circular edges" },
      )}
      <span style={{ width: 8 }} />
      <button
        className="btn"
        data-testid="tool-import-step"
        onClick={importStepFile}
        title="Import a STEP file as a new body"
      >
        ⇪ Import STEP
      </button>
      <span className="spacer" style={{ flex: 1 }} />
      {btn("tool-parameters", "ƒx Parameters", { kind: "parameters" })}
    </div>
  );
}

/** Rounds a live-measured dimension for use as a constraint's initial value. */
const measured = (n: number) => String(Math.round(n * 100) / 100);

/** Omit distributed over a union (plain Omit collapses union members). */
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

function SketchToolbar() {
  const tool = useUiStore((s) => s.sketchTool);
  const setTool = useUiStore((s) => s.setSketchTool);
  const exitSketch = useUiStore((s) => s.exitSketch);
  const activeSketchId = useUiStore((s) => s.activeSketchId);
  const selectedEntityIds = useUiStore((s) => s.selectedEntityIds);
  const doc = useDocumentStore((s) => s.doc);
  const dispatch = useDocumentStore((s) => s.dispatch);
  const result = useGeometryStore((s) => s.result);

  const feature = doc.features.find(
    (f): f is SketchFeature => f.id === activeSketchId && f.type === "sketch",
  );
  const evaluated = result?.sketches.find((s) => s.featureId === activeSketchId);
  // Solved coordinates (for measuring initial dimension values) with the
  // document as fallback before the first regen lands.
  const entities = evaluated?.entities?.length ? evaluated.entities : (feature?.entities ?? []);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const selected = selectedEntityIds
    .map((id) => byId.get(id))
    .filter((e): e is SketchEntity => e !== undefined);
  const pts = selected.filter((e) => e.kind === "point");
  const lines = selected.filter((e) => e.kind === "line");
  const rounds = selected.filter((e) => e.kind === "circle" || e.kind === "arc");
  const coord = (id: string): { x: number; y: number } => {
    const e = byId.get(id);
    return e && e.kind === "point" ? e : { x: 0, y: 0 };
  };

  const addConstraint = (c: DistributiveOmit<SketchConstraint, "id">) => {
    if (!feature) return;
    const next: SketchFeature = {
      ...feature,
      constraints: [...(feature.constraints ?? []), { ...c, id: newId() } as SketchConstraint],
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
    useUiStore.getState().selectEntity(null);
  };

  const deleteSelected = () => {
    if (!feature || selected.length === 0) return;
    const removed = new Set(selected.map((e) => e.id));
    // Deleting a point cascades to curves referencing it; constraints
    // referencing anything removed are dropped.
    for (const e of feature.entities ?? []) {
      if (removed.has(e.id)) continue;
      if (e.kind === "line" && (removed.has(e.p1) || removed.has(e.p2))) removed.add(e.id);
      if (e.kind === "circle" && removed.has(e.center)) removed.add(e.id);
      if (
        e.kind === "arc" &&
        (removed.has(e.center) || removed.has(e.start) || removed.has(e.end))
      ) {
        removed.add(e.id);
      }
    }
    const refs = (c: SketchConstraint): string[] => {
      const anyC = c as unknown as Record<string, string>;
      return ["a", "b", "line", "circle", "entity", "point"]
        .map((k) => anyC[k])
        .filter((v): v is string => typeof v === "string");
    };
    const next: SketchFeature = {
      ...feature,
      entities: (feature.entities ?? []).filter((e) => !removed.has(e.id)),
      constraints: (feature.constraints ?? []).filter((c) => !refs(c).some((r) => removed.has(r))),
    };
    dispatch({ kind: "updateFeature", featureId: feature.id, next });
    useUiStore.getState().selectEntity(null);
  };

  const tools: { id: SketchTool; label: string; testid: string }[] = [
    { id: "select", label: "☝ Select", testid: "sketch-tool-select" },
    { id: "line", label: "╱ Line", testid: "sketch-tool-line" },
    { id: "rect", label: "▭ Rectangle", testid: "sketch-tool-rect" },
    { id: "circle", label: "◯ Circle", testid: "sketch-tool-circle" },
    { id: "polygon", label: "⬠ Polygon", testid: "sketch-tool-polygon" },
    { id: "dimension", label: "↔ Dimension", testid: "sketch-tool-dimension" },
  ];

  const cbtn = (
    testid: string,
    label: string,
    title: string,
    enabled: boolean,
    act: () => void,
  ) => (
    <button className="btn" data-testid={testid} disabled={!enabled} title={title} onClick={act}>
      {label}
    </button>
  );

  const twoPts = pts.length === 2 && selected.length === 2;
  const oneLine = lines.length === 1 && selected.length === 1;
  const twoLines = lines.length === 2 && selected.length === 2;
  const oneRound = rounds.length === 1 && selected.length === 1;
  const lineAndRound = lines.length === 1 && rounds.length === 1 && selected.length === 2;

  const dist = () => {
    const [p, q] = [pts[0]!, pts[1]!] as [
      Extract<SketchEntity, { kind: "point" }>,
      Extract<SketchEntity, { kind: "point" }>,
    ];
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  const roundRadius = (e: SketchEntity): number => {
    if (e.kind === "circle") return e.radius;
    if (e.kind === "arc") {
      const c = coord(e.center);
      const s = coord(e.start);
      return Math.hypot(s.x - c.x, s.y - c.y);
    }
    return 0;
  };

  const solve = evaluated?.solve;

  return (
    <div className="toolbar">
      {tools.map((t) => (
        <button
          key={t.id}
          data-testid={t.testid}
          className={`btn ${tool === t.id ? "active" : ""}`}
          onClick={() => setTool(t.id)}
        >
          {t.label}
        </button>
      ))}
      <span style={{ width: 12 }} />
      {cbtn("constraint-horizontal", "―", "Horizontal (selected line)", oneLine, () =>
        addConstraint({ kind: "horizontal", line: lines[0]!.id }),
      )}
      {cbtn("constraint-vertical", "❘", "Vertical (selected line)", oneLine, () =>
        addConstraint({ kind: "vertical", line: lines[0]!.id }),
      )}
      {cbtn("constraint-parallel", "∥", "Parallel (two lines)", twoLines, () =>
        addConstraint({ kind: "parallel", a: lines[0]!.id, b: lines[1]!.id }),
      )}
      {cbtn("constraint-perpendicular", "⊥", "Perpendicular (two lines)", twoLines, () =>
        addConstraint({ kind: "perpendicular", a: lines[0]!.id, b: lines[1]!.id }),
      )}
      {cbtn(
        "constraint-equal",
        "＝",
        "Equal (two lines or two circles/arcs)",
        twoLines || (rounds.length === 2 && selected.length === 2),
        () =>
          twoLines
            ? addConstraint({ kind: "equalLength", a: lines[0]!.id, b: lines[1]!.id })
            : addConstraint({ kind: "equalRadius", a: rounds[0]!.id, b: rounds[1]!.id }),
      )}
      {cbtn("constraint-coincident", "◉", "Coincident (two points)", twoPts, () =>
        addConstraint({ kind: "coincident", a: pts[0]!.id, b: pts[1]!.id }),
      )}
      {cbtn("constraint-tangent", "⌒", "Tangent (line + circle/arc)", lineAndRound, () =>
        addConstraint({ kind: "tangent", line: lines[0]!.id, circle: rounds[0]!.id }),
      )}
      {cbtn(
        "constraint-fix",
        "⚓",
        "Fix point in place",
        pts.length === 1 && selected.length === 1,
        () => addConstraint({ kind: "fixed", point: pts[0]!.id }),
      )}
      <span style={{ width: 12 }} />
      {cbtn("constraint-distance", "↔ Dim", "Distance dimension (two points)", twoPts, () =>
        addConstraint({ kind: "distance", a: pts[0]!.id, b: pts[1]!.id, value: measured(dist()) }),
      )}
      {cbtn("constraint-radius", "R Dim", "Radius dimension (circle/arc)", oneRound, () =>
        addConstraint({
          kind: "radius",
          entity: rounds[0]!.id,
          value: measured(roundRadius(rounds[0]!)),
        }),
      )}
      {cbtn("constraint-angle", "∠ Dim", "Angle dimension (two lines)", twoLines, () => {
        const dir = (l: Extract<SketchEntity, { kind: "line" }>) => {
          const p1 = coord(l.p1);
          const p2 = coord(l.p2);
          return { x: p2.x - p1.x, y: p2.y - p1.y };
        };
        const a = dir(lines[0]! as Extract<SketchEntity, { kind: "line" }>);
        const b = dir(lines[1]! as Extract<SketchEntity, { kind: "line" }>);
        const deg = (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI;
        addConstraint({ kind: "angle", a: lines[0]!.id, b: lines[1]!.id, value: measured(deg) });
      })}
      {cbtn(
        "sketch-delete-entities",
        "🗑",
        "Delete selected entities",
        selected.length > 0,
        deleteSelected,
      )}
      <span className="spacer" style={{ flex: 1 }} />
      {solve && (
        <span
          className={`dof-badge ${solve.converged ? (solve.dof === 0 ? "full" : "") : "error"}`}
          data-testid="dof-badge"
          title="Sketch constraint status"
        >
          {!solve.converged
            ? "⚠ Over-constrained"
            : solve.dof === 0
              ? "✓ Fully constrained"
              : `${solve.dof} DOF`}
        </span>
      )}
      <button className="btn primary" data-testid="finish-sketch" onClick={exitSketch}>
        ✓ Finish Sketch
      </button>
    </div>
  );
}
