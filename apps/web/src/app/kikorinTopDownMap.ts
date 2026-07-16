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
  // Floor spans x/z in [-20, 20].
  floor(0, -0.5, 0, 20, 0.5, 20),

  // Perimeter — keeps the player/monsters from wandering off the floor edge.
  wall(0, WALL_Y, -19.5, 20, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(0, WALL_Y, 19.5, 20, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(-19.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 20),
  wall(19.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 20),

  // Vertical partitions at x=-5 and x=5, separating the west/east columns
  // from the center column. Each of these runs only ever covered z in
  // [-15,-3] or [3,15] (z in [-3,3] — the hub doorway — was never walled),
  // and each now gets its own doorway too, so the corner room on either end
  // connects to its neighboring edge room instead of being sealed off.
  ...splitPartition('z', -5, -9, 6),
  ...splitPartition('z', -5, 9, 6),
  ...splitPartition('z', 5, -9, 6),
  ...splitPartition('z', 5, 9, 6),

  // Horizontal partitions at z=-5 and z=5, same doorway-gap pattern along x.
  // The hub's own doorway to each of these runs (x in [-3, 3]) is already
  // open — these two runs only ever covered x in [-15,-3] and [3,15] to
  // begin with, so there was never a wall to remove there.
  ...splitPartition('x', -5, -9, 6),
  ...splitPartition('x', -5, 9, 6),
  ...splitPartition('x', 5, -9, 6),
  ...splitPartition('x', 5, 9, 6),
];
