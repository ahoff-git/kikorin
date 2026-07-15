import { describe, it, expect } from 'vitest'
import {
  renderFrame,
  setupRenderer,
  disposeRenderer,
  removeObjectByEid,
  setObjectTransformByEid,
  applyToObjectByEid,
  getRenderMode,
} from '../render'

describe('system-rendering exports', () => {
  it('exports renderFrame', () => {
    expect(typeof renderFrame).toBe('function')
  })

  it('exports setupRenderer', () => {
    expect(typeof setupRenderer).toBe('function')
  })

  it('exports disposeRenderer', () => {
    expect(typeof disposeRenderer).toBe('function')
  })

  it('removeObjectByEid returns false for unknown eid', () => {
    expect(removeObjectByEid(9999)).toBe(false)
  })

  it('setObjectTransformByEid returns false for unknown eid', () => {
    expect(setObjectTransformByEid(9999, 0, 0, 0, 0, 0, 0)).toBe(false)
  })

  it('applyToObjectByEid returns false for unknown eid', () => {
    expect(applyToObjectByEid(9999, () => {})).toBe(false)
  })
})

describe('render mode', () => {
  it('defaults to "3d" before any setupRenderer call', () => {
    expect(getRenderMode()).toBe('3d')
  })

  it('setupRenderer accepts an explicit mode without a canvas as a no-op', () => {
    // No real canvas/WebGL context in this test environment (node, no
    // jsdom) — setupRenderer(null, ...) exercises only the early-return
    // guard, same as the existing no-canvas smoke coverage above, but
    // proves the two-argument call shape type-checks and doesn't throw.
    expect(() => setupRenderer(null, '2d')).not.toThrow()
    expect(getRenderMode()).toBe('3d')
  })
})
