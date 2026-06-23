import { describe, it, expect } from 'vitest'
import {
  renderSystem,
  setupRenderer,
  disposeRenderer,
  upsertObjectByEid,
  removeObjectByEid,
  setObjectTransformByEid,
  setObjectTouchingByEid,
  applyToObjectByEid,
} from '../render'

describe('system-rendering exports', () => {
  it('exports renderSystem', () => {
    expect(typeof renderSystem).toBe('function')
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

  it('setObjectTouchingByEid returns false for unknown eid', () => {
    expect(setObjectTouchingByEid(9999, true)).toBe(false)
  })

  it('applyToObjectByEid returns false for unknown eid', () => {
    expect(applyToObjectByEid(9999, () => {})).toBe(false)
  })
})
