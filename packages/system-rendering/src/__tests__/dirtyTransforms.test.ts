import { describe, it, expect, vi } from 'vitest'

vi.mock('@kikorin/adapter', () => ({
  renderChannel: {
    subscribe: vi.fn(() => vi.fn()),
    getSnapshot: vi.fn(() => []),
  },
}))

const { subscribeToRenderChannel } = await import('../dirtyTransforms')

describe('subscribeToRenderChannel', () => {
  it('returns an unsubscribe function', () => {
    const unsub = subscribeToRenderChannel()
    expect(typeof unsub).toBe('function')
  })
})
