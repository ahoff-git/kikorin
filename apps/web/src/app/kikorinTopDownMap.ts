import type { TerrainBlockInput } from '@kikorin/adapter';

// A small top-down "pacman style" maze: one flat floor plus wall segments
// forming a 3x3 grid of rooms connected by a doorway gap in the middle of
// each partition, inside a perimeter wall. Same TerrainBlockInput shape
// kikorinMap.ts (the 3D game) already uses — this game reuses load_map and
// the 3D navmesh entirely unmodified; see kikorinTopDown.ts's module doc for
// why (gravity: 0 + a perfectly flat floor is what makes "no jumping"
// happen, not a new code path).
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

export const KIKORIN_TOPDOWN_MAP: TerrainBlockInput[] = [
  // Floor spans x/z in [-20, 20].
  floor(0, -0.5, 0, 20, 0.5, 20),

  // Perimeter — keeps the player/monsters from wandering off the floor edge.
  wall(0, WALL_Y, -19.5, 20, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(0, WALL_Y, 19.5, 20, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(-19.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 20),
  wall(19.5, WALL_Y, 0, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 20),

  // Vertical partitions at x=-5 and x=5, each split around a doorway gap
  // spanning z in [-3, 3].
  wall(-5, WALL_Y, -9, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 6),
  wall(-5, WALL_Y, 9, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 6),
  wall(5, WALL_Y, -9, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 6),
  wall(5, WALL_Y, 9, WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, 6),

  // Horizontal partitions at z=-5 and z=5, same doorway-gap pattern along x.
  wall(-9, WALL_Y, -5, 6, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(9, WALL_Y, -5, 6, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(-9, WALL_Y, 5, 6, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
  wall(9, WALL_Y, 5, 6, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS),
];
