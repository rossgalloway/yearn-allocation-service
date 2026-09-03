export type Address = `0x${string}`
export type Hash = `0x${string}`
export type TimelineDirection = 'asc' | 'desc'
export type AllocationHistoryProjection = 'full' | 'chart'

export interface NormalizedAllocationTimeline {
  generatedAt: number
  vault: VaultAllocationVault
  strategies: AllocationHistoryStrategy[]
  states: AllocationState[]
  transitions: AllocationTransition[]
  unappliedDoaProposals: DoaProposal[]
  events?: AllocationSourceEvent[]
}

export interface VaultAllocationHistoryResponse {
  schemaVersion: 2
  projection: 'full'
  generatedAt: number
  direction: TimelineDirection
  dataQuality: {
    certification: 'certified' | 'provisional'
    limitations: string[]
  }
  vault: VaultAllocationVault
  entries: AllocationHistoryEntry[]
  pagination: {
    limit: number
    returned: number
    hasMore: boolean
    nextCursor: string | null
  }
}

export type AllocationChartEntryKind = 'strategy_reallocation'

export interface AllocationChartStrategyState {
  strategyAddress: Address
  currentDebt: string
}

export interface AllocationChartState {
  blockNumber: number
  blockTimestamp: number
  totalAssets: string
  totalIdle: string | null
  allocations: AllocationChartStrategyState[]
}

export interface AllocationFlowState {
  blockNumber: number
  blockTimestamp: number
  totalAssets: string
  totalIdle: string | null
  idleBps: number | null
  allocations: Array<{
    strategyAddress: Address
    strategyName: string | null
    currentDebt: string
    currentDebtBps: number
  }>
}

export interface AllocationChartCurrentSnapshot extends AllocationChartState {
  id: string
  kind: 'current_snapshot'
  interval: AllocationChartInterval | null
}

export type AllocationFlowBalanceNode = { type: 'idle' } | { type: 'strategy'; address: Address; name: string | null }

export type AllocationFlowBoundaryNode = { type: 'external' } | { type: 'accounting' }

export type AllocationFlowNode = AllocationFlowBalanceNode | AllocationFlowBoundaryNode

export type AllocationFlowKind =
  | 'deposit'
  | 'withdrawal'
  | 'idle_deployment'
  | 'idle_deallocation'
  | 'strategy_reallocation'
  | 'reported_gain'
  | 'reported_loss'
  | 'report_refund'
  | 'bad_debt_purchase'
  | 'unattributed_asset_change'

export interface AllocationIntervalFlow {
  source: AllocationFlowNode
  target: AllocationFlowNode
  amount: string
  kind: AllocationFlowKind
  attribution: 'observed_event' | 'derived_from_debt_updates' | 'residual_balance'
  evidence: {
    eventCount: number
    transactionCount: number
  }
  accounting?: {
    totalFees: string
    protocolFees: string
  }
}

export interface AllocationFlowResidual {
  node: AllocationFlowBalanceNode
  openingBalance: string
  closingBalance: string
  attributedInflows: string
  attributedOutflows: string
  unattributedInflows: string
  unattributedOutflows: string
  residualAmount: string
}

export interface AllocationFlowInterval {
  fromEntryId: string
  toEntryId: string | null
  endKind: 'allocation_entry' | 'safe_head'
  startState: AllocationFlowState
  endState: AllocationFlowState
  flows: AllocationIntervalFlow[]
  reconciliation: {
    openingTotalAssets: string
    closingTotalAssets: string
    totalAssetsDelta: string
    balanceStatus: 'reconciled' | 'unreconciled'
    attributionStatus: 'complete' | 'partial'
    unattributedAmount: string
    checkedNodeTypes: ['idle', 'strategy']
    residuals: AllocationFlowResidual[]
  }
}

export type AllocationChartFlowNode =
  | { type: 'idle' }
  | { type: 'strategy'; address: Address }
  | AllocationFlowBoundaryNode

export interface AllocationChartFlow {
  source: AllocationChartFlowNode
  target: AllocationChartFlowNode
  amount: string
  kind: AllocationFlowKind
  attribution: AllocationIntervalFlow['attribution']
}

