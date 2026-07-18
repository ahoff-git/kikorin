mod ballistic3d;
mod navmesh2d;
mod pathing;

use pathing::{HeavyJob, PathingShared, PendingPromotion};

use bincode::{Decode, Encode};
use ecs::{
    ColliderConfig, DirtyFlags, World, NET_BULLET, NET_LOCAL, NET_LOW_URGENCY, NET_MONSTER,
    NET_PREDICTABLE, NET_PUBLIC_MASK, NET_REPLICATED,
};

// World gravity (m/s²). Bullets integrate the same constant so their arcs match
// Rapier-simulated bodies.
const GRAVITY: f32 = -20.0;

// Bullet maximum lifetime in ticks (~2.4 s at the 4 ms sim step).
const BULLET_MAX_FRAMES: u32 = 600;
// Bullets below this Y are dead (fell out of the map).
const BULLET_KILL_PLANE_Y: f32 = -20.0;
// Post-bounce offset along the surface normal so the reflected bullet doesn't
// start embedded in the surface it just hit.
const BULLET_BOUNCE_OFFSET: f32 = 0.02;

use netcode::{DeltaTracker, WireEvent};
use patch::{
    HitPatch, LifecycleKind, LifecyclePatch, MetricsPatch, NetEventKind, NetPatch, PatchBundle,
    PatchGenerator,
};
use pathfinding::{NavMesh, NavMeshConfig, PathRequest, Waypoint};
use physics::{Dimension, PhysicsWorld};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const BULLET_HIT_RADIUS_SQ: f32 = 1.2 * 1.2;

// Monster goal-reached epsilon: closer than this and the monster stops instead
// of steering.
const GOAL_REACHED_EPSILON: f32 = 0.001;
// Initial replan cooldowns are staggered by entity ID across this many buckets
// so a freshly spawned crowd doesn't request A* on the same tick.
const REPLAN_STAGGER_BUCKETS: u32 = 30;
// A vertical speed above this marks a jump frame — separation skips those so it
// doesn't fight the impulse.
const JUMP_FRAME_VY_THRESHOLD: f32 = 0.1;
// Terrain layers scanned per navmesh column before giving up (stacked platforms).
const MAX_TERRAIN_LAYERS_PER_COLUMN: usize = 8;
// Height above the taller of two candidate navmesh nodes at which the lateral
// wall-obstruction probe (see `horizontally_blocked`) is cast. Above either
// node's own walkable surface (so a legitimate step-up/stair edge, whose
// riser tops out at the tread's own height, is never mistaken for a wall)
// but well below any standing wall's top.
const WALL_PROBE_CLEARANCE: f32 = 0.15;

// The WebRTC transport has no disconnect callback, so liveness is inferred from
// traffic: a peer silent for longer than this (sim time) is dropped and its
// mirrors despawned. Peers Ping when otherwise idle, so a healthy connection is
// never silent for more than PING_INTERVAL_SECS.
const PEER_TIMEOUT_SECS: f32 = 5.0;
const PING_INTERVAL_SECS: f32 = 1.0;

// Replication cadence by urgency/predictability, in ticks (~4 ms each).
// Default (unpredictable, e.g. player input): every tick. NET_LOW_URGENCY
// background actors: ~16 Hz. NET_PREDICTABLE entities ride receiver-side
// extrapolation and only need drift corrections (~8 Hz) plus engine-forced
// updates at discontinuities (bullet bounces).
const LOW_URGENCY_STRIDE: u64 = 15;
const PREDICTABLE_STRIDE: u64 = 30;

// --- Game tuning configs ---
// Defaults are engine-provided; games override them via set_ai_config / set_nav_config
// with a (possibly partial) JS object. Missing fields fall back to these defaults —
// not to previously set values.

/// Monster AI tuning: movement, jumping, replanning, stuck detection, separation.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub walk_speed: f32,
    /// When false, monsters route around jump edges (or fail to path).
    pub can_jump: bool,
    pub jump_speed: f32,
    /// Sprint approach speed for Tier-4 discovered edges — engine-global
    /// like jump_speed (see ADR 0011).
    pub sprint_speed: f32,
    /// Jump budget between groundings (2 = double jump) — must match whatever
    /// capability the navmesh was built for (`build_navmesh`'s implicit 1, or
    /// `build_navmesh_2d`'s explicit `max_jumps` argument), the same way
    /// PlayerConfig::max_jumps must match the player's own jump capability.
    /// A mismatch either strands a monster mid-air (mesh assumes more jumps
    /// than this grants) or needlessly routes around gaps it could clear.
    pub max_jumps: u32,
    pub jump_trigger_dist: f32,
    pub jump_cooldown: f32,
    pub jump_height_tolerance: f32,
    pub waypoint_reach: f32,
    pub replan_stale_dist: f32,
    pub replan_cooldown: f32,
    pub stuck_sample_interval: f32,
    pub stuck_move_threshold: f32,
    pub stuck_escape_after: f32,
    pub separation_radius: f32,
    /// Frustration escalation: with no goal-distance progress for this long,
    /// a monster drops its route (flow included), pierces its replan
    /// cooldown, and retries with route variety — see specs/engine.
    pub no_progress_after: f32,
    /// Minimum distance-to-goal improvement that counts as progress.
    pub progress_epsilon: f32,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            walk_speed: 2.5,
            can_jump: true,
            jump_speed: 13.0,
            sprint_speed: 5.0,
            max_jumps: 1,
            jump_trigger_dist: 2.5,
            jump_cooldown: 0.9,
            jump_height_tolerance: 0.5,
            waypoint_reach: 1.8,
            replan_stale_dist: 4.0,
            replan_cooldown: 3.0,
            stuck_sample_interval: 0.8,
            stuck_move_threshold: 0.5,
            stuck_escape_after: 1.6,
            separation_radius: 2.0,
            no_progress_after: 2.0,
            progress_epsilon: 0.25,
        }
    }
}

/// Per-monster override of the subset of `AiConfig` that's safe to vary
/// against a navmesh built for one canonical capability. `jump_speed` and
/// `max_jumps` are deliberately NOT here and stay engine-global (`AiConfig`)
/// — the navmesh's edges are computed once assuming one jump impulse/budget,
/// so a monster with a weaker jump than the mesh assumed could get routed
/// onto a gap it can't actually clear (see ADR 0006/0008 for the class of
/// bug that already caused). `walk_speed` never changes which edges are
/// reachable, only how fast a monster crosses them — always safe to vary.
/// `can_jump: false` is safe in that direction too: `find_path`'s existing
/// `can_jump` argument already routes around jump edges entirely, so a
/// monster given this never gets offered a path it can't walk.
/// `can_fly` sidesteps the whole question: a flying monster skips the
/// navmesh/pathfinding system entirely (see `tick_monster_ai`).
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct MonsterCapability {
    pub walk_speed: f32,
    pub can_jump: bool,
    /// Unlocks `requires_sprint` edges (Tier-4 promotions) — see ADR 0011.
    pub can_sprint: bool,
    /// Incorporeal: passes through walls, unlocks phase edges (ADR 0013).
    pub can_phase: bool,
    pub can_fly: bool,
}

impl Default for MonsterCapability {
    fn default() -> Self {
        Self {
            walk_speed: AiConfig::default().walk_speed,
            can_jump: AiConfig::default().can_jump,
            can_sprint: false,
            can_phase: false,
            can_fly: false,
        }
    }
}

/// Navmesh build tuning: cell resolution and agent traversal capabilities.
/// Mesh bounds are not configured — they are derived from the loaded floor geometry.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct NavConfig {
    pub cell_size: f32,
    pub max_step_up: f32,
    pub jump_threshold: f32,
    pub min_ledge_drop: f32,
    pub max_ledge_drop: f32,
    pub corner_drop_tolerance: f32,
}

impl Default for NavConfig {
    fn default() -> Self {
        Self {
            cell_size: 1.5,
            max_step_up: 1.3,
            jump_threshold: 0.5,
            min_ledge_drop: 1.4,
            max_ledge_drop: 12.0,
            corner_drop_tolerance: 0.25,
        }
    }
}

/// Player controller + combat tuning. Game-supplied like AiConfig; the engine
/// owns the mechanics (movement, jumping, firing, damage), the game the numbers.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct PlayerConfig {
    pub walk_speed: f32,
    /// Yaw rate for the turn axis, radians/second.
    pub turn_speed: f32,
    pub jump_speed: f32,
    /// Jump budget between groundings (2 = double jump).
    pub max_jumps: u32,
    pub bullet_speed: f32,
    /// Bullet muzzle offset from the player center, along facing / up.
    pub bullet_spawn_forward: f32,
    pub bullet_spawn_up: f32,
    pub bullet_damage: i32,
}

impl Default for PlayerConfig {
    fn default() -> Self {
        Self {
            walk_speed: 15.0,
            turn_speed: 1.8,
            jump_speed: 12.0,
            max_jumps: 2,
            bullet_speed: 40.0,
            bullet_spawn_forward: 1.1,
            bullet_spawn_up: 0.4,
            bullet_damage: 50,
        }
    }
}

/// Monster population tuning: spawn template, ring placement, respawn policy.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct MonsterConfig {
    pub half_width: f32,
    pub half_height: f32,
    pub half_depth: f32,
    pub health: i32,
    pub net_flags: u8,
    /// spawn_monsters ring placement: radius = base + (i % steps) * step.
    pub spawn_y: f32,
    pub ring_base_radius: f32,
    pub ring_radius_step: f32,
    pub ring_steps: u32,
    /// When true, a killed monster respawns at a random ring position.
    pub respawn: bool,
    pub respawn_radius_min: f32,
    pub respawn_radius_max: f32,
    pub respawn_y: f32,
}

impl Default for MonsterConfig {
    fn default() -> Self {
        Self {
            half_width: 0.4,
            half_height: 0.9,
            half_depth: 0.4,
            health: 50,
            net_flags: NET_LOCAL | NET_MONSTER | NET_REPLICATED | NET_LOW_URGENCY,
            spawn_y: 5.0,
            ring_base_radius: 10.0,
            ring_radius_step: 4.0,
            ring_steps: 3,
            respawn: true,
            respawn_radius_min: 30.0,
            respawn_radius_max: 40.0,
            respawn_y: 10.0,
        }
    }
}

/// Raw player input state, sent by the UI layer each frame; the engine consumes
/// the latest every tick. TS owns only the key/mouse mapping that produces it.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PlayerInput {
    /// −1..1 forward/back axis, relative to the player's yaw.
    pub forward: f32,
    /// −1..1 strafe axis (positive = left).
    pub strafe: f32,
    /// −1..1 turn axis, integrated at turn_speed. Ignored while yaw_override set.
    pub turn: f32,
    /// Absolute yaw (radians) when the camera drives facing (pointer lock).
    pub yaw_override: Option<f32>,
    /// Held state; the engine edge-detects for the jump budget.
    pub jump_held: bool,
    /// Aim pitch (radians) — owned by the UI's look controls; used for firing.
    pub aim_pitch: f32,
}

struct PlayerState {
    eid: u32,
    yaw: f32,
    jumps_used: u32,
    prev_jump_held: bool,
    input: PlayerInput,
}

/// One static terrain block as supplied by the game's map data.
/// `kind` is passed through untouched for the game's own mesh styling.
/// `walkable: false` (walls, decorative geometry) keeps the block solid for
/// physics but excludes its top surface from navmesh node placement — otherwise
/// a grid cell landing on a wall top creates unreachable nodes, and a goal that
/// snaps to one makes every A* search fail after exploring the whole mesh.
#[derive(Clone, Debug, Deserialize)]
pub struct MapBlock {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub hw: f32,
    pub hh: f32,
    pub hd: f32,
    pub kind: String,
    #[serde(default = "default_walkable")]
    pub walkable: bool,
}

fn default_walkable() -> bool {
    true
}

// --- Timing helper ---

// performance.now() (µs resolution) rather than Date.now() (ms resolution): sim steps
// are ~4 ms, so per-system timings need sub-millisecond precision to be meaningful.
// Resolved once per thread; works in both window and worker global scopes.
#[cfg(target_arch = "wasm32")]
thread_local! {
    static PERFORMANCE: Option<web_sys::Performance> = {
        use wasm_bindgen::JsCast;
        js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance"))
            .ok()
            .and_then(|p| p.dyn_into::<web_sys::Performance>().ok())
    };
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    PERFORMANCE.with(|p| p.as_ref().map_or_else(js_sys::Date::now, |p| p.now()))
}

struct Timer {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    start_ms: f64,
}

impl Timer {
    fn new() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        {
            Self {
                start: std::time::Instant::now(),
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            Self { start_ms: now_ms() }
        }
    }

    fn elapsed_ms(&self) -> f32 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_secs_f32() * 1000.0
        }
        #[cfg(target_arch = "wasm32")]
        {
            (now_ms() - self.start_ms) as f32
        }
    }
}

// --- Per-monster path following state ---

/// What a monster is currently following — the three route shapes the
/// layered pathfinding system produces (see specs/engine, ADR 0011).
enum ActiveRoute {
    /// A route this monster owns (Tier-2 A* or a Tier-3 key plan).
    Owned { path: Vec<Waypoint>, index: usize },
    /// A read-only snapshot of another monster's pooled route.
    Spliced { route: std::rc::Rc<pathing::SharedRoute>, index: usize },
    /// Shared flow field — no owned waypoints; next hop looked up per tick.
    Flow { key: pathing::FlowKey },
}

/// Chain flow hops into one steering target safely beyond `reach` — a
/// single adjacent-node hop (cell_size 1.5 < waypoint_reach 1.8) is
/// instantly "reached" by follow_slice and would collapse flow following
/// into direct pursuit. Chains break at jump/sprint/ledge hops so jump
/// timing still happens at the correct node.
fn flow_target(
    mesh: &NavMesh,
    field: &pathfinding::FlowField,
    start: pathfinding::NodeId,
    reach: f32,
) -> Option<Waypoint> {
    const MAX_CHAIN: usize = 8;
    let mut node = start;
    let mut acc = 0.0_f32;
    let mut last: Option<Waypoint> = None;
    let mut last_pos = mesh.node_position(start)?;
    for _ in 0..MAX_CHAIN {
        let Some(hop) = field.next_hop(node) else { break };
        let p = mesh.node_position(hop.to)?;
        let wp = Waypoint {
            x: p[0],
            y: p[1],
            z: p[2],
            requires_jump: hop.requires_jump,
            requires_sprint: hop.requires_sprint,
            requires_phase: hop.requires_phase,
            is_ledge_drop: hop.is_ledge_drop,
        };
        if hop.requires_jump || hop.requires_sprint || hop.is_ledge_drop {
            // The special hop itself when it's next; otherwise stop just
            // before it so it becomes "next" once the flat run is walked.
            return Some(last.unwrap_or(wp));
        }
        acc += ((p[0] - last_pos[0]).powi(2) + (p[2] - last_pos[2]).powi(2)).sqrt();
        last_pos = p;
        last = Some(wp);
        if acc > reach * 1.5 {
            break;
        }
        node = hop.to;
    }
    last
}

impl ActiveRoute {
    fn owned(path: Vec<Waypoint>) -> Self {
        ActiveRoute::Owned { path, index: 0 }
    }

    fn last_waypoint(&self) -> Option<&Waypoint> {
        match self {
            ActiveRoute::Owned { path, .. } => path.last(),
            ActiveRoute::Spliced { route, .. } => route.waypoints.last(),
            ActiveRoute::Flow { .. } => None,
        }
    }
}

struct MonsterState {
    route: Option<ActiveRoute>,
    replan_cooldown: f32,
    jump_cooldown: f32,
    /// Jumps used since last grounded — mirrors PlayerState::jumps_used.
    /// Reset in `follow_slice` whenever `grounded` is true.
    jumps_used: u32,
    stuck_timer: f32,
    last_sample_x: f32,
    last_sample_z: f32,
    stuck_sample_timer: f32,
    /// Per-monster goal override (set_monster_goal); None = the engine-wide
    /// default goal (update_monster_goal).
    goal: Option<[f32; 2]>,
    // Frustration escalation (specs/engine): moving-but-not-closing
    // detection — complements the stuck sampler, which only catches
    // zero movement.
    progress_goal: [f32; 2],
    best_goal_dist: f32,
    progress_timer: f32,
    frustration: u32,
}

impl MonsterState {
    fn new(initial_replan_cooldown: f32) -> Self {
        Self {
            route: None,
            replan_cooldown: initial_replan_cooldown,
            jump_cooldown: 0.0,
            jumps_used: 0,
            stuck_timer: 0.0,
            last_sample_x: f32::INFINITY,
            last_sample_z: f32::INFINITY,
            stuck_sample_timer: 0.0,
            goal: None,
            progress_goal: [f32::INFINITY, f32::INFINITY],
            best_goal_dist: f32::INFINITY,
            progress_timer: 0.0,
            frustration: 0,
        }
    }

    /// True when this monster should escalate: no goal-distance improvement
    /// (beyond `progress_epsilon`) for `no_progress_after` seconds. A goal
    /// that itself jumped (player fled/teleported) re-baselines instead of
    /// counting as failure; real progress clears frustration entirely.
    fn update_progress(&mut self, ai: &AiConfig, dt_secs: f32, dist: f32, goal: [f32; 2]) -> bool {
        let goal_moved = (goal[0] - self.progress_goal[0])
            .hypot(goal[1] - self.progress_goal[1])
            > ai.replan_stale_dist;
        if goal_moved || dist + ai.progress_epsilon < self.best_goal_dist {
            self.progress_goal = goal;
            self.best_goal_dist = dist;
            self.progress_timer = 0.0;
            if !goal_moved {
                self.frustration = 0;
            }
            return false;
        }
        self.progress_timer += dt_secs;
        if self.progress_timer >= ai.no_progress_after {
            self.progress_timer = 0.0;
            self.best_goal_dist = dist;
            self.frustration = (self.frustration + 1).min(8);
            return true;
        }
        false
    }

    /// Decay cooldowns, run stuck sampling, and decide whether this monster
    /// should replan this tick. A stuck escape (no movement across enough
    /// samples) drops the path and zeroes the cooldown so the next check
    /// replans immediately. When the shared per-tick A* budget is spent
    /// (`replan_budget_available == false`), the cooldown is left untouched so
    /// the monster retries next tick instead of losing its turn.
    #[allow(clippy::too_many_arguments)]
    fn update_stuck_and_replan(
        &mut self,
        ai: &AiConfig,
        dt_secs: f32,
        mx: f32,
        mz: f32,
        goal_x: f32,
        goal_z: f32,
        replan_budget_available: bool,
    ) -> bool {
        self.jump_cooldown = (self.jump_cooldown - dt_secs).max(0.0);

        self.stuck_sample_timer += dt_secs;
        if self.stuck_sample_timer >= ai.stuck_sample_interval {
            self.stuck_sample_timer = 0.0;
            let moved =
                ((mx - self.last_sample_x).powi(2) + (mz - self.last_sample_z).powi(2)).sqrt();
            if moved < ai.stuck_move_threshold {
                self.stuck_timer += ai.stuck_sample_interval;
                if self.stuck_timer >= ai.stuck_escape_after {
                    self.route = None;
                    self.replan_cooldown = 0.0;
                    self.stuck_timer = 0.0;
                }
            } else {
                self.stuck_timer = 0.0;
            }
            self.last_sample_x = mx;
            self.last_sample_z = mz;
        }

        self.replan_cooldown = (self.replan_cooldown - dt_secs).max(0.0);

        let path_stale = match self.route.as_ref().and_then(|r| r.last_waypoint()) {
            Some(wp) => {
                ((goal_x - wp.x).powi(2) + (goal_z - wp.z).powi(2)).sqrt() > ai.replan_stale_dist
            }
            None => true,
        };

        if path_stale && self.replan_cooldown <= 0.0 && replan_budget_available {
            self.replan_cooldown = ai.replan_cooldown;
            true
        } else {
            false
        }
    }

    /// Advance past reached waypoints in `wps` (index is caller-owned so any
    /// route shape can drive this), then return the desired XZ direction,
    /// jump/sprint intent, and whether the slice is exhausted — exhaustion
    /// policy (drop route, zero cooldown) is the caller's, since it differs
    /// per route shape. Falls back to the direct goal bearing when exhausted.
    ///
    /// Multi-jump waypoints use apex-timed re-triggering (ADR 0008): first
    /// jump only when grounded; later jumps only airborne past the apex
    /// (vy ≤ 0), up to `AiConfig::max_jumps`, budget reset when grounded.
    #[allow(clippy::too_many_arguments)]
    fn follow_slice(
        &mut self,
        ai: &AiConfig,
        wps: &[Waypoint],
        index: &mut usize,
        mx: f32,
        mz: f32,
        foot_y: f32,
        grounded: bool,
        vy: f32,
        goal_dir: [f32; 2],
    ) -> (f32, f32, bool, bool, bool) {
        if grounded {
            self.jumps_used = 0;
        }

        while *index < wps.len() {
            let wp = &wps[*index];
            if (wp.x - mx).hypot(wp.z - mz) >= ai.waypoint_reach {
                break;
            }
            if wp.requires_jump && foot_y < wp.y - ai.jump_height_tolerance {
                break;
            }
            *index += 1;
        }

        if *index >= wps.len() {
            return (goal_dir[0], goal_dir[1], false, false, true);
        }

        let wp = &wps[*index];
        let wp_dx = wp.x - mx;
        let wp_dz = wp.z - mz;
        let wp_dist = (wp_dx * wp_dx + wp_dz * wp_dz).sqrt();
        let dir_x = if wp_dist > 0.0 { wp_dx / wp_dist } else { goal_dir[0] };
        let dir_z = if wp_dist > 0.0 { wp_dz / wp_dist } else { goal_dir[1] };
        let is_first_jump = self.jumps_used == 0;
        // First jump throttled by jump_cooldown; later jumps of the same
        // airborne sequence are apex-timed instead (the cooldown would still
        // be running and must not block them) — ADR 0008.
        let cooldown_ready = !is_first_jump || self.jump_cooldown <= 0.0;
        let airborne_and_past_apex = !grounded && vy <= 0.0;
        let can_jump_now = if is_first_jump { grounded } else { airborne_and_past_apex };
        let wants_jump = wp.requires_jump
            && cooldown_ready
            && can_jump_now
            && self.jumps_used < ai.max_jumps
            && wp_dist < ai.jump_trigger_dist;
        if wants_jump {
            if is_first_jump {
                self.jump_cooldown = ai.jump_cooldown;
            }
            self.jumps_used += 1;
        }
        // Sprint approach: cross the whole segment toward a sprint waypoint
        // at sprint speed, or the arc falls short (ADR 0011).
        (dir_x, dir_z, wants_jump, wp.requires_sprint, false)
    }
}

// --- WASM-bindgen public API ---

/// Top-level engine exposed to JavaScript. One instance per page load.
#[wasm_bindgen]
pub struct Engine {
    world: World,
    physics: PhysicsWorld,
    // Per-instance gravity, set once at construction (defaults to GRAVITY).
    // Every consumer that needs "how strong is gravity" reads this, not the
    // bare constant, so a zero-gravity instance is consistent everywhere —
    // physics, bullet ballistic integration, and the 2D navmesh's jump-
    // reachability math all agree.
    gravity: f32,
    navmesh: Option<NavMesh>,
    // Layered-pathfinding shared state (specs/engine, ADR 0011).
    pathing: PathingShared,
    delta_tracker: DeltaTracker,
    patch_gen: PatchGenerator,
    // Transport bridge: the game layer (main thread) owns the actual WebRTC
    // connections — RTCPeerConnection does not exist in workers — and shuttles
    // bytes/peer events through these queues via the net_* API. The engine
    // owns the protocol on top.
    inbound_net: Vec<(String, Vec<u8>)>,
    new_net_peers: Vec<String>,
    dropped_net_peers: Vec<String>,
    // (target, payload); target None = broadcast to every connected peer.
    outbound_net: Vec<(Option<String>, Vec<u8>)>,
    last_metrics: MetricsPatch,
    // Pre-computed list of NET_LOCAL entity IDs — updated on spawn/destroy.
    local_entities: Vec<u32>,
    // Remote-entity mirrors: (peer, remote eid) → local mirror eid, plus the
    // reverse map for cleanup. Remote ids live in the SENDER's id space and
    // would collide with local ids if applied directly.
    remote_mirrors: HashMap<(String, u32), u32>,
    mirror_owner: HashMap<u32, (String, u32)>,
    // Public flag profile received with each mirror's Spawn (NET_PUBLIC_MASK
    // bits only). Kept out of the world's net_flags so engine systems never
    // treat mirrors as simulatable entities.
    mirror_flags: HashMap<u32, u8>,
    // Accumulated sim time (sum of tick dt) — drives peer timeouts/keepalive.
    sim_time: f32,
    peer_last_seen: HashMap<String, f32>,
    last_broadcast_time: f32,
    // Locally-owned entities destroyed since the last flush; announced to peers
    // as Despawned events so their mirrors don't linger.
    pending_despawns: Vec<u32>,
    // Per-monster AI state — populated when a NET_MONSTER entity is spawned.
    monster_states: HashMap<u32, MonsterState>,
    // Per-monster capability override (set_monster_capability); absent =
    // derive from the current AiConfig (see capability_for).
    monster_capabilities: HashMap<u32, MonsterCapability>,
    // Animation: one game-loaded definition set (load_animations) plus a
    // per-entity playback instance. None set = animation inert (no cell emitted).
    // The state machine lives in `crates/animation`; the engine owns the
    // instances and drives them each tick (ADR 0015).
    animation_set: Option<animation::AnimationSet>,
    animation_states: HashMap<u32, animation::AnimationInstance>,
    // Entities playing a death animation before despawn (ADR 0020): excluded from
    // AI, separation, and bullet targeting until the animation finishes.
    dying: std::collections::HashSet<u32>,
    // Age counter (in ticks) for each NET_BULLET entity — used for TTL enforcement.
    bullet_ages: HashMap<u32, u32>,
    // Jump impulses latched by set_entity_velocity (non-zero vy) awaiting the next
    // physics step. A dedicated latch — not the world velocity field — because input
    // messages coalesce last-write-wins between ticks: when ticks run long, a queued
    // jump command followed by plain movement commands must still fire.
    pending_jumps: HashMap<u32, f32>,
    // Player position used as the monster pathfinding goal; updated each tick via
    // update_monster_goal(). Stored so the engine owns the loop, not the caller.
    goal_x: f32,
    goal_z: f32,
    // Game-supplied tuning; engine defaults until the set_*_config calls.
    ai: AiConfig,
    nav: NavConfig,
    player_cfg: PlayerConfig,
    monster_cfg: MonsterConfig,
    // The controller-driven player (register_player); None = no local player.
    player: Option<PlayerState>,
    // Local-entity lifecycle events queued for the next PatchBundle.
    pending_lifecycle: Vec<LifecyclePatch>,
    // LCG state for respawn scatter — deterministic, dependency-free.
    rng_state: u64,
    // Terrain entities whose top surface must not receive navmesh nodes (walls etc.).
    non_walkable_terrain: std::collections::HashSet<u32>,
    // Reusable scratch buffers for the per-tick hot loop. Cleared and refilled each tick
    // so the monster/bullet iteration lists don't heap-allocate every frame (~250 Hz).
    // Taken out via std::mem::take during use to satisfy the borrow checker, then returned
    // so the allocation capacity persists across ticks.
    scratch_ids: Vec<u32>,
    scratch_positions: Vec<[f32; 3]>,
    scratch_snapshots: Vec<(u32, [f32; 3])>,
    scratch_mirror_bullets: Vec<(u32, [f32; 3])>,
}

