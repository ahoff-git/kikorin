//! Physics backend selection: `PhysicsWorld` is a thin dispatcher over two
//! interchangeable backends — `two_d::PhysicsWorld2D` (Rapier2D) and
//! `three_d::PhysicsWorld3D` (Rapier3D) — chosen once at construction via
//! `Dimension` and fixed for the physics world's lifetime. Every method below
//! just forwards to whichever backend is active; see `two_d`/`three_d` for
//! the actual simulation logic and physics.spec.md for the shared contract
//! both backends honor identically (grounded caching, zero-friction dynamics,
//! collision groups, sensor semantics, the velocity-Y-threshold split).

mod three_d;
mod two_d;

use ecs::{EntityId, World};

/// Which physics backend a `PhysicsWorld` uses — set once at construction,
/// never changed for that instance's lifetime. `ThreeD` is X/Z-ground-plane,
/// Y-up (unchanged, original behavior). `TwoD` is X-horizontal, Y-up, with no
/// meaningful third axis; see `two_d`'s module docs for exactly how the
/// `[f32; 3]` API surface maps onto a 2D simulation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dimension {
    TwoD,
    ThreeD,
}

enum Backend {
    TwoD(two_d::PhysicsWorld2D),
    ThreeD(three_d::PhysicsWorld3D),
}

/// Wraps a 2D or 3D Rapier physics world (per `Dimension`, fixed at
/// construction) behind one identical API — callers never branch on which
/// backend is active.
pub struct PhysicsWorld {
    backend: Backend,
}

impl PhysicsWorld {
    pub fn new(gravity: f32, dimension: Dimension) -> Self {
        let backend = match dimension {
            Dimension::TwoD => Backend::TwoD(two_d::PhysicsWorld2D::new(gravity)),
            Dimension::ThreeD => Backend::ThreeD(three_d::PhysicsWorld3D::new(gravity)),
        };
        Self { backend }
    }

    pub fn dimension(&self) -> Dimension {
        match &self.backend {
            Backend::TwoD(_) => Dimension::TwoD,
            Backend::ThreeD(_) => Dimension::ThreeD,
        }
    }

    /// Sync entity positions/colliders from ECS world into Rapier before stepping.
    pub fn sync_from_world(&mut self, world: &World) {
        match &mut self.backend {
            Backend::TwoD(w) => w.sync_from_world(world),
            Backend::ThreeD(w) => w.sync_from_world(world),
        }
    }

    /// Step the physics simulation by dt_secs.
    pub fn step(&mut self, dt_secs: f32) {
        match &mut self.backend {
            Backend::TwoD(w) => w.step(dt_secs),
            Backend::ThreeD(w) => w.step(dt_secs),
        }
    }

    /// Write physics results (position, grounded) back into the ECS world.
    pub fn sync_to_world(&mut self, world: &mut World) {
        match &mut self.backend {
            Backend::TwoD(w) => w.sync_to_world(world),
            Backend::ThreeD(w) => w.sync_to_world(world),
        }
    }

    /// Rebuild the spatial query pipeline without stepping the simulation.
    pub fn prepare_queries(&mut self) {
        match &mut self.backend {
            Backend::TwoD(w) => w.prepare_queries(),
            Backend::ThreeD(w) => w.prepare_queries(),
        }
    }

    /// Ray cast downward to find the floor surface Y. In `TwoD`, `z` is
    /// accepted only for signature parity and ignored (see `two_d`'s docs).
    pub fn floor_height_at(&self, x: f32, z: f32) -> Option<f32> {
        match &self.backend {
            Backend::TwoD(w) => w.floor_height_at(x, z),
            Backend::ThreeD(w) => w.floor_height_at(x, z),
        }
    }

    /// Returns the list of entity IDs currently in contact with `entity`.
    pub fn touching(&self, entity: EntityId) -> &[EntityId] {
        match &self.backend {
            Backend::TwoD(w) => w.touching(entity),
            Backend::ThreeD(w) => w.touching(entity),
        }
    }

    /// Move a dynamic body directly in Rapier. In `TwoD`, `position[2]` is ignored.
    pub fn teleport_entity(&mut self, id: EntityId, position: [f32; 3]) {
        match &mut self.backend {
            Backend::TwoD(w) => w.teleport_entity(id, position),
            Backend::ThreeD(w) => w.teleport_entity(id, position),
        }
    }

    /// Swept collider cast used for wall detection. In `TwoD`, `direction[2]`
    /// is ignored and the returned normal's third component is always 0.0.
    pub fn cast_collider(
        &self,
        entity: EntityId,
        world: &World,
        direction: [f32; 3],
        max_toi: f32,
    ) -> Option<[f32; 3]> {
        match &self.backend {
            Backend::TwoD(w) => w.cast_collider(entity, world, direction, max_toi),
            Backend::ThreeD(w) => w.cast_collider(entity, world, direction, max_toi),
        }
    }

