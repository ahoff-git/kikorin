import { describe, it, expect } from 'vitest'
import { dirtyTransformsSystem } from '../dirtyTransforms'

describe('dirtyTransformsSystem', () => {
  it('exports dirtyTransformsSystem as a function', () => {
    expect(typeof dirtyTransformsSystem).toBe('function')
  })
})
