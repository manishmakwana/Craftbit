# D1: Worker RPC Protocol & Kernel Lifecycle

**Status:** Draft (written at M0, per spec §12.1 — to be finalized before M1 is considered
done; open questions below must be resolved first).

## Context

Serves spec §4.1 (process/thread topology) and §4.2 (OCCT WASM build). The geometry
kernel (OCCT) and, from M3 onward, the sketch constraint solver (PlaneGCS) run in
dedicated Web Workers so the UI thread never blocks on kernel calls (spec principle:
"Fast first, complete second"). This document defines how the main thread and the
geometry worker talk to each other.

## Decisions

- **RPC library: Comlink.** Chosen in spec §5. Verified in M0: `Comlink.wrap<Api>(worker)`
  gives a fully-typed async proxy from a single `interface` describing the worker's
  exposed methods (see `GeometryWorkerApi` in `packages/geometry-worker/src/worker.ts`).
  Alternative considered: hand-rolled `postMessage` + message-id correlation — rejected,
  it's exactly the boilerplate Comlink exists to remove, with no capability we need that
  Comlink lacks.
- **Client owns the Worker lifecycle, not a singleton.** `createGeometryWorkerClient()`
  (in `packages/geometry-worker/src/client.ts`) returns `{ api, terminate() }` rather than
  a bare Comlink proxy. Rejected alternative: a module-level singleton worker — it would
  leak across React StrictMode's mount/unmount/remount cycle and across route changes,
  and multiple documents/tabs may eventually need independent kernel instances (e.g. to
  isolate a crashed regeneration from other open work).
- **Transferables for all mesh buffers.** `Comlink.transfer(mesh, [mesh.positions.buffer,
  mesh.normals.buffer, mesh.faceIds.buffer])` — verified in M0 (see `worker.ts`). Buffers
  move, not copy, across the postMessage boundary, matching spec §4.1's requirement that
  meshes cross as transferable `Float32Array`s.
