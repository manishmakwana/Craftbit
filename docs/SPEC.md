# Craftbit — Product & Engineering Specification (v1)

**A free, open-source, web-based parametric CAD application for hobbyist makers.**

- No download, no installation, no account. Runs entirely in the browser on any device.
- Make 3D models parametrically, assemble them, and export fabrication-ready files for
  3D printing, laser cutting, and CNC machining.
- Spiritual successor niche: "Fusion 360 / FreeCAD, but open, free forever, and in a browser tab."

> **How to read this document.** This spec is written to be executed by AI coding agents.
> Every feature section includes: purpose, detailed behavior, UI description, data model
> impact, and acceptance criteria. Concrete libraries and versions are named deliberately —
> do not substitute alternatives without updating this spec first. Sections marked
> **[DECISION]** are architectural calls that were made to unblock v1; they can be
> overridden by the project owner, but each has cascading effects, so change them only
> at the spec level, never ad-hoc in code.

---

## Table of Contents

1. [Vision, Scope, and Non-Goals](#1-vision-scope-and-non-goals)
2. [Target Users and Core Workflows](#2-target-users-and-core-workflows)
3. [Foundational Decisions](#3-foundational-decisions)
4. [System Architecture](#4-system-architecture)
5. [Technology Stack](#5-technology-stack)
6. [Document & Data Model](#6-document--data-model)
7. [Feature Specifications](#7-feature-specifications)
   - 7.1 [Application Shell & Layout](#71-application-shell--layout)
   - 7.2 [Project Management (Local-First Storage)](#72-project-management-local-first-storage)
   - 7.3 [Units & Preferences](#73-units--preferences)
   - 7.4 [3D Viewport](#74-3d-viewport)
   - 7.5 [Selection System](#75-selection-system)
   - 7.6 [Sketcher (2D Constrained Sketching)](#76-sketcher-2d-constrained-sketching)
   - 7.7 [Part Modeling Features](#77-part-modeling-features)
   - 7.8 [Feature Tree & Parametric History](#78-feature-tree--parametric-history)
   - 7.9 [Parameters & Expressions](#79-parameters--expressions)
   - 7.10 [Assembly](#710-assembly)
   - 7.11 [Measurement & Inspection](#711-measurement--inspection)
   - 7.12 [Import](#712-import)
   - 7.13 [Export for Fabrication](#713-export-for-fabrication)
   - 7.14 [Undo/Redo](#714-undoredo)
   - 7.15 [Keyboard, Mouse & Touch Input](#715-keyboard-mouse--touch-input)
   - 7.16 [Onboarding & Help](#716-onboarding--help)
8. [Performance Requirements](#8-performance-requirements)
9. [Browser & Device Support](#9-browser--device-support)
10. [Testing Strategy](#10-testing-strategy)
11. [Repository Structure](#11-repository-structure)
12. [Implementation Milestones](#12-implementation-milestones)
13. [Post-v1 Roadmap (Explicitly Deferred)](#13-post-v1-roadmap-explicitly-deferred)
14. [Glossary](#14-glossary)

---

## 1. Vision, Scope, and Non-Goals

### 1.1 Vision

Craftbit lets a hobbyist open a browser tab, sketch a 2D profile, extrude it into a solid,
add fillets and holes, assemble several parts, and download files that go straight to
their 3D printer slicer, laser cutter software, or CNC CAM program — with zero installs
and zero accounts.

### 1.2 In scope for v1

| Capability | v1 delivery |
|---|---|
| Parametric 2D sketching | Full constraint-based sketcher (geometric + dimensional constraints) |
| Solid modeling | Extrude, revolve, fillet, chamfer, shell, hole, boolean, patterns, mirror, datum planes |
| Parametric history | Editable, reorderable feature tree with rollback |
| Named parameters | Global parameter table with expressions (`width = 2 * thickness + 5`) |
| Assembly | Multi-part documents, rigid mates (fastened/planar/axial), exploded positioning via joints |
| 3D printing output | Binary STL + 3MF export with manifold validation & auto-repair |
| Laser cutting output | Face-to-SVG/DXF flattening with optional kerf compensation |
| CNC output | STEP (AP214) and DXF export for use in external CAM tools |
| Import | STEP, STL, DXF (as sketch), SVG (as sketch) |
| Storage | Local-first: autosave to browser storage; save/open `.craftbit` project files |
| Offline | Full functionality offline after first load (PWA) |

### 1.3 Non-goals for v1 (hard exclusions — do not implement)

These are deliberately excluded to keep v1 shippable. See [Section 13](#13-post-v1-roadmap-explicitly-deferred).

- **In-app slicing or G-code generation** (users have Cura/PrusaSlicer/Kiri:Moto/LightBurn).
- **Cloud accounts, sync, or any server-side persistence.** v1 has no backend.
- **Real-time multiplayer collaboration.**
- **2D technical drawings / drafting sheets** (dimenssioned blueprint output).
- **Surface/freeform modeling** (lofts with guide curves, sweeps along 3D paths, T-splines).
  Exception: simple linear loft between two parallel sketches MAY be added if schedule allows; it is a stretch feature.
- **Simulation** (FEA, motion, kinematics beyond static mate solving).
- **Rendering/appearance** beyond flat per-body colors.
- **Plugins/scripting API** (design for it, don't ship it — see §4.5).
- **Version control / branching of designs.**
- **Sheet-metal, mesh sculpting, generative design, PCB.**

### 1.4 Product principles

1. **Fabrication-correct over feature-rich.** An exported STL must print; an exported SVG
   must cut at the right size. Export correctness bugs are always P0.
2. **Never lose work.** Autosave is continuous; the app must survive tab crash, refresh,
   and browser restart with ≤5 seconds of lost work.
3. **Fast first, complete second.** Interactive operations (orbit, sketch drag) must never
   block on the kernel. The kernel lives in a worker; the UI thread stays at 60 fps.
4. **Familiar to Fusion 360 refugees.** Default mouse bindings, terminology ("Sketch",
   "Extrude", "Joint", "Timeline") and workflow order match Fusion 360 conventions where
   reasonable, so tutorials and muscle memory transfer.
5. **Every document is a plain file.** The `.craftbit` format is documented JSON-in-zip;
   users own their data completely.

---

## 2. Target Users and Core Workflows

### 2.1 Personas

- **P1 — The 3D-printing hobbyist.** Owns an Ender/Prusa/Bambu. Designs brackets,
  enclosures, replacement parts. Needs: sketch → extrude → fillet → STL. Success metric:
  from blank document to sliceable STL of a simple bracket in **under 10 minutes**.
- **P2 — The laser cutter.** Makes boxes, signs, mechanical toys from plywood/acrylic.
  Needs: parametric sketches, finger joints (via parameters), flat-face export to SVG/DXF
  at exact 1:1 scale, kerf offset. Success metric: parametric box redesign by editing one
  parameter, re-export in **under 1 minute**.
- **P3 — The garage CNC user.** Router or desktop mill. Needs precise geometry, STEP/DXF
  export into their CAM tool (Kiri:Moto, ESTLcam, CamBam). Cares about exact dimensions
  and clean arcs (not polyline approximations) in DXF.
- **P4 — The educator/student.** Chromebook in a classroom. Needs: zero install, works on
  low-end hardware, forgiving UX. Drives the performance floor (§8) and touch support (§7.15).

### 2.2 Golden-path workflows (used as end-to-end test scripts)

**GP-1: Printed bracket.** New document → sketch rectangle on XY plane → dimension 60×40 →
extrude 5 mm → sketch two circles on top face → extrude-cut through → fillet 4 edges r3 →
export STL → file opens manifold in PrusaSlicer at correct size.

**GP-2: Laser box panel.** New document → parameter table: `thickness=3`, `width=120` →
sketch panel outline with finger joints driven by parameters → extrude `thickness` →
select face → Export face as SVG with 0.15 mm kerf → SVG measures exactly (width + 2·kerf-adjustment) in Inkscape.

**GP-3: Two-part assembly.** Create Part A (base with hole) and Part B (pin) in one
document → insert both into assembly → fastened joint pin-into-hole via face selection →
verify pin is coaxial → export combined STL and per-part STLs.

**GP-4: Edit history.** Open GP-1's bracket → double-click the first sketch in the
timeline → change 60→80 → confirm → all downstream features (extrude, holes, fillets)
regenerate correctly.

**GP-5: Import & modify.** Import a STEP file of a flange → measure a bore diameter →
sketch on its top face → extrude-cut a new slot → export STEP.

Each GP workflow must have an automated Playwright test before v1 ships (§10).

---

## 3. Foundational Decisions

### 3.1 [DECISION] Geometry kernel: OpenCascade (via WebAssembly)

**Choice:** OpenCascade Technology (OCCT) compiled to WebAssembly via **opencascade.js**
(custom build, not the full ~90 MB default build — see §4.2).

**Why:** OCCT is the only mature open-source B-rep kernel. It provides: parametric solids,
fillets/chamfers/shells that actually work, NURBS surfaces, STEP/IGES read+write, precise
edge geometry (real arcs/splines, not tessellations) needed for laser/CNC DXF output.
FreeCAD is built on it, so its behavior is battle-tested. Mesh/CSG kernels (Manifold,
three-csg) cannot deliver fillets, shells, or STEP, which P2/P3 require.

**Consequences:** ~15–25 MB (gzipped) WASM payload → mitigated by aggressive caching,
streaming compile, and a loading screen with progress (§7.16). All kernel calls are
asynchronous through a worker (§4.2). A custom OCCT build pipeline is part of the repo.

### 3.2 [DECISION] Sketch constraint solver: PlaneGCS (via WebAssembly)

**Choice:** FreeCAD's **PlaneGCS** solver compiled to WASM (the `planegcs` npm packaging
of it is the starting point; vendor and maintain our own build if the package is stale).

**Why:** Writing a robust 2D geometric constraint solver from scratch is a multi-year
research project. PlaneGCS is proven (every FreeCAD sketch uses it), LGPL, handles
under/over-constrained diagnostics, and is small (<1 MB WASM).

### 3.3 [DECISION] Fabrication depth: validated exports, no in-app CAM

v1 produces **files**, not toolpaths. The competitive insight: hobbyists universally
already run a slicer or CAM tool and trust it; what they lack is a good free *modeler*.
v1 wins by making exports **provably correct** (manifold STLs, exact-scale SVGs, real-arc
DXFs) rather than shipping a mediocre slicer. G-code generation is v2 (§13).

### 3.4 [DECISION] Local-first storage, zero backend

All persistence is client-side (OPFS + IndexedDB) plus user-initiated file download/open.
The app deploys as static files (any CDN / GitHub Pages). No auth, no database, no
server costs, no privacy policy complexity. "Any device" is satisfied because the app
loads anywhere and projects travel as `.craftbit` files. Cloud sync is v2.

### 3.5 [DECISION] Stack: React 18 + TypeScript (strict) + Three.js + Vite

Chosen for maximum ecosystem maturity and — relevantly for this project — maximum
familiarity to AI coding agents, minimizing implementation defects. State via **Zustand**
(simple, no boilerplate, works outside React for worker callbacks). No Redux, no MobX.

### 3.6 [DECISION] Single document type containing parts AND assemblies

Like Fusion 360 (and unlike FreeCAD/SolidWorks), one `.craftbit` document contains
multiple bodies, components, and joints. This removes cross-file reference management —
the single largest complexity trap for a v1 — while still supporting GP-3.

---

## 4. System Architecture

### 4.1 Process/thread topology

```
┌────────────────────────── Browser Tab ──────────────────────────┐
│                                                                 │
│  Main thread                        Workers                     │
│  ┌───────────────────┐   messages   ┌────────────────────────┐  │
│  │ React UI          │◄────────────►│ geometry.worker        │  │
│  │ Zustand stores    │  (Comlink)   │  - opencascade.js WASM │  │
│  │ Three.js viewport │              │  - feature regeneration│  │
│  │ Input controllers │              │  - tessellation        │  │
│  └───────────────────┘              │  - import/export codecs│  │
│           ▲                         └────────────────────────┘  │
│           │                         ┌────────────────────────┐  │
│           │                         │ sketch.worker          │  │
│           └────────────────────────►│  - PlaneGCS WASM       │  │
│                                     │  - constraint solving  │  │
│  Persistence: OPFS (project blobs)  └────────────────────────┘  │
│               IndexedDB (metadata, autosave journal)            │
│  Service Worker: precache app shell + WASM (offline / PWA)      │
└─────────────────────────────────────────────────────────────────┘
```

- **Comlink** wraps workers to give typed async RPC. All worker APIs return Promises;
  the UI never blocks on geometry.
- The **geometry worker** owns the OCCT document state (the B-rep shapes). The main
  thread holds only: the parametric document (JSON), tessellated meshes (transferable
  `Float32Array`s), and topology reference maps for picking.
- The **sketch worker** is separate so a pathological constraint solve can be
  terminated/restarted without tearing down the (expensive to boot) OCCT worker.
- Every request into a worker carries a monotonically increasing `generation` number;
  stale responses (superseded by newer edits) are discarded by the main thread.

### 4.2 OCCT WASM build

- Maintain a `kernel/` directory with a Docker-based build (opencascade.js custom build
  YAML) that compiles **only** the required OCCT modules: `TKernel, TKMath, TKG2d, TKG3d,
  TKGeomBase, TKBRep, TKGeomAlgo, TKTopAlgo, TKPrim, TKBO, TKBool, TKFillet, TKOffset,
  TKMesh, TKShHealing, TKDESTEP, TKDEIGES, TKXSBase` plus their dependencies.
- Target: ≤ 25 MB gzipped WASM. Loaded with `WebAssembly.instantiateStreaming`.
- The built artifacts are committed to the repo (or a release bucket) so contributors and
  CI do not need the Docker toolchain for app development.
- Version-pin OCCT; kernel upgrades are their own PRs with the full regression suite run.

### 4.3 Regeneration engine (the parametric core)

The document is a **directed acyclic graph of features** (§6). The geometry worker
implements:

- `regenerate(doc, fromFeatureId?)`: executes features in topological order, producing
  OCCT shapes. Skips clean (unchanged, cached) features. Emits per-feature status:
  `ok | warning | error` with human-readable messages (e.g., "Fillet failed: radius 5
  exceeds adjacent face size").
- **Topological naming:** every face/edge/vertex produced by a feature gets a stable
  string ID derived from `(featureId, operation-local index, orientation hints)`, using
  OCCT's history API (`BRepBuilderAPI_MakeShape::Generated/Modified`). Downstream
  references (e.g., "sketch on this face", "fillet this edge") store these IDs, not raw
  geometry pointers. When regeneration cannot resolve an ID, the referencing feature
  enters `error` state with a "reattach" affordance in the UI (§7.8) — it must never
  silently pick a different face. This is the hardest problem in parametric CAD;
  implement it early (Milestone 2) and test it exhaustively.
- **Tessellation:** after regeneration, each body is meshed (`BRepMesh_IncrementalMesh`,
  deflection scaled to body size; two LODs: display + export-quality) and returned as
  transferable buffers: positions, normals, triangle-to-face-ID map, and edge polylines
  with edge-ID map (for edge picking and display).

### 4.4 State management (main thread)

Zustand stores, cleanly separated:

- `documentStore` — the parametric document (source of truth, serializable, §6). All
  mutations go through **command objects** (name, params, `do/undo` data) to power
  undo/redo (§7.14) and future collaboration.
- `geometryStore` — derived render data from the worker (meshes, maps, feature statuses).
  Never persisted.
- `uiStore` — selection, active tool, active sketch, camera bookmark, panel visibility,
  dialog states. Session-persisted (survives refresh) but not part of the document.
- `settingsStore` — user preferences (§7.3), persisted to IndexedDB.

### 4.5 Extensibility posture (design-only in v1)

Do not ship a plugin API, but: all modeling operations must be dispatched through a
single typed `executeCommand(command)` entry point, and the feature registry
(`featureType → {paramsSchema, executeInWorker, dialogComponent, icon}`) must be a data
structure, not a switch statement. This keeps v2 scripting/plugins tractable.

---

## 5. Technology Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, `strict: true` | No `any` in `src/core/**` (lint-enforced) |
| UI framework | React 18 | Function components + hooks only |
| Build | Vite | Code-splitting: app shell loads before WASM |
| 3D rendering | Three.js (pinned minor version) | Raw Three.js, **not** react-three-fiber, for the main viewport (deterministic control of render loop, picking, and buffer updates). R3F may be used for trivial preview widgets only. |
| State | Zustand | See §4.4 |
| Geometry kernel | opencascade.js custom build (OCCT 7.7+) | §4.2 |
| Constraint solver | PlaneGCS via WASM | §3.2 |
| Worker RPC | Comlink | Transferables for all mesh buffers |
| Mesh validation/repair | Manifold (WASM) | STL/3MF export checks §7.13 |
| 3MF/zip | fflate | Also used for `.craftbit` container |
| Persistence | OPFS + IndexedDB (via `idb`) | §7.2 |
| PWA | Workbox (vite-plugin-pwa) | Precache shell + WASM |
| Styling | CSS Modules + design tokens (CSS custom properties) | Dark theme default; light theme required |
| Icons | Lucide + custom CAD glyph set (SVG sprite) | |
| Expression parsing | Self-written Pratt parser (~300 LOC) | §7.9; no `eval`, no heavy math lib |
| Unit tests | Vitest | |
| E2E tests | Playwright | Runs the real WASM kernel |
| Lint/format | ESLint + Prettier | CI-enforced |
| CI | GitHub Actions | typecheck, lint, unit, E2E, bundle-size budget |
| Hosting | Static (GitHub Pages / any CDN) | No server component |

Version pinning: exact versions in `package.json` (no `^`) for Three.js, opencascade.js,
Manifold, PlaneGCS. Renovate/dependabot PRs must pass the full E2E suite.

---

## 6. Document & Data Model

### 6.1 File format: `.craftbit`

A ZIP container (fflate):

```
project.craftbit
├── manifest.json      # {formatVersion: 1, appVersion, created, modified, name}
├── document.json      # the full parametric document (below)
├── thumbnails/        # PNG viewport snapshot for the project browser
└── imports/           # original imported files (STEP/STL/DXF/SVG) referenced by import features
```

Rules:
- `formatVersion` is an integer. Loaders must accept any `formatVersion ≤ current` via
  explicit migration functions (`migrations/v1_to_v2.ts`, …). Never break old files.
- `document.json` is deterministic (sorted keys, fixed number formatting) so files diff
  cleanly in git.
- All numbers are stored in **millimeters** and **radians**, regardless of display units.

### 6.2 Document schema (TypeScript, abridged but normative)

```ts
interface CraftbitDocument {
  formatVersion: 1;
  id: string;                       // uuid
  name: string;
  parameters: Parameter[];          // §7.9
  features: Feature[];              // ordered list = the timeline
  components: Component[];          // assembly instances §7.10
  joints: Joint[];                  // §7.10
  displayStates: Record<string, BodyDisplay>; // color, visibility per body
}

interface Parameter {
  id: string;
  name: string;                     // [A-Za-z_][A-Za-z0-9_]* — validated
  expression: string;               // "2 * thickness + 5" or "42"
  value: number;                    // cached evaluation, mm or rad or scalar
  unit: 'mm' | 'deg' | 'scalar';
  comment?: string;
}

type Feature =
  | SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature
  | ChamferFeature | ShellFeature | HoleFeature | BooleanFeature
  | MirrorFeature | LinearPatternFeature | CircularPatternFeature
  | DatumPlaneFeature | ImportFeature;

interface FeatureBase {
  id: string;
  type: string;
  name: string;                     // user-editable, default "Extrude1"…
  suppressed: boolean;
  status?: { level: 'ok'|'warning'|'error'; message?: string }; // runtime, not persisted
}

// Geometry references use topological names, never indices into live geometry:
type TopoRef = {
  kind: 'face' | 'edge' | 'vertex' | 'body' | 'sketchRegion' | 'sketchCurve' | 'datum' | 'originPlane';
  ref: string;                      // stable topological name (§4.3) or entity id
};

interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  profiles: TopoRef[];              // sketch regions
  direction: 'normal' | 'reversed' | 'symmetric';
  extent:
    | { kind: 'blind'; distance: Expr }        // Expr = string expression, evaluated via §7.9
    | { kind: 'throughAll' }
    | { kind: 'toFace'; face: TopoRef };
  operation: 'newBody' | 'join' | 'cut' | 'intersect';
  targetBodies?: TopoRef[];         // for cut/join/intersect; empty = auto (all intersecting)
}
```

Every feature type gets an analogous fully-typed interface plus a **Zod schema** used for
(a) runtime validation on file load, (b) generating the feature dialog forms' validation,
(c) fuzz-testing the regeneration engine.

### 6.3 Sketch sub-model

```ts
interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: TopoRef;                   // originPlane XY/XZ/YZ, datum plane, or planar face
  entities: SketchEntity[];         // points, lines, arcs, circles, ellipses, splines
  constraints: SketchConstraint[];  // §7.6
}

type SketchEntity =
  | { id: string; kind: 'point'; x: number; y: number; construction?: boolean }
  | { id: string; kind: 'line'; p1: string; p2: string; construction?: boolean }        // point ids
  | { id: string; kind: 'circle'; center: string; radius: number; construction?: boolean }
  | { id: string; kind: 'arc'; center: string; start: string; end: string; ccw: boolean; construction?: boolean }
  | { id: string; kind: 'spline'; controlPoints: string[]; degree: 3; construction?: boolean };

type SketchConstraint =
  | { id: string; kind: 'coincident'|'horizontal'|'vertical'|'parallel'|'perpendicular'
        |'tangent'|'equal'|'concentric'|'midpoint'|'symmetric'|'fix'|'pointOnCurve';
      refs: string[] }              // entity/point ids
  | { id: string; kind: 'distance'|'horizontalDistance'|'verticalDistance'|'angle'
        |'radius'|'diameter';
      refs: string[]; value: Expr; driven?: boolean };
```

### 6.4 Identity rules

- All ids are UUIDv4 generated at creation and never reused.
- Deleting a feature never renumbers others.
- Topological names (§4.3) are strings namespaced by feature id:
  `"f_3fa2…/face/top/0"` — opaque to the UI, resolved only by the geometry worker.

---

## 7. Feature Specifications

Each subsection: **Purpose → Behavior → UI → Acceptance criteria (AC)**.
ACs are written to be directly convertible into automated tests.

---

### 7.1 Application Shell & Layout

**Purpose:** A single-page layout familiar to Fusion 360 users, responsive from a
1024×640 Chromebook up to 4K desktop.

**Layout (desktop):**

```
┌──────────────────────────────────────────────────────────────┐
│ Top bar: logo | project name (editable) | save-state dot |   │
│          undo/redo | Export ▾ | Help ▾ | settings gear       │
├─────────┬────────────────────────────────────────────────────┤
│ Left    │                                                    │
│ panel:  │                3D Viewport                         │
│ Browser │        (with ViewCube top-right,                   │
│ (bodies,│         origin triad bottom-left)                  │
│ comps,  │                                                    │
│ sketches│                                                    │
│ params) │                                                    │
├─────────┴────────────────────────────────────────────────────┤
│ Timeline: [S][E][F][S][E]… feature chips + rollback marker   │
└──────────────────────────────────────────────────────────────┘
Toolbar: contextual, docked under top bar (Solid tab / Sketch tab switch automatically)
```

**Behavior:**
- Left panel collapsible; timeline collapsible; viewport always visible.
- A modal **feature dialog** (right-docked card, not screen-centered) opens when creating
  or editing a feature; the viewport stays interactive for pick-selection while it is open.
- Below 768 px width (tablet/phone): left panel and timeline become slide-over drawers;
  toolbar becomes a bottom action bar. Full modeling on a phone is NOT a v1 goal, but
  viewing, measuring, and exporting must work on a phone (P4).

**AC:**
1. App shell (HTML/JS, excluding WASM) interactive in < 2 s on a mid-range laptop, cold cache.
2. WASM kernel loads in background with a progress indicator; sketch tools usable the
   moment the solver worker is ready even if OCCT is still loading.
3. All panels keyboard-reachable; visible focus states; top-bar controls have ARIA labels.
4. Window resize never breaks layout from 320 px to 4K (viewport-only mode below 768 px).

---

### 7.2 Project Management (Local-First Storage)

**Purpose:** Zero-friction persistence with no account, satisfying "never lose work".

**Behavior:**
- **Home screen** (route `/`): grid of project cards (thumbnail, name, modified date)
  read from IndexedDB metadata + OPFS blobs. Actions: New, Open file…, Import
  (STEP/STL/DXF/SVG → new project), Duplicate, Rename, Delete (with confirm), Download.
- **Autosave:** every document mutation is journaled to IndexedDB immediately
  (command log), and a full snapshot is written to OPFS at most every 5 s (debounced)
  and on `visibilitychange`/`pagehide`. On reopen after a crash, replay journal on top of
  the last snapshot.
- **Save As / Download:** serializes to `.craftbit` and triggers a file download. Where
  the File System Access API is available (Chromium), offer "Save to disk" with a real
  file handle and subsequent silent saves; otherwise fall back to download.
- **Open:** file picker or drag-and-drop of `.craftbit` anywhere onto the home screen or
  an open document (with confirm if unsaved-to-file changes exist — note: work is still
  autosaved locally regardless).
- **Storage pressure:** call `navigator.storage.persist()`; show total usage in settings;
  warn when quota is >80% used.

**AC:**
1. Kill the tab mid-edit → reopen → document state is within one command of where it was.
2. Projects survive browser restart.
3. `.craftbit` round-trip: download → delete local project → open file → byte-equivalent
   `document.json` (modulo `modified` timestamp).
4. Two tabs opening the same project: second tab gets read-only mode with a banner
   ("Open in another tab") via `navigator.locks`.
5. Works in a private/incognito window (with a warning that storage is ephemeral).

---

### 7.3 Units & Preferences

**Behavior:**
- Document unit setting: mm (default), cm, m, inch. Affects **display and input parsing
  only**; storage is always mm (§6.1).
- Dimension input fields accept unit-suffixed values anywhere: `25`, `2.5cm`, `1in`,
  `3/8in` (fractional inches — hobbyist wood/CNC users need this), and full expressions (§7.9).
- Preferences (settingsStore): theme (dark/light/system), units default for new docs,
  mouse scheme (Fusion / SolidWorks / Blender presets — remaps orbit/pan/zoom buttons),
  grid on/off, autosave interval display.

**AC:**
1. Entering `1in` in an extrude dialog with mm display yields 25.4 mm stored.
2. `3/8in` parses to 9.525 mm.
3. Switching document units re-renders all dimensions without changing geometry.

---

### 7.4 3D Viewport

**Purpose:** The primary workspace; must feel as smooth as Fusion 360's.

**Behavior:**
- **Rendering:** Three.js WebGL2 renderer. MSAA (or FXAA fallback). Solid shaded +
  visible edges display mode (default), plus wireframe and shaded-no-edges modes.
  Matte physically-plausible material, two-tone environment lighting, soft ground shadow.
  Per-body colors settable from browser panel context menu (8 preset swatches + custom).
- **Camera:** perspective default; orthographic toggle; ViewCube (faces/edges/corners
  clickable, drag to orbit, home button); named standard views (Front/Top/Right/Iso)
  with keyboard shortcuts; `F` = fit-all, `Shift+F` = fit-selection. Orbit about cursor
  target (raycast hit point), Fusion-style.
- **Navigation defaults (Fusion scheme):** MMB-drag = pan is NOT Fusion; Fusion is:
  MMB = pan, Shift+MMB = orbit, wheel = zoom-to-cursor. Implement exactly this as the
  "Fusion" preset; "Blender" preset: MMB = orbit, Shift+MMB = pan.
- **Origin display:** origin triad + three origin planes (XY/XZ/YZ) shown as subtle
  translucent quads when relevant (plane-selection contexts), hidden otherwise but
  always present in the browser panel.
- **Section view:** single clipping plane draggable along a chosen axis/plane, with
  capped (filled) cross-sections visually approximated by stencil technique. (No
  section-based measurement in v1.)
- **Grid & scale bar:** adaptive grid on the active workplane in sketch mode; a dynamic
  scale indicator ("10 mm ──") bottom-center of the viewport at all times.

**AC:**
1. 60 fps orbit/pan/zoom with 50 bodies / 500k total triangles on a 2020 mid-range laptop
   (see §8 for the perf harness definition).
2. Zoom-to-cursor keeps the point under the cursor stationary within 2 px.
3. ViewCube "Front" animates to front view in ≤ 300 ms with easing.
4. Section plane drag updates at ≥ 30 fps on the reference machine.
5. No WebGL context loss on 30-minute idle; on context loss, the scene restores automatically.

---

### 7.5 Selection System

**Purpose:** Precise, predictable picking of faces/edges/vertices/bodies/components —
the substrate every modeling feature builds on.

**Behavior:**
- **Hover highlight** (pre-selection) in accent color; **selection** in a stronger color;
  multi-select with Ctrl/Cmd-click; box-select in sketch mode only (v1).
- **Selection filter** dropdown in toolbar: Auto (context-driven), Body, Face, Edge,
  Vertex, Component. In "Auto", priority = smallest sensible entity (vertex > edge > face).
- **Deep-select:** repeated clicks at the same position cycle through entities under the
  cursor (like Fusion's "select other"); after 800 ms hover, show a small flyout listing
  candidates.
- **Picking implementation:** GPU ID-buffer picking (render entity IDs to an offscreen
  target) — not raycasting against BVHs — so picking cost is O(1) with scene size and
  exactly matches what is rendered. Edge/vertex picking uses widened pick-geometry
  (≥ 6 px screen-space tolerance; 12 px on touch).
- Selections are stored as `TopoRef[]` in `uiStore` and validated after every
  regeneration (stale refs are dropped with a subtle toast).

**AC:**
1. Clicking a 1-px-wide edge at 6 px distance selects it (12 px on touch).
2. Deep-select cycles face → body → underlying face deterministically.
3. Feature dialogs show live counts of picked entities ("2 profiles selected") and
   allow removing individual picks from a chip list.

---

### 7.6 Sketcher (2D Constrained Sketching)

**Purpose:** The heart of parametric CAD. A constraint-based 2D editor on any plane or
planar face. This is the largest single feature; budget accordingly.

**Entering/leaving:**
- "Create Sketch" → pick origin plane, datum plane, or planar face → camera animates to
  look normal at the plane → sketch mode activates (dedicated toolbar, grid, other bodies
  dimmed to 30% and optionally hidden). "Finish Sketch" or Esc (with confirm if empty)
  exits and adds/updates the timeline chip. Faces of existing bodies can be **projected**
  into the sketch (see below) — model edges themselves are not directly usable as sketch
  geometry in v1.

**Drawing tools (v1 complete set):**
Line (with chained polyline + auto arc-tangent flick like Fusion), Rectangle
(2-point, center), Circle (center-radius), Arc (3-point, center-start-end), Ellipse
(center + axes), Polygon (n-sided, inscribed), Slot (straight, 2-point + width), Spline
(cubic, through control points), Point, Text-on-sketch **excluded** (v2), Fillet
(sketch corner), Trim, Extend, Offset (single closed loop, uniform distance), Mirror,
Project (project edges/faces of existing 3D bodies onto the sketch plane as
construction or normal geometry — required for GP-5 style workflows).

**Constraints:**
- Geometric: coincident, horizontal, vertical, parallel, perpendicular, tangent, equal,
  concentric, midpoint, symmetric (about a line), fix/lock, point-on-curve.
- Dimensional: distance (aligned/horizontal/vertical inferred from placement drag),
  angle, radius, diameter. Dimension values are expressions (§7.9). "Driven" (reference)
  dimensions supported (shown in parentheses, don't constrain).
- **Automatic constraint inference while drawing:** snapping with on-cursor glyphs for
  horizontal/vertical/coincident/tangent/midpoint/perpendicular as the user draws;
  inferred constraints are created on commit. Hold Ctrl to suppress inference.
- **Solver integration:** every entity mutation (drag, dimension edit, constraint
  add/remove) → send delta to sketch worker → PlaneGCS solve → updated positions
  rendered. Drag solving must be interactive (see AC). DOF display: status bar shows
  "n degrees of freedom remaining"; fully-constrained sketch geometry turns a distinct
  color (Fusion-black/our-theme equivalent). Over-constrained/conflicting: the offending
  constraints are highlighted red with a one-click "remove conflicting" resolution dialog
  listing the conflict set from the solver diagnostics.
- **Under the hood:** the sketch in `documentStore` stores both constraint set and last
  solved positions; positions are the fallback when the solver fails, so files always
  render.

**Regions:** on every solve, compute closed regions (planar face detection from the
curve arrangement) in the sketch worker; regions are hoverable/selectable entities used
by Extrude/Revolve profiles. Open profiles are usable for nothing in v1 (no thin-extrude).

**UI details:**
- Dimensions render as SVG/HTML overlay (not in WebGL) for crisp text; double-click to
  edit in-place with an expression input.
- Constraint glyphs are small icons near entities; click to select, Delete to remove;
  hover shows tooltip naming the constraint and its entities.
- A "Sketch palette" side card lists: tool options (construction toggle), constraint
  list, "show constraints" toggle, "show dimensions" toggle.

**AC:**
1. Drag-solve latency: for a sketch with 150 entities + 200 constraints, dragging a point
   updates at ≥ 30 fps on the reference machine (solve in sketch worker ≤ 20 ms median).
2. Drawing a rectangle auto-creates: 4 coincident, 2 horizontal, 2 vertical constraints;
   adding 2 dimensions fully constrains it (0 DOF shown).
3. Over-constraining (adding a redundant dimension) triggers the conflict dialog naming
   exactly the redundant constraint; sketch remains usable throughout.
4. Regions: two overlapping circles yield 3 selectable regions (lens + 2 crescents).
5. Trim on a crossing line splits correctly and preserves/repairs constraints where
   geometrically valid.
6. A sketch with a failed solve still renders last-known positions and can be edited.
7. Projected edges update when the source body changes (they carry TopoRefs) and go into
   error state (magenta) when the source disappears.

---

### 7.7 Part Modeling Features

Every feature follows the same lifecycle: toolbar button → dialog opens → user picks
geometry + sets params (live preview after each valid input, rendered as translucent
"ghost" via a preview regeneration in the worker with a 150 ms debounce) → OK commits a
command → timeline chip appears. Cancel restores pre-dialog state. Edit = double-click
chip → same dialog pre-filled.

Common dialog conventions: numeric fields accept expressions; direction flip buttons;
operation selector (New body / Join / Cut / Intersect) with **auto-defaulting**: if the
extrude profile lies on an existing body face and points into the body → default Cut;
outward → Join; disjoint → New body.

**7.7.1 Extrude** — profiles: 1+ sketch regions (multi-region OK). Extents: blind
distance (expression, may be negative), symmetric, through-all, to-face. Operations as
above. Draft angle: **excluded v1**.

**7.7.2 Revolve** — profile region(s) + axis (sketch line, construction line, or origin
axis). Angle: expression up to 360° (default full). Same operations.

**7.7.3 Fillet** — edge set (with tangent-chain auto-propagation toggle, default on),
single radius per feature (variable radius excluded v1). Preview. On kernel failure,
dialog shows the failing edges highlighted and OCCT's message mapped to a human
explanation table (maintain `filletErrorMap.ts`).

**7.7.4 Chamfer** — edge set, equal-distance style only in v1.

**7.7.5 Shell** — body + faces-to-remove set, thickness (inward only in v1).

**7.7.6 Hole** — the hobbyist power feature. Placement: pick a face + either sketch
points on it or click positions (creates an auto-sketch with point coincident/dimension
scaffolding). Types: simple, counterbore, countersink. Diameter presets: metric clearance
(M2–M12 close/normal/loose per ISO 273 — embed the table as data), tap drill sizes
(M2–M12 coarse), fractional inch. Depth: blind / through-all. Tip angle 118° default.

**7.7.7 Boolean** — combine/cut/intersect selected bodies (target + tools), keep-tools
checkbox.

**7.7.8 Mirror** — bodies or features, about origin plane / datum plane / planar face.

**7.7.9 Linear Pattern** — bodies or features; 1 or 2 directions (edge or axis ref),
count + spacing (expressions). Skippable instances excluded v1.

**7.7.10 Circular Pattern** — bodies or features; axis ref; count; full-circle equal
spacing or total-angle.

**7.7.11 Datum Plane** — offset-from-plane (expression), angle-from-plane-about-edge,
midplane between two parallel faces, through-three-points. Rendered as bordered
translucent quad sized to its references.

**7.7.12 Move/Copy Body** (direct edit) — translate/rotate a body by numeric offsets or
a from-to point pair. Recorded as a timeline feature like everything else.

**AC (per feature, plus):**
1. Every feature's dialog has full keyboard flow (Tab order, Enter=OK, Esc=Cancel).
2. Preview never commits partial state: Cancel after any amount of preview = exact
   pre-dialog document.
3. Each feature ships with ≥ 10 unit regression models (`fixtures/features/extrude/…`)
   asserting resulting body count, volume (±0.1%), surface area, and bounding box —
   volume/area computed via OCCT `BRepGProp`.
4. Hole feature: M5 clearance-normal preset produces a Ø5.5 mm hole (per ISO 273).
5. GP-1 and GP-4 pass end-to-end.

---

### 7.8 Feature Tree & Parametric History

**Purpose:** Fusion-style horizontal **timeline** (bottom) + browser tree (left).

**Behavior:**
- Timeline chips: icon per feature type, hover = name + params tooltip + highlights
  affected geometry in viewport; double-click = edit; right-click menu = Rename,
  Suppress/Unsuppress, Delete (with dependency warning listing downstream features that
  will break/be deleted), Rollback to here.
- **Rollback marker:** draggable; features after the marker are inactive (grayed).
  Creating a new feature while rolled back inserts at the marker (with downstream
  regeneration on marker return).
- **Reorder:** drag chips left/right; the drop is rejected (with explanation toast) if it
  violates dependencies (feature dragged before a feature it references).
- Error/warning states: chip gets red/amber badge; clicking opens a diagnostics popover:
  message + "Edit feature" + (for lost TopoRefs) **"Reattach"** flow: dialog reopens with
  the missing reference slot highlighted; user picks replacement geometry.
- Browser tree shows: Origin (planes/axes), Parameters shortcut, Bodies (per-body
  visibility eye, color swatch, rename), Components & Joints (§7.10), Sketches (visibility).

**AC:**
1. GP-4 passes.
2. Deleting a sketch that an extrude depends on shows the dependency dialog and, on
   confirm, deletes both.
3. Suppressing a fillet removes it from geometry and it stays suppressed across
   save/reload.
4. Rollback + insert + return regenerates downstream features correctly on 10 regression
   models.
5. Reorder of two independent extrudes changes nothing geometrically (regression-tested
   by volume comparison).

---

### 7.9 Parameters & Expressions

**Behavior:**
- **Parameters panel** (modal from browser/toolbar): table of user parameters — name,
  expression, value, unit, comment; add/rename/delete (delete blocked with reference
  list if in use). Renaming rewrites references in all expressions.
- Expression language: numbers with optional unit suffix (`mm`, `cm`, `in`, `deg`),
  operators `+ - * / % ^`, parentheses, parameter names, functions: `sin cos tan asin
  acos atan sqrt abs floor ceil round min max` (trig in degrees), constant `pi`.
  Fractions like `3/8in` handled by the unit parser (§7.3).
- Any numeric field in any feature/constraint dialog accepts an expression; if it
  references parameters, the field shows an `fx` badge; the stored value is the
  expression string, evaluated at regeneration time.
- Dependency tracking: parameter graph must be acyclic; cycle attempts are rejected at
  input time with the cycle path shown.
- Changing a parameter triggers regeneration of exactly the features whose expressions
  reference it (transitively).

**AC:**
1. GP-2 passes (parameter-driven laser panel).
2. `width = 2*thickness + 5` updates when `thickness` changes; unrelated features are
   not re-executed (assert via regeneration counters).
3. Cycle `a = b + 1; b = a + 1` is rejected with both names in the error.
4. Expression parser: 100% branch coverage, fuzzed against a reference evaluator.

---

### 7.10 Assembly

**Purpose:** Position multiple parts correctly relative to each other; verify fit;
export as a set. v1 scope is **static positioning** — joints define placement (and
degrees of freedom for interactive dragging), but there is no motion simulation, no
interference detection (v2).

**Model (per §3.6, single document):**
- Bodies created by features live at the document root. A **Component** wraps a set of
  bodies (or another `.craftbit` file inserted by copy — "Insert from file" embeds a
  full copy, no live cross-file links in v1) with a transform.
- "Create Component from bodies" promotes selected bodies into a component. Components
  can be instanced (same definition, n transforms) — pattern/copy of components supported
  via simple duplicate (shared definition), not via the feature timeline.

**Joints (Fusion-style, defining placement + allowed motion):**
- **Rigid** (fastened): full constraint.
- **Revolute**: rotation about an axis (pick two circular edges/cylindrical faces —
  snap-to-center like Fusion's joint origin snapping: hovering a circular edge snaps to
  its center; hovering a face snaps to face center or corners).
- **Slider**: translation along an edge/axis.
- **Cylindrical**: rotate + slide on one axis.
- Joint creation UX: pick joint origin on component A (snap points: circular-edge
  centers, face centers, vertices, edge midpoints), then on component B → A animates
  into place → set type + offset/angle (expressions allowed).
- **Drag interaction:** dragging a jointed component in the viewport moves it within its
  joint DOFs (solved kinematically for the single dragged chain — a simple forward
  solve, not a full constraint network; chains only, loops resolve by first-joint
  priority and a warning).
- Grounding: first component auto-grounded; ground/unground via context menu; ungrounded,
  unjointed components move freely with the Move tool.

**Browser representation:** components fold bodies + joints beneath them; joints listed
with type icons; double-click joint = edit dialog.

**AC:**
1. GP-3 passes.
2. Joint-origin snapping: hovering a circular edge shows a snap marker at its center
   within 8 px hover tolerance.
3. Revolute joint drag rotates smoothly at 60 fps and respects min/max angle limits if set.
4. Deleting a component removes its joints with a confirmation listing them.
5. Per-component and combined STL export both honor assembly transforms (§7.13).

---

### 7.11 Measurement & Inspection

**Behavior:**
- **Measure tool** (`M`/`I`): click 1 entity → shows properties (edge length, arc
  radius, face area, vertex position); click a 2nd → distance (min distance between
  entities), angle where applicable, ΔX/ΔY/ΔZ. Results panel with copy button;
  persistent on-screen labels until tool exit.
- **Body properties** (context menu): volume, surface area, bounding box dims; mass
  given a density dropdown (PLA 1.24, PETG 1.27, ABS 1.04, plywood 0.6, acrylic 1.18,
  aluminum 2.70, steel 7.85 g/cm³ — embed as data).
- Hover readout in status bar: entity type + primary dimension of hovered entity
  (edge → length, face → area) after 500 ms hover.

**AC:**
1. Distance between two parallel faces 25 mm apart reads 25.000 mm.
2. Measured values respect display units incl. fractional-inch display mode ("1 3/8 in"
   when inch units + fractional display enabled).
3. Bounding box of GP-1 bracket matches 80×40×5 after the GP-4 edit.

---

### 7.12 Import

All imports run in the geometry worker; original file bytes are stored in the container
(§6.1); import is a timeline feature (re-importable/replaceable — "Replace source file"
keeps downstream features attached where topological names survive by shape-matching
heuristics: match by centroid+area within tolerance; unmatched refs → error state, §7.8).

- **STEP (.step/.stp):** via OCCT `STEPControl_Reader`. Assemblies flatten to bodies
  grouped in one component per top-level product. Units honored from file. This is the
  primary "bring a part from the internet / another CAD" path (GP-5).
- **STL (.stl ascii+binary):** imported as a **mesh body** — rendered, measurable
  (vertex-to-vertex), usable as a visual reference and boolean **tool is excluded v1**;
  mesh bodies export back out in STL exports. Conversion-to-BRep excluded v1.
- **DXF (R12–2018, entities: LINE ARC CIRCLE LWPOLYLINE POLYLINE SPLINE ELLIPSE):**
  imports into a **new sketch** on a chosen plane, preserving arcs as arcs. Unknown
  entities skipped with a summary report toast.
- **SVG (paths, basic shapes):** flattened per SVG transform stack into a new sketch;
  cubic béziers → sketch splines; `viewBox`+unit handling with an explicit scale-confirm
  dialog ("This SVG appears to be 96 dpi; 1 px = 0.2646 mm — confirm or override").

**AC:**
1. GP-5 passes with a reference STEP fixture set (≥ 20 real-world files incl. exports
   from Fusion, FreeCAD, SolidWorks, OnShape).
2. 1000-part STEP import either completes < 60 s or fails gracefully with a clear
   message — never a frozen tab.
3. DXF with arcs re-exports (§7.13) with arcs intact (no polyline conversion), verified
   by entity-type comparison.
4. Malformed files of every format produce a user-readable error toast + telemetry-free
   console detail, never an unhandled exception.

---

### 7.13 Export for Fabrication

**Purpose:** THE reason v1 exists. Every export path has validation gates so the file
works on the first try at the machine.

**Export dialog** (top bar): choose scope (whole document / selected bodies / selected
component), format, format-specific options, filename. All generation in the worker with
progress; output via download (or File System Access handle).

**7.13.1 STL (3D printing)**
- Binary STL, unit = mm (de-facto slicer standard). Per-body or merged. Tessellation
  quality selector: Standard (0.05 mm deflection) / Fine (0.01) / Custom, + angular
  deflection 0.5 rad default.
- **Validation gate (runs automatically):** exported mesh → Manifold library check:
  watertight, no self-intersections, consistent winding. If invalid → attempt Manifold
  auto-repair → if repaired, note in success toast; if unrepairable, block export with a
  viewport overlay highlighting problem triangles and an "export anyway" escape hatch.

**7.13.2 3MF (3D printing, modern)**
- Single 3MF containing each selected body as a named object (names from browser),
  correct unit metadata, assembly transforms applied. Same validation gate as STL.
  (3MF preserves names + multi-part, which slicers increasingly prefer.)

**7.13.3 SVG / DXF from faces (laser cutting)**
- Flow: user selects one or more **planar faces** (typically the top faces of
  `thickness`-extruded panels) → each face's outer wire + holes become closed paths.
  Multiple faces auto-layout side-by-side with configurable gap (5 mm default) — no
  nesting optimization in v1.
- **Exact scale:** SVG uses `mm` units in width/height/viewBox (`width="120mm"`).
  DXF uses R12 with `$INSUNITS=4` (mm). Include a 100×10 mm calibration rectangle
  option (off by default).
- **Kerf compensation (optional, off by default):** offset outer contours outward and
  hole contours inward by kerf/2 (user enters kerf, e.g. 0.15 mm). Implemented via OCCT
  2D offset on the wire (preserving arcs) — NOT polygon offsetting of tessellated
  points. Reversals/self-intersections after offset → warn and skip that contour.
- Arcs/circles remain true arcs in DXF; in SVG, circles/arcs emit as arc path commands
  (`A`), splines as cubic béziers fitted within 0.01 mm tolerance.
- Color convention option: "LightBurn/Glowforge friendly" — cuts stroke `#FF0000`,
  engrave-marked construction geometry `#0000FF`, stroke-width 0.1 mm, no fill.

**7.13.4 STEP (CNC / CAD interchange)**
- AP214, mm, per-body solids with names, assembly transforms applied. Round-trip
  fidelity: exporting an imported STEP preserves solid count and volume ±0.01%.

**7.13.5 DXF from sketch**
- Any sketch exportable directly to DXF (same fidelity rules as 7.13.3) — covers CNC
  2D profiling workflows that never extrude.

**AC:**
1. GP-1: exported STL loads in PrusaSlicer & Cura with zero repair warnings, dimensions
   exact. (Automate: run STL through Manifold + assert dimensions from mesh bounds; the
   slicer check is a manual release-gate checklist item.)
2. GP-2: SVG opened in Inkscape measures exactly; DXF opened in LibreCAD measures
   exactly; kerf 0.15 grows a 120 mm outer dimension to 120.15 mm.
3. A deliberately non-manifold construction (two cubes sharing exactly one edge, exported
   merged) triggers the repair path and produces a watertight file.
4. 3MF validates against the 3MF Consortium's spec validator; opens named-correctly in
   PrusaSlicer (release-gate checklist).
5. STEP re-import round-trip volume ±0.01% on the fixture set.
6. Every export of every format is covered by golden-file tests (byte-stable where the
   format allows, else parsed-equivalence).

---

### 7.14 Undo/Redo

- Command-pattern over `documentStore` (§4.4): every user action = one command with
  inverse. Unlimited depth within session; stack persists through autosave journal so
  undo works even after a refresh (bounded to last 200 commands).
- Sketch-internal edits batch per gesture (a drag = one command; a tool-completed entity
  = one command with its inferred constraints).
- Undo during an open feature dialog is disabled (dialog Cancel is the escape).
- `Ctrl+Z` / `Ctrl+Shift+Z` (+ `Ctrl+Y`); buttons in top bar with tooltips naming the
  command ("Undo Extrude").

**AC:** A scripted 60-step random-walk (create/edit/delete/reorder/param-change) followed
by 60 undos returns a `document.json` deep-equal to the start; 60 redos returns to the
end. Run as a property-based test with 100 seeds in CI.

---

### 7.15 Keyboard, Mouse & Touch Input

- **Shortcut map (v1):** `L` line, `C` circle (in sketch), `R` rectangle, `D` dimension,
  `X` construction-toggle, `P` project, `E` extrude, `Q` press... — no: keep Fusion's:
  `E` extrude, `F` fillet (solid mode), `M` move, `I` measure, `S` shortcut-search box
  listing all commands (a command palette — implement; it's cheap and aids
  discoverability), `Esc` cancel/exit, `Delete` delete, `Ctrl+S` save (writes snapshot +
  file handle if present), `F6`-style view keys per §7.4. Full map lives in
  `docs/shortcuts.md` and an in-app cheatsheet (`?`).
- Single-key shortcuts only trigger when no text field is focused. All shortcuts
  rebindable is **excluded v1** (scheme presets only, §7.3).
- **Touch (tablet):** one-finger drag = orbit (viewport) / entity drag (sketch);
  two-finger = pan+pinch-zoom; long-press = right-click menu; picking tolerance 12 px;
  feature dialogs remain usable at 768 px. Full sketching parity on touch is best-effort,
  not release-blocking; viewing/measuring/exporting on touch IS release-blocking (P4).

---

### 7.16 Onboarding & Help

- **First-run:** WASM loading screen doubles as a 3-slide "what you can make" intro.
  Then an optional 2-minute interactive tutorial overlay building GP-1's bracket
  (step-by-step tooltips anchored to real UI; skippable; re-launchable from Help).
- Sample projects on the home screen: Bracket (print), Finger-joint box (laser),
  Simple flange (CNC/STEP) — each a `.craftbit` bundled with the app, opened as copies.
- Help menu: shortcuts cheatsheet, docs link, GitHub link, version + licenses page
  (OCCT LGPL attribution etc. — REQUIRED for license compliance).
- Empty-state hints: blank document shows ghost-text "Create a sketch to start (S)".

**AC:** A first-time user (hallway test, release checklist) completes the tutorial
without external help; tutorial completes correctly after every UI refactor (Playwright
covers it).

---

## 8. Performance Requirements

**Reference machine for all budgets:** 2020 mid-range laptop class — 4-core, 8 GB RAM,
integrated GPU (e.g., i5-1035G1 / M1 Air throttled profile), Chrome latest. CI perf tests
run on standardized GitHub runners with calibrated relative budgets.

| Metric | Budget |
|---|---|
| App shell interactive (cold) | < 2 s |
| Kernel ready (cold, 20 Mbps) | < 15 s; < 3 s warm (SW cache) |
| Orbit/pan/zoom | 60 fps @ 500k tris / 50 bodies |
| Sketch drag solve | ≥ 30 fps @ 150 entities/200 constraints |
| Single-feature regen (typical extrude/fillet) | < 200 ms median, < 1 s p95 |
| Full 30-feature model regen | < 3 s |
| STL export 500k tris incl. validation | < 5 s |
| Autosave snapshot | < 100 ms main-thread cost (serialize off-thread where possible) |
| Memory ceiling | < 1.5 GB total for the 500k-tri scene |
| Bundle: JS (non-WASM, gzip) | < 1.5 MB initial route |

The perf harness (`perf/` + Playwright traces) is built in Milestone 1 and run on every
PR with regression alerts at +10%.

---

## 9. Browser & Device Support

- **Tier 1 (release-blocking):** Chrome/Edge (last 2), Firefox (last 2), Safari 17+ —
  desktop. Chrome on Android tablets, Safari on iPad (view/measure/export flows).
- **Tier 2 (best-effort):** phones (view/export only), Safari 16.4+ (OPFS caveats →
  IndexedDB-only fallback path required).
- Required platform features: WebAssembly, WebGL2, Web Workers, IndexedDB. Optional
  with fallback: OPFS, File System Access API, `navigator.locks`, WASM threads (kernel
  must run single-threaded correctly; threads are an optimization).
- No WebGPU dependency in v1.

---

## 10. Testing Strategy

1. **Unit (Vitest):** expression parser, unit parsing, schema validation/migration,
   command undo inverses, kerf-offset math, DXF/SVG writers (golden files).
2. **Kernel regression (Vitest, node + WASM):** the `fixtures/` model corpus — every
   feature type × edge cases; assertions on volume/area/bbox/body-count (±0.1%);
   topological-naming survival tests (edit upstream, assert downstream refs resolve).
   Target ≥ 200 fixture models by release.
3. **Property-based:** undo/redo random walks (§7.14); random constraint systems
   (solver never crashes, always terminates ≤ 500 ms or reports non-convergence).
4. **E2E (Playwright, real WASM):** the five GP workflows + tutorial + storage-crash
   recovery + import fixtures. Runs headed-WebGL on CI (chromium with GPU flags;
   fallback SwiftShader with relaxed perf assertions).
5. **Export conformance:** parse every exported file with independent libraries
   (e.g., a second STL parser, `dxf-parser`, SVG via resvg) and assert geometry, not
   just "no crash".
6. **Manual release checklist** (`docs/release-checklist.md`): real slicer opens
   (Prusa/Cura/Bambu), real LightBurn/Inkscape open, real CAM (Kiri:Moto) STEP open,
   Safari/iPad pass, hallway usability test.
7. **Coverage bars:** `src/core/**` ≥ 90% lines; app overall ≥ 70%. CI blocks merge.

---

## 11. Repository Structure

```
craftbit/
├── docs/                    # this spec, ADRs, shortcuts, release-checklist, file-format.md
├── kernel/                  # OCCT wasm build config (Docker), pinned artifacts
├── packages/
│   ├── core/                # framework-free: document model, schemas, commands,
│   │                        #   expressions, units, migrations  (no React, no Three)
│   ├── geometry-worker/     # OCCT integration, features, tessellation, import/export
│   ├── sketch-worker/       # PlaneGCS integration, region finding
│   └── app/                 # React UI, viewport, stores, PWA
├── fixtures/                # regression models + import/export golden files
├── perf/                    # performance harness
└── e2e/                     # Playwright suites
```

- pnpm workspaces; `packages/core` must never import from `app` (dep-cruiser rule).
- Architecture Decision Records in `docs/adr/NNN-*.md` — every [DECISION] in §3 gets one;
  future deviations require a new ADR.
- License: **choose LGPL-2.1-or-later or MPL-2.0** for compatibility with OCCT (LGPL-2.1)
  and PlaneGCS (LGPL); plain MIT for `packages/core` is acceptable if kernel bindings are
  isolated. Record the final call as ADR-001 before the first external contribution.

## 12. Implementation Milestones

Ordered so each milestone is independently demoable and de-risks the scariest items first.
(AI agents: complete milestones in order; within a milestone, the bullet order is the
dependency order.)

- **M0 — Skeleton (foundation):** repo scaffolding, CI, Vite app shell, kernel WASM build
  loading in a worker with a "make a box, tessellate, render in Three.js" smoke test;
  perf harness skeleton. *Demo: a hardcoded box orbiting at 60 fps.*
- **M1 — Viewport & document core:** §7.1 shell, §7.4 viewport, §7.5 selection,
  document model + commands + undo (§6, §7.14), storage/autosave (§7.2), units (§7.3).
  *Demo: create primitive boxes via a debug command, select faces, undo, refresh-restore.*
- **M2 — Regeneration engine + topological naming (the risk milestone):** §4.3 in full,
  Extrude from hardcoded sketches, edit/rollback plumbing (§7.8 minimal). *Demo: GP-4
  mechanics on a scripted document.* Do not proceed until naming survives the fixture
  torture set.
- **M3 — Sketcher:** §7.6 complete. *Demo: fully-constrain a bracket profile.*
- **M4 — Modeling features:** §7.7 complete, parameters (§7.9), timeline UI (§7.8)
  complete. *Demo: GP-1, GP-4 pass in Playwright.*
- **M5 — Export:** §7.13 complete with validation gates. *Demo: GP-2 passes; STL prints
  (manual).*
- **M6 — Import:** §7.12. *Demo: GP-5 passes.*
- **M7 — Assembly:** §7.10, measurement (§7.11). *Demo: GP-3 passes.*
- **M8 — Polish & release:** onboarding (§7.16), touch/tablet pass (§7.15), perf budget
  enforcement (§8), PWA/offline, licenses page, docs site, release checklist run.
  *Demo: public beta.*

## 13. Post-v1 Roadmap (Explicitly Deferred)

In rough priority order, informed by persona needs: **v1.x:** loft/sweep, sketch text
(fonts → laser engraving), interference detection, appearance/materials, section
analysis with measurement. **v2:** 2.5D CAM (profile/pocket/drill G-code) + laser G-code,
technical drawings, cloud sync + share links (backend introduced here), scripting API
(the §4.5 groundwork), STL→BRep conversion, sheet metal. **v3:** real-time collaboration,
simulation, generative/nesting optimization.

## 14. Glossary

**B-rep** — boundary representation; solids defined by exact faces/edges/vertices (vs. triangle meshes). **OCCT** — OpenCascade Technology, the open-source B-rep kernel. **Topological naming** — assigning stable IDs to faces/edges so parametric references survive edits. **DOF** — degrees of freedom in a constraint system. **Kerf** — material removed by the laser beam width. **Manifold (mesh)** — watertight, printable mesh. **OPFS** — Origin Private File System, browser-private file storage. **PWA** — Progressive Web App (installable, offline-capable). **Feature timeline** — ordered, editable history of modeling operations. **TopoRef** — this spec's stable reference to geometry (§6.2).