    /// Ray cast against fixed (terrain) colliders only; returns (surface_normal, toi).
    pub fn cast_ray_with_normal(
        &self,
        from: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
    ) -> Option<([f32; 3], f32)> {
        match &self.backend {
            Backend::TwoD(w) => w.cast_ray_with_normal(from, dir, max_toi),
            Backend::ThreeD(w) => w.cast_ray_with_normal(from, dir, max_toi),
        }
    }

    /// Simple ray cast; returns (entity_id, time_of_impact) for the first hit.
    pub fn cast_ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<(EntityId, f32)> {
        match &self.backend {
            Backend::TwoD(w) => w.cast_ray(from, to),
            Backend::ThreeD(w) => w.cast_ray(from, to),
        }
    }

    pub fn remove_entity(&mut self, id: EntityId) {
        match &mut self.backend {
            Backend::TwoD(w) => w.remove_entity(id),
            Backend::ThreeD(w) => w.remove_entity(id),
        }
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

    // ---------------------------------------------------------------------
    // 3D backend — unchanged behavior, moved from the pre-dispatcher module.
    // ---------------------------------------------------------------------

    /// Sensors are fixed bodies, so terrain-only query predicates would admit
    /// them without explicit sensor exclusion. Standing inside a trigger volume
    /// must not mask the floor beneath it.
    #[test]
    fn grounded_survives_standing_inside_a_sensor_volume() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.36, 0.0], 0.25);
        // Trigger zone fully enclosing the ball.
        spawn_sensor(&mut world, [0.0, 1.0, 0.0], [2.0, 2.0, 2.0]);

        // Enough ticks to settle onto the floor and pass several recast strides.
        for _ in 0..(4_usize * 6) {
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.36, 0.0], 0.25);
        for _ in 0..(4_usize * 6) {
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

    #[test]
    fn sphere_resolves_floor_collision_within_grounded_stride() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);

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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        let mut prev_y = 3.0f32;
        let mut landed = false;
        let mut contacted = false;
        for i in 1..=240 {
            tick(&mut phys, &mut world);
            let y = world.position(ball).unwrap()[1];
            contacted = contacted || !phys.touching(ball).is_empty();
            if !contacted {
                assert!(
                    y <= prev_y + 1e-4,
                    "airborne y must not increase: {prev_y} -> {y} at tick {i}"
                );
            }
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let wall = spawn_static(&mut world, [1.0, 5.0, 0.0], [0.5, 5.0, 0.5]);
        let ball = spawn_dynamic(&mut world, [0.2, 8.0, 0.0], 0.25);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [20.0, 0.1, 20.0]);
        let wall = spawn_static(&mut world, [2.0, 0.6, 0.0], [0.1, 0.5, 5.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }

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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let ball = spawn_dynamic(&mut world, [0.0, 50.0, 0.0], 0.25);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        for _ in 0..60 {
            tick(&mut phys, &mut world);
        }
        assert!(
            phys.touching(ball).contains(&floor),
            "settled ball must be touching the floor"
        );
        let pos_at_removal = world.position(ball).unwrap();

        deactivate(&mut world, ball);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        phys.sync_from_world(&world);
        phys.step(DT);
        world.clear_dirty();
        phys.sync_to_world(&mut world);

        assert!(
            world.dirty_flags(ball).contains(ecs::DirtyFlags::TRANSFORM),
            "falling body must be marked TRANSFORM-dirty"
        );
        assert!(
            world.dirty_flags(floor).is_empty(),
            "unmoved static floor must stay clean"
        );

        for _ in 0..120 {
            tick(&mut phys, &mut world);
        }
        world.clear_dirty();
        tick(&mut phys, &mut world);
        assert!(
            world.dirty_flags(ball).contains(ecs::DirtyFlags::TRANSFORM),
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        spawn_static(&mut world, [2.0, 1.0, 0.0], [0.1, 1.0, 1.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 1.0, 0.0], 0.25);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let n = phys
            .cast_collider(ball, &world, [1.0, 0.0, 0.0], 5.0)
            .expect("sweep toward the wall must hit");
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
        let ball = spawn_dynamic(&mut world, [0.0, 50.0, 0.0], 0.25);

        world.set_velocity(ball, [0.0, 0.0, 0.0]);
        for _ in 0..30 {
            tick(&mut phys, &mut world);
        }
        let y0 = world.position(ball).unwrap()[1];

        world.set_velocity(ball, [0.0, 0.005, 0.0]);
        tick(&mut phys, &mut world);
        let y1 = world.position(ball).unwrap()[1];
        assert!(
            y0 - y1 > 0.05,
            "sub-threshold vy must not reset accumulated fall speed, drop {}",
            y0 - y1
        );

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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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
        let mut phys = PhysicsWorld::new(-9.81, Dimension::ThreeD);
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

    // ---------------------------------------------------------------------
    // 2D backend — same physical contract, one dimension down. Z is unused
    // by physics throughout (see two_d.rs's module docs).
    // ---------------------------------------------------------------------

    #[test]
    fn two_d_dynamic_body_falls_under_gravity_and_lands_grounded() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        assert_eq!(phys.dimension(), Dimension::TwoD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 3.0, 0.0], 0.25);

        let mut landed = false;
        for _ in 1..=240 {
            tick(&mut phys, &mut world);
            if world.is_grounded(ball) == Some(true) {
                landed = true;
                break;
            }
        }
        assert!(landed, "expected grounded=true within 240 ticks");
        let y = world.position(ball).unwrap()[1];
        assert!(
            (y - 0.35).abs() < 0.05,
            "resting y should be floor top + half_height, got {y}"
        );
    }

    #[test]
    fn two_d_wall_blocks_horizontal_motion_without_setting_grounded() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        let wall = spawn_static(&mut world, [1.0, 5.0, 0.0], [0.5, 5.0, 0.5]);
        let ball = spawn_dynamic(&mut world, [0.2, 8.0, 0.0], 0.25);
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
        assert!(pos[0] < 0.3, "wall should block horizontal motion, x={}", pos[0]);
        assert!(
            phys.touching(ball).contains(&wall),
            "expected an active side contact with the wall"
        );
    }

    #[test]
    fn two_d_floor_height_at_ignores_z_and_reports_top_surface() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        // z (second arg) is meaningless in 2D — passing two different values
        // for it must not change the result.
        let h1 = phys.floor_height_at(0.0, 0.0).expect("floor must be found");
        let h2 = phys.floor_height_at(0.0, 999.0).expect("z must be ignored");
        assert_eq!(h1, h2, "z must be ignored by the 2D backend");
        assert!((h1 - 0.1).abs() < 1e-3, "top surface should be at y=0.1, got {h1}");
        assert_eq!(
            phys.floor_height_at(100.0, 0.0),
            None,
            "off-map query must miss"
        );
    }

    #[test]
    fn two_d_cast_ray_hits_floor_and_z_survives_untouched_via_sync() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        // A dynamic body off to the side (so it can't shadow the ray, which
        // only reads x/y) given a non-zero z up front — physics must never
        // touch that z, even as x/y are simulated and synced back every tick.
        let ball = world.create_entity();
        world.set_position(ball, [5.0, 3.0, 42.0]);
        world.set_collider(
            ball,
            ColliderConfig { active: true, sensor: false, half_width: 0.25, half_height: 0.25, half_depth: 0.25 },
        );

        phys.sync_from_world(&world);
        phys.prepare_queries();
        let (hit, _toi) = phys
            .cast_ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0])
            .expect("expected a hit");
        assert_eq!(hit, floor);

        for _ in 0..60 {
            tick(&mut phys, &mut world);
        }
        assert_eq!(
            world.position(ball).unwrap()[2],
            42.0,
            "z must survive untouched across 2D physics ticks",
        );
    }

    #[test]
    fn two_d_cast_collider_reports_wall_normal_with_zero_z() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        spawn_static(&mut world, [2.0, 1.0, 0.0], [0.1, 1.0, 1.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 1.0, 0.0], 0.25);

        phys.sync_from_world(&world);
        phys.prepare_queries();

        let n = phys
            .cast_collider(ball, &world, [1.0, 0.0, 0.0], 5.0)
            .expect("sweep toward the wall must hit");
        assert!(n[0] < -0.99, "wall face normal must point back at the caster, got {n:?}");
        assert_eq!(n[2], 0.0, "2D normal must have zero z");

        assert!(
            phys.cast_collider(ball, &world, [-1.0, 0.0, 0.0], 5.0)
                .is_none(),
            "sweep away from the wall must miss"
        );
    }

    #[test]
    fn two_d_teleport_moves_body_ignoring_z() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        let ball = spawn_dynamic(&mut world, [0.0, 5.0, 7.0], 0.25);
        phys.sync_from_world(&world);

        phys.teleport_entity(ball, [3.0, 2.0, 999.0]);
        phys.step(DT);
        phys.sync_to_world(&mut world);

        let pos = world.position(ball).unwrap();
        assert!((pos[0] - 3.0).abs() < 0.1, "x must teleport, got {pos:?}");
        assert!((pos[1] - 2.0).abs() < 0.1, "y must teleport, got {pos:?}");
    }

    #[test]
    fn two_d_removed_dynamic_body_stops_participating() {
        let mut world = World::new(8);
        let mut phys = PhysicsWorld::new(-9.81, Dimension::TwoD);
        let floor = spawn_static(&mut world, [0.0, 0.0, 0.0], [10.0, 0.1, 10.0]);
        let ball = spawn_dynamic(&mut world, [0.0, 0.5, 0.0], 0.25);

        for _ in 0..60 {
            tick(&mut phys, &mut world);
        }
        assert!(phys.touching(ball).contains(&floor));

        deactivate(&mut world, ball);
        tick(&mut phys, &mut world);
        let pos_after_removal = world.position(ball).unwrap();
        for _ in 0..10 {
            tick(&mut phys, &mut world);
        }
        assert_eq!(
            world.position(ball).unwrap(),
            pos_after_removal,
            "removed body must no longer be simulated or synced back"
        );
    }
}
