use ecs::{DirtyFlags, EntityId, World};
use rapier3d::prelude::*;
use std::collections::HashMap;

// ShapeCastOptions lives in parry, re-exported through rapier but not in the prelude glob.
use rapier3d::parry::query::ShapeCastOptions;
// Group and InteractionGroups may not be in the prelude glob depending on rapier version.
use rapier3d::geometry::{Group, InteractionGroups};

/// Wraps a Rapier3D physics world and manages entity ↔ rigid-body mappings.
pub struct PhysicsWorld {
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

    // Grounded ray casts are expensive (query_pipeline scan). Cache the result and
    // only recast every GROUNDED_STRIDE ticks; at 250 Hz that is still ~62 checks/sec.
    tick_count: u64,
    grounded_cache: HashMap<EntityId, bool>,
}

impl PhysicsWorld {
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
            let Some(cfg) = world.collider(id) else { continue };
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
                            let vy = if vel[1].abs() > 0.01 { vel[1] } else { rb.linvel().y };
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

                let shape = if cfg.sensor {
                    SharedShape::cuboid(cfg.half_width, cfg.half_height, cfg.half_depth)
                } else {
                    SharedShape::cuboid(cfg.half_width, cfg.half_height, cfg.half_depth)
                };

                let col_builder = if cfg.sensor {
                    ColliderBuilder::new(shape).sensor(true)
                } else if is_dynamic {
                    // Zero friction: wall/stair friction cancels vertical velocity during a jump.
                    // friction(0.0) alone is not enough — Rapier's default combine rule is Average,
                    // so (0.0 + 0.5) / 2 = 0.25 remains. Multiply overrides to 0.0 × 0.5 = 0.0
                    // because Rapier picks max(discriminant) between the two rules (Multiply=2 >
                    // Average=0). collision_groups (broadphase filter) limits contact detection to
                    // GROUP_1 (floor/walls), so agent-agent pairs are never generated by the
                    // broadphase. This eliminates O(N²) narrowphase GJK work when agents cluster.
                    // Engine-side separation (apply_monster_separation in crates/engine) handles
                    // agent-agent avoidance instead.
                    ColliderBuilder::new(shape)
                        .friction(0.0)
                        .friction_combine_rule(CoefficientCombineRule::Multiply)
                        .collision_groups(InteractionGroups::new(Group::GROUP_2, Group::GROUP_1))
                } else {
                    ColliderBuilder::new(shape)
                };
                let col_handle =
                    self.colliders.insert_with_parent(col_builder.build(), rb_handle, &mut self.bodies);

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
            let Some(rb) = self.bodies.get(rb_handle) else { continue };
            if rb.is_fixed() {
                continue;
            }
            let t = rb.translation();
            world.set_position(id, [t.x, t.y, t.z]);
            world.mark_dirty(id, DirtyFlags::TRANSFORM);