// Engine action kinds fed to the animation state machine (kind → family via the
// loaded AnimationSet's action map). Locomotion is derived each tick; attack is
// triggered by player_fire. hurt/death arrive with the Phase 3 combat work.
const ANIM_KIND_IDLE: u16 = 0;
const ANIM_KIND_WALK: u16 = 1;
const ANIM_KIND_ATTACK: u16 = 2;
const ANIM_KIND_HURT: u16 = 3;
const ANIM_KIND_DEATH: u16 = 4;

// Squared horizontal speed above which an animated entity reads as "walking".
const ANIM_WALK_EPS_SQ: f32 = 0.05;

// Frame-event ids the engine dispatches (ADR 0017). Games mark the matching
// frame in their animation defs; the engine maps the id to a gameplay action.
const ANIM_EVENT_FIRE: u16 = 1; // spawn the player's projectile

// --- load_animations boundary DTO: game-authored animation definitions ---
// The art (sheets/layers) stays in the TS manifest; this is the timing/behavior
// half loaded into the engine (the sprite analog of load_map). See ADR 0015.
#[derive(serde::Deserialize)]
struct JsAnimFrame {
    optimal_ms: f32,
    #[serde(default)]
    min_ms: Option<f32>,
    #[serde(default)]
    max_ms: Option<f32>,
    #[serde(default)]
    skippable: bool,
    #[serde(default)]
    cancelable: bool,
    #[serde(default)]
    event: Option<u16>,
}

#[derive(serde::Deserialize)]
struct JsAnimFamily {
    frames: Vec<JsAnimFrame>,
    #[serde(default)]
    looping: bool,
    #[serde(default)]
    next: Option<usize>,
    #[serde(default)]
    hold_last: bool,
    #[serde(default = "default_interrupt")]
    interrupt: String,
    #[serde(default)]
    branch_frame: Option<usize>,
    /// Movement permitted while this family plays; absent = everything (ADR 0018).
    #[serde(default)]
    movement: Option<JsMoveMask>,
    /// Re-requesting this family while it plays restarts it (combo). Default false.
    #[serde(default)]
    retriggerable: bool,
}

fn default_interrupt() -> String {
    "always".to_string()
}

fn default_true() -> bool {
    true
}

/// Per-family movement permission (ADR 0018). Every field defaults to `true`, so
/// a family only lists what it *forbids* (e.g. `{ forward: false, jump: false }`).
#[derive(serde::Deserialize)]
struct JsMoveMask {
    #[serde(default = "default_true")]
    forward: bool,
    #[serde(default = "default_true")]
    strafe: bool,
    #[serde(default = "default_true")]
    turn: bool,
    #[serde(default = "default_true")]
    jump: bool,
    #[serde(default = "default_true")]
    crouch: bool,
}

#[derive(serde::Deserialize)]
struct JsAnimAction {
    kind: u16,
    #[serde(default)]
    variant: Option<u16>,
    family: usize,
}

#[derive(serde::Deserialize)]
struct JsAnimationSet {
    families: Vec<JsAnimFamily>,
    #[serde(default)]
    actions: Vec<JsAnimAction>,
}

/// Build an AnimationSet from the game's DTO, or None if it's malformed (logged)
/// — the engine then leaves animation inert rather than panicking mid-tick
/// (ADR 0019).
fn build_animation_set(dto: JsAnimationSet) -> Option<animation::AnimationSet> {
    let mut set = animation::AnimationSet::new();
    for fam in dto.families {
        let frames = fam
            .frames
            .into_iter()
            .map(|f| {
                let optimal = f.optimal_ms.max(0.0);
                animation::FrameSpec {
                    optimal_ms: optimal,
                    min_ms: f.min_ms.unwrap_or(optimal).clamp(0.0, optimal),
                    max_ms: f.max_ms.unwrap_or(optimal).max(optimal),
                    skippable: f.skippable,
                    cancelable: f.cancelable,
                    hitbox: None,
                    hurtbox: None,
                    event: f.event,
                }
            })
            .collect();
        let interrupt = match fam.interrupt.to_ascii_lowercase().as_str() {
            "block" => animation::Interrupt::Block,
            "queue" => animation::Interrupt::Queue,
            _ => animation::Interrupt::Always,
        };
        let move_mask = fam.movement.map_or(animation::MoveMask::ALL, |m| animation::MoveMask {
            forward: m.forward,
            strafe: m.strafe,
            turn: m.turn,
            jump: m.jump,
            crouch: m.crouch,
        });
        set.push_family(animation::Family {
            frames,
            looping: fam.looping,
            next: fam.next,
            hold_last: fam.hold_last,
            interrupt,
            branch_frame: fam.branch_frame,
            move_mask,
            retriggerable: fam.retriggerable,
        });
    }
    for a in dto.actions {
        set.map_action(a.kind, a.variant, a.family);
    }
    match set.validate() {
        Ok(()) => Some(set),
        Err(e) => {
            log::warn!("load_animations: malformed animation set ignored ({e})");
            None
        }
    }
}

#[wasm_bindgen]
impl Engine {
    /// `dimension`: `"2d"` (case-insensitive) selects Rapier2D; anything else
    /// (including omitted/`None`, from JS calling `new Engine()`) keeps the
    /// original Rapier3D behavior. A setup-time choice only — fixed for this
    /// engine instance's lifetime, and orthogonal to game logic (player
    /// controller/monster AI/bullets are unchanged either way; see
    /// crates/physics's Dimension for exactly what "2D" means physically).
    /// `gravity`: overrides the engine-wide gravity constant for this
    /// instance (e.g. `Some(0.0)` for a top-down, no-fall game); omitted/
    /// `None` keeps the original value. Threaded to every consumer that
    /// cares — physics, bullet ballistic integration, and the 2D navmesh's
    /// jump-reachability math all read `self.gravity`, not the bare constant.
    #[wasm_bindgen(constructor)]
    pub fn new(dimension: Option<String>, gravity: Option<f32>) -> Engine {
        #[cfg(target_arch = "wasm32")]
        {
            use log::Level;
            let _ = console_log::init_with_level(Level::Warn);
            console_error_panic_hook::set_once();
        }

        let dimension = match dimension.as_deref() {
            Some(s) if s.eq_ignore_ascii_case("2d") => Dimension::TwoD,
            _ => Dimension::ThreeD,
        };
        let gravity = gravity.unwrap_or(GRAVITY);

        Engine {
            world: World::new(1024),
            physics: PhysicsWorld::new(gravity, dimension),
            gravity,
            navmesh: None,
            pathing: PathingShared::new(),
            delta_tracker: DeltaTracker::new(),
            patch_gen: PatchGenerator::new(),
            inbound_net: Vec::new(),
            new_net_peers: Vec::new(),
            dropped_net_peers: Vec::new(),
            outbound_net: Vec::new(),
            last_metrics: MetricsPatch::default(),
            local_entities: Vec::new(),
            remote_mirrors: HashMap::new(),
            mirror_owner: HashMap::new(),
            mirror_flags: HashMap::new(),
            sim_time: 0.0,
            peer_last_seen: HashMap::new(),
            last_broadcast_time: 0.0,
            pending_despawns: Vec::new(),
            monster_states: HashMap::new(),
            monster_capabilities: HashMap::new(),
            animation_set: None,
            animation_states: HashMap::new(),
            dying: std::collections::HashSet::new(),
            bullet_ages: HashMap::new(),
            pending_jumps: HashMap::new(),
            goal_x: 0.0,
            goal_z: 0.0,
            ai: AiConfig::default(),
            nav: NavConfig::default(),
            player_cfg: PlayerConfig::default(),
            monster_cfg: MonsterConfig::default(),
            player: None,
            pending_lifecycle: Vec::new(),
            rng_state: 0x9E37_79B9_7F4A_7C15,
            non_walkable_terrain: std::collections::HashSet::new(),
            scratch_ids: Vec::new(),
            scratch_positions: Vec::new(),
            scratch_snapshots: Vec::new(),
            scratch_mirror_bullets: Vec::new(),
        }
    }

    /// Which physics backend this engine was constructed with — `"2d"` or
    /// `"3d"`. Introspection only; the choice was fixed at construction.
    pub fn dimension(&self) -> String {
        match self.physics.dimension() {
            Dimension::TwoD => "2d".to_string(),
            Dimension::ThreeD => "3d".to_string(),
        }
    }

    /// Update the fallback goal for monsters without a per-entity override,
    /// used only when no player exists yet to chase (no local player
    /// registered, no peers connected) — once at least one does, every such
    /// monster targets whichever player (local or a remote mirror) is
    /// currently closest to it instead. See `closest_player_position`.
    pub fn update_monster_goal(&mut self, gx: f32, gz: f32) {
        self.goal_x = gx;
        self.goal_z = gz;
    }

    /// Give one monster its own goal, overriding the default until cleared.
    /// No-op for entities without monster AI state.
    pub fn set_monster_goal(&mut self, id: u32, gx: f32, gz: f32) {
        if let Some(state) = self.monster_states.get_mut(&id) {
            state.goal = Some([gx, gz]);
        }
    }

    /// Revert a monster to the default goal.
    pub fn clear_monster_goal(&mut self, id: u32) {
        if let Some(state) = self.monster_states.get_mut(&id) {
            state.goal = None;
        }
    }

    /// Give one monster its own capability override (walk speed / can-jump /
    /// can-fly — see `MonsterCapability`'s doc comment for why `jump_speed`
    /// and `max_jumps` aren't here), overriding the engine-global `AiConfig`
    /// until cleared. Accepts a partial JS object; missing fields fall back
    /// to `MonsterCapability::default()` (not to the current `AiConfig`,
    /// same "missing = static default" convention every other partial
    /// config in this engine already uses). Invalid input is ignored with a
    /// warning.
    pub fn set_monster_capability(&mut self, id: u32, cfg: JsValue) {
        match serde_wasm_bindgen::from_value::<MonsterCapability>(cfg) {
            Ok(c) => {
                self.physics.set_phasing(id, c.can_phase);
                self.monster_capabilities.insert(id, c);
            }
            Err(e) => log::warn!("set_monster_capability: invalid config ignored: {e}"),
        }
    }

    /// Revert a monster to the engine-global AiConfig's capability.
    pub fn clear_monster_capability(&mut self, id: u32) {
        self.physics.set_phasing(id, false);
        self.monster_capabilities.remove(&id);
    }

    /// Override monster AI tuning. Accepts a partial JS object; missing fields fall
    /// back to engine defaults (not to previously set values). Invalid input is
    /// ignored with a warning.
    pub fn set_ai_config(&mut self, cfg: JsValue) {
        match serde_wasm_bindgen::from_value(cfg) {
            Ok(c) => self.ai = c,
            Err(e) => log::warn!("set_ai_config: invalid config ignored: {e}"),
        }
    }

    /// Override navmesh build tuning (same partial-object semantics as set_ai_config).
    /// Takes effect on the next load_map / build_navmesh call.
    pub fn set_nav_config(&mut self, cfg: JsValue) {
        match serde_wasm_bindgen::from_value(cfg) {
            Ok(c) => self.nav = c,
            Err(e) => log::warn!("set_nav_config: invalid config ignored: {e}"),
        }
    }

    /// Override player controller/combat tuning (partial-object semantics).
    pub fn set_player_config(&mut self, cfg: JsValue) {
        match serde_wasm_bindgen::from_value(cfg) {
            Ok(c) => self.player_cfg = c,
            Err(e) => log::warn!("set_player_config: invalid config ignored: {e}"),
        }
    }

    /// Override monster spawn/respawn tuning (partial-object semantics).
    pub fn set_monster_config(&mut self, cfg: JsValue) {
        match serde_wasm_bindgen::from_value(cfg) {
            Ok(c) => self.monster_cfg = c,
            Err(e) => log::warn!("set_monster_config: invalid config ignored: {e}"),
        }
    }

    /// Load the game's animation definitions: families (per-frame timing/flags,
    /// transitions, interruptibility, branch frame) plus the action→family map.
    /// This is the behavior half of the paper-doll system; the art (sheets,
    /// layers, cell size) stays in the TS manifest. Absent = animation inert
    /// (no cell emitted). See ADR 0015 / 0016.
    pub fn load_animations(&mut self, defs: JsValue) {
        match serde_wasm_bindgen::from_value::<JsAnimationSet>(defs) {
            Ok(dto) => {
                if let Some(set) = build_animation_set(dto) {
                    self.animation_set = Some(set);
                    // Existing instances hold family indices into the old set;
                    // drop them so a reload can't leave a stale index behind.
                    self.animation_states.clear();
                }
            }
            Err(e) => log::warn!("load_animations: invalid definitions ignored: {e}"),
        }
    }

    /// Register the player entity. From then on the engine runs its controller
    /// (facing, movement, jump budget) from set_player_input, fires its bullets
    /// via player_fire, and aims the default monster goal at it every tick.
    pub fn register_player(&mut self, eid: u32) {
        self.player = Some(PlayerState {
            eid,
            yaw: 0.0,
            jumps_used: 0,
            prev_jump_held: false,
            input: PlayerInput::default(),
        });
    }

    /// Latest raw input state from the UI (call once per frame). Invalid input
    /// is ignored with a warning.
    pub fn set_player_input(&mut self, input: JsValue) {
        match serde_wasm_bindgen::from_value(input) {
            Ok(i) => {
                if let Some(p) = self.player.as_mut() {
                    p.input = i;
                }
            }
            Err(e) => log::warn!("set_player_input: invalid input ignored: {e}"),
        }
    }

    /// Fire: with animations loaded, this only *requests* the attack action —
    /// the bullet spawns when the attack reaches its FIRE frame (drive_animation
    /// dispatch), keeping the shot locked to the strike regardless of animation
    /// speed. Without an animation set the bullet fires immediately (unchanged
    /// behavior for games that don't load animations, e.g. the 2D game fires via
    /// spawn_bullet directly and never calls this). See ADR 0017.
    pub fn player_fire(&mut self) {
        if self.animation_set.is_some() {
            if let Some(eid) = self.player.as_ref().map(|p| p.eid) {
                self.request_entity_action(eid, ANIM_KIND_ATTACK, None, None);
            }
        } else {
            self.fire_player_bullet();
        }
    }

    /// Spawn one bullet from the player along its current facing + aim pitch.
    /// Called either immediately (no animations) or on the attack's FIRE frame.
    fn fire_player_bullet(&mut self) {
        let cfg = self.player_cfg;
        let Some((eid, yaw, aim_pitch)) = self
            .player
            .as_ref()
            .map(|p| (p.eid, p.yaw, p.input.aim_pitch))
        else {
            return;
        };
        let Some(pos) = self.world.position(eid) else {
            return;
        };
        let (sin_y, cos_y) = (yaw.sin(), yaw.cos());
        let (sin_p, cos_p) = (aim_pitch.sin(), aim_pitch.cos());
        self.spawn_bullet(
            pos[0] + sin_y * cfg.bullet_spawn_forward,
            pos[1] + cfg.bullet_spawn_up,
            pos[2] + cos_y * cfg.bullet_spawn_forward,
            sin_y * cos_p * cfg.bullet_speed,
            sin_p * cfg.bullet_speed,
            cos_y * cos_p * cfg.bullet_speed,
            NET_REPLICATED | NET_PREDICTABLE,
        );
    }

    /// Spawn `count` monsters on a ring around the origin (placement/template
    /// from MonsterConfig). Each spawn surfaces as a lifecycle patch.
    pub fn spawn_monsters(&mut self, count: u32) {
        let cfg = self.monster_cfg;
        for i in 0..count {
            let angle = (i as f32 / count.max(1) as f32) * std::f32::consts::TAU;
            let radius =
                cfg.ring_base_radius + (i % cfg.ring_steps.max(1)) as f32 * cfg.ring_radius_step;
            self.spawn_box_entity(
                angle.cos() * radius,
                cfg.spawn_y,
                angle.sin() * radius,
                cfg.half_width,
                cfg.half_height,
                cfg.half_depth,
                cfg.health,
                cfg.net_flags,
            );
        }
    }

    /// Advance simulation by dt_ms milliseconds.
    /// Returns a PatchBundle as a JS object directly — no bincode round-trip.
    /// Thin WASM wrapper: the simulation itself lives in `tick_core` so native
    /// tests can execute full ticks without crossing the JsValue boundary.
    pub fn tick(&mut self, dt_ms: f64) -> JsValue {
        let tick_timer = Timer::new();
        let mut bundle = self.tick_core((dt_ms / 1000.0) as f32);

        // tick_ms is stamped here so it covers the whole call; the JsValue
        // conversion below cannot be self-timed — the worker measures it as
        // boundary_ms (observed call time minus tick_ms).
        bundle.metrics.tick_ms = tick_timer.elapsed_ms();
        self.last_metrics = bundle.metrics.clone();
        serde_wasm_bindgen::to_value(&JsPatch::from(bundle)).unwrap_or(JsValue::NULL)
    }

    /// Ensure an entity has an animation instance and request an action on it.
    /// No-op if no animation set is loaded. Split-borrows `animation_set`
    /// (immutable) and `animation_states` (mutable) — disjoint fields.
    fn request_entity_action(&mut self, eid: u32, kind: u16, variant: Option<u16>, target_ms: Option<f32>) {
        let Some(set) = self.animation_set.as_ref() else {
            return;
        };
        let family = set.family_for_action(kind, variant);
        self.animation_states
            .entry(eid)
            .or_insert_with(|| animation::AnimationInstance::new(set, family, target_ms))
            .request(set, family, target_ms);
    }

    /// Advance every animated entity's instance, derive locomotion, and write the
    /// resolved cell (family/frame/direction) into the world for patch emission.
    /// Rust is the source of truth for animation; TS only displays the cell.
    fn drive_animation(&mut self, dt_ms: f32) {
        if self.animation_set.is_none() {
            return;
        }
        let mut ids: Vec<u32> = Vec::with_capacity(self.monster_states.len() + 1);
        if let Some(p) = self.player.as_ref() {
            ids.push(p.eid);
        }
        ids.extend(self.monster_states.keys().copied());
        for eid in ids {
            self.animate_entity(eid, dt_ms);
        }

        // Despawn entities whose death animation has finished (ADR 0020).
        if !self.dying.is_empty() {
            let finished: Vec<u32> = self
                .dying
                .iter()
                .copied()
                .filter(|id| self.animation_states.get(id).is_none_or(|i| i.finished()))
                .collect();
            for id in finished {
                self.finish_death(id);
            }
        }
    }

    fn animate_entity(&mut self, eid: u32, dt_ms: f32) {
        // A dying entity holds its death animation (already requested) — don't
        // derive locomotion for it (ADR 0020). Otherwise pick idle/walk from
        // intended horizontal velocity (set by controller/AI before physics). A
        // one-shot like attack is Block/Queue, so this request is ignored until
        // it ends.
        if !self.dying.contains(&eid) {
            let moving = self
                .world
                .velocity(eid)
                .map(|v| v[0] * v[0] + v[2] * v[2] > ANIM_WALK_EPS_SQ)
                .unwrap_or(false);
            self.request_entity_action(eid, if moving { ANIM_KIND_WALK } else { ANIM_KIND_IDLE }, None, None);
        }

        let (frame, family, event) = {
            let Some(set) = self.animation_set.as_ref() else {
                return;
            };
            let Some(inst) = self.animation_states.get_mut(&eid) else {
                return;
            };
            let event = inst.advance(set, dt_ms);
            (inst.current_frame(), inst.family(), event)
        };
        let dir = self
            .world
            .rotation(eid)
            .map(|r| animation::direction_from_yaw(r[0]))
            .unwrap_or(0);
        let cell = ecs::AnimCell {
            anim_id: family as u16,
            frame: frame as u16,
            dir,
        };
        if self.world.anim_cell(eid) != Some(cell) {
            self.world.set_anim_cell(eid, cell);
            self.world.mark_dirty(eid, DirtyFlags::ANIM);
        }
        // Frame-synced gameplay hook: a frame the animation just entered can
        // trigger an engine action (ADR 0017).
        if let Some(ev) = event {
            self.on_anim_event(eid, ev);
        }
    }

    /// Dispatch a frame event to its gameplay action. The player's attack FIRE
    /// frame spawns the bullet, so the shot is locked to the strike frame.
    fn on_anim_event(&mut self, eid: u32, event: u16) {
        if event == ANIM_EVENT_FIRE && self.player.as_ref().is_some_and(|p| p.eid == eid) {
            self.fire_player_bullet();
        }
    }

    /// One full simulation tick: net in → AI → separation → physics → bullets →
    /// animation → net out → PatchBundle. Native-callable (no wasm types).
    fn tick_core(&mut self, dt_secs: f32) -> PatchBundle {
        log::debug!("tick {} — dt_secs={:.4}", self.world.tick_count(), dt_secs);
        self.sim_time += dt_secs;

        // 0. Tick-boundary graph mutations: Tier-4 promotions land before
        // any monster reads the navmesh this tick (ADR 0011).
        self.flush_promotions();

        // 1. Networking inbound: apply queued peer payloads to local mirror
        // entities, greet newly connected peers with a full snapshot (late
        // join), and drop disconnected or silent peers.
        let net_timer = Timer::new();
        let mut net_patches: Vec<NetPatch> = Vec::new();
        for (peer_id, bytes) in std::mem::take(&mut self.inbound_net) {
            self.ingest_peer_payload(&peer_id, &bytes, &mut net_patches);
        }
        let new_peers = std::mem::take(&mut self.new_net_peers);
        if !new_peers.is_empty() {
            let events = self.with_scratch_ids(|this, replicated| {
                Self::collect_by_flag(&this.world, NET_REPLICATED, replicated);
                this.delta_tracker.full_snapshot(&this.world, replicated)
            });
            let payload = (!events.is_empty()).then(|| netcode::encode_events(&events));
            for peer in new_peers {
                log::info!("peer connected: {peer} — sending {} full-sync events", events.len());
                self.peer_last_seen.insert(peer.clone(), self.sim_time);
                if let Some(p) = &payload {
                    self.outbound_net.push((Some(peer.clone()), p.clone()));
                }
                // Transport-level connection notice — lets the UI show the peer
                // before (or without) any entity data arriving.
                net_patches.push(NetPatch {
                    peer_id: peer,
                    entity: 0,
                    kind: NetEventKind::PeerJoined,
                    flags: None,
                });
            }
        }
        for peer in std::mem::take(&mut self.dropped_net_peers) {
            self.drop_peer(peer, &mut net_patches);
        }
        self.prune_timed_out_peers(&mut net_patches);
        self.extrapolate_predictable_mirrors(dt_secs);
        let mut net_ms = net_timer.elapsed_ms();

        // 2. Player controller (raw input → facing/movement/jump, monster goal
        // follows the player), then monster AI. Both run before physics so the
        // computed velocities feed into sync_from_world.
        let ai_timer = Timer::new();
        self.tick_player_controller(dt_secs);
        let pathfinding_ms = self.tick_monster_ai(dt_secs);

        // 2.25. Separation: adjust NET_MONSTER XZ velocities with soft repulsion forces so
        // monsters don't cluster. Also runs before physics.
        self.apply_monster_separation();
        let mut ai_ms = ai_timer.elapsed_ms();

        // 2.5. Physics step (consumes latched jump impulses — see step_physics).
        let physics_timer = Timer::new();
        self.step_physics(dt_secs);
        let physics_ms = physics_timer.elapsed_ms();

        // 3. Bullet update + hit detection, plus marking locally-owned entities dirty for
        // grounded/semantic delivery. Engine-owned system work — counted as AI time.
        let bullet_timer = Timer::new();
        let hits = self.tick_bullets(dt_secs);
        // Local entities re-dirty HEALTH each tick so grounded rides the
        // SemanticPatch (known workaround — see the engine spec).
        for &id in &self.local_entities {
            self.world.mark_dirty(id, DirtyFlags::HEALTH);
        }
        self.mark_replication_dirty();
        // Animation: advance each animated entity's state machine and emit the
        // resolved cell. Runs after movement/physics so locomotion reads the
        // tick's velocity and facing. Counted as AI time.
        self.drive_animation(dt_secs * 1000.0);
        ai_ms += bullet_timer.elapsed_ms();

        // 3.5. One bounded slice of background pathfinding work (flow-field
        // builds, key-route tables, Tier-4 discovery) — counted as AI time.
        let heavy_timer = Timer::new();
        self.run_heavy_slice();
        ai_ms += heavy_timer.elapsed_ms();

        // 4. Flush outbound deltas + despawns to all peers (plus a keepalive
        // Ping when otherwise silent — see PEER_TIMEOUT_SECS).
        let flush_timer = Timer::new();
        let outbound = self.collect_outbound_events();
        if !outbound.is_empty() {
            self.outbound_net
                .push((None, netcode::encode_events(&outbound)));
            self.last_broadcast_time = self.sim_time;
        }
        net_ms += flush_timer.elapsed_ms();

        // 5. Build the PatchBundle. patch_ms is stamped after generation so
        // consumers receive a real value; tick_ms is stamped by the wrapper.
        let patch_timer = Timer::new();
        let lifecycle = std::mem::take(&mut self.pending_lifecycle);
        let mut bundle = self.patch_gen.generate(
            &self.world,
            net_patches,
            hits,
            lifecycle,
            MetricsPatch {
                tick_ms: 0.0,
                ai_ms,
                physics_ms,
                pathfinding_ms,
                net_ms,
                patch_ms: 0.0,
            },
        );
        bundle.metrics.patch_ms = patch_timer.elapsed_ms();

        self.world.clear_dirty();
        self.world.advance_tick();

        bundle
    }

