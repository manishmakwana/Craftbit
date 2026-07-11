# D7: ViewCube navigation widget

Status: **planned** · Owner: viewport · Depends on: nothing new (pure app-side feature)

A Fusion 360-style ViewCube in the top-right corner of the viewport: a small,
always-visible 3D cube whose orientation mirrors the camera. Clicking a face,
edge, or corner of the cube animates the camera to that orientation; dragging
the cube orbits the view; a Home button restores the default isometric view.
This is the primary "how do I get back to a sensible view?" affordance for new
users and the fastest way to reach exact orthographic views for experienced
ones.

## 1. Fusion 360 behavior we replicate (v1 scope)

| Behavior | In scope |
| --- | --- |
| Cube tracks main camera orientation in real time | ✅ |
| 6 labeled faces (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM) → orthographic-style face-on views | ✅ |
| 12 edges → 45° two-axis views | ✅ |
| 8 corners → isometric three-axis views | ✅ |
| Hover highlight of the zone under the cursor | ✅ |
| Smooth animated transition (~350 ms, eased slerp) | ✅ |
| Drag the cube to orbit the camera | ✅ |
| Home button (default iso view + fit) | ✅ |
| In-plane roll arrows / 90° rotate arrows when face-on | ❌ later |
| Perspective↔ortho projection toggle in cube context menu | ❌ later |
| "Set current view as Front" re-mapping | ❌ later |

Craftbit is Z-up (`camera.up = (0,0,1)`, grid on XY). Fusion's cube is Y-up;
our label mapping is: TOP = +Z, BOTTOM = −Z, FRONT = −Y, BACK = +Y,
RIGHT = +X, LEFT = −X. (FRONT = −Y matches the default camera which looks
from −Y toward the model.)

## 2. Architecture

Two new modules, both under `packages/app/src/viewport/`:

```
viewport/
  viewCube.ts        ← framework-free: cube scene, picking, orientation math
  sceneManager.ts    ← + inset render pass, animated `orientTo()`, home view
  Viewport.tsx       ← + pointer routing into the cube region
```

### 2.1 Rendering: inset pass, same WebGL context

Do **not** create a second renderer/canvas (a second WebGL context costs
memory and breaks on some mobile GPUs). Render the cube as a second pass of
the existing renderer using scissor + viewport, inside the existing
`SceneManager` render loop:

```ts
// in the render loop, after the main scene render:
renderer.clearDepth();
renderer.setScissorTest(true);
renderer.setViewport(w - SIZE - PAD, h - SIZE - PAD, SIZE, SIZE);
renderer.setScissor(w - SIZE - PAD, h - SIZE - PAD, SIZE, SIZE);
renderer.render(cubeScene, cubeCamera);
renderer.setScissorTest(false);
renderer.setViewport(0, 0, w, h);
```

`SIZE = 96` CSS px (scaled by `devicePixelRatio` via renderer), `PAD = 12`.
The cube camera is a small perspective camera at fixed distance whose
**orientation copies the main camera every frame**:

```ts
cubeCamera.position.copy(mainCamera.position).sub(controls.target).normalize().multiplyScalar(3);
cubeCamera.up.copy(mainCamera.up);
cubeCamera.lookAt(0, 0, 0);
```

This keeps the cube in sync during orbit with zero extra bookkeeping.

### 2.2 Cube geometry and labels (`viewCube.ts`)

- One `THREE.BoxGeometry(1.4, 1.4, 1.4)` mesh with 6 materials. Each face
  texture is generated once at startup on an offscreen `<canvas>` (256×256):
  panel background from `--bg-raised`, label text from `--text-primary`,
  hairline border from `--border-hairline`, so the cube follows the app
  theme. No image assets, no async loads.
- Beveled look is cosmetic only — skip real bevels in v1; the flat cube with
  border strokes reads fine at 96 px.
- A thin `THREE.LineSegments` wireframe on top for crisp silhouette edges.
- Lighting: single `HemisphereLight` in the cube scene (labels are unlit
  `MeshBasicMaterial`, so lighting is optional — prefer unlit for legibility).

### 2.3 The 26 hit zones without 26 meshes

Raycast against the single cube mesh, then classify the hit **point** into
face/edge/corner by how many of its local coordinates are near the cube's
half-extent `h = 0.7`:

