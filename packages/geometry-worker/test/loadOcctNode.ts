/**
 * Loads the opencascade.js WASM kernel in Node for kernel regression tests
 * (spec §10.2). The package's glue file is ESM-with-embedded-require, which
 * Node refuses to load directly (ERR_AMBIGUOUS_MODULE_SYNTAX); we rewrite its
 * export to CJS in a temp file and inject the wasm binary directly.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCascadeInstance } from "../src/occt-types";

let cached: Promise<OpenCascadeInstance> | null = null;

export function loadOcctForNode(): Promise<OpenCascadeInstance> {
  if (cached) return cached;
  cached = (async () => {
    const require = createRequire(import.meta.url);
    const gluePath = require.resolve("opencascade.js/dist/opencascade.wasm.js");
    const wasmPath = require.resolve("opencascade.js/dist/opencascade.wasm.wasm");

    const glueSrc = fs
      .readFileSync(gluePath, "utf8")
      .replace(/export default opencascade;\s*$/, "module.exports = opencascade;");
    const tmpGlue = path.join(os.tmpdir(), `craftbit-occ-glue-${process.pid}.cjs`);
    fs.writeFileSync(tmpGlue, glueSrc);

    type Factory = new (opts: { wasmBinary: Buffer }) => Promise<OpenCascadeInstance>;

    const factory = require(tmpGlue) as Factory;
    const wasmBinary = fs.readFileSync(wasmPath);
    return await new factory({ wasmBinary });
  })();
  return cached;
}
