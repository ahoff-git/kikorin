import { describe, it, expect, vi } from 'vitest'
import { rng, clamp, randomItem, colorFrmRange, getContrastingColor } from '../random'
import { currentLogLevel, logLevels } from '../logging'

describe('rng', () => {
  it('returns a value within [low, high]', () => {
    for (let i = 0; i < 100; i++) {
      const v = rng(1, 10)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  it('returns an integer when both bounds are integers', () => {
    for (let i = 0; i < 20; i++) {
      expect(Number.isInteger(rng(0, 100))).toBe(true)
    }
  })

  it('derives precision from the most precise input', () => {
    for (let i = 0; i < 20; i++) {
      const v = rng(1.5, 2.5)
      const decimals = (v.toString().split('.')[1] ?? '').length
      expect(decimals).toBeLessThanOrEqual(1)
    }
  })

  it('respects an explicit decimals parameter', () => {
    for (let i = 0; i < 20; i++) {
      const v = rng(0, 1, 3)
      const decimals = (v.toString().split('.')[1] ?? '').length
      expect(decimals).toBeLessThanOrEqual(3)
    }
  })

  it('returns the same value when low equals high', () => {
    expect(rng(5, 5)).toBe(5)
    expect(rng(3.7, 3.7)).toBe(3.7)
  })

  it('handles reversed bounds gracefully', () => {
    for (let i = 0; i < 20; i++) {
      const v = rng(10, 1)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
    }
  })
})

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('clamps to low when below minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps to high when above maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('returns low at exactly the lower bound', () => {
    expect(clamp(0, 0, 10)).toBe(0)
  })

  it('returns high at exactly the upper bound', () => {
    expect(clamp(10, 0, 10)).toBe(10)
  })
})

describe('randomItem', () => {
  it('returns one of the array elements', () => {
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(randomItem(arr))
    }
  })

  it('returns the only element for a single-element array', () => {
    expect(randomItem(['only'])).toBe('only')
  })

  it('logs an error and returns undefined for an empty array', () => {
    // Logging is off by default; opt into error level so the log reaches console.error.
    const prevLevel = currentLogLevel.value
    currentLogLevel.value = logLevels.error
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = randomItem([] as unknown[])
    expect(errorSpy).toHaveBeenCalled()
    expect(result).toBeUndefined()
    errorSpy.mockRestore()
    currentLogLevel.value = prevLevel
  })
})

describe('colorFrmRange', () => {
  it('returns the first color at 0 percent', () => {
    expect(colorFrmRange('#ff0000', '#0000ff', 0)).toBe('#ff0000')
  })

  it('returns the second color at 100 percent', () => {
    expect(colorFrmRange('#ff0000', '#0000ff', 100)).toBe('#0000ff')
  })

  it('interpolates channels at 50 percent', () => {
    // #000000 → #ffffff at 50%: each channel = Math.round(0 - 0.5*(0-255)) = Math.round(127.5) = 128 = 0x80
    expect(colorFrmRange('#000000', '#ffffff', 50)).toBe('#808080')
  })
})

describe('getContrastingColor', () => {
  it('returns black for white', () => {
    expect(getContrastingColor('#ffffff')).toBe('#000000')
  })

  it('returns white for black', () => {
    expect(getContrastingColor('#000000')).toBe('#FFFFFF')
  })

  it('returns black for a light yellow (high luminance)', () => {
    // #ffff00: luminance ≈ (0.299*255 + 0.587*255)/255 ≈ 0.886
    expect(getContrastingColor('#ffff00')).toBe('#000000')
  })

  it('returns white for a dark color (low luminance)', () => {
    expect(getContrastingColor('#000033')).toBe('#FFFFFF')
  })

  it('works without the hash prefix', () => {
    expect(getContrastingColor('ffffff')).toBe(getContrastingColor('#ffffff'))
  })
})
