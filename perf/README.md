# Performance Harness

Tracks the budgets defined in spec §8 (`docs/SPEC.md`). This is the **M0 skeleton**:
one working script (frame-rate under viewport interaction) proving the harness
shape. Milestone 1 expands this into the full suite run on every PR (kernel-ready
time, regen latency, sketch drag-solve fps, export timings, memory ceiling) with
CI regression alerts at +10% per spec §8.

## Running

```sh
# 1. Start the app (dev or preview build) in another terminal:
pnpm --filter @craftbit/app dev
# or: pnpm --filter @craftbit/app build && pnpm --filter @craftbit/app preview

# 2. Run a measurement against it:
node perf/measure-fps.mjs http://localhost:5173/
```

Set `PLAYWRIGHT_EXECUTABLE_PATH` to point at a pre-installed Chromium (e.g. in a
sandboxed CI runner) to skip Playwright's own browser download.

## Budgets (spec §8, reference machine)

| Metric | Budget |
|---|---|
| Orbit/pan/zoom | 60 fps @ 500k tris / 50 bodies |
| Sketch drag solve | ≥ 30 fps @ 150 entities/200 constraints |
| Kernel ready (cold, 20 Mbps) | < 15 s; < 3 s warm (SW cache) |
| Single-feature regen | < 200 ms median, < 1 s p95 |

`measure-fps.mjs` currently checks only the first row, against the M0 hardcoded
box (far below the 500k-tri budget target) — a real perf gate needs the fixture
corpus from later milestones to generate a representative scene.
