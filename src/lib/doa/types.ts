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
  unallocatedBps: number | null
  unallocatedSource: 'same-timestamp-indexed' | null
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

export interface DoaAllocationSnapshotStrategy {
  address: string
  name: string | null
  nameSource: 'optimizer' | null
  currentBps: number
  optimizerCurrentBps: number | null
  targetBps: number | null
  indexedTargetDebtRatioBps: number | null
  optimizerScope: 'optimized' | 'unknown'
}

export interface DoaAllocationSnapshot {
  requestedTimestampUtc: string | null
  stateTimestampUtc: string | null
  blockNumber: number | null
  indexedStateId: string | null
  source: 'envio-allocation-history' | null
  complete: boolean
  strategies: DoaAllocationSnapshotStrategy[]
  unallocatedBps: number | null
  unallocatedSource: 'same-timestamp-indexed' | null
}

export type EnrichedDoaOptimizationRecord = DoaOptimizationRecord & {
  allocationSnapshot: DoaAllocationSnapshot
}
