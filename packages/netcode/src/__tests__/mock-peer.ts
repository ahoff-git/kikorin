/**
 * In-memory mock PeerJS transport for unit and integration tests.
 *
 * Synchronous delivery: MockConn.send() immediately calls data handlers on the
 * partner, so the full chain (send → route → decode → handler) happens in one
 * call stack, making every assertion deterministic without awaiting timers.
 */

import type { PeerJSDataConnection, PeerJSPeer } from '../connection-pool'
import { PeerNet } from '../peer-net'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EvHandler = (...args: any[]) => void

function makeEvMap() {
  const m = new Map<string, EvHandler[]>()
  return {
    on(ev: string, cb: EvHandler) {
      let arr = m.get(ev)
      if (!arr) { arr = []; m.set(ev, arr) }
      arr.push(cb)
    },
    emit(ev: string, ...args: unknown[]) {
      for (const cb of m.get(ev) ?? []) cb(...args)
    },
  }
}

export class MockConn implements PeerJSDataConnection {
  readonly peer: string
  open = false
  _partner: MockConn | null = null
  private _ev = makeEvMap()

  constructor(remotePeerId: string) { this.peer = remotePeerId }

  on(event: 'data',  cb: (data: unknown) => void): void
  on(event: 'open',  cb: () => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: string,  cb: EvHandler): void { this._ev.on(event, cb) }

  send(data: ArrayBuffer | Uint8Array): void {
    if (!this._partner?.open) return
    const buf: ArrayBuffer = data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      : data
    this._partner._ev.emit('data', buf)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this._ev.emit('close')
    if (this._partner) {
      const p = this._partner
      this._partner = null
      p._partner = null
      p.open = false
      p._ev.emit('close')
    }
  }

  _open(): void { this.open = true; this._ev.emit('open') }
}

export class MockPeerNode implements PeerJSPeer {
  readonly id: string
  private _net: MockNetwork
  private _ev = makeEvMap()

  constructor(id: string, net: MockNetwork) { this.id = id; this._net = net }

  on(event: 'connection', cb: (conn: PeerJSDataConnection) => void): void
  on(event: 'open',  cb: (id: string) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: () => void): void
  on(event: string,  cb: EvHandler): void { this._ev.on(event, cb) }
  connect(peerId: string): PeerJSDataConnection { return this._net._connect(this.id, peerId) }
  destroy(): void { this._net._remove(this.id) }
  _emit(ev: string, ...args: unknown[]): void { this._ev.emit(ev, ...args) }
}

export class MockNetwork {
  private _nodes = new Map<string, MockPeerNode>()

  register(id: string): MockPeerNode {
    const node = new MockPeerNode(id, this)
    this._nodes.set(id, node)
    return node
  }

  _connect(fromId: string, toId: string): MockConn {
    const to = this._nodes.get(toId)
    if (!to) throw new Error(`MockNetwork: unknown peer "${toId}"`)
    const cA = new MockConn(toId)
    const cB = new MockConn(fromId)
    cA._partner = cB
    cB._partner = cA
    to._emit('connection', cB)
    // Defer open so ConnectionPool can install its 'open' handler on cA first.
    queueMicrotask(() => { cA._open(); cB._open() })
    return cA
  }

  _remove(id: string): void { this._nodes.delete(id) }
}

export interface TestPeer {
  id: string
  net: PeerNet
}

/** Create a PeerNet wired to the mock network and return it as a TestPeer. */
export function makePeer(id: string, network: MockNetwork): TestPeer {
  const net = new PeerNet({ peerId: id })
  net.attachPeer(network.register(id))
  return { id, net }
}

/** Connect every pair in the list (full mesh). */
export async function connectAll(peers: TestPeer[]): Promise<void> {
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      await peers[i].net.connectPeer(peers[j].id)
    }
  }
}