export interface AllocationChartInterval {
  fromEntryId: string
  toEntryId: string | null
  endKind: 'allocation_entry' | 'safe_head'
  flows: AllocationChartFlow[]
  reconciliation: {
    balanceStatus: 'reconciled' | 'unreconciled'
    attributionStatus: 'complete' | 'partial'
    unattributedAmount: string
  }
}

export type AllocationChartExpectedAprImpact =
  | {
      status: 'available'
      source: 'doa'
      scope: 'proposal'
      baselineAprBps: number
      proposedAprBps: number
      deltaAprBps: number
      policyId: string
      publishedAt: number
      relationship: 'applied_in_entry' | 'governing_policy'
      applicationStatus: AllocationEntryPolicy['application']['status']
    }
  | {
      status: 'unavailable'
      reason: 'no_matched_doa_policy' | 'policy_apr_unavailable'
    }

export interface AllocationChartEntry {
  id: string
  kind: AllocationChartEntryKind
  endBlock: number
  endTimestamp: number
  after: AllocationChartState
  interval: AllocationChartInterval | null
  execution: {
    automation: AllocationHistoryEntry['execution']['automation']
    mechanism: AllocationHistoryEntry['execution']['mechanism']
    targetStatus: AllocationHistoryEntry['execution']['targetStatus']
  }
  expectedAprImpact: AllocationChartExpectedAprImpact
  detailsHref: string
}

export interface MaterializedAllocationChartPayload {
  data: AllocationChartEntry | AllocationChartCurrentSnapshot
  strategies: Record<string, string | null>
  detailInterval: AllocationFlowInterval | null
}

export interface AllocationChartVault {
  chainId: number
  address: Address
  name: string | null
}

export interface VaultAllocationChartResponse {
  schemaVersion: 2
  projection: 'chart'
  generatedAt: number
  direction: TimelineDirection
  dataQuality: VaultAllocationHistoryResponse['dataQuality']
  vault: AllocationChartVault
  strategies: Record<string, string | null>
  boundaryStates: Record<string, AllocationChartState>
  currentSnapshot: AllocationChartCurrentSnapshot | null
  entries: AllocationChartEntry[]
  pagination: {
    nextCursor: string | null
  }
}

export interface VaultAllocationHistoryEntryResponse {
  schemaVersion: 2
  projection: 'detail'
  generatedAt: number
  dataQuality: VaultAllocationHistoryResponse['dataQuality']
  vault: VaultAllocationVault
  entry: AllocationHistoryEntry
  interval: AllocationFlowInterval | null
}

export interface VaultAllocationVault {
  chainId: number
  address: Address
  name: string | null
  symbol: string | null
  assetAddress: Address | null
  assetSymbol: string | null
  assetDecimals: number | null
}

export interface AllocationHistoryStrategy {
  address: Address
  name: string | null
  status: 'active' | 'inactive' | 'unknown'
}

export interface AllocationState {
  id: string
  stateGranularity: 'block_end' | 'latest'
  blockNumber: number
  blockTimestamp: number
  transactionHash: Hash | null
  totalAssets: string
  totalDebt: string
  totalIdle: string | null
  unallocatedBps: number | null
  unallocatedSource: 'envio_same_block_checkpoint' | null
  unallocatedCheckpointId: string | null
  allocatorAddress: Address | null
  sourceEventIds: string[]
  strategies: AllocationStateStrategy[]
}

export interface AllocationStateStrategy {
  strategyAddress: Address
  currentDebt: string
  currentDebtBps: number
  maxDebt: string | null
  maxDebtBps: number | null
  targetDebtRatioBps: number | null
  maxDebtRatioBps: number | null
  allocatorAdded: boolean | null
  activation: number | null
  lastReport: number | null
}

export type AllocationTransitionKind =
  | 'doa_execution'
  | 'allocator_execution'
  | 'deposit_driven_debt_update'
  | 'withdrawal_driven_debt_update'
  | 'manual_debt_update'
  | 'manual_config_change'
  | 'report_only_state_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'vault_withdrawal'
  | 'vault_deposit'
  | 'current_live_tail'
  | 'unknown'

