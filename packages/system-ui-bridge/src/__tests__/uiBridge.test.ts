import { describe, it, expect } from 'vitest'
import { uiBridgeSystem } from '../uiBridge'

describe('system-ui-bridge', () => {
  it('exports uiBridgeSystem as a function', () => {
    expect(typeof uiBridgeSystem).toBe('function')
  })
})
