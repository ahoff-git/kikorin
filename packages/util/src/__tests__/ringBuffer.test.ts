import { describe, it, expect } from 'vitest'
import { createRingBuffer } from '../ringBuffer'

describe('createRingBuffer', () => {
  it('throws for zero capacity', () => {
    expect(() => createRingBuffer(0)).toThrow()
  })

  it('returns zero average when empty', () => {
    const buf = createRingBuffer(5)
    expect(buf.average()).toBe(0)
    expect(buf.size()).toBe(0)
  })

  it('computes average of pushed values', () => {
    const buf = createRingBuffer(4)
    buf.push(2)
    buf.push(4)
    expect(buf.average()).toBe(3)
    expect(buf.size()).toBe(2)
  })

  it('overwrites oldest when full', () => {
    const buf = createRingBuffer(3)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.push(10)
    expect(buf.size()).toBe(3)
    expect(buf.average()).toBeCloseTo((2 + 3 + 10) / 3)
  })

  it('clears correctly', () => {
    const buf = createRingBuffer(3)
    buf.push(5)
    buf.clear()
    expect(buf.size()).toBe(0)
    expect(buf.average()).toBe(0)
  })
})
