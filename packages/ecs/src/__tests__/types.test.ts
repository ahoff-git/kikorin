import { describe, it, expect } from 'vitest'
import { ControlSources, KeyboardControls, PointerControls, CoreFlags } from '../index'

describe('ecs types', () => {
  it('exports ControlSources', () => {
    expect(ControlSources.Keyboard).toBe('keyboard')
    expect(ControlSources.Pointer).toBe('pointer')
    expect(ControlSources.React).toBe('react')
  })

  it('exports KeyboardControls', () => {
    expect(KeyboardControls.KeyW).toBe('KeyW')
    expect(KeyboardControls.Space).toBe('Space')
  })

  it('exports PointerControls', () => {
    expect(PointerControls.Primary).toBe('primary')
  })

  it('exports CoreFlags', () => {
    expect(CoreFlags.Dead).toBe('dead')
    expect(CoreFlags.OnGround).toBe('onGround')
    expect(CoreFlags.InAir).toBe('inAir')
    expect(CoreFlags.TouchingNonFloor).toBe('touchingNonFloor')
  })
})