export type ActorRole =
  | 'doa_keeper'
  | 'debt_allocator_keeper'
  | 'governance'
  | 'management'
  | 'role_manager'
  | 'vault_role_holder'
  | 'unknown'

export interface ActorClassification {
  address: Address | null
  role: ActorRole
  label: string | null
}

export interface VaultActivity {
  kind: 'deposit' | 'withdrawal'
  path: 'direct' | 'routed'
  sourceEventId: string
  sender: Address | null
  receiver: Address | null
  owner: Address | null
  assets: string | null
  shares: string | null
}

export interface AllocationTransitionEffect {
  kind: AllocationTransitionKind
  sourceEventIds: string[]
  transactionHash: Hash
  transactionFrom: Address | null
  transactionTo: Address | null
  inputSelector: Hash | null
  actor: ActorClassification
  executionContext: AllocationExecutionContext
  triggerReplays?: AllocatorTriggerReplay[]
  vaultActivities?: VaultActivity[]
}

export interface AllocationTransition {
  id: string
  kind: AllocationTransitionKind
  fromStateId: string | null
  toStateId: string
  blockNumber: number
  blockTimestamp: number
  transactionHashes: Hash[]
  effects: AllocationTransitionEffect[]
  doa?: DoaAnnotation
}

export interface AllocationSourceEvent {
  id: string
  sourceAddress: Address
  sourceLabel: 'vault' | 'debtAllocator' | 'debtManagerFactory' | 'unknown'
  eventName: string
  signature: Hash
  blockNumber: number
  blockTimestamp: number
  transactionHash: Hash
  transactionIndex: number
  logIndex: number
  transactionFrom: Address | null
  transactionTo: Address | null
  inputSelector: Hash | null
  strategyAddress?: Address | null
  args: Record<string, unknown>
}

export interface DoaAnnotation {
  sourceKey: string
  proposalTimestamp: number
  optimizerCurrentApr: number | null
  optimizerProposedApr: number | null
  explain: string | null
  strategyTargets: Array<{
    strategyAddress: Address
    currentRatioBps: number | null
    targetRatioBps: number | null
    currentApr?: number | null
    targetApr?: number | null
  }>
  matchReason: string
  application: {
    status: 'confirmed'
    blockNumber: number
    transactionHash: Hash
    sourceEventIds: string[]
  }
}

export interface DoaProposal extends Omit<DoaAnnotation, 'application'> {
  status: 'unmatched' | 'superseded'
}

export interface RpcTransactionContext {
  from: Address | null
  to: Address | null
  inputSelector: Hash | null
  traceStatus: 'available' | 'unavailable'
  callPath: Address[]
  immediateVaultCaller: Address | null
}

export interface AllocationExecutionContext {
  traceStatus: RpcTransactionContext['traceStatus']
  callPath: Address[]
  immediateVaultCaller: Address | null
  immediateVaultCallerRoleMask: string | null
  immediateVaultCallerHasDebtManagerRole: boolean | null
}

export interface AllocatorTriggerReplay {
  strategyAddress: Address
  allocatorAddress: Address
  readAtBlock: number
  status: 'matched' | 'not_matched' | 'unavailable'
  shouldUpdate: boolean | null
  expectedDebt: string
  recommendedDebt: string | null
  absoluteDifference: string | null
  matchTolerance: string
  reason: string | null
}

export type AllocationHistoryEntryKind =
  | 'current_snapshot'
  | 'policy_application'
  | 'idle_deployment'
  | 'strategy_reallocation'
  | 'idle_deallocation'
  | 'unattributed_debt_update'
  | 'configuration_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'unknown'

export interface AllocationEntryStrategyState {
  strategyAddress: Address
  strategyName: string | null
  active: boolean | null
  currentDebt: string
  currentDebtBps: number
  maxDebt: string | null
  maxDebtBps: number | null
  targetDebtRatioBps: number | null
  maxDebtRatioBps: number | null
  allocatorAdded: boolean | null
}

export interface AllocationEntryState {
  blockNumber: number
  blockTimestamp: number
  source: 'archive_rpc'
  totalAssets: string
  totalDebt: string
  totalIdle: string | null
  unallocatedBps: number | null
  unallocatedSource: 'envio_same_block_checkpoint' | null
  unallocatedCheckpointId: string | null
  allocatorAddress: Address | null
  allocations: AllocationEntryStrategyState[]
  accountingChecks: {
    totalAssetsEqualsDebtPlusIdle: boolean | null
    strategyDebtSumEqualsTotalDebt: boolean
  }
}