```ts
const t = 0.42;                       // zone threshold (~30% of face is "pure face")
const sx = Math.abs(p.x) > t ? Math.sign(p.x) : 0;   // same for sy, sz
const axes = |sx| + |sy| + |sz|;      // 1 = face, 2 = edge, 3 = corner
```

The `(sx, sy, sz)` triple **is** the view direction key — all 26 zones map
directly to a camera direction `dir = normalize(sx, sy, sz)` with no lookup
table for directions. Only the up-vector needs rules (§2.4).

Hover highlight: a translucent quad/patch is positioned on the cube surface
under the classified zone (one reusable `MeshBasicMaterial` with
`--accent-muted`, `depthTest: false`). Re-picked on pointermove; hidden on
leave.

### 2.4 Orientation math

`orientTo(dir: Vector3)` on `SceneManager`, used by the cube and reusable by
future named-view commands:

- `target` stays where it is (`controls.target`), `distance` stays the
  current camera distance — clicking the cube never zooms or re-centers
  (matches Fusion).
- New camera position = `target + dir * distance`.
- **Up vector rules** (Z-up world):
  - If `|dir.z| < 0.99` (any view except TOP/BOTTOM): `up = +Z`.
  - TOP (`dir = +Z`): `up = +Y`; BOTTOM (`dir = −Z`): `up = −Y`.
    (So "TOP" reads with BACK away from you, same convention as Fusion.)
- **Animation**: slerp between quaternions is wrong here because
  OrbitControls owns the camera; instead animate the *position on the sphere*
  and the up vector: spherical-interpolate `startDir → endDir` (slerp the two
  unit vectors via quaternion between them), lerp `up`, renormalize, call
  `controls.update()` per frame. 350 ms, `easeInOutCubic`, driven inside the
  existing RAF loop (a `pendingOrientation` field; no new loop).
  Degenerate case `startDir ≈ −endDir` (180° flip): pick the rotation axis as
  the current up vector so the flip goes over the top, not sideways.
- During animation, user input wins: any pointerdown on the main viewport
  cancels the animation (`pendingOrientation = null`).

### 2.5 Drag-to-orbit on the cube

Pointer-drag that starts inside the cube rect orbits the main camera. Don't
re-implement orbiting: forward the drag to `OrbitControls` by calling its
internal rotate via public API — simplest robust route is to keep a small
custom handler that applies `controls`-equivalent spherical deltas:

```ts
// dx, dy in px over the cube rect
sphericalFromCamera(); theta -= dx * 0.02; phi -= dy * 0.02; applyToCamera();
```

(≈ 5 lines with `THREE.Spherical`; avoids depending on OrbitControls
internals.) A click is a drag under 4 px / 200 ms — same disambiguation the
sketch tools already use implicitly via click vs drag.

### 2.6 Home button

A small house icon (HTML overlay button, not part of the WebGL pass) at the
cube's top-left corner: restores the **default view** = initial camera
direction `normalize(140, −180, 120 − 0)` relative to target, `up = +Z`, then
`fitAll()`. Rendered by `Viewport.tsx` (`data-testid="viewcube-home"`), so it
needs no picking code.

## 3. Event routing (the only tricky integration)

`Viewport.tsx` owns pointer events on the container. The cube region must win
over model picking and sketch drawing:

1. Compute `inCubeRect(e)` from the container's bounding rect (top-right
   `SIZE+PAD` square). Add a helper on `SceneManager` so the rect stays in one
   place.
2. `onPointerDown`: if `inCubeRect`, delegate to `viewCube.onPointerDown` and
   **return before** sketch-draw / selection logic. Capture the pointer so
   drags that leave the rect keep orbiting.
3. `onPointerMove`: if a cube drag is active → orbit; else if `inCubeRect` →
   update hover highlight and show `cursor: pointer`; else clear cube hover
   and fall through to existing logic.
