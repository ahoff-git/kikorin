import { describe, it, expect, vi } from 'vitest'
import { eventBus } from '../eventBus'

describe('eventBus', () => {
  it('emits and receives ui:playerUpdate', () => {
    const handler = vi.fn()
    eventBus.on('ui:playerUpdate', handler)
    eventBus.emit('ui:playerUpdate', { player: null })
    expect(handler).toHaveBeenCalledWith({ player: null })
    eventBus.off('ui:playerUpdate', handler)
  })

  it('emits and receives ui:playerPositionUpdate', () => {
    const handler = vi.fn()
    eventBus.on('ui:playerPositionUpdate', handler)
    eventBus.emit('ui:playerPositionUpdate', { playerPosition: { x: 1, y: 2, z: 3 } })
    expect(handler).toHaveBeenCalledWith({ playerPosition: { x: 1, y: 2, z: 3 } })
    eventBus.off('ui:playerPositionUpdate', handler)
  })
})
