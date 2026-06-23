import { describe, it, expect } from 'vitest'
import { LeadElector } from '../lead-election'

describe('LeadElector — min-id', () => {
  const elector = new LeadElector('min-id')

  it('elects lexicographically smallest peer', () => {
    expect(elector.electLead('g1', ['peer-c', 'peer-a', 'peer-b'])).toBe('peer-a')
  })

  it('returns sole candidate directly', () => {
    expect(elector.electLead('g1', ['only'])).toBe('only')
  })

  it('throws with no candidates', () => {
    expect(() => elector.electLead('g1', [])).toThrow()
  })

  it('wouldReelect returns true when lead would change', () => {
    expect(elector.wouldReelect('g1', 'peer-c', ['peer-a', 'peer-b', 'peer-c'])).toBe(true)
  })

  it('wouldReelect returns false when lead is stable', () => {
    expect(elector.wouldReelect('g1', 'peer-a', ['peer-a', 'peer-b', 'peer-c'])).toBe(false)
  })
})

describe('LeadElector — hash-ring', () => {
  const elector = new LeadElector('hash-ring')

  it('produces a deterministic winner for a given group+candidate set', () => {
    const candidates = ['alpha', 'beta', 'gamma']
    const lead1 = elector.electLead('zone-north', candidates)
    const lead2 = elector.electLead('zone-north', candidates)
    expect(lead1).toBe(lead2)
    expect(candidates).toContain(lead1)
  })

  it('distributes leads across different groups', () => {
    // Use structurally diverse peer IDs so they spread across the ring
    const candidates = ['peer-alice-01', 'peer-bob-02', 'peer-carol-03', 'peer-dave-04', 'peer-eve-05']
    // Use varied group names spanning different naming patterns
    const groups = [
      ...Array.from({ length: 20 }, (_, i) => `zone-${i}`),
      ...Array.from({ length: 20 }, (_, i) => `sector:${i * 7}`),
      ...Array.from({ length: 20 }, (_, i) => `room/${String(i).padStart(3, '0')}`),
    ]
    const tally = new Map<string, number>()
    for (const g of groups) {
      const lead = elector.electLead(g, candidates)
      tally.set(lead, (tally.get(lead) ?? 0) + 1)
    }
    // 60 groups across 5 peers — expect at least 3 distinct leads
    expect(tally.size).toBeGreaterThanOrEqual(3)
  })

  it('single candidate always wins', () => {
    expect(elector.electLead('any', ['solo'])).toBe('solo')
  })
})

describe('LeadElector — load-balanced', () => {
  const elector = new LeadElector('load-balanced')

  it('elects least-loaded peer', () => {
    elector.updateLoadInfo({ peerId: 'heavy', connectionCount: 20, leadGroupCount: 10 })
    elector.updateLoadInfo({ peerId: 'light', connectionCount: 1, leadGroupCount: 0 })
    expect(elector.electLead('g', ['heavy', 'light'])).toBe('light')
  })

  it('treats peers without load info as unloaded (score=0)', () => {
    // 'unknown' has no info → score 0, 'known-heavy' has score > 0
    elector.updateLoadInfo({ peerId: 'known-heavy', connectionCount: 10, leadGroupCount: 5 })
    const winner = elector.electLead('g', ['unknown', 'known-heavy'])
    expect(winner).toBe('unknown')
  })

  it('removeLoadInfo removes the entry', () => {
    elector.updateLoadInfo({ peerId: 'temp', connectionCount: 0, leadGroupCount: 0 })
    elector.removeLoadInfo('temp')
    // Should not throw; election still proceeds
    expect(() => elector.electLead('g', ['temp', 'other'])).not.toThrow()
  })
})