    /// Deserialize a PatchBundle byte array into a JS object.
    pub fn deserialize_patch(bytes: &[u8]) -> JsValue {
        match PatchGenerator::deserialize(bytes) {
            Ok(b) => serde_wasm_bindgen::to_value(&JsPatch::from(b)).unwrap_or(JsValue::NULL),
            Err(_) => JsValue::NULL,
        }
    }

    /// Return current tick metrics as a JS object.
    pub fn get_metrics(&self) -> JsValue {
        let m = &self.last_metrics;
        serde_wasm_bindgen::to_value(&JsMetrics {
            tick_ms: m.tick_ms,
            ai_ms: m.ai_ms,
            physics_ms: m.physics_ms,
            pathfinding_ms: m.pathfinding_ms,
            net_ms: m.net_ms,
            patch_ms: m.patch_ms,
        })
        .unwrap_or(JsValue::NULL)
    }

    /// Set log verbosity: 0=off, 1=error, 2=warn, 3=info, 4=debug.
    pub fn set_log_level(&mut self, _level: u8) {
        #[cfg(target_arch = "wasm32")]
        {
            let filter = match _level {
                0 => log::LevelFilter::Off,
                1 => log::LevelFilter::Error,
                2 => log::LevelFilter::Warn,
                3 => log::LevelFilter::Info,
                4 => log::LevelFilter::Debug,
                _ => log::LevelFilter::Trace,
            };
            log::set_max_level(filter);
        }
    }

    /// Initialize WebRTC peer networking (WASM only).
    // --- Transport bridge (net_*) ---
    // The game layer owns the WebRTC connections (PeerJS on the main thread —
    // workers have no RTCPeerConnection) and drives these.

    /// A peer's data channel opened. Queues a late-join full sync + PeerJoined.
    pub fn net_peer_connected(&mut self, peer_id: &str) {
        self.new_net_peers.push(peer_id.to_string());
    }

    /// A peer's data channel closed. Its mirrors despawn next tick (the silent
    /// timeout remains as a backstop for channels that die without closing).
    pub fn net_peer_disconnected(&mut self, peer_id: &str) {
        self.dropped_net_peers.push(peer_id.to_string());
    }

    /// Inbound payload from a peer; applied at the start of the next tick.
    pub fn net_ingest(&mut self, peer_id: &str, payload: &[u8]) {
        self.inbound_net.push((peer_id.to_string(), payload.to_vec()));
    }

    /// Everything the engine wants sent since the last call, as
    /// `[{ peer: string | null, data: Uint8Array }]` — null peer = broadcast.
    #[cfg(target_arch = "wasm32")]
    pub fn net_take_outbound(&mut self) -> JsValue {
        let items = js_sys::Array::new();
        for (peer, bytes) in self.take_outbound() {
            let obj = js_sys::Object::new();
            let peer_val = peer.map_or(JsValue::NULL, JsValue::from);
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("peer"), &peer_val);
            let _ = js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("data"),
                &js_sys::Uint8Array::from(&bytes[..]).into(),
            );
            items.push(&obj);
        }
        items.into()
    }

    /// Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
    pub fn spawn_entity(&mut self, payload: &[u8]) -> u32 {
        let Ok((bp, _)) =
            bincode::decode_from_slice::<EntityBlueprint, _>(payload, bincode::config::standard())
        else {
            return u32::MAX;
        };

        let id = self.world.create_entity();
        if let Some(pos) = bp.position {
            self.world.set_position(id, pos);
        }
        if let Some(flags) = bp.net_flags {
            self.world.set_net_flags(id, flags);
        }
        if let Some(hp) = bp.health {
            self.world.set_health(id, hp);
        }
        if let Some(cfg) = bp.collider {
            self.world.set_collider(
                id,
                ColliderConfig {
                    active: cfg.active,
                    sensor: cfg.sensor,
                    half_width: cfg.hw,
                    half_height: cfg.hh,
                    half_depth: cfg.hd,
                },
            );
        }
        self.register_spawned(id, bp.net_flags.unwrap_or(0));
        id
    }

    /// Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
    /// Bounds are derived from the loaded floor entities (AABB padded by one cell), so
    /// maps of any size and location work without engine changes.
    pub fn build_navmesh(&mut self) {
        let nav = self.nav;
        let cell_size = nav.cell_size;

        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_z = f32::INFINITY;
        let mut max_z = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for id in self.world.entities() {
            if !self.world.is_floor(id) {
                continue;
            }
            let Some([x, y, z]) = self.world.position(id) else {
                continue;
            };
            let Some(col) = self.world.collider(id) else {
                continue;
            };
            if !col.active {
                continue;
            }
            min_x = min_x.min(x - col.half_width);
            max_x = max_x.max(x + col.half_width);
            min_z = min_z.min(z - col.half_depth);
            max_z = max_z.max(z + col.half_depth);
            min_y = min_y.min(y - col.half_height);
            max_y = max_y.max(y + col.half_height);
        }
        if !min_x.is_finite() {
            // No floor geometry loaded — nothing to walk on.
            self.navmesh = None;
            return;
        }
        let min_x = min_x - cell_size;
        let max_x = max_x + cell_size;
        let min_z = min_z - cell_size;
        let max_z = max_z + cell_size;
        // Vertical probe window: just above the highest floor top down to just
        // below the lowest floor bottom — derived, like XZ, from the geometry.
        let scan_top = max_y + 1.0;
        let scan_bottom = min_y - 1.0;

        let cols = (((max_x - min_x) / cell_size).ceil() as usize).max(1);
        let rows = (((max_z - min_z) / cell_size).ceil() as usize).max(1);

        self.physics.sync_from_world(&self.world);
        self.physics.prepare_queries();

        let mut mesh = NavMesh::new(NavMeshConfig { cell_size });

        let mut node_grid: Vec<Option<pathfinding::NodeId>> = vec![None; cols * rows];
        let mut node_ys: Vec<f32> = Vec::new();

        for row in 0..rows {
            for col in 0..cols {
                let x = min_x + (col as f32 + 0.5) * cell_size;
                let z = min_z + (row as f32 + 0.5) * cell_size;
                if let Some(y) = self.walkable_height_at(x, z, scan_top, scan_bottom) {
                    let id = mesh.add_node(x, y, z);
                    debug_assert_eq!(id as usize, node_ys.len());
                    node_ys.push(y);
                    node_grid[row * cols + col] = Some(id);
                }
            }
        }

        let cardinal_dirs: &[(i32, i32)] = &[(0, 1), (0, -1), (1, 0), (-1, 0)];
        let diagonal_dirs: &[(i32, i32)] = &[(1, 1), (1, -1), (-1, 1), (-1, -1)];
        let dir_sets: &[(&[(i32, i32)], f32)] = &[
            (cardinal_dirs, cell_size),
            (diagonal_dirs, cell_size * std::f32::consts::SQRT_2),
        ];

        for row in 0..rows {
            for col in 0..cols {
                let from_id = match node_grid[row * cols + col] {
                    Some(id) => id,
                    None => continue,
                };
                let from_y = node_ys[from_id as usize];
                let from_x = min_x + (col as f32 + 0.5) * cell_size;
                let from_z = min_z + (row as f32 + 0.5) * cell_size;

                for &(dirs, base_cost) in dir_sets {
                    for &(dc, dr) in dirs {
                        let nc = col as i32 + dc;
                        let nr = row as i32 + dr;
                        if nc < 0 || nr < 0 || nc >= cols as i32 || nr >= rows as i32 {
                            continue;
                        }
                        let to_id = match node_grid[nr as usize * cols + nc as usize] {
                            Some(id) => id,
                            None => continue,
                        };
                        let to_y = node_ys[to_id as usize];
                        let height_diff = to_y - from_y;

                        let to_x = min_x + (nc as f32 + 0.5) * cell_size;
                        let to_z = min_z + (nr as f32 + 0.5) * cell_size;
                        if self.horizontally_blocked([from_x, from_y, from_z], [to_x, to_y, to_z]) {
                            // A wall severs this pair for normal movers, but
                            // an incorporeal one walks straight through —
                            // keep the connection as a phase edge (ADR 0013).
                            if height_diff.abs() <= nav.max_step_up {
                                mesh.add_phase_edge(from_id, to_id, base_cost);
                            }
                            continue;
                        }

                        if dc != 0 && dr != 0 {
                            let side_col_id = match node_grid[row * cols + nc as usize] {
                                Some(id) => id,
                                None => continue,
                            };
                            let side_row_id = match node_grid[nr as usize * cols + col] {
                                Some(id) => id,
                                None => continue,
                            };

                            let low_endpoint_y = from_y.min(node_ys[to_id as usize]);
                            let side_col_y = node_ys[side_col_id as usize];
                            let side_row_y = node_ys[side_row_id as usize];
                            if side_col_y + nav.corner_drop_tolerance < low_endpoint_y
                                || side_row_y + nav.corner_drop_tolerance < low_endpoint_y
                            {
                                continue;
                            }
                        }

                        if height_diff > nav.max_step_up {
                            continue;
                        }
                        if height_diff < -nav.max_ledge_drop {
                            continue;
                        }

                        let is_ledge_drop = height_diff < -nav.min_ledge_drop;
                        let requires_jump = !is_ledge_drop && height_diff > nav.jump_threshold;

                        let height_cost = if requires_jump {
                            height_diff * 0.5
                        } else if is_ledge_drop {
                            height_diff.abs() * 0.1
                        } else {
                            height_diff.max(0.0) * 0.3
                        };

                        mesh.add_edge(
                            from_id,
                            to_id,
                            base_cost + height_cost,
                            requires_jump,
                            is_ledge_drop,
                        );
                    }
                }
            }
        }

        log::debug!("build_navmesh: {} nodes", node_ys.len());
        self.navmesh = Some(mesh);
        self.pathing.reset_for_new_terrain();
    }

    /// Build (or rebuild) a 2D navmesh — the side-view platformer analogue of
    /// `build_navmesh`, kept as a separate entry point (see
    /// `crates/engine/src/navmesh2d.rs`) since 3D's single-surface-per-column
    /// scan silently loses geometry a 2D level actually needs. `walk_speed`/
    /// `jump_speed`/`max_jumps` describe whoever will traverse the mesh —
    /// passed in by the caller each time rather than read from any stored
    /// config, so the same level can serve movers with different
    /// capabilities without touching Rust. Stores into the same `self.navmesh`
    /// slot `build_navmesh` does; `find_path` queries it unchanged either way.
    pub fn build_navmesh_2d(&mut self, walk_speed: f32, jump_speed: f32, max_jumps: u32) {
        self.physics.sync_from_world(&self.world);
        self.physics.prepare_queries();
        let cap = navmesh2d::MovementCapability2D { walk_speed, jump_speed, max_jumps };
        self.navmesh = navmesh2d::build(&self.world, &self.physics, &self.non_walkable_terrain, &cap, self.gravity);
        self.pathing.reset_for_new_terrain();
    }

    /// Apply Tier-4 promotions at the tick boundary — never mid-tick while
    /// monsters are reading the graph (ADR 0011). Downstream caches rebuild:
    /// flow fields clear (rebuilt on demand); key-route tables re-enqueue.
    fn flush_promotions(&mut self) {
        if self.pathing.promotions.is_empty() {
            return;
        }
        let Some(mesh) = self.navmesh.as_mut() else {
            self.pathing.promotions.clear();
            return;
        };
        for p in self.pathing.promotions.drain(..) {
            mesh.upgrade_edge(p.from, p.to, p.cost, p.requires_sprint);
        }
        self.pathing.flow_fields.clear();
        self.pathing.queued_flow.clear();
        let caps: Vec<pathing::CapKey> = self.pathing.key_routes.keys().copied().collect();
        self.pathing.key_routes.clear();
        self.pathing.queued_caps.clear();
        let keys = self.navmesh.as_ref().expect("checked above").derive_key_nodes();
        for cap in caps {
            self.pathing.enqueue_key_routes(cap, keys.clone());
        }
    }

    /// One bounded slice of background pathfinding work per tick — the
    /// "slow tiers compute while fast tiers serve" lane (specs/engine).
    fn run_heavy_slice(&mut self) {
        let Some(job) = self.pathing.jobs.pop_front() else {
            return;
        };
        let timer = Timer::new();
        match job {
            HeavyJob::BuildFlowField { key } => {
                if self.navmesh.is_some() {
                    let field = self
                        .navmesh
                        .as_ref()
                        .expect("checked")
                        .flow_field_to_node(key.0, key.1, key.2, key.3);
                    self.pathing.insert_flow_field(key, field);
                } else {
                    self.pathing.queued_flow.remove(&key);
                }
            }
            HeavyJob::BuildKeyRoutes { cap, keys, mut fields } => {
                if let Some(mesh) = &self.navmesh {
                    if fields.len() < keys.len() {
                        let k = keys[fields.len()];
                        fields.push(mesh.flow_field_to_node(k, cap.0, cap.1, cap.2));
                    }
                    if fields.len() < keys.len() {
                        // One field per slice; requeue at the front so the
                        // build finishes before other jobs interleave.
                        self.pathing
                            .jobs
                            .push_front(HeavyJob::BuildKeyRoutes { cap, keys, fields });
                    } else {
                        if let Some(kr) = pathfinding::KeyRoutes::from_parts(keys, fields) {
                            self.pathing.key_routes.insert(cap, kr);
                        }
                        self.pathing.queued_caps.remove(&cap);
                    }
                } else {
                    self.pathing.queued_caps.remove(&cap);
                }
            }
            HeavyJob::DiscoverEdges { frontier, cursor } => {
                self.run_discover_slice(frontier, cursor)
            }
        }
        let elapsed = timer.elapsed_ms();
        self.pathing.tune_slice(elapsed);
    }

    /// One slice of the Tier-4 discovery sweep: real ballistic solving over
    /// candidate node pairs the mesh doesn't already connect, walk-speed
    /// profile first, sprint second (specs/engine, ADR 0011). Zero-gravity
    /// engines discover nothing (flight_time is None), by design.
    ///
    /// Sweeps FRONTIER nodes only (degree < 8 — where the walkable surface
    /// is interrupted; open floor can't anchor a vault), and skips pairs
    /// already connected within two hops without any raycast — both cuts
    /// are what make the sweep finish in ticks instead of tens of seconds.
    fn run_discover_slice(&mut self, mut frontier: Vec<pathfinding::NodeId>, mut cursor: usize) {
        let Some(mesh) = &self.navmesh else {
            self.pathing.discover_pending = false;
            return;
        };
        const FULL_DEGREE: usize = 8;
        if frontier.is_empty() && cursor == 0 {
            frontier = (0..mesh.node_count() as u32)
                .filter(|&id| mesh.non_phase_degree(id) < FULL_DEGREE)
                .collect();
        }

        let ai = self.ai;
        let g = self.gravity.abs();
        let reach = ballistic3d::max_reach(ai.jump_speed, ai.sprint_speed, g);
        let mut budget = self.pathing.slice_units;
        let mut found: Vec<PendingPromotion> = Vec::new();

        'outer: while cursor < frontier.len() && budget > 4 {
            let from_id = frontier[cursor];
            let Some(from) = mesh.node_position(from_id) else {
                cursor += 1;
                continue;
            };
            let cands = mesh.nodes_within(from[0], from[2], reach);
            // One ray-free window Dijkstra per frontier node: graph distance
            // to every candidate through EXISTING edges (None = severed).
            // The boring test below is a detour ratio, not reachability —
            // a wall you can walk around in 3× the distance still deserves
            // its vault.
            let graph_dist = Self::window_graph_distances(mesh, from_id, &cands);
            budget = budget.saturating_sub(4);
            for (ci, &cand) in cands.iter().enumerate() {
                if budget == 0 {
                    // Mid-node exit: resume at this node next slice (its
                    // earlier candidates re-check; promotion is idempotent).
                    break 'outer;
                }
                if cand == from_id
                    || mesh.non_phase_degree(cand) >= FULL_DEGREE
                    || mesh.has_non_phase_edge(from_id, cand)
                {
                    continue;
                }
                let Some(to) = mesh.node_position(cand) else { continue };
                let dist_xz =
                    ((to[0] - from[0]).powi(2) + (to[2] - from[2]).powi(2)).sqrt();
                if dist_xz < self.nav.cell_size {
                    continue;
                }
                let dy = to[1] - from[1];
                // Boring skip (no rays): a near-flat pair the existing graph
                // already serves without a serious detour is just walking —
                // promoting it would carpet open floors in fake jump edges.
                if dy.abs() <= self.nav.jump_threshold
                    && graph_dist[ci].is_some_and(|d| d <= dist_xz * 2.0)
                {
                    continue;
                }
                budget = budget.saturating_sub(8);
                for (speed, sprint) in [(ai.walk_speed, false), (ai.sprint_speed, true)] {
                    let Some(t) = ballistic3d::flight_time(dist_xz, dy, ai.jump_speed, speed, g)
                    else {
                        continue;
                    };
                    if !self.arc_is_clear(from, to, ai.jump_speed, t, g) {
                        break; // obstructed for both speeds: same arc endpoints
                    }
                    if sprint && !self.runway_is_clear(from, to, ai.sprint_speed) {
                        break;
                    }
                    found.push(PendingPromotion {
                        from: from_id,
                        to: cand,
                        cost: dist_xz + dy.max(0.0) * 0.5,
                        requires_sprint: sprint,
                    });
                    break; // walk-speed success covers sprint too
                }
            }
            cursor += 1;
        }

        let done = cursor >= frontier.len();
        self.pathing.promotions.extend(found);
        if done {
            self.pathing.discover_pending = false;
        } else {
            self.pathing.jobs.push_back(HeavyJob::DiscoverEdges { frontier, cursor });
        }
    }

    /// Ray-free graph distances from `from` to each candidate, through
    /// existing edges, restricted to the candidate window (plus `from`).
    /// Edge costs approximated by node-to-node euclidean distance — this
    /// feeds a detour *ratio*, not an exact cost. None = severed within the
    /// window (a wall or void cuts the local graph).
    fn window_graph_distances(
        mesh: &NavMesh,
        from: pathfinding::NodeId,
        cands: &[pathfinding::NodeId],
    ) -> Vec<Option<f32>> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        let mut index: HashMap<pathfinding::NodeId, usize> = HashMap::with_capacity(cands.len() + 1);
        for (i, &c) in cands.iter().enumerate() {
            index.insert(c, i);
        }
        let in_window = |id: pathfinding::NodeId| id == from || index.contains_key(&id);
        let mut dist: HashMap<pathfinding::NodeId, u32> = HashMap::with_capacity(cands.len() + 1);
        let mut heap = BinaryHeap::new();
        dist.insert(from, 0);
        heap.push(Reverse((0u32, from)));
        while let Some(Reverse((d, u))) = heap.pop() {
            if dist.get(&u).is_some_and(|&best| d > best) {
                continue;
            }
            let Some(up) = mesh.node_position(u) else { continue };
            for v in mesh.non_phase_targets(u) {
                if !in_window(v) {
                    continue;
                }
                let Some(vp) = mesh.node_position(v) else { continue };
                let step = ((vp[0] - up[0]).powi(2)
                    + (vp[1] - up[1]).powi(2)
                    + (vp[2] - up[2]).powi(2))
                .sqrt();
                let nd = d + (step * 100.0) as u32;
                if dist.get(&v).is_none_or(|&best| nd < best) {
                    dist.insert(v, nd);
                    heap.push(Reverse((nd, v)));
                }
            }
        }
        cands
            .iter()
            .map(|c| dist.get(c).map(|&d| d as f32 / 100.0))
            .collect()
    }

    /// Swept obstruction probe along the jump arc, lifted half a body above
    /// the surface; only static terrain blocks (a transient dynamic entity
    /// must not veto a permanent map fact).
    fn arc_is_clear(&self, from: [f32; 3], to: [f32; 3], launch_vy: f32, t_total: f32, g: f32) -> bool {
        const LIFT: f32 = 0.5;
        let pts = ballistic3d::arc_points(
            [from[0], from[1] + LIFT, from[2]],
            [to[0], to[1] + LIFT, to[2]],
            launch_vy,
            t_total,
            g,
            8,
        );
        pts.windows(2).all(|w| match self.physics.cast_ray(w[0], w[1]) {
            Some((eid, _)) => !self.world.is_floor(eid),
            None => true,
        })
    }

    /// A sprint jump needs a clear straight run-up behind the takeoff point
    /// (half a second at sprint speed), along the takeoff bearing.
    fn runway_is_clear(&self, from: [f32; 3], to: [f32; 3], sprint_speed: f32) -> bool {
        const LIFT: f32 = 0.5;
        let dx = to[0] - from[0];
        let dz = to[2] - from[2];
        let len = (dx * dx + dz * dz).sqrt();
        if len < 1e-6 {
            return false;
        }
        let runway = sprint_speed * 0.5;
        let start = [
            from[0] - dx / len * runway,
            from[1] + LIFT,
            from[2] - dz / len * runway,
        ];
        match self.physics.cast_ray(start, [from[0], from[1] + LIFT, from[2]]) {
            Some((eid, _)) => !self.world.is_floor(eid),
            None => true,
        }
    }

    /// Reactive-nudge entry point (goal layers, ADR 0011): blend a soft
    /// influence into a monster's current velocity without replacing its
    /// path target — the same post-AI pattern monster separation uses.
    pub fn add_monster_nudge(&mut self, id: u32, nx: f32, ny: f32, nz: f32) {
        if let Some(v) = self.world.velocity(id) {
            self.world.set_velocity(id, [v[0] + nx, v[1] + ny, v[2] + nz]);
        }
    }

    /// Mark a floor entity as non-walkable (or clear that) after it's already
    /// spawned — additive counterpart to `MapBlock.walkable` (which only
    /// applies at `load_map` time) for callers like the 2D game that spawn
    /// terrain block-by-block via `spawn_floor_entity` instead.
    pub fn set_terrain_walkable(&mut self, id: u32, walkable: bool) {
        if walkable {
            self.non_walkable_terrain.remove(&id);
        } else {
            self.non_walkable_terrain.insert(id);
        }
        // Walls get their own collision group so incorporeal bodies can
        // filter them out (ADR 0013).
        self.physics.set_wall(id, !walkable);
    }

    /// Find a path from (startX, startY, startZ) to (goalX, goalZ).
    pub fn find_path(
        &self,
        start_x: f32,
        start_y: f32,
        start_z: f32,
        goal_x: f32,
        goal_z: f32,
        can_jump: bool,
    ) -> JsValue {
        let Some(navmesh) = &self.navmesh else {
            return JsValue::NULL;
        };

        let result = navmesh.find_path(PathRequest {
            start: [start_x, start_y, start_z],
            goal: [goal_x, 0.0, goal_z],
            route_seed: None,
            can_jump,
            // Manual debug query — sprint edges are for capability-tagged monsters.
            can_sprint: false,
            can_phase: false,
            start_y: Some(start_y),
        });

        match result {
            None => JsValue::NULL,
            Some(waypoints) => {
                let js: Vec<JsWaypoint> = waypoints
                    .iter()
                    .map(|w| JsWaypoint {
                        x: w.x,
                        y: w.y,
                        z: w.z,
                        requires_jump: w.requires_jump,
                        is_ledge_drop: w.is_ledge_drop,
                    })
                    .collect();
                serde_wasm_bindgen::to_value(&js).unwrap_or(JsValue::NULL)
            }
        }
    }

    /// Destroy an entity and remove its Rapier physics body.
    pub fn destroy_entity(&mut self, id: u32) {
        // NET_REPLICATED entities announce their destruction so remote mirrors
        // don't linger.
        if self.world.net_flags(id).is_some_and(|f| f & NET_REPLICATED != 0) {
            self.pending_despawns.push(id);
        }
        // Lifecycle event for the game's mesh bookkeeping — terrain is excluded
        // (load_map owns it) and mirrors report through NetPatch instead. The
        // alive check keeps a double-destroy from emitting twice.
        let is_mirror = self.mirror_owner.contains_key(&id);
        if !is_mirror && !self.world.is_floor(id) && self.world.position(id).is_some() {
            self.pending_lifecycle.push(LifecyclePatch {
                entity: id,
                kind: LifecycleKind::Despawned,
                flags: self.world.net_flags(id).unwrap_or(0),
            });
        }
        // A force-destroyed remote mirror drops its mapping too.
        if let Some(key) = self.mirror_owner.remove(&id) {
            self.remote_mirrors.remove(&key);
        }
        self.mirror_flags.remove(&id);
        self.world.destroy_entity(id);
        self.physics.remove_entity(id);
        self.local_entities.retain(|&e| e != id);
        self.monster_states.remove(&id);
        self.monster_capabilities.remove(&id);
        self.animation_states.remove(&id);
        self.dying.remove(&id);
        self.bullet_ages.remove(&id);
        self.non_walkable_terrain.remove(&id);
        self.pending_jumps.remove(&id);
        // Entity IDs are recycled: a stale delta snapshot would suppress the
        // recycled entity's first outbound sync.
        self.delta_tracker.forget(id);
    }

    /// Load a map from a JS array of `{ x, y, z, hw, hh, hd, kind }` blocks: spawns a
    /// static terrain entity per block, builds the navmesh from the resulting floor
    /// geometry, and returns the same blocks with `eid` added for mesh creation on the
    /// TS side. The map data is owned by the game — the engine ships none.
    pub fn load_map(&mut self, blocks: JsValue) -> JsValue {
        let Ok(blocks) = serde_wasm_bindgen::from_value::<Vec<MapBlock>>(blocks) else {
            return JsValue::NULL;
        };
        let placed = self.load_map_blocks(&blocks);
        serde_wasm_bindgen::to_value(&placed).unwrap_or(JsValue::NULL)
    }

    /// Spawn a static floor entity. Returns the entity ID.
    pub fn spawn_floor_entity(&mut self, x: f32, y: f32, z: f32, hw: f32, hh: f32, hd: f32) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_collider(
            id,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: hw,
                half_height: hh,
                half_depth: hd,
            },
        );
        self.world.set_floor(id, true);
        id
    }

    /// Spawn a dynamic entity (player, monster, box). Returns the entity ID.
    /// `net_flags`: combine NET_LOCAL (0x01) and NET_MONSTER (0x04) for monster entities.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_box_entity(
        &mut self,
        x: f32,
        y: f32,
        z: f32,
        hw: f32,
        hh: f32,
        hd: f32,
        health: i32,
        net_flags: u8,
    ) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_health(id, health);
        self.world.set_net_flags(id, net_flags);
        self.world.set_collider(
            id,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: hw,
                half_height: hh,
                half_depth: hd,
            },
        );
        self.register_spawned(id, net_flags);
        id
    }

    /// Spawn a projectile. The engine integrates its ballistic trajectory each
    /// tick. `net_flags` adds the game's networking profile (e.g. NET_REPLICATED
    /// | NET_PREDICTABLE); NET_BULLET is always set.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_bullet(
        &mut self,
        x: f32,
        y: f32,
        z: f32,
        vx: f32,
        vy: f32,
        vz: f32,
        net_flags: u8,
    ) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_velocity(id, [vx, vy, vz]);
        self.world.set_net_flags(id, net_flags | NET_BULLET);
        self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
        self.register_spawned(id, net_flags | NET_BULLET);
        id
    }

    /// Set the velocity of an entity. XZ is a movement command, applied last-write-wins.
    /// Non-zero vy latches a jump impulse consumed by exactly one physics step; vy=0
    /// never clears a pending latch, so a jump survives movement commands that coalesce
    /// ahead of the next tick. Consecutive jumps before a tick collapse to the last one.
    pub fn set_entity_velocity(&mut self, id: u32, vx: f32, vy: f32, vz: f32) {
        if let Some(v) = self.world.velocity(id) {
            // vy stays at its current world value (0 between jumps — the gravity-owned
            // sentinel in physics::sync_from_world); the latch carries the impulse.
            self.world.set_velocity(id, [vx, v[1], vz]);
            if vy != 0.0 {
                self.pending_jumps.insert(id, vy);
            }
        }
    }

    /// Move an entity immediately, clearing velocity for dynamic bodies.
    pub fn teleport_entity(&mut self, id: u32, x: f32, y: f32, z: f32) {
        if self.world.position(id).is_none() {
            return;
        }

        let position = [x, y, z];
        self.world.set_position(id, position);
        if self.world.velocity(id).is_some() {
            self.world.set_velocity(id, [0.0, 0.0, 0.0]);
        }
        self.pending_jumps.remove(&id);
        self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
        self.delta_tracker.mark_dirty(id);
        self.physics.teleport_entity(id, position);
    }
}

