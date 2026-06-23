import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChronoTrigger } from '../chronoTrigger'

let pendingFrames: Map<number, (time: number) => void>
let rafIdCounter: number

function setupRafMock() {
  pendingFrames = new Map()
  rafIdCounter = 1
  vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
    const id = rafIdCounter++
    pendingFrames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id)
  })
}

function triggerFrame(time: number) {
  const entries = Array.from(pendingFrames.entries())
  pendingFrames.clear()
  for (const [, cb] of entries) cb(time)
}

beforeEach(() => {
  setupRafMock()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createChronoTrigger', () => {
  describe('runAt', () => {
    it('returns a positive integer id', () => {
      const ct = createChronoTrigger()
      const id = ct.runAt({ callback: () => {} })
      expect(id).toBeGreaterThan(0)
      expect(Number.isInteger(id)).toBe(true)
    })

    it('returns distinct ids for different tasks', () => {
      const ct = createChronoTrigger()
      const id1 = ct.runAt({ callback: () => {} })
      const id2 = ct.runAt({ callback: () => {} })
      expect(id1).not.toBe(id2)
    })

    it('throws when callback is not a function', () => {
      const ct = createChronoTrigger()
      expect(() => ct.runAt({ callback: null as unknown as () => void })).toThrow()
    })

    it('throws when fpsTarget is zero', () => {
      const ct = createChronoTrigger()
      expect(() => ct.runAt({ callback: () => {}, fpsTarget: 0 })).toThrow()
    })

    it('throws when fpsTarget is negative', () => {
      const ct = createChronoTrigger()
      expect(() => ct.runAt({ callback: () => {}, fpsTarget: -1 })).toThrow()
    })
  })

  describe('dispose', () => {
    it('returns true when removing a registered task', () => {
      const ct = createChronoTrigger()
      const id = ct.runAt({ callback: () => {} })
      expect(ct.dispose(id)).toBe(true)
    })

    it('returns false for an unknown id', () => {
      const ct = createChronoTrigger()
      expect(ct.dispose(9999)).toBe(false)
    })

    it('prevents a disposed task from firing', () => {
      const ct = createChronoTrigger()
      const callback = vi.fn()
      const id = ct.runAt({ callback })
      ct.dispose(id)
      ct.Start()
      triggerFrame(100)
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('Start / Stop', () => {
    it('enqueues a RAF on Start', () => {
      const ct = createChronoTrigger()
      expect(pendingFrames.size).toBe(0)
      ct.Start()
      expect(pendingFrames.size).toBe(1)
    })

    it('fires a no-interval task on every frame', () => {
      const ct = createChronoTrigger()
      const callback = vi.fn()
      ct.runAt({ callback })
      ct.Start()

      triggerFrame(100) // Frame 1: delta=0 on first frame, still fires
      expect(callback).toHaveBeenCalledTimes(1)

      triggerFrame(200) // Frame 2: delta=100
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('does not re-register after Stop', () => {
      const ct = createChronoTrigger()
      ct.Start()
      ct.Stop()
      triggerFrame(100) // frame was already pending, but Stop cancelled it
      expect(pendingFrames.size).toBe(0)
    })

    it('does not fire tasks after Stop', () => {
      const ct = createChronoTrigger()
      const callback = vi.fn()
      ct.runAt({ callback })
      ct.Start()
      ct.Stop()
      // Even if we manually trigger the cancelled frame, running=false exits early
      triggerFrame(100)
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('fpsTarget scheduling', () => {
    it('fires task once on first frame and then at the correct interval', () => {
      const ct = createChronoTrigger()
      const callback = vi.fn()
      // 10 fps → intervalMs = 100ms; accumulator starts at intervalMs = 100
      ct.runAt({ callback, fpsTarget: 10 })
      ct.Start()

      // Frame 1 at t=0: delta=0, accum=100+0=100, ticks=floor(100/100)=1 → fires once
      triggerFrame(0)
      expect(callback).toHaveBeenCalledTimes(1)

      // Frame 2 at t=50ms: delta=50, accum=0+50=50, ticks=0 → no fire
      triggerFrame(50)
      expect(callback).toHaveBeenCalledTimes(1)

      // Frame 3 at t=150ms: delta=100, accum=50+100=150, ticks=1 → fires once more
      triggerFrame(150)
      expect(callback).toHaveBeenCalledTimes(2)
    })
  })
})
