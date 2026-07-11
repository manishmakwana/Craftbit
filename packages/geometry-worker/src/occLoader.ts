// A type-only side-effect import (`import "./occt"`) would make bundlers try
// to resolve occt.d.ts as a runtime module, which fails (it has no JS emit).
// A triple-slash reference is compiler-only and never reaches the bundler.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./occt.d.ts" />
import initFactory from "opencascade.js/dist/opencascade.wasm.js";
// The `?url` suffix forces Vite to treat this as a raw asset URL. Without it,
// modern Vite's native WebAssembly-ESM-integration handling tries to parse
// this file as a wasm *module* (auto-resolving its low-level wasm imports),
// which is incompatible with opencascade.js's classic Emscripten glue code —
// hence bypassing the package's own `initOpenCascade()` entry point.
import wasmUrl from "opencascade.js/dist/opencascade.wasm.wasm?url";
import type { OpenCascadeInstance } from "./occt-types";

/**
 * M0 uses opencascade.js's prebuilt "full" WASM (~65 MB uncompressed, OCCT 7.4).
 * Spec §4.2 calls for a custom minimal OCCT 7.7+ build (≤25 MB gzipped) via the
 * `kernel/` Docker pipeline — tracked as follow-up work (design gate D1), not
 * done here. This loader is the single point that will swap to that build.
 */

let occPromise: Promise<OpenCascadeInstance> | null = null;

export function loadOcct(): Promise<OpenCascadeInstance> {
  if (!occPromise) {
    occPromise = new initFactory({
      locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
    });
  }
  return occPromise!;
}
