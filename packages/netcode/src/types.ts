export type PeerId = string
export type GroupId = string
export type EntityId = number
export type ComponentId = number
export type FieldId = number
export type SequenceNumber = number

export type NetTypedArray =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int8Array
  | Int16Array

// 8-byte message header:
// [type:1][flags:1][seq:2][ack:2][payloadLen:2]  (all LE)
export const HEADER_SIZE = 8

export const enum MessageType {
  Handshake   = 0x01,
  Subscribe   = 0x02,
  Unsubscribe = 0x03,
  DeltaUpdate = 0x04,
  FullSync    = 0x05,
  Ack         = 0x06,
  Ping        = 0x07,
  Pong        = 0x08,
  LeadClaim   = 0x09,
  LeadYield   = 0x0a,
  PeerList    = 0x0b,
  GameEvent   = 0x0c,
}

export const enum MessageFlag {
  None       = 0x00,
  Reliable   = 0x01,
  Compressed = 0x02,
  Fragmented = 0x04,
}

export interface NetMessage {
  type: MessageType
  flags: MessageFlag
  seq: SequenceNumber
  ack: SequenceNumber
  payload: ArrayBuffer
}

export interface FieldSchema {
  id: FieldId
  name: string
  /** Direct reference to the bitecs component TypedArray (e.g. Position.x) */
  array: NetTypedArray
}

export interface ComponentSchema {
  id: ComponentId
  name: string
  fields: FieldSchema[]
}

export interface InterestGroupConfig {
  id: GroupId
  /** Max entities tracked by this group. Default 4096. */
  maxEntities?: number
  /** Flush interval in ms. Default 50 (20hz). */
  tickRateMs?: number
  /** Lead election strategy. Default 'min-id'. */
  electionStrategy?: ElectionStrategy
}

export interface PeerNetConfig {
  peerId: PeerId
  /** Exponential moving average alpha for RTT. Default 0.125. */
  rttAlpha?: number
}

export interface DeltaEntry {
  entityId: EntityId
  componentId: ComponentId
  fieldId: FieldId
  value: number
}

export type DeltaSet = DeltaEntry[]

export type DeltaHandler = (deltas: DeltaSet, groupId: GroupId, fromPeer: PeerId) => void

export type ElectionStrategy = 'min-id' | 'hash-ring' | 'load-balanced'

export interface LoadInfo {
  peerId: PeerId
  connectionCount: number
  leadGroupCount: number
}
