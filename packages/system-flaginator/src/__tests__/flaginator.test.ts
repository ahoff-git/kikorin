import { describe, it, expect } from 'vitest'
import { addEntity, createWorld } from 'bitecs'
import {
  createFlaginator,
  registerFlaginatorFlag,
  evaluateFlaginatorFlag,
  markFlaginatorComponentChanged,
  flagComponentDependency,
  resetFlaginatorEntity,
  advanceFlaginatorTick,
} from '../flaginator'

type TestWorld = {
  flaginator: ReturnType<typeof createFlaginator>
  components: { Health: Int32Array }
}

function createTestWorld(maxEntities = 100): TestWorld {
  const world = createWorld<TestWorld>({
    flaginator: createFlaginator<TestWorld>(maxEntities),
    components: {
      Health: new Int32Array(maxEntities),
    },
  })
  return world
}

describe('flaginator', () => {
  it('creates flaginator state', () => {
    const state = createFlaginator(100)
    expect(state.maxEntities).toBe(100)
    expect(state.tick).toBe(0)
    expect(state.flags.size).toBe(0)
  })

  it('registers and evaluates a flag', () => {
    const world = createTestWorld()
    registerFlaginatorFlag(world, 'isAlive', {
      dependencies: [flagComponentDependency('Health')],
      evaluate: ({ world: w, eid }) => w.components.Health[eid] > 0,
    })

    addEntity(world)
    world.components.Health[1] = 100
    markFlaginatorComponentChanged(world, 'Health', 1)
    advanceFlaginatorTick(world)
    expect(evaluateFlaginatorFlag(world, 'isAlive', 1)).toBe(true)

    world.components.Health[1] = 0
    markFlaginatorComponentChanged(world, 'Health', 1)
    advanceFlaginatorTick(world)
    expect(evaluateFlaginatorFlag(world, 'isAlive', 1)).toBe(false)
  })

  it('throws on duplicate flag registration', () => {
    const world = createTestWorld()
    registerFlaginatorFlag(world, 'myFlag', { evaluate: () => true })
    expect(() =>
      registerFlaginatorFlag(world, 'myFlag', { evaluate: () => false })
    ).toThrow()
  })

  it('resets entity epoch on resetFlaginatorEntity', () => {
    const world = createTestWorld()
    registerFlaginatorFlag(world, 'f', { evaluate: () => true })
    addEntity(world)
    advanceFlaginatorTick(world)
    evaluateFlaginatorFlag(world, 'f', 1)
    resetFlaginatorEntity(world, 1)
    const state = world.flaginator
    expect(state.entityEpoch[1]).toBeGreaterThan(0)
  })
})
