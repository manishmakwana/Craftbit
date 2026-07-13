# D2: Topological Naming Scheme

Status: **draft — pending Phase-0 binding probe** · Milestone: M2 · Serves: spec §4.3, §6.4, §7.8
Depends on: D1 (worker RPC — names travel in tessellation payloads), the OCCT history API
(`BRepBuilderAPI_MakeShape::Generated/Modified/IsDeleted`).

## 1. Context

Every downstream reference to geometry — "sketch on this face" ([`PlaneRef`](../../packages/core/src/document.ts)),
"fillet this edge" (`EdgeRef`), "shell removing these faces" (`FaceRef`) — is today stored
as a **raw enumeration index**: `{ bodyId, faceIndex }`, where `faceIndex` is the position
of the face in `TopExp_Explorer` traversal order of the body's shape *at the moment the
user clicked*. This is correct only while the upstream geometry is byte-identical. Any
upstream edit (dimension change, new fillet, feature reorder) rebuilds the OCCT shape and
may reorder, split, merge, add, or delete faces — after which the stored index silently
denotes a *different* face. This is the classic parametric-CAD corruption mode the spec
forbids: a reference "must never silently pick a different face" (§4.3).

D2 replaces indices with **stable, deterministic string names** derived from each
subshape's *birth lineage*: which feature created it, from which input entity, by which
kind of history event. Names are:

- **deterministic** — regenerating the same document twice yields the same names
  (no session state, no persistence of kernel pointers; survives worker restarts);
- **lineage-anchored** — a face's name never depends on its enumeration position;
- **opaque to the UI** — the app stores and compares them; only the geometry worker
  mints and resolves them (§6.4);
- **loud on failure** — an unresolvable name puts the referencing feature in `error`
  state with a reattach affordance (§7.8); the resolver never falls back to guessing.

Constraints inherited from the current codebase:

- Kernel is opencascade.js 1.1.1 (prebuilt full OCCT 7.4). Its `Supported APIs` list
  confirms `BRepBuilderAPI_MakeShape`, `BRepAlgoAPI_Cut/Fuse/Common`,
  `BRepFilletAPI_MakeFillet/MakeChamfer`, `BRepOffsetAPI_MakeThickSolid`,
  `BRepPrimAPI_MakePrism/MakeRevol`, `BRepBuilderAPI_Transform`, `TopTools_ListOfShape`
  are all bound. Per-method availability (history methods return
  `TopTools_ListOfShape&`) must be verified by the Phase-0 probe (§7).
- The regen engine ([`regen.ts`](../../packages/geometry-worker/src/regen.ts)) executes
  features sequentially over a `RegenState { bodies: RegenBody[] }`; each `RegenBody`
  holds one `TopoDS_Shape`. Naming state attaches to `RegenBody`.
- Sketches are profile-based (D3 not landed): profiles are rects, circles, polygons
  with UUID `profile.id`s. Profile curve identity is derivable without a solver.
- Tessellation ships `faceIds`/`edgeRanges` index maps to the app for picking
  ([`tessellate.ts`](../../packages/geometry-worker/src/tessellate.ts)); D2 adds
  parallel name tables so a pick resolves to a name.

## 2. Decisions

### 2.1 [DECISION] Lineage-encoded string names, computed fresh every regen

Each subshape's name is a string that *encodes its derivation*: the creating feature's
id plus a role tag that references the input entity's name (recursively). Names are
recomputed from scratch on every regeneration by walking OCCT history; nothing about
naming is cached across regens or sessions. Resolution is then a plain map lookup.

**Alternatives rejected:**

- *Persistent kernel-side tags (OCAF/`TNaming`)*: OCCT's own answer, but OCAF drags in a
  document framework parallel to ours, its WASM binding surface is poorly exercised, and
  its persistence model fights our JSON document. Rejected for v1.
- *Geometric matching* (re-find "the face nearest centroid C with normal N"): this is
  guessing by construction — exactly what §4.3 forbids. Used by no serious CAD as the
  primary mechanism. Rejected outright as primary; also rejected as an automatic
  fallback (reattach is a *user* action).
- *Sticky session tables* (remember index→name maps from the previous regen and diff):
  breaks on worker restart and on document load — the first regen of a session would
  have no basis. Determinism from the document alone is non-negotiable (D1 crash
  recovery re-runs regen from the document).

### 2.2 [DECISION] Names encode full parent lineage (recursive), not local ordinals

