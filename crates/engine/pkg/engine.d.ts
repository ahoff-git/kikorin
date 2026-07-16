/* tslint:disable */
/* eslint-disable */

/**
 * Top-level engine exposed to JavaScript. One instance per page load.
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Reactive-nudge entry point (goal layers, ADR 0011): blend a soft
     * influence into a monster's current velocity without replacing its
     * path target — the same post-AI pattern monster separation uses.
     */
    add_monster_nudge(id: number, nx: number, ny: number, nz: number): void;
    /**
     * Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
     * Bounds are derived from the loaded floor entities (AABB padded by one cell), so
     * maps of any size and location work without engine changes.
     */
    build_navmesh(): void;
    /**
     * Build (or rebuild) a 2D navmesh — the side-view platformer analogue of
     * `build_navmesh`, kept as a separate entry point (see
     * `crates/engine/src/navmesh2d.rs`) since 3D's single-surface-per-column
     * scan silently loses geometry a 2D level actually needs. `walk_speed`/
     * `jump_speed`/`max_jumps` describe whoever will traverse the mesh —
     * passed in by the caller each time rather than read from any stored
     * config, so the same level can serve movers with different
     * capabilities without touching Rust. Stores into the same `self.navmesh`
     * slot `build_navmesh` does; `find_path` queries it unchanged either way.
     */
    build_navmesh_2d(walk_speed: number, jump_speed: number, max_jumps: number): void;
    /**
     * Revert a monster to the engine-global AiConfig's capability.
     */
    clear_monster_capability(id: number): void;
    /**
     * Revert a monster to the default goal.
     */
    clear_monster_goal(id: number): void;
    /**
     * Deserialize a PatchBundle byte array into a JS object.
     */
    static deserialize_patch(bytes: Uint8Array): any;
    /**
     * Destroy an entity and remove its Rapier physics body.
     */
    destroy_entity(id: number): void;
    /**
     * Which physics backend this engine was constructed with — `"2d"` or
     * `"3d"`. Introspection only; the choice was fixed at construction.
     */
    dimension(): string;
    /**
     * Find a path from (startX, startY, startZ) to (goalX, goalZ).
     */
    find_path(start_x: number, start_y: number, start_z: number, goal_x: number, goal_z: number, can_jump: boolean): any;
    /**
     * Return current tick metrics as a JS object.
     */
    get_metrics(): any;
    /**
     * Load a map from a JS array of `{ x, y, z, hw, hh, hd, kind }` blocks: spawns a
     * static terrain entity per block, builds the navmesh from the resulting floor
     * geometry, and returns the same blocks with `eid` added for mesh creation on the
     * TS side. The map data is owned by the game — the engine ships none.
     */
    load_map(blocks: any): any;
    /**
     * Inbound payload from a peer; applied at the start of the next tick.
     */
    net_ingest(peer_id: string, payload: Uint8Array): void;
    /**
     * Initialize WebRTC peer networking (WASM only).
     * A peer's data channel opened. Queues a late-join full sync + PeerJoined.
     */
    net_peer_connected(peer_id: string): void;
    /**
     * A peer's data channel closed. Its mirrors despawn next tick (the silent
     * timeout remains as a backstop for channels that die without closing).
     */
    net_peer_disconnected(peer_id: string): void;
    /**
     * Everything the engine wants sent since the last call, as
     * `[{ peer: string | null, data: Uint8Array }]` — null peer = broadcast.
     */
    net_take_outbound(): any;
    /**
     * `dimension`: `"2d"` (case-insensitive) selects Rapier2D; anything else
     * (including omitted/`None`, from JS calling `new Engine()`) keeps the
     * original Rapier3D behavior. A setup-time choice only — fixed for this
     * engine instance's lifetime, and orthogonal to game logic (player
     * controller/monster AI/bullets are unchanged either way; see
     * crates/physics's Dimension for exactly what "2D" means physically).
     * `gravity`: overrides the engine-wide gravity constant for this
     * instance (e.g. `Some(0.0)` for a top-down, no-fall game); omitted/
     * `None` keeps the original value. Threaded to every consumer that
     * cares — physics, bullet ballistic integration, and the 2D navmesh's
     * jump-reachability math all read `self.gravity`, not the bare constant.
     */
    constructor(dimension?: string | null, gravity?: number | null);
    /**
     * Fire one bullet from the player along its facing + aim pitch (tuning in
     * PlayerConfig). Ballistic, replicated, predictable; spawn and death reach
     * the game as lifecycle patches.
     */
    player_fire(): void;
    /**
     * Register the player entity. From then on the engine runs its controller
     * (facing, movement, jump budget) from set_player_input, fires its bullets
     * via player_fire, and aims the default monster goal at it every tick.
     */
    register_player(eid: number): void;
    /**
     * Override monster AI tuning. Accepts a partial JS object; missing fields fall
     * back to engine defaults (not to previously set values). Invalid input is
     * ignored with a warning.
     */
    set_ai_config(cfg: any): void;
    /**
     * Set the velocity of an entity. XZ is a movement command, applied last-write-wins.
     * Non-zero vy latches a jump impulse consumed by exactly one physics step; vy=0
     * never clears a pending latch, so a jump survives movement commands that coalesce
     * ahead of the next tick. Consecutive jumps before a tick collapse to the last one.
     */
    set_entity_velocity(id: number, vx: number, vy: number, vz: number): void;
    /**
     * Set log verbosity: 0=off, 1=error, 2=warn, 3=info, 4=debug.
     */
    set_log_level(_level: number): void;
    /**
     * Give one monster its own capability override (walk speed / can-jump /
     * can-fly — see `MonsterCapability`'s doc comment for why `jump_speed`
     * and `max_jumps` aren't here), overriding the engine-global `AiConfig`
     * until cleared. Accepts a partial JS object; missing fields fall back
     * to `MonsterCapability::default()` (not to the current `AiConfig`,
     * same "missing = static default" convention every other partial
     * config in this engine already uses). Invalid input is ignored with a
     * warning.
     */
    set_monster_capability(id: number, cfg: any): void;
    /**
     * Override monster spawn/respawn tuning (partial-object semantics).
     */
    set_monster_config(cfg: any): void;
    /**
     * Give one monster its own goal, overriding the default until cleared.
     * No-op for entities without monster AI state.
     */
    set_monster_goal(id: number, gx: number, gz: number): void;
    /**
     * Override navmesh build tuning (same partial-object semantics as set_ai_config).
     * Takes effect on the next load_map / build_navmesh call.
     */
    set_nav_config(cfg: any): void;
    /**
     * Override player controller/combat tuning (partial-object semantics).
     */
    set_player_config(cfg: any): void;
    /**
     * Latest raw input state from the UI (call once per frame). Invalid input
     * is ignored with a warning.
     */
    set_player_input(input: any): void;
    /**
     * Mark a floor entity as non-walkable (or clear that) after it's already
     * spawned — additive counterpart to `MapBlock.walkable` (which only
     * applies at `load_map` time) for callers like the 2D game that spawn
     * terrain block-by-block via `spawn_floor_entity` instead.
     */
    set_terrain_walkable(id: number, walkable: boolean): void;
    /**
     * Spawn a dynamic entity (player, monster, box). Returns the entity ID.
     * `net_flags`: combine NET_LOCAL (0x01) and NET_MONSTER (0x04) for monster entities.
     */
    spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
    /**
     * Spawn a projectile. The engine integrates its ballistic trajectory each
     * tick. `net_flags` adds the game's networking profile (e.g. NET_REPLICATED
     * | NET_PREDICTABLE); NET_BULLET is always set.
     */
    spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number, net_flags: number): number;
    /**
     * Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
     */
    spawn_entity(payload: Uint8Array): number;
    /**
     * Spawn a static floor entity. Returns the entity ID.
     */
    spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): number;
    /**
     * Spawn `count` monsters on a ring around the origin (placement/template
     * from MonsterConfig). Each spawn surfaces as a lifecycle patch.
     */
    spawn_monsters(count: number): void;
    /**
     * Move an entity immediately, clearing velocity for dynamic bodies.
     */
    teleport_entity(id: number, x: number, y: number, z: number): void;
    /**
     * Advance simulation by dt_ms milliseconds.
     * Returns a PatchBundle as a JS object directly — no bincode round-trip.
     * Thin WASM wrapper: the simulation itself lives in `tick_core` so native
     * tests can execute full ticks without crossing the JsValue boundary.
     */
    tick(dt_ms: number): any;
    /**
     * Update the fallback goal for monsters without a per-entity override,
     * used only when no player exists yet to chase (no local player
     * registered, no peers connected) — once at least one does, every such
     * monster targets whichever player (local or a remote mirror) is
     * currently closest to it instead. See `closest_player_position`.
     */
    update_monster_goal(gx: number, gz: number): void;
}
