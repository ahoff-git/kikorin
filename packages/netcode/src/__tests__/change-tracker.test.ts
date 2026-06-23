import { describe, it, expect, beforeEach } from 'vitest'
import { ChangeTracker } from '../change-tracker'
import type { ComponentSchema } from '../types'

function makeSchema(componentId: number, fieldCount: number): { schema: ComponentSchema; arrays: Float32Array[] } {
  const arrays = Array.from({ length: fieldCount }, () => new Float32Array(256))
  const schema: ComponentSchema = {
    id: componentId,
    name: `Comp${componentId}`,
    fields: arrays.map((arr, i) => ({ id: i, name: `f${i}`, array: arr })),
  }
  return { schema, arrays }
}

describe('ChangeTracker', () => {
  let tracker: ChangeTracker

  beforeEach(() => {
    tracker = new ChangeTracker()
  })

  it('emits nothing for clean entities', () => {
    const { schema } = makeSchema(0, 3)
    tracker.registerComponent(schema)
    // No markDirty — flush should return empty
    expect(tracker.flush([1, 2, 3])).toHaveLength(0)
  })

  it('emits delta only for dirty entities', () => {
    const { schema, arrays } = makeSchema(0, 2)
    tracker.registerComponent(schema)

    arrays[0][5] = 10
    arrays[1][5] = 20
    tracker.markDirty(5)

    const deltas = tracker.flush([3, 5, 7])
    expect(deltas).toHaveLength(2)
    expect(deltas.find(d => d.fieldId === 0)!.value).toBeCloseTo(10)
    expect(deltas.find(d => d.fieldId === 1)!.value).toBeCloseTo(20)
  })

  it('does not re-emit unchanged fields on second flush', () => {
    const { schema, arrays } = makeSchema(0, 1)
    tracker.registerComponent(schema)

    arrays[0][1] = 99
    tracker.markDirty(1)
    tracker.flush([1]) // snapshot taken

    tracker.markDirty(1) // dirty again but value unchanged
    const second = tracker.flush([1])
    expect(second).toHaveLength(0)
  })

  it('emits when field value changes between flushes', () => {
    const { schema, arrays } = makeSchema(0, 1)
    tracker.registerComponent(schema)

    arrays[0][1] = 1
    tracker.markDirty(1)
    tracker.flush([1])

    arrays[0][1] = 2
    tracker.markDirty(1)
    const deltas = tracker.flush([1])
    expect(deltas).toHaveLength(1)
    expect(deltas[0].value).toBeCloseTo(2)
  })

  it('fullSnapshot always returns all fields regardless of dirty state', () => {
    const { schema, arrays } = makeSchema(0, 3)
    tracker.registerComponent(schema)

    arrays[0][10] = 1
    arrays[1][10] = 2
    arrays[2][10] = 3

    const snap = tracker.fullSnapshot([10])
    expect(snap).toHaveLength(3)
  })

  it('invalidateEntity forces all fields to re-emit on next flush', () => {
    const { schema, arrays } = makeSchema(0, 2)
    tracker.registerComponent(schema)

    arrays[0][3] = 5
    arrays[1][3] = 6
    tracker.markDirty(3)
    tracker.flush([3]) // snapshot established

    // Simulate entity respawn — same eid, different values
    arrays[0][3] = 99
    arrays[1][3] = 100
    tracker.invalidateEntity(3) // resets snapshot

    const deltas = tracker.flush([3])
    expect(deltas).toHaveLength(2)
    expect(deltas.find(d => d.fieldId === 0)!.value).toBeCloseTo(99)
    expect(deltas.find(d => d.fieldId === 1)!.value).toBeCloseTo(100)
  })

  it('clears dirty count after flush', () => {
    const { schema } = makeSchema(0, 1)
    tracker.registerComponent(schema)
    tracker.markDirty(1)
    tracker.markDirty(2)
    expect(tracker.dirtyCount).toBe(2)
    tracker.flush([1, 2])
    expect(tracker.dirtyCount).toBe(0)
  })

  it('throws on duplicate component registration', () => {
    const { schema } = makeSchema(0, 1)
    tracker.registerComponent(schema)
    expect(() => tracker.registerComponent(schema)).toThrow()
  })

  it('tracks multiple components simultaneously', () => {
    const { schema: s0, arrays: a0 } = makeSchema(0, 2)
    const { schema: s1, arrays: a1 } = makeSchema(1, 1)
    tracker.registerComponent(s0)
    tracker.registerComponent(s1)

    a0[0][7] = 1; a0[1][7] = 2; a1[0][7] = 3
    tracker.markDirty(7)

    const deltas = tracker.flush([7])
    expect(deltas).toHaveLength(3)
    const c0 = deltas.filter(d => d.componentId === 0)
    const c1 = deltas.filter(d => d.componentId === 1)
    expect(c0).toHaveLength(2)
    expect(c1).toHaveLength(1)
  })
})