// --- Private engine methods (not exposed to JS) ---

impl Engine {
    /// Physics phase of a tick: stamp latched jump impulses into world velocity so
    /// this sync applies them, step Rapier, then reset vy to 0 (the gravity-owned
    /// sentinel — see physics::sync_from_world) so later ticks preserve gravity
    /// accumulation. Factored out of tick() so native tests can drive physics
    /// without crossing the JsValue boundary.
    fn step_physics(&mut self, dt_secs: f32) {
        for (&id, &vy) in &self.pending_jumps {
            if let Some(v) = self.world.velocity(id) {
                self.world.set_velocity(id, [v[0], vy, v[2]]);
            }
        }

        self.physics.sync_from_world(&self.world);
        self.physics.step(dt_secs);
        self.physics.sync_to_world(&mut self.world);

        for &id in self.pending_jumps.keys() {
            if let Some(v) = self.world.velocity(id) {
                self.world.set_velocity(id, [v[0], 0.0, v[2]]);
            }
        }
        self.pending_jumps.clear();
    }

    /// Post-spawn bookkeeping shared by every spawn path. Ensures the entity has
    /// a velocity component (so movement/jump commands work), registers the
    /// NET-flag driven state (local replication list, per-monster AI state), and
    /// queues the lifecycle event the game builds its mesh from.
    fn register_spawned(&mut self, id: u32, net_flags: u8) {
        if self.world.velocity(id).is_none() {
            self.world.set_velocity(id, [0.0, 0.0, 0.0]);
        }
        if net_flags & NET_LOCAL != 0 {
            self.local_entities.push(id);
        }
        if net_flags & NET_MONSTER != 0 {
            let stagger =
                (id % REPLAN_STAGGER_BUCKETS) as f32 / REPLAN_STAGGER_BUCKETS as f32
                    * self.ai.replan_cooldown;
            self.monster_states.insert(id, MonsterState::new(stagger));
        }
        self.pending_lifecycle.push(LifecyclePatch {
            entity: id,
            kind: LifecycleKind::Spawned,
            flags: net_flags,
        });
    }

    /// Run the player controller: facing (turn axis or camera override), planar
    /// movement, and the double-jump budget — all from the latest raw input.
    /// Also aims the default monster goal at the player.
    /// Movement the player's current animation family permits (ADR 0018).
    /// Fully permissive when no animation set / no instance — so this only ever
    /// tightens behavior once a restrictive family (e.g. attack) is playing.
    fn player_move_mask(&self) -> animation::MoveMask {
        let Some(set) = self.animation_set.as_ref() else {
            return animation::MoveMask::ALL;
        };
        let Some(eid) = self.player.as_ref().map(|p| p.eid) else {
            return animation::MoveMask::ALL;
        };
        self.animation_states
            .get(&eid)
            .and_then(|inst| set.families.get(inst.family()))
            .map_or(animation::MoveMask::ALL, |fam| fam.move_mask)
    }

    fn tick_player_controller(&mut self, dt_secs: f32) {
        let cfg = self.player_cfg;
        // 2D's player is TypeScript-driven (yaw/strafe don't exist in a
        // side-view game — see tick_monster_ai's matching gate and
        // specs/engine/README.md's Physics Dimension section for the full picture).
        // Still safe to call register_player for 2D — that's what lets
        // closest_player_position see it — as long as this stays a no-op so
        // it never overwrites the TS-driven velocity with default input.
        if self.physics.dimension() == Dimension::TwoD {
            return;
        }
        // The current animation gates which inputs apply (rooted attack, etc.).
        let mask = self.player_move_mask();
        let Some(p) = self.player.as_mut() else {
            return;
        };
        let eid = p.eid;

        if mask.turn {
            if let Some(yaw) = p.input.yaw_override {
                p.yaw = yaw;
            } else {
                p.yaw += p.input.turn * cfg.turn_speed * dt_secs;
            }
        }

        // Standing on the ground refills the jump budget. (grounded is served
        // from the physics cache, so the refill can lag a jump by a few ticks —
        // same tolerance the game always had.)
        if self.world.is_grounded(eid).unwrap_or(false) {
            p.jumps_used = 0;
        }
        // Edge-detect on the *gated* value, so a jump held through a no-jump
        // animation fires the moment the animation frees it up.
        let jump_held = mask.jump && p.input.jump_held;
        let jump_edge = jump_held && !p.prev_jump_held;
        p.prev_jump_held = jump_held;
        let vy = if jump_edge && p.jumps_used < cfg.max_jumps {
            p.jumps_used += 1;
            cfg.jump_speed
        } else {
            0.0
        };

        let forward = if mask.forward { p.input.forward } else { 0.0 };
        let strafe = if mask.strafe { p.input.strafe } else { 0.0 };
        let (sin_y, cos_y) = (p.yaw.sin(), p.yaw.cos());
        let mut vx = forward * sin_y + strafe * cos_y;
        let mut vz = forward * cos_y - strafe * sin_y;
        let len = (vx * vx + vz * vz).sqrt();
        if len > 1.0 {
            vx /= len;
            vz /= len;
        }
        let yaw = p.yaw;

        self.set_entity_velocity(eid, vx * cfg.walk_speed, vy, vz * cfg.walk_speed);
        self.world.set_rotation(eid, [yaw, 0.0, 0.0]);
        self.world.mark_dirty(eid, DirtyFlags::TRANSFORM);
    }

    /// Respawn one monster at a random bearing on the respawn ring.
    fn respawn_monster(&mut self) {
        let cfg = self.monster_cfg;
        let angle = self.next_rand() * std::f32::consts::TAU;
        let radius = cfg.respawn_radius_min
            + self.next_rand() * (cfg.respawn_radius_max - cfg.respawn_radius_min);
        self.spawn_box_entity(
            angle.cos() * radius,
            cfg.respawn_y,
            angle.sin() * radius,
            cfg.half_width,
            cfg.half_height,
            cfg.half_depth,
            cfg.health,
            cfg.net_flags,
        );
    }

