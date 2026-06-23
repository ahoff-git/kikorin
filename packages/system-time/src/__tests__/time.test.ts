import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { timeSystem } from '../time'
import type { CoreWorld } from '@kikorin/ecs'

let mockNow = 0

function makeTimeWorld(initialThen: number): CoreWorld {
  let sum = 0
  let count = 0
  return {
    time: {
      delta: 0,
      elapsed: 0,
      then: initialThen,
      deltaBuffer: {
        push(v: number) { sum += v; count++ },
        average() { return count > 0 ? sum / count : 0 },
        clear() { sum = 0; count = 0 },
        size() { return count },
      },
      avgDelta: 0,
      ticksPerSecond: 0,
    },
  } as unknown as CoreWorld
}

beforeEach(() => {
  mockNow = 0
  vi.stubGlobal('performance', { now: () => mockNow })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('timeSystem', () => {
  it('computes delta as the difference between now and then', () => {
    mockNow = 1100
    const world = makeTimeWorld(1000)
    timeSystem(world)
    expect(world.time.delta).toBe(100)
  })

  it('increments elapsed by delta', () => {
    mockNow = 1050
    const world = makeTimeWorld(1000)
    world.time.elapsed = 500
    timeSystem(world)
    expect(world.time.elapsed).toBe(550)
  })

  it('updates then to the current time', () => {
    mockNow = 2000
    const world = makeTimeWorld(1000)
    timeSystem(world)
    expect(world.time.then).toBe(2000)
  })

  it('computes ticksPerSecond as 1000 / avgDelta when avgDelta is non-zero', () => {
    mockNow = 1016
    const world = makeTimeWorld(1000)
    timeSystem(world)
    expect(world.time.avgDelta).toBeCloseTo(16)
    expect(world.time.ticksPerSecond).toBeCloseTo(1000 / 16)
  })

  it('sets ticksPerSecond to 0 when delta is 0', () => {
    mockNow = 1000
    const world = makeTimeWorld(1000)
    timeSystem(world)
    expect(world.time.delta).toBe(0)
    expect(world.time.ticksPerSecond).toBe(0)
  })

  it('accumulates elapsed across multiple ticks', () => {
    const world = makeTimeWorld(0)
    mockNow = 100
    timeSystem(world)
    mockNow = 200
    timeSystem(world)
    mockNow = 350
    timeSystem(world)
    expect(world.time.elapsed).toBeCloseTo(350)
  })
})
