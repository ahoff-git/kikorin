export interface RenderPatch {
  entity: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface SemanticPatch {
  entity: number;
  health?: number;
  net_flags?: number;
  grounded?: boolean;
}

export interface NetPatch {
  peer_id: string;
  entity: number;
}

export interface HitPatch {
  bullet_eid: number;
  /** null when the bullet left the play area rather than hitting a monster. */
  target_eid: number | null;
}

export interface MetricsPatch {
  tick_ms: number;
  ecs_ms: number;
  physics_ms: number;
  net_ms: number;
  patch_ms: number;
}

export interface PatchBundle {
  tick: number;
  render: RenderPatch[];
  semantic: SemanticPatch[];
  net: NetPatch[];
  hits: HitPatch[];
  metrics: MetricsPatch;
}

export type JsWaypoint = {
  x: number;
  y: number;
  z: number;
  requiresJump: boolean;
  isLedgeDrop: boolean;
};

/** Minimal interface the WASM Engine must satisfy. */
export interface EngineHandle {
  /** Advance the simulation by dt_ms. Returns a PatchBundle JS object directly. */
  tick(dt_ms: number): PatchBundle | null;
  apply_input(payload: Uint8Array): void;
  get_metrics(): MetricsPatch;
  set_log_level(level: number): void;
  spawn_entity(payload: Uint8Array): number;
  destroy_entity(id: number): void;
  /** Spawn a static floor/terrain entity. Returns the entity ID. */
  spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): number;
  /** Spawn a dynamic entity. net_flags=1 (NET_LOCAL) for locally-simulated entities. */
  spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
  /**
   * Spawn a projectile. The engine integrates its ballistic trajectory each tick and
   * emits render patches. No Rapier body — bypasses broadphase entirely.
   * TypeScript owns lifetime and hit detection; call destroy_entity to remove.
   */
  spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number): number;
  /** Set XZ velocity (movement) and optionally Y (one-frame jump impulse when non-zero). */
  set_entity_velocity(id: number, vx: number, vy: number, vz: number): void;
  /** Update the position monsters path toward. Call once per frame before tick(). */
  update_monster_goal(gx: number, gz: number): void;
  /** Build (or rebuild) the navmesh from current floor geometry. Call once after terrain is spawned. */
  build_navmesh(): void;
  /**
   * Find a path from (startX, startY, startZ) to (goalX, goalZ).
   * Returns a waypoint array or null if no path exists.
   * canJump=false excludes step-up edges (monsters that cannot jump).
   */
  find_path(startX: number, startY: number, startZ: number, goalX: number, goalZ: number, canJump: boolean): JsWaypoint[] | null;
  /** WASM-only: initialise WebRTC networking. */
  init_networking?(session_id: string, signaling_url: string): void;
}

export interface EngineClass {
  new (): EngineHandle;
}
