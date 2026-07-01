use bincode::Decode;
use ecs::{ColliderConfig, DirtyFlags, World};

const NET_BULLET: u8 = 0x02;
use netcode::{DeltaTracker, NetPatch, PeerSession, encode_patches};
use patch::{MetricsPatch, PatchBundle, PatchGenerator};
use pathfinding::{NavMesh, NavMeshConfig, PathRequest};
use physics::PhysicsWorld;
use serde::Serialize;
use wasm_bindgen::prelude::*;

// --- Timing helper ---

struct Timer {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    start_ms: f64,
}

impl Timer {
    fn new() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        { Self { start: std::time::Instant::now() } }
        #[cfg(target_arch = "wasm32")]
        { Self { start_ms: js_sys::Date::now() } }
    }

    fn elapsed_ms(&self) -> f32 {
        #[cfg(not(target_arch = "wasm32"))]
        { self.start.elapsed().as_secs_f32() * 1000.0 }
        #[cfg(target_arch = "wasm32")]
        { (js_sys::Date::now() - self.start_ms) as f32 }
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
    // Pre-computed list of NET_LOCAL entity IDs — updated on spawn/destroy,
    // replaces the per-tick collect::<Vec<_>>() over all entities.
    local_entities: Vec<u32>,
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
        }
    }

    /// Advance simulation by dt_ms milliseconds.
    /// Returns a PatchBundle as a JS object directly — no bincode round-trip.
    pub fn tick(&mut self, dt_ms: f64) -> JsValue {
        let tick_timer = Timer::new();
        let dt_secs = (dt_ms / 1000.0) as f32;
        log::debug!("tick {} — dt_ms={:.2}", self.world.tick_count(), dt_ms);

        // 1. Drain inbound peer messages and apply to world (no TypeScript bounce)
        let net_timer = Timer::new();
        let mut net_patches: Vec<NetPatch> = Vec::new();
        for (_peer_id, bytes) in self.peer_session.drain_inbound() {
            if let Ok(patches) = self.delta_tracker.apply_inbound(&bytes, &mut self.world) {
                net_patches.extend(patches);
            }
        }
        let net_ms = net_timer.elapsed_ms();

        // 2. Physics step
        let physics_timer = Timer::new();
        self.physics.sync_from_world(&self.world);
        self.physics.step(dt_secs);
        self.physics.sync_to_world(&mut self.world);
        let physics_ms = physics_timer.elapsed_ms();

        // 2.5. Bullet update: integrate ballistic trajectory without a Rapier body.
        // NET_BULLET (0x02) entities have no collider — they bypass broadphase entirely.
        // TypeScript owns lifetime and hit detection; destroy_entity removes them.
        {
            let bullet_ids: Vec<u32> = self.world.entities()
                .filter(|&id| self.world.net_flags(id).map_or(false, |f| f & NET_BULLET != 0))
                .collect();
            for id in bullet_ids {
                let Some(pos) = self.world.position(id) else { continue };
                let Some(vel) = self.world.velocity(id) else { continue };
                let speed = (vel[0].powi(2) + vel[1].powi(2) + vel[2].powi(2)).sqrt();
                if speed < 1e-6 { continue; }
                let dir = [vel[0] / speed, vel[1] / speed, vel[2] / speed];
                let dist = speed * dt_secs;

                if let Some((normal, toi)) = self.physics.cast_ray_with_normal([pos[0], pos[1], pos[2]], dir, dist) {
                    // Reflect: v' = v - 2(v·n)n
                    let dot = vel[0] * normal[0] + vel[1] * normal[1] + vel[2] * normal[2];
                    self.world.set_velocity(id, [
                        vel[0] - 2.0 * dot * normal[0],
                        vel[1] - 2.0 * dot * normal[1],
                        vel[2] - 2.0 * dot * normal[2],
                    ]);
                    // Move to contact point, nudged off the surface to avoid re-intersection.
                    self.world.set_position(id, [
                        pos[0] + dir[0] * toi + normal[0] * 0.02,
                        pos[1] + dir[1] * toi + normal[1] * 0.02,
                        pos[2] + dir[2] * toi + normal[2] * 0.02,
                    ]);
                } else {
                    self.world.set_position(id, [
                        pos[0] + vel[0] * dt_secs,
                        pos[1] + vel[1] * dt_secs,
                        pos[2] + vel[2] * dt_secs,
                    ]);
                }
                self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
            }
        }

        // 3. Mark locally-owned entities dirty for grounded/semantic delivery.
        // Uses the pre-cached local_entities list — no allocation, no full-entity scan.
        // TRANSFORM is omitted: physics.sync_to_world already marks it for entities
        // that moved; marking it here would emit render patches for stationary entities.
        let ecs_timer = Timer::new();
        for &id in &self.local_entities {
            self.world.mark_dirty(id, DirtyFlags::HEALTH);
            self.delta_tracker.mark_dirty(id);
        }
        let ecs_ms = ecs_timer.elapsed_ms();

        // 4. Flush outbound deltas to all peers
        let outbound = self.delta_tracker.flush(&self.world, &self.local_peer_id.clone());
        if !outbound.is_empty() {
            self.peer_session.broadcast(&encode_patches(&outbound));
        }

        // 5. Build PatchBundle and convert directly to JsValue.
        // Eliminates the bincode encode→buffer copy→bincode decode round-trip that
        // previously crossed the WASM boundary twice per tick.
        let patch_timer = Timer::new();
        let metrics = MetricsPatch {
            tick_ms: tick_timer.elapsed_ms(),
            ecs_ms,
            physics_ms,
            net_ms,
            patch_ms: 0.0,
        };
        let bundle = self.patch_gen.generate(&self.world, net_patches, metrics);

        self.world.clear_dirty();
        self.world.advance_tick();

        self.last_metrics = bundle.metrics.clone();
        let js = serde_wasm_bindgen::to_value(&JsPatch::from(bundle)).unwrap_or(JsValue::NULL);
        self.last_metrics.patch_ms = patch_timer.elapsed_ms();

        js
    }

    /// Apply a serialized input event or inbound peer message.
    pub fn apply_input(&mut self, payload: &[u8]) {
        let _ = self.delta_tracker.apply_inbound(payload, &mut self.world);
    }

    /// Deserialize a PatchBundle byte array into a JS object.
    /// The adapter calls this so TypeScript doesn't need a bincode parser.
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
            ecs_ms: m.ecs_ms,
            physics_ms: m.physics_ms,
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
    /// TypeScript provides the shared session ID and signaling server URL.
    /// Connection negotiation happens asynchronously inside wasm-peers.
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
            self.world.set_collider(id, ColliderConfig {
                active: cfg.active,
                sensor: cfg.sensor,
                half_width: cfg.hw,
                half_height: cfg.hh,
                half_depth: cfg.hd,
            });
        }
        id
    }

    /// Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
    /// Call once after all floor/terrain entities have been spawned.
    /// The navmesh covers [-80, 80] XZ at 1.5-unit cell resolution.
    pub fn build_navmesh(&mut self) {
        const CELL_SIZE: f32 = 1.5;
        const MIN_X: f32 = -80.0;
        const MAX_X: f32 =  80.0;
        const MIN_Z: f32 = -80.0;
        const MAX_Z: f32 =  80.0;

        const MAX_STEP_UP: f32    = 1.3;
        const JUMP_THRESHOLD: f32 = 0.5;
        const MIN_LEDGE_DROP: f32 = 1.4;
        const MAX_LEDGE_DROP: f32 = 12.0;

        let cols = ((MAX_X - MIN_X) / CELL_SIZE).round() as usize + 1;
        let rows = ((MAX_Z - MIN_Z) / CELL_SIZE).round() as usize + 1;

        // Sync floor entities into Rapier and prime the query pipeline before scanning.
        self.physics.sync_from_world(&self.world);
        self.physics.prepare_queries();

        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: CELL_SIZE,
            min_x: MIN_X,
            max_x: MAX_X,
            min_z: MIN_Z,
            max_z: MAX_Z,
        });

        let mut node_grid: Vec<Option<pathfinding::NodeId>> = vec![None; cols * rows];
        let mut node_ys: Vec<f32> = Vec::new();

        for row in 0..rows {
            for col in 0..cols {
                let x = MIN_X + col as f32 * CELL_SIZE;
                let z = MIN_Z + row as f32 * CELL_SIZE;
                if let Some(y) = self.physics.floor_height_at(x, z) {
                    let id = mesh.add_node(x, y, z);
                    debug_assert_eq!(id as usize, node_ys.len());
                    node_ys.push(y);
                    node_grid[row * cols + col] = Some(id);
                }
            }
        }

        // Connect adjacent walkable nodes. Same height thresholds as the TS navmesh.
        let cardinal_dirs: &[(i32, i32)] = &[(0, 1), (0, -1), (1, 0), (-1, 0)];
        let diagonal_dirs: &[(i32, i32)] = &[(1, 1), (1, -1), (-1, 1), (-1, -1)];
        let dir_sets: &[(&[(i32, i32)], f32)] = &[
            (cardinal_dirs, CELL_SIZE),
            (diagonal_dirs, CELL_SIZE * std::f32::consts::SQRT_2),
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
                        if nc < 0 || nr < 0 || nc >= cols as i32 || nr >= rows as i32 { continue; }
                        let to_id = match node_grid[nr as usize * cols + nc as usize] {
                            Some(id) => id,
                            None => continue,
                        };
                        let height_diff = node_ys[to_id as usize] - from_y;

                        if height_diff > MAX_STEP_UP    { continue; }
                        if height_diff < -MAX_LEDGE_DROP { continue; }

                        let is_ledge_drop = height_diff < -MIN_LEDGE_DROP;
                        let requires_jump = !is_ledge_drop && height_diff > JUMP_THRESHOLD;

                        let height_cost = if requires_jump {
                            height_diff * 0.5
                        } else if is_ledge_drop {
                            height_diff.abs() * 0.1
                        } else {
                            height_diff.max(0.0) * 0.3
                        };

                        mesh.add_edge(from_id, to_id, base_cost + height_cost, requires_jump, is_ledge_drop);
                    }
                }
            }
        }

        log::debug!("build_navmesh: {} nodes", node_ys.len());
        self.navmesh = Some(mesh);
    }

    /// Find a path from (startX, startY, startZ) to (goalX, goalZ).
    /// Returns a JS array of `{x, y, z, requiresJump, isLedgeDrop}` waypoints, or null.
    /// `canJump` — set false for monsters that cannot jump; jump edges are excluded.
    pub fn find_path(
        &self,
        start_x: f32,
        start_y: f32,
        start_z: f32,
        goal_x: f32,
        goal_z: f32,
        can_jump: bool,
    ) -> JsValue {
        let Some(navmesh) = &self.navmesh else { return JsValue::NULL };

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
                let js: Vec<JsWaypoint> = waypoints.iter().map(|w| JsWaypoint {
                    x: w.x,
                    y: w.y,
                    z: w.z,
                    requires_jump: w.requires_jump,
                    is_ledge_drop: w.is_ledge_drop,
                }).collect();
                serde_wasm_bindgen::to_value(&js).unwrap_or(JsValue::NULL)
            }
        }
    }

    /// Destroy an entity and remove its Rapier physics body.
    pub fn destroy_entity(&mut self, id: u32) {
        self.world.destroy_entity(id);
        self.physics.remove_entity(id);
        self.local_entities.retain(|&e| e != id);
    }

    /// Spawn a static floor entity. Returns the entity ID.
    /// The entity is a solid collider; set its Three.js position immediately after spawning.
    pub fn spawn_floor_entity(&mut self, x: f32, y: f32, z: f32, hw: f32, hh: f32, hd: f32) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_collider(id, ColliderConfig {
            active: true,
            sensor: false,
            half_width: hw,
            half_height: hh,
            half_depth: hd,
        });
        self.world.set_floor(id, true);
        id
    }

    /// Spawn a dynamic entity (player, monster, box). Returns the entity ID.
    /// Pass `net_flags = 1` (NET_LOCAL) for locally-simulated entities; they are
    /// automatically included in render patches every tick.
    pub fn spawn_box_entity(
        &mut self, x: f32, y: f32, z: f32,
        hw: f32, hh: f32, hd: f32,
        health: i32, net_flags: u8,
    ) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_velocity(id, [0.0, 0.0, 0.0]);
        self.world.set_health(id, health);
        self.world.set_net_flags(id, net_flags);
        self.world.set_collider(id, ColliderConfig {
            active: true,
            sensor: false,
            half_width: hw,
            half_height: hh,
            half_depth: hd,
        });
        if net_flags & 0x01 != 0 {
            self.local_entities.push(id);
        }
        id
    }

    /// Spawn a projectile. The engine integrates its ballistic trajectory each tick
    /// (constant XZ velocity, 20.0 m/s² gravity on Y) and emits render patches.
    /// No Rapier body is created — bullets bypass broadphase and contact generation.
    /// TypeScript owns lifetime and hit detection; call destroy_entity to remove.
    pub fn spawn_bullet(&mut self, x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32) -> u32 {
        let id = self.world.create_entity();
        self.world.set_position(id, [x, y, z]);
        self.world.set_velocity(id, [vx, vy, vz]);
        self.world.set_net_flags(id, NET_BULLET);
        self.world.mark_dirty(id, DirtyFlags::TRANSFORM);
        id
    }

    /// Set the velocity of an entity. Use from TypeScript game logic each frame.
    /// XZ velocity is always applied. Pass vy=0 for normal movement so that
    /// sync_from_world (in the physics crate) preserves Rapier's accumulated Y
    /// velocity (gravity). Pass non-zero vy only for a one-frame jump impulse.
    pub fn set_entity_velocity(&mut self, id: u32, vx: f32, vy: f32, vz: f32) {
        if self.world.velocity(id).is_some() {
            self.world.set_velocity(id, [vx, vy, vz]);
        }
    }
}

