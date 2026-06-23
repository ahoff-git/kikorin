import { describe, it, expect, beforeEach, vi } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/system-physics', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    castEntityCollider: vi.fn(() => null),
    findHighestFloorTopAtPosition: vi.fn(() => null),
  }
})

vi.mock('@kikorin/system-rendering', () => ({
  lookCameraAt: vi.fn(() => true),
  readCameraPosition: vi.fn(() => true),
  setCameraPosition: vi.fn(() => true),
}))

const { cameraFollowSystem, resetCameraTarget, setCameraFollowTarget } = await import('../cameraFollow')
const { castEntityCollider } = await import('@kikorin/system-physics')
const { setCameraPosition } = await import('@kikorin/system-rendering')

const MAX_ENTITIES = 100

function makeTestWorld(): CoreWorld {
  const n = MAX_ENTITIES
  const config = {
    components: {
      Position: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Velocity: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Rotation: { yaw: new Float32Array(n), pitch: new Float32Array(n), roll: new Float32Array(n) },
      FaceVelocity: new Int8Array(n),
      Projectile: new Int8Array(n),
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
    time: { delta: 0, elapsed: 0, then: 0, deltaBuffer: { push: () => {}, average: () => 0, clear: () => {}, size: () => 0 }, avgDelta: 0, ticksPerSecond: 0 },
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
    vi.mocked(castEntityCollider).mockReturnValue(null)

    // Reset module-level camera state
    resetCameraTarget()

    // Spawn a player entity with Position
    playerEid = addEntity(world)
    addComponent(world, playerEid, world.components.Position)
    world.components.Position.x[playerEid] = 0
    world.components.Position.y[playerEid] = 0
    world.components.Position.z[playerEid] = 0

    // Set camera to follow this entity (default offset: 0,4,10)
    setCameraFollowTarget(playerEid)
  })

  it('places camera at player position + follow offset when no wall blocks', () => {
    cameraFollowSystem(world)

    // Default offset is (0,4,10); player at (0,0,0) → camera at (0,4,10)
    expect(setCameraPosition).toHaveBeenCalledWith(0, 4, 10)
  })

  it('does nothing when mode is off', () => {
    resetCameraTarget()
    cameraFollowSystem(world)

    expect(setCameraPosition).not.toHaveBeenCalled()
  })

  it('moves camera closer to player when a wall is between player and camera', () => {
    // Wall detected at toi=0.5 along player→camera direction
    vi.mocked(castEntityCollider).mockReturnValueOnce({
      colliderEid: 99,
      toi: 0.5,
      witness1: { x: 0, y: 0, z: 0 },
      witness2: { x: 0, y: 0, z: 0 },
      normal1: { x: 0, y: 0, z: -1 },
      normal2: { x: 0, y: 0, z: 1 },
    })

    cameraFollowSystem(world)

    // Camera should be placed somewhere BETWEEN player and desired camera pos
    // desired Z = 10; wall at toi=0.5 → camera Z should be < 10
    const call = vi.mocked(setCameraPosition).mock.calls[0]!
    const cameraZ = call[2]!
    expect(cameraZ).toBeGreaterThan(0)
    expect(cameraZ).toBeLessThan(10)
  })

  it('does not adjust camera when wall is beyond the camera (toi >= 1)', () => {
    // toi=1 means wall is exactly AT the desired camera position — barely past it
    vi.mocked(castEntityCollider).mockReturnValueOnce({
      colliderEid: 99,
      toi: 1.0,
      witness1: { x: 0, y: 0, z: 0 },
      witness2: { x: 0, y: 0, z: 0 },
      normal1: { x: 0, y: 0, z: -1 },
      normal2: { x: 0, y: 0, z: 1 },
    })

    cameraFollowSystem(world)

    // Camera should be at the desired position — wall is at or beyond camera
    expect(setCameraPosition).toHaveBeenCalledWith(0, 4, 10)
  })

  it('calls castEntityCollider from player toward desired camera position', () => {
    cameraFollowSystem(world)

    // Player at (0,0,0); desired camera at (0,4,10) → direction (0,4,10)
    expect(castEntityCollider).toHaveBeenCalledWith(
      world,
      playerEid,
      expect.objectContaining({ x: 0, y: 0, z: 0 }),
      expect.objectContaining({ x: 0, y: 4, z: 10 }),
      expect.any(Object),
    )
  })

  describe('filterPredicate for camera wall cast', () => {
    function getCameraFilterPredicate(): (targetEid: number) => boolean {
      cameraFollowSystem(world)
      const call = vi.mocked(castEntityCollider).mock.calls[0]!
      const opts = call[4] as { filterPredicate: (eid: number) => boolean }
      return opts.filterPredicate
    }

    it('allows wall entities to occlude the camera', () => {
      const filter = getCameraFilterPredicate()
      const wallEid = addEntity(world)
      expect(filter(wallEid)).toBe(true)
    })

    it('excludes Floor entities from occluding the camera', () => {
      const filter = getCameraFilterPredicate()
      const floorEid = addEntity(world)
      addComponent(world, floorEid, world.components.Floor)
      world.components.Floor[floorEid] = 1
      expect(filter(floorEid)).toBe(false)
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
