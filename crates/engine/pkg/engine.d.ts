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
     * Call once after all floor/terrain entities have been spawned.
     * The navmesh covers [-80, 80] XZ at 1.5-unit cell resolution.
     */
    build_navmesh(): void;
    /**
     * Deserialize a PatchBundle byte array into a JS object.
     * The adapter calls this so TypeScript doesn't need a bincode parser.
     */
    static deserialize_patch(bytes: Uint8Array): any;
    /**
     * Destroy an entity and remove its Rapier physics body.
     */
    destroy_entity(id: number): void;
    /**
     * Find a path from (startX, startY, startZ) to (goalX, goalZ).
     * Returns a JS array of `{x, y, z, requiresJump, isLedgeDrop}` waypoints, or null.
     * `canJump` — set false for monsters that cannot jump; jump edges are excluded.
     */
    find_path(start_x: number, start_y: number, start_z: number, goal_x: number, goal_z: number, can_jump: boolean): any;
    /**
     * Return current tick metrics as a JS object.
     */
    get_metrics(): any;
    /**
     * Initialize WebRTC peer networking (WASM only).
     * TypeScript provides the shared session ID and signaling server URL.
     * Connection negotiation happens asynchronously inside wasm-peers.
     */
    init_networking(session_id: string, signaling_url: string): void;
    constructor();
    /**
     * Set the velocity of an entity. Use from TypeScript game logic each frame.
     * XZ velocity is always applied. Pass vy=0 for normal movement so that
     * sync_from_world (in the physics crate) preserves Rapier's accumulated Y
     * velocity (gravity). Pass non-zero vy only for a one-frame jump impulse.
     */
    set_entity_velocity(id: number, vx: number, vy: number, vz: number): void;
    /**
     * Set log verbosity: 0=off, 1=error, 2=warn, 3=info, 4=debug.
     */
    set_log_level(_level: number): void;
    /**
     * Spawn a dynamic entity (player, monster, box). Returns the entity ID.
     * Pass `net_flags = 1` (NET_LOCAL) for locally-simulated entities; they are
     * automatically included in render patches every tick.
     */
    spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
    /**
     * Spawn a projectile. The engine integrates its ballistic trajectory each tick
     * (constant XZ velocity, 20.0 m/s² gravity on Y) and emits render patches.
     * No Rapier body is created — bullets bypass broadphase and contact generation.
     * TypeScript owns lifetime and hit detection; call destroy_entity to remove.
     */
    spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number): number;
    /**
     * Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
     */
    spawn_entity(payload: Uint8Array): number;
    /**
     * Spawn a static floor entity. Returns the entity ID.
     * The entity is a solid collider; set its Three.js position immediately after spawning.
     */
    spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): number;
    /**
     * Advance simulation by dt_ms milliseconds.
     * Returns a PatchBundle as a JS object directly — no bincode round-trip.
     */
    tick(dt_ms: number): any;
}
