import { describe, it, expect, beforeEach, vi } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/system-physics', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    castRayFromTo: vi.fn(() => null),
    findHighestFloorTopAtPosition: vi.fn(() => null),
  }
})

vi.mock('@kikorin/system-rendering', () => ({
  lookCameraAt: vi.fn(() => true),
  readCameraPosition: vi.fn(() => true),
  setCameraPosition: vi.fn(() => true),
}))

const { cameraFollowSystem, resetCameraTarget, setCameraFollowTarget } = await import('../cameraFollow')
const { castRayFromTo } = await import('@kikorin/system-physics')
const { setCameraPosition } = await import('@kikorin/system-rendering')

const MAX_ENTITIES = 100
const DEFAULT_DT = 1 / 60

function makeTestWorld(): CoreWorld {
  const n = MAX_ENTITIES
  const config = {
    components: {
      Position: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Velocity: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Rotation: { yaw: new Float32Array(n), pitch: new Float32Array(n), roll: new Float32Array(n) },
      FaceVelocity: new Int8Array(n),
      NetFlags: new Int8Array(n),
      Collider: { Active: new Int8Array(n), Sensor: new Int8Array(n), HalfWidth: new Float32Array(n), HalfHeight: new Float32Array(n), HalfDepth: new Float32Array(n) },
      Gravity: { Grounded: new Int8Array(n) },
      Floor: new Int8Array(n),
      RenderDirtyFlags: { DirtyTransformFlag: new Int8Array(n), DirtyCount: 0, DirtyList: new Int32Array(n), DirtyFlagSet: new Int8Array(n) },
      CollisionDirtyFlags: { DirtyTransformFlag: new Int8Array(n), ConfigDirtyFlag: new Int8Array(n), DirtyCount: 0, DirtyList: new Int32Array(n), DirtyFlagSet: new Int8Array(n) },
      Render: new Int32Array(n),
      Health: new Int32Array(n),
      Player: [] as CoreWorld['components']['Player'],
    },
    collision: {
      ready: false, initStarted: false, initError: null, world: null,
      collidersByEid: [], eidByColliderHandle: new Map(),
      touchingByEid: [],
      touchPairs: { Count: 0, A: new Int32Array(n), B: new Int32Array(n) },
      touchPairIndexByKey: new Map(), touchPairKeysByIndex: [], scratchTouching: [],
      bounceSuggestions: { Active: new Int8Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), DirtyList: new Int32Array(n), DirtyCount: 0, DirtyFlagSet: new Int8Array(n) },
    },
    time: { delta: DEFAULT_DT, elapsed: 0, then: 0, deltaBuffer: { push: () => {}, average: () => 0, clear: () => {}, size: () => 0 }, avgDelta: 0, ticksPerSecond: 0 },
    commands: { queue: [], handlers: new Map(), enqueue: () => 0, on: () => () => {}, process: () => {}, clear: () => {} },
    controls: { queue: [], states: new Map(), enqueue: () => 0, on: () => () => {}, onTick: () => () => {}, process: () => {}, getState: () => undefined, getStates: () => [], getActiveStates: () => [], isActive: () => false, isAnyActive: () => false, getAxis: () => 0, cancelActive: () => {}, clear: () => {} },
    chillUpdater: { setUpdate: () => {}, check: () => false },
    flaginator: {} as CoreWorld['flaginator'],
  }
  return createWorld(config) as unknown as CoreWorld
}

