import { describe, it, expect } from 'vitest'
import { gravitySystem, findHighestFloorTopAtPosition } from '../gravity'

describe('system-physics gravity exports', () => {
  it('exports gravitySystem as function', () => {
    expect(typeof gravitySystem).toBe('function')
  })

  it('exports findHighestFloorTopAtPosition as function', () => {
    expect(typeof findHighestFloorTopAtPosition).toBe('function')
  })
})
