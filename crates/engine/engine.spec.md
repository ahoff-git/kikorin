## crates/engine — Engine Orchestrator (WASM Entry Point)

### Purpose
The single `#[wasm_bindgen]` `Engine` type — the only Rust artifact JavaScript sees. Assembles the ECS world, physics, netcode, pathfinding, and patch generation into one per-tick sequence, and owns the game logic that belongs to no single subsystem: monster AI, bullet simulation, and hit detection.

### The Big Picture
The ECS `World` is the single source of truth. Each tick, subsystems read and write the world in a fixed order; the dirty entities are then packed into one bincode `PatchBundle` that crosses the WASM boundary. JavaScript never reads entity state directly — it consumes patches and calls spawn/input methods.

Rust owns all simulation: physics, pathfinding, monster AI, bullet lifetimes, and terrain layout. TypeScript is a pure UI/render layer (Three.js, React, input) that reacts to patches.

### Subsystem Map
This spec is the top-level entry point; each box below has its own spec for the detail glossed over here.

- **`ecs`** — SoA world storage + scheduler; the single source of truth every subsystem reads/writes.
- **`physics`** — Rapier3D step; derives bodies from ECS colliders, writes back positions + grounded.
- **`pathfinding`** — stateless NavMesh A*; supplies monster waypoints.
- **`netcode`** — per-peer delta tracking + WebRTC apply/flush.
- **`patch`** — packs the tick's dirty entities into the `PatchBundle`.
- `packages/adapter` (TS) — mirror types + channels that consume the bundle; `packages/system-rendering` (TS) — applies render patches to Three.js.

### Per-tick Sequence — `tick(dt_ms)`
1. Drain inbound peer messages → apply to world.
2. **Monster AI:** per NET_MONSTER entity — follow path, detect stuck, replan (≤ 1 A* search per tick), write desired velocity + rotation.
3. **Separation:** blend soft repulsion into monster XZ velocities (skipped on jump frames).
4. **Physics:** sync world → Rapier, step, sync back.
5. **Bullets:** integrate NET_BULLET trajectories, bounce off terrain, enforce TTL, detect monster overlaps → hit events.
6. Mark locally-owned entities dirty; flush outbound peer deltas.
7. Generate `PatchBundle` → clear dirty flags → advance tick.

### NET Flags — entity networking/simulation contract
The `net_flags` bitmask on each entity is the source of truth for how the engine treats it. Referenced by name across the other crates.
- `NET_LOCAL (0x01)` — Rapier dynamic body; emits HEALTH patches; replicated outbound.
- `NET_BULLET (0x02)` — no Rapier body; engine integrates its ballistic trajectory; emits only TRANSFORM patches.
- `NET_MONSTER (0x04)` — engine owns its AI, separation, and hit detection. Combine with LOCAL (`0x05`) for a locally-simulated monster.

### Public WASM API
```
tick(dt_ms) → JsPatch                     per-tick simulation; returns the PatchBundle
apply_input(bytes)                        apply inbound peer delta / input event
spawn_box_entity(x,y,z,hw,hh,hd,health,net_flags) → id
spawn_bullet(x,y,z,vx,vy,vz) → id         NET_BULLET; no Rapier body
spawn_entity(EntityBlueprint bytes) → id
destroy_entity(id)                        removes ECS + Rapier body + AI/bullet state
load_map() → JsTerrainBlock[]             spawns static terrain, builds navmesh, returns layout
update_monster_goal(gx, gz)               set pathfinding target; once per frame
find_path(sx,sy,sz,gx,gz,canJump) → JsWaypoint[] | null   manual A* query
init_networking(session_id, url)          WASM only
get_metrics() → JsMetrics | set_log_level(u8) | deserialize_patch(bytes) → JsPatch (static)
```

### Invariants
- At most one A* search runs per tick.
- `load_map()` builds the navmesh internally — callers must not build it separately.
- `destroy_entity` removes the entity's Rapier body and any monster/bullet state in the same call, so no phantom patches survive for a recycled ID.

### Dependencies
`ecs`, `physics`, `netcode`, `patch`, `pathfinding`; `wasm-bindgen`, `serde-wasm-bindgen`, `bincode`, and (WASM only) `console_log` / `console_error_panic_hook`.

### Verification
- `cargo check -p engine` exits 0.
- `wasm-pack build --target bundler` in `crates/engine/` produces `pkg/` (`@kikorin/engine-wasm`).