describe('cameraFollowSystem', () => {
  let world: CoreWorld
  let playerEid: number

  beforeEach(() => {
    world = makeTestWorld()
    vi.clearAllMocks()
    vi.mocked(castRayFromTo).mockReturnValue(null)

    resetCameraTarget()

    playerEid = addEntity(world)
    addComponent(world, playerEid, world.components.Position)
    world.components.Position.x[playerEid] = 0
    world.components.Position.y[playerEid] = 0
    world.components.Position.z[playerEid] = 0

    setCameraFollowTarget(playerEid)
  })

  it('places camera at player position + follow offset when no wall blocks', () => {
    cameraFollowSystem(world)

    // Default offset is (0,6,10); player at (0,0,0) → camera at (0,6,10)
    expect(setCameraPosition).toHaveBeenCalledWith(0, 6, 10)
  })

  it('does nothing when mode is off', () => {
    resetCameraTarget()
    cameraFollowSystem(world)

    expect(setCameraPosition).not.toHaveBeenCalled()
  })

  it('snaps camera in immediately when a wall blocks the path', () => {
    // Wall detected at toi=0.5 along player→camera direction (normalized)
    vi.mocked(castRayFromTo).mockReturnValue({ toi: 0.5, colliderEid: 99 })

    cameraFollowSystem(world)

    const [, , cameraZ] = vi.mocked(setCameraPosition).mock.calls[0]!
    // Camera must be between player (Z=0) and full desired position (Z=10)
    expect(cameraZ).toBeGreaterThan(0)
    expect(cameraZ).toBeLessThan(10)
  })

  it('does not adjust camera when wall is at or beyond the camera (toi >= 1)', () => {
    vi.mocked(castRayFromTo).mockReturnValue({ toi: 1.0, colliderEid: 99 })

    cameraFollowSystem(world)

    expect(setCameraPosition).toHaveBeenCalledWith(0, 6, 10)
  })

  it('springs camera distance back toward follow distance when wall clears', () => {
    // Frame 1: wall at toi=0.5 → camera snaps close
    vi.mocked(castRayFromTo).mockReturnValue({ toi: 0.5, colliderEid: 99 })
    cameraFollowSystem(world)
    const [, , zAfterWall] = vi.mocked(setCameraPosition).mock.calls[0]!

    // Frame 2: wall gone → camera springs back
    vi.clearAllMocks()
    vi.mocked(castRayFromTo).mockReturnValue(null)
    cameraFollowSystem(world)
    const [, , zAfterClear] = vi.mocked(setCameraPosition).mock.calls[0]!

    // Camera should have moved further from player than it was at the snap-in frame
    expect(zAfterClear).toBeGreaterThan(zAfterWall!)
  })

  it('fully restores camera distance after enough frames with no wall', () => {
    // Snap in with a wall
    vi.mocked(castRayFromTo).mockReturnValue({ toi: 0.5, colliderEid: 99 })
    cameraFollowSystem(world)

    // Run enough frames at DEFAULT_DT for the spring to fully restore
    vi.mocked(castRayFromTo).mockReturnValue(null)
    // CAMERA_RESTORE_SPEED=6, followDistance≈11.66 — needs ≈2s of frames to restore
    for (let i = 0; i < 180; i++) {
      vi.clearAllMocks()
      cameraFollowSystem(world)
    }

    const [, , z] = vi.mocked(setCameraPosition).mock.calls[0]!
    expect(z).toBeCloseTo(10, 0) // Should be back near Z=10
  })

  it('calls castRayFromTo from look-at height toward desired camera position', () => {
    cameraFollowSystem(world)

    // Player at (0,0,0); look-at origin is 0.75 above feet; camera at (0,6,10)
    expect(castRayFromTo).toHaveBeenCalledWith(
      world,
      expect.objectContaining({ x: 0, y: 0.75, z: 0 }),
      expect.objectContaining({ x: 0, y: 6, z: 10 }),
      expect.any(Object),
    )
  })

  describe('filterPredicate for camera wall cast', () => {
    function getCameraFilterPredicate(): (targetEid: number) => boolean {
      cameraFollowSystem(world)
      const call = vi.mocked(castRayFromTo).mock.calls[0]!
      const opts = call[3] as { filterPredicate: (eid: number) => boolean }
      return opts.filterPredicate
    }

    it('allows wall entities to occlude the camera', () => {
      const filter = getCameraFilterPredicate()
      const wallEid = addEntity(world)
      expect(filter(wallEid)).toBe(true)
    })

    it('allows Floor entities to occlude the camera (walls share the Floor component)', () => {
      const filter = getCameraFilterPredicate()
      const floorEid = addEntity(world)
      addComponent(world, floorEid, world.components.Floor)
      world.components.Floor[floorEid] = 1
      expect(filter(floorEid)).toBe(true)
    })

    it('excludes Person entities (those with Player component) from occluding the camera', () => {
      const filter = getCameraFilterPredicate()
      const personEid = addEntity(world)
      addComponent(world, personEid, world.components.Player)
      world.components.Player[personEid] = { level: 0, experience: 0, name: 'NPC' }
      expect(filter(personEid)).toBe(false)
    })
  })
})
