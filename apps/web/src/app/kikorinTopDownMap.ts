import type { TerrainBlockInput } from '@kikorin/adapter';

// A small top-down "pacman style" maze: one flat floor plus wall segments
// forming a 3x3 grid of rooms (corners, edges, and a center hub), each
// adjacent pair of rooms connected by its own doorway gap, inside a
// perimeter wall. Same TerrainBlockInput shape kikorinMap.ts (the 3D game)
// already uses — this game reuses load_map and the 3D navmesh entirely
// unmodified; see kikorinTopDown.ts's module doc for why (gravity: 0 + a
// perfectly flat floor is what makes "no jumping" happen, not a new code
// path).
//
// Every wall is `walkable: false` — required, not optional: load_map spawns
// every block (including walls) as a floor-tagged static body, so without
// this the navmesh would place walkable nodes on top of the maze walls,
// letting monsters path across them instead of through the doorways.
const floor = (x: number, y: number, z: number, hw: number, hh: number, hd: number): TerrainBlockInput =>
  ({ x, y, z, hw, hh, hd, kind: 'floor' });
const wall = (x: number, y: number, z: number, hw: number, hh: number, hd: number): TerrainBlockInput =>
  ({ x, y, z, hw, hh, hd, kind: 'wall', walkable: false });

// Floor top sits at y=0; walls rest on it (their own half-height above 0).
const WALL_HALF_HEIGHT = 1.0;
const WALL_HALF_THICKNESS = 0.5;
const WALL_Y = WALL_HALF_HEIGHT;

// Half-width of every doorway gap cut into a partition run.
const DOORWAY_HALF_WIDTH = 1.5;

/**
 * A straight partition run of full length `2 * runHalfLength`, centered at
 * `runCenter` along its long axis and at `fixedCoord` along its thin axis,
 * split into two wall pieces with a `DOORWAY_HALF_WIDTH`-wide gap at its
 * middle — the doorway connecting the two rooms this run separates.
 * `axis: 'z'` is a vertical run (thin in x, long in z, e.g. the x=-5
 * partition); `axis: 'x'` is a horizontal run (thin in z, long in x).
 */
function splitPartition(
  axis: 'x' | 'z',
  fixedCoord: number,
  runCenter: number,
  runHalfLength: number,
): TerrainBlockInput[] {
  const pieceHalfLength = (runHalfLength - DOORWAY_HALF_WIDTH) / 2;
  const nearCenter = runCenter - runHalfLength + pieceHalfLength;
  const farCenter = runCenter + runHalfLength - pieceHalfLength;
  return axis === 'z'
    ? [
        wall(fixedCoord, WALL_Y, nearCenter, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, pieceHalfLength),
        wall(fixedCoord, WALL_Y, farCenter, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, pieceHalfLength),
      ]
    : [
        wall(nearCenter, WALL_Y, fixedCoord, pieceHalfLength, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
        wall(farCenter, WALL_Y, fixedCoord, pieceHalfLength, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
      ];
}

export const KIKORIN_TOPDOWN_MAP: TerrainBlockInput[] = [
  // Floor spans x/z in [-30, 30] — a 5x5 district grid: open center hall,
  // ringed by rooms of varying size, every neighbor pair connected by its
  // own doorway.
  floor(0, -0.5, 0, 30, 0.5, 30),

  // Perimeter.
  wall(0, WALL_Y, -29.5, 30, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(0, WALL_Y, 29.5, 30, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(-29.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 30),
  wall(29.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 30),

  // Inner ring at ±7 around the center hall (hall spans ±7), a doorway in
  // the middle of each side.
  ...splitPartition('z', -7, 0, 7),
  ...splitPartition('z', 7, 0, 7),
  ...splitPartition('x', -7, 0, 7),
  ...splitPartition('x', 7, 0, 7),

  // Middle band partitions at ±18: rooms between the inner ring and the
  // outer edge, staggered doorways so routes wind rather than run straight.
  ...splitPartition('z', -18, -12, 8),
  ...splitPartition('z', -18, 12, 8),
  ...splitPartition('z', 18, -12, 8),
  ...splitPartition('z', 18, 12, 8),
  ...splitPartition('x', -18, -12, 8),
  ...splitPartition('x', -18, 12, 8),
  ...splitPartition('x', 18, -12, 8),
  ...splitPartition('x', 18, 12, 8),

  // Cross-corridor spokes connecting inner ring to middle band, each with
  // its own doorway, offset from the ring doorways for winding paths.
  ...splitPartition('z', -12, 0, 4),
  ...splitPartition('z', 12, 0, 4),
  ...splitPartition('x', -12, 0, 4),
  ...splitPartition('x', 12, 0, 4),

  // A few freestanding pillars in the center hall for cover (and for the
  // pathing to weave around).
  wall(-3.5, WALL_Y, -3.5, 0.8, WALL_HALF_HEIGHT, 0.8),
  wall(3.5, WALL_Y, -3.5, 0.8, WALL_HALF_HEIGHT, 0.8),
  wall(-3.5, WALL_Y, 3.5, 0.8, WALL_HALF_HEIGHT, 0.8),
  wall(3.5, WALL_Y, 3.5, 0.8, WALL_HALF_HEIGHT, 0.8),
];
