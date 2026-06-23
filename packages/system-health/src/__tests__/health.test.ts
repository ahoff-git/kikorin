import { describe, it, expect } from 'vitest'
import { healthSystem } from '../health'

describe('system-health', () => {
  it('exports healthSystem as a function', () => {
    expect(typeof healthSystem).toBe('function')
  })
})
