import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/events', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

const { uiBridgeSystem } = await import('../uiBridge')
const { eventBus } = await import('@kikorin/events')

const MAX_ENTITIES = 100

function makeTestWorld(): CoreWorld {
  const n = MAX_ENTITIES
  const Player: CoreWorld['components']['Player'] = []

  // chillUpdater that fires every update immediately (bypasses minMS throttle)
  const chillUpdater = {
    setUpdate: vi.fn(({ updateFunction, value }: { updateKey: string; updateFunction: (v: unknown) => void; value: unknown; minMS: number }) => {
      updateFunction(value)
    }),
    check: vi.fn(),
  }

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
    time: {
      delta: 16, elapsed: 0, then: 0,
      deltaBuffer: { push: () => {}, average: () => 16, clear: () => {}, size: () => 1 },
      avgDelta: 16, ticksPerSecond: 60,
    },
    commands: { queue: [], handlers: new Map(), enqueue: () => 0, on: () => () => {}, process: () => {}, clear: () => {} },
    controls: {
      queue: [], states: new Map(), enqueue: () => 0, on: () => () => {}, onTick: () => () => {},
      process: () => {}, getState: () => undefined, getStates: () => [], getActiveStates: () => [],
      isActive: () => false, isAnyActive: () => false, getAxis: () => 0, cancelActive: () => {}, clear: () => {},
    },
    chillUpdater,
    flaginator: {} as CoreWorld['flaginator'],
  }

  return createWorld(config) as unknown as CoreWorld
}

describe('uiBridgeSystem', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
    vi.clearAllMocks()
  })

  it('emits ui:timeMetricsUpdate with time data', () => {
    world.time.delta = 32
    world.time.ticksPerSecond = 30

    uiBridgeSystem(world)

    expect(eventBus.emit).toHaveBeenCalledWith(
      'ui:timeMetricsUpdate',
      expect.objectContaining({
        timeMetrics: expect.objectContaining({ delta: 32, ticksPerSecond: 30 }),
      }),
    )
  })

  it('emits ui:playerUpdate with null player when no player entity exists', () => {
    uiBridgeSystem(world)

    expect(eventBus.emit).toHaveBeenCalledWith(
      'ui:playerUpdate',
      expect.objectContaining({ player: null }),
    )
  })

  it('emits ui:playerUpdate with player data when a player entity exists', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Player)
    world.components.Player[eid] = { level: 3, experience: 50, name: 'Hero' }

    uiBridgeSystem(world)

    expect(eventBus.emit).toHaveBeenCalledWith(
      'ui:playerUpdate',
      expect.objectContaining({
        player: expect.objectContaining({ level: 3, experience: 50, name: 'Hero' }),
      }),
    )
  })

  it('emits ui:playerPositionUpdate with null position when no player entity exists', () => {
    uiBridgeSystem(world)

    expect(eventBus.emit).toHaveBeenCalledWith(
      'ui:playerPositionUpdate',
      expect.objectContaining({ playerPosition: null }),
    )
  })

  it('emits ui:controlsUpdate', () => {
    uiBridgeSystem(world)

    expect(eventBus.emit).toHaveBeenCalledWith(
      'ui:controlsUpdate',
      expect.objectContaining({ controlStates: expect.any(Array) }),
    )
  })

  it('calls chillUpdater.check() once per tick', () => {
    uiBridgeSystem(world)

    expect(world.chillUpdater.check).toHaveBeenCalledTimes(1)
  })
})