export interface AllocationEntryStrategyChange {
  strategyAddress: Address
  strategyName: string | null
  currentDebtBefore: string | null
  currentDebtAfter: string | null
  currentDebtDelta: string | null
  maxDebtBefore: string | null
  maxDebtAfter: string | null
  maxDebtDelta: string | null
  currentDebtBpsBefore: number | null
  currentDebtBpsAfter: number | null
  currentDebtBpsDelta: number | null
  targetDebtRatioBpsBefore: number | null
  targetDebtRatioBpsAfter: number | null
  maxDebtRatioBpsBefore: number | null
  maxDebtRatioBpsAfter: number | null
  activeBefore: boolean | null
  activeAfter: boolean | null
}

export interface AllocationEntryPolicy {
  id: string
  source: 'doa'
  proposal: {
    sourceKey: string
    publishedAt: number
    optimizerCurrentApr: number | null
    optimizerProposedApr: number | null
    explain: string | null
  }
  application:
    | {
        status: 'confirmed'
        blockNumber: number
        transactionHash: Hash
        sourceEventIds: string[]
      }
    | {
        status: 'inferred_from_historical_config'
        blockNumber: null
        transactionHash: null
        sourceEventIds: []
      }
  targets: Array<{
    strategyAddress: Address
    strategyName: string | null
    currentRatioBps: number | null
    targetRatioBps: number | null
    maxRatioBps: number | null
    currentApr?: number | null
    targetApr?: number | null
  }>
}

export interface AllocationEntryTransaction {
  transactionHash: Hash
  blockNumber: number
  blockTimestamp: number
  kind: AllocationTransitionKind
  originator: ActorClassification
  transactionTarget: Address | null
  inputSelector: Hash | null
  callPath: Address[]
  traceStatus: RpcTransactionContext['traceStatus']
  immediateVaultCaller: Address | null
  authorization: {
    role: 'DEBT_MANAGER'
    roleMask: string | null
    confirmedAtBlock: boolean | null
  }
  sourceEventIds: string[]
  triggerReplays: AllocatorTriggerReplay[]
  vaultActivities?: VaultActivity[]
}

export type AllocationEntryOperationValue = string | number | boolean | string[] | null

export interface AllocationEntryOperation {
  kind:
    | 'strategy_added'
    | 'strategy_retired'
    | 'max_debt_updated'
    | 'allocator_strategy_configured'
    | 'vault_configuration_updated'
  source: 'envio_event' | 'archive_rpc_diff'
  sourceEventIds: string[]
  eventName: string | null
  subject: {
    type: 'strategy' | 'vault' | 'account' | 'allocator'
    address: Address | null
    name: string | null
  }
  changes: Array<{
    field: string
    before: AllocationEntryOperationValue
    after: AllocationEntryOperationValue
  }>
}

export interface AllocationHistoryEntry {
  id: string
  kind: AllocationHistoryEntryKind
  startBlock: number
  endBlock: number
  startTimestamp: number
  endTimestamp: number
  before: AllocationEntryState | null
  after: AllocationEntryState
  changes: {
    totalDebtDelta: string | null
    totalIdleDelta: string | null
    strategies: AllocationEntryStrategyChange[]
  }
  policy: AllocationEntryPolicy | null
  operations: AllocationEntryOperation[]
  execution: {
    automation: 'automatic' | 'manual' | 'mixed' | 'unknown' | null
    mechanism:
      | 'allocator_keeper'
      | 'direct_vault_role'
      | 'governance_safe'
      | 'governance'
      | 'role_manager'
      | 'mixed'
      | 'unknown'
      | null
    targetStatus: 'matched' | 'overridden' | 'unavailable' | 'not_applicable' | 'mixed' | null
    transactions: AllocationEntryTransaction[]
  }
  classification: {
    confidence: 'high' | 'medium' | 'low'
    evidence: string[]
    limitations: string[]
  }
  detailsAvailable: boolean
}
