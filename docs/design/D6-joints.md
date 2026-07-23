# D6: Joint model & drag kinematics

Status: **implemented** (static placement; drag UI lands with M7) · Owner:
core + geometry-worker + app · Gate for M7 (spec §7.10, gate row D6)

The spec's assembly model positions parts with **joints**: pick a joint origin
on the moving part, pick one on the target, and the moving part snaps into
place with a defined set of remaining degrees of freedom (rigid, revolute,
slider, cylindrical). This doc fixes the joint math per type, how joint
origins are derived from picked topology, snap-point detection and priority,
the single-chain forward solve for viewport dragging, limits, grounding
semantics, TopoRef re-anchoring after regeneration, and failure/reattach
behavior.

**v1 scope shipped with this gate:** joints as *timeline features* performing
static closed-form placement (offset/angle as expressions), executed by the
regen engine with full topological-name preservation. The viewport **drag
solve is designed here (§6) but its interactive UI ships with M7's assembly
milestone**, together with components; until then a joint's placement is
edited through its dialog (offset/angle), which exercises the same math.
Craftbit's document model has bodies, not components, at the root (§3.6 v1
simplification) — joints therefore relate **bodies**.

## 1. Joint feature model (`packages/core/src/document.ts`)

```ts
export interface JointRef {
  bodyId: string;
  kind: "face" | "edge";
  name: string; // D2 topological name — same resolution rules as TopoRef
}

export interface JointFeature {
  id: string;
  type: "joint";
  name: string;
  suppressed: boolean;
  jointType: "rigid" | "revolute" | "slider" | "cylindrical";
  /** The body that moves into place. */
  movingRef: JointRef;
  /** The stationary side. Its body is NOT moved by this joint. */
  targetRef: JointRef;
  /** Offset along the joint z axis (mm expression). */
  offset: Expr;
  /** Rotation about the joint z axis (degrees expression). */
  angle: Expr;
  /** Flip the mate direction (moving z aligned with target z instead of anti-aligned). */
  flip: boolean;
  /** Optional motion limits, stored for the drag solve (§6); not enforced on the
   *  static placement, which is exact by construction. */
  limits?: { minOffset?: Expr; maxOffset?: Expr; minAngle?: Expr; maxAngle?: Expr };
}
```

Notes:
- `movingRef`/`targetRef` are D2 topological names, so joints re-anchor across
  upstream edits exactly like fillets and face sketches do (§7), and fail
  loudly ("re-pick") instead of grabbing the wrong face.
- `offset`/`angle` are expressions — `boltSpacing/2`, `15deg`-style parametric
  placement works out of the box.
- A joint is a **feature in the timeline**, executed in order like `move`.
  This is the v1 simplification that eliminates constraint networks: each
  joint repositions exactly one body when its turn comes.

## 2. Joint frames from topology

Every joint reduces to aligning two right-handed frames (origin, z, x). The
frame is derived from the picked entity at regen time — never stored — so it
tracks parameter edits upstream.

**Planar face** → mate frame:
- origin = face **centroid** (`BRepGProp.SurfaceProperties` centre of mass —
  not `gp_Pln.Location()`, which is an arbitrary point of the infinite plane);
- z = face outward normal (plane axis direction, reversed when the face is
  `TopAbs_REVERSED` — same convention `resolvePlane` already uses);
- x = the plane's `XDirection()` (deterministic for a given surface).

**Circular edge** → mate frame (probed: `BRepAdaptor_Curve.GetType()` =
`GeomAbs_Circle`, `.Circle().Location() / .Axis().Direction() / .Radius()`
all bind in opencascade.js 1.1.1):
- origin = circle center;
- z = circle axis direction;
- x = any deterministic perpendicular: we use the normalized projection of
  the world axis least aligned with z (same rule everywhere, so re-runs are
  reproducible).

Non-planar faces and non-circular edges are rejected with a readable error
("Pick a planar face or circular edge").

## 3. Placement math (all four types)

Let M = moving frame, T = target frame (both right-handed `gp_Ax3`). The
**effective target frame** T′ is built from T and the joint parameters:

- origin′ = T.origin + `offset` · T.z
- z′ = −T.z, or +T.z when `flip` — mating surfaces face each other by
  default, matching Fusion's behavior;
- x′ = T.x rotated by `angle` about T.z (then handed to `gp_Ax3_3(p, z′, x′)`,
  which re-orthonormalizes into a right-handed frame).

The placement transform is `gp_Trsf.SetDisplacement(M, T′)` — probed: it is
the rigid motion carrying geometry *from* frame M *onto* frame T′ (a point at
+1 along M.z lands at +1 along T′.z from T′.origin). Applied with
`BRepBuilderAPI_Transform_2(shape, trsf, false)`.

Per-type semantics — the *static placement is identical for all four types*
(that is what makes the closed form possible); the type determines which
parameters are user-meaningful and which DOFs remain for dragging (§6):

