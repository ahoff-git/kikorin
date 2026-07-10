## crates/engine — Engine Orchestrator (WASM Entry Point)

### Purpose
The single `#[wasm_bindgen]` `Engine` type — the only Rust artifact JavaScript sees. Assembles the ECS world, physics, netcode, pathfinding, and patch generation into one per-tick sequence, and owns the game logic that belongs to no single subsystem: monster AI, bullet simulation, and hit detection.

### The Big Picture
The ECS `World` is the single source of truth. Each tick, subsystems read and write the world in a fixed order; the dirty entities are then packed into one bincode `PatchBundle` that crosses the WASM boundary. JavaScript never reads entity state directly — it consumes patches and calls spawn/input methods.

Rust owns all game logic: physics, pathfinding, monster AI, the player controller (facing/movement/jump budget from raw input), combat (firing, damage, death, respawn), monster population, and bullet lifetimes. Game data is supplied by the game layer at runtime — the map arrives as blocks via `load_map(blocks)`, and tuning via the `set_*_config` calls (partial JS objects; missing fields fall back to engine defaults). TypeScript is strictly UI + IO: it captures raw key/mouse state, renders what lifecycle/render patches say exists, and drives the camera.

### Subsystem Map
This spec is the top-level entry point; each box below has its own spec for the detail glossed over here.

- **`ecs`** — SoA world storage + scheduler; the single source of truth every subsystem reads/writes.
- **`physics`** — Rapier3D step; derives bodies from ECS colliders, writes back positions + grounded.
- **`pathfinding`** — stateless NavMesh A*; supplies monster waypoints.
- **`netcode`** — per-peer delta tracking + WebRTC apply/flush.
- **`patch`** — packs the tick's dirty entities into the `PatchBundle`.
- `packages/adapter` (TS) — mirror types + channels that consume the bundle; `packages/system-rendering` (TS) — applies render patches to Three.js.

