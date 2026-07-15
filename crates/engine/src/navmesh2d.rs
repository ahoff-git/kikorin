//! 2D navmesh construction — a side-view platformer analogue of `build_navmesh`
//! in `lib.rs`. Reuses `crates/pathfinding`'s `NavMesh` unchanged (nodes are
//! `(x, y, z=0)`; the crate's XZ-bucketed grid and 3-D heuristic degenerate
//! correctly with `z` pinned to a constant).
//!
//! Deliberately separate from `build_navmesh`: 3D rasterizes the X/Z ground
//! plane and keeps only the *first* (topmost) walkable surface per column,
//! which is correct for outdoor terrain but silently wrong for a 2D level
//! where a platform floats directly above a full-width ground strip — both
//! are independently walkable, not just whichever the raycast hits first.
//! This module rasterizes X only and records every stacked surface per
//! column, then connects them by *computed* reachability rather than a fixed
//! height-difference threshold: given the mover's actual walk speed, jump
//! speed, and jump count, `jump_reachable` solves real projectile motion for
//! each candidate gap. Nothing here is a hand-tuned constant — thresholds
//! that 3D hard-codes in `NavConfig` are derived per call from the scanned
//! geometry and the caller-supplied capability instead.

use crate::MAX_TERRAIN_LAYERS_PER_COLUMN;
use ecs::World;
use pathfinding::{NavMesh, NavMeshConfig};
use physics::PhysicsWorld;
use std::collections::HashSet;

/// Movement capability of whoever will traverse the mesh. Passed in
/// explicitly by the caller (see `Engine::build_navmesh_2d`) rather than read
/// from any engine-wide config — the same map can serve movers with
/// different capabilities without touching Rust, and a monster's real numbers
/// never drift out of sync with what the navmesh thinks it can do.
#[derive(Clone, Copy, Debug)]
pub struct MovementCapability2D {
    pub walk_speed: f32,
    /// Initial vertical velocity of a single jump impulse.
    pub jump_speed: f32,
    /// Jump budget between groundings (2 = double jump, 0 = can never leave the ground).
    pub max_jumps: u32,
}

impl MovementCapability2D {
    /// Max height gained if every jump is re-triggered exactly at the previous
    /// jump's apex (zero vertical velocity at that instant) — the most height
    /// physically obtainable from `max_jumps` identical impulses, since each
    /// jump always launches from zero vertical velocity and therefore
    /// contributes the same apex height `v²/(2g)`.
    fn max_height(&self, gravity_abs: f32) -> f32 {
        if self.max_jumps == 0 || gravity_abs <= 0.0 {
            return 0.0;
        }
        let apex = self.jump_speed * self.jump_speed / (2.0 * gravity_abs);
        apex * self.max_jumps as f32
    }

    /// Total time airborne when every jump is used to maximize height (rise
    /// through all `max_jumps` apexes, then fall from the cumulative peak).
    /// This is the *height-maximizing* strategy, not the *distance-maximizing*
    /// one — used only as the recursion bound in `jump_reachable`, not as a
    /// direct proxy for horizontal range (a mover trading height for distance
    /// covers more ground; see `jump_reachable`'s doc comment).
    fn max_air_time(&self, gravity_abs: f32) -> f32 {
        if self.max_jumps == 0 || gravity_abs <= 0.0 {
            return 0.0;
        }
        let rise_time = (self.jump_speed / gravity_abs) * self.max_jumps as f32;
        let fall_time = (2.0 * self.max_height(gravity_abs) / gravity_abs).sqrt();
        rise_time + fall_time
    }

    /// Upper bound on horizontal distance coverable by any jump strategy —
    /// used only to bound the candidate-edge search window, not as a
    /// per-gap feasibility check (that's `jump_reachable`).
    fn max_horizontal_reach(&self, gravity_abs: f32) -> f32 {
        self.walk_speed * self.max_air_time(gravity_abs)
    }
}