            // Grounded: short downward ray from entity center.
            // A ray aimed straight down can only intersect horizontally-facing surfaces
            // (top/bottom faces of boxes). Vertical side faces of stairs and walls are
            // parallel to the ray direction and are never hit, so side contacts cannot
            // produce a false grounded=true.
            // Ray casts are expensive at 250 Hz with many entities; recast every
            // GROUNDED_STRIDE ticks (~62 Hz) and serve the cached value in between.
            const GROUNDED_STRIDE: u64 = 4;
            let grounded = if self.tick_count % GROUNDED_STRIDE == 0 {
                let result = if let Some(cfg) = world.collider(id) {
                    const GROUND_TOL: f32 = 0.10;
                    let max_dist = cfg.half_height + GROUND_TOL;
                    let ray = Ray::new(point![t.x, t.y, t.z], vector![0.0, -1.0, 0.0]);
                    let own_col = self.entity_to_col.get(&id).copied();
                    let only_fixed = |_h: ColliderHandle, col: &Collider| -> bool {
                        col.parent()
                            .and_then(|rb_h| self.bodies.get(rb_h))
                            .map_or(false, |rb| rb.is_fixed())
                    };
                    let filter = match own_col {
                        Some(col) => QueryFilter::new().exclude_collider(col).predicate(&only_fixed),
                        None => QueryFilter::new().predicate(&only_fixed),
                    };
                    self.query_pipeline
                        .cast_ray(&self.bodies, &self.colliders, &ray, max_dist, true, filter)
                        .map_or(false, |(hit_col, _toi)| {
                            self.col_to_entity
                                .get(&hit_col)
                                .map_or(false, |&other| world.is_floor(other))
                        })
                } else {
                    false
                };
                self.grounded_cache.insert(id, result);
                result
            } else {
                *self.grounded_cache.get(&id).unwrap_or(&false)
            };
            world.set_grounded(id, grounded);
        }
    }

    /// Rebuild the spatial query pipeline without stepping the simulation.
    /// Call this before any query (`floor_height_at`, `cast_ray`, `cast_collider`)
    /// when entities have been added but `step` has not yet run.
    pub fn prepare_queries(&mut self) {
        self.query_pipeline.update(&self.colliders);
    }

    /// Ray cast downward to find the floor surface Y at the given XZ position.
    pub fn floor_height_at(&self, x: f32, z: f32) -> Option<f32> {
        let ray = Ray::new(point![x, 1000.0, z], vector![0.0, -1.0, 0.0]);
        // Name the predicate so the closure lives long enough
        let is_fixed = |_handle: ColliderHandle, col: &Collider| -> bool {
            col.parent()
                .and_then(|rb| self.bodies.get(rb))
                .map_or(false, |rb| rb.is_fixed())
        };
        let filter = QueryFilter::new().predicate(&is_fixed);

        self.query_pipeline
            .cast_ray(&self.bodies, &self.colliders, &ray, 2000.0, true, filter)
            .map(|(_handle, toi)| 1000.0 - toi)
    }

    /// Returns the list of entity IDs currently in contact with `entity`.
    pub fn touching(&self, entity: EntityId) -> &[EntityId] {
        self.touching.get(&entity).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Swept collider cast — used for wall detection.
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

        let shape = SharedShape::cuboid(cfg.half_width, cfg.half_height, cfg.half_depth);
        let iso = Isometry::translation(pos[0], pos[1], pos[2]);
        let dir = Vector::new(direction[0], direction[1], direction[2]);

        let filter = QueryFilter::new().exclude_collider(
            *self.entity_to_col.get(&entity)?,
        );

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
    pub fn cast_ray_with_normal(&self, from: [f32; 3], dir: [f32; 3], max_toi: f32) -> Option<([f32; 3], f32)> {
        let ray = Ray::new(point![from[0], from[1], from[2]], vector![dir[0], dir[1], dir[2]]);
        let is_fixed = |_h: ColliderHandle, col: &Collider| -> bool {
            col.parent()
                .and_then(|rb| self.bodies.get(rb))
                .map_or(false, |rb| rb.is_fixed())
        };
        let filter = QueryFilter::new().predicate(&is_fixed);
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
            .cast_ray(&self.bodies, &self.colliders, &ray, len, true, QueryFilter::default())
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

#[cfg(test)]
mod tests {
    use super::*;
    use ecs::{ColliderConfig, World};

    #[test]
    fn sphere_resolves_floor_collision_within_grounded_stride() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);

        // Floor entity at y=0
        let floor = world.create_entity();
        world.set_position(floor, [0.0, 0.0, 0.0]);
        world.set_floor(floor, true);
        world.set_collider(floor, ColliderConfig {
            active: true,
            sensor: false,
            half_width: 10.0,
            half_height: 0.1,
            half_depth: 10.0,
        });

        // Dynamic entity just above the floor (bottom at y=0.05, top at y=0.55)
        let ball = world.create_entity();
        world.set_position(ball, [0.0, 0.3, 0.0]);
        world.set_collider(ball, ColliderConfig {
            active: true,
            sensor: false,
            half_width: 0.25,
            half_height: 0.25,
            half_depth: 0.25,
        });

        phys.sync_from_world(&world);

        let dt = 1.0 / 60.0;
        let mut grounded = false;
        for _ in 0..4 {
            phys.step(dt);
            phys.sync_to_world(&mut world);
            if world.is_grounded(ball).unwrap_or(false) {
                grounded = true;
                break;
            }
        }

        assert!(grounded, "expected grounded=true within the grounded cache stride");
    }
}
