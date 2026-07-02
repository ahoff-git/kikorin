## crates/engine — Rust Engine Orchestrator (WASM Entry Point)

### Purpose
Assembles ECS, physics, netcode, patch generation, monster AI, and bullet hit detection into the single `#[wasm_bindgen]` `Engine` type. This is the only Rust artifact JavaScript sees. Owns the per-tick orchestration sequence and the WASM-bindgen public API.

### Boundaries
- **Owns:** `Engine` struct, wasm-bindgen exports, per-tick sequencing, monster AI state machine (`MonsterState`), monster separation, bullet hit detection, `EntityBlueprint` decode, JS-serializable mirror types (`JsPatch`, `JsRender`, `JsSemantic`, `JsHit`, `JsMetrics`).
- **Must not:** contain rendering logic (Three.js), input handling, or React UI state. Must not bypass the `PatchBundle` boundary — no per-entity getter calls in the hot path outside tick methods.

### Inputs and Outputs
```
tick(dt_ms: f64) → JsValue (JsPatch)    // PatchBundle as JS object; clears dirty flags each call
apply_input(payload: &[u8]) → void      // apply inbound peer delta or input event
deserialize_patch(bytes: &[u8]) → JsValue  // static; converts bincode → JS object
get_metrics() → JsValue                 // JSON metrics from last tick
set_log_level(level: u8) → void
spawn_entity(payload: &[u8]) → u32      // decode EntityBlueprint, return new ID
destroy_entity(id: u32) → void
spawn_box_entity(x,y,z,hw,hh,hd,health,net_flags) → u32  // dynamic box entity
spawn_floor_entity(x,y,z,hw,hh,hd) → u32                 // static floor/terrain entity
spawn_bullet(x,y,z,vx,vy,vz) → u32                       // NET_BULLET entity — no Rapier body
update_monster_goal(gx, gz) → void      // set pathfinding target; call once per frame
find_path(startX,startY,startZ,goalX,goalZ,canJump) → JsValue  // manual A* query (optional)
init_networking(session_id, signaling_url) → void  // WASM only
```

### NET Flags
- `NET_LOCAL (0x01)`: Rapier dynamic body, HEALTH patches, networking outbound.
- `NET_BULLET (0x02)`: No Rapier body, no HEALTH patches. Position integrated by the engine each tick; only TRANSFORM render patches emitted.
- `NET_MONSTER (0x04)`: Monster entity flag. Engine owns AI (path following, stuck detection, replanning), separation forces, and hit detection for this entity. Combine with NET_LOCAL for locally-simulated monsters: `0x05`.

### Per-tick Sequence
1. Drain inbound peer messages → apply to World, collect NetPatches.
2. `tick_monster_ai(dt)`: for each NET_MONSTER entity — stuck detection, path replanning (one A* per tick max), waypoint following, desired velocity + rotation written to ECS.
2.25. `apply_monster_separation()`: blend soft repulsion into NET_MONSTER XZ velocities; skips jump frames.
2.5. `PhysicsWorld::sync_from_world` → `step(dt_secs)` → `sync_to_world`.
3. `tick_bullets(dt)`: for each NET_BULLET entity — integrate ballistic trajectory, bounce off terrain via `cast_ray_with_normal`, detect overlap with NET_MONSTER entities. Returns `Vec<HitPatch>` (one per collision, one per out-of-bounds bullet).
4. Mark locally-owned entities dirty with HEALTH.
5. Flush outbound deltas to peers.
6. `PatchGenerator::generate` (now includes `hits`) → convert to `JsPatch` → return. `clear_dirty`. `advance_tick`.

### Invariants
- `World::clear_dirty` is called once per tick, after patch generation.
- `MetricsPatch` is always included in the returned bundle.
- At most one A* search runs per engine tick (path_requested_this_tick flag).
- Separation does not modify velocity on jump frames (`vel.y.abs() > 0.1`).
- Hit detection uses ECS positions (updated by physics sync), not Three.js positions.
- `destroy_entity` removes MonsterState and Rapier body in the same call.

### Dependencies
- `ecs`, `physics`, `netcode`, `patch`, `pathfinding` crates. `wasm-bindgen`, `serde-wasm-bindgen`, `console_log`, `console_error_panic_hook` (WASM), `bincode`.

### Verification
- `cargo build --target wasm32-unknown-unknown --release` exits 0.
- `wasm-pack build --target bundler` in `crates/engine/` produces `pkg/` with `@kikorin/engine-wasm`.

### Change Notes
- Initial implementation: Timer abstraction for sub-millisecond timing cross-platform.
- `destroy_entity` calls `physics.remove_entity(id)` — prevents phantom render patches.
- Gravity raised from 9.81 to 20.0 m/s². Jump velocities scaled proportionally.
- Added `spawn_bullet` and `NET_BULLET (0x02)` flag. Bullet entities have no Rapier body.
- Bullets bounce off terrain using `PhysicsWorld::cast_ray_with_normal`.
- **Previous pass:** Monster AI state machine, path following, stuck detection, and replanning migrated from TypeScript (`kikorin.tsx`) to Rust (`tick_monster_ai`). Monster separation forces migrated from the `monsterAIWorker.ts` pool to `apply_monster_separation`. Bullet hit detection migrated from TypeScript to `tick_bullets`. Added `NET_MONSTER (0x04)` flag, `MonsterState` struct, `update_monster_goal` API, and `HitPatch` in the `PatchBundle`. TypeScript is now responsible only for rendering, player input, camera, bullet lifetime, and respawn logic triggered by `HitPatch` events.
- **This pass:** Fixed `tick_bullets` — gravity (`vy -= 20.0 * dt_secs`) was never applied to stored bullet velocity, so bullets flew in a straight line instead of arcing. Also fixed the non-bounce path to write the gravity-updated velocity back to ECS so the arc accumulates across ticks. Both the bounce (velocity reflection) and free-flight paths now use the gravity-adjusted velocity.

**Contract changes from this pass:**
- `PatchBundle` gains `hits: Vec<HitPatch>`. All consumers must handle the new field.
- Monsters must be spawned with `net_flags = NET_LOCAL | NET_MONSTER (0x05)` instead of just `NET_LOCAL (0x01)`.
- `update_monster_goal(gx, gz)` must be called each frame with the player position before tick().
- `spawn_box_entity` no longer needs a MonsterPathState counterpart in TypeScript.
- `monsterAIWorker.ts` deleted; `set_entity_velocity_batch` no longer called for monsters.
