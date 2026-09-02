import type {
  Address,
  AllocationChartCurrentSnapshot,
  AllocationChartEntry,
  AllocationChartEntryKind,
  AllocationChartExpectedAprImpact,
  AllocationChartState,
  AllocationEntryState,
  AllocationHistoryEntry,
  VaultAllocationVault
} from './types'

const CHART_ENTRY_KINDS = new Set<AllocationChartEntryKind>([
  'idle_deployment',
  'idle_deallocation',
  'strategy_reallocation'
])

export function isAllocationChartEntryKind(kind: string): kind is AllocationChartEntryKind {
  return CHART_ENTRY_KINDS.has(kind as AllocationChartEntryKind)
}

function nonzero(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) !== 0n
}

function idleBps(state: AllocationEntryState): number | null {
  if (state.totalIdle === null || !/^\d+$/.test(state.totalAssets) || !/^\d+$/.test(state.totalIdle)) return null
  const totalAssets = BigInt(state.totalAssets)
  if (totalAssets === 0n) return null
  return Number((BigInt(state.totalIdle) * 10_000n) / totalAssets)
}

function relevantStrategyAddresses(entry: AllocationHistoryEntry): Address[] {
  const relevant = new Set<Address>()
  for (const state of [entry.before, entry.after]) {
    for (const allocation of state?.allocations ?? []) {
      if (nonzero(allocation.currentDebt)) relevant.add(allocation.strategyAddress)
    }
  }
  for (const change of entry.changes.strategies) {
    if (
      change.currentDebtBefore !== change.currentDebtAfter &&
      (nonzero(change.currentDebtBefore) || nonzero(change.currentDebtAfter))
    ) {
      relevant.add(change.strategyAddress)
    }
  }
  for (const operation of entry.operations) {
    if (operation.subject.type === 'strategy' && operation.subject.address) relevant.add(operation.subject.address)
  }
  for (const target of entry.policy?.targets ?? []) relevant.add(target.strategyAddress)
  return [...relevant].sort()
}

function strategyNames(entry: AllocationHistoryEntry): Map<Address, string | null> {
  const names = new Map<Address, string | null>()
  for (const state of [entry.before, entry.after]) {
    for (const allocation of state?.allocations ?? []) names.set(allocation.strategyAddress, allocation.strategyName)
  }
  for (const target of entry.policy?.targets ?? []) names.set(target.strategyAddress, target.strategyName)
  for (const operation of entry.operations) {
    if (operation.subject.type === 'strategy' && operation.subject.address) {
      names.set(operation.subject.address, operation.subject.name)
    }
  }
  return names
}

function chartState(
  state: AllocationEntryState,
  addresses: readonly Address[],
  names: ReadonlyMap<Address, string | null>
): AllocationChartState {
  const allocations = new Map(state.allocations.map((allocation) => [allocation.strategyAddress, allocation]))
  return {
    blockNumber: state.blockNumber,
    totalAssets: state.totalAssets,
    totalIdle: state.totalIdle,
    idleBps: idleBps(state),
    allocations: addresses.map((strategyAddress) => {
      const allocation = allocations.get(strategyAddress)
      return {
        strategyAddress,
        strategyName: allocation?.strategyName ?? names.get(strategyAddress) ?? null,
        currentDebt: allocation?.currentDebt ?? '0',
        currentDebtBps: allocation?.currentDebtBps ?? 0
      }
    })
  }
}

function expectedAprImpact(entry: AllocationHistoryEntry): AllocationChartExpectedAprImpact {
  if (!entry.policy) return { status: 'unavailable', reason: 'no_matched_doa_policy' }
  const baselineAprBps = entry.policy.proposal.optimizerCurrentApr
  const proposedAprBps = entry.policy.proposal.optimizerProposedApr
  if (baselineAprBps === null || proposedAprBps === null) {
    return { status: 'unavailable', reason: 'policy_apr_unavailable' }
  }
  const application = entry.policy.application
  const appliedInEntry =
    application.status === 'confirmed' &&
    application.blockNumber >= entry.startBlock &&
    application.blockNumber <= entry.endBlock
  return {
    status: 'available',
    source: 'doa',
    scope: 'proposal',
    baselineAprBps,
    proposedAprBps,
    deltaAprBps: proposedAprBps - baselineAprBps,
    policyId: entry.policy.id,
    publishedAt: entry.policy.proposal.publishedAt,
    relationship: appliedInEntry ? 'applied_in_entry' : 'governing_policy',
    applicationStatus: application.status
  }
}

function compactTransactions(entry: AllocationHistoryEntry): AllocationChartEntry['execution']['transactions'] {
  const transactions = new Map<string, AllocationChartEntry['execution']['transactions'][number]>()
  for (const transaction of entry.execution.transactions) {
    const key = `${transaction.blockNumber}:${transaction.transactionHash}`
    if (!transactions.has(key)) {
      transactions.set(key, {
        transactionHash: transaction.transactionHash,
        blockNumber: transaction.blockNumber
      })
    }
  }
  return [...transactions.values()]
}

function detailsHref(vault: VaultAllocationVault, entryId: string, runId: string): string {
  return `/api/rest/views/allocation-history/${vault.chainId}/${vault.address.toLowerCase()}/entries/${encodeURIComponent(entryId)}?runId=${encodeURIComponent(runId)}`
}

export function buildAllocationChartEntry(
  entry: AllocationHistoryEntry,
  vault: VaultAllocationVault,
  runId: string
): AllocationChartEntry | null {
  if (!isAllocationChartEntryKind(entry.kind)) return null
  if (!entry.before) throw new Error(`Chart entry ${entry.id} is missing its before state`)
  const addresses = relevantStrategyAddresses(entry)
  const names = strategyNames(entry)
  return {
    id: entry.id,
    kind: entry.kind,
    startBlock: entry.startBlock,
    endBlock: entry.endBlock,
    startTimestamp: entry.startTimestamp,
    endTimestamp: entry.endTimestamp,
    before: chartState(entry.before, addresses, names),
    after: chartState(entry.after, addresses, names),
    execution: {
      automation: entry.execution.automation,
      mechanism: entry.execution.mechanism,
      targetStatus: entry.execution.targetStatus,
      transactions: compactTransactions(entry)
    },
    expectedAprImpact: expectedAprImpact(entry),
    operations: entry.operations.map((operation) => ({
      kind: operation.kind,
      subject: operation.subject,
      changes: operation.changes
    })),
    classification: { confidence: entry.classification.confidence },
    detailsAvailable: true,
    detailsHref: detailsHref(vault, entry.id, runId)
  }
}

export function buildAllocationChartCurrentSnapshot(
  entry: AllocationHistoryEntry
): AllocationChartCurrentSnapshot | null {
  if (entry.kind !== 'current_snapshot') return null
  const addresses = entry.after.allocations
    .filter((allocation) => nonzero(allocation.currentDebt))
    .map((allocation) => allocation.strategyAddress)
    .sort()
  const state = chartState(entry.after, addresses, strategyNames(entry))
  return {
    id: entry.id,
    kind: 'current_snapshot',
    blockTimestamp: entry.after.blockTimestamp,
    ...state
  }
}

export function buildAllocationChartPayload(
  entry: AllocationHistoryEntry,
  vault: VaultAllocationVault,
  runId: string
): AllocationChartEntry | AllocationChartCurrentSnapshot | null {
  return buildAllocationChartCurrentSnapshot(entry) ?? buildAllocationChartEntry(entry, vault, runId)
}
