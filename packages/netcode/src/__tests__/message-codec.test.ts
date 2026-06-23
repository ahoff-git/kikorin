import { describe, it, expect } from 'vitest'
import {
  encodeMessage,
  decodeMessage,
  encodeDeltaPayload,
  decodeDeltaPayload,
  encodeJson,
  decodeJson,
} from '../message-codec'
import { MessageFlag, MessageType, type DeltaSet } from '../types'

describe('message-codec header round-trip', () => {
  it('encodes and decodes a message with empty payload', () => {
    const msg = {
      type: MessageType.Ping,
      flags: MessageFlag.None,
      seq: 42,
      ack: 7,
      payload: new ArrayBuffer(0),
    }
    const encoded = encodeMessage(msg)
    const decoded = decodeMessage(encoded)
    expect(decoded.type).toBe(MessageType.Ping)
    expect(decoded.flags).toBe(MessageFlag.None)
    expect(decoded.seq).toBe(42)
    expect(decoded.ack).toBe(7)
    expect(decoded.payload.byteLength).toBe(0)
  })

  it('preserves payload bytes', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const msg = {
      type: MessageType.DeltaUpdate,
      flags: MessageFlag.Reliable,
      seq: 1000,
      ack: 999,
      payload,
    }
    const decoded = decodeMessage(encodeMessage(msg))
    expect(new Uint8Array(decoded.payload)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('wraps sequence numbers at 0xffff', () => {
    const msg = {
      type: MessageType.Ack,
      flags: MessageFlag.None,
      seq: 0xffff,
      ack: 0xffff,
      payload: new ArrayBuffer(0),
    }
    const decoded = decodeMessage(encodeMessage(msg))
    expect(decoded.seq).toBe(0xffff)
    expect(decoded.ack).toBe(0xffff)
  })
})

describe('delta payload round-trip', () => {
  it('encodes and decodes a simple delta set', () => {
    const deltas: DeltaSet = [
      { entityId: 1, componentId: 0, fieldId: 0, value: 3.14 },
      { entityId: 1, componentId: 0, fieldId: 1, value: -7.5 },
      { entityId: 2, componentId: 1, fieldId: 0, value: 0.0 },
    ]
    const buf = encodeDeltaPayload('world', deltas)
    const { groupId, deltas: out } = decodeDeltaPayload(buf)

    expect(groupId).toBe('world')
    expect(out).toHaveLength(3)

    const find = (eid: number, cid: number, fid: number) =>
      out.find(d => d.entityId === eid && d.componentId === cid && d.fieldId === fid)

    // f32 precision: within 0.001
    expect(find(1, 0, 0)!.value).toBeCloseTo(3.14, 2)
    expect(find(1, 0, 1)!.value).toBeCloseTo(-7.5, 2)
    expect(find(2, 1, 0)!.value).toBeCloseTo(0.0, 2)
  })

  it('handles empty delta set', () => {
    const buf = encodeDeltaPayload('g1', [])
    const { groupId, deltas } = decodeDeltaPayload(buf)
    expect(groupId).toBe('g1')
    expect(deltas).toHaveLength(0)
  })

  it('handles many entities', () => {
    const deltas: DeltaSet = Array.from({ length: 200 }, (_, i) => ({
      entityId: i + 1,
      componentId: 0,
      fieldId: 0,
      value: i * 0.5,
    }))
    const buf = encodeDeltaPayload('stress', deltas)
    const { deltas: out } = decodeDeltaPayload(buf)
    expect(out).toHaveLength(200)
    for (let i = 0; i < 200; i++) {
      expect(out[i].value).toBeCloseTo(i * 0.5, 1)
    }
  })

  it('preserves group id with special characters', () => {
    const { groupId } = decodeDeltaPayload(encodeDeltaPayload('zone:north/sector-7', []))
    expect(groupId).toBe('zone:north/sector-7')
  })
})

describe('json control payload', () => {
  it('round-trips an object', () => {
    const obj = { groupId: 'test', leadId: 'peer-abc', extra: 42 }
    const decoded = decodeJson(encodeJson(obj))
    expect(decoded).toEqual(obj)
  })
})