    /// LCG in [0, 1) — deterministic and dependency-free; spawn scatter only.
    fn next_rand(&mut self) -> f32 {
        self.rng_state = self
            .rng_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.rng_state >> 33) as f32 / (u32::MAX as f32 + 1.0)
    }

    /// Height of the topmost WALKABLE floor surface at (x, z), for navmesh node
    /// placement. Unlike physics.floor_height_at, this skips non-floor entities
    /// (e.g. a dynamic entity transiently occupying the column), continuing the
    /// scan below them. A non-walkable **floor** entity (a wall or parapet) is
    /// different: it terminates the scan with no node at all, not a node on
    /// whatever's underneath it — a wall standing on a walkable floor must not
    /// get a navmesh node at its own footprint, or `horizontally_blocked` would
    /// have nothing to disconnect (the node itself would still sit at zero
    /// height difference from its neighbors, bypassing the wall in two hops
    /// instead of one). A goal or query landing on the wall's footprint instead
    /// falls back to the nearest real node via `nearest_walkable`'s snap radius.
    /// The scan window (`scan_top` → `scan_bottom`) is derived by the caller from
    /// the loaded floor geometry — never hardcoded, so maps at any altitude work.
    fn walkable_height_at(&self, x: f32, z: f32, scan_top: f32, scan_bottom: f32) -> Option<f32> {
        let mut from_y = scan_top;
        for _ in 0..MAX_TERRAIN_LAYERS_PER_COLUMN {
            let (eid, toi) = self.physics.cast_ray([x, from_y, z], [x, scan_bottom, z])?;
            if self.world.is_floor(eid) {
                if self.non_walkable_terrain.contains(&eid) {
                    return None;
                }
                return Some(from_y - toi);
            }
            // Not floor terrain — resume below the blocking entity's bottom face
            // (resuming just below its top would start inside the box and re-hit
            // it at toi = 0).
            let pos = self.world.position(eid)?;
            let col = self.world.collider(eid)?;
            from_y = pos[1] - col.half_height - 0.01;
            if from_y <= scan_bottom {
                return None;
            }
        }
        None
    }

    /// True if a non-walkable ("wall") entity stands laterally between two
    /// candidate navmesh node positions — i.e. an obstacle a mover can't pass
    /// *through*. `walkable_height_at` already keeps a node from being placed
    /// *on* a wall's own footprint, but that alone doesn't stop two nodes on
    /// either side of a wall thinner than `NavConfig::cell_size` from landing
    /// as ordinary grid neighbors with zero height difference between them —
    /// this catches that case.
    /// Probed once, at `WALL_PROBE_CLEARANCE` above the higher endpoint —
    /// above either node's own walkable surface (so a step-up/stair edge,
    /// whose riser tops out at the tread's own height, is never mistaken for
    /// a wall) but still well below any standing wall's top.
    fn horizontally_blocked(&self, from: [f32; 3], to: [f32; 3]) -> bool {
        let probe_y = from[1].max(to[1]) + WALL_PROBE_CLEARANCE;
        let probe_from = [from[0], probe_y, from[2]];
        let probe_to = [to[0], probe_y, to[2]];
        matches!(
            self.physics.cast_ray(probe_from, probe_to),
            Some((eid, _)) if self.non_walkable_terrain.contains(&eid)
        )
    }

    /// Native-callable core of load_map: spawn each block as a static floor entity and
    /// build the navmesh over the resulting geometry.
    fn load_map_blocks(&mut self, blocks: &[MapBlock]) -> Vec<JsTerrainBlock> {
        let placed = blocks
            .iter()
            .map(|b| {
                let eid = self.spawn_floor_entity(b.x, b.y, b.z, b.hw, b.hh, b.hd);
                if !b.walkable {
                    self.non_walkable_terrain.insert(eid);
                    self.physics.set_wall(eid, true);
                }
                JsTerrainBlock {
                    eid,
                    x: b.x,
                    y: b.y,
                    z: b.z,
                    hw: b.hw,
                    hh: b.hh,
                    hd: b.hd,
                    kind: b.kind.clone(),
                }
            })
            .collect();
        self.build_navmesh();
        placed
    }

    /// Fill `buf` (cleared first) with the IDs of all live entities whose net_flags
    /// include `flag`. Associated fn so the caller can pass a scratch buffer taken out
    /// of `self` without a borrow conflict on `self.world`.
    fn collect_by_flag(world: &World, flag: u8, buf: &mut Vec<u32>) {
        buf.clear();
        buf.extend(
            world
                .entities()
                .filter(|&id| world.net_flags(id).is_some_and(|f| f & flag != 0)),
        );
    }

    /// Runs `f` with `self.scratch_ids` temporarily taken out (so `f` can read
    /// `self.world` while also writing the id list, without a borrow conflict),
    /// then always restores it afterward — including on an early return inside
    /// `f` — so its allocated capacity is reused next tick instead of being
    /// dropped and reallocated.
    fn with_scratch_ids<R>(&mut self, f: impl FnOnce(&mut Self, &mut Vec<u32>) -> R) -> R {
        let mut ids = std::mem::take(&mut self.scratch_ids);
        let result = f(self, &mut ids);
        self.scratch_ids = ids;
        result
    }

    /// Decode and apply one peer payload: Delta/FullSync events route to this
    /// peer's local mirror entities (created on first sight), Despawned drops
    /// the mirror, Ping only refreshes liveness. Emits one boundary NetPatch
    /// per entity event so the game can manage remote meshes. A payload that
    /// fails to decode is dropped whole.
    fn ingest_peer_payload(&mut self, peer: &str, bytes: &[u8], out: &mut Vec<NetPatch>) {
        self.peer_last_seen.insert(peer.to_string(), self.sim_time);
        let Ok(events) = netcode::decode_events(bytes) else {
            return;
        };
        for event in events {
            match event {
                WireEvent::Spawn { entity, flags, fields } => {
                    let (mirror, is_new) = self.mirror_for(peer, entity);
                    // A Spawn for a known mirror is a re-sync (e.g. late-join
                    // snapshot after reconnect) — refresh its profile.
                    let public = flags & NET_PUBLIC_MASK;
                    self.mirror_flags.insert(mirror, public);
                    netcode::apply_fields_to_entity(&mut self.world, mirror, &fields);
                    self.world.mark_dirty(mirror, DirtyFlags::TRANSFORM);
                    out.push(NetPatch {
                        peer_id: peer.to_string(),
                        entity: mirror,
                        kind: if is_new {
                            NetEventKind::EntitySpawned
                        } else {
                            NetEventKind::EntityUpdated
                        },
                        flags: Some(public),
                    });
                }
                WireEvent::Delta { entity, fields } => {
                    // A Delta for an unknown entity (e.g. its Spawn raced a
                    // reconnect) still creates a mirror — profile flags arrive
                    // with the next full sync.
                    let (mirror, is_new) = self.mirror_for(peer, entity);
                    netcode::apply_fields_to_entity(&mut self.world, mirror, &fields);
                    self.world.mark_dirty(mirror, DirtyFlags::TRANSFORM);
                    out.push(NetPatch {
                        peer_id: peer.to_string(),
                        entity: mirror,
                        kind: if is_new {
                            NetEventKind::EntitySpawned
                        } else {
                            NetEventKind::EntityUpdated
                        },
                        flags: if is_new { Some(0) } else { None },
                    });
                }
                WireEvent::Despawned { entity } => {
                    if let Some(mirror) = self.remote_mirrors.get(&(peer.to_string(), entity)).copied()
                    {
                        self.destroy_entity(mirror);
                        out.push(NetPatch {
                            peer_id: peer.to_string(),
                            entity: mirror,
                            kind: NetEventKind::EntityDespawned,
                            flags: None,
                        });
                    }
                }
                WireEvent::Ping => {}
            }
        }
    }

    /// Look up (or create) the local mirror for a remote entity. Mirrors are
    /// display-only: no collider, no world NET flags — engine systems (AI,
    /// bullets, physics, replication) all ignore them; their public profile
    /// lives in `mirror_flags`.
    fn mirror_for(&mut self, peer: &str, remote: u32) -> (u32, bool) {
        let key = (peer.to_string(), remote);
        match self.remote_mirrors.get(&key) {
            Some(&mirror) => (mirror, false),
            None => {
                let mirror = self.world.create_entity();
                self.remote_mirrors.insert(key.clone(), mirror);
                self.mirror_owner.insert(mirror, key);
                self.mirror_flags.insert(mirror, 0);
                (mirror, true)
            }
        }
    }

    /// Flag-driven replication cadence: queue each NET_REPLICATED entity for
    /// the delta flush when its profile says it's due. Unpredictable entities
    /// (default) go every tick; NET_PREDICTABLE ride receiver extrapolation and
    /// only need periodic drift corrections (plus engine-forced updates at
    /// discontinuities, e.g. bullet bounces); NET_LOW_URGENCY throttles
    /// background actors.
    fn mark_replication_dirty(&mut self) {
        let tick = self.world.tick_count();
        self.with_scratch_ids(|this, ids| {
            Self::collect_by_flag(&this.world, NET_REPLICATED, ids);
            for &id in ids.iter() {
                let flags = this.world.net_flags(id).unwrap_or(0);
                // Unannounced entities flush immediately whatever their cadence —
                // the Spawn event is what tells peers they exist.
                let due = if !this.delta_tracker.is_tracked(id) {
                    true
                } else if flags & NET_PREDICTABLE != 0 {
                    tick.is_multiple_of(PREDICTABLE_STRIDE)
                } else if flags & NET_LOW_URGENCY != 0 {
                    tick.is_multiple_of(LOW_URGENCY_STRIDE)
                } else {
                    true
                };
                if due {
                    this.delta_tracker.mark_dirty(id);
                }
            }
        });
    }

    /// Advance NET_PREDICTABLE mirrors between network updates: linear motion
    /// from the last received velocity, plus gravity for ballistic (NET_BULLET)
    /// mirrors so remote bullets arc like local ones. The owner's periodic
    /// corrections (PREDICTABLE_STRIDE) rein in drift.
    fn extrapolate_predictable_mirrors(&mut self, dt_secs: f32) {
        for (&mirror, &flags) in &self.mirror_flags {
            if flags & NET_PREDICTABLE == 0 {
                continue;
            }
            let Some(pos) = self.world.position(mirror) else {
                continue;
            };
            let Some(mut vel) = self.world.velocity(mirror) else {
                continue;
            };
            if flags & NET_BULLET != 0 {
                vel[1] += self.gravity * dt_secs;
                self.world.set_velocity(mirror, vel);
            }
            self.world.set_position(
                mirror,
                [
                    pos[0] + vel[0] * dt_secs,
                    pos[1] + vel[1] * dt_secs,
                    pos[2] + vel[2] * dt_secs,
                ],
            );
            self.world.mark_dirty(mirror, DirtyFlags::TRANSFORM);
        }
    }

    /// Forget one peer: destroy its mirrors and report the departure.
    fn drop_peer(&mut self, peer: String, out: &mut Vec<NetPatch>) {
        self.peer_last_seen.remove(&peer);

        let mirrors: Vec<u32> = self
            .mirror_owner
            .iter()
            .filter(|(_, (owner, _))| *owner == peer)
            .map(|(&mirror, _)| mirror)
            .collect();
        for mirror in mirrors {
            self.destroy_entity(mirror);
            out.push(NetPatch {
                peer_id: peer.clone(),
                entity: mirror,
                kind: NetEventKind::EntityDespawned,
                flags: None,
            });
        }
        out.push(NetPatch {
            peer_id: peer,
            entity: 0,
            kind: NetEventKind::PeerLeft,
            flags: None,
        });
    }

    /// Backstop for channels that die without a close event: peers silent past
    /// PEER_TIMEOUT_SECS are dropped (healthy peers Ping when otherwise quiet).
    fn prune_timed_out_peers(&mut self, out: &mut Vec<NetPatch>) {
        let now = self.sim_time;
        let dead: Vec<String> = self
            .peer_last_seen
            .iter()
            .filter(|(_, &seen)| now - seen > PEER_TIMEOUT_SECS)
            .map(|(peer, _)| peer.clone())
            .collect();
        for peer in dead {
            self.drop_peer(peer, out);
        }
    }

    /// Drain the queued outbound payloads for the transport layer.
    fn take_outbound(&mut self) -> Vec<(Option<String>, Vec<u8>)> {
        std::mem::take(&mut self.outbound_net)
    }

    /// Deltas for dirty local entities plus queued despawn announcements; when
    /// there is nothing to say, a Ping past the keepalive interval so quiet
    /// peers aren't timed out remotely. With no peers connected there is nobody
    /// to talk to: announcements are dropped (the late-join full sync covers
    /// state) and nothing is queued, so the outbound queue can't grow while the
    /// transport is idle.
    fn collect_outbound_events(&mut self) -> Vec<WireEvent> {
        if self.peer_last_seen.is_empty() {
            self.pending_despawns.clear();
            return Vec::new();
        }
        let mut events = self.delta_tracker.flush(&self.world);
        events.extend(
            self.pending_despawns
                .drain(..)
                .map(|entity| WireEvent::Despawned { entity }),
        );
        if events.is_empty() && self.sim_time - self.last_broadcast_time >= PING_INTERVAL_SECS {
            events.push(WireEvent::Ping);
        }
        events
    }

    /// The position of whichever player — the locally simulated one, or a
    /// remote player's mirror — is closest to (x, z). A mirror counts as a
    /// player when its public profile is neither NET_BULLET nor NET_MONSTER
    /// (the only two typed profiles that cross the wire); see `mirror_flags`.
    /// None only when nobody is playing yet: no local player registered, no
    /// peers connected.
    fn closest_player_position(&self, x: f32, z: f32) -> Option<(f32, f32)> {
        self.closest_player_position_3d(x, z).map(|(px, _, pz)| (px, pz))
    }

    /// Same search as `closest_player_position`, also returning the
    /// player's real Y — needed by flying monsters, which (unlike grounded
    /// ones) actually close vertical distance to their goal.
    fn closest_player_position_3d(&self, x: f32, z: f32) -> Option<(f32, f32, f32)> {
        let mut best: Option<(f32, f32, f32, f32)> = None; // (dist_sq, px, py, pz)

        if let Some(player) = &self.player {
            if let Some([px, py, pz]) = self.world.position(player.eid) {
                best = Some(((px - x) * (px - x) + (pz - z) * (pz - z), px, py, pz));
            }
        }

        for (&mirror, &flags) in &self.mirror_flags {
            if flags & (NET_BULLET | NET_MONSTER) != 0 {
                continue;
            }
            let Some([px, py, pz]) = self.world.position(mirror) else {
                continue;
            };
            let dist_sq = (px - x) * (px - x) + (pz - z) * (pz - z);
            if best.is_none_or(|(best_dist, ..)| dist_sq < best_dist) {
                best = Some((dist_sq, px, py, pz));
            }
        }

        best.map(|(_, px, py, pz)| (px, py, pz))
    }

    /// The effective capability for one monster: its override
    /// (`set_monster_capability`) if any, else derived from the current
    /// `AiConfig` — read fresh each call, so a later `set_ai_config` still
    /// affects monsters with no explicit override.
    fn capability_for(&self, mid: u32) -> MonsterCapability {
        self.monster_capabilities.get(&mid).copied().unwrap_or(MonsterCapability {
            walk_speed: self.ai.walk_speed,
            can_jump: self.ai.can_jump,
            can_sprint: false,
            can_phase: false,
            can_fly: false,
        })
    }

    /// The goal one monster paths toward: its per-entity override; else
    /// whichever player (local or a remote mirror) is currently closest to
    /// it; else the JS-set engine-wide default, used only when no player
    /// exists yet to chase (e.g. before `register_player`, or tests that
    /// drive goals directly without spawning a player).
    /// Resolve a grounded monster's XZ goal and whether it's chasing a player.
    /// Precedence: per-entity override → closest player (local or a remote
    /// mirror) → JS-set fallback. The `chasing_player` flag (true only for the
    /// closest-player case) tells the layered-pathfinding dispatcher to use the
    /// shared flow-field strategy vs. a unique-goal route (see specs/engine).
    fn goal_for(&self, mid: u32, mx: f32, mz: f32) -> (f32, f32, bool) {
        if let Some(g) = self.monster_states.get(&mid).and_then(|s| s.goal) {
            return (g[0], g[1], false);
        }
        match self.closest_player_position(mx, mz) {
            Some((px, pz)) => (px, pz, true),
            None => (self.goal_x, self.goal_z, false),
        }
    }

    /// Run monster AI for one tick. Orchestration only — the per-monster
    /// mechanics live on MonsterState (`update_stuck_and_replan`,
    /// `follow_waypoints`); this loop owns world reads/writes, the shared
    /// per-tick A* budget, and the navmesh dispatch.
    /// Sets ECS velocity and rotation for each NET_MONSTER entity; physics
    /// picks them up in the following sync_from_world call.
    /// Returns the milliseconds spent inside A* searches (pathfinding_ms).
    fn tick_monster_ai(&mut self, dt_secs: f32) -> f32 {
        let ai = self.ai;
        // Ground-plane math below (goal_for, dx/dz, follow_waypoints) reads
        // positions' X and Z components unconditionally — this works
        // correctly for 2D too, without a separate code path, because every
        // 2D entity's Z is always 0 by convention (2D physics passes Z
        // through untouched, and nothing in the 2D game ever sets it to
        // anything else): dz is always 0-0=0, so dist/direction degenerate
        // to correct 1-D (X-only) results for free. This invariant is real
        // and load-bearing — a future feature giving 2D entities nonzero Z
        // would silently break monster AI. The one thing that doesn't
        // degenerate safely is the rotation write below (yaw is a real 3D
        // concept with no 2D equivalent), so it's the one part gated
        // explicitly — see tick_player_controller's matching gate.
        let is_2d = self.physics.dimension() == Dimension::TwoD;

        self.with_scratch_ids(|this, monster_ids| {
            let mut pathfinding_ms = 0.0_f32;
            Self::collect_by_flag(&this.world, NET_MONSTER, monster_ids);

            // At most one A* search per engine tick to bound the per-tick CPU spike.
            // The per-monster cooldown provides the primary throttle; this flag
            // prevents two monsters with simultaneous cooldown expiry from stacking.
            let mut path_requested_this_tick = false;

            for &mid in monster_ids.iter() {
                // A dying monster stops chasing/steering (ADR 0020).
                if this.dying.contains(&mid) {
                    continue;
                }
                let [mx, my, mz] = match this.world.position(mid) {
                    Some(p) => p,
                    None => continue,
                };
                let capability = this.capability_for(mid);

                // Flying skips the navmesh/pathfinding system entirely — no
                // waypoints, just steer straight at the goal's real 3D
                // position (unlike grounded movers, which only ever care
                // about X/Z). Physically well-defined with zero physics
                // changes: writing a fresh nonzero Y every tick is already a
                // sustained "set velocity.y to exactly this" command, not a
                // one-shot jump impulse — see crates/physics's
                // nonzero_ecs_velocity_y_is_a_one_frame_jump_impulse /
                // zero_ecs_velocity_y_preserves_gravity_accumulation tests.
                if capability.can_fly {
                    // Goal precedence mirrors goal_for, but duplicated rather
                    // than shared: goal_for is grounded-only (X/Z), while a
                    // flying monster additionally needs a sensible altitude when
                    // the goal has none of its own (hold current Y).
                    let (goal_x, goal_y, goal_z) = if let Some(g) =
                        this.monster_states.get(&mid).and_then(|s| s.goal)
                    {
                        (g[0], my, g[1])
                    } else if let Some((px, py, pz)) = this.closest_player_position_3d(mx, mz) {
                        (px, py, pz)
                    } else {
                        (this.goal_x, my, this.goal_z)
                    };
                    let dx = goal_x - mx;
                    let dy = goal_y - my;
                    let dz = goal_z - mz;
                    let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                    if dist < GOAL_REACHED_EPSILON {
                        this.world.set_velocity(mid, [0.0, 0.0, 0.0]);
                        continue;
                    }
                    let speed = capability.walk_speed;
                    let (mut vx, mut vy, mut vz) =
                        (dx / dist * speed, dy / dist * speed, dz / dist * speed);
                    // Reactive vertical avoidance: terrain on the flight line
                    // within a speed-derived lookahead → climb over it (keep
                    // a little forward drive so the ascent clears the face,
                    // not hovers against it). Once high enough for a clear
                    // line, the normal beeline resumes — an emergent arc
                    // over walls with no pathfinding involved (ADR 0012).
                    let lookahead = speed.max(2.0);
                    let inv = 1.0 / speed;
                    // Probe starts past the flyer's own collider — a ray from
                    // the body center solid-hits itself at t=0.
                    let skin = 1.05;
                    let probe_from = [
                        mx + vx * inv * skin,
                        my + vy * inv * skin,
                        mz + vz * inv * skin,
                    ];
                    let probe_to = [
                        mx + vx * inv * lookahead,
                        my + vy * inv * lookahead,
                        mz + vz * inv * lookahead,
                    ];
                    let blocked = matches!(
                        this.physics.cast_ray(probe_from, probe_to),
                        Some((eid, _)) if this.world.is_floor(eid)
                    );
                    if blocked {
                        let h = (vx * vx + vz * vz).sqrt().max(1e-6);
                        let (fx, fz) = (vx / h, vz / h);
                        vx = fx * 0.35 * speed;
                        vy = 0.85 * speed;
                        vz = fz * 0.35 * speed;
                    }
                    if !is_2d {
                        let yaw = vx.atan2(vz);
                        this.world.set_rotation(mid, [yaw, 0.0, 0.0]);
                        this.world.mark_dirty(mid, DirtyFlags::TRANSFORM);
                    }
                    this.world.set_velocity(mid, [vx, vy, vz]);
                    continue;
                }

                let grounded = this.world.is_grounded(mid).unwrap_or(false);
                // A subsequent jump in a multi-jump sequence times off this —
                // see follow_waypoints' doc comment.
                let vy = this.world.velocity(mid).map_or(0.0, |v| v[1]);
                // Foot height anchors navmesh lookups to the correct floor layer;
                // monster dimensions are caller-supplied, so read the collider.
                let foot_y = my - this.world.collider(mid).map_or(0.0, |c| c.half_height);

                // Goal + source: goal_for also reports whether this is the
                // shared player chase (flow-field strategy) or a unique goal
                // (key-route/A* strategy), which the dispatcher below needs.
                let (goal_x, goal_z, chasing_player) = this.goal_for(mid, mx, mz);
                let dx = goal_x - mx;
                let dz = goal_z - mz;
                let dist = (dx * dx + dz * dz).sqrt();
                if dist < GOAL_REACHED_EPSILON {
                    // Stop explicitly: physics reapplies the last XZ command every
                    // sync, so skipping the write would keep the monster walking.
                    this.world.set_velocity(mid, [0.0, 0.0, 0.0]);
                    continue;
                }
                let goal_dir = [dx / dist, dz / dist];
                let cap_key = (capability.can_jump, capability.can_sprint, capability.can_phase);

                // Frustration: moving-but-not-closing escalation. Drops
                // whatever route is being trusted (flow/splice included),
                // pierces the replan cooldown, and — while frustrated —
                // shuns shared answers in favor of its own seeded A* (route
                // variety), so each escalation genuinely tries harder.
                let escalated = match this.monster_states.get_mut(&mid) {
                    Some(state) => state.update_progress(&ai, dt_secs, dist, [goal_x, goal_z]),
                    None => continue,
                };
                if escalated {
                    if let Some(s) = this.monster_states.get_mut(&mid) {
                        s.route = None;
                        s.replan_cooldown = 0.0;
                    }
                }
                let frustration = this.monster_states.get(&mid).map_or(0, |s| s.frustration);

                // --- Dispatcher: validate, then acquire, a route. ---
                // A flow route is re-validated against the goal's current
                // node every tick; any mismatch (goal moved nodes, field
                // evicted, capability changed) drops it for re-acquisition.
                let goal_node = if chasing_player {
                    this.navmesh.as_ref().and_then(|m| m.nearest_walkable(goal_x, goal_z))
                } else {
                    None
                };
                if let Some(ActiveRoute::Flow { key }) =
                    this.monster_states.get(&mid).and_then(|s| s.route.as_ref())
                {
                    let key = *key;
                    let valid = chasing_player
                        && goal_node == Some(key.0)
                        && (key.1, key.2, key.3) == cap_key
                        && this.pathing.flow_fields.contains_key(&key);
                    if !valid {
                        if let Some(s) = this.monster_states.get_mut(&mid) {
                            s.route = None;
                        }
                    }
                }

                let mut have_route =
                    this.monster_states.get(&mid).is_some_and(|s| s.route.is_some());

                // Crowd chase rides the shared flow field (O(1) per tick, no
                // A* token); missing fields build on the heavy queue while
                // the monster keeps its existing behavior.
                if !have_route && chasing_player && frustration == 0 {
                    if let Some(gn) = goal_node {
                        let key = (gn, cap_key.0, cap_key.1, cap_key.2);
                        match this.pathing.flow_fields.get(&key) {
                            // Adopt only if the field can actually route this
                            // monster — an unreachable pocket falls through to
                            // splice/A* (which will also fail, but must not be
                            // silently suppressed by holding a dead Flow route).
                            Some(field) => {
                                let reachable = this
                                    .navmesh
                                    .as_ref()
                                    .and_then(|m| m.nearest_walkable_3d(mx, foot_y, mz))
                                    .is_some_and(|n| field.reaches(n));
                                if reachable {
                                    if let Some(s) = this.monster_states.get_mut(&mid) {
                                        s.route = Some(ActiveRoute::Flow { key });
                                        have_route = true;
                                    }
                                }
                            }
                            None => this.pathing.enqueue_flow_field(key),
                        }
                    }
                }

                // Splice onto another monster's pooled route — free, no
                // search; staleness-guarded inside find_splice. Frustrated
                // monsters shun shared routes (one may be why they're stuck).
                if !have_route && frustration == 0 {
                    if let Some((route, index)) = this.pathing.find_splice(
                        mx,
                        mz,
                        [goal_x, goal_z],
                        ai.waypoint_reach * 2.0,
                        ai.replan_stale_dist,
                        capability.can_jump,
                        capability.can_sprint,
                        capability.can_phase,
                    ) {
                        if let Some(s) = this.monster_states.get_mut(&mid) {
                            s.route = Some(ActiveRoute::Spliced { route, index });
                        }
                    }
                }

                // Flow followers never spend the A* token (the field is
                // already shortest-path); stuck sampling still runs and drops
                // the route on a jam.
                let is_flow = matches!(
                    this.monster_states.get(&mid).and_then(|s| s.route.as_ref()),
                    Some(ActiveRoute::Flow { .. })
                );
                let should_replan = match this.monster_states.get_mut(&mid) {
                    Some(state) => state.update_stuck_and_replan(
                        &ai,
                        dt_secs,
                        mx,
                        mz,
                        goal_x,
                        goal_z,
                        !path_requested_this_tick && !is_flow,
                    ),
                    None => continue,
                };

                if should_replan {
                    // Tier 3 first: a baked key plan is zero-search and does
                    // not consume the A* token. Its own usefulness gate
                    // rejects short hauls (see KeyRoutes::plan). Frustrated
                    // monsters skip it — a deterministic baked answer that
                    // isn't working would just be retried identically.
                    let mut planned = false;
                    if !chasing_player && frustration == 0 {
                        if this.pathing.key_routes.contains_key(&cap_key) {
                            if let (Some(kr), Some(mesh)) =
                                (this.pathing.key_routes.get(&cap_key), this.navmesh.as_ref())
                            {
                                if let Some(plan) = kr.plan(
                                    mesh,
                                    [mx, foot_y, mz],
                                    Some(foot_y),
                                    [goal_x, 0.0, goal_z],
                                ) {
                                    this.pathing.pool_route(plan.waypoints.clone(), [goal_x, goal_z], ai.waypoint_reach * 3.0);
                                    if let Some(s) = this.monster_states.get_mut(&mid) {
                                        s.route = Some(ActiveRoute::owned(plan.waypoints));
                                    }
                                    planned = true;
                                }
                            }
                        } else if this.navmesh.is_some()
                            && !this.pathing.queued_caps.contains(&cap_key)
                        {
                            let keys = this.navmesh.as_ref().expect("checked").derive_key_nodes();
                            this.pathing.enqueue_key_routes(cap_key, keys);
                        }
                    }
                    if !planned {
                        path_requested_this_tick = true;
                        if let Some(navmesh) = &this.navmesh {
                            let path_timer = Timer::new();
                            // Each escalation retries with a different seed —
                            // deterministic route variety, so "try harder"
                            // means "try a different way", not the same
                            // failing route again.
                            let route_seed = (frustration > 0)
                                .then(|| mid.wrapping_mul(31).wrapping_add(frustration));
                            let result = navmesh.find_path(PathRequest {
                                start: [mx, foot_y, mz],
                                goal: [goal_x, 0.0, goal_z],
                                route_seed,
                                can_jump: capability.can_jump,
                                can_sprint: capability.can_sprint,
                                can_phase: capability.can_phase,
                                start_y: Some(foot_y),
                            });
                            pathfinding_ms += path_timer.elapsed_ms();
                            if let Some(path) = &result {
                                this.pathing.pool_route(path.clone(), [goal_x, goal_z], ai.waypoint_reach * 3.0);
                            }
                            if let Some(s) = this.monster_states.get_mut(&mid) {
                                s.route = result.map(ActiveRoute::owned);
                            }
                        }
                    }
                }

                // --- Follow the active route. Exhaustion policy is per
                // shape: a fully-walked owned/spliced route earns an instant
                // replan (a FAILED search stays None and keeps its cooldown —
                // zeroing it would turn one bad goal into a per-tick storm of
                // full-mesh searches); a flow route just fetches a fresh hop
                // next tick. ---
                let mut route = match this.monster_states.get_mut(&mid) {
                    Some(state) => state.route.take(),
                    None => continue,
                };
                let mut walked_out = false;
                let (desired_x, desired_z, wants_jump, wants_sprint) =
                    match (&mut route, this.monster_states.get_mut(&mid)) {
                        (Some(ActiveRoute::Owned { path, index }), Some(state)) => {
                            let (ddx, ddz, jump, sprint, exhausted) = state.follow_slice(
                                &ai, path, index, mx, mz, foot_y, grounded, vy, goal_dir,
                            );
                            walked_out = exhausted;
                            (ddx, ddz, jump, sprint)
                        }
                        (Some(ActiveRoute::Spliced { route: shared, index }), Some(state)) => {
                            let (ddx, ddz, jump, sprint, exhausted) = state.follow_slice(
                                &ai,
                                &shared.waypoints,
                                index,
                                mx,
                                mz,
                                foot_y,
                                grounded,
                                vy,
                                goal_dir,
                            );
                            walked_out = exhausted;
                            (ddx, ddz, jump, sprint)
                        }
                        (Some(ActiveRoute::Flow { key }), Some(state)) => {
                            let hop_wp = this.pathing.flow_fields.get(key).and_then(|field| {
                                let mesh = this.navmesh.as_ref()?;
                                let node = mesh.nearest_walkable_3d(mx, foot_y, mz)?;
                                flow_target(mesh, field, node, ai.waypoint_reach)
                            });
                            match hop_wp {
                                Some(wp) => {
                                    let buf = [wp];
                                    let mut i0 = 0usize;
                                    let (ddx, ddz, jump, sprint, _) = state.follow_slice(
                                        &ai, &buf, &mut i0, mx, mz, foot_y, grounded, vy, goal_dir,
                                    );
                                    (ddx, ddz, jump, sprint)
                                }
                                // At the goal's own node (or briefly off-mesh):
                                // direct steering covers the last mile.
                                None => (goal_dir[0], goal_dir[1], false, false),
                            }
                        }
                        (None, Some(_)) => (goal_dir[0], goal_dir[1], false, false),
                        (_, None) => continue,
                    };
                if walked_out {
                    route = None;
                    if let Some(s) = this.monster_states.get_mut(&mid) {
                        s.replan_cooldown = 0.0;
                    }
                }
                if let Some(s) = this.monster_states.get_mut(&mid) {
                    s.route = route;
                }

                // Rotation: yaw faces the walk direction. 2D has no yaw
                // (side view; facing is a sprite flip driven from TS instead)
                // — skip the write entirely rather than let a meaningless
                // value ride to the renderer, which applies rotation
                // unconditionally (see this fn's doc comment above).
                if !is_2d {
                    let yaw = desired_x.atan2(desired_z);
                    this.world.set_rotation(mid, [yaw, 0.0, 0.0]);
                    this.world.mark_dirty(mid, DirtyFlags::TRANSFORM);
                }

                let vy = if wants_jump { ai.jump_speed } else { 0.0 };
                // Sprint waypoints are approached at sprint speed (ADR 0011).
                let speed = if wants_sprint && capability.can_sprint {
                    ai.sprint_speed
                } else {
                    capability.walk_speed
                };
                // Desired direction stored as velocity; separation adjusts it below.
                this.world.set_velocity(mid, [desired_x * speed, vy, desired_z * speed]);
            }

            pathfinding_ms
        })
    }

    /// Add soft repulsion forces so monsters don't cluster. Reads current XZ velocities
    /// (which encode desired walk direction × speed), blends in separation, and writes
    /// back. Must run after tick_monster_ai and before physics sync_from_world.
    fn apply_monster_separation(&mut self) {
        let ai = self.ai;
        self.with_scratch_ids(|this, monster_ids| {
            Self::collect_by_flag(&this.world, NET_MONSTER, monster_ids);

            if monster_ids.len() < 2 {
                return;
            }

            // Snapshot positions so the per-entity loop can read all neighbours without
            // re-borrowing this.world through the inner loop.
            let mut positions = std::mem::take(&mut this.scratch_positions);
            positions.clear();
            positions.extend(
                monster_ids
                    .iter()
                    .map(|&id| this.world.position(id).unwrap_or([0.0; 3])),
            );

            let r_sq = ai.separation_radius * ai.separation_radius;

            for (i, &mid) in monster_ids.iter().enumerate() {
                // Dying monsters don't push or get pushed (ADR 0020).
                if this.dying.contains(&mid) {
                    continue;
                }
                let vel = match this.world.velocity(mid) {
                    Some(v) => v,
                    None => continue,
                };
                // Skip jump frames so separation doesn't fight the vertical impulse.
                if vel[1].abs() > JUMP_FRAME_VY_THRESHOLD {
                    continue;
                }

                let [mx, _, mz] = positions[i];
                let mut sx = 0.0_f32;
                let mut sz = 0.0_f32;

                for (j, pos_j) in positions.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    let dx = pos_j[0] - mx;
                    let dz = pos_j[2] - mz;
                    let d2 = dx * dx + dz * dz;
                    if d2 > 1e-6 && d2 < r_sq {
                        let d = d2.sqrt();
                        let f = 1.0 - d / ai.separation_radius;
                        sx -= (dx / d) * f;
                        sz -= (dz / d) * f;
                    }
                }

                if sx.abs() < 1e-6 && sz.abs() < 1e-6 {
                    continue;
                }

                // Recover unit desired direction from velocity (vel = dir × walk_speed).
                let speed = (vel[0] * vel[0] + vel[2] * vel[2]).sqrt();
                let (dir_x, dir_z) = if speed > 1e-6 {
                    (vel[0] / speed, vel[2] / speed)
                } else {
                    (0.0, 0.0)
                };

                this.world.set_velocity(
                    mid,
                    [
                        (dir_x + sx) * ai.walk_speed,
                        vel[1],
                        (dir_z + sz) * ai.walk_speed,
                    ],
                );
            }

            // Return the buffer so its capacity is reused next tick.
            this.scratch_positions = positions;
        });
    }

    /// Integrate NET_BULLET positions (ballistic arc + wall bounce), detect hits
    /// against NET_MONSTER entities, and settle the consequences: spent bullets
    /// are destroyed, hit monsters take PlayerConfig::bullet_damage, and dead
    /// monsters despawn (respawning per MonsterConfig). Returns one HitPatch per
    /// collision and one per expiry (target_eid = None) as UI events.
    ///
    /// Also checks every visible **bullet mirror** (another peer's bullet,
    /// replicated here as a display-only entity with no real net_flags) against
    /// this engine's own locally-simulated monsters. A monster's health is only
    /// ever mutated by its owner, so this is what makes a bullet fired by one
    /// peer able to damage a monster owned by another: the owner is already
    /// receiving that bullet's replicated position, it just wasn't checking it.
    /// No new wire message needed — see ADR 0007.
    fn tick_bullets(&mut self, dt_secs: f32) -> Vec<HitPatch> {
        let (hits, spent_bullets, damaged_monsters) = self.with_scratch_ids(|this, bullet_ids| {
            Self::collect_by_flag(&this.world, NET_BULLET, bullet_ids);
            let any_mirror_bullets = this.mirror_flags.values().any(|&f| f & NET_BULLET != 0);

            // No local bullets in flight and no remote bullets to check against our
            // own monsters: skip the monster snapshot scan+alloc entirely. This is
            // the common case for a session with no peers connected yet.
            if bullet_ids.is_empty() && !any_mirror_bullets {
                return (Vec::new(), Vec::new(), Vec::new());
            }

            // Snapshot monster positions before the bullet loop so we can check hits without
            // a conflicting borrow on this.world inside the integration logic.
            let mut monster_snapshots = std::mem::take(&mut this.scratch_snapshots);
            monster_snapshots.clear();
            monster_snapshots.extend(
                this.world
                    .entities()
                    .filter(|&id| {
                        this.world
                            .net_flags(id)
                            .is_some_and(|f| f & NET_MONSTER != 0)
                            // Dying monsters stop being bullet targets (ADR 0020).
                            && !this.dying.contains(&id)
                    })
                    .filter_map(|id| Some((id, this.world.position(id)?))),
            );

            let mut hits: Vec<HitPatch> = Vec::new();
            let mut spent_bullets: Vec<u32> = Vec::new();
            let mut damaged_monsters: Vec<u32> = Vec::new();

            for &id in bullet_ids.iter() {
                // TTL gate. Use a block so the mutable borrow on bullet_ages is
                // dropped before the rest of the loop body (which also needs &mut this).
                {
                    let age = this.bullet_ages.entry(id).or_insert(0);
                    *age += 1;
                    if *age > BULLET_MAX_FRAMES {
                        hits.push(HitPatch {
                            bullet_eid: id,
                            target_eid: None,
                        });
                        spent_bullets.push(id);
                        continue;
                    }
                }

                let Some(pos) = this.world.position(id) else {
                    continue;
                };
                let Some(vel) = this.world.velocity(id) else {
                    continue;
                };

                // Bullet left the play area.
                if pos[1] < BULLET_KILL_PLANE_Y {
                    hits.push(HitPatch {
                        bullet_eid: id,
                        target_eid: None,
                    });
                    spent_bullets.push(id);
                    continue;
                }

                // Apply gravity before integration so it accumulates across ticks.
                // Shadow vel so the gravity-adjusted values are used for the ray and position.
                let vel = [vel[0], vel[1] + this.gravity * dt_secs, vel[2]];

                let speed = (vel[0].powi(2) + vel[1].powi(2) + vel[2].powi(2)).sqrt();
                if speed > 1e-6 {
                    let dir = [vel[0] / speed, vel[1] / speed, vel[2] / speed];
                    let dist = speed * dt_secs;

                    if let Some((normal, toi)) =
                        this.physics
                            .cast_ray_with_normal([pos[0], pos[1], pos[2]], dir, dist)
                    {
                        let dot = vel[0] * normal[0] + vel[1] * normal[1] + vel[2] * normal[2];
                        this.world.set_velocity(
                            id,
                            [
                                vel[0] - 2.0 * dot * normal[0],
                                vel[1] - 2.0 * dot * normal[1],
                                vel[2] - 2.0 * dot * normal[2],
                            ],
                        );
                        // Velocity discontinuity: remote mirrors extrapolate this
                        // bullet, so force an immediate correction instead of
                        // waiting for the next PREDICTABLE_STRIDE tick.
                        if this
                            .world
                            .net_flags(id)
                            .is_some_and(|f| f & NET_REPLICATED != 0)
                        {
                            this.delta_tracker.mark_dirty(id);
                        }
                        this.world.set_position(
                            id,
                            [
                                pos[0] + dir[0] * toi + normal[0] * BULLET_BOUNCE_OFFSET,
                                pos[1] + dir[1] * toi + normal[1] * BULLET_BOUNCE_OFFSET,
                                pos[2] + dir[2] * toi + normal[2] * BULLET_BOUNCE_OFFSET,
                            ],
                        );
                    } else {
                        // Store gravity-updated velocity so the arc accumulates next tick.
                        this.world.set_velocity(id, vel);
                        this.world.set_position(
                            id,
                            [
                                pos[0] + vel[0] * dt_secs,
                                pos[1] + vel[1] * dt_secs,
                                pos[2] + vel[2] * dt_secs,
                            ],
                        );
                    }
                } else {
                    this.world.set_velocity(id, vel);
                }

                this.world.mark_dirty(id, DirtyFlags::TRANSFORM);

                // Read the updated position for hit detection.
                let bpos = match this.world.position(id) {
                    Some(p) => p,
                    None => continue,
                };

                for &(mid, mpos) in &monster_snapshots {
                    let dx = bpos[0] - mpos[0];
                    let dy = bpos[1] - mpos[1];
                    let dz = bpos[2] - mpos[2];
                    if dx * dx + dy * dy + dz * dz < BULLET_HIT_RADIUS_SQ {
                        hits.push(HitPatch {
                            bullet_eid: id,
                            target_eid: Some(mid),
                        });
                        spent_bullets.push(id);
                        damaged_monsters.push(mid);
                        break;
                    }
                }
            }

            // Bullet mirrors (other peers' bullets) vs our own monsters — see
            // this fn's doc comment. Skipped entirely when nothing qualifies,
            // so a session with no remote bullet mirrors pays nothing extra.
            if any_mirror_bullets && !monster_snapshots.is_empty() {
                let mut mirror_bullets = std::mem::take(&mut this.scratch_mirror_bullets);
                mirror_bullets.clear();
                mirror_bullets.extend(
                    this.mirror_flags
                        .iter()
                        .filter(|&(_, &flags)| flags & NET_BULLET != 0)
                        .filter_map(|(&id, _)| Some((id, this.world.position(id)?))),
                );

                for &(bid, bpos) in &mirror_bullets {
                    for &(mid, mpos) in &monster_snapshots {
                        let dx = bpos[0] - mpos[0];
                        let dy = bpos[1] - mpos[1];
                        let dz = bpos[2] - mpos[2];
                        if dx * dx + dy * dy + dz * dz < BULLET_HIT_RADIUS_SQ {
                            hits.push(HitPatch {
                                bullet_eid: bid,
                                target_eid: Some(mid),
                            });
                            spent_bullets.push(bid);
                            damaged_monsters.push(mid);
                            break;
                        }
                    }
                }

                this.scratch_mirror_bullets = mirror_bullets;
            }

            // Return the buffer so its capacity is reused next tick.
            this.scratch_snapshots = monster_snapshots;

            (hits, spent_bullets, damaged_monsters)
        });

        // Settle consequences after the integration loop so entity destruction
        // never invalidates the snapshots it iterated.
        for id in spent_bullets {
            self.destroy_entity(id);
        }
        for mid in damaged_monsters {
            // A monster already playing its death animation ignores further hits.
            if self.dying.contains(&mid) {
                continue;
            }
            // Already destroyed this tick (two bullets, one monster) → skip.
            let Some(hp) = self.world.health(mid) else {
                continue;
            };
            let hp = hp - self.player_cfg.bullet_damage;
            self.world.set_health(mid, hp);
            self.world.mark_dirty(mid, DirtyFlags::HEALTH);
            if hp <= 0 {
                self.begin_death(mid);
            } else {
                // Non-lethal: a quick flinch (a no-op if there's no hurt family).
                self.request_entity_action(mid, ANIM_KIND_HURT, None, None);
            }
        }

        hits
    }

    /// Lethal damage: play a death animation and despawn when it finishes
    /// (ADR 0020). A dying entity is pulled out of AI, separation, and bullet
    /// targeting immediately (below), so it stops acting the instant it dies. If
    /// there's no real (non-looping) death animation to play, destroy at once.
    fn begin_death(&mut self, id: u32) {
        let has_death_anim = self.animation_set.as_ref().is_some_and(|set| {
            let fam = set.family_for_action(ANIM_KIND_DEATH, None);
            set.families.get(fam).is_some_and(|f| !f.looping)
        });
        if has_death_anim {
            self.dying.insert(id);
            self.world.set_velocity(id, [0.0, 0.0, 0.0]);
            self.request_entity_action(id, ANIM_KIND_DEATH, None, None);
        } else {
            self.finish_death(id);
        }
    }

    /// Despawn a dead entity; monsters respawn per MonsterConfig.
    fn finish_death(&mut self, id: u32) {
        let was_monster = self.world.net_flags(id).is_some_and(|f| f & NET_MONSTER != 0);
        self.dying.remove(&id);
        self.destroy_entity(id);
        if was_monster && self.monster_cfg.respawn {
            self.respawn_monster();
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new(None, None)
    }
}

