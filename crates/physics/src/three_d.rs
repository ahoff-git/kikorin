//! Rapier3D-backed physics: X/Z is the ground plane, Y is up. Mirrors
//! `two_d.rs` method-for-method; see `lib.rs`'s `PhysicsWorld` dispatcher for
//! the shared public contract both backends implement identically.

use ecs::{DirtyFlags, EntityId, World};
use rapier3d::prelude::*;

// ShapeCastOptions lives in parry, re-exported through rapier but not in the prelude glob.
use rapier3d::parry::query::ShapeCastOptions;
// Group and InteractionGroups may not be in the prelude glob depending on rapier version.
use rapier3d::geometry::{Group, InteractionGroups};
use std::collections::HashMap;

// Grounded ray casts are expensive (query_pipeline scan). Results are cached and
// recast only every GROUNDED_STRIDE ticks; the crate is tick-rate agnostic — at
// the engine's 4 ms step that is ~62 recasts/sec.
const GROUNDED_STRIDE: u64 = 4;

// A velocity-command Y below this magnitude means "gravity owns Y" (see the
// Velocity Split section of physics.spec.md); above it, the command overrides
// Rapier's accumulated vertical velocity for this sync.
const Y_COMMAND_THRESHOLD: f32 = 0.01;

// Downward floor probes start from this height; anything above it is outside
// the probe-able world.
const FLOOR_RAY_START_Y: f32 = 1000.0;

/// Predicate for queries that must only see static terrain. Callers pair it
/// with `exclude_sensors()`: sensor volumes are fixed bodies too, but they are
/// zones, not surfaces — grounding on one, bouncing a bullet off one, or
/// sampling a floor height from one would all be wrong.
fn is_fixed_collider(bodies: &RigidBodySet, col: &Collider) -> bool {
    col.parent()
        .and_then(|rb| bodies.get(rb))
        .is_some_and(|rb| rb.is_fixed())
}

fn cuboid_shape(cfg: &ecs::ColliderConfig) -> SharedShape {
    SharedShape::cuboid(cfg.half_width, cfg.half_height, cfg.half_depth)
}

/// Wraps a Rapier3D physics world and manages entity ↔ rigid-body mappings.
pub struct PhysicsWorld3D {
    gravity: Vector<f32>,
    integration_params: IntegrationParameters,
    pipeline: PhysicsPipeline,
    island_manager: IslandManager,
    broad_phase: DefaultBroadPhase,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    query_pipeline: QueryPipeline,

    // entity ↔ physics handle mappings
    entity_to_rb: HashMap<EntityId, RigidBodyHandle>,
    entity_to_col: HashMap<EntityId, ColliderHandle>,
    col_to_entity: HashMap<ColliderHandle, EntityId>,

    // contact tracking per entity (refreshed each step)
    touching: HashMap<EntityId, Vec<EntityId>>,

    // See GROUNDED_STRIDE for the caching policy.
    tick_count: u64,
    grounded_cache: HashMap<EntityId, bool>,
}

impl PhysicsWorld3D {
    pub fn new(gravity: f32) -> Self {
        Self {
            gravity: vector![0.0, gravity, 0.0],
            integration_params: IntegrationParameters::default(),
            pipeline: PhysicsPipeline::new(),
            island_manager: IslandManager::new(),
            broad_phase: DefaultBroadPhase::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            query_pipeline: QueryPipeline::new(),
            entity_to_rb: HashMap::new(),
            entity_to_col: HashMap::new(),
            col_to_entity: HashMap::new(),
            touching: HashMap::new(),
            tick_count: 0,
            grounded_cache: HashMap::new(),
        }
    }

    /// Sync entity positions/colliders from ECS world into Rapier before stepping.
    pub fn sync_from_world(&mut self, world: &World) {
        for id in world.entities() {
            let Some(cfg) = world.collider(id) else {
                continue;
            };
            if !cfg.active {
                self.remove_entity(id);
                continue;
            }

            let pos = world.position(id).unwrap_or([0.0; 3]);
            let is_floor = world.is_floor(id);
            let is_dynamic = !is_floor && !cfg.sensor;

            if let Some(&rb_handle) = self.entity_to_rb.get(&id) {
                // Dynamic body positions come from physics — do NOT read them back from ECS
                // and call set_translation. That would be a no-op round-trip that triggers a
                // broadphase AABB update for every dynamic body every tick (very expensive at
                // 250 Hz with 10+ agents). Only apply the velocity command from game code.
                // Teleporting a dynamic entity requires calling set_translation directly on the
                // Rapier body; it cannot be done by writing the ECS position field.
                if is_dynamic {
                    if let Some(rb) = self.bodies.get_mut(rb_handle) {
                        if let Some(vel) = world.velocity(id) {
                            let vy = if vel[1].abs() > Y_COMMAND_THRESHOLD {
                                vel[1]
                            } else {
                                rb.linvel().y
                            };
                            rb.set_linvel(vector![vel[0], vy, vel[2]], true);
                        }
                    }
                }
            } else {
                // Create new rigid body + collider
                let rb = if is_dynamic {
                    RigidBodyBuilder::dynamic()
                        .translation(vector![pos[0], pos[1], pos[2]])
                        .lock_rotations()
                        .build()
                } else {
                    RigidBodyBuilder::fixed()
                        .translation(vector![pos[0], pos[1], pos[2]])
                        .build()
                };
                let rb_handle = self.bodies.insert(rb);

                let shape = cuboid_shape(&cfg);

                let col_builder = if cfg.sensor {
                    ColliderBuilder::new(shape).sensor(true)
                } else if is_dynamic {
                    // Zero-friction + Multiply combine + GROUP_2→GROUP_1 broadphase
                    // filter — rationale in physics.spec.md ("Zero Friction" and
                    // "Collision Groups" sections).
                    ColliderBuilder::new(shape)
                        .friction(0.0)
                        .friction_combine_rule(CoefficientCombineRule::Multiply)
                        .collision_groups(InteractionGroups::new(Group::GROUP_2, Group::GROUP_1))
                } else {
                    ColliderBuilder::new(shape)
                };
                let col_handle = self.colliders.insert_with_parent(
                    col_builder.build(),
                    rb_handle,
                    &mut self.bodies,
                );

                self.entity_to_rb.insert(id, rb_handle);
                self.entity_to_col.insert(id, col_handle);
                self.col_to_entity.insert(col_handle, id);
            }
        }
    }

