import type { DoaAllocationCoverage, DoaStrategyDebtRatio } from './types'

const TOTAL_ALLOCATION_BPS = 10_000
export const DOA_ALLOCATION_COMPLETENESS_TOLERANCE_BPS = 5

function validateIncludedBps(label: 'current' | 'target', includedBps: number): void {
  if (includedBps > TOTAL_ALLOCATION_BPS + DOA_ALLOCATION_COMPLETENESS_TOLERANCE_BPS) {
    throw new Error(
      `Invalid DOA allocation coverage: ${label} ratios total ${includedBps} bps, exceeding ${TOTAL_ALLOCATION_BPS} bps`
    )
  }
}

export function calculateDoaAllocationCoverage(
  strategyDebtRatios: readonly Pick<DoaStrategyDebtRatio, 'currentRatio' | 'targetRatio'>[]
): DoaAllocationCoverage {
  const currentIncludedBps = strategyDebtRatios.reduce((sum, strategy) => sum + strategy.currentRatio, 0)
  const targetIncludedBps = strategyDebtRatios.reduce((sum, strategy) => sum + strategy.targetRatio, 0)

  validateIncludedBps('current', currentIncludedBps)
  validateIncludedBps('target', targetIncludedBps)

  const currentComplete =
    Math.abs(TOTAL_ALLOCATION_BPS - currentIncludedBps) <= DOA_ALLOCATION_COMPLETENESS_TOLERANCE_BPS
  const targetComplete = Math.abs(TOTAL_ALLOCATION_BPS - targetIncludedBps) <= DOA_ALLOCATION_COMPLETENESS_TOLERANCE_BPS
  const hasIncludedAllocation = currentIncludedBps > 0 || targetIncludedBps > 0

  return {
    currentIncludedBps,
    targetIncludedBps,
    currentResidualBps: Math.max(0, TOTAL_ALLOCATION_BPS - currentIncludedBps),
    targetResidualBps: Math.max(0, TOTAL_ALLOCATION_BPS - targetIncludedBps),
    currentComplete,
    targetComplete,
    classification:
      currentComplete && targetComplete ? 'complete' : hasIncludedAllocation ? 'partial-optimizer-scope' : 'unknown'
  }
}
