## crates/patch — PatchBundle Generation

### Purpose
Scans the world's dirty entities each tick and produces the `PatchBundle` — the single payload that crosses the WASM boundary per tick. Owns the boundary payload schema: `RenderPatch`, `SemanticPatch`, `NetPatch`, `HitPatch`, `MetricsPatch`. Read-only over the ECS world; never mutates state, runs physics, or touches netcode.

### Inputs and Outputs
- **In:** `&World` (dirty entities + component values), `Vec<NetPatch>` and `Vec<HitPatch>` (supplied by the engine), `MetricsPatch` (engine timing).
- **Out:** `PatchBundle` in memory; `Vec<u8>` bincode from `serialize`. The engine converts the bundle to a JS object via `serde_wasm_bindgen` for the hot path; the bincode round-trip backs `Engine::deserialize_patch`.

### Boundary NetPatch
`NetPatch { peer_id, entity, kind, flags }` is deliberately thinner than netcode's wire events: `entity` is the **local mirror id** the engine created for the remote entity (so it lines up with render patches), `kind` is the lifecycle the game acts on — `EntitySpawned` / `EntityUpdated` / `EntityDespawned` (create/remove remote meshes), `PeerJoined` (data channel opened, before any entity data; `entity` is 0), and `PeerLeft` (disconnect/timeout; `entity` is 0) — and `flags` (present on spawn events) is the mirror's public net profile for mesh styling. Field-level wire detail stays inside `crates/netcode`; the engine maps between the two. This keeps `patch` and `netcode` independent.

### Emission Rules
- `RenderPatch` — emitted for entities with `DirtyFlags::TRANSFORM`.
- `SemanticPatch` — emitted for entities with `DirtyFlags::HEALTH` or `NET`.
- `LifecyclePatch` — engine-supplied (queued at spawn/destroy time, not derived from dirty flags): one `Spawned`/`Despawned` per local-entity creation/destruction, carrying the entity's net-flag profile for mesh styling. Terrain and remote mirrors are excluded (terrain returns from `load_map`; mirrors ride `NetPatch`). `HitPatch` is a pure UI/FX event — the engine already settled the consequences.
- `MetricsPatch` — always present, even when render/semantic/net are empty. Fields: `tick_ms`, `ai_ms`, `physics_ms`, `pathfinding_ms`, `net_ms`, `patch_ms`; `pathfinding_ms` is the A* share of `ai_ms`.

### Invariants
- `generate` does not call `World::clear_dirty`; the caller (engine) clears dirty after generation.
- `generate` receives `tick_ms`/`patch_ms` as zero; the engine stamps both into `bundle.metrics` after generation so consumers receive real values.
- **Consumption order**: a consumer must apply `lifecycle` and `net` (entity creation — `LifecycleKind::Spawned` / `NetEventKind::EntitySpawned`) before `render` (entity positioning) for entities that appear in the same bundle. A brand-new entity's first `RenderPatch` targets an object the consumer hasn't created yet; applying render first silently drops it, leaving the entity at whatever default position the consumer's renderer uses until its next `RenderPatch` — which may never come (e.g. a stationary remote mirror only updates on a `Delta`, and gets none while its owner doesn't move).

### Dependencies
`ecs` (World, DirtyFlags, EntityId), `bincode`. No sibling crate deps beyond `ecs`.

### Verification
`cargo test -p patch` — `patch_bundle_roundtrips_through_bincode`, `generator_emits_render_patch_for_dirty_transform`, `generator_emits_semantic_patch_for_health_dirty`.
