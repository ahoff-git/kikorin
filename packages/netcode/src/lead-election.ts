import type { ElectionStrategy, GroupId, LoadInfo, PeerId } from './types'

// FNV-1a 32-bit hash — fast, good distribution, deterministic across peers
function fnv1a(s: string): number {
  let h = 2_166_136_261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16_777_619) >>> 0
  }
  return h
}

/**
 * Deterministic lead election for an interest group.
 *
 * All peers in a group run the same algorithm over the same candidate list,
 * so they converge on the same lead without coordination messages. When the
 * candidate set changes (peer joins/leaves), every peer re-elects locally.
 *
 * Strategies:
 *   min-id        — lexicographically smallest peer ID wins. Zero coordination
 *                   overhead, deterministic, but always assigns load to the
 *                   same peer. Best for low-churn groups.
 *
 *   hash-ring     — consistent hashing with 20 virtual nodes per peer.
 *                   Spreads lead responsibility across peers as groups multiply.
 *                   A single peer join/leave only re-assigns ~1/N groups.
 *
 *   load-balanced — weighted score from live load metrics sent by peers.
 *                   Falls back to min-id for peers without reported metrics.
 *                   Best when peers have heterogeneous capacity.
 */
export class LeadElector {
  private _strategy: ElectionStrategy
  private _loadInfo = new Map<PeerId, LoadInfo>()

  constructor(strategy: ElectionStrategy = 'min-id') {
    this._strategy = strategy
  }

  updateLoadInfo(info: LoadInfo): void {
    this._loadInfo.set(info.peerId, info)
  }

  removeLoadInfo(peerId: PeerId): void {
    this._loadInfo.delete(peerId)
  }

  electLead(groupId: GroupId, candidates: PeerId[]): PeerId {
    if (candidates.length === 0) throw new Error('No candidates for election')
    if (candidates.length === 1) return candidates[0]

    switch (this._strategy) {
      case 'min-id':        return this._minId(candidates)
      case 'hash-ring':     return this._hashRing(groupId, candidates)
      case 'load-balanced': return this._loadBalanced(candidates)
    }
  }

  wouldReelect(groupId: GroupId, currentLead: PeerId, candidates: PeerId[]): boolean {
    try {
      return this.electLead(groupId, candidates) !== currentLead
    } catch {
      return true
    }
  }

  private _minId(candidates: PeerId[]): PeerId {
    return candidates.reduce((best, id) => (id < best ? id : best))
  }

  private _hashRing(groupId: GroupId, candidates: PeerId[]): PeerId {
    const target = fnv1a(groupId)
    // 20 virtual nodes per peer — enough for good distribution with small group sets
    const ring: Array<{ pos: number; peerId: PeerId }> = []
    for (const peerId of candidates) {
      for (let v = 0; v < 20; v++) {
        ring.push({ pos: fnv1a(`${peerId}:vn${v}`), peerId })
      }
    }
    ring.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
    // First node clockwise from the group's hash position
    return (ring.find(n => n.pos >= target) ?? ring[0]).peerId
  }

  private _loadBalanced(candidates: PeerId[]): PeerId {
    let best = candidates[0]
    let bestScore = Infinity
    for (const peerId of candidates) {
      const info = this._loadInfo.get(peerId)
      // connectionCount * 2 + leadGroupCount * 5 — leads cost more than plain connections
      const score = info ? info.connectionCount * 2 + info.leadGroupCount * 5 : 0
      if (score < bestScore) { bestScore = score; best = peerId }
    }
    return best
  }
}
