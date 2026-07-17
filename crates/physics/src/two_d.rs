//! Rapier2D-backed physics: X is horizontal, Y is up (gravity applies to Y),
//! matching the 3D backend's Y-up convention one dimension down. There is no
//! second horizontal axis — Z carries no physical meaning here at all.
//!
//! The outer `PhysicsWorld` API stays `[f32; 3]`-shaped for parity with the 3D
//! backend and with the ECS `World`'s position/velocity storage. This backend
//! only ever reads index 0 (x) and index 1 (y); index 2 (z) is never read for
//! physics and is passed through unchanged on `sync_to_world` (whatever the
//! caller last put there — e.g. a render depth/layering value — survives a
//! physics tick untouched, since Rapier2D itself has no concept of it).
//! Callers that pass a genuinely 3D `direction`/`to` (e.g. `cast_ray`'s `to`)
//! get a purely-2D interpretation: only x/y participate in the cast; z is
//! ignored, not treated as depth.

use ecs::{DirtyFlags, EntityId, World};
use rapier2d::prelude::*;

// ShapeCastOptions lives in parry, re-exported through rapier but not in the prelude glob.
use rapier2d::parry::query::ShapeCastOptions;
// Group and InteractionGroups may not be in the prelude glob depending on rapier version.
use rapier2d::geometry::{Group, InteractionGroups};
use std::collections::HashMap;

// See three_d.rs for the rationale behind each of these — identical policy,
// one dimension down.
const GROUNDED_STRIDE: u64 = 4;
const Y_COMMAND_THRESHOLD: f32 = 0.01;
const FLOOR_RAY_START_Y: f32 = 1000.0;

fn is_fixed_collider(bodies: &RigidBodySet, col: &Collider) -> bool {
    col.parent()
        .and_then(|rb| bodies.get(rb))
        .is_some_and(|rb| rb.is_fixed())
}

/// 2D box shape from the same `ColliderConfig` the 3D backend uses —
/// `half_depth` is ignored (no depth axis in 2D physics).
fn cuboid_shape(cfg: &ecs::ColliderConfig) -> SharedShape {
    SharedShape::cuboid(cfg.half_width, cfg.half_height)
}

/// Wraps a Rapier2D physics world and manages entity ↔ rigid-body mappings.
/// Method-for-method mirror of `three_d::PhysicsWorld3D` — see its docs for
/// per-method rationale; comments here cover only what differs in 2D.
pub struct PhysicsWorld2D {
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

    entity_to_rb: HashMap<EntityId, RigidBodyHandle>,
    entity_to_col: HashMap<EntityId, ColliderHandle>,
    col_to_entity: HashMap<ColliderHandle, EntityId>,

    touching: HashMap<EntityId, Vec<EntityId>>,

    tick_count: u64,
    grounded_cache: HashMap<EntityId, bool>,

    // Collision-class overrides (see specs/physics "Collision Groups"):
    // walls live in their own group so phasing bodies can filter them out.
    wall_ids: std::collections::HashSet<EntityId>,
    phasing_ids: std::collections::HashSet<EntityId>,
}

impl PhysicsWorld2D {
    pub fn new(gravity: f32) -> Self {
        Self {
            gravity: vector![0.0, gravity],
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
            wall_ids: std::collections::HashSet::new(),
            phasing_ids: std::collections::HashSet::new(),
        }
    }

    /// See PhysicsWorld3D::dynamic_groups — duplicated per ADR 0001.
    fn dynamic_groups(&self, id: EntityId) -> InteractionGroups {
        let filter = if self.phasing_ids.contains(&id) {
            Group::GROUP_1
        } else {
            Group::GROUP_1 | Group::GROUP_3
        };
        InteractionGroups::new(Group::GROUP_2, filter)
    }

    fn static_groups(&self, id: EntityId) -> InteractionGroups {
        let membership = if self.wall_ids.contains(&id) {
            Group::GROUP_3
        } else {
            Group::GROUP_1
        };
        InteractionGroups::new(membership, Group::ALL)
    }

    pub fn set_wall(&mut self, id: EntityId, is_wall: bool) {
        if is_wall {
            self.wall_ids.insert(id);
        } else {
            self.wall_ids.remove(&id);
        }
        let groups = self.static_groups(id);
        if let Some(&h) = self.entity_to_col.get(&id) {
            if let Some(col) = self.colliders.get_mut(h) {
                col.set_collision_groups(groups);
            }
        }
    }

