import { describe, it, expect, vi } from 'vitest'
import { createChillUpdater } from '../chillUpdate'

describe('createChillUpdater', () => {
  it('returns false when no pending updates', () => {
    const updater = createChillUpdater()
    expect(updater.check()).toBe(false)
  })

  it('fires an update when set', () => {
    const updater = createChillUpdater()
    const fn = vi.fn()
    updater.setUpdate({ updateKey: 'test', updateFunction: fn, value: 42 })
    const result = updater.check()
    expect(result).toBe(true)
    expect(fn).toHaveBeenCalledWith(42)
  })

  it('does not fire twice without being set again', () => {
    const updater = createChillUpdater()
    const fn = vi.fn()
    updater.setUpdate({ updateKey: 'x', updateFunction: fn, value: 1 })
    updater.check()
    updater.check()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('updates value on subsequent setUpdate calls', () => {
    const updater = createChillUpdater()
    const fn = vi.fn()
    updater.setUpdate({ updateKey: 'k', updateFunction: fn, value: 1 })
    updater.setUpdate({ updateKey: 'k', updateFunction: fn, value: 2 })
    updater.check()
    expect(fn).toHaveBeenCalledWith(2)
  })
})
