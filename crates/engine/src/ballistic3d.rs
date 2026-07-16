//! Tier-4 ballistic solving in 3D — the projectile-motion math behind
//! edge discovery (see specs/pathfinding, ADR 0011). Pure math only; the
//! physics probes (arc clearance, sprint runway) live with the caller,
//! which owns the PhysicsWorld.
//!
//! Same model as navmesh2d's solver: gravity couples only to Y, so a 3D
//! gap reduces to the 1D problem over lateral distance sqrt(dx²+dz²) —
//! what 3D adds is *obstruction*, not new math, handled by the caller's
//! arc sweep.

/// Flight time for a jump covering lateral distance `dist_xz` and vertical
/// delta `dy` (positive = up), launched with vertical speed `launch_vy` at
/// horizontal speed ≤ `speed`. Prefers the falling root (more lateral
/// range). None = unreachable.
pub(crate) fn flight_time(dist_xz: f32, dy: f32, launch_vy: f32, speed: f32, gravity_abs: f32) -> Option<f32> {
    if gravity_abs <= 0.0 || speed <= 0.0 {
        return None;
    }
    let discriminant = launch_vy * launch_vy - 2.0 * gravity_abs * dy;
    if discriminant < 0.0 {
        return None;
    }
    let sqrt_d = discriminant.sqrt();
    let t_fall = (launch_vy + sqrt_d) / gravity_abs;
    let t_rise = (launch_vy - sqrt_d) / gravity_abs;
    for &t in &[t_fall, t_rise] {
        if t > 0.0 && dist_xz <= speed * t {
            return Some(t);
        }
    }
    None
}

/// Sample points along the arc from `from` to `to` for obstruction probing.
/// Horizontal motion is linear in time (constant lateral velocity covering
/// the gap in exactly `t_total`); vertical follows the launch parabola.
pub(crate) fn arc_points(
    from: [f32; 3],
    to: [f32; 3],
    launch_vy: f32,
    t_total: f32,
    gravity_abs: f32,
    samples: usize,
) -> Vec<[f32; 3]> {
    let mut points = Vec::with_capacity(samples + 1);
    for i in 0..=samples {
        let s = i as f32 / samples as f32;
        let t = s * t_total;
        points.push([
            from[0] + (to[0] - from[0]) * s,
            from[1] + launch_vy * t - 0.5 * gravity_abs * t * t,
            from[2] + (to[2] - from[2]) * s,
        ]);
    }
    points
}

/// Max lateral reach of any jump at `speed` — bounds the candidate-pair
/// search window (same derivation as navmesh2d's max_horizontal_reach).
pub(crate) fn max_reach(launch_vy: f32, speed: f32, gravity_abs: f32) -> f32 {
    if gravity_abs <= 0.0 {
        return 0.0;
    }
    let rise = launch_vy / gravity_abs;
    let apex = launch_vy * launch_vy / (2.0 * gravity_abs);
    let fall = (2.0 * apex / gravity_abs).sqrt();
    speed * (rise + fall)
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: f32 = 20.0;

    #[test]
    fn flight_time_matches_navmesh2d_reachability_semantics() {
        // Flat gap within range: navmesh2d says reachable at 4.0 with
        // walk 6 / jump 9 (range 5.4) — flight_time must agree.
        assert!(flight_time(4.0, 0.0, 9.0, 6.0, G).is_some());
        assert!(flight_time(50.0, 0.0, 9.0, 6.0, G).is_none());
        // Apex-height step, zero lateral.
        let apex = 9.0 * 9.0 / (2.0 * G);
        assert!(flight_time(0.0, apex, 9.0, 6.0, G).is_some());
        assert!(flight_time(0.0, apex + 0.5, 9.0, 6.0, G).is_none());
    }

    #[test]
    fn sprint_speed_extends_lateral_reach() {
        // A gap beyond walk range but within sprint range — the whole
        // point of the sprint variant.
        let walk = 6.0;
        let sprint = 12.0;
        let gap = 8.0;
        assert!(flight_time(gap, 0.0, 9.0, walk, G).is_none());
        assert!(flight_time(gap, 0.0, 9.0, sprint, G).is_some());
        assert!(max_reach(9.0, sprint, G) > max_reach(9.0, walk, G));
    }

    #[test]
    fn arc_points_start_and_end_on_the_endpoints() {
        let from = [0.0, 0.0, 0.0];
        let to = [2.4, 1.0, 1.8];
        let dist_xz = (2.4f32 * 2.4 + 1.8 * 1.8).sqrt();
        let t = flight_time(dist_xz, 1.0, 9.0, 6.0, G).expect("reachable");
        // Endpoint consistency requires the launch vy that lands exactly at
        // dy after t: vy = (dy + 0.5*g*t²)/t.
        let vy = (1.0 + 0.5 * G * t * t) / t;
        let pts = arc_points(from, to, vy, t, G, 8);
        assert_eq!(pts.len(), 9);
        let first = pts[0];
        let last = pts[8];
        for i in 0..3 {
            assert!((first[i] - from[i]).abs() < 1e-4, "arc must start at from");
            assert!((last[i] - to[i]).abs() < 1e-3, "arc must end at to, axis {i}");
        }
        // The arc's midpoint must rise above the straight line — it's a
        // parabola, not a chord (this is what the clearance sweep probes).
        let mid = pts[4];
        let chord_mid_y = (from[1] + to[1]) / 2.0;
        assert!(mid[1] > chord_mid_y, "parabolic arc must clear the chord");
    }

    #[test]
    fn diagonal_gap_uses_true_lateral_distance() {
        // 3D check: a 3-4-5 diagonal gap behaves exactly like a straight
        // 5.0 gap — bearing must not matter to reachability.
        let straight = flight_time(5.0, 0.0, 9.0, 6.0, G);
        let dist_diag = (3.0f32 * 3.0 + 4.0 * 4.0).sqrt();
        let diagonal = flight_time(dist_diag, 0.0, 9.0, 6.0, G);
        assert_eq!(straight.is_some(), diagonal.is_some());
    }
}
