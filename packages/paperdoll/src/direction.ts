// The 8 facing rows every sprite sheet is authored in. Order is fixed and
// load-bearing: sheet row N *is* Direction N, and the layer-order matrix indexes
// by it. See specs/paperdoll for the convention.
//
// Index 0 is South (facing the camera in a top-down/2d view); indices advance
// clockwise-from-south through the diagonals. The engine's yaw is 0 when an
// entity faces +Z (screen-down / south) and increases turning toward +X (east),
// so direction index runs *opposite* yaw — captured once, here, and nowhere
// else in the codebase.

export const DIRECTION_COUNT = 8;

export type Direction = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** S, SW, W, NW, N, NE, E, SE — human labels for the row order, for debug/tests. */
export const DIRECTION_LABELS = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"] as const;

const SECTOR = (Math.PI * 2) / DIRECTION_COUNT; // 45°

/**
 * Quantize an engine yaw (radians) to a sheet row. Rounds to the nearest of 8
 * sectors, so a yaw exactly between two rows snaps to the lower-numbered one.
 */
export function directionFromYaw(yaw: number): Direction {
  // -yaw because direction runs opposite yaw (see module doc). +DIRECTION_COUNT
  // before the final mod so negative yaws don't produce a negative index.
  const idx = ((Math.round(-yaw / SECTOR) % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
  return idx as Direction;
}

/**
 * Billboard variant: the row shown depends on where the camera stands, not just
 * where the entity faces. Passing the camera's azimuth (its heading around the
 * world Y axis) yields the direction the entity presents *to that camera*, so
 * orbiting a standing entity walks through all 8 rows. `cameraAzimuth === 0`
 * collapses to `directionFromYaw`.
 */
export function directionFromYawRelativeToCamera(yaw: number, cameraAzimuth: number): Direction {
  return directionFromYaw(yaw - cameraAzimuth);
}
