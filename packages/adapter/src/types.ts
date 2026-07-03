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
  /** null/undefined when the bullet expired or left the play area rather than hitting a monster. */
  target_eid?: number | null;
}

export interface MetricsPatch {
  /** Full Rust tick, including patch generation. */
  tick_ms: number;
  /** Engine-owned systems: monster AI, separation, bullets, dirty marking. */
  ai_ms: number;
  physics_ms: number;
  /** A* search share of ai_ms. */
  pathfinding_ms: number;
  /** Inbound apply + outbound delta flush. */
  net_ms: number;
  /** PatchBundle generation (dirty scan). */
  patch_ms: number;
  /**
   * WASM-boundary cost: JS-observed tick() call time minus Rust-internal tick_ms
   * (i.e. the JsValue conversion + bindgen overhead). Absent on the raw WASM
   * bundle; the engine worker fills it before each flush.
   */
  boundary_ms?: number;
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

export type JsTerrainBlock = {
  eid: number;
  x: number;
  y: number;
  z: number;
  hw: number;
  hh: number;
  hd: number;
  kind: 'floor' | 'wall' | 'platform';
};

/** One static terrain block of a game-owned map, as passed to load_map. */
export type TerrainBlockInput = Omit<JsTerrainBlock, 'eid'> & {
  /**
   * Whether NPCs may walk on this block's top surface (default true). Walls and
   * decorative geometry must set false: they stay solid for physics, but the
   * navmesh skips their tops — a node on an unreachable wall top makes every
   * pathfinding request that snaps to it fail after exploring the whole mesh.
   */
  walkable?: boolean;
};

/**
 * Monster AI tuning overrides. All fields optional; fields left out fall back to
 * engine defaults (not to previously set values).
 */
export interface AiConfigInput {
  walk_speed?: number;
  jump_speed?: number;
  jump_trigger_dist?: number;
  jump_cooldown?: number;
  jump_height_tolerance?: number;
  waypoint_reach?: number;
  replan_stale_dist?: number;
  replan_cooldown?: number;
  stuck_sample_interval?: number;
  stuck_move_threshold?: number;
  stuck_escape_after?: number;
  separation_radius?: number;
}

/**
 * Navmesh build tuning overrides (cell resolution + agent traversal capabilities).
 * Same partial-object semantics as AiConfigInput. Mesh bounds are not configurable —
 * the engine derives them from the loaded floor geometry.
 */
export interface NavConfigInput {
  cell_size?: number;
  max_step_up?: number;
  jump_threshold?: number;
  min_ledge_drop?: number;
  max_ledge_drop?: number;
  corner_drop_tolerance?: number;
}

/** Minimal interface the WASM Engine must satisfy. */
export interface EngineHandle {
  /** Advance the simulation by dt_ms. Returns a PatchBundle JS object directly. */
  tick(dt_ms: number): PatchBundle | null;
  apply_input(payload: Uint8Array): void;
  get_metrics(): MetricsPatch;
  set_log_level(level: number): void;
  spawn_entity(payload: Uint8Array): number;
  destroy_entity(id: number): void;
  /**
   * Load a game-owned map. Spawns a static terrain entity per block and builds the
   * navmesh over the resulting geometry in a single Rust call. Returns the blocks
   * with their entity IDs added so TypeScript can create Three.js meshes.
   */
  load_map(blocks: TerrainBlockInput[]): JsTerrainBlock[];
  /** Override monster AI tuning (partial object; missing fields = engine defaults). */
  set_ai_config(cfg: AiConfigInput): void;
  /** Override navmesh build tuning; applies to the next load_map/build_navmesh. */
  set_nav_config(cfg: NavConfigInput): void;
  /** Spawn a dynamic entity. net_flags=1 (NET_LOCAL) for locally-simulated entities. */
  spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
  /**
   * Spawn a projectile. The engine integrates its ballistic trajectory each tick,
   * enforces a TTL (PROJ_MAX_FRAMES), and emits HitPatch events for hits and expiry.
   * No Rapier body — bypasses broadphase entirely.
   */
  spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number): number;
  /** Set XZ velocity (movement) and optionally Y (one-frame jump impulse when non-zero). */
  set_entity_velocity(id: number, vx: number, vy: number, vz: number): void;
  /** Update the position monsters path toward. Call once per frame before tick(). */
  update_monster_goal(gx: number, gz: number): void;
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
