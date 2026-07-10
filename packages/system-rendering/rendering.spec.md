## packages/system-rendering — Three.js Render Bridge

### Purpose
Owns the Three.js scene/camera/renderer lifecycle and a per-entity `Object3D` registry keyed by entity ID. Applies render patches from the Rust engine to scene objects and drives per-frame draws. Owns no simulation state; consumes only `@kikorin/adapter` channels.

### Inputs and Outputs
- **In:** `renderChannel` snapshots (`RenderPatch[]` from `@kikorin/adapter`) — position/rotation per entity per tick.
- **Out:** updated `Object3D` transforms; `renderer.render(scene, camera)` per `renderFrame()`.
- **API surface:** `setupRenderer` / `disposeRenderer`; registry ops (`upsertObjectByEid`, `removeObjectByEid`, `applyToObjectByEid`, `setObjectTransformByEid`); `subscribeToRenderChannel`; `renderFrame`; `getRenderMetrics` (EMA of `renderFrame` duration as `frame_ms` — the rendering-pipeline slice of the cross-layer metrics contract; currently no standing consumer); camera helpers (`setActiveCamera`, `getActiveCamera`, `setCameraPosition`, `lookCameraAt`).

### Invariants
- `subscribeToRenderChannel` runs after `setupRenderer`; call its returned unsubscribe on dispose.
- `removeObjectByEid(eid, { dispose: true })` frees geometry/material; without `dispose` it only detaches from scene + registry.
- Camera operations are no-ops before `setupRenderer`.
- Registry keys are unique numeric entity IDs.

### Dependencies
`three`, `@kikorin/adapter` (`renderChannel`, `RenderPatch`).

### Verification
`pnpm --filter @kikorin/system-rendering test` — export smoke tests, unknown-eid returns for `removeObjectByEid` / `setObjectTransformByEid` / `applyToObjectByEid`, and that `subscribeToRenderChannel` returns an unsubscribe function (unsubscribe behavior itself is not exercised — the channel is mocked).