    /// Step the physics simulation by dt_secs.
    pub fn step(&mut self, dt_secs: f32) {
        self.integration_params.dt = dt_secs;
        self.tick_count = self.tick_count.wrapping_add(1);
        self.pipeline.step(
            &self.gravity,
            &self.integration_params,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &(),
            &(),
        );
        self.rebuild_touching();
    }

    /// Write physics results (position, grounded) back into the ECS world.
    pub fn sync_to_world(&mut self, world: &mut World) {
        for (&id, &rb_handle) in &self.entity_to_rb {
            let Some(rb) = self.bodies.get(rb_handle) else {
                continue;
            };
            if rb.is_fixed() {
                continue;
            }
            let t = rb.translation();
            world.set_position(id, [t.x, t.y, t.z]);
            world.mark_dirty(id, DirtyFlags::TRANSFORM);

            let grounded = if self.tick_count.is_multiple_of(GROUNDED_STRIDE) {
                let result = self.grounded_ray_hit(id, [t.x, t.y, t.z], world);
                self.grounded_cache.insert(id, result);
                result
            } else {
                *self.grounded_cache.get(&id).unwrap_or(&false)
            };
            world.set_grounded(id, grounded);
        }
    }

    /// Grounded probe: short downward ray from the entity center, max distance
    /// `half_height + GROUND_TOL`; grounded iff it hits a floor entity.
    /// A ray aimed straight down can only intersect horizontally-facing surfaces
    /// (top/bottom faces of boxes). Vertical side faces of stairs and walls are
    /// parallel to the ray direction and are never hit, so side contacts cannot
    /// produce a false grounded=true. Sensors are excluded — standing inside a
    /// sensor volume must not mask the floor beneath it.
    fn grounded_ray_hit(&self, id: EntityId, center: [f32; 3], world: &World) -> bool {
        let Some(cfg) = world.collider(id) else {
            return false;
        };
        const GROUND_TOL: f32 = 0.10;
        let max_dist = cfg.half_height + GROUND_TOL;
        let ray = Ray::new(
            point![center[0], center[1], center[2]],
            vector![0.0, -1.0, 0.0],
        );
        let only_fixed = |_h: ColliderHandle, col: &Collider| is_fixed_collider(&self.bodies, col);
        let base = QueryFilter::new().exclude_sensors().predicate(&only_fixed);
        let filter = match self.entity_to_col.get(&id).copied() {
            Some(col) => base.exclude_collider(col),
            None => base,
        };
        self.query_pipeline
            .cast_ray(&self.bodies, &self.colliders, &ray, max_dist, true, filter)
            .is_some_and(|(hit_col, _toi)| {
                self.col_to_entity
                    .get(&hit_col)
                    .is_some_and(|&other| world.is_floor(other))
            })
    }

    /// Rebuild the spatial query pipeline without stepping the simulation.
    /// Call this before any query (`floor_height_at`, `cast_ray`, `cast_collider`)
    /// when entities have been added but `step` has not yet run.
    pub fn prepare_queries(&mut self) {
        self.query_pipeline.update(&self.colliders);
    }

    /// Ray cast downward to find the floor surface Y at the given XZ position.
    pub fn floor_height_at(&self, x: f32, z: f32) -> Option<f32> {
        let ray = Ray::new(point![x, FLOOR_RAY_START_Y, z], vector![0.0, -1.0, 0.0]);
        // Name the predicate so the closure lives long enough
        let is_fixed = |_h: ColliderHandle, col: &Collider| is_fixed_collider(&self.bodies, col);
        let filter = QueryFilter::new().exclude_sensors().predicate(&is_fixed);

        self.query_pipeline
            .cast_ray(
                &self.bodies,
                &self.colliders,
                &ray,
                FLOOR_RAY_START_Y * 2.0,
                true,
                filter,
            )
            .map(|(_handle, toi)| FLOOR_RAY_START_Y - toi)
    }

