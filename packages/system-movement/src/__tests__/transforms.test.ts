import { describe, it, expect } from 'vitest'
import {
  getYawFromXZDirection,
  rotateLocalVectorByEntityRotation,
  setEntityPosition,
  setEntityVelocity,
  setEntityRotation,
  markTransformDirty,
} from '../transforms'

describe('transforms exports', () => {
  it('exports getYawFromXZDirection', () => {
    expect(typeof getYawFromXZDirection).toBe('function')
  })

  it('getYawFromXZDirection returns 0 for -z direction', () => {
    expect(getYawFromXZDirection(0, -1)).toBeCloseTo(0)
  })

  it('getYawFromXZDirection returns PI/2 for -x direction', () => {
    expect(getYawFromXZDirection(-1, 0)).toBeCloseTo(Math.PI / 2)
  })

  it('exports rotateLocalVectorByEntityRotation', () => {
    expect(typeof rotateLocalVectorByEntityRotation).toBe('function')
  })

  it('exports setEntityPosition, setEntityVelocity, setEntityRotation', () => {
    expect(typeof setEntityPosition).toBe('function')
    expect(typeof setEntityVelocity).toBe('function')
    expect(typeof setEntityRotation).toBe('function')
  })
})
