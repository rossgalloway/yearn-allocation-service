export interface AllocationSourceEvent {
  id: string
  chainId: number
  vaultAddress: string
  sourceAddress: string
  sourceType: string
  eventName: string
  signature: string
  normalizationVersion: number
  abiVariant: string | null
  blockNumber: number
  blockTimestamp: string
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  topLevelTransactionFrom: string | null
  topLevelTransactionTo: string | null
  topLevelInputSelector: string | null
  strategyAddress: string | null
  argsJson: string
}

export interface VaultAccountingCheckpoint {
  id: string
  chainId: number
  vaultAddress: string
  blockNumber: number
  blockTimestamp: string
  blockHash: string
  totalAssets: string
  totalDebt: string
  totalIdle: string
  accountingIdentityHolds: boolean
  canonicalBlockVerified: boolean
  source: string
  sourceEventIds: string[]
}

export interface VaultAllocationCoverage {
  id: string
  chainId: number
  vaultAddress: string
  coverageStartBlock: number
  coverageStartBlockHash: string
  validatedThroughBlock: number
  validatedThroughBlockHash: string
  vaultDiscoveryComplete: boolean
  eventHistoryComplete: boolean
  allocatorDeploymentHistoryComplete: boolean
  allocatorAssignmentHistoryComplete: boolean
  checkpointTriggerAuditComplete: boolean
  safeForTimeline: boolean
  knownGaps: string[]
  coverageRevision: string
  producerCommit: string
  validatedAt: string
}

export interface VaultAccountingCheckpointFailure {
  id: string
  blockNumber: number
  expectedBlockHash: string
  reason: string
  sourceEventIds: string[]
}