A fillet face is named by *the edge it replaced*, whose name in turn embeds *the faces
whose intersection formed it*, etc. Names therefore grow with timeline depth. This is
accepted: names are opaque, never displayed raw, compress well in JSON, and full lineage
is what makes them survive feature reorder (a name mentions only feature ids and input
entities — never positions in the timeline or enumeration order).

**Alternative rejected:** flat per-feature ordinals (`f_xyz/face/3`) with a separate
lineage table. The table would itself need persistence and migration; folding lineage
into the string keeps the document self-describing and diff-able.

### 2.3 [DECISION] 1→N splits: deterministic centroid ordering + exact-count guard

When history maps one input to N outputs (`Modified(F)` returns 2+ faces — e.g. a slot
cut splits a face), siblings get ordinals assigned by sorting on centroid
(lexicographic x,y,z, tolerance 1e-7 mm). Ordering by centroid is deterministic for a
given geometry but **not** guaranteed stable under parameter edits, so the resolver
enforces an **exact-count guard**: a name carrying split ordinal `k` of `n` resolves
only if the same input still splits into exactly `n` pieces; otherwise the reference
fails loudly. Features holding split-ordinal refs additionally regenerate with status
`warning` ("reference to a split face — may need reattachment after upstream edits").

**Alternative rejected:** disambiguating by adjacent-face fingerprints. Strictly more
precise, strictly more code, and it degrades into geometric matching at the margins.
Revisit post-v1 if torture-set telemetry shows centroid ordering flapping in practice.

### 2.4 [DECISION] References become `{ bodyId, name }`; document format v2

`EdgeRef`/`FaceRef`/`PlaneRef(kind:"face")` change from `…Index: number` to
`name: string`. `formatVersion` bumps 1→2. v1 documents are migrated on load by a
one-time **upgrade regen**: regenerate with v1 semantics (index lookup), capture the
name of the subshape each index currently denotes, rewrite refs, stamp v2. If an index
is out of range during upgrade, the owning feature enters `error` (never guess — same
rule as normal resolution).

### 2.5 [DECISION] Naming rules are part of each feature executor's contract

Every executor in `regen.ts` returns, alongside the new shape, the history evidence D2
needs (the builder object or an explicit old→new mapping). A single shared
`nameResult()` routine turns that into the body's new name table. New feature types must
ship naming rules in the same PR (enforced by the determinism test in §6.1, which walks
all `FEATURE_TYPES`).

## 3. Detailed design

### 3.1 Name grammar

```
name        := featId "/" shapeKind "/" tag
shapeKind   := "face" | "edge" | "vertex"
tag         := origin ( ";" splitMark )?
origin      :=
    "start" | "end"                      // extrude/revolve caps
  | "side(" curveKey ")"                 // swept from a sketch curve
  | "cap(" curveKey ")"                  // cap-face edge born from a sketch curve
  | "gen(" parentName ")"                // Generated(parent) — new dimension
  | "mod(" parentName ")"                // Modified(parent) — same dimension
  | "sect(" parentNameA "," parentNameB ")"  // boolean section edge (two parents)
  | "inst(" k "," parentName ")"         // pattern/mirror instance k of parent
  | "imp(" ordinal ")"                   // imported shape, exploration ordinal
  | "new(" ordinal ")"                   // orphan: no history evidence (warning)
splitMark   := "s" k "of" n              // sibling k (0-based) of n, centroid-sorted
curveKey    := sketchFeatId ":" profileId ":" segIdx
featId      := the creating feature's UUID
parentName  := a complete name (recursion)
```

Notes:

- `curveKey` names sketch geometry without D3: rect segments are `0..3`
  (bottom, right, top, left in profile-local coords), circle is `0`, polygon segment
  `i` joins `points[i]→points[i+1 mod n]`. **Known limitation:** inserting/removing a
  polygon point re-keys later segments of that polygon; dependents on those side faces
  will fail loudly and need reattach. Rect/circle keys are fully stable. D3's sketch
  entities (UUID per curve) will replace `segIdx` and remove this limitation.
- A subshape that passes through a feature untouched (`IsSame` on old and new shape)
  **keeps its existing name** — features it flows through add nothing. Names only grow
  at features that actually touch the entity. `mod(…)` wraps only on true modification.
- Only when the *same* feature modifies an entity twice in one op (does not occur with
  current executors) would nesting like `mod(mod(…))` appear within one feature id;
  across features it is expected and correct.
- Names never contain positions in `doc.features` or explorer enumeration indices —
  that is what makes them survive reorder.

### 3.2 Worker data structures

