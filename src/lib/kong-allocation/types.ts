export type Address = `0x${string}`
export type Hash = `0x${string}`
export type TimelineDirection = 'asc' | 'desc'

export interface VaultAllocationTimeline {
  schemaVersion: 1
  generatedAt: number
  direction: TimelineDirection
  vault: VaultAllocationVault
  strategies: AllocationHistoryStrategy[]
  states: AllocationState[]
  transitions: AllocationTransition[]
  pendingDoaProposals?: DoaProposal[]
  events?: AllocationSourceEvent[]
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
  unallocatedBps: number
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
}

export interface DoaProposal extends DoaAnnotation {
  status: 'pending' | 'unmatched' | 'stale'
}

export interface RpcTransactionContext {
  from: Address | null
  to: Address | null
  inputSelector: Hash | null
}