// --- Blueprint types ---

#[derive(Decode, Encode)]
struct EntityBlueprint {
    position: Option<[f32; 3]>,
    net_flags: Option<u8>,
    health: Option<i32>,
    collider: Option<ColliderBp>,
}

#[derive(Decode, Encode)]
struct ColliderBp {
    active: bool,
    sensor: bool,
    hw: f32,
    hh: f32,
    hd: f32,
}

// --- JS-serializable mirror types for serde_wasm_bindgen ---

#[derive(Serialize)]
struct JsTerrainBlock {
    eid: u32,
    x: f32,
    y: f32,
    z: f32,
    hw: f32,
    hh: f32,
    hd: f32,
    kind: String,
}

#[derive(Serialize)]
struct JsWaypoint {
    x: f32,
    y: f32,
    z: f32,
    #[serde(rename = "requiresJump")]
    requires_jump: bool,
    #[serde(rename = "isLedgeDrop")]
    is_ledge_drop: bool,
}

#[derive(Serialize)]
struct JsMetrics {
    tick_ms: f32,
    ai_ms: f32,
    physics_ms: f32,
    pathfinding_ms: f32,
    net_ms: f32,
    patch_ms: f32,
}

#[derive(Serialize)]
struct JsPatch {
    tick: u64,
    render: Vec<JsRender>,
    semantic: Vec<JsSemantic>,
    net: Vec<JsNet>,
    hits: Vec<JsHit>,
    lifecycle: Vec<JsLifecycle>,
    metrics: JsMetrics,
}

#[derive(Serialize)]
struct JsLifecycle {
    entity: u32,
    kind: &'static str,
    flags: u8,
}

fn js_lifecycle_kind(kind: LifecycleKind) -> &'static str {
    match kind {
        LifecycleKind::Spawned => "spawned",
        LifecycleKind::Despawned => "despawned",
    }
}

#[derive(Serialize)]
struct JsRender {
    entity: u32,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    pitch: f32,
    roll: f32,
}

#[derive(Serialize)]
struct JsSemantic {
    entity: u32,
    health: Option<i32>,
    net_flags: Option<u8>,
    grounded: Option<bool>,
    anim_id: Option<u16>,
    anim_frame: Option<u16>,
    anim_dir: Option<u8>,
}

#[derive(Serialize)]
struct JsNet {
    peer_id: String,
    entity: u32,
    kind: &'static str,
    flags: Option<u8>,
}

fn js_net_kind(kind: NetEventKind) -> &'static str {
    match kind {
        NetEventKind::EntitySpawned => "spawned",
        NetEventKind::EntityUpdated => "updated",
        NetEventKind::EntityDespawned => "despawned",
        NetEventKind::PeerJoined => "peer_joined",
        NetEventKind::PeerLeft => "peer_left",
    }
}

#[derive(Serialize)]
struct JsHit {
    bullet_eid: u32,
    target_eid: Option<u32>,
}

impl From<PatchBundle> for JsPatch {
    fn from(b: PatchBundle) -> Self {
        Self {
            tick: b.tick,
            render: b
                .render
                .into_iter()
                .map(|r| JsRender {
                    entity: r.entity,
                    x: r.x,
                    y: r.y,
                    z: r.z,
                    yaw: r.yaw,
                    pitch: r.pitch,
                    roll: r.roll,
                })
                .collect(),
            semantic: b
                .semantic
                .into_iter()
                .map(|s| JsSemantic {
                    entity: s.entity,
                    health: s.health,
                    net_flags: s.net_flags,
                    grounded: s.grounded,
                    anim_id: s.anim_id,
                    anim_frame: s.anim_frame,
                    anim_dir: s.anim_dir,
                })
                .collect(),
            net: b
                .net
                .into_iter()
                .map(|n| JsNet {
                    peer_id: n.peer_id,
                    entity: n.entity,
                    kind: js_net_kind(n.kind),
                    flags: n.flags,
                })
                .collect(),
            hits: b
                .hits
                .into_iter()
                .map(|h| JsHit {
                    bullet_eid: h.bullet_eid,
                    target_eid: h.target_eid,
                })
                .collect(),
            lifecycle: b
                .lifecycle
                .into_iter()
                .map(|l| JsLifecycle {
                    entity: l.entity,
                    kind: js_lifecycle_kind(l.kind),
                    flags: l.flags,
                })
                .collect(),
            metrics: JsMetrics {
                tick_ms: b.metrics.tick_ms,
                ai_ms: b.metrics.ai_ms,
                physics_ms: b.metrics.physics_ms,
                pathfinding_ms: b.metrics.pathfinding_ms,
                net_ms: b.metrics.net_ms,
                patch_ms: b.metrics.patch_ms,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test fixture: the castle layout (x, y, z, hw, hh, hd, walkable). The canonical
    // map now lives in the game layer (apps/web); this copy exists only to exercise
    // navmesh construction over realistic stair/platform/wall geometry. Walls are
    // walkable=false, mirroring kikorinMap.ts.
    const CASTLE_MAP: &[(f32, f32, f32, f32, f32, f32, bool)] = &[
        // MAIN FLOOR
        (0.0, -1.0, -5.0, 60.0, 1.0, 75.0, true),
        // EAST WING — ramp steps
        (11.5, 0.5, 12.0, 1.5, 0.5, 5.0, true),
        (14.5, 1.0, 12.0, 1.5, 1.0, 5.0, true),
        (17.5, 1.5, 12.0, 1.5, 1.5, 5.0, true),
        (20.5, 2.0, 12.0, 1.5, 2.0, 5.0, true),
        (31.0, 3.7, -6.0, 9.0, 0.3, 22.0, true),
        (42.0, 3.7, 0.0, 2.0, 0.3, 3.0, true),
        (47.0, 3.7, 0.0, 3.0, 0.3, 4.0, true),
        // WEST WING — staircase
        (-12.0, 0.5, 5.0, 1.5, 0.5, 2.5, true),
        (-15.0, 1.0, 5.0, 1.5, 1.0, 2.5, true),
        (-18.0, 1.5, 5.0, 1.5, 1.5, 2.5, true),
        (-21.0, 2.0, 5.0, 1.5, 2.0, 2.5, true),
        (-31.0, 3.7, -6.0, 9.0, 0.3, 22.0, true),
        // NORTH BRIDGE
        (0.0, 3.7, -26.0, 22.0, 0.3, 5.0, true),
        // NORTH KEEP
        (0.0, 3.7, -37.0, 8.0, 0.3, 6.0, true),
        (0.0, 4.5, -44.0, 4.0, 0.5, 1.5, true),
        (0.0, 5.5, -47.0, 4.0, 0.5, 1.5, true),
        (0.0, 6.5, -50.0, 4.0, 0.5, 1.5, true),
        (0.0, 7.5, -53.0, 4.0, 0.5, 1.5, true),
        // UPPER KEEP
        (0.0, 7.7, -58.0, 5.0, 0.3, 4.0, true),
        (0.0, 9.5, -62.0, 5.0, 1.5, 0.4, false),
        // SOUTH TERRACE
        (0.0, 0.5, 28.5, 8.0, 0.5, 1.5, true),
        (0.0, 1.0, 25.5, 8.0, 1.0, 1.5, true),
        (0.0, 1.5, 22.5, 8.0, 1.5, 1.5, true),
        (0.0, 2.7, 17.0, 12.0, 0.3, 5.0, true),
        // WALLS & PARAPETS
        (-5.0, 1.5, -7.0, 0.5, 1.5, 3.0, false),
        (5.0, 1.5, -7.0, 0.5, 1.5, 3.0, false),
        (40.0, 4.8, -6.0, 0.3, 0.8, 22.0, false),
        (-40.0, 4.8, -6.0, 0.3, 0.8, 22.0, false),
        (-11.0, 4.8, -31.0, 11.0, 0.8, 0.4, false),
        (11.0, 4.8, -31.0, 11.0, 0.8, 0.4, false),
    ];

    fn castle_blocks() -> Vec<MapBlock> {
        CASTLE_MAP
            .iter()
            .map(|&(x, y, z, hw, hh, hd, walkable)| MapBlock {
                x,
                y,
                z,
                hw,
                hh,
                hd,
                kind: if walkable { "platform" } else { "wall" }.to_string(),
                walkable,
            })
            .collect()
    }

    fn engine_with_static_map() -> Engine {
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&castle_blocks());
        engine
    }

    #[test]
    fn east_stair_path_keeps_waypoints_inside_stair_treads() {
        let engine = engine_with_static_map();
        let navmesh = engine.navmesh.as_ref().expect("navmesh should be built");

        let path = navmesh
            .find_path(PathRequest {
                start: [11.5, 0.0, 12.0],
                goal: [31.0, 0.0, -6.0],
                route_seed: None,
                can_jump: true,
                can_sprint: false,
                can_phase: false,
                start_y: Some(0.0),
            })
            .expect("east stair should route to the platform");

        assert!(
            path.iter()
                .any(|wp| wp.x > 22.0 && (wp.y - 4.0).abs() < 0.01),
            "path should reach the upper platform: {path:?}",
        );
        assert!(
            path.iter()
                .find(|wp| wp.x > 22.0)
                .is_some_and(|wp| wp.z > 7.1),
            "path should enter the platform through the supported stair seam: {path:?}",
        );

        for wp in path
            .iter()
            .filter(|wp| wp.x >= 10.0 && wp.x <= 22.0 && wp.y >= 1.0)
        {
            assert!(
                wp.z > 7.1 && wp.z < 16.9,
                "stair waypoint should stay inside the tread, not on an edge: {wp:?}",
            );
        }
    }

    #[test]
    fn navmesh_bounds_derive_from_terrain_location() {
        // A map placed far outside the old hardcoded ±80 world bounds must still
        // produce a walkable navmesh — bounds come from the geometry, not the engine.
        let mut engine = Engine::new(None, None);
        let blocks: Vec<MapBlock> = [
            (200.0, -1.0, 200.0, 15.0, 1.0, 15.0),
            (220.0, -1.0, 200.0, 5.0, 1.0, 5.0),
        ]
        .iter()
        .map(|&(x, y, z, hw, hh, hd)| MapBlock {
            x,
            y,
            z,
            hw,
            hh,
            hd,
            kind: "floor".to_string(),
            walkable: true,
        })
        .collect();

        let placed = engine.load_map_blocks(&blocks);
        assert_eq!(placed.len(), 2);

        let navmesh = engine.navmesh.as_ref().expect("navmesh should be built");
        let path = navmesh.find_path(PathRequest {
            start: [190.0, 0.0, 195.0],
            goal: [222.0, 0.0, 200.0],
            route_seed: None,
            can_jump: true,
            can_sprint: false,
            can_phase: false,
            start_y: Some(0.0),
        });
        assert!(
            path.is_some(),
            "path should exist across terrain located at ~(200, 200)"
        );
    }

    #[test]
    fn navmesh_is_none_without_floor_geometry() {
        let mut engine = Engine::new(None, None);
        engine.build_navmesh();
        assert!(engine.navmesh.is_none(), "no floors → no navmesh");
    }

    #[test]
    fn goal_beside_parapet_wall_stays_reachable() {
        // The ±40 parapet tops must not carry navmesh nodes (walkable=false): a goal
        // next to the wall would otherwise snap to an unreachable wall-top node and
        // every search for it would fail after exploring the entire mesh.
        let engine = engine_with_static_map();
        let navmesh = engine.navmesh.as_ref().expect("navmesh should be built");

        let path = navmesh
            .find_path(PathRequest {
                start: [25.0, 4.0, -6.0],
                goal: [39.9, 0.0, -6.0],
                route_seed: None,
                can_jump: true,
                can_sprint: false,
                can_phase: false,
                start_y: Some(4.0),
            })
            .expect("goal hugging the east parapet must resolve to a platform node");

        for wp in &path {
            assert!(
                wp.y < 5.0,
                "no waypoint may sit on the parapet top (y≈5.6): {wp:?}",
            );
        }
    }

    #[test]
    fn full_height_wall_thinner_than_a_cell_still_blocks_lateral_pathing() {
        // A maze-style partition wall (unlike a parapet) has open, walkable
        // floor on BOTH sides at the SAME height — the case that originally
        // slipped through: the wall is thinner (1.0) than NavConfig's default
        // cell_size (1.5), so its footprint can fall entirely between two
        // neighboring grid nodes without covering either one's sample point.
        // Without horizontally_blocked, those two nodes would still connect at
        // zero height-difference cost, letting monsters walk straight through.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0,
                y: -0.5,
                z: 0.0,
                hw: 10.0,
                hh: 0.5,
                hd: 10.0,
                kind: "floor".into(),
                walkable: true,
            },
            // A wall spanning the full width, no doorway — the two sides
            // must be entirely disconnected, not just longer to route between.
            MapBlock {
                x: 0.0,
                y: 1.0,
                z: 0.0,
                hw: 10.0,
                hh: 1.0,
                hd: 0.5,
                kind: "wall".into(),
                walkable: false,
            },
        ]);
        let navmesh = engine.navmesh.as_ref().expect("navmesh should be built");

