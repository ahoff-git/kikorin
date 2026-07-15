## packages/system-rendering — Three.js Render Bridge

### Purpose
Owns the Three.js scene/camera/renderer lifecycle and a per-entity `Object3D` registry keyed by entity ID. Applies render patches from the Rust engine to scene objects and drives per-frame draws. Owns no simulation state; consumes only `@kikorin/adapter` channels.

### Render Mode — a construction-time setup parameter
`setupRenderer(canvas, mode?: "2d" | "3d")` picks the camera/lighting rig once, at setup — there is no runtime switch (mirrors `crates/physics`'s `Dimension`; the two are independent knobs a game picks together, not coupled at the type level). Default (or omitted) is `"3d"`, identical to the original behavior. `getRenderMode()` reports which one is active.

- **`"3d"`**: `PerspectiveCamera`, sky-color background, a directional "sun" light with shadow mapping (frustum/texel-snapping as before).
- **`"2d"`**: `OrthographicCamera` (frustum height fixed by `ORTHO_VIEW_HEIGHT`, width follows the aspect ratio), same sky-color background, flat ambient-only lighting — no directional light, no shadow map (`renderer.shadowMap.enabled = false`). Dynamic shadows rarely make sense for a 2D scene, and skipping the rig avoids its overhead entirely.

This package never constructs meshes (`BoxGeometry`, `Mesh`, materials all live in the consuming app) — geometry choice is entirely up to the caller in both modes. A 2D game supplies its own flat/sprite-style geometry to `upsertObjectByEid` the same way a 3D game supplies boxes; this package only manages the generic `Object3D` registry and doesn't need to know shape types.

`getActiveCamera()`/`setActiveCamera()` are typed against three's base `Camera` class (not `PerspectiveCamera` specifically) so the same camera-control helpers (`setCameraPosition`, `lookCameraAt`) work unchanged against either camera kind — both only touch `Object3D`-level position/lookAt, never anything perspective-specific.

### Inputs and Outputs
- **In:** `renderChannel` snapshots (`RenderPatch[]` from `@kikorin/adapter`) — position/rotation per entity per tick.
- **Out:** updated `Object3D` transforms; `renderer.render(scene, camera)` per `renderFrame()`.
- **API surface:** `setupRenderer` / `disposeRenderer`; `getRenderMode`; registry ops (`upsertObjectByEid`, `removeObjectByEid`, `applyToObjectByEid`, `setObjectTransformByEid`); `subscribeToRenderChannel`; `renderFrame`; `getRenderMetrics` (EMA of `renderFrame` duration as `frame_ms` — the rendering-pipeline slice of the cross-layer metrics contract; currently no standing consumer); camera helpers (`setActiveCamera`, `getActiveCamera`, `setCameraPosition`, `lookCameraAt`).

### Invariants
- `subscribeToRenderChannel` runs after `setupRenderer`; call its returned unsubscribe on dispose.
- `removeObjectByEid(eid, { dispose: true })` frees geometry/material; without `dispose` it only detaches from scene + registry.
- Camera operations are no-ops before `setupRenderer`.
- Registry keys are unique numeric entity IDs.
- `disposeRenderer` resets the render mode back to `"3d"` along with the rest of the render state — a subsequent `setupRenderer` call always explicitly re-specifies its mode regardless, but nothing reads the reset value in between.

### Dependencies
`three`, `@kikorin/adapter` (`renderChannel`, `RenderPatch`).

### Verification
`pnpm --filter @kikorin/system-rendering test` — export smoke tests, unknown-eid returns for `removeObjectByEid` / `setObjectTransformByEid` / `applyToObjectByEid`, that `subscribeToRenderChannel` returns an unsubscribe function (unsubscribe behavior itself is not exercised — the channel is mocked), `getRenderMode` defaulting to `"3d"`, and the two-argument `setupRenderer(canvas, mode)` call shape. There is no real `WebGLRenderer`/canvas in this suite (plain Node test environment, no jsdom) — camera/lighting setup for either mode is exercised only by type-checking and the no-canvas early-return path, not a live GL context; manual verification in a browser is how the actual visual output (ortho framing, flat 2D lighting) gets confirmed.
