import { describe, it, expect } from 'vitest'
import { movementSystem } from '../movement'

describe('system-movement', () => {
  it('exports movementSystem as a function', () => {
    expect(typeof movementSystem).toBe('function')
  })
})
