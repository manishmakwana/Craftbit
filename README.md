# Craftbit

Free, open-source, web-based parametric CAD — model, assemble, and export for 3D
printing, laser cutting, and CNC, entirely in the browser. No install, no account.

Full product & engineering spec: [`docs/SPEC.md`](docs/SPEC.md).

## Status

**Working parametric modeler (v1 core loop).** The GP-1 golden path from the spec runs
end to end in the browser: sketch a rectangle → dimension it with expressions → extrude
→ sketch circles on a face → cut holes → fillet edges → export a validated, watertight
binary STL (plus STEP, and exact-scale SVG/DXF from sketches). Includes: feature
timeline with edit/delete and per-feature error reporting, named parameters with an
expression engine (units, fractions like `3/8in`, functions), unlimited undo/redo,
IndexedDB autosave that survives reload, and `.craftbit` file save/open.

Known deltas from the full spec (deliberate, tracked):
- Sketching is profile-based (rect/circle/polygon with expression dimensions), not yet
  the PlaneGCS constraint solver of spec §7.6 (design gate D3).
- Feature references use body+index addressing, not stable topological naming (D2).
- Assembly (§7.10), import (§7.12), and the remaining modeling features of §7.7 are
  not yet implemented.
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