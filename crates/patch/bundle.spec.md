## crates/patch — PatchBundle Generation

### Purpose
Scans the world's dirty entities each tick and produces the `PatchBundle` — the single binary payload that crosses the WASM boundary per tick. Read-only over the ECS world; never mutates state, runs physics, or touches netcode.

### Inputs and Outputs
- **In:** `&World` (dirty entities + component values), `Vec<NetPatch>` (from netcode drain), `MetricsPatch` (engine timing).
- **Out:** `PatchBundle` in memory; `Vec<u8>` bincode from `serialize`. Bincode (not JSON) keeps the boundary payload minimal; `Engine::deserialize_patch` converts back to a JS struct.

### Emission Rules
- `RenderPatch` — emitted for entities with `DirtyFlags::TRANSFORM`.
- `SemanticPatch` — emitted for entities with `DirtyFlags::HEALTH` or `NET`.
- `MetricsPatch` — always present, even when render/semantic/net are empty.

### Invariants
- `generate` does not call `World::clear_dirty`; the caller (engine) clears dirty after serialization.

### Dependencies
`ecs` (World, DirtyFlags, EntityId), `netcode` (NetPatch), `bincode`, `serde`.

### Verification
`cargo test -p patch` — `patch_bundle_roundtrips_through_bincode`, `generator_emits_render_patch_for_dirty_transform`, `generator_emits_semantic_patch_for_health_dirty`.
