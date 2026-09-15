export interface DoaStrategyDebtRatio {
  strategy: string
  name?: string
  targetRatio: number
  currentRatio: number
  currentApr?: number
  targetApr?: number
}

export interface DoaOptimization {
  vault: string
  strategyDebtRatios: DoaStrategyDebtRatio[]
  currentApr: number
  proposedApr: number
  explain: string
}

export interface DoaOptimizationSource {
  key: string
  chainId: number
  revision: string
  isLatestAlias: boolean
  timestampUtc: string | null
  latestMatchedTimestampUtc: string | null
}

export type DoaAllocationCoverageClassification = 'complete' | 'partial-optimizer-scope' | 'unknown'

export interface DoaAllocationCoverage {
  currentIncludedBps: number
  targetIncludedBps: number
  currentResidualBps: number
  targetResidualBps: number
  currentComplete: boolean
  targetComplete: boolean
  classification: DoaAllocationCoverageClassification
}

export interface DoaOptimizationFreshness {
  optimizationTimestampUtc: string | null
  latestAvailableTimestampUtc: string | null
}

export type DoaOptimizationRecord = DoaOptimization & {
  source: DoaOptimizationSource
  allocationCoverage: DoaAllocationCoverage
  freshness: DoaOptimizationFreshness
}
