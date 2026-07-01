## crates/engine — Rust Engine Orchestrator (WASM Entry Point)

### Purpose
Assembles ECS, physics, netcode, and patch generation into the single `#[wasm_bindgen]` `Engine` type. This is the only Rust artifact JavaScript sees. Owns the per-tick orchestration sequence and the WASM-bindgen public API.

### Boundaries
- **Owns:** `Engine` struct, wasm-bindgen exports (`tick`, `apply_input`, `deserialize_patch`, `get_metrics`, `set_log_level`, `spawn_entity`, `destroy_entity`, `init_networking`), per-tick sequencing, `EntityBlueprint` decode, JS-serializable mirror types (`JsPatch`, `JsRender`, `JsSemantic`, `JsMetrics`).
- **Must not:** contain game-specific logic (maps, rules, units). Must not bypass the `PatchBundle` boundary — no per-entity getter calls in the hot path.

### Inputs and Outputs
```
tick(dt_ms: f64) → Vec<u8>              // bincode PatchBundle; clears dirty flags each call
apply_input(payload: &[u8]) → void      // apply inbound peer delta or input event
deserialize_patch(bytes: &[u8]) → JsValue  // static; converts bincode → JS object
get_metrics() → JsValue                 // JSON metrics from last tick
set_log_level(level: u8) → void         // 0=off…4=debug; no-op on non-WASM targets
spawn_entity(payload: &[u8]) → u32      // decode EntityBlueprint, return new ID
destroy_entity(id: u32) → void
spawn_box_entity(x,y,z,hw,hh,hd,health,net_flags) → u32  // dynamic box entity
spawn_floor_entity(x,y,z,hw,hh,hd) → u32                 // static floor/terrain entity
spawn_bullet(x,y,z,vx,vy,vz) → u32                       // NET_BULLET entity — no Rapier body
init_networking(session_id, signaling_url) → void  // WASM only
```

### NET Flags
- `NET_LOCAL (0x01)`: Rapier dynamic body, HEALTH patches, networking outbound. Used for player and monster entities.
- `NET_BULLET (0x02)`: No Rapier body, no HEALTH patches, no networking outbound. Position integrated by the engine each tick; only TRANSFORM render patches emitted. TypeScript owns lifetime and hit detection.

### Per-tick Sequence
1. Drain inbound peer messages → apply to World, collect NetPatches
2. `PhysicsWorld::sync_from_world` → `step(dt_secs)` → `sync_to_world`
2.5. Bullet update: for each entity with `NET_BULLET` set, integrate ballistic trajectory (`vy -= 20.0 * dt`), update position, mark TRANSFORM dirty. Bypasses Rapier entirely.
3. Mark locally-owned entities (NET_LOCAL bit set) dirty with TRANSFORM
4. Flush outbound deltas to all peers via `PeerSession`
5. `PatchGenerator::generate` → `serialize` → return bytes; `clear_dirty`; `advance_tick`

### Invariants
- `World::clear_dirty` is called once per tick, after serialization.
- `MetricsPatch` is always included in the returned `PatchBundle`.
- Log calls are `log::debug!` gated; default level is `Warn` in WASM (`console_log`).

### Dependencies
- `ecs`, `physics`, `netcode`, `patch` crates. `wasm-bindgen`, `serde-wasm-bindgen`, `console_log`, `console_error_panic_hook` (WASM), `bincode`.

### Verification
- `cargo build --target wasm32-unknown-unknown --release` exits 0.
- `wasm-pack build --target bundler` in `crates/engine/` produces `pkg/` with correct `@kikorin/engine-wasm` package name (patched post-build).

### Change Notes
- Initial implementation. `Timer` abstraction handles `std::time::Instant` (native tests) vs `js_sys::Date::now()` (WASM) for sub-millisecond timing.
- `destroy_entity` now calls `physics.remove_entity(id)` in addition to `world.destroy_entity(id)`. Previously only the ECS entity was cleared; the Rapier rigid body persisted, continued simulating, generated phantom render patches for the destroyed entity's ID, and could physically collide with live entities. This caused visible desync whenever bullets or monsters were destroyed.

**Contract change:** callers of `destroy_entity` now get immediate physics cleanup. The old body will no longer appear in `sync_to_world` output or generate render patches after the call.
- Gravity raised from 9.81 to 20.0 m/s² (Rapier world and bullet integrator). Jump velocities scaled proportionally (JUMP_VEL 8→12, MONSTER_JUMP_SPEED 9→13) to preserve similar peak jump height.
- Added `spawn_bullet` and `NET_BULLET (0x02)` flag. Bullet entities have no Rapier body — zero broadphase cost per bullet. The engine integrates their ballistic arc in step 2.5 and marks TRANSFORM dirty each tick. TypeScript reads positions via `applyToObjectByEid` (render patch pipeline) and calls `destroy_entity` for lifetime expiry and hit detection. `physics.remove_entity` is a no-op for bullet entities (no entry in `entity_to_rb`) — safe to call.
- Bullets now bounce off terrain using `PhysicsWorld::cast_ray_with_normal`. Each tick the bullet's travel vector is ray-cast against fixed colliders only (dynamic entities excluded — monsters are handled by TypeScript hit detection). On hit: velocity is reflected (`v' = v - 2(v·n)n`) and the bullet is nudged 0.02 units off the surface to prevent re-intersection. No Rapier body is created; ray casting uses the existing `query_pipeline` BVH — O(log n) per bullet per tick.
