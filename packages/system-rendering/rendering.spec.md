## packages/system-rendering — Three.js Render Bridge

### Purpose
Manages the Three.js scene lifecycle and a per-entity `Object3D` registry. Receives render patches from the Rust WASM engine (via `renderChannel`) and applies them to scene objects. Provides camera control helpers and a per-frame draw call.

### Boundaries
- **Owns:** Three.js scene/camera/renderer lifecycle (`setupRenderer`, `disposeRenderer`), `Object3D` registry keyed by entity ID (`upsertObjectByEid`, `removeObjectByEid`, `applyToObjectByEid`, `setObjectTransformByEid`, `setObjectTouchingByEid`), `subscribeToRenderChannel` (wires `renderChannel` to the registry), `renderFrame` (drives `renderer.render`), `setCameraPosition`, `lookCameraAt`, `getActiveCamera`.
- **Must not:** own ECS component data, drive physics or game simulation, or import from `@kikorin/ecs` or `@kikorin/engine`.

### Inputs and Outputs
- **Inputs:** `renderChannel` snapshots (`RenderPatch[]` from `@kikorin/adapter`) — position/rotation per entity each tick.
- **Outputs:** Updated `Object3D.position` / `Object3D.rotation` for each patched entity; `renderer.render(scene, camera)` on each `renderFrame()` call.
- **Camera API:** `setCameraPosition(x, y, z)`, `lookCameraAt(x, y, z)`, `getActiveCamera() → Camera | null`.

### Invariants
- `subscribeToRenderChannel` must be called after `setupRenderer` and its returned unsubscribe called on dispose.
- `removeObjectByEid(eid, { dispose: true })` releases Three.js geometry/material memory; omitting `dispose` only removes from the scene and registry.
- Camera operations are no-ops before `setupRenderer` is called.
- The `Object3D` registry is keyed by numeric entity ID. Eids must be unique per live entity.

### Dependencies
- `three` (Three.js)
- `@kikorin/adapter` (`renderChannel`, `RenderPatch`)

### Verification
- `pnpm --filter @kikorin/system-rendering test` — `render.test.ts` (export smoke tests, `removeObjectByEid` / `applyToObjectByEid` unknown-eid returns), `dirtyTransforms.test.ts` (subscription smoke test).

### Change Notes
- Removed `@kikorin/ecs` dependency and ECS-driven `dirtyTransformsSystem`. Transform updates now driven by `renderChannel` patches from the Rust WASM engine.
- `renderSystem` renamed to `renderFrame` to better describe its role as a single-frame draw call.
- `dirtyTransforms.test.ts` replaced: old test covered the removed `dirtyTransformsSystem`; new test verifies `subscribeToRenderChannel` returns an unsubscribe function.
- `removeObjectByEid` now accepts `{ dispose?: boolean }` second arg for geometry/material cleanup.
