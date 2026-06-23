import { HEADER_SIZE, MessageFlag, MessageType, type DeltaEntry, type DeltaSet, type NetMessage } from './types'

// ---------------------------------------------------------------------------
// Buffer pool — reuse fixed-size buffers to reduce GC pressure
// ---------------------------------------------------------------------------

const POOL_BUFFER_SIZE = 65_536
const POOL_MAX = 16
const _pool: ArrayBuffer[] = []

function acquireBuffer(): ArrayBuffer {
  return _pool.pop() ?? new ArrayBuffer(POOL_BUFFER_SIZE)
}

function releaseBuffer(buf: ArrayBuffer): void {
  if (buf.byteLength === POOL_BUFFER_SIZE && _pool.length < POOL_MAX) {
    _pool.push(buf)
  }
}

// ---------------------------------------------------------------------------
// Header encode / decode
// ---------------------------------------------------------------------------

export function encodeHeader(
  view: DataView,
  type: MessageType,
  flags: MessageFlag,
  seq: number,
  ack: number,
  payloadLen: number,
): void {
  view.setUint8(0, type)
  view.setUint8(1, flags)
  view.setUint16(2, seq, true)
  view.setUint16(4, ack, true)
  view.setUint16(6, payloadLen, true)
}

export function decodeHeader(view: DataView): {
  type: MessageType
  flags: MessageFlag
  seq: number
  ack: number
  payloadLen: number
} {
  return {
    type: view.getUint8(0) as MessageType,
    flags: view.getUint8(1) as MessageFlag,
    seq: view.getUint16(2, true),
    ack: view.getUint16(4, true),
    payloadLen: view.getUint16(6, true),
  }
}

// ---------------------------------------------------------------------------
// Full message encode / decode
// ---------------------------------------------------------------------------

export function encodeMessage(msg: NetMessage): ArrayBuffer {
  const payloadLen = msg.payload.byteLength
  const total = HEADER_SIZE + payloadLen
  const buf = total <= POOL_BUFFER_SIZE ? acquireBuffer() : new ArrayBuffer(total)
  encodeHeader(new DataView(buf), msg.type, msg.flags, msg.seq, msg.ack, payloadLen)
  new Uint8Array(buf, HEADER_SIZE, payloadLen).set(new Uint8Array(msg.payload))
  const out = buf.slice(0, total)
  releaseBuffer(buf)
  return out
}

export function decodeMessage(buf: ArrayBuffer): NetMessage {
  const view = new DataView(buf)
  const { type, flags, seq, ack, payloadLen } = decodeHeader(view)
  return {
    type,
    flags,
    seq,
    ack,
    payload: buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen),
  }
}

// ---------------------------------------------------------------------------
// Delta payload encode / decode
//
// Wire format:
//   [groupId_len:1][groupId:N]
//   [entityCount:2]
//   per entity:
//     [eid:4][componentCount:1]
//     per component:
//       [cid:1][fieldCount:1]
//       per field:
//         [fid:1][value:4 f32 LE]
// ---------------------------------------------------------------------------

export function encodeDeltaPayload(groupId: string, deltas: DeltaSet): ArrayBuffer {
  const enc = new TextEncoder()
  const groupIdBytes = enc.encode(groupId)

  // Group deltas: entity → component → [fieldId, value][]
  const byEntity = new Map<number, Map<number, Array<[number, number]>>>()
  for (const { entityId, componentId, fieldId, value } of deltas) {
    let byComp = byEntity.get(entityId)
    if (!byComp) { byComp = new Map(); byEntity.set(entityId, byComp) }
    let fields = byComp.get(componentId)
    if (!fields) { fields = []; byComp.set(componentId, fields) }
    fields.push([fieldId, value])
  }

  // Size: 1 + groupIdBytes.length + 2 + entities*(4+1 + comps*(1+1 + fields*(1+4)))
  const maxSize = 1 + groupIdBytes.length + 2 + deltas.length * 12
  const buf = maxSize <= POOL_BUFFER_SIZE ? acquireBuffer() : new ArrayBuffer(maxSize)
  const view = new DataView(buf)
  let off = 0

  view.setUint8(off, groupIdBytes.length); off += 1
  new Uint8Array(buf, off, groupIdBytes.length).set(groupIdBytes); off += groupIdBytes.length
  view.setUint16(off, byEntity.size, true); off += 2

  for (const [eid, byComp] of byEntity) {
    view.setUint32(off, eid, true); off += 4
    view.setUint8(off, byComp.size); off += 1
    for (const [cid, fields] of byComp) {
      view.setUint8(off, cid); off += 1
      view.setUint8(off, fields.length); off += 1
      for (const [fid, val] of fields) {
        view.setUint8(off, fid); off += 1
        view.setFloat32(off, val, true); off += 4
      }
    }
  }

  const out = buf.slice(0, off)
  releaseBuffer(buf)
  return out
}

export function decodeDeltaPayload(buf: ArrayBuffer): { groupId: string; deltas: DeltaSet } {
  const view = new DataView(buf)
  const dec = new TextDecoder()
  let off = 0

  const groupIdLen = view.getUint8(off); off += 1
  const groupId = dec.decode(buf.slice(off, off + groupIdLen)); off += groupIdLen
  const entityCount = view.getUint16(off, true); off += 2

  const deltas: DeltaEntry[] = []
  for (let e = 0; e < entityCount; e++) {
    const entityId = view.getUint32(off, true); off += 4
    const componentCount = view.getUint8(off); off += 1
    for (let c = 0; c < componentCount; c++) {
      const componentId = view.getUint8(off); off += 1
      const fieldCount = view.getUint8(off); off += 1
      for (let f = 0; f < fieldCount; f++) {
        const fieldId = view.getUint8(off); off += 1
        const value = view.getFloat32(off, true); off += 4
        deltas.push({ entityId, componentId, fieldId, value })
      }
    }
  }

  return { groupId, deltas }
}

// ---------------------------------------------------------------------------
// Control payload helpers (JSON-over-text for low-freq control messages)
// ---------------------------------------------------------------------------

const _enc = new TextEncoder()
const _dec = new TextDecoder()

export function encodeJson(obj: Record<string, unknown>): ArrayBuffer {
  return _enc.encode(JSON.stringify(obj)).buffer as ArrayBuffer
}

export function decodeJson(buf: ArrayBuffer): Record<string, unknown> {
  return JSON.parse(_dec.decode(buf)) as Record<string, unknown>
}