/// Solves real projectile motion for a single jump: launched at `(0,0)` with
/// horizontal speed `cap.walk_speed` and vertical speed `cap.jump_speed`
/// under `gravity_abs`, is `(dx, dy)` on the trajectory? Two roots exist for
/// `dy` below the apex (rising through it, then falling back through it) —
/// the larger root allows more horizontal travel, so it's checked first.
/// `launch_vy = 0` (no jump impulse at all — just walking off a ledge) is a
/// valid input and correctly reduces to a pure-gravity fall: the mover still
/// drifts horizontally at `walk_speed` for the whole fall.
fn ballistic_reachable(dx: f32, dy: f32, launch_vy: f32, walk_speed: f32, gravity_abs: f32) -> bool {
    if gravity_abs <= 0.0 {
        return dy <= 0.0 && dx.abs() <= 1e-6;
    }
    // dy = v0*t - 0.5*g*t^2  =>  0.5*g*t^2 - v0*t + dy = 0
    let discriminant = launch_vy * launch_vy - 2.0 * gravity_abs * dy;
    if discriminant < 0.0 {
        return false; // apex is below dy — unreachable regardless of timing
    }
    let sqrt_d = discriminant.sqrt();
    let t_rise = (launch_vy - sqrt_d) / gravity_abs;
    let t_fall = (launch_vy + sqrt_d) / gravity_abs;
    for &t in &[t_fall, t_rise] {
        if t > 0.0 && dx.abs() <= walk_speed * t {
            return true;
        }
    }
    false
}

fn single_jump_reachable(dx: f32, dy: f32, cap: &MovementCapability2D, gravity_abs: f32) -> bool {
    let launch_vy = if cap.max_jumps == 0 { 0.0 } else { cap.jump_speed };
    ballistic_reachable(dx, dy, launch_vy, cap.walk_speed, gravity_abs)
}

/// Whether a mover with `cap` can cross a gap of horizontal distance `dx` and
/// vertical delta `dy` (positive = up). Tries the direct single-jump solve
/// first; if `dy` exceeds what one jump can reach and more than one jump is
/// available, models "climb to the first jump's apex, then solve the
/// remaining (smaller) gap from there" — the same apex-chaining strategy
/// `MovementCapability2D::max_height` assumes. This is a sufficient-condition
/// heuristic, not an exhaustive optimal-control solve: it may reject some
/// gaps a cleverly-timed multi-jump could actually cross (e.g. trading height
/// for distance mid-arc), but it never claims a gap is reachable when it
/// isn't — the right bias for a navmesh, where a false "reachable" strands a
/// mover mid-air and a false "unreachable" just means a longer route.
fn jump_reachable(dx: f32, dy: f32, cap: &MovementCapability2D, gravity_abs: f32) -> bool {
    if single_jump_reachable(dx, dy, cap, gravity_abs) {
        return true;
    }
    if cap.max_jumps <= 1 || gravity_abs <= 0.0 {
        return false;
    }
    let apex_height = cap.jump_speed * cap.jump_speed / (2.0 * gravity_abs);
    let apex_time = cap.jump_speed / gravity_abs;
    let apex_dx = cap.walk_speed * apex_time;
    let remaining = MovementCapability2D { max_jumps: cap.max_jumps - 1, ..*cap };
    jump_reachable(dx - apex_dx.copysign(dx), dy - apex_height, &remaining, gravity_abs)
}

/// Sampling resolution for the column scan, derived from the smallest floor
/// half-width actually present in the level rather than a fixed `cell_size`
/// — a level built from tiny platforms samples finer, a level built from a
/// few huge slabs samples coarser. Clamped to a sane range so a pathological
/// input (a single hairline-thin block, or one enormous slab) can't produce
/// an unusably fine or coarse scan.
pub fn derive_scan_resolution(floor_half_widths: &[f32]) -> f32 {
    const MIN_RESOLUTION: f32 = 0.1;
    const MAX_RESOLUTION: f32 = 2.0;
    let smallest = floor_half_widths
        .iter()
        .copied()
        .filter(|w| *w > 0.0)
        .fold(f32::INFINITY, f32::min);
    if !smallest.is_finite() {
        return MAX_RESOLUTION;
    }
    (smallest * 0.5).clamp(MIN_RESOLUTION, MAX_RESOLUTION)
}

