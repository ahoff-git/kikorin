use bincode::Decode;
use ecs::{ColliderConfig, DirtyFlags, World};

const NET_LOCAL: u8 = 0x01;
const NET_BULLET: u8 = 0x02;
const NET_MONSTER: u8 = 0x04;

// Bullet maximum lifetime before automatic despawn (~10 s at 60 fps).
const PROJ_MAX_FRAMES: u32 = 600;
// Sentinel stored in bullet_ages after a HitPatch has been emitted. Prevents
// re-emitting the event on subsequent ticks while TS processes the HitPatch and
// calls destroy_entity. The entity is NOT destroyed here — TS owns that step.
const BULLET_DEAD: u32 = u32::MAX;

use netcode::{encode_patches, DeltaTracker, PeerSession};
use patch::{HitPatch, MetricsPatch, NetPatch, PatchBundle, PatchGenerator};
use pathfinding::{NavMesh, NavMeshConfig, PathRequest, Waypoint};
use physics::PhysicsWorld;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const PROJ_HIT_RADIUS_SQ: f32 = 1.2 * 1.2;

// --- Game tuning configs ---
// Defaults are engine-provided; games override them via set_ai_config / set_nav_config
// with a (possibly partial) JS object. Missing fields fall back to these defaults —
// not to previously set values.

/// Monster AI tuning: movement, jumping, replanning, stuck detection, separation.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub walk_speed: f32,
    pub jump_speed: f32,
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
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            walk_speed: 2.5,
            jump_speed: 13.0,
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

struct MonsterState {
    path: Option<Vec<Waypoint>>,
    waypoint_index: usize,
    replan_cooldown: f32,
    jump_cooldown: f32,
    stuck_timer: f32,
    last_sample_x: f32,
    last_sample_z: f32,
    stuck_sample_timer: f32,
}

impl MonsterState {
    fn new(initial_replan_cooldown: f32) -> Self {
        Self {
            path: None,
            waypoint_index: 0,
            replan_cooldown: initial_replan_cooldown,
            jump_cooldown: 0.0,
            stuck_timer: 0.0,
            last_sample_x: f32::INFINITY,
            last_sample_z: f32::INFINITY,
            stuck_sample_timer: 0.0,
        }
    }
}

// --- WASM-bindgen public API ---

/// Top-level engine exposed to JavaScript. One instance per page load.
#[wasm_bindgen]
pub struct Engine {
    world: World,
    physics: PhysicsWorld,
    navmesh: Option<NavMesh>,
    delta_tracker: DeltaTracker,
    peer_session: PeerSession,
    patch_gen: PatchGenerator,
    last_metrics: MetricsPatch,
    local_peer_id: String,
    // Pre-computed list of NET_LOCAL entity IDs — updated on spawn/destroy.
    local_entities: Vec<u32>,
    // Per-monster AI state — populated when a NET_MONSTER entity is spawned.
    monster_states: HashMap<u32, MonsterState>,
    // Age counter (in ticks) for each NET_BULLET entity — used for TTL enforcement.
    bullet_ages: HashMap<u32, u32>,
    // Player position used as the monster pathfinding goal; updated each tick via
    // update_monster_goal(). Stored so the engine owns the loop, not the caller.
    goal_x: f32,
    goal_z: f32,
    // Game-supplied tuning; engine defaults until set_ai_config / set_nav_config.
    ai: AiConfig,
    nav: NavConfig,
    // Terrain entities whose top surface must not receive navmesh nodes (walls etc.).
    non_walkable_terrain: std::collections::HashSet<u32>,
    // Reusable scratch buffers for the per-tick hot loop. Cleared and refilled each tick
    // so the monster/bullet iteration lists don't heap-allocate every frame (~250 Hz).
    // Taken out via std::mem::take during use to satisfy the borrow checker, then returned
    // so the allocation capacity persists across ticks.
    scratch_ids: Vec<u32>,
    scratch_positions: Vec<[f32; 3]>,
    scratch_snapshots: Vec<(u32, [f32; 3])>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        #[cfg(target_arch = "wasm32")]
        {
            use log::Level;
            let _ = console_log::init_with_level(Level::Warn);
            console_error_panic_hook::set_once();
        }