// --- Blueprint types (decoded from apply_input / spawn_entity payloads) ---

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
    ecs_ms: f32,
    physics_ms: f32,
    net_ms: f32,
    patch_ms: f32,
}

#[derive(Serialize)]
struct JsPatch {
    tick: u64,
    render: Vec<JsRender>,
    semantic: Vec<JsSemantic>,
    net: Vec<JsNet>,
    metrics: JsMetrics,
}

#[derive(Serialize)]
struct JsRender {
    entity: u32,
    x: f32, y: f32, z: f32,
    yaw: f32, pitch: f32, roll: f32,
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

impl From<PatchBundle> for JsPatch {
    fn from(b: PatchBundle) -> Self {
        Self {
            tick: b.tick,
            render: b.render.into_iter().map(|r| JsRender {
                entity: r.entity,
                x: r.x, y: r.y, z: r.z,
                yaw: r.yaw, pitch: r.pitch, roll: r.roll,
            }).collect(),
            semantic: b.semantic.into_iter().map(|s| JsSemantic {
                entity: s.entity,
                health: s.health,
                net_flags: s.net_flags,
                grounded: s.grounded,
            }).collect(),
            net: b.net.into_iter().map(|n| JsNet {
                peer_id: n.peer_id,
                entity: n.entity,
            }).collect(),
            metrics: JsMetrics {
                tick_ms: b.metrics.tick_ms,
                ecs_ms: b.metrics.ecs_ms,
                physics_ms: b.metrics.physics_ms,
                net_ms: b.metrics.net_ms,
                patch_ms: b.metrics.patch_ms,
            },
        }
    }
}