### Per-tick Sequence — `tick(dt_ms)`
`tick` is a thin WASM wrapper (timing + JsValue conversion) around the native-testable `tick_core(dt_secs) → PatchBundle`:
1. **Networking inbound:** drain the transport bridge's queued payloads and apply each event to that peer's **local mirror entity** — remote ids live in the sender's id space, so they are mapped, never applied directly (mirrors are display-only: no collider, no world NET flags; engine systems ignore them). Newly connected peers get a full sync of all NET_REPLICATED entities plus a `PeerJoined` boundary event (so the UI shows them before any entity data); explicitly disconnected or timeout-silent peers are dropped: mirrors despawned, `PeerLeft` reported. Each entity event emits a boundary `NetPatch` (see `crates/patch` spec); outbound payloads queue for `net_take_outbound` (the transport lives on the main thread — see the netcode spec).
2. **Player controller** (`register_player` + `set_player_input`): facing from the turn axis (or the camera's absolute yaw override in pointer lock), normalized planar movement at `walk_speed`, an edge-detected jump budget (`max_jumps`, refilled while grounded) feeding the jump latch, rotation for rendering, and the default monster goal stamped to the player's position. Then **Monster AI:** per NET_MONSTER entity — resolve its goal (per-entity override, else the default), follow path, detect stuck, replan (≤ 1 A* search per tick, and a monster denied by that budget keeps its cooldown so it retries next tick), write desired velocity + rotation; a monster within the goal epsilon writes a zero velocity (physics reapplies the last command every sync, so "skip" would mean "keep walking"). The per-monster mechanics live on `MonsterState` (`update_stuck_and_replan`, `follow_waypoints`); the loop owns world I/O, the A* budget, and navmesh dispatch.
3. **Separation:** blend soft repulsion into monster XZ velocities (skipped on jump frames).
4. **Physics:** stamp latched jump impulses into world velocity, sync world → Rapier, step, sync back, reset consumed impulses to vy=0.
5. **Bullets & combat:** integrate NET_BULLET trajectories, bounce off terrain, enforce TTL, detect monster overlaps. The engine settles the consequences itself after the integration loop: spent bullets (hit, TTL, kill plane) are destroyed; hit monsters take `PlayerConfig::bullet_damage` and at ≤ 0 health are destroyed and — per `MonsterConfig::respawn` — replaced at a random bearing on the respawn ring. Each death/spawn emits a `LifecyclePatch`; the `HitPatch` (exactly one per bullet death, `target_eid: None` for expiry) is a pure UI/FX event.
6. Mark local entities HEALTH-dirty (grounded delivery); run the flag-driven replication cadence (`mark_replication_dirty`); flush outbound Spawn/Delta events + queued `Despawned` announcements, or a keepalive `Ping` when silent past `PING_INTERVAL_SECS` with peers connected.
7. Generate `PatchBundle` → clear dirty flags → advance tick.

### Metrics
The engine owns all Rust-side timing and stamps it into `bundle.metrics` so consumers receive real values: `tick_ms` (whole tick), `ai_ms` (AI + separation + bullets + dirty marking), `physics_ms`, `pathfinding_ms` (A* share of `ai_ms`), `net_ms` (inbound apply + outbound flush), `patch_ms` (bundle generation). On WASM, timing uses `performance.now()` (µs resolution) — `Date.now()`'s 1 ms resolution is useless at ~4 ms sim steps. The JsValue conversion cannot time itself; the TS worker reports it as `boundary_ms` (observed call time − `tick_ms`).

### NET Flags — the entity networking profile
The `net_flags` bitmask (constants live in `crates/ecs`, mirrored in `@kikorin/adapter`) is the source of truth for how the engine simulates **and replicates** each entity. The dimensions compose — an entity's networking behavior is the combination, not one enum:

| Dimension | Flag | Effect |
|---|---|---|
| Ownership | `NET_LOCAL (0x01)` | Simulated here: HEALTH-dirtied each tick (grounded delivery). Rapier bodies are driven by collider config, not this flag. |
| Type | `NET_BULLET (0x02)` | Engine integrates its ballistic trajectory; death handshake in tick step 5. Receivers apply gravity when extrapolating its mirrors. |
| Type | `NET_MONSTER (0x04)` | Engine owns AI, separation, hit detection. |
| Authority | `NET_REPLICATED (0x08)` | Broadcast to peers; destruction announces `Despawned`. Without it an entity never touches the wire. |
| Predictability | `NET_PREDICTABLE (0x10)` | Velocity ships on the wire; receivers extrapolate, so the sender only sends drift corrections every `PREDICTABLE_STRIDE` ticks plus engine-forced updates at discontinuities (bullet bounces). |
| Urgency | `NET_LOW_URGENCY (0x20)` | Replicated every `LOW_URGENCY_STRIDE` ticks instead of every tick — for background actors. |

Replication cadence is engine-owned (`mark_replication_dirty`): default = every tick, predictable/low-urgency = their strides. Content is tracker-owned (only changed components ship). Only `NET_PUBLIC_MASK` bits (type + predictability) cross the wire, inside `Spawn` events; ownership/authority/urgency are sender-local. Received mirrors keep their profile in engine-side bookkeeping, never in world `net_flags`, so engine systems ignore them; `NET_PREDICTABLE` mirrors are extrapolated each tick (with gravity when bullet-typed).

kikorin's profiles: player = `LOCAL|REPLICATED`, monsters = `LOCAL|MONSTER|REPLICATED|LOW_URGENCY`, bullets = `BULLET|REPLICATED|PREDICTABLE`, terrain = unflagged (never replicated).

Every spawn path routes through the same post-spawn bookkeeping (`register_spawned`): velocity component init plus the flag-driven registries — the blueprint path included.

### Public WASM API
```
tick(dt_ms) → JsPatch                     per-tick simulation; returns the PatchBundle
spawn_box_entity(x,y,z,hw,hh,hd,health,net_flags) → id
spawn_bullet(x,y,z,vx,vy,vz,net_flags) → id   NET_BULLET always set; no Rapier body
spawn_floor_entity(x,y,z,hw,hh,hd) → id   static terrain body
spawn_entity(EntityBlueprint bytes) → id
destroy_entity(id)                        removes ECS + Rapier body + AI/bullet/delta state
teleport_entity(id,x,y,z)                 immediate move; clears velocity + any jump latch
set_entity_velocity(id,vx,vy,vz)          XZ movement (last write wins); non-zero vy latches a jump impulse
load_map(blocks) → JsTerrainBlock[]       spawns game-supplied terrain, builds navmesh, returns blocks + eids
build_navmesh()                           rebuild navmesh from current floor geometry
set_ai_config | set_nav_config | set_player_config | set_monster_config   tuning overrides (partial; missing = defaults)
register_player(eid)                      hand the entity to the engine's controller
set_player_input(input)                   raw input state, once per frame
player_fire()                             spawn a bullet along facing + aim pitch
spawn_monsters(count)                     ring placement from MonsterConfig
update_monster_goal(gx, gz)               set the default pathfinding goal; once per frame
set_monster_goal(id, gx, gz)              per-monster goal override (until cleared)
clear_monster_goal(id)                    revert a monster to the default goal
find_path(sx,sy,sz,gx,gz,canJump) → JsWaypoint[] | null   manual A* query
net_peer_connected/disconnected(peer)     transport bridge: data-channel open/close
net_ingest(peer, bytes)                   transport bridge: inbound payload
net_take_outbound() → [{peer|null, data}] transport bridge: drain queued sends (WASM)
get_metrics() → JsMetrics | set_log_level(u8) | deserialize_patch(bytes) → JsPatch (static)
```

### Invariants
- At most one A* search runs per tick, and a **failed** search (unreachable goal) never resets a monster's replan cooldown — only a fully-walked path earns an immediate replan. A failed A* explores the whole graph before returning None, so an every-tick retry would collapse the tick budget.
- `load_map(blocks)` builds the navmesh internally — callers must not build it separately.
- Navmesh bounds — XZ **and** the vertical probe window — are derived from the loaded floor geometry (AABB + padding), never hardcoded; with no floor geometry there is no navmesh and path queries return null. Maps at any altitude work.
- Navmesh nodes are placed only on **walkable** surfaces: blocks with `walkable: false` (walls) stay solid for physics, but node sampling skips their tops and continues to the surface beneath. This prevents unreachable node ribbons on wall tops, which would make goals that snap to them permanently unpathable.
- The engine ships no game data: map layout and AI/nav tuning defaults are overridable inputs.

### Known Gaps — reusability decisions pending
- Bullet flight tuning (TTL, hit radius, elastic bounce, kill plane) and world gravity are engine constants, not configs — no `set_bullet_config`/gravity override yet (muzzle/speed/damage live in PlayerConfig).
- Bullets can only hit NET_MONSTER entities, with a fixed hit radius (PvE assumption).
- No map unload: repeated `load_map` accumulates terrain.
- `destroy_entity` removes the entity's Rapier body and any monster/bullet state in the same call, so no phantom patches survive for a recycled ID.
- **Jump is an event; XZ movement is state.** A non-zero vy in `set_entity_velocity` latches a jump impulse consumed by exactly one physics step; vy=0 calls never clear the latch. Input messages coalesce last-write-wins between ticks (the worker drains its queue back-to-back when ticks run long), so a jump command riding the velocity field directly would be overwritten before a step consumed it. Consecutive jumps before a tick collapse to the last one; `destroy_entity` and `teleport_entity` drop a pending latch.

### Dependencies
`ecs`, `physics`, `netcode`, `patch`, `pathfinding`; `wasm-bindgen`, `serde-wasm-bindgen`, `bincode`, and (WASM only) `console_log` / `console_error_panic_hook`.

### Verification
- `cargo test -p engine` — navmesh construction over realistic geometry (including altitude-independence), replan cooldown limiting, dynamic-body teleport, the jump-latch contract (survives movement-command overwrites, consumed by exactly one step, dropped on destroy), blueprint-spawn bookkeeping, bullet lifecycle (TTL / kill plane / monster hit each emit exactly one HitPatch; the engine destroys spent bullets), the player controller (movement/facing/goal tracking, held jump = exactly one impulse), fire (muzzle offset, velocity, ballistic-replicated-predictable profile), kill → despawn → ring respawn with lifecycle events, ring spawn_monsters, monster separation divergence, goal-reached stop, AI steering against injected paths (waypoint following and advancement, jump triggering with cooldown, yaw facing, stuck escape → replan), per-monster goal override/clear, and networking (mirrors shield local ids from remote id collisions, repeat deltas reuse the mirror, per-peer id spaces, despawn events, silent-peer timeout with PeerLeft, replicated-only destroy broadcasting, urgency-stride cadence, predictable-mirror extrapolation vs unpredictable mirrors staying put, and a **two-engine loopback test** piping one engine's broadcasts into another to prove the full replicate→mirror→boundary pipeline). Full ticks run natively through `tick_core`.
- `wasm-pack build --target bundler` in `crates/engine/` produces `pkg/` (`@kikorin/engine-wasm`).