        Engine {
            world: World::new(1024),
            physics: PhysicsWorld::new(-20.0),
            navmesh: None,
            delta_tracker: DeltaTracker::new(),
            peer_session: PeerSession::new(),
            patch_gen: PatchGenerator::new(),
            last_metrics: MetricsPatch::default(),
            local_peer_id: "local".to_string(),
            local_entities: Vec::new(),
            monster_states: HashMap::new(),
            bullet_ages: HashMap::new(),
            goal_x: 0.0,
            goal_z: 0.0,
            ai: AiConfig::default(),
            nav: NavConfig::default(),
            non_walkable_terrain: std::collections::HashSet::new(),
            scratch_ids: Vec::new(),
            scratch_positions: Vec::new(),
            scratch_snapshots: Vec::new(),
        }
    }

    /// Update the position monsters path toward. Call once per frame before tick()
    /// with the player's current world position.
    pub fn update_monster_goal(&mut self, gx: f32, gz: f32) {
        self.goal_x = gx;
        self.goal_z = gz;
    }

    /// Override monster AI tuning. Accepts a partial JS object; missing fields fall
    /// back to engine defaults (not to previously set values). Invalid input is ignored.
    pub fn set_ai_config(&mut self, cfg: JsValue) {
        if let Ok(c) = serde_wasm_bindgen::from_value(cfg) {
            self.ai = c;
        }
    }

    /// Override navmesh build tuning (same partial-object semantics as set_ai_config).
    /// Takes effect on the next load_map / build_navmesh call.
    pub fn set_nav_config(&mut self, cfg: JsValue) {
        if let Ok(c) = serde_wasm_bindgen::from_value(cfg) {
            self.nav = c;
        }
    }

    /// Advance simulation by dt_ms milliseconds.
    /// Returns a PatchBundle as a JS object directly — no bincode round-trip.
    pub fn tick(&mut self, dt_ms: f64) -> JsValue {
        let tick_timer = Timer::new();
        let dt_secs = (dt_ms / 1000.0) as f32;
        log::debug!("tick {} — dt_ms={:.2}", self.world.tick_count(), dt_ms);

        // 1. Drain inbound peer messages, apply to world, and map the applied wire
        // patches to the thinner boundary NetPatch that rides in the PatchBundle.
        let net_timer = Timer::new();
        let mut net_patches: Vec<NetPatch> = Vec::new();
        for (_peer_id, bytes) in self.peer_session.drain_inbound() {
            if let Ok(patches) = self.delta_tracker.apply_inbound(&bytes, &mut self.world) {
                net_patches.extend(patches.into_iter().map(|p| NetPatch {
                    peer_id: p.peer_id,
                    entity: p.entity,
                }));
            }
        }
        let mut net_ms = net_timer.elapsed_ms();

        // 2. Monster AI: compute desired directions, handle stuck detection, replan paths.
        // Runs before physics so the computed velocities feed into sync_from_world.
        // Returns the time spent inside A* searches, reported separately as pathfinding_ms.
        let ai_timer = Timer::new();
        let pathfinding_ms = self.tick_monster_ai(dt_secs);

        // 2.25. Separation: adjust NET_MONSTER XZ velocities with soft repulsion forces so
        // monsters don't cluster. Also runs before physics.
        self.apply_monster_separation();
        let mut ai_ms = ai_timer.elapsed_ms();

        // 2.5. Physics step.
        let physics_timer = Timer::new();
        self.physics.sync_from_world(&self.world);
        self.physics.step(dt_secs);
        self.physics.sync_to_world(&mut self.world);
        let physics_ms = physics_timer.elapsed_ms();

        // 3. Bullet update + hit detection, plus marking locally-owned entities dirty for
        // grounded/semantic delivery. Engine-owned system work — counted as AI time.
        let bullet_timer = Timer::new();
        let hits = self.tick_bullets(dt_secs);
        for &id in &self.local_entities {
            self.world.mark_dirty(id, DirtyFlags::HEALTH);
            self.delta_tracker.mark_dirty(id);
        }
        ai_ms += bullet_timer.elapsed_ms();

        // 4. Flush outbound deltas to all peers.
        // No clone needed: delta_tracker, world, and local_peer_id are disjoint fields.
        let flush_timer = Timer::new();
        let outbound = self.delta_tracker.flush(&self.world, &self.local_peer_id);
        if !outbound.is_empty() {
            self.peer_session.broadcast(&encode_patches(&outbound));
        }
        net_ms += flush_timer.elapsed_ms();

        // 5. Build PatchBundle and convert directly to JsValue. patch_ms and tick_ms are
        // stamped into the bundle after generation so consumers receive real values.
        // The JsValue conversion itself cannot be self-timed; the worker measures it as
        // boundary_ms (observed call time minus tick_ms).
        let patch_timer = Timer::new();
        let mut bundle = self.patch_gen.generate(
            &self.world,
            net_patches,
            hits,
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

        bundle.metrics.tick_ms = tick_timer.elapsed_ms();
        self.last_metrics = bundle.metrics.clone();
        serde_wasm_bindgen::to_value(&JsPatch::from(bundle)).unwrap_or(JsValue::NULL)
    }

    /// Apply a serialized input event or inbound peer message.
    pub fn apply_input(&mut self, payload: &[u8]) {
        let _ = self.delta_tracker.apply_inbound(payload, &mut self.world);
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
    #[cfg(target_arch = "wasm32")]
    pub fn init_networking(&mut self, session_id: &str, signaling_url: &str) {
        self.local_peer_id = session_id.to_string();
        self.peer_session.connect(session_id, signaling_url);
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
        for id in self.world.entities() {
            if !self.world.is_floor(id) {
                continue;
            }
            let Some([x, _, z]) = self.world.position(id) else {
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

        let cols = (((max_x - min_x) / cell_size).ceil() as usize).max(1);
        let rows = (((max_z - min_z) / cell_size).ceil() as usize).max(1);

        self.physics.sync_from_world(&self.world);
        self.physics.prepare_queries();

        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size,
            min_x,
            max_x,
            min_z,
            max_z,
        });

        let mut node_grid: Vec<Option<pathfinding::NodeId>> = vec![None; cols * rows];
        let mut node_ys: Vec<f32> = Vec::new();

        for row in 0..rows {
            for col in 0..cols {
                let x = min_x + (col as f32 + 0.5) * cell_size;
                let z = min_z + (row as f32 + 0.5) * cell_size;
                if let Some(y) = self.walkable_height_at(x, z) {
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
                        let height_diff = node_ys[to_id as usize] - from_y;

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
        self.world.destroy_entity(id);
        self.physics.remove_entity(id);
        self.local_entities.retain(|&e| e != id);
        self.monster_states.remove(&id);
        self.bullet_ages.remove(&id);
        self.non_walkable_terrain.remove(&id);
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
        self.world.set_velocity(id, [0.0, 0.0, 0.0]);
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
        if net_flags & NET_LOCAL != 0 {
            self.local_entities.push(id);
        }
        if net_flags & NET_MONSTER != 0 {
            // Stagger initial replan cooldowns using entity ID so monsters don't all
            // request A* on the same tick at startup.
            let stagger = (id % 30) as f32 / 30.0 * self.ai.replan_cooldown;
            self.monster_states.insert(id, MonsterState::new(stagger));
        }
        id
    }

    /// Spawn a projectile. The engine integrates its ballistic trajectory each tick.
    pub fn spawn_bullet(&mut self, x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_velocity(id, [vx, vy, vz]);
        self.world.set_net_flags(id, NET_BULLET);
        self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
        id
    }

    /// Set the velocity of an entity. XZ velocity is always applied.
    /// Pass vy=0 to preserve gravity accumulation; non-zero vy applies a one-frame jump impulse.
    pub fn set_entity_velocity(&mut self, id: u32, vx: f32, vy: f32, vz: f32) {
        if self.world.velocity(id).is_some() {
            self.world.set_velocity(id, [vx, vy, vz]);
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
        self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
        self.delta_tracker.mark_dirty(id);
        self.physics.teleport_entity(id, position);
    }
}

// --- Private engine methods (not exposed to JS) ---

impl Engine {
    /// Height of the topmost WALKABLE floor surface at (x, z), for navmesh node
    /// placement. Unlike physics.floor_height_at, this skips non-walkable terrain
    /// (walls) and non-floor entities, continuing the scan below them — so a cell
    /// whose column passes through a parapet top gets its node on the platform
    /// underneath instead of an unreachable node on the wall.
    fn walkable_height_at(&self, x: f32, z: f32) -> Option<f32> {
        let mut from_y = 200.0_f32;
        for _ in 0..8 {
            let (eid, toi) = self.physics.cast_ray([x, from_y, z], [x, -50.0, z])?;
            let hit_y = from_y - toi;
            if self.world.is_floor(eid) && !self.non_walkable_terrain.contains(&eid) {
                return Some(hit_y);
            }
            // Resume below the blocking entity's bottom face — resuming just below
            // its top would start inside the box and re-hit it at toi = 0.
            let pos = self.world.position(eid)?;
            let col = self.world.collider(eid)?;
            from_y = pos[1] - col.half_height - 0.01;
            if from_y <= -50.0 {
                return None;
            }
        }
        None
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

    /// Run monster AI for one tick: stuck detection, path replanning, waypoint following.
    /// Sets ECS velocity and rotation for each NET_MONSTER entity; physics picks them up
    /// in the following sync_from_world call.
    /// Returns the milliseconds spent inside A* searches (the pathfinding_ms metric).
    fn tick_monster_ai(&mut self, dt_secs: f32) -> f32 {
        let goal_x = self.goal_x;
        let goal_z = self.goal_z;
        let ai = self.ai;
        let mut pathfinding_ms = 0.0_f32;

        let mut monster_ids = std::mem::take(&mut self.scratch_ids);
        Self::collect_by_flag(&self.world, NET_MONSTER, &mut monster_ids);

        // At most one A* search per engine tick to bound the per-tick CPU spike.
        // The per-monster cooldown (3 s) provides the primary throttle; this flag
        // prevents two monsters with simultaneous cooldown expiry from stacking.
        let mut path_requested_this_tick = false;

        for &mid in &monster_ids {
            let [mx, my, mz] = match self.world.position(mid) {
                Some(p) => p,
                None => continue,
            };
            let grounded = self.world.is_grounded(mid).unwrap_or(false);

            let dx = goal_x - mx;
            let dz = goal_z - mz;
            let dist = (dx * dx + dz * dz).sqrt();
            if dist < 0.001 {
                continue;
            }

            // --- Stuck detection & replanning (mutates state, no navmesh access) ---
            let should_replan = {
                let state = match self.monster_states.get_mut(&mid) {
                    Some(s) => s,
                    None => continue,
                };

                state.jump_cooldown = (state.jump_cooldown - dt_secs).max(0.0);

                state.stuck_sample_timer += dt_secs;
                if state.stuck_sample_timer >= ai.stuck_sample_interval {
                    state.stuck_sample_timer = 0.0;
                    let moved = ((mx - state.last_sample_x).powi(2)
                        + (mz - state.last_sample_z).powi(2))
                    .sqrt();
                    if moved < ai.stuck_move_threshold {
                        state.stuck_timer += ai.stuck_sample_interval;
                        if state.stuck_timer >= ai.stuck_escape_after {
                            state.path = None;
                            state.replan_cooldown = 0.0;
                            state.stuck_timer = 0.0;
                        }
                    } else {
                        state.stuck_timer = 0.0;
                    }
                    state.last_sample_x = mx;
                    state.last_sample_z = mz;
                }

                state.replan_cooldown = (state.replan_cooldown - dt_secs).max(0.0);

                let path_stale = match state.path.as_ref().and_then(|p| p.last()) {
                    Some(wp) => {
                        ((goal_x - wp.x).powi(2) + (goal_z - wp.z).powi(2)).sqrt()
                            > ai.replan_stale_dist
                    }
                    None => true,
                };

                if path_stale && state.replan_cooldown <= 0.0 && !path_requested_this_tick {
                    state.replan_cooldown = ai.replan_cooldown;
                    true
                } else {
                    false
                }
            }; // state borrow dropped here

            // --- Navmesh lookup (requires &self.navmesh, so must not hold state borrow) ---
            if should_replan {
                path_requested_this_tick = true;
                if let Some(navmesh) = &self.navmesh {
                    let path_timer = Timer::new();
                    let result = navmesh.find_path(PathRequest {
                        start: [mx, my - 0.9, mz],
                        goal: [goal_x, 0.0, goal_z],
                        route_seed: None,
                        can_jump: true,
                        start_y: Some(my - 0.9),
                    });
                    pathfinding_ms += path_timer.elapsed_ms();
                    if let Some(s) = self.monster_states.get_mut(&mid) {
                        s.path = result;
                        s.waypoint_index = 0;
                    }
                }
            }

            // --- Waypoint following: compute desired direction & jump intent ---
            let (desired_x, desired_z, wants_jump) = {
                let state = match self.monster_states.get_mut(&mid) {
                    Some(s) => s,
                    None => continue,
                };

                let path_len = state.path.as_ref().map_or(0, |p| p.len());

                // Advance past reached waypoints.
                while state.waypoint_index < path_len {
                    let (wp_x, wp_z, wp_y, req_jump) = {
                        let wp = &state.path.as_ref().unwrap()[state.waypoint_index];
                        (wp.x, wp.z, wp.y, wp.requires_jump)
                    };
                    if (wp_x - mx).hypot(wp_z - mz) >= ai.waypoint_reach {
                        break;
                    }
                    if req_jump && my - 0.9 < wp_y - ai.jump_height_tolerance {
                        break;
                    }
                    state.waypoint_index += 1;
                }

                if state.waypoint_index >= path_len {
                    // A real path fully walked → replan immediately for responsiveness.
                    // A None path (last search FAILED, e.g. unreachable goal) must keep
                    // its cooldown: zeroing it here turns one failed search into a
                    // per-tick storm of full-mesh A* explorations — each failure scans
                    // the whole graph, which is what tanks the tick budget in WASM.
                    if state.path.is_some() && path_len > 0 {
                        state.replan_cooldown = 0.0;
                    }
                    state.path = None;
                    (dx / dist, dz / dist, false)
                } else {
                    let (wp_x, wp_z, wp_y, req_jump) = {
                        let wp = &state.path.as_ref().unwrap()[state.waypoint_index];
                        (wp.x, wp.z, wp.y, wp.requires_jump)
                    };
                    let wp_dx = wp_x - mx;
                    let wp_dz = wp_z - mz;
                    let wp_dist = (wp_dx * wp_dx + wp_dz * wp_dz).sqrt();
                    let dir_x = if wp_dist > 0.0 {
                        wp_dx / wp_dist
                    } else {
                        dx / dist
                    };
                    let dir_z = if wp_dist > 0.0 {
                        wp_dz / wp_dist
                    } else {
                        dz / dist
                    };
                    let wants_jump = req_jump
                        && state.jump_cooldown <= 0.0
                        && grounded
                        && wp_dist < ai.jump_trigger_dist;
                    // Anchor the look-at: compare against wp_y rather than wp_y + half-height
                    // so the monster faces the ledge edge it needs to jump onto.
                    let _ = wp_y;
                    (dir_x, dir_z, wants_jump)
                }
            }; // state borrow dropped here

            // Rotation: yaw faces the walk direction.
            let yaw = desired_x.atan2(desired_z);
            self.world.set_rotation(mid, [yaw, 0.0, 0.0]);
            self.world.mark_dirty(mid, DirtyFlags::TRANSFORM);

            if wants_jump {
                self.world.set_velocity(
                    mid,
                    [
                        desired_x * ai.walk_speed,
                        ai.jump_speed,
                        desired_z * ai.walk_speed,
                    ],
                );
                if let Some(s) = self.monster_states.get_mut(&mid) {
                    s.jump_cooldown = ai.jump_cooldown;
                }
            } else {
                // Desired direction stored as velocity; separation pass adjusts it below.
                self.world.set_velocity(
                    mid,
                    [desired_x * ai.walk_speed, 0.0, desired_z * ai.walk_speed],
                );
            }
        }

        // Return the buffer so its capacity is reused next tick.
        self.scratch_ids = monster_ids;
        pathfinding_ms
    }

    /// Add soft repulsion forces so monsters don't cluster. Reads current XZ velocities
    /// (which encode desired walk direction × speed), blends in separation, and writes
    /// back. Must run after tick_monster_ai and before physics sync_from_world.
    fn apply_monster_separation(&mut self) {
        let ai = self.ai;
        let mut monster_ids = std::mem::take(&mut self.scratch_ids);
        Self::collect_by_flag(&self.world, NET_MONSTER, &mut monster_ids);

        if monster_ids.len() < 2 {
            self.scratch_ids = monster_ids;
            return;
        }

        // Snapshot positions so the per-entity loop can read all neighbours without
        // re-borrowing self.world through the inner loop.
        let mut positions = std::mem::take(&mut self.scratch_positions);
        positions.clear();
        positions.extend(
            monster_ids
                .iter()
                .map(|&id| self.world.position(id).unwrap_or([0.0; 3])),
        );

        let r_sq = ai.separation_radius * ai.separation_radius;

        for (i, &mid) in monster_ids.iter().enumerate() {
            let vel = match self.world.velocity(mid) {
                Some(v) => v,
                None => continue,
            };
            // Skip jump frames so separation doesn't fight the vertical impulse.
            if vel[1].abs() > 0.1 {
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

            self.world.set_velocity(
                mid,
                [
                    (dir_x + sx) * ai.walk_speed,
                    vel[1],
                    (dir_z + sz) * ai.walk_speed,
                ],
            );
        }

        // Return buffers so their capacity is reused next tick.
        self.scratch_positions = positions;
        self.scratch_ids = monster_ids;
    }

    /// Integrate NET_BULLET positions (ballistic arc + wall bounce) and detect hits
    /// against NET_MONSTER entities. Returns one HitPatch per collision and one per
    /// bullet that leaves the play area (target_eid = None).
    fn tick_bullets(&mut self, dt_secs: f32) -> Vec<HitPatch> {
        let mut bullet_ids = std::mem::take(&mut self.scratch_ids);
        Self::collect_by_flag(&self.world, NET_BULLET, &mut bullet_ids);

        // No bullets in flight: skip the monster snapshot scan+alloc entirely. Bullets are
        // transient, so the common case is zero bullets — most ticks return here.
        if bullet_ids.is_empty() {
            self.scratch_ids = bullet_ids;
            return Vec::new();
        }

        // Snapshot monster positions before the bullet loop so we can check hits without
        // a conflicting borrow on self.world inside the integration logic.
        let mut monster_snapshots = std::mem::take(&mut self.scratch_snapshots);
        monster_snapshots.clear();
        monster_snapshots.extend(
            self.world
                .entities()
                .filter(|&id| {
                    self.world
                        .net_flags(id)
                        .is_some_and(|f| f & NET_MONSTER != 0)
                })
                .filter_map(|id| Some((id, self.world.position(id)?))),
        );

        let mut hits: Vec<HitPatch> = Vec::new();

        for &id in &bullet_ids {
            // TTL and dead-bullet gate.
            // Use a block so the mutable borrow on bullet_ages is dropped before the
            // rest of the loop body (which also needs &mut self).
            {
                let age = self.bullet_ages.entry(id).or_insert(0);
                if *age == BULLET_DEAD {
                    // HitPatch already emitted; waiting for TS to call destroy_entity.
                    continue;
                }
                *age += 1;
                if *age > PROJ_MAX_FRAMES {
                    hits.push(HitPatch {
                        bullet_eid: id,
                        target_eid: None,
                    });
                    *age = BULLET_DEAD;
                    continue;
                }
            }

            let Some(pos) = self.world.position(id) else {
                continue;
            };
            let Some(vel) = self.world.velocity(id) else {
                continue;
            };

            // Bullet left the play area. Mark dead so we don't re-emit every tick
            // while TS processes the HitPatch. TS owns the destroy_entity call.
            if pos[1] < -20.0 {
                hits.push(HitPatch {
                    bullet_eid: id,
                    target_eid: None,
                });
                self.bullet_ages.insert(id, BULLET_DEAD);
                continue;
            }

            // Apply gravity before integration so it accumulates across ticks.
            // Shadow vel so the gravity-adjusted values are used for the ray and position.
            let vel = [vel[0], vel[1] - 20.0 * dt_secs, vel[2]];

            let speed = (vel[0].powi(2) + vel[1].powi(2) + vel[2].powi(2)).sqrt();
            if speed > 1e-6 {
                let dir = [vel[0] / speed, vel[1] / speed, vel[2] / speed];
                let dist = speed * dt_secs;

                if let Some((normal, toi)) =
                    self.physics
                        .cast_ray_with_normal([pos[0], pos[1], pos[2]], dir, dist)
                {
                    let dot = vel[0] * normal[0] + vel[1] * normal[1] + vel[2] * normal[2];
                    self.world.set_velocity(
                        id,
                        [
                            vel[0] - 2.0 * dot * normal[0],
                            vel[1] - 2.0 * dot * normal[1],
                            vel[2] - 2.0 * dot * normal[2],
                        ],
                    );
                    self.world.set_position(
                        id,
                        [
                            pos[0] + dir[0] * toi + normal[0] * 0.02,
                            pos[1] + dir[1] * toi + normal[1] * 0.02,
                            pos[2] + dir[2] * toi + normal[2] * 0.02,
                        ],
                    );
                } else {
                    // Store gravity-updated velocity so the arc accumulates next tick.
                    self.world.set_velocity(id, vel);
                    self.world.set_position(
                        id,
                        [
                            pos[0] + vel[0] * dt_secs,
                            pos[1] + vel[1] * dt_secs,
                            pos[2] + vel[2] * dt_secs,
                        ],
                    );
                }
            } else {
                self.world.set_velocity(id, vel);
            }

            self.world.mark_dirty(id, DirtyFlags::TRANSFORM);

            // Read the updated position for hit detection.
            let bpos = match self.world.position(id) {
                Some(p) => p,
                None => continue,
            };

            for &(mid, mpos) in &monster_snapshots {
                let dx = bpos[0] - mpos[0];
                let dy = bpos[1] - mpos[1];
                let dz = bpos[2] - mpos[2];
                if dx * dx + dy * dy + dz * dz < PROJ_HIT_RADIUS_SQ {
                    hits.push(HitPatch {
                        bullet_eid: id,
                        target_eid: Some(mid),
                    });
                    // Mark dead so subsequent ticks don't re-emit. TS calls destroy_entity
                    // when it processes the HitPatch — Rust must not destroy the entity here
                    // because the freed ID could be recycled before TS's destroy arrives.
                    self.bullet_ages.insert(id, BULLET_DEAD);
                    break;
                }
            }
        }

        // Return buffers so their capacity is reused next tick.
        self.scratch_snapshots = monster_snapshots;
        self.scratch_ids = bullet_ids;

        hits
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

// --- Blueprint types ---

#[derive(Decode)]
struct EntityBlueprint {
    position: Option<[f32; 3]>,
    net_flags: Option<u8>,
    health: Option<i32>,
    collider: Option<ColliderBp>,
}

#[derive(Decode)]
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
    metrics: JsMetrics,
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
}

#[derive(Serialize)]
struct JsNet {
    peer_id: String,
    entity: u32,
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
                })
                .collect(),
            net: b
                .net
                .into_iter()
                .map(|n| JsNet {
                    peer_id: n.peer_id,
                    entity: n.entity,
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
        let mut engine = Engine::new();
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
        let mut engine = Engine::new();
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
            start_y: Some(0.0),
        });
        assert!(
            path.is_some(),
            "path should exist across terrain located at ~(200, 200)"
        );
    }

    #[test]
    fn navmesh_is_none_without_floor_geometry() {
        let mut engine = Engine::new();
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
    fn unreachable_goal_does_not_replan_every_tick() {
        // A goal on an isolated island makes every A* search fail after exhausting
        // the graph. Failed searches must respect the replan cooldown — the exhausted-
        // path branch must not zero it, or one bad goal becomes a full-mesh search
        // per tick and the tick budget collapses.
        let mut engine = Engine::new();
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

    #[test]
    fn teleport_entity_moves_existing_dynamic_body() {
        let mut engine = Engine::new();
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
}
