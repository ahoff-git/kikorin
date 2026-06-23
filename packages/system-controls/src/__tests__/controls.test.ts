import { describe, it, expect } from 'vitest'
import { createControls } from '../controls'

describe('createControls', () => {
  it('creates a controls instance', () => {
    const controls = createControls<object>()
    expect(typeof controls.enqueue).toBe('function')
    expect(typeof controls.on).toBe('function')
    expect(typeof controls.process).toBe('function')
    expect(typeof controls.getState).toBe('function')
    expect(controls.queue).toHaveLength(0)
  })

  it('enqueues control events', () => {
    const controls = createControls<object>()
    const seq = controls.enqueue({
      source: 'keyboard',
      controlId: 'KeyW',
      phase: 'start',
    })
    expect(typeof seq).toBe('number')
    expect(controls.queue).toHaveLength(1)
  })

  it('processes events and calls handlers', () => {
    const controls = createControls<object>()
    const received: string[] = []
    controls.on({ source: 'keyboard', controlId: 'KeyW' }, (_world, event) => {
      received.push(event.phase)
    })
    controls.enqueue({ source: 'keyboard', controlId: 'KeyW', phase: 'start' })
    controls.process({})
    expect(received).toContain('start')
  })

  it('isActive returns true while control is active', () => {
    const controls = createControls<object>()
    controls.enqueue({ source: 'keyboard', controlId: 'Space', phase: 'start' })
    controls.process({})
    expect(controls.isActive('Space', 'keyboard')).toBe(true)
  })

  it('cancelActive sends cancel events', () => {
    const controls = createControls<object>()
    controls.enqueue({ source: 'keyboard', controlId: 'KeyA', phase: 'start' })
    controls.process({})
    controls.cancelActive({ source: 'keyboard' })
    controls.process({})
    expect(controls.isActive('KeyA', 'keyboard')).toBe(false)
  })

  it('getAxis returns -1, 0, or 1', () => {
    const controls = createControls<object>()
    controls.enqueue({ source: 'keyboard', controlId: 'KeyA', phase: 'start' })
    controls.process({})
    const axis = controls.getAxis(['KeyA'], ['KeyD'])
    expect(axis).toBe(-1)
  })

  it('clear empties queue and states', () => {
    const controls = createControls<object>()
    controls.enqueue({ source: 'keyboard', controlId: 'KeyW', phase: 'start' })
    controls.clear()
    expect(controls.queue).toHaveLength(0)
  })
})