    pub fn set_phasing(&mut self, id: EntityId, phasing: bool) {
        if phasing {
            self.phasing_ids.insert(id);
        } else {
            self.phasing_ids.remove(&id);
        }
        let groups = self.dynamic_groups(id);
        if let Some(&h) = self.entity_to_col.get(&id) {
            if let Some(col) = self.colliders.get_mut(h) {
                col.set_collision_groups(groups);
            }
        }
    }

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
                if is_dynamic {
                    if let Some(rb) = self.bodies.get_mut(rb_handle) {
                        if let Some(vel) = world.velocity(id) {
                            let vy = if vel[1].abs() > Y_COMMAND_THRESHOLD {
                                vel[1]
                            } else {
                                rb.linvel().y
                            };
                            rb.set_linvel(vector![vel[0], vy], true);
                        }
                    }
                }
            } else {
                let rb = if is_dynamic {
                    RigidBodyBuilder::dynamic()
                        .translation(vector![pos[0], pos[1]])
                        .lock_rotations()
                        .build()
                } else {
                    RigidBodyBuilder::fixed()
                        .translation(vector![pos[0], pos[1]])
                        .build()
                };
                let rb_handle = self.bodies.insert(rb);

                let shape = cuboid_shape(&cfg);

                let col_builder = if cfg.sensor {
                    ColliderBuilder::new(shape).sensor(true)
                } else if is_dynamic {
                    ColliderBuilder::new(shape)
                        .friction(0.0)
                        .friction_combine_rule(CoefficientCombineRule::Multiply)
                        .collision_groups(self.dynamic_groups(id))
                } else {
                    ColliderBuilder::new(shape).collision_groups(self.static_groups(id))
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

    /// Writes (x, y) back from physics; index 2 (z) is read from the world's
    /// current value and passed through unchanged — Rapier2D never touches it.
    pub fn sync_to_world(&mut self, world: &mut World) {
        for (&id, &rb_handle) in &self.entity_to_rb {
            let Some(rb) = self.bodies.get(rb_handle) else {
                continue;
            };
            if rb.is_fixed() {
                continue;
            }
            let t = rb.translation();
            let z = world.position(id).map_or(0.0, |p| p[2]);
            world.set_position(id, [t.x, t.y, z]);
            world.mark_dirty(id, DirtyFlags::TRANSFORM);

            let grounded = if self.tick_count.is_multiple_of(GROUNDED_STRIDE) {
                let result = self.grounded_ray_hit(id, [t.x, t.y], world);
                self.grounded_cache.insert(id, result);
                result
            } else {
                *self.grounded_cache.get(&id).unwrap_or(&false)
            };
            world.set_grounded(id, grounded);
        }
    }

    fn grounded_ray_hit(&self, id: EntityId, center: [f32; 2], world: &World) -> bool {
        let Some(cfg) = world.collider(id) else {
            return false;
        };
        const GROUND_TOL: f32 = 0.10;
        let max_dist = cfg.half_height + GROUND_TOL;
        let ray = Ray::new(point![center[0], center[1]], vector![0.0, -1.0]);
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

    pub fn prepare_queries(&mut self) {
        self.query_pipeline.update(&self.colliders);
    }

    /// Ray cast downward to find the floor surface Y at horizontal position
    /// `x`. `z` is accepted only for API parity with the 3D backend (there is
    /// no second horizontal axis in 2D) and is ignored.
    pub fn floor_height_at(&self, x: f32, _z: f32) -> Option<f32> {
        let ray = Ray::new(point![x, FLOOR_RAY_START_Y], vector![0.0, -1.0]);
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

    pub fn touching(&self, entity: EntityId) -> &[EntityId] {
        self.touching
            .get(&entity)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// `position[2]` is ignored — 2D bodies have no z to teleport.
    pub fn teleport_entity(&mut self, id: EntityId, position: [f32; 3]) {
        self.grounded_cache.remove(&id);
        let Some(&rb_handle) = self.entity_to_rb.get(&id) else {
            return;
        };
        let Some(rb) = self.bodies.get_mut(rb_handle) else {
            return;
        };

        rb.set_translation(vector![position[0], position[1]], true);
        rb.set_linvel(vector![0.0, 0.0], true);
    }

    /// `direction[2]` is ignored; the returned normal's third component is
    /// always 0.0 (2D surfaces have no z-facing component).
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
        let iso = Isometry::translation(pos[0], pos[1]);
        let dir = Vector::new(direction[0], direction[1]);

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
                [n.x, n.y, 0.0]
            })
    }

    /// `from`/`dir`'s third component is ignored; `dir` must still be
    /// unit-length in its x/y components. Returned normal's z is always 0.0.
    pub fn cast_ray_with_normal(
        &self,
        from: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
    ) -> Option<([f32; 3], f32)> {
        let ray = Ray::new(point![from[0], from[1]], vector![dir[0], dir[1]]);
        let is_fixed = |_h: ColliderHandle, col: &Collider| is_fixed_collider(&self.bodies, col);
        let filter = QueryFilter::new().exclude_sensors().predicate(&is_fixed);
        self.query_pipeline
            .cast_ray_and_get_normal(&self.bodies, &self.colliders, &ray, max_toi, true, filter)
            .map(|(_, hit)| {
                let n = hit.normal;
                ([n.x, n.y, 0.0], hit.time_of_impact)
            })
    }

    /// Distance and direction are computed purely from x/y — a z difference
    /// between `from` and `to` is not treated as depth and does not affect
    /// the cast.
    pub fn cast_ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<(EntityId, f32)> {
        let dir = [to[0] - from[0], to[1] - from[1]];
        let len = (dir[0].powi(2) + dir[1].powi(2)).sqrt();
        if len < 1e-6 {
            return None;
        }
        let ray = Ray::new(
            point![from[0], from[1]],
            vector![dir[0] / len, dir[1] / len],
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
