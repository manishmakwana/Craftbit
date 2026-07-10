# ADR-001: Project License

**Status:** Accepted
**Date:** 2026-07-10

## Context

Spec §11 flags the license as a decision that must be settled before external
contributions begin. Craftbit's kernel dependencies are copyleft: OpenCascade
Technology (OCCT) is LGPL-2.1-or-later, and PlaneGCS is LGPL-2.1-or-later. Both are
consumed as compiled WebAssembly artifacts, not statically linked into a single native
binary, which changes the practical obligations compared to a native LGPL dependency.

Two options were considered:

- **LGPL-2.1-or-later** for the whole project: matches the kernel dependencies exactly,
  but is a weak-copyleft license designed around dynamic linking of native libraries; its
  terms are awkward to reason about for a JS/TS/WASM codebase (e.g., "relinking" clauses
  don't map cleanly onto bundlers).
- **MPL-2.0**: file-level (not project-level) copyleft — modifications to MPL-licensed
  *files* must stay open, but the license imposes no constraints on how those files are
  combined with other code, and it explicitly permits combination with GPL/LGPL-licensed
  code without forcing the whole combined work to relicense. It is the standard choice
  for modern open-source web/tooling projects (Rust project components, HashiCorp's
  pre-2023 stack, many Mozilla projects) and is well understood by contributors and by
  AI coding agents.

## Decision

**Craftbit is licensed under MPL-2.0**, applied at the project root (`LICENSE`). Every
source file should carry the standard MPL-2.0 file header (Exhibit A in `LICENSE`).

- `packages/core` has no runtime dependency on OCCT/PlaneGCS and could in principle be
  MIT; it stays MPL-2.0 for consistency and to avoid a two-license repository.
- `packages/geometry-worker` and `packages/sketch-worker` consume OCCT/PlaneGCS as
  separate WASM artifacts (not statically linked into MPL-licensed source), which is
  compatible with MPL-2.0's combination terms.
- Third-party WASM builds (OCCT, PlaneGCS) retain their own LGPL-2.1-or-later license;
  Craftbit does not relicense them. Attribution is surfaced in-app per spec §7.16
  ("version + licenses page").

## Consequences

- Forks/derivatives must keep modified MPL-licensed files open, but may combine Craftbit
  with proprietary code in a larger work (e.g., a company shipping a customized internal
  build) without relicensing the whole thing — intentional, to encourage adoption.
- A `docs/licenses/THIRD_PARTY.md` must be maintained listing every dependency's license
  as the dependency list grows (created in Milestone 1 alongside the licenses page).
