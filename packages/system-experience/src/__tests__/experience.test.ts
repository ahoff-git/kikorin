import { describe, it, expect } from 'vitest'
import { experienceSystem } from '../experience'

describe('system-experience', () => {
  it('exports experienceSystem as a function', () => {
    expect(typeof experienceSystem).toBe('function')
  })
})
