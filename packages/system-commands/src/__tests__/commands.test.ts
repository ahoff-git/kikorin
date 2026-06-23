import { describe, it, expect, vi } from 'vitest'
import { createCoreCommands } from '../commands'

describe('createCoreCommands', () => {
  it('creates a commands instance', () => {
    const cmds = createCoreCommands<object>()
    expect(typeof cmds.enqueue).toBe('function')
    expect(typeof cmds.on).toBe('function')
    expect(typeof cmds.process).toBe('function')
    expect(cmds.queue).toHaveLength(0)
  })

  it('enqueues commands in timestamp order', () => {
    const cmds = createCoreCommands<object>()
    cmds.enqueue({ timestamp: 200, source: 'game', type: 'attack' })
    cmds.enqueue({ timestamp: 100, source: 'game', type: 'move' })
    expect(cmds.queue[0]!.type).toBe('move')
    expect(cmds.queue[1]!.type).toBe('attack')
  })

  it('calls registered handlers on process', () => {
    const cmds = createCoreCommands<object>()
    const handler = vi.fn()
    cmds.on('jump', handler)
    cmds.enqueue({ source: 'input', type: 'jump', payload: { height: 5 } })
    cmds.process({})
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![1].type).toBe('jump')
    expect(handler.mock.calls[0]![1].payload).toEqual({ height: 5 })
  })

  it('clears the queue after processing', () => {
    const cmds = createCoreCommands<object>()
    cmds.enqueue({ source: 'x', type: 'y' })
    cmds.process({})
    expect(cmds.queue).toHaveLength(0)
  })

  it('unsubscribes handler when returned function is called', () => {
    const cmds = createCoreCommands<object>()
    const handler = vi.fn()
    const off = cmds.on('fire', handler)
    off()
    cmds.enqueue({ source: 'x', type: 'fire' })
    cmds.process({})
    expect(handler).not.toHaveBeenCalled()
  })
})
