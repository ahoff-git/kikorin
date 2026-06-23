// Min-heap priority queue. Lower priority value = higher urgency.
// Stable: equal-priority items are dequeued in insertion order.

export interface PQEntry<T> {
  readonly priority: number
  readonly seq: number
  readonly value: T
}

export class PriorityQueue<T> {
  private _heap: PQEntry<T>[] = []
  private _seq = 0

  get size(): number { return this._heap.length }
  get isEmpty(): boolean { return this._heap.length === 0 }

  push(value: T, priority: number): void {
    const entry: PQEntry<T> = { priority, seq: this._seq++, value }
    this._heap.push(entry)
    this._bubbleUp(this._heap.length - 1)
  }

  pop(): T | undefined {
    if (this._heap.length === 0) return undefined
    const top = this._heap[0]
    const last = this._heap.pop()!
    if (this._heap.length > 0) {
      this._heap[0] = last
      this._siftDown(0)
    }
    return top.value
  }

  peek(): T | undefined {
    return this._heap[0]?.value
  }

  clear(): void {
    this._heap = []
  }

  private _lt(a: PQEntry<T>, b: PQEntry<T>): boolean {
    return a.priority !== b.priority ? a.priority < b.priority : a.seq < b.seq
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this._lt(this._heap[i], this._heap[parent])) {
        ;[this._heap[i], this._heap[parent]] = [this._heap[parent], this._heap[i]]
        i = parent
      } else break
    }
  }

  private _siftDown(i: number): void {
    const n = this._heap.length
    for (;;) {
      let min = i
      const l = (i << 1) + 1
      const r = l + 1
      if (l < n && this._lt(this._heap[l], this._heap[min])) min = l
      if (r < n && this._lt(this._heap[r], this._heap[min])) min = r
      if (min === i) break
      ;[this._heap[i], this._heap[min]] = [this._heap[min], this._heap[i]]
      i = min
    }
  }
}
