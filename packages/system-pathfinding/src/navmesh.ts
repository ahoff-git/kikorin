import { findHighestFloorTopAtPosition } from '@kikorin/system-physics'
import type { CoreWorld } from '@kikorin/ecs'

// Grid cell size in world units. Ramps rise 0.5 units per cell at this spacing,
// which stays below the step-up threshold and avoids triggering jump impulses.
export const NAVMESH_CELL_SIZE = 1.5

// Bounds cover all terrain features (ramps, stairs, keeps) plus approach corridors.
// Monsters outside this area fall back to direct pursuit — flat ground needs no A*.
export const NAVMESH_MIN_X = -80
export const NAVMESH_MAX_X = 80
export const NAVMESH_MIN_Z = -80
export const NAVMESH_MAX_Z = 80

// A neighbour is reachable by walking if the height gain is at most this.
// Stair steps are 1 unit high, ramp cells ~0.5 units — both fit within 1.3.
const MAX_STEP_UP = 1.3
// Height differences above this within MAX_STEP_UP require a jump impulse.
const JUMP_HEIGHT_THRESHOLD = 0.5
// Drops below this are one-way ledge-drop edges (gravity handles descent).
const MIN_LEDGE_DROP = 1.4
// Drops larger than this are impassable (too far to fall safely).
const MAX_LEDGE_DROP = 12.0

export type NavNode = {
  readonly index: number
  readonly col: number
  readonly row: number
  readonly x: number
  readonly z: number
  readonly y: number        // floor surface world Y
  readonly walkable: boolean
}

export type NavEdge = {
  readonly toIndex: number
  readonly cost: number
  readonly requiresJump: boolean  // step-up: monster needs an upward impulse
  readonly isLedgeDrop: boolean   // one-way descent: gravity handles it
}

const CARDINAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
]
const DIAGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]

export class NavMesh {
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
  readonly minX: number
  readonly minZ: number
  readonly nodes: readonly NavNode[]
  readonly edges: readonly (readonly NavEdge[])[]

