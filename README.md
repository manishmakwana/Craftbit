# Craftbit

Free, open-source, web-based parametric CAD — model, assemble, and export for 3D
printing, laser cutting, and CNC, entirely in the browser. No install, no account.

Full product & engineering spec: [`docs/SPEC.md`](docs/SPEC.md).

## Status

**Working parametric CAD covering the v1 goal: model → assemble → fabricate.**
Everything below runs in the browser, verified end to end by automated browser tests
and 44 unit/kernel-regression tests (18 of which assert exact closed-form volumes
against the real OCCT kernel):

- **Sketch** on origin planes or picked planar faces: rectangles, circles, polygons,
  every dimension an expression (units, fractions like `3/8in`, functions, named
  parameters with cycle detection).
- **Model**: extrude (new/join/cut; normal/reversed/symmetric), revolve, fillet,
  chamfer, shell, mirror, linear & circular patterns, boolean combine
  (join/cut/intersect).
- **Assemble**: multiple bodies per document, move/rotate positioning with
  expression-driven offsets, mirror-to-new-body, per-body colors, STEP **import**
  (embedded in the document, fully parametric downstream).
- **Fabricate**: validated watertight binary STL (edge-manifold check + bounds
  report), STEP AP203/214, exact-1:1-scale SVG and DXF R12 from any sketch.
- **Never lose work**: feature timeline with edit/delete and per-feature error
  reporting, unlimited undo/redo, IndexedDB autosave surviving reload, `.craftbit`
  file save/open.

Known deltas from the full spec (deliberate, tracked):
- Sketching is profile-based (rect/circle/polygon with expression dimensions), not yet
  the PlaneGCS constraint solver of spec §7.6 (design gate D3).
- Feature references use body+index addressing, not stable topological naming (D2).
- Assembly is positioning-based (move/rotate features), not the joint solver of §7.10
  (design gate D6); STL/DXF/SVG import (§7.12) not yet implemented (STEP import works).
- Kernel is the prebuilt OCCT 7.4 full build (~14 MB gzipped), not the custom minimal
  build of §4.2.

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm dev          # starts the app dev server
pnpm typecheck    # tsc --noEmit across all packages
pnpm lint         # eslint
pnpm format       # prettier --check
pnpm test         # vitest
pnpm build        # production build of all packages
```

### Workspace layout

- `packages/core` — framework-free document model, schemas, commands (spec §6)
- `packages/geometry-worker` — OCCT WASM integration, runs in a Web Worker (spec §4)
- `packages/app` — React + Three.js UI
- `docs/` — spec, ADRs, per-subsystem design docs
- `perf/` — performance harness (spec §8)