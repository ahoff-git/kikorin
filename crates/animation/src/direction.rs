//! Yaw → 8-way sheet row. Mirrors the (now-removed) TypeScript quantizer so the
//! engine and the sprite agree on which row is shown — the boundary sends the
//! resolved direction, TS never recomputes it.
//!
//! Index 0 is South (facing the camera in a top-down view); indices advance
//! clockwise-from-south through the diagonals. Engine yaw is 0 facing +Z (south)
//! and increases toward +X (east), so the row index runs opposite yaw.

use std::f32::consts::TAU;

pub const DIRECTION_COUNT: u8 = 8;

/// Quantize an engine yaw (radians) to a direction row 0..=7.
pub fn direction_from_yaw(yaw: f32) -> u8 {
    let sector = TAU / DIRECTION_COUNT as f32; // 45°
    // -yaw because the row runs opposite yaw; rem_euclid keeps it non-negative.
    let idx = (-yaw / sector).round() as i32;
    idx.rem_euclid(DIRECTION_COUNT as i32) as u8
}

/// Billboard variant: the row an entity presents to a camera at `camera_azimuth`
/// (its heading around world Y). Collapses to `direction_from_yaw` at azimuth 0.
pub fn direction_from_yaw_relative(yaw: f32, camera_azimuth: f32) -> u8 {
    direction_from_yaw(yaw - camera_azimuth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn cardinals_and_diagonals() {
        assert_eq!(direction_from_yaw(0.0), 0); // S
        assert_eq!(direction_from_yaw(-PI / 4.0), 1); // SW
        assert_eq!(direction_from_yaw(-PI / 2.0), 2); // W
        assert_eq!(direction_from_yaw(-3.0 * PI / 4.0), 3); // NW
        assert_eq!(direction_from_yaw(PI), 4); // N
        assert_eq!(direction_from_yaw(3.0 * PI / 4.0), 5); // NE
        assert_eq!(direction_from_yaw(PI / 2.0), 6); // E
        assert_eq!(direction_from_yaw(PI / 4.0), 7); // SE
    }

    #[test]
    fn wraps_negative_and_over_two_pi() {
        assert_eq!(direction_from_yaw(-PI), 4); // -π == π == N
        assert_eq!(direction_from_yaw(2.0 * PI), 0); // full turn == S
    }

    #[test]
    fn camera_relative_rotates_the_row() {
        assert_eq!(direction_from_yaw_relative(PI / 2.0, 0.0), direction_from_yaw(PI / 2.0));
        assert_eq!(direction_from_yaw_relative(0.0, PI / 2.0), 2); // faces S, camera a quarter-turn away → W
    }
}
