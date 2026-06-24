import type { NavMesh, NavEdge } from './navmesh'

export type Waypoint = {
  readonly x: number
  readonly y: number
  readonly z: number
  /** True when the edge leading TO this waypoint requires a jump impulse (stair step-up). */
  readonly requiresJump: boolean
  /** True when the edge leading TO this waypoint is a one-way ledge drop. */
  readonly isLedgeDrop: boolean
}

// ── Min binary heap ─────────────────────────────────────────────────────────
// Typed arrays keep memory contiguous and avoid GC pressure on hot paths.
class MinHeap {
  private keys: Float64Array
  private vals: Int32Array
  private size = 0

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
  }

  get length() { return this.size }

  push(key: number, val: number): void {
    // Grow if needed
    if (this.size >= this.keys.length) {
      const newCap = this.keys.length * 2
      const newKeys = new Float64Array(newCap)
      const newVals = new Int32Array(newCap)
      newKeys.set(this.keys)
      newVals.set(this.vals)
      this.keys = newKeys
      this.vals = newVals
    }
    let i = this.size++
    this.keys[i] = key
    this.vals[i] = val
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent]! <= this.keys[i]!) break
      this._swap(i, parent)
      i = parent
    }
  }

  popVal(): number {
    const val = this.vals[0]!
    const last = --this.size
    this.keys[0] = this.keys[last]!
    this.vals[0] = this.vals[last]!
    let i = 0
    while (true) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let min = i
      if (l < this.size && this.keys[l]! < this.keys[min]!) min = l
      if (r < this.size && this.keys[r]! < this.keys[min]!) min = r
      if (min === i) break
      this._swap(i, min)
      i = min
    }
    return val
  }

  private _swap(a: number, b: number) {
    const tk = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = tk
    const tv = this.vals[a]!; this.vals[a] = this.vals[b]!; this.vals[b] = tv
  }
}

// ── A* ──────────────────────────────────────────────────────────────────────

function heuristic(navmesh: NavMesh, a: number, b: number): number {
  const na = navmesh.nodes[a]!
  const nb = navmesh.nodes[b]!
  const dx = na.x - nb.x
  const dz = na.z - nb.z
  return Math.sqrt(dx * dx + dz * dz)
}

/**
 * Find a smoothed path from world (startX, startZ) to (goalX, goalZ).
 * Returns null when no path exists, or an empty array when start === goal.
 * Waypoints include height info and flags for jumps and ledge drops so the
 * monster steering code can issue impulses at the right moment.
 *
 * Pass `startY` (floor Y of the monster) to get height-aware start-node matching.
 * This prevents monsters standing on the ground beneath an elevated platform from
 * anchoring to the platform surface (y=4) as their start node.
 * The goal always uses the highest walkable surface at the target XZ (nearestWalkable),
 * which is correct for routing toward a player regardless of their current Y.
 */
export function findPath(
  navmesh: NavMesh,
  startX: number,
  startZ: number,
  goalX: number,
  goalZ: number,
  startY?: number,
): Waypoint[] | null {
  const startIdx = startY !== undefined
    ? (navmesh.nearestWalkableAtHeight(startX, startZ, startY) ?? navmesh.nearestWalkable(startX, startZ))
    : navmesh.nearestWalkable(startX, startZ)
  const goalIdx = navmesh.nearestWalkable(goalX, goalZ)
  if (startIdx === null || goalIdx === null) return null
  if (startIdx === goalIdx) return []

  const n = navmesh.nodes.length
  const gCost = new Float32Array(n).fill(Infinity)
  const parent = new Int32Array(n).fill(-1)
  // Pack requiresJump (bit 0) and isLedgeDrop (bit 1) into a byte per node.
  const edgeFlags = new Uint8Array(n)
  const visited = new Uint8Array(n)

  const heap = new MinHeap(512)
  gCost[startIdx] = 0
  heap.push(heuristic(navmesh, startIdx, goalIdx), startIdx)

  while (heap.length > 0) {
    const current = heap.popVal()
    if (current === goalIdx) {
      return reconstructPath(navmesh, parent, edgeFlags, goalIdx)
    }
    if (visited[current]) continue
    visited[current] = 1

    for (const edge of navmesh.edges[current]!) {
      const { toIndex, cost, requiresJump, isLedgeDrop } = edge
      if (visited[toIndex]) continue
      const g = gCost[current]! + cost
      if (g < gCost[toIndex]!) {
        gCost[toIndex] = g
        parent[toIndex] = current
        edgeFlags[toIndex] = (requiresJump ? 1 : 0) | (isLedgeDrop ? 2 : 0)
        heap.push(g + heuristic(navmesh, toIndex, goalIdx), toIndex)
      }
    }
  }

  return null
}

// ── Path reconstruction & simplification ────────────────────────────────────

function reconstructPath(
  navmesh: NavMesh,
  parent: Int32Array,
  edgeFlags: Uint8Array,
  goalIdx: number,
): Waypoint[] {
  // Walk backwards from goal to start.
  const rawIndices: number[] = []
  let cur = goalIdx
  while (cur !== -1) {
    rawIndices.push(cur)
    cur = parent[cur]!
  }
  rawIndices.reverse()

  // Keep only waypoints where the path changes direction, plus special edges
  // (jump, ledge drop) and the endpoints. This produces a compact waypoint list
  // that drives the monster toward prominent corners and transitions only.
  const waypoints: Waypoint[] = []
  for (let i = 0; i < rawIndices.length; i++) {
    const idx = rawIndices[i]!
    const node = navmesh.nodes[idx]!
    const flags = edgeFlags[idx]!
    const requiresJump = (flags & 1) !== 0
    const isLedgeDrop = (flags & 2) !== 0

    const isEndpoint = i === 0 || i === rawIndices.length - 1
    const isSpecial = requiresJump || isLedgeDrop
    const isTurn = !isEndpoint && isDirectionChange(
      navmesh,
      rawIndices[i - 1]!,
      idx,
      rawIndices[i + 1]!,
    )

    if (isEndpoint || isSpecial || isTurn) {
      waypoints.push({ x: node.x, y: node.y, z: node.z, requiresJump, isLedgeDrop })
    }
  }

  return waypoints
}

function isDirectionChange(
  navmesh: NavMesh,
  prevIdx: number,
  curIdx: number,
  nextIdx: number,
): boolean {
  const prev = navmesh.nodes[prevIdx]!
  const cur = navmesh.nodes[curIdx]!
  const next = navmesh.nodes[nextIdx]!
  const dx1 = cur.x - prev.x
  const dz1 = cur.z - prev.z
  const dx2 = next.x - cur.x
  const dz2 = next.z - cur.z
  const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1)
  const len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2)
  if (len1 === 0 || len2 === 0) return false
  const dot = (dx1 * dx2 + dz1 * dz2) / (len1 * len2)
  return dot < 0.92  // ~23° turn threshold
}
