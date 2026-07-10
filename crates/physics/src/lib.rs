use ecs::{DirtyFlags, EntityId, World};
use rapier3d::prelude::*;
use std::collections::HashMap;

// ShapeCastOptions lives in parry, re-exported through rapier but not in the prelude glob.
use rapier3d::parry::query::ShapeCastOptions;
// Group and InteractionGroups may not be in the prelude glob depending on rapier version.
use rapier3d::geometry::{Group, InteractionGroups};

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

    // See GROUNDED_STRIDE for the caching policy.
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

#[cfg(test)]
mod tests {
    use super::*;
    use ecs::{ColliderConfig, World};

    const DT: f32 = 1.0 / 60.0;

    /// Fixed terrain body. Walls use the same floor flag as floors — the flag
    /// means "static terrain" to sync_from_world, not "horizontal surface".
    fn spawn_static(world: &mut World, pos: [f32; 3], half: [f32; 3]) -> EntityId {
        let id = world.create_entity();
        world.set_position(id, pos);
        world.set_floor(id, true);
        world.set_collider(
            id,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: half[0],
                half_height: half[1],
                half_depth: half[2],
            },
        );
        id
    }

    fn spawn_dynamic(world: &mut World, pos: [f32; 3], half: f32) -> EntityId {
        let id = world.create_entity();
        world.set_position(id, pos);
        world.set_collider(
            id,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: half,
                half_height: half,
                half_depth: half,
            },
        );
        id
    }

    fn spawn_sensor(world: &mut World, pos: [f32; 3], half: [f32; 3]) -> EntityId {
        let id = world.create_entity();
        world.set_position(id, pos);
        world.set_collider(
            id,
            ColliderConfig {
                active: true,
                sensor: true,
                half_width: half[0],
                half_height: half[1],
                half_depth: half[2],
            },
        );
        id
    }

    /// Sensors are fixed bodies, so terrain-only query predicates would admit
    /// them without explicit sensor exclusion. Standing inside a trigger volume
    /// must not mask the floor beneath it.
    #[test]
    fn grounded_survives_standing_inside_a_sensor_volume() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.36, 0.0], 0.25);
        // Trigger zone fully enclosing the ball.
        spawn_sensor(&mut world, [0.0, 1.0, 0.0], [2.0, 2.0, 2.0]);

        // Enough ticks to settle onto the floor and pass several recast strides.
        for _ in 0..(GROUNDED_STRIDE as usize * 6) {
            tick(&mut phys, &mut world);
        }

        assert_eq!(
            world.is_grounded(ball),
            Some(true),
            "a sensor volume must not mask the floor beneath the entity",
        );
    }

    /// floor_height_at must see through sensor volumes to real terrain.
    #[test]
    fn floor_height_ignores_sensor_volumes() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]); // top at 0.1
        spawn_sensor(&mut world, [0.0, 3.0, 0.0], [1.0, 1.0, 1.0]); // top at 4.0

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let h = phys.floor_height_at(0.0, 0.0).expect("floor must be found");
        assert!(
            (h - 0.1).abs() < 0.01,
            "sensor top (y=4.0) must not read as floor height, got {h}",
        );
    }

    /// Pins the create-once contract: collider config changes on a live body are
    /// ignored — the only rebuild path is deactivate → reactivate.
    #[test]
    fn collider_config_changes_on_live_bodies_are_ignored() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.36, 0.0], 0.25);
        for _ in 0..(GROUNDED_STRIDE as usize * 6) {
            tick(&mut phys, &mut world);
        }
        assert_eq!(world.is_grounded(ball), Some(true), "ball should settle first");

        // Grow the collider so its bottom would clip into the floor if applied —
        // a live-rebuilt body would depenetrate upward. Nothing must change.
        let y_before = world.position(ball).unwrap()[1];
        let mut cfg = world.collider(ball).unwrap();
        cfg.half_height = 2.0;
        world.set_collider(ball, cfg);
        for _ in 0..4 {
            tick(&mut phys, &mut world);
        }
        let y_after = world.position(ball).unwrap()[1];
        assert!(
            (y_after - y_before).abs() < 0.01,
            "live collider mutation must be a no-op: y {y_before} -> {y_after}",
        );
    }

    /// One full 60 Hz physics tick: sync in, step, sync out.
    fn tick(phys: &mut PhysicsWorld, world: &mut World) {
        phys.sync_from_world(world);
        phys.step(DT);
        phys.sync_to_world(world);
    }

    fn deactivate(world: &mut World, id: EntityId) {
        let mut cfg = world.collider(id).unwrap();
        cfg.active = false;
        world.set_collider(id, cfg);
    }

    #[test]
    fn sphere_resolves_floor_collision_within_grounded_stride() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);

        // Floor entity at y=0
        let floor = world.create_entity();
        world.set_position(floor, [0.0, 0.0, 0.0]);
        world.set_floor(floor, true);
        world.set_collider(
            floor,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: 10.0,
                half_height: 0.1,
                half_depth: 10.0,
            },
        );

        // Dynamic entity just above the floor (bottom at y=0.05, top at y=0.55)
        let ball = world.create_entity();
        world.set_position(ball, [0.0, 0.3, 0.0]);
        world.set_collider(
            ball,
            ColliderConfig {
                active: true,
                sensor: false,
                half_width: 0.25,
                half_height: 0.25,
                half_depth: 0.25,
            },
        );

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

        assert!(
            grounded,
            "expected grounded=true within the grounded cache stride"
        );
    }

    #[test]
    fn dynamic_body_falls_under_gravity_and_lands_grounded() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        let mut prev_y = 3.0f32;
        let mut landed = false;
        let mut contacted = false;
        for i in 1..=240 {
            tick(&mut phys, &mut world);
            let y = world.position(ball).unwrap()[1];
            // Depenetration can nudge y up by a few 1e-4 once contact begins, and
            // grounded only flips on GROUNDED_STRIDE recast ticks — so gate the
            // monotonic-descent check on contact, not on observed grounded.
            contacted = contacted || !phys.touching(ball).is_empty();
            if !contacted {
                assert!(
                    y <= prev_y + 1e-4,
                    "airborne y must not increase: {prev_y} -> {y} at tick {i}"
                );
            }
            // First grounded recast tick: still far above the floor, must be mid-air.
            if i == 4 {
                assert!(y > 1.0, "body should still be high at tick 4, y={y}");
                assert_eq!(
                    world.is_grounded(ball),
                    Some(false),
                    "mid-air body must not be grounded"
                );
            }
            if world.is_grounded(ball) == Some(true) {
                landed = true;
            }
            prev_y = y;
        }
        assert!(landed, "expected grounded=true within 240 ticks");
        let y = world.position(ball).unwrap()[1];
        assert!(
            (y - 0.35).abs() < 0.05,
            "resting y should be floor top + half_height, got {y}"
        );
    }

    #[test]
    fn wall_side_contact_does_not_set_grounded() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        // Tall wall spanning y in [0, 10]; nothing below the body to land on.
        let wall = spawn_static(&mut world, [1.0, 5.0, 0.0], [0.5, 5.0, 0.5]);
        let ball = spawn_dynamic(&mut world, [0.2, 8.0, 0.0], 0.25);
        // Press into the wall's vertical face every tick while gravity pulls down.
        world.set_velocity(ball, [1.5, 0.0, 0.0]);

        for _ in 1..=12 {
            tick(&mut phys, &mut world);
            assert_eq!(
                world.is_grounded(ball),
                Some(false),
                "side contact with a vertical face must never set grounded"
            );
        }

        let pos = world.position(ball).unwrap();
        assert!(
            pos[0] < 0.3,
            "wall should block horizontal motion, x={}",
            pos[0]
        );
        assert!(
            pos[1] < 8.0,
            "zero friction: body slides down while pressed against the wall"
        );
        assert!(
            phys.touching(ball).contains(&wall),
            "expected an active side contact with the wall"
        );
    }

    #[test]
    fn ecs_velocity_xz_is_applied_every_sync() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [20.0, 0.1, 20.0]);
        // Wall in the +x path: face at x = 1.9, spanning the ball's height.
        let wall = spawn_static(&mut world, [2.0, 0.6, 0.0], [0.1, 0.5, 5.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        // Let it land and settle first.
        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }

        // Zero friction + zero damping means a linvel applied once persists forever,
        // so unobstructed motion cannot distinguish "reapplied every sync" from
        // "applied once". The wall contact zeroes vx between syncs; only per-sync
        // reapplication keeps the ball pressed against it and makes x motion resume
        // the moment the wall disappears.
        world.set_velocity(ball, [2.0, 0.0, 1.0]);
        for _ in 0..60 {
            tick(&mut phys, &mut world);
        }
        let pos = world.position(ball).unwrap();
        assert!(
            (pos[0] - 1.65).abs() < 0.05,
            "ball must be pinned at the wall face, x={}",
            pos[0]
        );
        assert!(
            (pos[2] - 1.0).abs() < 0.05,
            "z is unobstructed and must track ECS velocity, z={}",
            pos[2]
        );
        assert!(
            phys.touching(ball).contains(&wall),
            "reapplied vx must keep the wall contact alive"
        );

        deactivate(&mut world, wall);
        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }
        let pos = world.position(ball).unwrap();
        assert!(
            (pos[0] - 2.65).abs() < 0.1,
            "x motion must resume after wall removal (velocity reapplied, not one-shot), x={}",
            pos[0]
        );
        assert!(
            (pos[2] - 1.5).abs() < 0.05,
            "z should track ECS velocity, got {}",
            pos[2]
        );
    }

    #[test]
    fn zero_ecs_velocity_y_preserves_gravity_accumulation() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let ball = spawn_dynamic(&mut world, [0.0, 50.0, 0.0], 0.25);
        // velocity.y == 0.0 must NOT reset Rapier's vertical velocity each sync.
        world.set_velocity(ball, [0.0, 0.0, 0.0]);

        let mut ys = vec![50.0f32];
        for _ in 0..10 {
            tick(&mut phys, &mut world);
            ys.push(world.position(ball).unwrap()[1]);
        }
        let first_drop = ys[0] - ys[1];
        let last_drop = ys[9] - ys[10];
        assert!(first_drop > 0.0, "body must fall under gravity");
        assert!(
            last_drop > first_drop * 2.0,
            "fall speed must keep accumulating across syncs (first {first_drop}, last {last_drop})"
        );
    }

    #[test]
    fn nonzero_ecs_velocity_y_is_a_one_frame_jump_impulse() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }
        let rest_y = world.position(ball).unwrap()[1];

        world.set_velocity(ball, [0.0, 5.0, 0.0]);
        tick(&mut phys, &mut world);
        let y_after_impulse = world.position(ball).unwrap()[1];
        assert!(
            y_after_impulse > rest_y + 0.05,
            "jump impulse should move the body up"
        );

        // Clear the command; Rapier's accumulated upward velocity must persist.
        world.set_velocity(ball, [0.0, 0.0, 0.0]);
        tick(&mut phys, &mut world);
        let y_next = world.position(ball).unwrap()[1];
        assert!(
            y_next > y_after_impulse,
            "upward velocity must persist after the one-frame impulse"
        );
    }

    #[test]
    fn floor_height_at_reports_top_surface_and_misses_off_map() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        // Queries before the first step need the query pipeline built explicitly.
        phys.prepare_queries();

        let h = phys
            .floor_height_at(0.0, 0.0)
            .expect("expected a floor hit on the map");
        assert!(
            (h - 0.1).abs() < 1e-3,
            "top surface should be at y=0.1, got {h}"
        );
        assert_eq!(
            phys.floor_height_at(100.0, 100.0),
            None,
            "off-map query must miss"
        );
    }

    #[test]
    fn cast_ray_hits_floor_entity_and_misses_empty_space() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let (hit, toi) = phys
            .cast_ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0])
            .expect("expected a hit");
        assert_eq!(hit, floor);
        assert!(
            (toi - 4.9).abs() < 1e-3,
            "hit distance to floor top, got {toi}"
        );
        assert!(phys
            .cast_ray([50.0, 5.0, 50.0], [50.0, -1.0, 50.0])
            .is_none());
    }

    #[test]
    fn cast_ray_with_normal_returns_up_normal_on_floor_top() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let (normal, toi) = phys
            .cast_ray_with_normal([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 10.0)
            .expect("expected a hit");
        assert!(
            normal[1] > 0.99,
            "floor top normal must point up, got {normal:?}"
        );
        assert!(normal[0].abs() < 1e-3 && normal[2].abs() < 1e-3);
        assert!((toi - 4.9).abs() < 1e-3, "toi to floor top, got {toi}");
        assert!(phys
            .cast_ray_with_normal([0.0, 5.0, 0.0], [0.0, 1.0, 0.0], 10.0)
            .is_none());
    }

    #[test]
    fn deactivated_collider_removes_entity_from_queries() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        phys.prepare_queries();
        assert!(phys.floor_height_at(0.0, 0.0).is_some());

        deactivate(&mut world, floor);
        phys.sync_from_world(&world);
        phys.prepare_queries();
        assert_eq!(
            phys.floor_height_at(0.0, 0.0),
            None,
            "removed floor must no longer be hit"
        );
    }

    #[test]
    fn removed_dynamic_body_stops_participating() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        // Settle onto the floor so there is a real contact to lose.
        for _ in 0..60 {
            tick(&mut phys, &mut world);
        }
        assert!(
            phys.touching(ball).contains(&floor),
            "settled ball must be touching the floor"
        );
        let pos_at_removal = world.position(ball).unwrap();

        deactivate(&mut world, ball);
        // remove_entity does not clear the touching map; the stale contact list
        // survives until the next step's rebuild_touching (current contract).
        phys.sync_from_world(&world);
        assert!(
            phys.touching(ball).contains(&floor),
            "touching is stale between removal and the next step"
        );
        phys.step(DT);
        phys.sync_to_world(&mut world);
        assert!(
            phys.touching(ball).is_empty(),
            "next step must clear the removed body's contacts"
        );

        for _ in 0..10 {
            tick(&mut phys, &mut world);
        }
        assert_eq!(
            world.position(ball).unwrap(),
            pos_at_removal,
            "removed body must no longer be simulated or synced back"
        );
    }

    #[test]
    fn sync_to_world_dirties_moving_dynamic_but_not_static_floor() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        phys.sync_from_world(&world);
        phys.step(DT);
        world.clear_dirty();
        phys.sync_to_world(&mut world);

        assert!(
            world.dirty_flags(ball).contains(DirtyFlags::TRANSFORM),
            "falling body must be marked TRANSFORM-dirty"
        );
        assert!(
            world.dirty_flags(floor).is_empty(),
            "unmoved static floor must stay clean"
        );

        // Resting dynamics are dirtied too: sync_to_world marks every non-fixed
        // body TRANSFORM unconditionally, each tick, position change or not (see
        // physics.spec.md — known over-dirtying tradeoff). Pinned so a switch to
        // change-detection shows up as an explicit contract change.
        // TODO: if sync_to_world ever compares positions before dirtying, flip
        // this assertion to is_empty() and update the spec.
        for _ in 0..120 {
            tick(&mut phys, &mut world);
        }
        world.clear_dirty();
        tick(&mut phys, &mut world);
        assert!(
            world.dirty_flags(ball).contains(DirtyFlags::TRANSFORM),
            "resting dynamic is still dirtied every tick (current contract)"
        );
        assert!(
            world.dirty_flags(floor).is_empty(),
            "static floor must never be dirtied"
        );
    }

    #[test]
    fn cast_collider_reports_wall_normal_and_misses_open_space() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        // Wall face at x = 1.9, tall/wide enough that the swept cuboid hits it square.
        spawn_static(&mut world, [2.0, 1.0, 0.0], [0.1, 1.0, 1.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 1.0, 0.0], 0.25);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let n = phys
            .cast_collider(ball, &world, [1.0, 0.0, 0.0], 5.0)
            .expect("sweep toward the wall must hit");
        // normal1 is the hit surface's outward normal: opposes the sweep direction.
        assert!(
            n[0] < -0.99,
            "wall face normal must point back at the caster, got {n:?}"
        );
        assert!(
            n[1].abs() < 1e-3 && n[2].abs() < 1e-3,
            "axis-aligned face, got {n:?}"
        );

        assert!(
            phys.cast_collider(ball, &world, [-1.0, 0.0, 0.0], 5.0)
                .is_none(),
            "sweep away from the wall must miss"
        );
    }

    #[test]
    fn sensor_collider_neither_blocks_nor_touches() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        // Sensor volume spanning y in [0.5, 1.5], directly in the fall path.
        let zone = world.create_entity();
        world.set_position(zone, [0.0, 1.0, 0.0]);
        world.set_collider(
            zone,
            ColliderConfig {
                active: true,
                sensor: true,
                half_width: 0.5,
                half_height: 0.5,
                half_depth: 0.5,
            },
        );
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        for _ in 0..120 {
            tick(&mut phys, &mut world);
            assert!(
                !phys.touching(ball).contains(&zone),
                "sensors produce intersections, never contacts"
            );
        }

        let y = world.position(ball).unwrap()[1];
        assert!(
            (y - 0.35).abs() < 0.05,
            "ball must fall through the sensor to the floor, got y={y}"
        );
        assert!(phys.touching(ball).contains(&floor));

        // Sensor bodies are fixed: sync_to_world neither moves nor dirties them.
        assert_eq!(world.position(zone), Some([0.0, 1.0, 0.0]));
        world.clear_dirty();
        tick(&mut phys, &mut world);
        assert!(
            world.dirty_flags(zone).is_empty(),
            "fixed sensor body must stay clean"
        );
    }

    #[test]
    fn overlapping_dynamic_bodies_generate_no_contacts() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        // Overlapping by 0.3 in x, free-falling together. collision_groups
        // (GROUP_2 -> GROUP_1) filters agent-agent pairs in the broadphase;
        // separation is the engine's job, not the physics world's.
        let a = spawn_dynamic(&mut world, [0.0, 5.0, 0.0], 0.25);
        let b = spawn_dynamic(&mut world, [0.2, 5.0, 0.0], 0.25);

        for _ in 0..20 {
            tick(&mut phys, &mut world);
            assert!(
                phys.touching(a).is_empty(),
                "dynamic-dynamic pairs must never contact"
            );
            assert!(
                phys.touching(b).is_empty(),
                "dynamic-dynamic pairs must never contact"
            );
        }
        let pa = world.position(a).unwrap();
        let pb = world.position(b).unwrap();
        assert!(
            pa[0].abs() < 1e-4 && (pb[0] - 0.2).abs() < 1e-4,
            "no depenetration push in x"
        );
        assert!(
            (pa[1] - pb[1]).abs() < 1e-4,
            "both fall identically, undisturbed"
        );
    }

    #[test]
    fn velocity_y_threshold_splits_preserve_vs_override() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let ball = spawn_dynamic(&mut world, [0.0, 50.0, 0.0], 0.25);

        // Accumulate fall speed: ~4.9 m/s down after 30 ticks (~0.08 drop/tick).
        world.set_velocity(ball, [0.0, 0.0, 0.0]);
        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }
        let y0 = world.position(ball).unwrap()[1];

        // |vy| <= 0.01 behaves like vy == 0: Rapier's accumulated Y is preserved.
        world.set_velocity(ball, [0.0, 0.005, 0.0]);
        tick(&mut phys, &mut world);
        let y1 = world.position(ball).unwrap()[1];
        assert!(
            y0 - y1 > 0.05,
            "sub-threshold vy must not reset accumulated fall speed, drop {}",
            y0 - y1
        );

        // |vy| > 0.01 overrides: fall speed collapses to ~vy for that frame.
        world.set_velocity(ball, [0.0, 0.02, 0.0]);
        tick(&mut phys, &mut world);
        let y2 = world.position(ball).unwrap()[1];
        assert!(
            (y1 - y2).abs() < 0.01,
            "above-threshold vy must override Rapier's Y, drop {}",
            y1 - y2
        );
    }

    /// KNOWN GAP (pinned, not endorsed): World::destroy_entity drops the entity
    /// from ECS iteration, so sync_from_world never sees it again and never calls
    /// remove_entity — the Rapier body leaks and keeps answering queries.
    /// Deactivating the collider before destroying is the required teardown path
    /// (see deactivated_collider_removes_entity_from_queries). If this test starts
    /// failing, the leak was fixed: flip the assertion and update physics.spec.md.
    #[test]
    fn destroy_entity_without_deactivation_leaks_rapier_body() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        phys.prepare_queries();
        assert!(phys.floor_height_at(0.0, 0.0).is_some());

        world.destroy_entity(floor);
        phys.sync_from_world(&world);
        phys.prepare_queries();
        assert!(
            phys.floor_height_at(0.0, 0.0).is_some(),
            "leaked Rapier body still answers queries after destroy_entity"
        );
    }

    #[test]
    fn grounded_cache_serves_stale_value_between_recasts() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        // Settle through tick 12 — a recast tick (GROUNDED_STRIDE = 4) that caches
        // grounded = true for the resting ball.
        for _ in 1..=12 {
            tick(&mut phys, &mut world);
        }
        assert_eq!(
            world.is_grounded(ball),
            Some(true),
            "ball must be settled and grounded"
        );

        // Remove the floor: ticks 13-15 serve the stale cached value; the tick-16
        // recast finally observes the missing floor. This staleness (up to
        // GROUNDED_STRIDE - 1 ticks) is the accepted cost of the ray-cast cache.
        deactivate(&mut world, floor);
        for i in 13..=15 {
            tick(&mut phys, &mut world);
            assert_eq!(
                world.is_grounded(ball),
                Some(true),
                "cached grounded is served between recasts (tick {i})"
            );
        }
        tick(&mut phys, &mut world);
        assert_eq!(
            world.is_grounded(ball),
            Some(false),
            "recast tick must see the missing floor"
        );
    }
}
