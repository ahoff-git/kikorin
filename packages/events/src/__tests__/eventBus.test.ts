import { describe, it, expect, vi } from 'vitest'
import { eventBus } from '../eventBus'

describe('eventBus', () => {
  it('emits and receives ui:timeMetricsUpdate', () => {
    const handler = vi.fn()
    eventBus.on('ui:timeMetricsUpdate', handler)
    eventBus.emit('ui:timeMetricsUpdate', { timeMetrics: { avgDelta: 4, ticksPerSecond: 250 } })
    expect(handler).toHaveBeenCalledWith({ timeMetrics: { avgDelta: 4, ticksPerSecond: 250 } })
    eventBus.off('ui:timeMetricsUpdate', handler)
  })

  it('emits and receives ui:crosshairAimPoint', () => {
    const handler = vi.fn()
    eventBus.on('ui:crosshairAimPoint', handler)
    eventBus.emit('ui:crosshairAimPoint', { wx: 1, wy: 2, wz: 3 })
    expect(handler).toHaveBeenCalledWith({ wx: 1, wy: 2, wz: 3 })
    eventBus.off('ui:crosshairAimPoint', handler)
  })
})
