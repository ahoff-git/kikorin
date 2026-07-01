## crates/patch — PatchBundle Generation & Serialization

### Purpose
Scans the ECS World's dirty entity list each tick and produces a `PatchBundle` — the single binary payload that crosses the WASM boundary per tick. Owns `PatchBundle` serialization (bincode) and deserialization.

### Boundaries
- **Owns:** `PatchBundle`, `RenderPatch`, `SemanticPatch`, `MetricsPatch`, `PatchGenerator::generate`, `serialize`, `deserialize`.
- **Must not:** mutate the ECS World, run physics, or touch netcode. Read-only access to `World` during `generate`.

### Inputs and Outputs
- **Inputs:** `&World` (reads `dirty_entities()`, component values), `Vec<NetPatch>` (from netcode drain), `MetricsPatch` (from engine timing).
- **Outputs:** `PatchBundle` (in-memory), `Vec<u8>` (bincode-serialized) from `PatchGenerator::serialize`.

### Invariants
- `MetricsPatch` is always present in every PatchBundle, even when `render`, `semantic`, and `net` are empty.
- `RenderPatch` is emitted only for entities with `DirtyFlags::TRANSFORM` set.
- `SemanticPatch` is emitted only for entities with `DirtyFlags::HEALTH` or `DirtyFlags::NET` set.
- `PatchGenerator` does not call `World::clear_dirty` — the caller (`crates/engine`) must clear dirty after serialization.

### Dependencies
- `ecs` crate (World, DirtyFlags, EntityId), `netcode` crate (NetPatch type), `bincode`, `serde`.

### Verification
- `cargo test -p patch` — three tests: `patch_bundle_roundtrips_through_bincode`, `generator_emits_render_patch_for_dirty_transform`, `generator_emits_semantic_patch_for_health_dirty`.

### Change Notes
- Initial implementation. `PatchBundle` is bincode-encoded (not JSON) for minimal WASM boundary size. `Engine::deserialize_patch` in `crates/engine` converts to a JS-friendly struct via `serde_wasm_bindgen`.
