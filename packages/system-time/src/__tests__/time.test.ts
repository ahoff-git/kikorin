import { describe, it, expect } from 'vitest'
import { timeSystem } from '../time'

describe('system-time', () => {
  it('exports timeSystem as a function', () => {
    expect(typeof timeSystem).toBe('function')
  })
})
