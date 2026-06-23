import { describe, it, expect } from 'vitest'
import { PriorityQueue } from '../priority-queue'

describe('PriorityQueue', () => {
  it('dequeues in ascending priority order', () => {
    const pq = new PriorityQueue<string>()
    pq.push('low',    10)
    pq.push('high',   1)
    pq.push('medium', 5)
    expect(pq.pop()).toBe('high')
    expect(pq.pop()).toBe('medium')
    expect(pq.pop()).toBe('low')
    expect(pq.pop()).toBeUndefined()
  })

  it('is stable for equal priorities (FIFO)', () => {
    const pq = new PriorityQueue<number>()
    pq.push(1, 0)
    pq.push(2, 0)
    pq.push(3, 0)
    expect(pq.pop()).toBe(1)
    expect(pq.pop()).toBe(2)
    expect(pq.pop()).toBe(3)
  })

  it('peek does not dequeue', () => {
    const pq = new PriorityQueue<string>()
    pq.push('a', 1)
    expect(pq.peek()).toBe('a')
    expect(pq.size).toBe(1)
    expect(pq.peek()).toBe('a')
  })

  it('tracks isEmpty and size correctly', () => {
    const pq = new PriorityQueue<number>()
    expect(pq.isEmpty).toBe(true)
    expect(pq.size).toBe(0)
    pq.push(42, 0)
    expect(pq.isEmpty).toBe(false)
    expect(pq.size).toBe(1)
    pq.pop()
    expect(pq.isEmpty).toBe(true)
  })

  it('handles large random insertions correctly', () => {
    const pq = new PriorityQueue<number>()
    const values = Array.from({ length: 100 }, (_, i) => i)
    // Insert in reverse order
    for (let i = 99; i >= 0; i--) pq.push(i, i)
    const out: number[] = []
    while (!pq.isEmpty) out.push(pq.pop()!)
    expect(out).toEqual(values)
  })

  it('clear empties the queue', () => {
    const pq = new PriorityQueue<number>()
    pq.push(1, 1)
    pq.push(2, 2)
    pq.clear()
    expect(pq.size).toBe(0)
    expect(pq.pop()).toBeUndefined()
  })
})