4. `onPointerUp`: if cube-click (not drag) → classify zone → `orientTo()`.
5. Sketch mode: the cube stays active (matches Fusion — you can rotate out of
   a sketch's face-on view; `lookAtPlane` is only an initial framing). No
   special-casing needed beyond the routing above; `resetCameraUp()` on
   sketch exit already restores Z-up, and `orientTo` sets up explicitly
   anyway.

Alternative considered and rejected: making the cube an HTML/CSS 3D transform
overlay (like some web CAD apps). Rejected because we already have a WebGL
scene + raycaster, CSS 3D picking of edges/corners is fiddly, and the inset
pass is ~40 lines.

## 4. Implementation steps

| # | Step | Touches | Est. |
| --- | --- | --- | --- |
| 1 | `viewCube.ts`: cube scene, canvas label textures, wireframe, zone classifier (`classifyHit`), pure `dirForZone`/`upForDir` helpers | new file | 0.5 d |
| 2 | `SceneManager`: inset render pass, per-frame cube-camera sync, `orientTo()` with eased animation + cancel, `homeView()`, `getViewCubeRect()` | sceneManager.ts | 0.5 d |
| 3 | `Viewport.tsx`: pointer routing (down/move/up), hover cursor, Home button overlay | Viewport.tsx, styles.css | 0.5 d |
| 4 | Unit tests for the pure math: `classifyHit` (26 zones + threshold edges), `upForDir` rules, 180°-flip axis choice | new test in app or core-style pure module | 0.25 d |
| 5 | Playwright E2E (`viewcube.mjs`): see §5 | scratch/E2E | 0.5 d |
| 6 | Polish pass: hover highlight colors vs theme, cube size on small screens (hide below 480 px viewport width), docs/README feature list | misc | 0.25 d |

Total ≈ 2.5 days of focused work; steps 1–3 land the usable feature.

Keep `viewCube.ts` free of React and of `SceneManager` imports (pass in
`renderer`/`camera` interfaces) so the zone math and orientation rules are
unit-testable in Node without WebGL.

## 5. Acceptance criteria / E2E script

Playwright, same harness as `gp1.mjs`/`dims.mjs`:

1. Draw a rect on XY, extrude 5 mm (existing helpers) → body visible.
2. Click the cube's TOP zone (cube rect center is a known offset from the
   viewport's top-right corner; TOP zone = center of the cube when viewing
   from default iso? — instead expose `data-view` on a debug attribute:
   `SceneManager` sets `container.dataset.viewDir = "x,y,z"` on animation
   end, so the test asserts the exact direction rather than screenshots).
   Assert `viewDir ≈ (0,0,1)` after animation settles.
3. Click FRONT zone → `viewDir ≈ (0,−1,0)`; screenshot shows the extrusion
   edge-on (pixel check optional; direction assert is primary).
4. Drag on the cube by 60 px → `viewDir` changed by a nontrivial angle and no
   sketch/selection side effects occurred.
5. Click Home (`viewcube-home`) → direction back to default iso and the body
   fully in frame.
6. Enter sketch mode and confirm cube clicks still reorient (labels overlay
   unaffected), Esc/finish still works.
7. Zero console errors; `RESULT: PASS`.

Also verify by hand: hover highlight tracks zones; cube never intercepts
clicks outside its 108 px corner square; devicePixelRatio > 1 renders crisp
labels.

## 6. Risks & mitigations

- **OrbitControls fighting the animation** — `controls.update()` re-derives
  from camera position each frame and damping can drag the camera mid-slerp.
  Mitigation: disable damping (`controls.enableDamping = false`) for the
  duration of the animation, restore after; cancel on user pointerdown.
- **Up-vector discontinuity at TOP/BOTTOM** — flipping `up` mid-animation
  causes a visible lurch. Mitigation: lerp the up vector across the same
  eased timeline (it stays valid because we renormalize and it never passes
  through zero for our rule set).
- **Sketch-mode camera.up** — sketch mode sets `camera.up = plane.ydir`;
  a cube click while sketching must override to the §2.4 rules (it does, by
  construction) and `resetCameraUp()` on exit remains correct.
- **Scissor pass vs `projectToScreen` overlays** — dimension labels project
  using full-viewport dimensions; the inset pass doesn't change
  `this.width/height`, so no interaction. Assert via dims E2E re-run.
- **Small viewports / touch** — 96 px cube on a phone occludes content and is
  hard to hit. v1: hide below 480 px container width (CSS-driven flag checked
  in resize()); touch drag support comes free via pointer events.

## 7. Out of scope (tracked for later)

Roll arrows and 90° in-plane rotation when face-on; ortho projection toggle;
context menu ("Look at", "Set as Front"); named view bookmarks; compass ring
under the cube. None of these change the architecture above — they attach to
`viewCube.ts` zones and `orientTo()`.
