# Craftbit

Free, open-source, web-based parametric CAD — model, assemble, and export for 3D
printing, laser cutting, and CNC, entirely in the browser. No install, no account.

Full product & engineering spec: [`docs/SPEC.md`](docs/SPEC.md).

## Status

Milestone 0 (foundation) complete: monorepo scaffold, and a real OpenCascade.js (OCCT)
WASM kernel running in a Web Worker, tessellating a solid and rendering it in a Three.js
viewport. See `docs/design/D1-worker-rpc-protocol.md` for the worker RPC design.

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