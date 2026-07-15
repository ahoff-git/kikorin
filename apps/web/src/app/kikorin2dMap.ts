/**
 * A simple side-view 2D level: a ground strip plus a few floating platforms.
 * X is horizontal, Y is vertical (matches crates/physics's 2D convention —
 * gravity pulls on Y). Z is a fixed small thickness, purely cosmetic (2D
 * physics never reads it) so blocks read as flat slabs from the orthographic
 * camera. Spawned directly via spawn_floor_entity — this game doesn't use
 * load_map at all, but does build a 2D navmesh over this geometry afterward
 * (engine.build_navmesh_2d; see kikorin2d.ts) for monster pathfinding.
 */
export interface Block2D {
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** Defaults to true. Mirrors 3D's `MapBlock.walkable` — set false for hazards/decoration that should stay solid but never be pathed onto. Not used by KIKORIN_2D_MAP today; exists so the plumbing is real and testable. */
  walkable?: boolean;
}

const Z_DEPTH_HALF = 0.5;

export const KIKORIN_2D_MAP: Block2D[] = [
  // Ground strip.
  { x: 0, y: -0.5, hw: 20, hh: 0.5 },
  // Floating platforms, stepped up to the right.
  { x: -8, y: 1.5, hw: 2, hh: 0.3 },
  { x: -2, y: 3, hw: 2, hh: 0.3 },
  { x: 4, y: 4.5, hw: 2, hh: 0.3 },
  { x: 9, y: 2.5, hw: 2, hh: 0.3 },
];

export const BLOCK_Z_HALF_DEPTH = Z_DEPTH_HALF;
