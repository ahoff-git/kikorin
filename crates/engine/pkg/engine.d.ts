/* tslint:disable */
/* eslint-disable */

/**
 * Top-level engine exposed to JavaScript. One instance per page load.
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply a serialized input event or inbound peer message.
     */
    apply_input(payload: Uint8Array): void;
    /**
     * Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
     * Bounds are derived from the loaded floor entities (AABB padded by one cell), so
     * maps of any size and location work without engine changes.
     */
    build_navmesh(): void;
    /**
     * Deserialize a PatchBundle byte array into a JS object.
     */
    static deserialize_patch(bytes: Uint8Array): any;
    /**
     * Destroy an entity and remove its Rapier physics body.
     */
    destroy_entity(id: number): void;
    /**
     * Find a path from (startX, startY, startZ) to (goalX, goalZ).
     */
    find_path(start_x: number, start_y: number, start_z: number, goal_x: number, goal_z: number, can_jump: boolean): any;
    /**
     * Return current tick metrics as a JS object.
     */
    get_metrics(): any;
    /**
     * Initialize WebRTC peer networking (WASM only).
     */
    init_networking(session_id: string, signaling_url: string): void;
    /**
     * Load a map from a JS array of `{ x, y, z, hw, hh, hd, kind }` blocks: spawns a
     * static terrain entity per block, builds the navmesh from the resulting floor
     * geometry, and returns the same blocks with `eid` added for mesh creation on the
     * TS side. The map data is owned by the game — the engine ships none.
     */
    load_map(blocks: any): any;
    constructor();
    /**
     * Override monster AI tuning. Accepts a partial JS object; missing fields fall
     * back to engine defaults (not to previously set values). Invalid input is ignored.
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
     * Override navmesh build tuning (same partial-object semantics as set_ai_config).
     * Takes effect on the next load_map / build_navmesh call.
     */
    set_nav_config(cfg: any): void;
    /**
     * Spawn a dynamic entity (player, monster, box). Returns the entity ID.
     * `net_flags`: combine NET_LOCAL (0x01) and NET_MONSTER (0x04) for monster entities.
     */
    spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
    /**
     * Spawn a projectile. The engine integrates its ballistic trajectory each tick.
     */
    spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number): number;
    /**
     * Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
     */
    spawn_entity(payload: Uint8Array): number;
    /**
     * Spawn a static floor entity. Returns the entity ID.
     */
    spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): number;
    /**
     * Move an entity immediately, clearing velocity for dynamic bodies.
     */
    teleport_entity(id: number, x: number, y: number, z: number): void;
    /**
     * Advance simulation by dt_ms milliseconds.
     * Returns a PatchBundle as a JS object directly — no bincode round-trip.
     */
    tick(dt_ms: number): any;
    /**
     * Update the position monsters path toward. Call once per frame before tick()
     * with the player's current world position.
     */
    update_monster_goal(gx: number, gz: number): void;
}
