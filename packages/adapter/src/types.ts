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
  /**
   * Resolved animation cell, present when the engine's animation state machine
   * changed it this tick: which family (`anim_id`), frame, and 8-way direction
   * to display. Rust owns animation; TS renders the cell and never recomputes
   * it (ADR 0015). Absent unless animations are loaded (load_animations).
   */
  anim_id?: number;
  anim_frame?: number;
  anim_dir?: number;
}

export interface NetPatch {
  peer_id: string;
  /** Local mirror entity id (matches render patches); 0 for peer_left. */
  entity: number;
  /**
   * spawned/updated/despawned track a remote peer's entity via its local
   * mirror (create/remove meshes on spawned/despawned). peer_joined fires as
   * soon as the data channel opens (before any entity data); peer_left fires
   * once when a peer disconnects or times out, after its entities despawn.
   */
  kind: 'spawned' | 'updated' | 'despawned' | 'peer_joined' | 'peer_left';
  /**
   * The mirror's public net profile (NET_BULLET/NET_MONSTER/NET_PREDICTABLE
   * bits), present on spawned events — style the remote mesh from it.
   */
  flags?: number | null;
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

/**
 * Local-entity lifecycle event: the engine created or destroyed an entity
 * (fire, death, respawn, TTL, explicit spawn). Create/remove meshes from these
 * — the engine is the source of truth for what exists. Terrain is excluded
 * (load_map returns it); remote mirrors ride NetPatch instead.
 */
export interface LifecyclePatch {
  entity: number;
  kind: 'spawned' | 'despawned';
  /** The entity's net-flag profile — style meshes from it. */
  flags: number;
}

export interface PatchBundle {
  tick: number;
  render: RenderPatch[];
  semantic: SemanticPatch[];
  net: NetPatch[];
  hits: HitPatch[];
  lifecycle: LifecyclePatch[];
  metrics: MetricsPatch;
}

/**
 * Raw player input state, sent once per frame. The engine turns it into
 * movement/facing/jumps — TS owns only the key/mouse mapping that produces it.
 */
export interface PlayerInputState {
  /** −1..1 forward/back axis, relative to the player's yaw. */
  forward?: number;
  /** −1..1 strafe axis (positive = left). */
  strafe?: number;
  /** −1..1 turn axis; ignored while yaw_override is set. */
  turn?: number;
  /** Absolute yaw (radians) when the camera drives facing (pointer lock). */
  yaw_override?: number | null;
  /** Held state; the engine edge-detects for the jump budget. */
  jump_held?: boolean;
  /** Aim pitch (radians), used for firing. */
  aim_pitch?: number;
}

/** Player controller/combat tuning overrides (partial; missing = engine defaults). */
export interface PlayerConfigInput {
  walk_speed?: number;
  turn_speed?: number;
  jump_speed?: number;
  max_jumps?: number;
  bullet_speed?: number;
  bullet_spawn_forward?: number;
  bullet_spawn_up?: number;
  bullet_damage?: number;
}

/** Monster spawn/respawn tuning overrides (partial; missing = engine defaults). */
export interface MonsterConfigInput {
  half_width?: number;
  half_height?: number;
  half_depth?: number;
  health?: number;
  net_flags?: number;
  spawn_y?: number;
  ring_base_radius?: number;
  ring_radius_step?: number;
  ring_steps?: number;
  respawn?: boolean;
  respawn_radius_min?: number;
  respawn_radius_max?: number;
  respawn_y?: number;
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
  /** Opaque styling tag owned by the game; the engine passes it through untouched. */
  kind: string;
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
  /** Jump budget between groundings (2 = double jump) — must match whatever
   * capability the navmesh was built for (build_navmesh's implicit 1, or
   * build_navmesh_2d's max_jumps argument). */
  max_jumps?: number;
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
  /** Frustration escalation window — no goal progress for this long → escalate (see specs/engine). */
  no_progress_after?: number;
  /** Minimum distance-to-goal improvement that counts as progress. */
  progress_epsilon?: number;
}

/**
 * Per-monster capability override (set_monster_capability) — the subset of
 * AiConfig that's safe to vary per monster against a navmesh built for one
 * canonical capability. `jump_speed`/`max_jumps` deliberately aren't here —
 * they stay engine-global (AiConfigInput) so every jumping monster matches
 * what the navmesh actually assumed; only `walk_speed` (never changes which
 * edges are reachable), `can_jump` (false just routes around jump edges,
 * which find_path already supports), and `can_fly` (skips the navmesh
 * entirely) are safe to vary. Missing fields fall back to
 * MonsterCapability's own defaults (not to the current AiConfig — same
 * "missing = static default" convention as every other partial config
 * here), so pass a fully-specified object rather than a sparse one.
 */
export interface MonsterCapabilityInput {
  walk_speed?: number;
  can_jump?: boolean;
  /** Unlocks Tier-4 discovered sprint-jump routes (see ADR 0011). */
  can_sprint?: boolean;
  /** Incorporeal: passes through walls, unlocks phase routes (ADR 0013). */
  can_phase?: boolean;
  can_fly?: boolean;
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

/**
 * Game-authored animation definitions loaded into the engine (load_animations).
 * The *behavior* half of the paper-doll system — timings, transitions,
 * interruptibility — kept in step with the TS art manifest by family order
 * (family index = `anim_id` the engine emits). Art (sheets/layers) stays in
 * `@kikorin/paperdoll`'s manifest. See ADR 0015 / 0016.
 */
export interface AnimFrameInput {
  /** Natural display time for this frame (ms). */
  optimal_ms: number;
  /** Fitting clamps; default to optimal_ms (rigid frame). */
  min_ms?: number;
  max_ms?: number;
  /** May be dropped when a target duration cuts the animation short. */
  skippable?: boolean;
  /** Opens an interrupt window even under a block/queue policy. */
  cancelable?: boolean;
}

export interface AnimFamilyInput {
  frames: AnimFrameInput[];
  looping?: boolean;
  /** Family index to flow to when a one-shot ends. */
  next?: number;
  /** Freeze the final frame (e.g. death) instead of transitioning. */
  hold_last?: boolean;
  /** How a new action interrupts this one; default "always". */
  interrupt?: 'always' | 'block' | 'queue';
  /** Under "queue", the frame at which a queued action takes over (else at end). */
  branch_frame?: number;
}

/** Maps an engine action kind (+ optional variant) to a family index. */
export interface AnimActionInput {
  kind: number;
  variant?: number;
  family: number;
}

export interface AnimationDefsInput {
  families: AnimFamilyInput[];
  actions?: AnimActionInput[];
}

/** Minimal interface the WASM Engine must satisfy. */
export interface EngineHandle {
  /** Advance the simulation by dt_ms. Returns a PatchBundle JS object directly. */
  tick(dt_ms: number): PatchBundle | null;
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
  /** Override player controller/combat tuning (partial; missing = engine defaults). */
  set_player_config(cfg: PlayerConfigInput): void;
  /** Override monster spawn/respawn tuning (partial; missing = engine defaults). */
  set_monster_config(cfg: MonsterConfigInput): void;
  /** Load animation definitions (families/timings/transitions/action map). Absent = animation inert. */
  load_animations(defs: AnimationDefsInput): void;
  /**
   * Register the player entity. The engine then runs its controller from
   * set_player_input, fires via player_fire, and aims the default monster goal
   * at it every tick.
   */
  register_player(eid: number): void;
  /** Latest raw input state; call once per frame. */
  set_player_input(input: PlayerInputState): void;
  /** Fire one bullet along the player's facing + aim pitch. */
  player_fire(): void;
  /** Spawn `count` monsters on the configured ring; spawns surface as lifecycle patches. */
  spawn_monsters(count: number): void;
  /** Spawn a dynamic entity. net_flags=1 (NET_LOCAL) for locally-simulated entities. */
  spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): number;
  /**
   * Spawn a static terrain body directly, without building (or rebuilding)
   * the navmesh the way load_map does — use this for a game that doesn't
   * use the engine's monster/pathfinding system at all.
   */
  spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): number;
  /**
   * Build (or rebuild) a 2D navmesh from whatever floor entities currently
   * exist — the side-view counterpart to load_map's implicit 3D navmesh
   * build, for a game (like kikorin's 2D one) that spawns terrain via
   * spawn_floor_entity instead. walkSpeed/jumpSpeed/maxJumps describe
   * whoever will traverse it; edge reachability is computed from real
   * projectile motion using these, not a fixed NavConfig-style threshold.
   */
  build_navmesh_2d(walkSpeed: number, jumpSpeed: number, maxJumps: number): void;
  /** Mark a floor entity non-walkable (or clear that) after it's already spawned — the per-block-after-the-fact counterpart to load_map's MapBlock.walkable, for terrain spawned via spawn_floor_entity. */
  set_terrain_walkable(id: number, walkable: boolean): void;
  /**
   * Spawn a projectile. The engine integrates its ballistic trajectory each tick,
   * enforces a TTL, and emits each HitPatch exactly once (hit, expiry, or kill
   * plane). The engine never destroys bullets — the game must call destroy_entity
   * when it processes the HitPatch. No Rapier body — bypasses broadphase entirely.
   * net_flags adds the networking profile (e.g. NET_REPLICATED | NET_PREDICTABLE);
   * NET_BULLET is always set by the engine.
   */
  spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number, net_flags: number): number;
  /**
   * Set XZ movement velocity (last write wins). Non-zero vy latches a jump impulse
   * consumed by exactly one physics step; vy=0 never clears a pending jump, so a
   * jump command survives movement commands coalescing ahead of the next tick.
   */
  set_entity_velocity(id: number, vx: number, vy: number, vz: number): void;
  /** Move an entity immediately and clear dynamic velocity. */
  teleport_entity(id: number, x: number, y: number, z: number): void;
  /**
   * Update the default goal — pathed toward by every monster without a
   * per-entity override. Call once per frame before tick().
   */
  update_monster_goal(gx: number, gz: number): void;
  /** Give one monster its own goal, overriding the default until cleared. */
  set_monster_goal(id: number, gx: number, gz: number): void;
  /** Revert a monster to the default goal. */
  clear_monster_goal(id: number): void;
  /** Give one monster its own capability override (walk speed / can-jump / can-fly), overriding the engine-global AiConfig until cleared. */
  set_monster_capability(id: number, cfg: MonsterCapabilityInput): void;
  /** Revert a monster to the engine-global AiConfig's capability. */
  clear_monster_capability(id: number): void;
  /**
   * Find a path from (startX, startY, startZ) to (goalX, goalZ).
   * Returns a waypoint array or null if no path exists.
   * canJump=false excludes step-up edges (monsters that cannot jump).
   */
  find_path(startX: number, startY: number, startZ: number, goalX: number, goalZ: number, canJump: boolean): JsWaypoint[] | null;
  /**
   * Transport bridge: the game layer owns the WebRTC connections (workers have
   * no RTCPeerConnection) and drives these — connect/disconnect on data-channel
   * events, ingest for inbound payloads, and take_outbound to drain what the
   * engine wants sent ({ peer: null } = broadcast).
   */
  net_peer_connected(peer_id: string): void;
  net_peer_disconnected(peer_id: string): void;
  net_ingest(peer_id: string, payload: Uint8Array): void;
  net_take_outbound(): { peer: string | null; data: Uint8Array }[];
}

export interface EngineClass {
  /**
   * `dimension`: `"2d"` selects Rapier2D physics; omitted (or `"3d"`) is the original Rapier3D behavior.
   * `gravity`: overrides the engine-wide gravity constant for this instance (e.g. `0` for a
   * top-down, no-fall game); omitted keeps the original value. Threaded to bullet integration
   * and the 2D navmesh too, not just physics — see specs/engine/README.md.
   */
  new (dimension?: '2d' | '3d', gravity?: number): EngineHandle;
}
