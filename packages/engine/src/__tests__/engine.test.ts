import { describe, it, expect } from 'vitest'
import { setupCoreWorld } from '../core'

describe('@kikorin/engine', () => {
  it('exports setupCoreWorld as a function', () => {
    expect(typeof setupCoreWorld).toBe('function')
  })
})
