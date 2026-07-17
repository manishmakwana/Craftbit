import { useState } from "react";
import {
  sampleLoopPolygon,
  sketchToDxf,
  sketchToSvg,
  type Evaluated2dProfile,
} from "@craftbit/core";
import type { EvaluatedProfile, StlValidation } from "@craftbit/geometry-worker";
import { useDocumentStore } from "../../stores/documentStore";
import { useGeometryStore } from "../../stores/geometryStore";
import { useUiStore } from "../../stores/uiStore";
import { downloadFile } from "../../stores/persistence";

export function ExportDialog() {
  const doc = useDocumentStore((s) => s.doc);
  const result = useGeometryStore((s) => s.result);
  const { exportStl, exportStep } = useGeometryStore.getState();
  const { openDialog, showToast } = useUiStore.getState();

  const [busy, setBusy] = useState<string | null>(null);
  const [stlReport, setStlReport] = useState<StlValidation | null>(null);

  const hasBodies = (result?.bodies.length ?? 0) > 0;
  const sketches = result?.sketches ?? [];
  const baseName = doc.name.replace(/[^\w-]+/g, "_") || "craftbit";

  const doStl = async () => {
    setBusy("stl");
    try {
      const { bytes, validation } = await exportStl(doc);
      setStlReport(validation);
      if (validation.watertight) {
        downloadFile(`${baseName}.stl`, bytes.slice().buffer, "model/stl");
        showToast(`STL exported — ${validation.triangleCount} triangles, watertight ✓`);
      } else {
        showToast(
          `Mesh has ${validation.openEdgeCount} open edges — fix the model or export anyway below`,
          true,
        );
      }
    } catch (e) {
      showToast(`STL export failed: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const doStlAnyway = async () => {
    setBusy("stl");
    try {
      const { bytes } = await exportStl(doc);
      downloadFile(`${baseName}.stl`, bytes.slice().buffer, "model/stl");
    } finally {
      setBusy(null);
    }
  };

  const doStep = async () => {
    setBusy("step");
    try {
      const bytes = await exportStep(doc);
      downloadFile(`${baseName}.step`, bytes.slice().buffer, "application/step");
      showToast("STEP exported");
    } catch (e) {
      showToast(`STEP export failed: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-card" data-testid="export-dialog">
      <h2>⇩ Export</h2>

      <div className="panel-section">
        <h3>3D printing</h3>
        <button
          className="btn"
          style={{ width: "100%" }}
          disabled={!hasBodies || busy !== null}
          onClick={doStl}
          data-testid="export-stl"
        >
          {busy === "stl" ? "Exporting…" : "Binary STL (mm) — validated"}
        </button>
        {stlReport && (
          <div className="dialog-hint" style={{ marginTop: 6 }} data-testid="stl-report">
            {stlReport.triangleCount} triangles ·{" "}
            {stlReport.watertight ? "watertight ✓" : `${stlReport.openEdgeCount} open edges ✗`}
            <br />
            {(stlReport.boundsMm.max[0] - stlReport.boundsMm.min[0]).toFixed(2)} ×{" "}
            {(stlReport.boundsMm.max[1] - stlReport.boundsMm.min[1]).toFixed(2)} ×{" "}
            {(stlReport.boundsMm.max[2] - stlReport.boundsMm.min[2]).toFixed(2)} mm
            {!stlReport.watertight && (
              <>
                <br />
                <button className="btn danger-text" style={{ marginTop: 4 }} onClick={doStlAnyway}>
                  Export anyway
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="panel-section">
        <h3>CNC / CAD interchange</h3>
        <button
          className="btn"
          style={{ width: "100%" }}
          disabled={!hasBodies || busy !== null}
          onClick={doStep}
          data-testid="export-step"
        >
          {busy === "step" ? "Exporting…" : "STEP (AP203/214)"}
        </button>
      </div>

      <div className="panel-section">
        <h3>Laser cutting (per sketch)</h3>
        {sketches.length === 0 && <div className="dialog-hint">No sketches to export.</div>}
        {sketches.map((s) => {
          const feature = doc.features.find((f) => f.id === s.featureId);
          const name = feature?.name ?? "Sketch";
          // 2D fabrication export flattens constraint-sketcher loops to
          // fine polylines (arcs sampled at 64 chords — well under laser
          // kerf at hobby scales).
          const profiles2d: Evaluated2dProfile[] = s.profiles.map((p: EvaluatedProfile) =>
            p.kind === "loop"
              ? {
                  id: p.id,
                  kind: "polygon" as const,
                  points: sampleLoopPolygon({ id: p.id, segments: p.segments }, 64),
                }
              : p,
          );
          return (
            <div key={s.featureId} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <span style={{ flex: 1, alignSelf: "center" }}>{name}</span>
              <button
                className="btn"
                data-testid="export-svg"
                disabled={profiles2d.length === 0}
                onClick={() => {
                  downloadFile(`${baseName}-${name}.svg`, sketchToSvg(profiles2d), "image/svg+xml");
                  showToast("SVG exported at exact 1:1 mm scale");
                }}
              >
                SVG
              </button>
              <button
                className="btn"
                data-testid="export-dxf"
                disabled={profiles2d.length === 0}
                onClick={() => {
                  downloadFile(
                    `${baseName}-${name}.dxf`,
                    sketchToDxf(profiles2d),
                    "application/dxf",
                  );
                  showToast("DXF (R12, mm) exported");
                }}
              >
                DXF
              </button>
            </div>
          );
        })}
      </div>

      <div className="dialog-footer">
        <button className="btn primary" onClick={() => openDialog(null)}>
          Done
        </button>
      </div>
    </div>
  );
}