  constructor(world: CoreWorld, floorEids: ArrayLike<number>) {
    this.cellSize = NAVMESH_CELL_SIZE
    this.minX = NAVMESH_MIN_X
    this.minZ = NAVMESH_MIN_Z
    this.cols = Math.round((NAVMESH_MAX_X - NAVMESH_MIN_X) / NAVMESH_CELL_SIZE) + 1
    this.rows = Math.round((NAVMESH_MAX_Z - NAVMESH_MIN_Z) / NAVMESH_CELL_SIZE) + 1

    const nodes: NavNode[] = new Array(this.cols * this.rows)
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const index = row * this.cols + col
        const x = this.minX + col * this.cellSize
        const z = this.minZ + row * this.cellSize
        const floorY = findHighestFloorTopAtPosition(world, floorEids, x, z)
        nodes[index] = { index, col, row, x, z, y: floorY ?? 0, walkable: floorY !== null }
      }
    }
    this.nodes = nodes

    const edges: NavEdge[][] = Array.from({ length: nodes.length }, () => [])
    const diagCost = this.cellSize * Math.SQRT2

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const fromIdx = row * this.cols + col
        const fromNode = nodes[fromIdx]!
        if (!fromNode.walkable) continue

        for (const [dc, dr] of CARDINAL_DIRS) {
          tryAddEdge(nodes, edges, fromNode, fromIdx, col + dc, row + dr, this.cols, this.rows, this.cellSize)
        }
        for (const [dc, dr] of DIAGONAL_DIRS) {
          tryAddEdge(nodes, edges, fromNode, fromIdx, col + dc, row + dr, this.cols, this.rows, diagCost)
        }
      }
    }
    this.edges = edges
  }

  /** Grid index for the cell whose centre is nearest to (worldX, worldZ). */
  nodeIndexAt(worldX: number, worldZ: number): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.round((worldX - this.minX) / this.cellSize)))
    const row = Math.max(0, Math.min(this.rows - 1, Math.round((worldZ - this.minZ) / this.cellSize)))
    return row * this.cols + col
  }

  /**
   * Nearest walkable node index to (worldX, worldZ).
   * Expands outward up to 4 cells. Returns null if nothing found.
   */
  nearestWalkable(worldX: number, worldZ: number): number | null {
    const center = this.nodeIndexAt(worldX, worldZ)
    if (this.nodes[center]!.walkable) return center

    const { col: cc, row: cr } = this.nodes[center]!
    for (let radius = 1; radius <= 4; radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue
          const c = cc + dc
          const r = cr + dr
          if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue
          const idx = r * this.cols + c
          if (this.nodes[idx]!.walkable) return idx
        }
      }
    }
    return null
  }

  /**
   * Nearest walkable node whose floor Y is within `heightTol` of `targetY`.
   *
   * This is needed because `findHighestFloorTopAtPosition` returns the TOP surface
   * at any XZ point — cells directly under an elevated platform return y=4 even when
   * the entity is standing on the ground (y=0) below. Passing the entity's actual
   * floor Y lets us find the correct same-level starting node even if that means
   * expanding the search beyond the platform footprint.
   */
  nearestWalkableAtHeight(
    worldX: number,
    worldZ: number,
    targetY: number,
    heightTol = 1.5,
  ): number | null {
    const center = this.nodeIndexAt(worldX, worldZ)
    const { col: cc, row: cr } = this.nodes[center]!

    // Expand ring by ring; stop at the first ring that yields a height-matched node so
    // we always return the closest XZ match at the correct level.
    for (let radius = 0; radius <= 15; radius++) {
      let bestIdx: number | null = null
      let bestDistSq = Infinity

      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (radius > 0 && Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue
          const c = cc + dc
          const r = cr + dr
          if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue
          const idx = r * this.cols + c
          const node = this.nodes[idx]!
          if (!node.walkable) continue
          if (Math.abs(node.y - targetY) > heightTol) continue
          const distSq = dc * dc + dr * dr
          if (distSq < bestDistSq) {
            bestDistSq = distSq
            bestIdx = idx
          }
        }
      }

      if (bestIdx !== null) return bestIdx
    }
    return null
  }

  /** True when (worldX, worldZ) lies within the navmesh grid boundary. */
  inBounds(worldX: number, worldZ: number): boolean {
    return (
      worldX >= this.minX &&
      worldX <= this.minX + (this.cols - 1) * this.cellSize &&
      worldZ >= this.minZ &&
      worldZ <= this.minZ + (this.rows - 1) * this.cellSize
    )
  }
}

function tryAddEdge(
  nodes: NavNode[],
  edges: NavEdge[][],
  fromNode: NavNode,
  fromIdx: number,
  nc: number,
  nr: number,
  cols: number,
  rows: number,
  baseCost: number,
) {
  if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return
  const toIdx = nr * cols + nc
  const toNode = nodes[toIdx]!
  if (!toNode.walkable) return

  const heightDiff = toNode.y - fromNode.y  // positive = going up

  if (heightDiff > MAX_STEP_UP) return        // too steep to climb
  if (heightDiff < -MAX_LEDGE_DROP) return    // drop too large

  const isLedgeDrop = heightDiff < -MIN_LEDGE_DROP
  const requiresJump = !isLedgeDrop && heightDiff > JUMP_HEIGHT_THRESHOLD

  // Uphill costs a little more to prefer ramps over stairs when both exist.
  const heightCost = requiresJump
    ? heightDiff * 0.5
    : isLedgeDrop
      ? Math.abs(heightDiff) * 0.1
      : Math.max(0, heightDiff) * 0.3

  edges[fromIdx]!.push({ toIndex: toIdx, cost: baseCost + heightCost, requiresJump, isLedgeDrop })
}