    /// Returns the list of entity IDs currently in contact with `entity`.
    pub fn touching(&self, entity: EntityId) -> &[EntityId] {
        self.touching
            .get(&entity)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Move a dynamic body directly in Rapier.
    ///
    /// ECS position writes do not move existing dynamic bodies: sync_from_world treats
    /// Rapier as the source of truth for them. Use this for explicit teleports.
    pub fn teleport_entity(&mut self, id: EntityId, position: [f32; 3]) {
        // The cached grounded state is stale wherever the entity lands.
        self.grounded_cache.remove(&id);
        let Some(&rb_handle) = self.entity_to_rb.get(&id) else {
            return;
        };
        let Some(rb) = self.bodies.get_mut(rb_handle) else {
            return;
        };

        rb.set_translation(vector![position[0], position[1], position[2]], true);
        rb.set_linvel(vector![0.0, 0.0, 0.0], true);
    }

    /// Swept collider cast used for wall detection.
    /// Returns the normal of the first hit surface, if any.
    pub fn cast_collider(
        &self,
        entity: EntityId,
        world: &World,
        direction: [f32; 3],
        max_toi: f32,
    ) -> Option<[f32; 3]> {
        let cfg = world.collider(entity)?;
        let pos = world.position(entity)?;

        let shape = cuboid_shape(&cfg);
        let iso = Isometry::translation(pos[0], pos[1], pos[2]);
        let dir = Vector::new(direction[0], direction[1], direction[2]);

        // Sensors are zones, not obstacles — they must not read as walls.
        let filter = QueryFilter::new()
            .exclude_sensors()
            .exclude_collider(*self.entity_to_col.get(&entity)?);

        self.query_pipeline
            .cast_shape(
                &self.bodies,
                &self.colliders,
                &iso,
                &dir,
                shape.as_ref(),
                ShapeCastOptions::with_max_time_of_impact(max_toi),
                filter,
            )
            .map(|(_handle, hit)| {
                let n = hit.normal1;
                [n.x, n.y, n.z]
            })
    }

    /// Ray cast against fixed (terrain) colliders only; returns (surface_normal, toi).
    /// `dir` must be unit-length. Used by bullet bounce: excludes dynamic bodies so
    /// bullets only reflect off walls/floors, not monsters or the player.
    pub fn cast_ray_with_normal(
        &self,
        from: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
    ) -> Option<([f32; 3], f32)> {
        let ray = Ray::new(
            point![from[0], from[1], from[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        let is_fixed = |_h: ColliderHandle, col: &Collider| is_fixed_collider(&self.bodies, col);
        let filter = QueryFilter::new().exclude_sensors().predicate(&is_fixed);
        self.query_pipeline
            .cast_ray_and_get_normal(&self.bodies, &self.colliders, &ray, max_toi, true, filter)
            .map(|(_, hit)| {
                let n = hit.normal;
                ([n.x, n.y, n.z], hit.time_of_impact)
            })
    }

    /// Simple ray cast; returns (entity_id, time_of_impact) for the first hit.
    pub fn cast_ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<(EntityId, f32)> {
        let dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        let len = (dir[0].powi(2) + dir[1].powi(2) + dir[2].powi(2)).sqrt();
        if len < 1e-6 {
            return None;
        }
        let ray = Ray::new(
            point![from[0], from[1], from[2]],
            vector![dir[0] / len, dir[1] / len, dir[2] / len],
        );
        self.query_pipeline
            .cast_ray(
                &self.bodies,
                &self.colliders,
                &ray,
                len,
                true,
                QueryFilter::default(),
            )
            .and_then(|(col_handle, toi)| {
                self.col_to_entity.get(&col_handle).map(|&eid| (eid, toi))
            })
    }

    pub fn remove_entity(&mut self, id: EntityId) {
        self.grounded_cache.remove(&id);
        if let Some(rb_handle) = self.entity_to_rb.remove(&id) {
            self.bodies.remove(
                rb_handle,
                &mut self.island_manager,
                &mut self.colliders,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                true,
            );
        }
        if let Some(col_handle) = self.entity_to_col.remove(&id) {
            self.col_to_entity.remove(&col_handle);
        }
    }

    fn rebuild_touching(&mut self) {
        for v in self.touching.values_mut() {
            v.clear();
        }

        for pair in self.narrow_phase.contact_pairs() {
            if !pair.has_any_active_contact {
                continue;
            }
            let ea = self.col_to_entity.get(&pair.collider1).copied();
            let eb = self.col_to_entity.get(&pair.collider2).copied();
            if let (Some(a), Some(b)) = (ea, eb) {
                self.touching.entry(a).or_default().push(b);
                self.touching.entry(b).or_default().push(a);
            }
        }

        self.touching.retain(|_, v| !v.is_empty());
    }
}
