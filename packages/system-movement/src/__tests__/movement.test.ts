import { describe, it, expect, beforeEach, vi } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import { createFlaginator } from '@kikorin/system-flaginator'
import { NET } from '@kikorin/ecs'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/system-physics', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    castEntityCollider: vi.fn(() => null),
  }
})

const { castEntityCollider } = await import('@kikorin/system-physics')
const { movementSystem } = await import('../movement')

const MAX_ENTITIES = 100

function makeTestWorld(): CoreWorld {
  const n = MAX_ENTITIES
  const Player: CoreWorld['components']['Player'] = []

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
      Player,
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
    flaginator: createFlaginator<CoreWorld>(n),
  }

  return createWorld(config) as unknown as CoreWorld
}

const ZERO_VEC = { x: 0, y: 0, z: 0 }
const ZERO_HIT = { colliderEid: 99, toi: 0, witness1: ZERO_VEC, witness2: ZERO_VEC, normal1: ZERO_VEC, normal2: ZERO_VEC }

describe('movementSystem', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
    vi.clearAllMocks()
    vi.mocked(castEntityCollider).mockReturnValue(null)
  })

  it('moves entity by velocity * dt', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)

    world.components.Position.x[eid] = 0
    world.components.Position.y[eid] = 0
    world.components.Position.z[eid] = 0
    world.components.Velocity.x[eid] = 10
    world.components.Velocity.z[eid] = 5
    world.time.delta = 1000 // 1 second

    movementSystem(world)

    // dt = 1000 * 0.001 = 1s; x: 0 + 10*1 = 10; z: 0 + 5*1 = 5
    expect(world.components.Position.x[eid]).toBeCloseTo(10)
    expect(world.components.Position.z[eid]).toBeCloseTo(5)
  })

  it('does not move entities when delta is 0', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)

    world.components.Position.x[eid] = 5
    world.components.Velocity.x[eid] = 100
    world.time.delta = 0

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBe(5)
  })

  it('skips entities with the PROJECTILE net flag set', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    world.components.NetFlags[eid] = NET.PROJECTILE

    world.components.Position.x[eid] = 0
    world.components.Velocity.x[eid] = 100
    world.time.delta = 1000

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBe(0)
  })

  it('moves owned projectile-type entities only when OWNED is set without PROJECTILE', () => {
    // OWNED alone (non-projectile type) should simulate normally
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    world.components.NetFlags[eid] = NET.OWNED

    world.components.Position.x[eid] = 0
    world.components.Velocity.x[eid] = 10
    world.time.delta = 1000

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBeCloseTo(10)
  })

  it('skips remote-predicted entities that also carry PROJECTILE flag', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    world.components.NetFlags[eid] = NET.PREDICT | NET.PROJECTILE

    world.components.Position.x[eid] = 0
    world.components.Velocity.x[eid] = 100
    world.time.delta = 1000

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBe(0)
  })

  it('does not move entities that have no velocity', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)

    world.components.Position.x[eid] = 3
    world.time.delta = 1000

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBe(3)
  })

  it('updates yaw to face velocity direction when FaceVelocity is set', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    addComponent(world, eid, world.components.Rotation)
    addComponent(world, eid, world.components.FaceVelocity)

    world.components.FaceVelocity[eid] = 1
    world.components.Velocity.x[eid] = 0
    world.components.Velocity.z[eid] = -1
    world.time.delta = 100

    movementSystem(world)

    expect(world.components.Rotation.yaw[eid]).toBeCloseTo(0)
  })

  describe('wall collision (player entities)', () => {
    function spawnPlayer(world: CoreWorld): number {
      const eid = addEntity(world)
      addComponent(world, eid, world.components.Position)
      addComponent(world, eid, world.components.Velocity)
      addComponent(world, eid, world.components.Collider)
      addComponent(world, eid, world.components.Player)
      world.components.Player[eid] = { level: 0, experience: 0, name: 'test' }
      return eid
    }

    it('moves freely when no wall is hit', () => {
      const eid = spawnPlayer(world)
      world.components.Velocity.x[eid] = 10
      world.time.delta = 1000

      movementSystem(world)

      expect(world.components.Position.x[eid]).toBeCloseTo(10)
    })

    it('stops player before a head-on wall (normal pointing back toward player)', () => {
      // Player moving in +X; wall normal1 = (1,0,0) = outward normal of player shape at contact
      vi.mocked(castEntityCollider).mockReturnValueOnce({
        ...ZERO_HIT,
        toi: 0.5,
        normal1: { x: 1, y: 0, z: 0 },
      })

      const eid = spawnPlayer(world)
      world.components.Position.x[eid] = 0
      world.components.Position.z[eid] = 0
      world.components.Velocity.x[eid] = 10
      world.time.delta = 1000 // dt=1s, dx=10

      movementSystem(world)

      // safeToi = 0.5 - 0.001 = 0.499; nextX = 10*0.499 = 4.99
      // slide: remainingT=0.5; dot = 10*1 = 10; slideX = (10-10)*0.5 = 0
      expect(world.components.Position.x[eid]).toBeCloseTo(4.99)
      expect(world.components.Position.z[eid]).toBeCloseTo(0)
    })

    it('slides player along wall when moving diagonally into an X-facing wall', () => {
      // Diagonal movement into a wall at x=something; wall normal1=(1,0,0)
      vi.mocked(castEntityCollider).mockReturnValueOnce({
        ...ZERO_HIT,
        toi: 0.5,
        normal1: { x: 1, y: 0, z: 0 },
      })

      const eid = spawnPlayer(world)
      world.components.Position.x[eid] = 0
      world.components.Position.z[eid] = 0
      world.components.Velocity.x[eid] = 10
      world.components.Velocity.z[eid] = 10
      world.time.delta = 1000 // dt=1s, dx=10, dz=10

      movementSystem(world)

      // safeToi = 0.499; nextX = 10*0.499 = 4.99; nextZ = 10*0.499 = 4.99
      // remainingT = 0.5; dot = 10*1+10*0 = 10
      // slideX = (10-10*1)*0.5 = 0; slideZ = (10-10*0)*0.5 = 5
      // Final: x = 4.99, z = 4.99+5 = 9.99
      expect(world.components.Position.x[eid]).toBeCloseTo(4.99)
      expect(world.components.Position.z[eid]).toBeCloseTo(9.99)
    })

    it('slides player along wall when moving diagonally into a Z-facing wall', () => {
      // Wall normal1=(0,0,1) means player is pressing into a Z-facing wall
      vi.mocked(castEntityCollider).mockReturnValueOnce({
        ...ZERO_HIT,
        toi: 0.5,
        normal1: { x: 0, y: 0, z: 1 },
      })

      const eid = spawnPlayer(world)
      world.components.Velocity.x[eid] = 10
      world.components.Velocity.z[eid] = 10
      world.time.delta = 1000

      movementSystem(world)

      // dx=10, dz=10; safeToi=0.499
      // nextX=4.99, nextZ=4.99
      // remainingT=0.5; dot=10*0+10*1=10
      // slideX=(10-0)*0.5=5; slideZ=(10-10)*0.5=0
      // Final: x=4.99+5=9.99, z=4.99+0=4.99
      expect(world.components.Position.x[eid]).toBeCloseTo(9.99)
      expect(world.components.Position.z[eid]).toBeCloseTo(4.99)
    })

    it('does not call castEntityCollider for non-player entities', () => {
      const eid = addEntity(world)
      addComponent(world, eid, world.components.Position)
      addComponent(world, eid, world.components.Velocity)
      addComponent(world, eid, world.components.Collider)
      // No Player component

      world.components.Velocity.x[eid] = 10
      world.time.delta = 1000

      movementSystem(world)

      expect(castEntityCollider).not.toHaveBeenCalled()
      expect(world.components.Position.x[eid]).toBeCloseTo(10)
    })

    it('does not call castEntityCollider for player without Collider', () => {
      const eid = addEntity(world)
      addComponent(world, eid, world.components.Position)
      addComponent(world, eid, world.components.Velocity)
      addComponent(world, eid, world.components.Player)
      world.components.Player[eid] = { level: 0, experience: 0, name: 'test' }
      // No Collider component

      world.components.Velocity.x[eid] = 10
      world.time.delta = 1000

      movementSystem(world)

      expect(castEntityCollider).not.toHaveBeenCalled()
    })

    it('passes XZ-only movement delta to castEntityCollider (Y is zero)', () => {
      vi.mocked(castEntityCollider).mockReturnValueOnce(null)

      const eid = spawnPlayer(world)
      world.components.Velocity.x[eid] = 5
      world.components.Velocity.y[eid] = 10 // vertical — should not be passed to cast
      world.components.Velocity.z[eid] = 3
      world.time.delta = 1000

      movementSystem(world)

      expect(castEntityCollider).toHaveBeenCalledWith(
        world,
        eid,
        expect.objectContaining({ x: 0, z: 0 }),
        expect.objectContaining({ x: 5, y: 0, z: 3 }),
        expect.any(Object),
      )
    })

    describe('filterPredicate', () => {
      function getFilterPredicate(): (targetEid: number) => boolean {
        const eid = spawnPlayer(world)
        world.components.Velocity.x[eid] = 10
        world.time.delta = 1000
        movementSystem(world)
        const call = vi.mocked(castEntityCollider).mock.calls[0]!
        const opts = call[4] as { filterPredicate: (eid: number) => boolean }
        return opts.filterPredicate
      }

      it('allows wall entities (no Floor, no Player, no Sensor) to block the player', () => {
        const filter = getFilterPredicate()
        const wallEid = addEntity(world)
        // wall entity: no special components added
        expect(filter(wallEid)).toBe(true)
      })

      it('excludes Floor entities from blocking', () => {
        const filter = getFilterPredicate()
        const floorEid = addEntity(world)
        addComponent(world, floorEid, world.components.Floor)
        world.components.Floor[floorEid] = 1
        expect(filter(floorEid)).toBe(false)
      })

      it('excludes Person entities (those with Player component) from blocking', () => {
        const filter = getFilterPredicate()
        const personEid = addEntity(world)
        addComponent(world, personEid, world.components.Player)
        world.components.Player[personEid] = { level: 0, experience: 0, name: 'NPC' }
        expect(filter(personEid)).toBe(false)
      })

      it('excludes Sensor colliders from blocking', () => {
        const filter = getFilterPredicate()
        const sensorEid = addEntity(world)
        addComponent(world, sensorEid, world.components.Collider)
        world.components.Collider.Sensor[sensorEid] = 1
        expect(filter(sensorEid)).toBe(false)
      })

      it('excludes projectile-type entities (NET.PROJECTILE flag) from blocking', () => {
        const filter = getFilterPredicate()
        const projEid = addEntity(world)
        world.components.NetFlags[projEid] = NET.PROJECTILE
        expect(filter(projEid)).toBe(false)
      })
    })
  })
})
