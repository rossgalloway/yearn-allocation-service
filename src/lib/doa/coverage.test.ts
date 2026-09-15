import { describe, expect, it } from 'vitest'
import { calculateDoaAllocationCoverage } from './coverage'

describe('calculateDoaAllocationCoverage', () => {
  it('keeps an optimizer residual distinct from proven unallocated capital', () => {
    const coverage = calculateDoaAllocationCoverage([
      { currentRatio: 91, targetRatio: 91 },
      { currentRatio: 4066, targetRatio: 4066 }
    ])

    expect(coverage).toEqual({
      currentIncludedBps: 4157,
      targetIncludedBps: 4157,
      currentResidualBps: 5843,
      targetResidualBps: 5843,
      currentComplete: false,
      targetComplete: false,
      classification: 'partial-optimizer-scope'
    })
  })

  it('accepts rounding overflow only inside the five-bps completeness tolerance', () => {
    expect(calculateDoaAllocationCoverage([{ currentRatio: 10_003, targetRatio: 10_005 }])).toEqual(
      expect.objectContaining({
        currentComplete: true,
        targetComplete: true,
        currentResidualBps: 0,
        targetResidualBps: 0,
        classification: 'complete'
      })
    )
    expect(() => calculateDoaAllocationCoverage([{ currentRatio: 10_006, targetRatio: 10_000 }])).toThrow(
      'exceeding 10000 bps'
    )
  })
})