| Type        | placement uses      | free DOFs (drag)        |
|-------------|---------------------|-------------------------|
| rigid       | offset, angle       | none                    |
| revolute    | offset, **angle**   | rotation about z        |
| slider      | **offset**, angle   | translation along z     |
| cylindrical | **offset**, **angle** | rotation + translation |

For revolute/slider/cylindrical, dragging (once shipped) writes back into
`angle`/`offset` — the document stays the single source of truth and regen
reproduces the dragged pose exactly.

## 4. Execution & grounding semantics

`executeJoint` (worker regen):
1. Resolve both refs by topological name (§7). Either failure → feature error,
   body left where the previous features put it.
2. Build frames (§2), effective target (§3), transform the **moving body
   only**. Names carry over verbatim in explorer order (same probe-backed rule
   as `move`: transforms relocate without topology change).
3. Volume unchanged by construction; recomputed anyway as a cheap invariant.

**Grounding** is implicit and sequential: a body is grounded iff no joint
(or move) downstream selects it as the moving side. The first-created body
never needs marking — the user simply never picks it as `movingRef`. This
matches the spec's "first component auto-grounded" outcome without a flag,
and **loops cannot form**: each joint is one directed reposition executed in
timeline order. Two joints moving the same body simply execute in order (the
later one wins), covered by a timeline warning if both are active — this is
the v1 rendering of the spec's "first-joint-priority rule and a warning",
inverted to timeline order because our joints are features, not a network.

## 5. Snap points & creation UX

Joint creation is a two-pick dialog flow (same pattern as fillet/shell):
1. "Joint" toolbar tool → dialog opens armed for pick 1 (moving side);
2. user clicks a planar face or circular edge; pick is converted to a
   topological name immediately (stale-pick guard, as in D2 dialogs);
3. pick 2 (target side) — a pick on the same body is rejected;
4. choose type, offset/angle/flip → OK appends the feature, regen animates
   the body into place on the next frame.

Snap priority when a click is ambiguous (edge within pick tolerance of a
face): **circular edge > planar face** — edges give the more specific frame
(exact center + axis) and match Fusion's snap priority. Vertex and
edge-midpoint snap targets from the spec are deferred to M7's assembly UI
along with hover markers (AC 2); v1 accepts the two entity kinds that define
complete frames on their own.

## 6. Drag kinematics (designed now, UI ships with M7)

Dragging a jointed body moves it inside its joint's free DOFs:

- **Chain extraction:** starting at the dragged body, follow joints where it
  is the moving side; the chain is the ordered list of joints from the last
  grounded ancestor. In v1's sequential model, a body's pose is determined by
  *its* joint alone, so the chain always has length 1 — the general chain
  walk is specified for when components/nested joints arrive.
- **Forward solve (single chain):** project the pointer ray onto the joint's
  free coordinate: for revolute, intersect with the plane through T′.origin
  normal to z and take `atan2` against x′ → candidate angle; for slider,
  project onto the z line → candidate offset; cylindrical does both. Clamp to
  `limits` (min/max angle/offset). Write the clamped value into the feature's
  `angle`/`offset` and re-run the placement transform on the render-thread
  proxy (no kernel round-trip — a `gp_Trsf` equivalent computed in JS moves
  the Three.js mesh; the worker regen confirms on drag end).
- **Loops:** impossible in the v1 feature model (each joint moves one body,
  later features win). When a network model arrives (v2), loops resolve by
  first-joint priority with a warning, per spec.
- **Limits** are stored on the feature now (§1) so documents created in v1
  carry them into the M7 drag UI unchanged.

## 7. Re-anchoring, failure, reattach

Joints inherit D2's machinery wholesale:
- Refs resolve by lineage name every regen; upstream edits that reorder OCCT's
  enumeration don't detach joints.
- A name that no longer resolves (`unknown-name` / `split-count-changed`)
  fails **loudly**: the joint feature errors with the D2 "re-pick" message,
  downstream features continue with the body un-jointed (it stays where
  earlier features put it — deterministic, visible, no geometric guessing).
- Reattach = edit the joint in its dialog and re-pick the broken side; the
  dialog pre-fills everything else.

## 8. Testing

- **Kernel tests (vitest, real OCCT):** exact closed-form pose assertions —
  e.g. rigid-join a 10-cube's face to a 20-cube's face with offset 5 →
  centroid at the predicted point to 1e-7; revolute on circular edges →
  cylinder axis coincident with target hole axis, angle parameter rotates a
  marker feature to the predicted quadrant; flip flips; expression offsets
  re-evaluate on parameter edit; broken ref errors with re-pick message and
  leaves the body in place.
- **E2E (Playwright):** build two bodies, create a joint through the dialog,
  assert the timeline chip appears and the body volume/position meta updates;
  reload persistence.
