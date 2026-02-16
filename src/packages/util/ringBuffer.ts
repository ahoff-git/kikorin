export interface RingBuffer {
  push(value: number): void
  average(): number
  sum(): number
  size(): number
  capacity(): number
  clear(): void
}

export function createRingBuffer(capacity: number): RingBuffer {
  if (capacity <= 0) {
    throw new Error("RingBuffer capacity must be > 0")
  }

  const buffer = new Float64Array(capacity)
  let head = 0        // points to oldest value
  let length = 0
  let total = 0

  return {
    push(value: number) {
      if (length < capacity) {
        // still filling
        buffer[(head + length) % capacity] = value
        total += value
        length++
      } else {
        // overwrite oldest
        const old = buffer[head]
        total -= old
        buffer[head] = value
        total += value
        head = (head + 1) % capacity
      }
    },

    average() {
      return length === 0 ? 0 : total / length
    },

    sum() {
      return total
    },

    size() {
      return length
    },

    capacity() {
      return capacity
    },

    clear() {
      head = 0
      length = 0
      total = 0
    }
  }
}
