# D3: Constraint-based sketcher

Status: **implementing** · Owner: core + geometry-worker + app · Supersedes the
profile-only sketch delta noted in README

The spec (§7.6, §6.3) calls for a real 2D constraint sketcher: geometric
entities (points, lines, arcs, circles) related by constraints (coincident,
horizontal, parallel, dimensions…) and kept consistent by a solver. This doc
fixes the entity/constraint model, the solver choice, the document-schema
changes, how solved geometry becomes faces in the kernel, and the UI
interaction model. Existing profile-based sketches (rect/circle/polygon)
remain valid — the two models coexist in the same sketch feature.

## 1. Solver decision: custom Levenberg–Marquardt core, PlaneGCS-compatible model

The spec suggested PlaneGCS (FreeCAD's solver) compiled to WASM. Decision:
**ship a custom TypeScript numerical core instead**, with the constraint
*model* kept structurally compatible so PlaneGCS can be swapped in later.

Rationale:
- Our v1 constraint set is small (11 kinds) and sketches are hobbyist-scale
  (tens of entities, not thousands). Levenberg–Marquardt over the full
  parameter vector converges in single-digit milliseconds at this scale —
  interactive dragging is not at risk.
- A second WASM module (~1 MB + async init) complicates `packages/core`'s
  framework-free/synchronous contract; the solver must run synchronously in
  both the worker (regen) and the UI thread (drag preview).
- PlaneGCS's advantages — redundancy diagnosis, DogLeg/SQP fallbacks,
  decomposition for big systems — matter at scales we don't reach in v1.
- The swap path stays open: constraints are declarative data; only
  `solveSketch()`'s internals would change.

What we give up (accepted): precise redundant/conflicting-constraint
identification. v1 reports convergence + a residual check and a DOF estimate;
it does not name the offending constraint.

## 2. Entity model (`packages/core/src/sketchSolver.ts` + document schema)

Entities live in `SketchFeature.entities`; all coordinates are plain numbers
(mm, sketch-local). Stored coordinates are the *last solved/drawn* state and
serve as the initial guess for the next solve — the solve itself is
re-run at every regeneration, so dimensions drive geometry, not vice versa.

```ts
{ id, kind: "point",  x, y }
{ id, kind: "line",   p1: pointId, p2: pointId }
{ id, kind: "circle", center: pointId, radius: number }
{ id, kind: "arc",    center: pointId, start: pointId, end: pointId, ccw: boolean }
```

- Lines/arcs/circles reference **shared point entities**; drawing chained
  lines reuses the endpoint entity, which encodes coincidence structurally
  (no equation needed) — the same trick FreeCAD uses.
- Arc radius is implicit: the solver adds two built-in residuals
  `|start−center| = r` and `|end−center| = r` with `r` a solver parameter
  seeded from the stored geometry. This keeps endpoints first-class points
  that other constraints can grab.

## 3. Constraint model

Dimensional values are expression strings evaluated against the parameter
table *before* solving (worker: regen env; UI: last regen's parameter values).

| kind | operands | residual(s) |
| --- | --- | --- |
| `coincident` | point, point | `ax−bx`, `ay−by` |
| `horizontal` / `vertical` | line | `y2−y1` / `x2−x1` |
| `parallel` | line, line | cross(d₁, d₂) |
| `perpendicular` | line, line | dot(d₁, d₂) |
| `equalLength` | line, line | `|d₁|²−|d₂|²` |
| `equalRadius` | circle/arc ×2 | `r₁−r₂` |
| `distance` | point, point, expr | `|a−b|−v` |
| `radius` | circle/arc, expr | `r−v` |
| `angle` | line, line, expr (deg) | `atan2(cross,dot)−v·π/180` |
| `tangent` | line, circle/arc | dist(center → line)−r |
| `fixed` | point | removes the point's params from the vector |

Cross/dot residuals are normalized by entity length scale so mixed-size
sketches condition well.

## 4. Solver

- Parameter vector: (x, y) of every non-fixed point + radius of every
  circle/arc. Residual vector from §3 + implicit arc residuals.
- **Levenberg–Marquardt**: numeric forward-difference Jacobian (systems are
  small; simplicity beats symbolic derivatives here), damped normal
  equations via Gaussian elimination, λ adaptation ×10/÷10, convergence at
  max-residual < 1e-8, cap 200 iterations.
- **Dragging**: the dragged point's target position joins as two extra
  low-weight residuals (`w = 0.05`) so real constraints always win but the
  point follows the cursor through the constraint manifold. Standard
  soft-target technique.
- **Diagnostics** returned with every solve: `converged` (residual check) and
  `dof = max(0, params − independentResidualEstimate)` where the estimate is
  the row count of the Jacobian's numerically independent rows (rank via
  Gaussian elimination with a tolerance). UI shows "Fully constrained" at 0
  DOF, "n degrees of freedom" otherwise, "Over-constrained / not converged"
  when the solve fails its residual check.

## 5. From solved entities to faces (loop extraction + kernel)

`extractLoops(entities)` (core, pure, unit-tested):
- Circles are standalone loops.
- Lines/arcs form a graph over their endpoint entities (points merged by
  `coincident` constraints unify nodes). Every connected component in which
  **every node has degree exactly 2** is a closed loop; walk it to an ordered
  segment list. Components with dangling ends produce no face (drawing in
  progress) — that's normal, not an error.
- Loop ids are canonical (`loop:` + lexicographically smallest member entity
  id) so extrude `profileIds` stay stable across edits.

Worker (`regen.ts`):
- `EvaluatedSketch` gains `entities` (solved, for UI rendering), `loops`
  (as new `EvaluatedProfile` kind `"loop"` with line/arc segments), and
  solve diagnostics.
- Wire building: line segments via `BRepBuilderAPI_MakeEdge(gp_Pnt, gp_Pnt)`
  (existing pattern); arc segments via `GC_MakeArcOfCircle` (3-point form:
  start, on-arc midpoint, end) → `Geom_TrimmedCurve` → edge. Exact API
  overload names verified by Node probe before use (house rule).
- Containment/nesting: loops participate in the existing `groupProfiles`
  even-odd logic via a sampled polygon approximation (arcs → 32 segments)
  for area/inner-point/contains tests only; the real wire keeps true arcs.

## 6. UI interaction (packages/app)

- **Line tool**: click to start, click again per segment (each click commits
  a line whose endpoints are shared point entities); clicking on/near the
  chain's first point closes the loop and ends the chain; Esc/double-click
  ends without closing. Rubber-band preview uses the existing preview layer.
- **Entity rendering** (sceneManager): lines/arcs/circles as line geometry in
  the sketch group; endpoint/center points as screen-size square handles.
  Solved positions come from the regen result, so what you see is always the
  solver's output.
- **Selection**: in the Select tool, entity picking runs in screen space
  (project endpoints via `projectToScreen`, nearest point within 8 px wins,
  then nearest line/arc within 6 px) — more predictable than raycaster
  thresholds at glancing angles. Multi-select with Shift.
- **Constraint toolbar**: appears in sketch mode; buttons enable based on the
  selection shape (2 points → coincident/distance; 1 line → H/V; 2 lines →
  parallel/perpendicular/equal/angle; circle/arc → radius; line+circle →
  tangent; 1 point → fix). Clicking dispatches an `updateFeature` adding the
  constraint; regen re-solves and the drawing snaps.
- **Dimensions on canvas**: `distance`/`radius`/`angle` constraints render as
  clickable labels (same pattern as the existing W/H/R labels) with inline
  expression editing.
- **Dragging**: with Select, dragging a point handle runs local solves per
  pointer-move for live preview and commits the solved coordinates in a
  single `updateFeature` on pointer-up (one undo step per drag).
- **DOF badge**: sketch toolbar shows the active sketch's diagnostic.

Legacy rect/circle/polygon tools and their dimension labels stay untouched.

## 7. Compatibility & migration

- `SketchFeature.entities` and `.constraints` are optional arrays (absent in
  old documents ⇒ treated as empty). Format version stays 1 — strictly
  additive.
- Extrude/revolve `profileIds` may reference profile ids or loop ids
  interchangeably; empty still means "everything closed in the sketch".

## 8. Testing

- Solver unit tests with closed-form assertions: rectangle from 4 free lines
  + H/V/distance constraints solves to exact 60×40; tangent line-circle;
  angle; equal; over-/under-constrained diagnostics; drag follows target
  while preserving constraints.
- Loop extraction tests: open chains yield nothing, closed chains yield
  ordered loops, coincident-merged endpoints count.
- Kernel regression: constrained rectangle → extrude 5 mm → volume exactly
  60·40·5; loop with an arc (slot shape) → exact area·height volume.
- Playwright E2E: draw a 4-line closed chain with the line tool, H/V + two
  distance dims (60/40), extrude 5, exported STL bounds exactly
  60.00 × 40.00 × 5.00 mm; drag test moves a corner and the shape stays
  rectangular.

## 9. Out of scope for this gate (tracked)

Symmetric/midpoint/collinear constraints; construction geometry; auto
constraint inference on draw (beyond endpoint chaining); precise redundant-
constraint identification; PlaneGCS swap-in; splines/ellipses; UI arc tool
may land minimal (model/kernel arc support is in-scope and tested either way).