```ts
// geometry-worker/src/naming.ts (new module)

/** One body's name table for the current regeneration state. */
export interface TopoNames {
  /** name → subshape, for resolution and as prev-state input to the next feature. */
  byName: Map<string, TopoDsShape>;
  /** Deterministic reverse lookup filled at tessellation time:
   *  explorer-order index → name, per kind. */
  faceNameByIndex: string[];
  edgeNameByIndex: string[];
}

export interface RegenBody {
  id: string;
  shape: TopoDsShape;
  names: TopoNames;          // NEW — replaces nothing; indices remain for tessellation
}

/** History evidence a feature executor hands to the namer. */
export interface HistoryEvidence {
  kind: "builder";
  builder: MakeShapeLike;               // wraps Generated/Modified/IsDeleted
  /** Extra seeds with a priori names, e.g. profile wire edges → curveKeys,
   *  MakePrism FirstShape/LastShape → start/end. */
  seeds?: { shape: TopoDsShape; name: string }[];
} | {
  kind: "explicit";                     // transform/move/pattern/import
  map: (oldName: string, oldShape: TopoDsShape) => string; // e.g. identity, inst(k,·)
} ;

export interface MakeShapeLike {
  Generated(s: TopoDsShape): TopToolsListOfShape;
  Modified(s: TopoDsShape): TopToolsListOfShape;
  IsDeleted(s: TopoDsShape): boolean;
}
```

### 3.3 The naming pass (`nameResult`)

Runs once per feature execution, per output body:

```ts
function nameResult(
  oc: OpenCascadeInstance,
  featureId: string,
  prev: TopoNames | null,          // null when the feature creates the body
  evidence: HistoryEvidence,
  newShape: TopoDsShape,
): { names: TopoNames; orphans: number };
```

Algorithm (builder evidence):

1. Index all faces/edges/vertices of `newShape` into a `TopTools_IndexedMapOfShape`
   per kind (dedupes shared subshapes; gives the canonical iteration set).
2. **Passthrough:** for each old named subshape `O` with `newIndex.Contains(O)`
   (`IsSame` semantics), carry its name over unchanged.
