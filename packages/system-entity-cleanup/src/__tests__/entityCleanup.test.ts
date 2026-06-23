import { describe, it, expect } from 'vitest'
import { destroyEntity, fallCleanupSystem } from '../entityCleanup'

describe('system-entity-cleanup', () => {
  it('exports destroyEntity as a function', () => {
    expect(typeof destroyEntity).toBe('function')
  })

  it('exports fallCleanupSystem as a function', () => {
    expect(typeof fallCleanupSystem).toBe('function')
  })
})
