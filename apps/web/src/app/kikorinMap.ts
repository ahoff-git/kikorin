import type { TerrainBlockInput } from '@kikorin/adapter';

// The kikorin castle map. Game data, not engine data: the engine receives these
// blocks via load_map(), spawns a static body per block, and derives the navmesh
// bounds from this geometry. `kind` only affects mesh styling on our side.
const platform = (x: number, y: number, z: number, hw: number, hh: number, hd: number): TerrainBlockInput =>
  ({ x, y, z, hw, hh, hd, kind: 'platform' });
const floor = (x: number, y: number, z: number, hw: number, hh: number, hd: number): TerrainBlockInput =>
  ({ x, y, z, hw, hh, hd, kind: 'floor' });
const wall = (x: number, y: number, z: number, hw: number, hh: number, hd: number): TerrainBlockInput =>
  ({ x, y, z, hw, hh, hd, kind: 'wall', walkable: false });

export const KIKORIN_MAP: TerrainBlockInput[] = [
  // MAIN FLOOR
  floor(0.0, -1.0, -5.0, 60.0, 1.0, 75.0),
  // EAST WING — ramp steps
  platform(11.5, 0.5, 12.0, 1.5, 0.5, 5.0),
  platform(14.5, 1.0, 12.0, 1.5, 1.0, 5.0),
  platform(17.5, 1.5, 12.0, 1.5, 1.5, 5.0),
  platform(20.5, 2.0, 12.0, 1.5, 2.0, 5.0),
  platform(31.0, 3.7, -6.0, 9.0, 0.3, 22.0),
  platform(42.0, 3.7, 0.0, 2.0, 0.3, 3.0),
  platform(47.0, 3.7, 0.0, 3.0, 0.3, 4.0),
  // WEST WING — staircase
  platform(-12.0, 0.5, 5.0, 1.5, 0.5, 2.5),
  platform(-15.0, 1.0, 5.0, 1.5, 1.0, 2.5),
  platform(-18.0, 1.5, 5.0, 1.5, 1.5, 2.5),
  platform(-21.0, 2.0, 5.0, 1.5, 2.0, 2.5),
  platform(-31.0, 3.7, -6.0, 9.0, 0.3, 22.0),
  // NORTH BRIDGE
  platform(0.0, 3.7, -26.0, 22.0, 0.3, 5.0),
  // NORTH KEEP
  platform(0.0, 3.7, -37.0, 8.0, 0.3, 6.0),
  platform(0.0, 4.5, -44.0, 4.0, 0.5, 1.5),
  platform(0.0, 5.5, -47.0, 4.0, 0.5, 1.5),
  platform(0.0, 6.5, -50.0, 4.0, 0.5, 1.5),
  platform(0.0, 7.5, -53.0, 4.0, 0.5, 1.5),
  // UPPER KEEP
  platform(0.0, 7.7, -58.0, 5.0, 0.3, 4.0),
  wall(0.0, 9.5, -62.0, 5.0, 1.5, 0.4),
  // SOUTH TERRACE
  platform(0.0, 0.5, 28.5, 8.0, 0.5, 1.5),
  platform(0.0, 1.0, 25.5, 8.0, 1.0, 1.5),
  platform(0.0, 1.5, 22.5, 8.0, 1.5, 1.5),
  platform(0.0, 2.7, 17.0, 12.0, 0.3, 5.0),
  // WALLS & PARAPETS
  wall(-5.0, 1.5, -7.0, 0.5, 1.5, 3.0),
  wall(5.0, 1.5, -7.0, 0.5, 1.5, 3.0),
  wall(40.0, 4.8, -6.0, 0.3, 0.8, 22.0),
  wall(-40.0, 4.8, -6.0, 0.3, 0.8, 22.0),
  wall(-11.0, 4.8, -31.0, 11.0, 0.8, 0.4),
  wall(11.0, 4.8, -31.0, 11.0, 0.8, 0.4),
];