3. **Deleted:** for each remaining old `O`, if `builder.IsDeleted(O)` → name retired
   (recorded in the feature's regen report for diagnostics).
4. **Modified:** collect `builder.Modified(O)` for each old `O`. Invert into
   `newShape → [sourceNames]`. One source, one output → `featId/kind/mod(srcName)`.
   One source, n>1 outputs → centroid-sort outputs, names get `;s{k}of{n}`.
   Multiple sources merging into one output (fuse seam) → sources sorted
   lexicographically, name uses the first; the merge is recorded in the report.
5. **Generated:** same inversion for `builder.Generated(O)` over old subshapes *and*
   `evidence.seeds` → `featId/kind/gen(srcName)` (seeds use their given name directly,
   e.g. `side(curveKey)` — see §3.4 per-op tables).
6. **Orphans:** any new subshape still unnamed → `featId/kind/new(j)` with `j` from
   centroid sort of the orphan set; feature status becomes `warning` listing the count.
   Orphans are resolvable names (stable while topology count is stable) but signal a
   history gap to fix.
7. Build `faceNameByIndex`/`edgeNameByIndex` by walking the same explorer order
   tessellation uses.

Cost: O(|old| · (1 Generated + 1 Modified call)) + O(|new|) map operations. At v1
scale (≤ a few thousand faces, spec §8) this is noise next to the boolean itself.

### 3.4 Per-feature naming rules

| Feature | Evidence | Rules |
|---|---|---|
| **sketch** | — | Sketches produce no body subshapes; they contribute `curveKey`s consumed by extrude/revolve. |
| **extrude** (`BRepPrimAPI_MakePrism`) | builder + seeds | Seed `FirstShape()`'s faces → `start` (multi-profile: `start;s{k}of{n}` by centroid), `LastShape()` → `end`. `Generated(profileEdge)` → `side(curveKey)`. `Generated(profileVertex)` → lateral edges `gen(vertexKey)`. Cap-face boundary edges → `cap(curveKey)` via `Generated`/`FirstShape` cross-index. Symmetric extrude is a single prism from a translated profile — same rules. For `operation: join/cut` the prism is named first, then boolean rules apply to the combine. |
| **revolve** (`BRepPrimAPI_MakeRevol`) | builder + seeds | `Generated(profileEdge)` → `side(curveKey)`. Partial revolve: `FirstShape()` → `start`, `LastShape()` → `end`; full 360°: no caps (and refs to `start`/`end` correctly die if angle is edited to 360). Axis-touching profiles produce degenerate/apex cases → orphan path (warning) is acceptable v1. |
| **fillet** (`BRepFilletAPI_MakeFillet`) | builder | `Generated(edge)` → the fillet face(s) `gen(edgeName)`; multi-face blends at corners get split marks. `Modified(face)` → trimmed neighbors keep lineage via `mod(…)` only if OCCT reports true modification; typically trimming reports Modified 1→1 so names survive as `mod(old)`. |
| **chamfer** (`BRepFilletAPI_MakeChamfer`) | builder | Identical to fillet. |
| **shell** (`BRepOffsetAPI_MakeThickSolid`) | builder | `Modified(face)` → offset inner faces. Rim faces (thickness walls at removed-face boundaries) come from `Generated(edgeOfRemovedFace)`. OCCT 7.4 thick-solid history is the weakest of the set — Phase-0 probes it explicitly; orphan fallback covers gaps with `warning`, which is honest (spec prefers loud degradation over invented lineage). |
| **boolean** (`BRepAlgoAPI_Cut/Fuse/Common`) | builder | Old names from **both** parents feed step 2–5 (tool-body lineage survives into the result — a cavity wall keeps its tool-extrude `side(…)` name). Section edges (`Generated` from a *face*) → `sect(faceA,faceB)` with the two parent face names sorted. Whole-face deletions via `IsDeleted`. The tool body is consumed (removed from `RegenState.bodies`); its names live on only inside the result's lineage strings. |
| **mirror** (`BRepBuilderAPI_Transform`, copy) | explicit | New-body mirror: every subshape of the copy → `featId/kind/inst(0,srcName)`. Merge mirror: name the copy that way, then fuse under boolean rules. |
| **linearPattern / circularPattern** | explicit + builder | Instance `k` (k≥1; the original keeps its names) → `featId/kind/inst(k,srcName)`. The subsequent fuse of instances follows boolean rules; seam faces between touching instances resolve through `mod`/split marks. Count changes: existing `inst(k)` names are untouched; grown counts append; shrunk counts retire high-k names (dependents fail loudly — correct). |
| **move** | explicit, identity | `BRepBuilderAPI_Transform` relocates without topology change: every name carries over verbatim (passthrough via `IsSame` fails under relocation, so `move` uses `kind:"explicit"` identity mapping keyed by explorer-order correspondence, which `Transform` preserves). |
| **importStep** | explicit | No history exists. Faces/edges named `featId/kind/imp(j)` in explorer order at import. Deterministic because the embedded STEP bytes are immutable document content; the same bytes always parse to the same shape and order. Re-import/replace-source matching is D5's problem, not D2's. |

### 3.5 Resolution

```ts
function resolveRef(state: RegenState, ref: TopoRef, kind: "face" | "edge"):
  | { ok: true; shape: TopoDsShape; index: number }
  | { ok: false; reason: "missing-body" | "unknown-name" | "split-count-changed" };
```

Lookup in the owning body's `names.byName`. The split-count guard (§2.3) is enforced
structurally: a stale `;s{k}of{n}` mark simply doesn't exist in the fresh table when
the split count changed (the new names carry `of{n'}`), so it surfaces as
`unknown-name` — the resolver then inspects the table for same-prefix/different-`n`
entries purely to produce the more specific `split-count-changed` message. On any
failure the referencing feature gets `status: "error"` with the human-readable reason
and regen **continues** past it (spec §4.3/§7.8: downstream features that don't depend
on the failed one still build).

### 3.6 Document schema changes (core)

```ts
// document.ts — formatVersion 2
export interface TopoRef { bodyId: string; name: string; }

export type PlaneRef =
  | { kind: "origin"; plane: OriginPlaneName }
  | { kind: "face"; bodyId: string; name: string };   // was faceIndex

export interface FilletFeature { /* … */ edges: TopoRef[]; }   // was EdgeRef[]
export interface ChamferFeature { /* … */ edges: TopoRef[]; }
export interface ShellFeature   { /* … */ faces: TopoRef[]; }
```

`validateDocument` accepts v1 and v2; v1 triggers the upgrade regen (§2.4) inside the
worker (`upgradeDocumentRefs(doc): { doc: CraftbitDocument; failures: FeatureId[] }`),
after which the app persists v2. Saving always writes v2.

### 3.7 Picking & RPC surface

`TessellatedMesh` gains `faceNames: string[]` and `edgeNames: string[]` (index-aligned
with the existing `faceIds` / `edgeRanges` tables — the arrays already share explorer
order). The app's pick pipeline maps triangle → `faceIds[t]` → `faceNames[i]` and
stores **names** into new refs; indices remain a render/pick-session concern only and
never enter the document. String tables ride the existing structured-clone payload
(names are small relative to position buffers; no transferable needed).

### 3.8 UI: error + reattach (contract only; UI work tracked under §7.8)

A feature whose ref fails resolution shows `error` in the timeline with the resolver's
reason. **Reattach:** the dialog reopens in pick mode; the user picks a replacement
face/edge; the command overwrites the stale `TopoRef` with the picked name (a normal
undoable document command). No automatic rebinding of any kind.

## 4. Failure modes & recovery

| Failure | Detection | Behavior |
|---|---|---|
| Name not in table (upstream topology change) | resolver | Feature `error`, message names the missing ref, regen continues; reattach offered. |
| Split count changed | resolver (§3.5) | Feature `error` with specific message; reattach offered. |
| Split ordinal order flips under parameter edit (count unchanged) | not detectable — inherent to §2.3 | Mitigated: refs carrying split marks regenerate with `warning`; torture set T-B6/T-E8 measure how often this bites. |
| History returns nothing for a new subshape | namer step 6 | Orphan name `new(j)`, feature `warning`; still referenceable, flagged for kernel-rule improvement. |
| `IsDeleted` true but shape still referenced downstream | resolver (name retired) | Standard `error` + reattach. |
| Worker crash / restart (D1) | D1 protocol | No naming state survives nor needs to: regen from the document reproduces identical names (determinism test §6.1 is the guarantee). |
| v1→v2 upgrade meets an out-of-range index | upgrade regen | That feature enters `error` un-migrated; all others migrate; user resolves via reattach. Never guess. |
| Binding gap found by Phase-0 probe (a history method missing/broken in the WASM build) | Phase 0 | Per-op fallback is the orphan path (`new(j)` + `warning`) — shipped only with the gap documented here; if `Modified` itself is unusable for booleans, D2 implementation **blocks** on a kernel-build fix (§4.2 custom build) rather than shipping geometric matching. |

## 5. Migration & compatibility

- `CRAFTBIT_FORMAT_VERSION` → 2. Loader keeps reading v1 via upgrade regen (§2.4).
- Autosaved v1 IndexedDB documents upgrade on first open, then persist as v2.
- Undo history is session-scoped — no migration concerns.
- Feature reorder/suppress require **no name migration** by construction (§3.1 note 4):
  names mention feature ids and lineage only. Reorder changes *which* names exist after
  regen (geometry changes), never the spelling of surviving ones. Suppressing a feature
  retires the names it minted; dependents fail loudly until unsuppressed — matching
  §7.8's suppression semantics.

## 6. Test plan

### 6.1 Invariant tests (unit, run against the real kernel like the volume suite)

- **N-DET**: for each `FEATURE_TYPES` entry, build a document exercising it, regenerate
  twice in fresh worker instances → name tables byte-identical.
- **N-SER**: serialize → deserialize → regenerate → all refs resolve to the same
  face centroids as pre-serialization.
- **N-MIG**: a v1 fixture document upgrades to v2 with every ref resolving to the same
  centroid the index denoted; an out-of-range-index fixture yields exactly one `error`
  feature.
- **N-GRAMMAR**: every minted name parses under §3.1; parser round-trips.

### 6.2 Torture set (≥40 cases; each = build doc → assert → edit → regen → assert)

Extrude/revolve:
**T-E1** box: 6 face names stable across 2 regens. **T-E2** edit distance → identical names.
**T-E3** resize sketch rect → side names stable. **T-E4** add 2nd profile → old names
unchanged. **T-E5** symmetric extrude start/end distinct. **T-E6** direction reversed →
start stays on sketch-plane side. **T-E7** cut a through-hole → top face keeps name
(1→1 Modified), hole wall named from tool curve. **T-E8** slot cut splits top face →
`s0of2`/`s1of2` resolve; widen slot (count unchanged) → still resolve. **T-E9** join
overlapping extrudes → shared-region naming per boolean rules. **T-R1** full revolve side
face named from profile seg. **T-R2** partial revolve has start/end. **T-R3** edit angle
270→360 → refs to start/end fail loudly.

Fillet/chamfer:
**T-F1** fillet 1 edge → `gen(edge)` face; neighbors keep lineage. **T-F2** edit box size →
fillet follows (edge name resolves). **T-F3** *(spec's own case)* fillet an edge, then an
upstream cut splits its source face → fillet errors loudly, no silent pick. **T-F4**
3 edges at a corner → blend faces with split marks resolve. **T-F5** delete fillet →
downstream sketch-on-fillet-face errors. **T-F6** radius consumes adjacent face →
IsDeleted → dependent errors. **T-C1/T-C2** chamfer analogues of F1/F2.

Shell:
**T-S1** shell (remove top): offset faces via `mod`, rim faces via `gen(edge)` — or
documented orphan-warnings per Phase-0 findings. **T-S2** edit thickness → names stable.
**T-S3** shell after fillet → fillet face's inner twin resolvable.

Boolean:
**T-B1** cut: cavity walls carry tool lineage. **T-B2** fuse two bodies, fillet the seam
edge, move one body → seam edge re-resolves. **T-B3** intersect keeps both parents'
surviving names. **T-B4** tool exactly covers a target face → IsDeleted → dependent
errors. **T-B5** cut splits body into 2 lobes in one compound → names unique across
lobes. **T-B6** face split 3 ways; edit tool so it splits 2 ways → loud
`split-count-changed`.

Sketch-on-face chains:
**T-P1** box → sketch on top → extrude join → edit base height → stack follows.
**T-P2** sketch on planar face of a filleted body. **T-P3** upstream fillet consumes the
sketch's host face → sketch errors with reattach. **T-P4** sketch on a face that
survived a boolean.

Mirror/pattern/move/import:
**T-M1** linear pattern count 4→6 → existing `inst(k)` names untouched, new appended.
**T-M2** count 6→4 → ref to `inst(5)` fails loudly. **T-M3** circular pattern instance
face naming. **T-M4** mirror new-body → `inst(0,src)` names. **T-M5** mirror merge →
seam handled by boolean rules. **T-M6** fillet on instance 2, edit spacing → stable.
**T-V1** move body → every name identical before/after. **T-I1** STEP import → `imp(j)`
stable across regens. **T-I2** fillet an imported edge → survives document reload.

Timeline surgery:
**T-O1** suppress mid-timeline fillet → dependent errors; unsuppress → self-heals with
identical names. **T-O2** reorder chamfer before fillet → refs re-resolve or fail
loudly; zero silent rebinds (assert resolved centroids). **T-O3** delete a middle
feature → downstream errors only where dependent.

Serialization: **T-Z1** full round-trip (§6.1 N-SER as an e2e doc). **T-Z2** v1 file
migration end-to-end through the app load path.

Gate per spec §12: **M2 does not proceed until the full set passes.** Silent-rebind
assertions (comparing resolved-face centroids against expected, not just "resolved")
are mandatory in every torture case — resolution *succeeding on the wrong face* is the
bug class this design exists to kill.

### 6.3 Phase-0 binding probe (precondition, ~1 day)

A standalone vitest file (`naming-probe.test.ts`, committed, kept green) that asserts
against the real WASM build:

1. `BRepAlgoAPI_Cut` exposes callable `Modified`/`Generated`/`IsDeleted` returning an
   iterable `TopTools_ListOfShape` (probe: cut a box, ask `Modified(topFace)`).
2. `BRepPrimAPI_MakePrism` exposes `FirstShape`/`LastShape`/`Generated(profileEdge)`.
3. `BRepPrimAPI_MakeRevol` ditto (partial + full angle).
4. `BRepFilletAPI_MakeFillet.Generated(edge)` returns the fillet face.
5. `BRepOffsetAPI_MakeThickSolid` history coverage — record exactly which of
   Modified/Generated respond usefully; §3.4 shell row is finalized from this.
6. `TopTools_IndexedMapOfShape` + `IsSame` semantics across a `Transform` (validates
   the `move` explicit-identity rule).

## 7. Open questions

Per the gate rules these must be empty before implementation starts. All three are
closed mechanically by the Phase-0 probe (§6.3), which is the first commit of the
implementation PR chain:

1. Do the WASM bindings expose the history methods with usable signatures
   (list-by-reference returns)? *(Expected yes — classes are in the build's supported
   list and the full build binds all public methods; must be proven.)*
2. How complete is `MakeThickSolid` history in OCCT 7.4? *(Determines whether shell rim
   faces get `gen(edge)` names or ship as documented orphan-warnings.)*
3. Does `BRepPrimAPI_MakeRevol` report `FirstShape/LastShape` sanely for partial
   revolutions in this build? *(Fallback: cap faces via orphan path.)*