- **opencascade.js loading: bypass the package's own `initOpenCascade()` entry point.**
  Discovered during M0: modern Vite (v8) treats `.wasm` imports as native
  WebAssembly-ESM-integration modules by default, which is incompatible with
  opencascade.js's classic Emscripten glue code (`import wasmFile from "./x.wasm"`
  expecting a plain URL string). Fix: import the glue factory and the `.wasm` binary
  separately, forcing the binary through Vite's raw-asset path with an explicit `?url`
  suffix (`packages/geometry-worker/src/occLoader.ts`). Any future OCCT build swap
  (spec §4.2's custom minimal build) must preserve this `?url` import pattern.

## Detailed design

### Current (M0) surface

```ts
// packages/geometry-worker/src/worker.ts
export interface GeometryWorkerApi {
  ready(): Promise<void>;
  makeBox(dx: number, dy: number, dz: number): Promise<TessellatedMesh>;
}

// packages/geometry-worker/src/client.ts
export interface GeometryWorkerClient {
  api: Comlink.Remote<GeometryWorkerApi>;
  terminate(): void;
}
export function createGeometryWorkerClient(): GeometryWorkerClient;
```

`TessellatedMesh` (`packages/geometry-worker/src/tessellate.ts`) is a flat, non-indexed
triangle soup: `positions: Float32Array`, `normals: Float32Array` (per-triangle flat
shading, computed from face-orientation-corrected winding), `faceIds: Uint32Array` (one
entry per triangle, index into the shape's face enumeration order), `triangleCount`.

OCCT itself is loaded lazily and cached as a module-level promise inside the worker
(`occLoader.ts`); the first RPC call pays the WASM instantiation cost, subsequent calls
reuse the same instance.

### Required for M1 (open questions below expand on why)

The real regeneration engine (spec §4.3) needs more than M0's single happy-path call:

1. **Message envelope with a generation number.** Every request from main→worker should
   carry a monotonically increasing `generation`; the worker echoes it back, and the
   main thread discards any response whose generation is stale (superseded by a newer
   edit) — spec §4.1. M0's single-shot `makeBox` call doesn't need this yet (there's
   only ever one in-flight call), but `regenerate(doc, fromFeatureId?)` (§4.3) will fire
   repeatedly as the user edits, so this must land before that method exists.
2. **Cancellation.** A long regeneration (or a pathological fillet) must be abandonable
   when superseded. Comlink doesn't give this for free — plan: the worker checks an
   `AbortSignal`-like flag (a `SharedArrayBuffer` int, or a cooperative check between OCCT
   calls) at safe points, OR — simpler for M1 — accept that in-flight OCCT calls run to
   completion but their *results* are discarded by generation-number staleness, and only
   `terminate()` + respawn is used for the truly pathological/hung case (see next point).
3. **Crash/hang detection and restart.** If the worker throws inside OCCT (e.g. a bad
   embind call) or hangs, the client must detect it (a per-call timeout is the simplest
   mechanism) and be able to `terminate()` + `createGeometryWorkerClient()` again,
   re-sending the last-known-good document for a fresh `regenerate()`. Not implemented in
   M0 — there is currently no timeout and no automatic restart.
4. **Error serialization.** OCCT/embind exceptions thrown inside the worker must cross
   the postMessage boundary as structured, serializable errors (message + feature id +
   which OCCT call failed), not opaque `[object Object]` — needed for spec §7.8's
   per-feature error/warning display. Comlink does forward thrown errors as rejected
   promises with a `message`, but embind exceptions' `.message` quality needs checking
   once real feature operations (not just `BRepPrimAPI_MakeBox`) are wired up.
5. **OCCT memory/handle lifetime.** opencascade.js's embind bindings use manual
   reference-counted handles for some types (e.g. `Handle_Poly_Triangulation`) — nothing
   in M0 explicitly disposes them. Need to establish: does opencascade.js's embind layer
   auto-free on JS garbage collection (typical for embind's smart-pointer bindings), or
   do long-lived shapes need explicit `.delete()` calls (typical for embind value-type
   bindings)? This must be answered empirically (instrument memory growth across repeated
   regenerations) before M2's regeneration engine runs in a loop indefinitely.

## Failure modes & recovery (M0 status)

| Failure | M0 behavior | Needed by M1 |
|---|---|---|
| WASM fails to load (network, unsupported browser) | `makeBox()` promise rejects; `Viewport` shows a generic "Failed to load kernel" overlay | Distinguish network failure vs. unsupported-browser (spec §9) with actionable messages |
| OCCT call throws | Rejects; caught in `Viewport`'s `.catch`, logged to console | Structured error surfaced in UI per feature (§7.8), not just console |
| Worker hangs | No detection — caller waits forever | Per-call timeout + `terminate()`/restart |
| Stale response (superseded edit) | Not possible yet (only one call ever fires) | Generation-number discard |

## Test plan

- M0 (done): manual Playwright verification that a real OCCT box renders, tessellates
  correctly (matches known box topology: 6 faces, correct volume via `BRepGProp` spot
  check during API verification), and sustains ~60 fps under simulated orbit drag.
- M1 (to add): automated Playwright test asserting the same, checked into `e2e/`;
  a Vitest-level test for `tessellate.ts`'s pure geometry math (normal computation,
  winding-flip on reversed faces) against a fixture `OpenCascadeInstance` fake, decoupled
  from the real WASM so it runs fast in CI; a fault-injection test that kills the worker
  mid-call and asserts the client detects and recovers.

## Open questions (must be empty before M1 implementation of `regenerate()` starts)

1. Generation-number protocol: exact envelope shape and where staleness is checked
   (client-side only, or does the worker also track "am I still working on the latest
   generation" to skip redundant work)?
2. Cancellation mechanism: cooperative flag vs. terminate-and-restart — pick one default,
   document when the other is used as fallback.
3. Per-call timeout value(s) — likely different for interactive ops (extrude preview)
   vs. batch ops (full document regeneration); needs real numbers from spec §8's budgets.
4. OCCT handle lifetime: does opencascade.js require explicit disposal? (Empirical answer
   needed — see Detailed Design point 5.)
5. Does the sketch worker (PlaneGCS, landing in M3) share this same client/protocol
   shape, or does its much-higher call frequency (every drag frame) need a different,
   lower-overhead channel (e.g. `SharedArrayBuffer` instead of structured-clone postMessage)?