/// Every walkable surface height in a vertical column at `x`, ordered top to
/// bottom. Mirrors `lib.rs`'s 3D `walkable_height_at`, but collects every
/// layer instead of stopping at the first — see this module's doc comment
/// for why that distinction matters for a 2D level.
fn walkable_heights_at(
    world: &World,
    physics: &PhysicsWorld,
    non_walkable_terrain: &HashSet<u32>,
    x: f32,
    scan_top: f32,
    scan_bottom: f32,
) -> Vec<f32> {
    let mut heights = Vec::new();
    let mut from_y = scan_top;
    for _ in 0..MAX_TERRAIN_LAYERS_PER_COLUMN {
        let Some((eid, toi)) = physics.cast_ray([x, from_y, 0.0], [x, scan_bottom, 0.0]) else {
            break;
        };
        let hit_y = from_y - toi;
        if world.is_floor(eid) && !non_walkable_terrain.contains(&eid) {
            heights.push(hit_y);
        }
        let Some(pos) = world.position(eid) else { break };
        let Some(col) = world.collider(eid) else { break };
        from_y = pos[1] - col.half_height - 0.01;
        if from_y <= scan_bottom {
            break;
        }
    }
    heights
}

/// Builds a 2D navmesh from whatever floor-tagged entities are currently in
/// `world` (the same dynamic discovery `build_navmesh` uses for 3D — works
/// regardless of how the terrain was spawned, not coupled to any specific
/// level format). Returns `None` when there's no floor geometry to walk on.
///
/// `physics` must already have `sync_from_world`/`prepare_queries` called on
/// it (the caller's responsibility — see `Engine::build_navmesh_2d` — since
/// those are the same physics-sync steps every other query in this engine
/// needs, not something specific to navmesh building).
pub fn build(
    world: &World,
    physics: &PhysicsWorld,
    non_walkable_terrain: &HashSet<u32>,
    cap: &MovementCapability2D,
    gravity: f32,
) -> Option<NavMesh> {
    let gravity_abs = gravity.abs();

    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut half_widths = Vec::new();
    for id in world.entities() {
        if !world.is_floor(id) {
            continue;
        }
        let Some([x, y, _]) = world.position(id) else { continue };
        let Some(col) = world.collider(id) else { continue };
        if !col.active {
            continue;
        }
        min_x = min_x.min(x - col.half_width);
        max_x = max_x.max(x + col.half_width);
        min_y = min_y.min(y - col.half_height);
        max_y = max_y.max(y + col.half_height);
        half_widths.push(col.half_width);
    }
    if !min_x.is_finite() {
        return None; // no floor geometry loaded — nothing to walk on
    }

    let resolution = derive_scan_resolution(&half_widths);
    let walk_step_tolerance = resolution * 0.5;
    let ledge_drop_threshold = resolution;

    let scan_top = max_y + 1.0;
    let scan_bottom = min_y - 1.0;
    let cols = (((max_x - min_x) / resolution).ceil() as usize).max(1);

    let mut mesh = NavMesh::new(NavMeshConfig { cell_size: resolution });
    // Every node found, in scan order (left to right, top to bottom within a
    // column) — kept alongside the mesh's own node list so edge-building can
    // do windowed x-proximity search without re-querying the mesh.
    let mut samples: Vec<(f32, f32, pathfinding::NodeId)> = Vec::new();

    for col in 0..=cols {
        let x = min_x + col as f32 * resolution;
        for y in walkable_heights_at(world, physics, non_walkable_terrain, x, scan_top, scan_bottom) {
            let id = mesh.add_node(x, y, 0.0);
            samples.push((x, y, id));
        }
    }

    let max_reach = cap.max_horizontal_reach(gravity_abs).max(resolution * 2.0);

    // Windowed O(n * k) edge search: samples are x-sorted by construction, so
    // only nodes within max_reach of each other can possibly connect.
    for i in 0..samples.len() {
        let (xi, yi, id_i) = samples[i];
        for j in (i + 1)..samples.len() {
            let (xj, yj, id_j) = samples[j];
            let dx = xj - xi;
            if dx > max_reach {
                break; // samples is x-sorted — nothing further out is closer
            }
            let dy = yj - yi;

            let same_layer_adjacent = dx <= resolution * 1.5 && dy.abs() <= walk_step_tolerance;
            if same_layer_adjacent {
                mesh.add_edge(id_i, id_j, dx, false, false);
                mesh.add_edge(id_j, id_i, dx, false, false);
                continue;
            }

            // Ascending i->j: needs a real jump. Descending i->j: a drop, free
            // if within tolerance, otherwise still needs `jump_reachable`'s
            // (dy<=0) branch to bound how far a fall can carry horizontally.
            if jump_reachable(dx, dy, cap, gravity_abs) {
                let is_drop = dy < -ledge_drop_threshold;
                mesh.add_edge(id_i, id_j, dx + dy.max(0.0), !is_drop, is_drop);
            }
            if jump_reachable(dx, -dy, cap, gravity_abs) {
                let is_drop = -dy < -ledge_drop_threshold;
                mesh.add_edge(id_j, id_i, dx + (-dy).max(0.0), !is_drop, is_drop);
            }
        }
    }

    Some(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: f32 = 20.0; // gravity_abs used throughout — matches crate::GRAVITY's magnitude

    fn cap(walk_speed: f32, jump_speed: f32, max_jumps: u32) -> MovementCapability2D {
        MovementCapability2D { walk_speed, jump_speed, max_jumps }
    }

    #[test]
    fn flat_gap_within_single_jump_range_is_reachable() {
        let c = cap(6.0, 9.0, 1);
        // Max single-jump air time at dy=0: t = 2*v0/g = 0.9s: range = 5.4.
        assert!(jump_reachable(4.0, 0.0, &c, G));
    }

    #[test]
    fn flat_gap_beyond_single_jump_range_is_unreachable() {
        let c = cap(6.0, 9.0, 1);
        assert!(!jump_reachable(50.0, 0.0, &c, G));
    }

    #[test]
    fn step_exactly_at_single_jump_apex_height_is_reachable_with_zero_horizontal_distance() {
        let c = cap(6.0, 9.0, 1);
        let apex = c.jump_speed * c.jump_speed / (2.0 * G);
        assert!(jump_reachable(0.0, apex, &c, G));
        assert!(!jump_reachable(0.0, apex + 0.5, &c, G), "half a unit above the apex must be out of reach");
    }

    #[test]
    fn step_above_single_jump_apex_needs_a_second_jump() {
        let c1 = cap(6.0, 9.0, 1);
        let c2 = cap(6.0, 9.0, 2);
        let apex1 = c1.jump_speed * c1.jump_speed / (2.0 * G);
        let target_height = apex1 * 1.5;
        assert!(!jump_reachable(0.0, target_height, &c1, G), "one jump alone must not reach 1.5x its own apex");
        assert!(jump_reachable(0.0, target_height, &c2, G), "a second jump should close the remaining height");
    }

    #[test]
    fn gap_too_far_even_with_max_jumps_is_unreachable() {
        let c = cap(6.0, 9.0, 3);
        assert!(!jump_reachable(500.0, 0.0, &c, G));
    }

    #[test]
    fn drop_of_arbitrary_depth_is_always_reachable_horizontally_bounded_by_fall_time() {
        let c = cap(6.0, 9.0, 1);
        // Falling 20 units takes sqrt(2*20/20) = ~1.41s -> ~8.5 horizontal units.
        assert!(jump_reachable(8.0, -20.0, &c, G));
        assert!(!jump_reachable(100.0, -20.0, &c, G));
    }

    #[test]
    fn zero_jump_capability_can_still_fall_off_a_ledge_but_never_gains_height() {
        let c = cap(6.0, 0.0, 0);
        // No jump impulse at all still falls under gravity, drifting
        // horizontally at walk_speed for the fall's duration — walking off a
        // ledge doesn't require a jump.
        // Fall time from 1 unit under gravity 20 is sqrt(2*1/20) ~= 0.316s,
        // giving ~1.9 units of horizontal drift at walk_speed 6 — well clear of 1.0.
        assert!(jump_reachable(1.0, -1.0, &c, G), "a short drop with modest horizontal drift needs no jump");
        // But it can never clear a flat gap (would have to leave the ground
        // with no vertical impulse) or gain any height at all.
        assert!(!jump_reachable(1.0, 0.0, &c, G), "flat gap-crossing requires leaving the ground");
        assert!(!jump_reachable(0.0, 0.5, &c, G), "gaining height requires a jump impulse");
    }

    #[test]
    fn scan_resolution_scales_with_smallest_block() {
        let fine = derive_scan_resolution(&[0.2, 5.0, 10.0]);
        let coarse = derive_scan_resolution(&[5.0, 10.0, 20.0]);
        assert!(fine < coarse, "the smallest block present should drive resolution finer");
    }

    #[test]
    fn scan_resolution_is_clamped_for_pathological_input() {
        assert!(derive_scan_resolution(&[0.0001]) >= 0.1);
        assert!(derive_scan_resolution(&[1000.0]) <= 2.0);
        assert_eq!(derive_scan_resolution(&[]), 2.0, "no floors at all should fall back to the coarse clamp");
    }

    // --- build(): the actual bug this module exists to avoid ---

    use ecs::{ColliderConfig, EntityId};
    use physics::Dimension;

    fn spawn_floor(world: &mut World, x: f32, y: f32, hw: f32, hh: f32) -> EntityId {
        let id = world.create_entity();
        world.set_position(id, [x, y, 0.0]);
        world.set_floor(id, true);
        world.set_collider(
            id,
            ColliderConfig { active: true, sensor: false, half_width: hw, half_height: hh, half_depth: 0.5 },
        );
        id
    }

    #[test]
    fn platform_floating_above_ground_produces_nodes_for_both_layers() {
        // A full-width ground strip plus a platform floating directly above
        // part of it — exactly KIKORIN_2D_MAP's shape. A single-surface-per-
        // column scan (3D's approach) would make the ground under the
        // platform invisible to the mesh.
        let mut world = World::new(8);
        spawn_floor(&mut world, 0.0, -0.5, 20.0, 0.5); // ground: y top = 0.0
        spawn_floor(&mut world, 0.0, 1.5, 2.0, 0.3); // platform: y top = 1.8, spans x in [-2, 2]

        let mut physics = PhysicsWorld::new(-20.0, Dimension::TwoD);
        physics.sync_from_world(&world);
        physics.prepare_queries();

        let cap = MovementCapability2D { walk_speed: 6.0, jump_speed: 9.0, max_jumps: 2 };
        let mesh = build(&world, &physics, &HashSet::new(), &cap, -20.0).expect("floor geometry exists");

        // Directly under the platform (x=0), both the platform top (~1.8) and
        // the ground top (~0.0) must be independently reachable — proving
        // the ground layer survived being scanned underneath the platform.
        let ground_under_platform = mesh
            .find_path(pathfinding::PathRequest {
                start: [0.0, 0.0, 0.0],
                goal: [0.0, 0.0, 0.0],
                route_seed: None,
                can_jump: true,
                start_y: Some(0.0),
            })
            .expect("a node near ground level under the platform must exist");
        assert!(
            ground_under_platform[0].y < 1.0,
            "expected a ground-layer node under the platform, got y={}",
            ground_under_platform[0].y
        );

        let platform_top = mesh
            .find_path(pathfinding::PathRequest {
                start: [0.0, 1.8, 0.0],
                goal: [0.0, 1.8, 0.0],
                route_seed: None,
                can_jump: true,
                start_y: Some(1.8),
            })
            .expect("a node on top of the platform must exist");
        assert!(
            platform_top[0].y > 1.0,
            "expected a platform-layer node, got y={}",
            platform_top[0].y
        );
    }

    #[test]
    fn non_walkable_terrain_is_excluded_from_the_scan() {
        let mut world = World::new(8);
        let ground = spawn_floor(&mut world, 0.0, -0.5, 20.0, 0.5);

        let mut physics = PhysicsWorld::new(-20.0, Dimension::TwoD);
        physics.sync_from_world(&world);
        physics.prepare_queries();

        let cap = MovementCapability2D { walk_speed: 6.0, jump_speed: 9.0, max_jumps: 1 };
        let mut excluded = HashSet::new();
        excluded.insert(ground);
        // Bounds still come from raw floor geometry (matching build_navmesh's
        // own AABB computation, which likewise doesn't consult
        // non_walkable_terrain) — walkability is a property of columns, not
        // of the scan window — so `build` still returns `Some`, just with no
        // walkable nodes anywhere in it.
        let mesh = build(&world, &physics, &excluded, &cap, -20.0).expect("bounds exist even with no walkable floor");
        let path = mesh.find_path(pathfinding::PathRequest {
            start: [0.0, 0.0, 0.0],
            goal: [0.0, 0.0, 0.0],
            route_seed: None,
            can_jump: true,
            start_y: Some(0.0),
        });
        assert!(path.is_none(), "excluding the only floor entity must leave no walkable nodes");
    }
}
