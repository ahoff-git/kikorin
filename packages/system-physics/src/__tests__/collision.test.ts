import { describe, it, expect } from 'vitest'
import {
  collisionSystem,
  createCollisionState,
  setupCollisionSystem,
  configureCuboidCollider,
  getTouchingEntities,
  getTouchPairs,
  markCollisionTransformDirty,
} from '../collision'

describe('system-physics collision exports', () => {
  it('exports collisionSystem as function', () => {
    expect(typeof collisionSystem).toBe('function')
  })

  it('exports createCollisionState as function', () => {
    expect(typeof createCollisionState).toBe('function')
  })

  it('createCollisionState creates valid initial state', () => {
    const state = createCollisionState(100)
    expect(state.ready).toBe(false)
    expect(state.world).toBe(null)
    expect(state.touchPairs.Count).toBe(0)
  })
})
