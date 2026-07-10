import { describe, it, expect } from 'vitest'
import {
  renderFrame,
  setupRenderer,
  disposeRenderer,
  removeObjectByEid,
  setObjectTransformByEid,
  applyToObjectByEid,
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