        let path = navmesh.find_path(PathRequest {
            start: [0.0, 0.0, -5.0],
            goal: [0.0, 0.0, 5.0],
            route_seed: None,
            can_jump: true,
            can_sprint: false,
            can_phase: false,
            start_y: Some(0.0),
        });
        assert!(
            path.is_none(),
            "a full-width wall must fully disconnect the two sides, got: {path:?}",
        );
    }

    #[test]
    fn unreachable_goal_does_not_replan_every_tick() {
        // A goal on an isolated island makes every A* search fail after exhausting
        // the graph. Failed searches must respect the replan cooldown — the exhausted-
        // path branch must not zero it, or one bad goal becomes a full-mesh search
        // per tick and the tick budget collapses.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0,
                y: -1.0,
                z: 0.0,
                hw: 20.0,
                hh: 1.0,
                hd: 20.0,
                kind: "floor".into(),
                walkable: true,
            },
            // Island 8 units up: far beyond max_step_up, no edges connect it.
            MapBlock {
                x: 30.0,
                y: 7.0,
                z: 0.0,
                hw: 3.0,
                hh: 0.3,
                hd: 3.0,
                kind: "platform".into(),
                walkable: true,
            },
        ]);
        engine.spawn_box_entity(0.0, 1.0, 0.0, 0.4, 0.9, 0.4, 30, NET_LOCAL | NET_MONSTER);
        engine.update_monster_goal(30.0, 0.0); // snaps to the island → unreachable

        let mut searches = 0u32;
        for _ in 0..1000 {
            if engine.tick_monster_ai(0.004) > 0.0 {
                searches += 1;
            }
        }
        // 4 s of sim at a 3 s cooldown (initial stagger ≤ 3 s) → at most ~3 searches.
        assert!(
            searches <= 4,
            "failed searches must be cooldown-limited, got {searches} in 1000 ticks",
        );
    }

    fn engine_with_flat_floor() -> Engine {
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[MapBlock {
            x: 0.0,
            y: -1.0,
            z: 0.0,
            hw: 20.0,
            hh: 1.0,
            hd: 20.0,
            kind: "floor".into(),
            walkable: true,
        }]);
        engine
    }

    fn bullet_count(engine: &Engine) -> usize {
        engine
            .world
            .entities()
            .filter(|&id| engine.world.net_flags(id).is_some_and(|f| f & NET_BULLET != 0))
            .count()
    }

    // A 3-frame attack (fixed 100 ms each) whose FIRE event sits on frame 1, plus
    // a trivial idle. Drives the "bullet spawns on the strike frame" contract.
    fn test_family(frames: Vec<animation::FrameSpec>, looping: bool, interrupt: animation::Interrupt) -> animation::Family {
        animation::Family {
            frames,
            looping,
            next: None,
            hold_last: false,
            interrupt,
            branch_frame: None,
            move_mask: animation::MoveMask::ALL,
            retriggerable: false,
        }
    }

    fn fire_on_frame1_anim_set() -> animation::AnimationSet {
        let mut set = animation::AnimationSet::new();
        let idle = set.push_family(test_family(vec![animation::FrameSpec::fixed(100.0)], true, animation::Interrupt::Always));
        let mut strike = animation::FrameSpec::fixed(100.0);
        strike.event = Some(ANIM_EVENT_FIRE);
        let mut attack_fam = test_family(
            vec![animation::FrameSpec::fixed(100.0), strike, animation::FrameSpec::fixed(100.0)],
            false,
            animation::Interrupt::Block,
        );
        attack_fam.move_mask = animation::MoveMask::ROOTED; // exercises the move-mask gate (ADR 0018)
        let attack = set.push_family(attack_fam);
        // A one-shot death family (hold_last) → the dying flow can complete (ADR 0020).
        let mut death_fam = test_family(
            vec![animation::FrameSpec::fixed(100.0), animation::FrameSpec::fixed(100.0)],
            false,
            animation::Interrupt::Block,
        );
        death_fam.hold_last = true;
        let death = set.push_family(death_fam);
        set.map_action(ANIM_KIND_IDLE, None, idle);
        set.map_action(ANIM_KIND_ATTACK, None, attack);
        set.map_action(ANIM_KIND_DEATH, None, death);
        set
    }

    #[test]
    fn player_bullet_spawns_on_the_attack_fire_frame_not_the_click() {
        let mut engine = engine_with_flat_floor();
        engine.animation_set = Some(fire_on_frame1_anim_set());
        let player = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(player);

        // Fire only *requests* the attack — no bullet yet (deferred to FIRE frame).
        engine.player_fire();
        assert_eq!(bullet_count(&engine), 0, "no bullet on the click itself");

        // Frame 0 is [0,100)ms; at 4 ms/tick, frame 1 (the FIRE frame) begins at
        // tick 25. Nothing should spawn before then.
        for _ in 0..20 {
            engine.tick_core(0.004);
        }
        assert_eq!(bullet_count(&engine), 0, "still winding up — no bullet before the strike frame");

        // Cross into the FIRE frame → exactly one bullet.
        for _ in 0..10 {
            engine.tick_core(0.004);
        }
        assert_eq!(bullet_count(&engine), 1, "the strike frame spawns the bullet");
    }

    #[test]
    fn attack_move_mask_roots_the_player() {
        let mut engine = engine_with_flat_floor();
        engine.animation_set = Some(fire_on_frame1_anim_set()); // attack mask = ROOTED
        let player = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(player);
        // Hold full-forward input.
        engine.player.as_mut().unwrap().input.forward = 1.0;

        // Idle (no restriction): forward input produces planar velocity.
        engine.tick_core(0.004);
        let idle_v = engine.world.velocity(player).unwrap();
        assert!((idle_v[0] * idle_v[0] + idle_v[2] * idle_v[2]).sqrt() > 0.1, "moves while idle");

        // Now attack (ROOTED): the same forward input is gated to zero.
        engine.player_fire();
        engine.tick_core(0.004);
        let atk_v = engine.world.velocity(player).unwrap();
        assert!(
            (atk_v[0] * atk_v[0] + atk_v[2] * atk_v[2]).sqrt() < 0.01,
            "rooted attack ignores movement input: {atk_v:?}",
        );
    }

    #[test]
    fn lethal_hit_plays_death_then_despawns_and_stops_being_a_target() {
        let mut engine = engine_with_flat_floor();
        engine.animation_set = Some(fire_on_frame1_anim_set()); // death = 2×100ms hold_last
        engine.monster_cfg.respawn = false;
        // A 1-HP monster so a single hit is lethal, plus a player to own bullets.
        let player = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(player);
        let monster = engine.spawn_box_entity(0.0, 0.9, 2.0, 0.4, 0.9, 0.4, 1, NET_LOCAL | NET_MONSTER);

        // Kill it via the damage path (skip ballistics; drive the settlement directly).
        engine.world.set_health(monster, -1);
        engine.begin_death(monster);
        assert!(engine.dying.contains(&monster), "lethal hit starts the dying state");
        assert!(engine.world.position(monster).is_some(), "not destroyed yet — death plays first");

        // While dying it's excluded from the bullet-target snapshot.
        let targets: Vec<u32> = engine
            .world
            .entities()
            .filter(|&id| engine.world.net_flags(id).is_some_and(|f| f & NET_MONSTER != 0) && !engine.dying.contains(&id))
            .collect();
        assert!(!targets.contains(&monster), "dying monster is not a bullet target");

        // Death anim is 2×100ms; advance past it → despawned.
        for _ in 0..60 {
            engine.tick_core(0.004);
        }
        assert!(engine.world.position(monster).is_none(), "despawns when the death animation finishes");
        assert!(!engine.dying.contains(&monster));
    }

    #[test]
    fn malformed_animation_set_is_rejected_not_installed() {
        // An action pointing at a non-existent family must not install (and must
        // not panic) — animation just stays inert. Built via the DTO so it
        // exercises the same path load_animations uses.
        let bad = JsAnimationSet {
            families: vec![JsAnimFamily {
                frames: vec![JsAnimFrame {
                    optimal_ms: 100.0,
                    min_ms: None,
                    max_ms: None,
                    skippable: false,
                    cancelable: false,
                    event: None,
                }],
                looping: true,
                next: None,
                hold_last: false,
                interrupt: "always".to_string(),
                branch_frame: None,
                movement: None,
                retriggerable: false,
            }],
            actions: vec![JsAnimAction { kind: 0, variant: None, family: 9 }],
        };
        assert!(build_animation_set(bad).is_none(), "bad action mapping must be rejected");
    }

    #[test]
    fn jump_latch_survives_movement_commands_before_the_next_tick() {
        // The lagged-worker message pattern: when a sim pump runs long, queued input
        // messages drain back-to-back — a jump command followed by plain movement
        // commands, all before the next physics step. The jump must still fire.
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        for _ in 0..10 {
            engine.step_physics(0.004);
        }
        let y0 = engine.world.position(eid).expect("entity exists")[1];

        engine.set_entity_velocity(eid, 0.0, 12.0, 0.0); // jump press frame
        engine.set_entity_velocity(eid, 0.0, 0.0, 0.0); // subsequent movement frames
        engine.set_entity_velocity(eid, 0.0, 0.0, 0.0);

        for _ in 0..50 {
            engine.step_physics(0.004);
        }
        let y1 = engine.world.position(eid).expect("entity exists")[1];
        assert!(
            y1 > y0 + 0.5,
            "latched jump must fire despite later movement commands: y0={y0} y1={y1}",
        );
    }

    #[test]
    fn jump_impulse_is_consumed_by_exactly_one_step() {
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        for _ in 0..10 {
            engine.step_physics(0.004);
        }

        engine.set_entity_velocity(eid, 0.0, 12.0, 0.0);
        engine.step_physics(0.004);

        // Latch consumed: no pending entry, and world vy back to the gravity-owned 0.
        assert!(engine.pending_jumps.is_empty(), "latch must clear after the step");
        assert_eq!(
            engine.world.velocity(eid).expect("entity exists")[1],
            0.0,
            "world vy must reset so later ticks preserve gravity accumulation",
        );

        // Full flight at vy=12, g=-20 is ~1.2 s. The body must rise and come back
        // down — a re-applied impulse would hold it climbing forever.
        let mut apex = f32::MIN;
        for _ in 0..400 {
            engine.step_physics(0.004);
            apex = apex.max(engine.world.position(eid).expect("entity exists")[1]);
        }
        let y_final = engine.world.position(eid).expect("entity exists")[1];
        assert!(apex > 2.0, "jump must gain real height, apex={apex}");
        assert!(
            y_final < 1.5,
            "body must land again — impulse re-applied? y_final={y_final} apex={apex}",
        );
    }

    #[test]
    fn destroying_an_entity_drops_its_pending_jump() {
        // Entity IDs are recycled; a stale latch must not launch the next entity
        // that reuses the slot.
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.set_entity_velocity(eid, 0.0, 12.0, 0.0);
        engine.destroy_entity(eid);
        assert!(engine.pending_jumps.is_empty());
    }

    #[test]
    fn teleport_entity_moves_existing_dynamic_body() {
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[MapBlock {
            x: 0.0,
            y: -1.0,
            z: 0.0,
            hw: 20.0,
            hh: 1.0,
            hd: 20.0,
            kind: "floor".into(),
            walkable: true,
        }]);
        let eid = engine.spawn_box_entity(0.0, 5.0, 0.0, 0.4, 0.9, 0.4, 30, NET_LOCAL);

        engine.physics.sync_from_world(&engine.world);
        engine.teleport_entity(eid, 8.0, 4.0, -6.0);
        engine.physics.sync_to_world(&mut engine.world);

        let pos = engine
            .world
            .position(eid)
            .expect("entity should still exist");
        assert!(
            (pos[0] - 8.0).abs() < 0.001
                && (pos[1] - 4.0).abs() < 0.001
                && (pos[2] + 6.0).abs() < 0.001,
            "dynamic body should be moved through Rapier, got {pos:?}",
        );
    }

    #[test]
    fn blueprint_spawn_gets_velocity_and_flag_registries() {
        // Regression: the blueprint path used to skip all NET-flag bookkeeping,
        // leaving blueprint monsters without AI state and without a velocity
        // component (so movement commands silently no-oped).
        let mut engine = Engine::new(None, None);
        let bp = EntityBlueprint {
            position: Some([0.0, 1.0, 0.0]),
            net_flags: Some(NET_LOCAL | NET_MONSTER),
            health: Some(30),
            collider: Some(ColliderBp {
                active: true,
                sensor: false,
                hw: 0.4,
                hh: 0.9,
                hd: 0.4,
            }),
        };
        let payload = bincode::encode_to_vec(&bp, bincode::config::standard()).unwrap();

        let id = engine.spawn_entity(&payload);
        assert_ne!(id, u32::MAX, "blueprint must decode");
        assert!(engine.local_entities.contains(&id));
        assert!(engine.monster_states.contains_key(&id));

        engine.set_entity_velocity(id, 1.0, 0.0, 2.0);
        assert_eq!(
            engine.world.velocity(id),
            Some([1.0, 0.0, 2.0]),
            "movement commands must work on blueprint-spawned entities",
        );
    }

    #[test]
    fn bullet_ttl_expiry_emits_exactly_one_hitpatch() {
        let mut engine = engine_with_flat_floor();
        let b = engine.spawn_bullet(0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0);

        let mut expiries = 0;
        for _ in 0..(BULLET_MAX_FRAMES + 20) {
            let bundle = engine.tick_core(0.004);
            expiries += bundle
                .hits
                .iter()
                .filter(|h| h.bullet_eid == b && h.target_eid.is_none())
                .count();
        }
        assert_eq!(expiries, 1, "TTL expiry must emit exactly one HitPatch");
        assert_eq!(
            engine.world.position(b),
            None,
            "the engine owns bullet destruction — spent bullets must be gone",
        );
    }

    #[test]
    fn player_controller_moves_turns_and_jumps() {
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(eid);
        for _ in 0..10 {
            engine.tick_core(0.004); // settle onto the floor
        }
        let y0 = engine.world.position(eid).expect("player")[1];

        // Full forward + jump held at yaw 0 (facing +z).
        if let Some(p) = engine.player.as_mut() {
            p.input = PlayerInput {
                forward: 1.0,
                jump_held: true,
                ..PlayerInput::default()
            };
        }
        for _ in 0..50 {
            engine.tick_core(0.004);
        }

        let pos = engine.world.position(eid).expect("player");
        assert!(pos[2] > 1.0, "forward input must move the player +z, got {pos:?}");
        assert!(pos[1] > y0 + 0.5, "held jump must lift the player, got {pos:?}");
        assert_eq!(engine.world.rotation(eid).map(|r| r[0]), Some(0.0));
    }

    #[test]
    fn held_jump_fires_exactly_one_impulse() {
        // The budget spends on press edges, not held state: one press held
        // forever = one jump. A single jump at 12 m/s peaks ~3.6 above start;
        // a re-triggered impulse would push the apex well past that.
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(eid);
        for _ in 0..10 {
            engine.tick_core(0.004);
        }
        let y0 = engine.world.position(eid).expect("player")[1];

        if let Some(p) = engine.player.as_mut() {
            p.input.jump_held = true;
        }
        let mut apex = f32::MIN;
        for _ in 0..400 {
            engine.tick_core(0.004);
            apex = apex.max(engine.world.position(eid).expect("player")[1]);
        }
        assert!(apex > y0 + 2.0, "the press edge must jump, apex={apex}");
        assert!(
            apex < y0 + 4.5,
            "holding jump must not re-trigger the impulse, apex={apex}",
        );
    }

    #[test]
    fn player_fire_spawns_a_ballistic_replicated_bullet() {
        let mut engine = engine_with_flat_floor();
        let eid = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(eid);
        engine.pending_lifecycle.clear(); // ignore setup spawns

        engine.player_fire();

        let spawned: Vec<_> = engine
            .pending_lifecycle
            .iter()
            .filter(|l| l.kind == LifecycleKind::Spawned)
            .collect();
        assert_eq!(spawned.len(), 1, "fire must spawn exactly one bullet");
        let bullet = spawned[0];
        assert_ne!(bullet.flags & NET_BULLET, 0);
        assert_ne!(bullet.flags & NET_REPLICATED, 0);
        assert_ne!(bullet.flags & NET_PREDICTABLE, 0);

        // Facing +z at yaw 0: muzzle offset forward/up, velocity along +z.
        let pos = engine.world.position(bullet.entity).expect("bullet");
        assert!((pos[2] - 1.1).abs() < 0.01 && (pos[1] - 1.3).abs() < 0.01, "muzzle offset, got {pos:?}");
        let vel = engine.world.velocity(bullet.entity).expect("bullet velocity");
        assert!(vel[2] > 39.0, "bullet must fly along facing, got {vel:?}");
    }

    #[test]
    fn zero_gravity_engine_bullet_travels_in_a_straight_line() {
        // Top-down games (see kikorinTopDown.ts) construct with gravity: 0 so
        // bullets don't arc — confirms self.gravity, not the bare GRAVITY
        // constant, is what bullet integration actually reads.
        let mut engine = Engine::new(None, Some(0.0));
        let b = engine.spawn_bullet(0.0, 5.0, 0.0, 10.0, 0.0, 0.0, 0);
        for _ in 0..20 {
            engine.tick_core(0.004);
        }
        let vel = engine.world.velocity(b).expect("bullet");
        assert_eq!(vel[1], 0.0, "vy must stay exactly 0 under zero gravity, got {vel:?}");
        let pos = engine.world.position(b).expect("bullet");
        assert_eq!(pos[1], 5.0, "y position must not drift under zero gravity, got {pos:?}");
    }

    #[test]
    fn zero_gravity_engine_dynamic_body_does_not_fall() {
        let mut engine = Engine::new(None, Some(0.0));
        let id = engine.spawn_box_entity(0.0, 5.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        for _ in 0..20 {
            engine.tick_core(0.004);
        }
        let pos = engine.world.position(id).expect("entity");
        assert_eq!(pos[1], 5.0, "must not fall with no floor and no gravity, got {pos:?}");
    }

    #[test]
    fn bullet_kill_despawns_monster_and_respawns_replacement() {
        let mut engine = engine_with_flat_floor();
        let monster = engine.spawn_box_entity(5.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(5.0, 0.0); // hold position
        let b = engine.spawn_bullet(0.0, 0.9, 0.0, 20.0, 0.0, 0.0, 0);
        engine.pending_lifecycle.clear();

        let mut lifecycle: Vec<LifecyclePatch> = Vec::new();
        for _ in 0..200 {
            let bundle = engine.tick_core(0.004);
            lifecycle.extend(bundle.lifecycle);
        }

        // Engine settles everything itself: monster despawned, bullet despawned,
        // replacement spawned on the respawn ring. (Position asserts on the old
        // eids would be meaningless — destroyed ids are recycled immediately.)
        assert!(lifecycle.iter().any(|l| l.kind == LifecycleKind::Despawned && l.entity == monster));
        assert!(lifecycle.iter().any(|l| l.kind == LifecycleKind::Despawned && l.entity == b));
        let respawn = lifecycle
            .iter()
            .find(|l| l.kind == LifecycleKind::Spawned && l.flags & NET_MONSTER != 0)
            .expect("a replacement monster must respawn");
        let rpos = engine.world.position(respawn.entity).expect("respawned monster");
        let dist = (rpos[0] * rpos[0] + rpos[2] * rpos[2]).sqrt();
        assert!(
            (30.0..=40.0).contains(&dist),
            "respawn must land on the configured ring, got {rpos:?}",
        );
    }

    #[test]
    fn spawn_monsters_places_a_ring_with_lifecycle_events() {
        let mut engine = engine_with_flat_floor();
        engine.pending_lifecycle.clear();

        engine.spawn_monsters(10);

        let spawns: Vec<_> = engine
            .pending_lifecycle
            .iter()
            .filter(|l| l.kind == LifecycleKind::Spawned && l.flags & NET_MONSTER != 0)
            .collect();
        assert_eq!(spawns.len(), 10);
        assert_eq!(engine.monster_states.len(), 10, "monsters must get AI state");
        for l in spawns {
            let pos = engine.world.position(l.entity).expect("monster");
            let radius = (pos[0] * pos[0] + pos[2] * pos[2]).sqrt();
            assert!(
                (10.0..=18.1).contains(&radius),
                "ring placement radius out of range: {pos:?}",
            );
        }
    }

    #[test]
    fn bullet_below_kill_plane_emits_exactly_one_hitpatch() {
        // No terrain: the bullet free-falls past the kill plane.
        let mut engine = Engine::new(None, None);
        let b = engine.spawn_bullet(0.0, 1.0, 0.0, 0.0, -30.0, 0.0, 0);

        let mut deaths = 0;
        for _ in 0..400 {
            let bundle = engine.tick_core(0.004);
            deaths += bundle
                .hits
                .iter()
                .filter(|h| h.bullet_eid == b && h.target_eid.is_none())
                .count();
        }
        assert_eq!(deaths, 1, "kill plane must emit exactly one HitPatch");
    }

    #[test]
    fn bullet_hits_monster_exactly_once() {
        let mut engine = engine_with_flat_floor();
        let monster = engine.spawn_box_entity(5.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(5.0, 0.0); // monster is already at its goal — stays put
        let b = engine.spawn_bullet(0.0, 0.9, 0.0, 20.0, 0.0, 0.0, 0);

        let mut monster_hits = 0;
        for _ in 0..200 {
            let bundle = engine.tick_core(0.004);
            monster_hits += bundle
                .hits
                .iter()
                .filter(|h| h.bullet_eid == b && h.target_eid == Some(monster))
                .count();
        }
        assert_eq!(monster_hits, 1, "one flight through the monster = one hit event");
    }

    #[test]
    fn separation_pushes_clustered_monsters_apart() {
        let mut engine = engine_with_flat_floor();
        let a = engine.spawn_box_entity(-0.5, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        let b = engine.spawn_box_entity(0.5, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        // Both marching straight +z, well inside each other's separation radius.
        engine.world.set_velocity(a, [0.0, 0.0, 2.5]);
        engine.world.set_velocity(b, [0.0, 0.0, 2.5]);

        engine.apply_monster_separation();

        let va = engine.world.velocity(a).unwrap();
        let vb = engine.world.velocity(b).unwrap();
        assert!(va[0] < 0.0, "left monster must be pushed left, got {va:?}");
        assert!(vb[0] > 0.0, "right monster must be pushed right, got {vb:?}");
    }

    #[test]
    fn monster_stops_when_goal_reached() {
        // Physics reapplies the last XZ command every sync, so reaching the goal
        // must write a zero velocity, not just skip the steering update.
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(3.0, 0.9, 3.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.world.set_velocity(m, [2.5, 0.0, 0.0]); // stale walk command
        engine.update_monster_goal(3.0, 3.0); // already there

        engine.tick_monster_ai(0.004);

        assert_eq!(
            engine.world.velocity(m),
            Some([0.0, 0.0, 0.0]),
            "goal reached must stop the monster",
        );
    }

    fn waypoint(x: f32, y: f32, z: f32, requires_jump: bool) -> Waypoint {
        Waypoint {
            x,
            y,
            z,
            requires_jump,
            requires_sprint: false,
            requires_phase: false,
            is_ledge_drop: false,
        }
    }

    /// Inject a hand-built path so steering is tested against known waypoints
    /// instead of whatever A* produces.
    fn inject_path(engine: &mut Engine, mid: u32, path: Vec<Waypoint>) {
        let state = engine.monster_states.get_mut(&mid).expect("monster state");
        state.route = Some(ActiveRoute::owned(path));
    }

    /// The injected/owned route's (path, index) view, for assertions.
    fn owned_route(engine: &Engine, mid: u32) -> Option<(&[Waypoint], usize)> {
        match engine.monster_states.get(&mid)?.route.as_ref()? {
            ActiveRoute::Owned { path, index } => Some((path, *index)),
            _ => None,
        }
    }

    #[test]
    fn monster_steers_toward_waypoints_not_the_goal_bearing() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        // Goal matches the path's last waypoint so the path is not stale.
        engine.update_monster_goal(20.0, 5.0);
        inject_path(
            &mut engine,
            m,
            vec![waypoint(0.0, 0.0, 5.0, false), waypoint(20.0, 0.0, 5.0, false)],
        );

        engine.tick_monster_ai(0.004);

        // Direct goal bearing is mostly +x; the first waypoint is straight +z.
        let v = engine.world.velocity(m).expect("velocity");
        assert!(
            v[2] > 0.0 && v[2] > v[0].abs() * 10.0,
            "must walk toward the first waypoint (+z), got {v:?}",
        );
        // Yaw faces the walk direction: atan2(dir_x=0, dir_z=1) = 0.
        let yaw = engine.world.rotation(m).expect("rotation")[0];
        assert!(yaw.abs() < 0.01, "yaw must face +z, got {yaw}");
    }

    #[test]
    fn monster_advances_past_reached_waypoints() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 4.5, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(20.0, 5.0);
        inject_path(
            &mut engine,
            m,
            vec![waypoint(0.0, 0.0, 5.0, false), waypoint(20.0, 0.0, 5.0, false)],
        );

        engine.tick_monster_ai(0.004);

        let (_, index) = owned_route(&engine, m).expect("route");
        assert_eq!(index, 1, "first waypoint is within reach → advance");
        let v = engine.world.velocity(m).expect("velocity");
        assert!(v[0] > 2.0, "must now steer toward the second waypoint (+x), got {v:?}");
    }

    #[test]
    fn monster_jumps_at_a_close_jump_waypoint() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.world.set_grounded(m, true);
        engine.update_monster_goal(2.0, 0.0);
        // Single elevated jump waypoint at the goal, inside jump_trigger_dist.
        inject_path(&mut engine, m, vec![waypoint(2.0, 1.5, 0.0, true)]);

        engine.tick_monster_ai(0.004);

        let v = engine.world.velocity(m).expect("velocity");
        assert_eq!(v[1], engine.ai.jump_speed, "grounded + close jump waypoint → jump, got {v:?}");
        let state = engine.monster_states.get(&m).expect("state");
        assert_eq!(
            state.jump_cooldown, engine.ai.jump_cooldown,
            "jumping must start the jump cooldown",
        );
    }

    #[test]
    fn monster_with_a_jump_budget_double_jumps_at_the_first_apex_not_before() {
        // AiConfig::max_jumps must let a monster actually execute a gap the
        // navmesh solved assuming more than one jump — otherwise the mesh
        // and the mover disagree and it strands mid-air. See ADR 0008.
        let mut engine = engine_with_flat_floor();
        engine.ai.max_jumps = 2;
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.world.set_grounded(m, true);
        engine.update_monster_goal(2.0, 0.0);
        inject_path(&mut engine, m, vec![waypoint(2.0, 4.0, 0.0, true)]);
        // Long enough that neither tick below risks an incidental replan
        // clobbering the injected path.
        engine.monster_states.get_mut(&m).unwrap().replan_cooldown = 10.0;

        engine.tick_monster_ai(0.004);
        assert_eq!(
            engine.world.velocity(m).unwrap()[1],
            engine.ai.jump_speed,
            "grounded + close jump waypoint → first jump",
        );
        assert_eq!(engine.monster_states.get(&m).unwrap().jumps_used, 1);

        // Still rising (vy > 0): a second jump this early would overshoot
        // jump_reachable's apex-chaining assumption — must not fire yet.
        engine.world.set_grounded(m, false);
        engine.world.set_velocity(m, [0.0, 5.0, 0.0]);
        engine.tick_monster_ai(0.004);
        assert_eq!(
            engine.world.velocity(m).unwrap()[1],
            0.0,
            "still rising past the first jump — must not double-jump early",
        );
        assert_eq!(engine.monster_states.get(&m).unwrap().jumps_used, 1);

        // Past the apex (vy <= 0), still airborne, budget remaining → the
        // second jump fires now, timed to match the reachability solve.
        engine.world.set_velocity(m, [0.0, -0.5, 0.0]);
        engine.tick_monster_ai(0.004);
        assert_eq!(
            engine.world.velocity(m).unwrap()[1],
            engine.ai.jump_speed,
            "past the apex with budget remaining → second jump",
        );
        assert_eq!(engine.monster_states.get(&m).unwrap().jumps_used, 2);

        // Budget exhausted: a third attempt (still airborne, past another
        // apex) must not fire.
        engine.world.set_velocity(m, [0.0, -0.5, 0.0]);
        engine.tick_monster_ai(0.004);
        assert_eq!(
            engine.world.velocity(m).unwrap()[1],
            0.0,
            "budget exhausted (max_jumps=2) — must not jump a third time",
        );
    }

    #[test]
    fn monster_capability_walk_speed_overrides_the_global_default() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            m,
            MonsterCapability { walk_speed: 99.0, can_jump: true, can_sprint: false, can_phase: false, can_fly: false },
        );
        engine.update_monster_goal(10.0, 0.0);

        engine.tick_monster_ai(0.004);

        let v = engine.world.velocity(m).unwrap();
        let speed = (v[0] * v[0] + v[2] * v[2]).sqrt();
        assert!(
            (speed - 99.0).abs() < 0.01,
            "override walk_speed must drive the written velocity magnitude, got {v:?}",
        );
    }

    #[test]
    fn monster_capability_can_jump_false_finds_no_path_when_jumping_is_the_only_route() {
        // Two contiguous platforms forming a single step (height diff 0.6,
        // within NavConfig defaults' jump_threshold..max_step_up range) —
        // the only connection between them is a jump-only edge.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -0.5, z: 0.0, hw: 3.0, hh: 0.5, hd: 3.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: 6.0, y: 0.3, z: 0.0, hw: 3.0, hh: 0.3, hd: 3.0,
                kind: "floor".into(), walkable: true,
            },
        ]);

        let capable = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        let weak = engine.spawn_box_entity(0.5, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            weak,
            MonsterCapability { walk_speed: engine.ai.walk_speed, can_jump: false, can_sprint: false, can_phase: false, can_fly: false },
        );
        engine.update_monster_goal(6.0, 0.0);
        engine.monster_states.get_mut(&capable).unwrap().replan_cooldown = 0.0;
        engine.monster_states.get_mut(&weak).unwrap().replan_cooldown = 0.0;

        // At most one A* search runs per tick — two ticks guarantees both
        // monsters actually get a turn (a denied search keeps its zero
        // cooldown, so nothing is lost by waiting).
        engine.tick_monster_ai(0.004);
        engine.tick_monster_ai(0.004);

        let capable_path = owned_route(&engine, capable).map(|(p, _)| p.to_vec());
        let weak_path = owned_route(&engine, weak).map(|(p, _)| p.to_vec());
        assert!(
            capable_path.as_ref().is_some_and(|p| p.iter().any(|wp| wp.requires_jump)),
            "default (can_jump) monster should find a path using the jump, got {capable_path:?}",
        );
        assert!(
            weak_path.is_none(),
            "can_jump:false monster must find no path when jumping is the only route, got {weak_path:?}",
        );
    }

    #[test]
    fn flying_monster_closes_3d_distance_toward_the_player_including_altitude() {
        let mut engine = engine_with_flat_floor();
        let player = engine.spawn_box_entity(6.0, 8.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        engine.register_player(player);

        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            m,
            MonsterCapability { walk_speed: 10.0, can_jump: true, can_sprint: false, can_phase: false, can_fly: true },
        );

        engine.tick_monster_ai(0.004);

        let v = engine.world.velocity(m).unwrap();
        let speed = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        assert!(
            (speed - 10.0).abs() < 0.01,
            "flying speed must match capability.walk_speed, got {v:?}",
        );
        assert!(v[1] > 0.0, "flying monster below the player must climb, got {v:?}");

        let expected = [6.0_f32, 7.1, 0.0]; // player (6,8,0) minus monster (0,0.9,0)
        let norm = (expected[0].powi(2) + expected[1].powi(2) + expected[2].powi(2)).sqrt();
        for i in 0..3 {
            assert!(
                (v[i] / speed - expected[i] / norm).abs() < 0.01,
                "flight direction should point straight at the player, axis {i}: {v:?}",
            );
        }
        assert!(
            engine.monster_states.get(&m).unwrap().route.is_none(),
            "a flying monster must never touch the navmesh/pathfinding system",
        );
    }

    #[test]
    fn crowd_chasers_adopt_a_shared_flow_field_once_it_builds() {
        let mut engine = engine_with_flat_floor();
        let player =
            engine.spawn_box_entity(10.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        engine.register_player(player);
        let m1 = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        let m2 = engine.spawn_box_entity(-1.0, 0.9, 1.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);

        // Enough ticks for the heavy queue to finish discovery and build the
        // shared field; monsters direct-steer meanwhile (never blocked).
        for _ in 0..600 {
            engine.tick_core(0.004);
        }

        for m in [m1, m2] {
            assert!(
                matches!(
                    engine.monster_states.get(&m).and_then(|s| s.route.as_ref()),
                    Some(ActiveRoute::Flow { .. })
                ),
                "chaser {m} must ride the shared flow field once built",
            );
            let p = engine.world.position(m).expect("alive");
            assert!(p[0] > 1.0, "chaser {m} must have progressed toward the player, got {p:?}");
        }
        assert_eq!(
            engine.pathing.flow_fields.len(),
            1,
            "one shared field serves every same-goal chaser",
        );
    }

    #[test]
    fn flow_field_followers_detour_around_walls_instead_of_beelining() {
        // Regression: cell_size (1.5) < waypoint_reach (1.8) made every flat
        // flow hop instantly "reached", collapsing flow following into direct
        // pursuit — invisible on a flat floor, wall-hugging on a real map.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 10.0,
                kind: "floor".into(), walkable: true,
            },
            // Tall wall across z=0 leaving only an east gap (x in [6,10]).
            MapBlock {
                x: -2.0, y: 3.0, z: 0.0, hw: 8.0, hh: 3.0, hd: 0.4,
                kind: "wall".into(), walkable: false,
            },
        ]);
        let player =
            engine.spawn_box_entity(-8.0, 0.9, 8.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        engine.register_player(player);
        let m = engine.spawn_box_entity(-8.0, 0.9, -8.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        // Isolate the flow path: no A* of its own (a valid Owned route would
        // correctly be kept until exhausted), no stuck-escape resets.
        engine.monster_states.get_mut(&m).unwrap().replan_cooldown = 1_000.0;
        engine.ai.stuck_escape_after = 1_000.0;

        // Enough ticks for discovery to finish and the flow field to build.
        for _ in 0..400 {
            engine.tick_core(0.004);
        }
        assert!(
            matches!(
                engine.monster_states.get(&m).and_then(|s| s.route.as_ref()),
                Some(ActiveRoute::Flow { .. })
            ),
            "chaser must be riding the flow field by now",
        );

        let [mx, _, mz] = engine.world.position(m).unwrap();
        if mz < -1.0 {
            // Still on the wall's far side: the field must steer east toward
            // the gap, not straight at the player (direct is pure +z here).
            let v = engine.world.velocity(m).unwrap();
            assert!(
                v[0] > v[2].abs() * 0.5 && v[0] > 0.5,
                "flow follower behind the wall must head east toward the gap, got {v:?} at ({mx},{mz})",
            );
        } else {
            // Already through: it can only have gotten here via the east gap.
            assert!(
                mx > 4.0 || mz > -1.0,
                "monster crossed the wall line without using the gap: ({mx},{mz})",
            );
        }
    }

    #[test]
    fn frustration_escalates_on_no_progress_and_resets_on_real_progress() {
        let ai = AiConfig::default();
        let mut state = MonsterState::new(0.0);

        // First observation baselines (goal "moved" from the INFINITY init).
        assert!(!state.update_progress(&ai, 0.1, 10.0, [10.0, 0.0]));
        assert_eq!(state.frustration, 0);

        // Closing distance is progress — timer resets, no escalation.
        assert!(!state.update_progress(&ai, 0.1, 9.0, [10.0, 0.0]));

        // Moving without closing: escalates once the window elapses.
        let mut fired = 0;
        for _ in 0..40 {
            if state.update_progress(&ai, 0.1, 9.2, [10.0, 0.0]) {
                fired += 1;
            }
        }
        assert_eq!(fired, 2, "4s of no progress at a 2s window = 2 escalations");
        assert_eq!(state.frustration, 2);

        // The goal itself jumping re-baselines without penalizing.
        assert!(!state.update_progress(&ai, 0.1, 25.0, [30.0, 0.0]));
        assert_eq!(state.frustration, 2, "a fleeing goal is not the monster's failure");

        // Real progress clears frustration entirely.
        assert!(!state.update_progress(&ai, 0.1, 20.0, [30.0, 0.0]));
        assert_eq!(state.frustration, 0);
    }

    #[test]
    fn frustration_pierces_a_cold_replan_cooldown_and_finds_a_way_around() {
        // A monster beelining into a wall (no route, replan cooldown far in
        // the future) used to do so forever. Frustration must notice the
        // lack of progress, pierce the cooldown, and get a real route.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 10.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: -2.0, y: 3.0, z: 0.0, hw: 8.0, hh: 3.0, hd: 0.4,
                kind: "wall".into(), walkable: false,
            },
        ]);
        // Fallback goal beyond the wall (no player → no flow field lane).
        engine.update_monster_goal(-8.0, 8.0);
        let m = engine.spawn_box_entity(-8.0, 0.9, -8.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_states.get_mut(&m).unwrap().replan_cooldown = 1_000.0;
        engine.ai.stuck_escape_after = 1_000.0; // isolate frustration from stuck-escape

        // ~10s: ~3s of legitimate approach progress, then the wall jam, the
        // 2s no-progress window, and time to route east after escalation.
        for _ in 0..2_500 {
            engine.tick_core(0.004);
        }

        let state = engine.monster_states.get(&m).unwrap();
        assert!(
            state.route.is_some(),
            "escalation must have pierced the cooldown and produced a route",
        );
        let v = engine.world.velocity(m).unwrap();
        let [mx, _, mz] = engine.world.position(m).unwrap();
        if mz < -1.0 {
            assert!(
                v[0] > 0.3,
                "behind the wall the route must head east toward the gap, got {v:?} at ({mx},{mz})",
            );
        }
    }

    /// Run ticks with the heavy-slice budget forced wide open — debug
    /// builds run raycasts ~50x slower than release/wasm, so the adaptive
    /// tuner correctly throttles to its floor here and sweeps that finish
    /// in ~1s of release gameplay would take thousands of debug ticks.
    /// Tests assert functionality, not debug-build pacing.
    fn tick_fast(engine: &mut Engine, ticks: usize) {
        for _ in 0..ticks {
            engine.pathing.slice_units = 1_000_000;
            engine.tick_core(0.004);
        }
    }

    #[test]
    fn incorporeal_monster_walks_through_a_wall_that_stops_normal_ones() {
        // Full-width tall wall — phasing is the only way across (too high
        // to vault, no way around).
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 10.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: 0.0, y: 4.0, z: 0.0, hw: 10.0, hh: 4.0, hd: 0.4,
                kind: "wall".into(), walkable: false,
            },
        ]);
        engine.update_monster_goal(0.0, 6.0);
        let ghost = engine.spawn_box_entity(-2.0, 0.9, -6.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            ghost,
            MonsterCapability {
                walk_speed: 2.5, can_jump: false, can_sprint: false, can_phase: true, can_fly: false,
            },
        );
        engine.physics.set_phasing(ghost, true);
        let normal = engine.spawn_box_entity(2.0, 0.9, -6.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_states.get_mut(&ghost).unwrap().replan_cooldown = 0.0;

        tick_fast(&mut engine, 3_000);

        let gp = engine.world.position(ghost).unwrap();
        let np = engine.world.position(normal).unwrap();
        assert!(
            gp[2] > 1.0,
            "the ghost must phase through the wall toward the goal, ended at {gp:?}",
        );
        assert!(
            np[2] < 0.0,
            "the normal monster must still be blocked by the wall, ended at {np:?}",
        );
    }

    #[test]
    fn flying_monster_climbs_over_a_tall_wall_instead_of_hugging_it() {
        // Tall wall (top y=8) between a flying monster and the player —
        // the old beeline pressed against the face forever.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 10.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: 0.0, y: 4.0, z: 0.0, hw: 10.0, hh: 4.0, hd: 0.4,
                kind: "wall".into(), walkable: false,
            },
        ]);
        let player =
            engine.spawn_box_entity(0.0, 0.9, 6.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        engine.register_player(player);
        let m = engine.spawn_box_entity(0.0, 0.9, -6.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            m,
            MonsterCapability { walk_speed: 8.0, can_jump: false, can_sprint: false, can_phase: false, can_fly: true },
        );

        let mut max_y = 0.0_f32;
        let mut crossed = false;
        for _ in 0..2_000 {
            engine.tick_core(0.004);
            let p = engine.world.position(m).unwrap();
            max_y = max_y.max(p[1]);
            if p[2] > 1.0 {
                crossed = true;
                break;
            }
        }
        let p = engine.world.position(m).unwrap();
        assert!(crossed, "flyer must cross the wall, ended at {p:?} (max_y {max_y})");
        assert!(max_y > 8.0, "it must have climbed above the wall top, max_y {max_y}");
    }

    #[test]
    fn discovery_finds_vaults_over_the_castle_low_walls() {
        // The ±5 pen walls (top y=3.0) are under the jump apex (4.2) —
        // after the discovery sweep, cross-wall vault edges must exist.
        let mut engine = engine_with_static_map();
        tick_fast(&mut engine, 10);
        let mesh = engine.navmesh.as_ref().unwrap();
        let outside = mesh.nearest_walkable(-6.5, -7.0).unwrap();
        let inside = mesh.nearest_walkable(-3.5, -7.0).unwrap();
        assert_ne!(outside, inside, "snap must find distinct nodes across the wall");
        assert!(
            mesh.has_edge(outside, inside) || mesh.has_edge(inside, outside),
            "a vault edge across the low pen wall must have been discovered",
        );
    }

    #[test]
    fn monsters_vault_a_low_wall_when_it_is_the_only_route() {
        // Full-width low wall (top y=2.0, jump apex 4.2): no way around, so
        // the Tier-4 vault edge must be discovered AND executable.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: 0.0, y: -1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 10.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: 0.0, y: 1.0, z: 0.0, hw: 10.0, hh: 1.0, hd: 0.4,
                kind: "wall".into(), walkable: false,
            },
        ]);
        engine.update_monster_goal(0.0, 6.0);
        let m = engine.spawn_box_entity(0.0, 0.9, -6.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);

        // ~14s: discovery sweep, promotion flush, replan, walk, vault.
        let mut crossed_at = None;
        for tick in 0..3_500 {
            engine.tick_core(0.004);
            if crossed_at.is_none() {
                let p = engine.world.position(m).unwrap();
                if p[2] > 1.0 {
                    crossed_at = Some(tick);
                    break;
                }
            }
        }
        let p = engine.world.position(m).unwrap();
        assert!(
            crossed_at.is_some(),
            "monster must vault the low wall (the only route), ended at {p:?}",
        );
    }

    #[test]
    fn tier4_discovers_a_sprint_only_gap_and_only_sprinters_may_use_it() {
        // Two islands; nearest cross-gap nodes ~6.0 apart — beyond the
        // walk-jump reach (~3.25 at defaults) but within sprint reach (~6.5).
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[
            MapBlock {
                x: -4.0, y: -0.5, z: 0.0, hw: 4.0, hh: 0.5, hd: 4.0,
                kind: "floor".into(), walkable: true,
            },
            MapBlock {
                x: 7.5, y: -0.5, z: 0.0, hw: 4.0, hh: 0.5, hd: 4.0,
                kind: "floor".into(), walkable: true,
            },
        ]);

        for _ in 0..600 {
            engine.tick_core(0.004);
        }

        let mesh = engine.navmesh.as_ref().expect("navmesh");
        let request = |can_sprint: bool| PathRequest {
            start: [-4.0, 0.0, 0.0],
            goal: [7.5, 0.0, 0.0],
            route_seed: None,
            can_jump: true,
            can_sprint,
            can_phase: false,
            start_y: Some(0.0),
        };
        let sprint_path = mesh.find_path(request(true));
        assert!(
            sprint_path.as_ref().is_some_and(|p| p.iter().any(|wp| wp.requires_sprint)),
            "a sprinter must cross via the discovered sprint edge, got {sprint_path:?}",
        );
        assert!(
            mesh.find_path(request(false)).is_none(),
            "a non-sprinter must never be offered the sprint-only crossing",
        );
    }

    #[test]
    fn a_second_monster_splices_onto_a_pooled_route_without_its_own_search() {
        let mut engine = engine_with_flat_floor();
        let a = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        let b = engine.spawn_box_entity(0.5, 0.9, 0.5, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        // A bent long-haul goal (not straight-line) so the route survives
        // simplify with real length and pools.
        engine.update_monster_goal(15.0, 8.0);
        engine.monster_states.get_mut(&a).unwrap().replan_cooldown = 0.0;
        // b is never granted a search of its own this test.
        engine.monster_states.get_mut(&b).unwrap().replan_cooldown = 100.0;

        engine.tick_monster_ai(0.004);

        assert!(
            matches!(
                engine.monster_states.get(&a).and_then(|s| s.route.as_ref()),
                Some(ActiveRoute::Owned { .. })
            ),
            "a computed and owns the route",
        );
        assert!(
            matches!(
                engine.monster_states.get(&b).and_then(|s| s.route.as_ref()),
                Some(ActiveRoute::Spliced { .. })
            ),
            "b must ride a's pooled route without a search of its own",
        );
        assert!(
            engine.monster_states.get(&b).unwrap().replan_cooldown > 90.0,
            "b's cooldown untouched — it truly never searched",
        );
    }

    #[test]
    fn destroying_a_monster_clears_its_capability_override_for_a_recycled_id() {
        let mut engine = engine_with_flat_floor();
        let a = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.monster_capabilities.insert(
            a,
            MonsterCapability { walk_speed: 99.0, can_jump: false, can_sprint: false, can_phase: false, can_fly: true },
        );
        engine.destroy_entity(a);
        assert!(engine.monster_capabilities.get(&a).is_none());

        let b = engine.spawn_box_entity(1.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        let cap = engine.capability_for(b);
        assert_eq!(cap.walk_speed, engine.ai.walk_speed, "must not inherit a's stale override");
        assert!(!cap.can_fly, "must not inherit a's stale override");
    }

    #[test]
    fn stuck_monster_clears_its_path_and_replans() {
        let mut engine = engine_with_flat_floor();
        // Zero walk speed pins the monster in place so the stuck sampler fires;
        // tight intervals keep the test fast.
        engine.ai.walk_speed = 0.0;
        engine.ai.stuck_sample_interval = 0.01;
        engine.ai.stuck_escape_after = 0.02;

        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(10.0, 0.5);
        // Sentinel path ending at the goal (not stale) with a recognizable first
        // waypoint, plus a huge cooldown that only a stuck-escape can bypass.
        inject_path(&mut engine, m, vec![waypoint(0.0, 0.0, 42.0, false), waypoint(10.0, 0.0, 0.5, false)]);
        engine.monster_states.get_mut(&m).expect("state").replan_cooldown = 100.0;

        for _ in 0..100 {
            engine.tick_monster_ai(0.004);
        }

        let state = engine.monster_states.get(&m).expect("state");
        assert!(
            state.replan_cooldown < 50.0,
            "stuck escape must zero the cooldown so a replan happens, got {}",
            state.replan_cooldown,
        );
        let (path, _) = owned_route(&engine, m).expect("replanned path");
        let first = path.first().expect("non-empty");
        assert_ne!(first.z, 42.0, "the sentinel path must have been replaced by a replan");
    }

    #[test]
    fn per_monster_goal_overrides_the_default() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(-10.0, 0.0); // default: -x
        engine.set_monster_goal(m, 10.0, 0.0); // override: +x

        assert_eq!(engine.goal_for(m, 0.0, 0.0), (10.0, 0.0, false));

        // Enough ticks to clear the initial replan stagger and plan a path.
        for _ in 0..1_500 {
            engine.tick_monster_ai(0.004);
        }
        let v = engine.world.velocity(m).expect("velocity");
        assert!(v[0] > 0.0, "must walk toward its own goal (+x), got {v:?}");
    }

    #[test]
    fn clearing_a_monster_goal_reverts_to_the_default() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);
        engine.update_monster_goal(-10.0, 0.0);
        engine.set_monster_goal(m, 10.0, 0.0);
        for _ in 0..1_500 {
            engine.tick_monster_ai(0.004);
        }
        assert!(engine.world.velocity(m).expect("velocity")[0] > 0.0);

        engine.clear_monster_goal(m);
        assert_eq!(engine.goal_for(m, 0.0, 0.0), (-10.0, 0.0, false));
        // The stale path (ending at +10) forces a replan toward the default
        // goal once the cooldown allows; the stationary monster's stuck escape
        // shortcuts that wait.
        for _ in 0..2_000 {
            engine.tick_monster_ai(0.004);
        }
        let v = engine.world.velocity(m).expect("velocity");
        assert!(v[0] < 0.0, "must revert to the default goal (-x), got {v:?}");
    }

    #[test]
    fn monster_without_an_override_targets_whichever_player_is_closest() {
        let mut engine = engine_with_flat_floor();
        let local_player = engine.spawn_box_entity(-10.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(local_player);
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);

        // Only the local player exists — it's the target even with no JS-set default goal.
        assert_eq!(engine.goal_for(m, 0.0, 0.0), (-10.0, 0.0, true));

        // A remote player's mirror appears closer than the local player.
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(1, [5.0, 0.9, 0.0]), &mut out);
        assert_eq!(
            engine.goal_for(m, 0.0, 0.0),
            (5.0, 0.0, true),
            "must switch to the closer remote player",
        );

        // The remote player moves away; the local player becomes closest again.
        engine.ingest_peer_payload("peer-a", &delta_payload(1, [50.0, 0.9, 0.0]), &mut out);
        assert_eq!(
            engine.goal_for(m, 0.0, 0.0),
            (-10.0, 0.0, true),
            "must switch back once the local player is closer",
        );
    }

    #[test]
    fn per_entity_goal_override_still_wins_over_closest_player() {
        let mut engine = engine_with_flat_floor();
        let local_player = engine.spawn_box_entity(-1.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
        engine.register_player(local_player);
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);

        engine.set_monster_goal(m, 30.0, 0.0);
        assert_eq!(
            engine.goal_for(m, 0.0, 0.0),
            (30.0, 0.0, false),
            "an explicit per-monster goal must win over the closest-player default",
        );
    }

    #[test]
    fn a_remote_monster_mirror_never_counts_as_a_player_target() {
        let mut engine = engine_with_flat_floor();
        let m = engine.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 50, NET_MONSTER);

        // A remote peer's own monster mirrors in nearby — its public profile
        // carries the NET_MONSTER bit, so it must not be mistaken for a player.
        let payload = netcode::encode_events(&[WireEvent::Spawn {
            entity: 1,
            flags: NET_MONSTER,
            fields: vec![
                netcode::FieldUpdate { component_id: netcode::COMP_POSITION, field_id: 0, value: 1.0 },
                netcode::FieldUpdate { component_id: netcode::COMP_POSITION, field_id: 1, value: 0.9 },
                netcode::FieldUpdate { component_id: netcode::COMP_POSITION, field_id: 2, value: 0.0 },
            ],
        }]);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &payload, &mut out);

        // No local/remote player exists at all — falls back to the JS default.
        engine.update_monster_goal(20.0, 0.0);
        assert_eq!(
            engine.goal_for(m, 0.0, 0.0),
            (20.0, 0.0, false),
            "a remote monster mirror must never be treated as a player target",
        );
    }

    fn delta_payload(entity: u32, pos: [f32; 3]) -> Vec<u8> {
        let fields = (0..3)
            .map(|axis| netcode::FieldUpdate {
                component_id: netcode::COMP_POSITION,
                field_id: axis as u8,
                value: pos[axis] as f64,
            })
            .collect();
        netcode::encode_events(&[WireEvent::Delta { entity, fields }])
    }

    #[test]
    fn inbound_delta_creates_a_mirror_not_an_id_collision() {
        let mut engine = Engine::new(None, None);
        let player = engine.spawn_box_entity(0.0, 5.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);

        // The remote peer's entity id happens to equal our player's id — applying
        // it directly would stomp the local player.
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(player, [9.0, 9.0, 9.0]), &mut out);

        assert_eq!(
            engine.world.position(player),
            Some([0.0, 5.0, 0.0]),
            "local entity must be untouched by a remote peer's id space",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NetEventKind::EntitySpawned);
        let mirror = out[0].entity;
        assert_ne!(mirror, player);
        assert_eq!(engine.world.position(mirror), Some([9.0, 9.0, 9.0]));
        assert!(
            engine.world.dirty_flags(mirror).contains(DirtyFlags::TRANSFORM),
            "mirror must be render-dirty so the game sees it move",
        );
    }

    #[test]
    fn repeat_deltas_update_the_same_mirror() {
        let mut engine = Engine::new(None, None);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [1.0, 0.0, 0.0]), &mut out);
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [2.0, 0.0, 0.0]), &mut out);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, NetEventKind::EntitySpawned);
        assert_eq!(out[1].kind, NetEventKind::EntityUpdated);
        assert_eq!(out[0].entity, out[1].entity, "same remote entity → same mirror");
        assert_eq!(engine.world.position(out[1].entity), Some([2.0, 0.0, 0.0]));
    }

    #[test]
    fn same_remote_id_from_two_peers_gets_two_mirrors() {
        let mut engine = Engine::new(None, None);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [1.0, 0.0, 0.0]), &mut out);
        engine.ingest_peer_payload("peer-b", &delta_payload(7, [2.0, 0.0, 0.0]), &mut out);

        assert_ne!(
            out[0].entity, out[1].entity,
            "entity ids are per-sender; two peers' id 7 are different entities",
        );
    }

    #[test]
    fn despawn_event_removes_the_mirror() {
        let mut engine = Engine::new(None, None);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [1.0, 0.0, 0.0]), &mut out);
        let mirror = out[0].entity;

        out.clear();
        let despawn = netcode::encode_events(&[WireEvent::Despawned { entity: 7 }]);
        engine.ingest_peer_payload("peer-a", &despawn, &mut out);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NetEventKind::EntityDespawned);
        assert_eq!(out[0].entity, mirror);
        assert_eq!(engine.world.position(mirror), None, "mirror must be destroyed");
        assert!(engine.remote_mirrors.is_empty() && engine.mirror_owner.is_empty());
    }

    #[test]
    fn silent_peer_times_out_and_its_mirrors_despawn() {
        let mut engine = Engine::new(None, None);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [1.0, 0.0, 0.0]), &mut out);
        let mirror = out[0].entity;

        // Run past PEER_TIMEOUT_SECS of sim time with no further traffic.
        let ticks = ((PEER_TIMEOUT_SECS / 0.004) as usize) + 100;
        let mut despawned = false;
        let mut peer_left = false;
        for _ in 0..ticks {
            let bundle = engine.tick_core(0.004);
            for p in &bundle.net {
                despawned |= p.kind == NetEventKind::EntityDespawned && p.entity == mirror;
                peer_left |= p.kind == NetEventKind::PeerLeft && p.peer_id == "peer-a";
            }
        }

        assert!(despawned, "timed-out peer's mirror must despawn");
        assert!(peer_left, "the game must learn the peer left");
        assert_eq!(engine.world.position(mirror), None);
        assert!(engine.peer_last_seen.is_empty());
    }

    #[test]
    fn destroying_a_replicated_entity_broadcasts_despawned() {
        let mut engine = Engine::new(None, None);
        let player =
            engine.spawn_box_entity(0.0, 5.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        // Un-replicated local entities are nobody's business on the wire.
        let private = engine.spawn_box_entity(1.0, 5.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL);

        engine.destroy_entity(player);
        engine.destroy_entity(private);

        // Announcements only exist for an audience.
        engine.peer_last_seen.insert("peer-x".to_string(), 0.0);
        let events = engine.collect_outbound_events();
        assert!(
            events.contains(&WireEvent::Despawned { entity: player }),
            "peers must be told the replicated entity is gone, got {events:?}",
        );
        assert!(
            !events.contains(&WireEvent::Despawned { entity: private }),
            "non-replicated entities must not leak onto the wire",
        );
    }

    #[test]
    fn replication_cadence_follows_urgency_flags() {
        let mut engine = Engine::new(None, None);
        // Flushing needs an audience.
        engine.peer_last_seen.insert("peer-x".to_string(), 0.0);
        let urgent =
            engine.spawn_box_entity(0.0, 5.0, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        let lazy = engine.spawn_box_entity(
            1.0,
            5.0,
            0.0,
            0.4,
            0.9,
            0.4,
            100,
            NET_LOCAL | NET_REPLICATED | NET_LOW_URGENCY,
        );

        // Move both every tick; count how many wire events each produces over
        // two low-urgency strides. The first flush is the Spawn announcement.
        let mut urgent_events = 0;
        let mut lazy_events = 0;
        for i in 0..(LOW_URGENCY_STRIDE * 2) {
            let t = i as f32;
            engine.world.set_position(urgent, [t, 5.0, 0.0]);
            engine.world.set_position(lazy, [t, 5.0, 1.0]);
            engine.mark_replication_dirty();
            for ev in engine.collect_outbound_events() {
                match ev {
                    WireEvent::Spawn { entity, .. } | WireEvent::Delta { entity, .. } => {
                        if entity == urgent {
                            urgent_events += 1;
                        } else if entity == lazy {
                            lazy_events += 1;
                        }
                    }
                    _ => {}
                }
            }
            engine.world.advance_tick();
        }

        assert_eq!(
            urgent_events,
            LOW_URGENCY_STRIDE * 2,
            "default urgency replicates every tick",
        );
        assert_eq!(lazy_events, 2, "low urgency replicates once per stride");
    }

    #[test]
    fn predictable_mirrors_extrapolate_between_updates() {
        let mut engine = Engine::new(None, None);
        // Remote ballistic bullet: one Spawn with position + velocity.
        let mut fields = Vec::new();
        for (axis, v) in [0.0, 10.0, 0.0].iter().enumerate() {
            fields.push(netcode::FieldUpdate {
                component_id: netcode::COMP_POSITION,
                field_id: axis as u8,
                value: *v,
            });
        }
        for (axis, v) in [20.0, 0.0, 0.0].iter().enumerate() {
            fields.push(netcode::FieldUpdate {
                component_id: netcode::COMP_VELOCITY,
                field_id: axis as u8,
                value: *v,
            });
        }
        let payload = netcode::encode_events(&[WireEvent::Spawn {
            entity: 7,
            flags: NET_BULLET | NET_PREDICTABLE,
            fields,
        }]);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &payload, &mut out);
        assert_eq!(out[0].flags, Some(NET_BULLET | NET_PREDICTABLE));
        let mirror = out[0].entity;

        // No further network traffic: the mirror must fly on its own — forward
        // with the received velocity, arcing down under gravity.
        for _ in 0..50 {
            engine.tick_core(0.004);
        }
        let pos = engine.world.position(mirror).expect("mirror exists");
        assert!(pos[0] > 3.0, "mirror must extrapolate forward, got {pos:?}");
        assert!(pos[1] < 10.0, "ballistic mirror must arc down, got {pos:?}");
    }

    #[test]
    fn unpredictable_mirrors_stay_put_between_updates() {
        let mut engine = Engine::new(None, None);
        let mut out = Vec::new();
        engine.ingest_peer_payload("peer-a", &delta_payload(7, [1.0, 2.0, 3.0]), &mut out);
        let mirror = out[0].entity;

        for _ in 0..50 {
            engine.tick_core(0.004);
        }
        assert_eq!(
            engine.world.position(mirror),
            Some([1.0, 2.0, 3.0]),
            "non-predictable mirrors move only on network updates",
        );
    }

    /// End-to-end loopback: two full engines wired through the same transport
    /// bridge the browser uses (net_peer_connected / take_outbound / net_ingest).
    /// Proves the whole replication pipeline — cadence marking, Spawn
    /// announcements, mirror creation, boundary events, live positions — with
    /// no browser transport involved.
    #[test]
    fn loopback_replicates_player_monsters_and_bullets_between_engines() {
        let mut a = engine_with_flat_floor();
        let mut b = engine_with_flat_floor();

        let player =
            a.spawn_box_entity(0.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100, NET_LOCAL | NET_REPLICATED);
        a.register_player(player);
        a.spawn_monsters(3);
        a.player_fire();

        // Both data channels open (what the transport reports on connect).
        a.net_peer_connected("peer-b");
        b.net_peer_connected("peer-a");

        let mut b_net: Vec<NetPatch> = Vec::new();
        for _ in 0..(PREDICTABLE_STRIDE * 2) {
            a.tick_core(0.004);
            for (_target, bytes) in a.take_outbound() {
                b.net_ingest("peer-a", &bytes);
            }
            // B's tick applies the queued payloads; its bundle carries the
            // boundary events the way useEngine would see them.
            let bundle = b.tick_core(0.004);
            b_net.extend(bundle.net);
            b.take_outbound();
        }

        let spawned: Vec<&NetPatch> = b_net
            .iter()
            .filter(|p| p.kind == NetEventKind::EntitySpawned)
            .collect();
        assert_eq!(
            spawned.len(),
            5,
            "player + 3 monsters + bullet must all appear on B, got {spawned:#?}",
        );
        let by_flag =
            |mask: u8| spawned.iter().filter(|p| p.flags.unwrap_or(0) & mask != 0).count();
        assert_eq!(by_flag(NET_MONSTER), 3, "monster mirrors must carry the monster profile");
        assert_eq!(by_flag(NET_BULLET), 1, "the bullet mirror must carry the bullet profile");
        assert_eq!(
            spawned.iter().filter(|p| p.flags == Some(0)).count(),
            1,
            "the player's public profile is empty (ownership bits don't travel)",
        );
        for p in &spawned {
            assert!(
                b.world.position(p.entity).is_some(),
                "every mirror must have a live position on B",
            );
        }
    }

    #[test]
    fn a_bullet_fired_by_one_peer_damages_a_monster_owned_by_another() {
        // A owns the monster (real, local, authoritative health); B fires the
        // bullet (real, local to B). Before mirror-bullet hit detection, A's
        // tick_bullets only ever checked LOCAL bullets against LOCAL monsters —
        // B's bullet arrives on A as a display-only mirror with no real
        // net_flags, invisible to that scan, so the monster never took damage.
        let mut a = engine_with_flat_floor();
        let mut b = engine_with_flat_floor();

        let monster = a.spawn_box_entity(
            5.0, 0.9, 0.0, 0.4, 0.9, 0.4, 100,
            NET_LOCAL | NET_MONSTER | NET_REPLICATED | NET_LOW_URGENCY,
        );
        // B's bullet spawns already overlapping the monster's known position
        // and holds still (zero velocity) — no aiming logic under test here,
        // just whether a hit against a mirror ever gets checked at all.
        b.spawn_bullet(5.0, 0.9, 0.0, 0.0, 0.0, 0.0, NET_REPLICATED | NET_PREDICTABLE);

        a.net_peer_connected("peer-b");
        b.net_peer_connected("peer-a");

        for _ in 0..5 {
            b.tick_core(0.004);
            for (_target, bytes) in b.take_outbound() {
                a.net_ingest("peer-b", &bytes);
            }
            a.tick_core(0.004);
            a.take_outbound();
        }

        assert_eq!(
            a.world.health(monster),
            Some(100 - a.player_cfg.bullet_damage),
            "the monster's owner must apply damage from a bullet it only sees as a mirror",
        );
    }

    #[test]
    fn navmesh_builds_at_any_altitude() {
        // Regression: the node-sampling scan window used to be hardcoded to
        // y ∈ [200, −50]; floors outside it silently produced no navmesh nodes.
        let mut engine = Engine::new(None, None);
        engine.load_map_blocks(&[MapBlock {
            x: 0.0,
            y: 300.0,
            z: 0.0,
            hw: 20.0,
            hh: 1.0,
            hd: 20.0,
            kind: "floor".into(),
            walkable: true,
        }]);

        let navmesh = engine
            .navmesh
            .as_ref()
            .expect("floor at y=300 must produce a navmesh");
        let path = navmesh.find_path(PathRequest {
            start: [-10.0, 0.0, -10.0],
            goal: [10.0, 0.0, 10.0],
            route_seed: None,
            can_jump: true,
            can_sprint: false,
            can_phase: false,
            start_y: Some(301.0),
        });
        assert!(path.is_some(), "path must exist on a high-altitude floor");
    }
}
