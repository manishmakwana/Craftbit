/**
 * Ambient module shims for the untyped `opencascade.js` package and its raw
 * WASM binary asset. This file must have NO top-level import/export: a
 * `declare module "specifier"` block only introduces a brand-new ambient
 * module (vs. requiring one that already has types, to augment) inside a
 * global script file — not inside a file that is itself a module. Inline
 * `import(...)` type queries below are type-only expressions, not module
 * import statements, so they don't turn this file into a module.
 *
 * Referenced via a triple-slash directive from occLoader.ts so it's pulled
 * into every consuming program (e.g. packages/app's tsc run) regardless of
 * that program's own `include` glob, since occLoader.ts is always part of
 * the import graph wherever this package is used.
 */

declare module "opencascade.js/dist/opencascade.wasm.js" {
  interface EmscriptenModuleInit {
    locateFile?(path: string): string;
    wasmBinary?: ArrayBufferView;
  }
  const factory: new (
    opts?: EmscriptenModuleInit,
  ) => Promise<import("./occt-types").OpenCascadeInstance>;
  export default factory;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
